import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ActionService } from '../actions/service.js';
import { EventHub } from '../events.js';
import type { DockerScannerRunner } from '../scanners/dockerRunner.js';
import { createScope } from '../scope.js';
import { ArtifactStore } from '../storage/artifacts.js';
import { ReconService } from './service.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const supportsNodeSqlite = Number.parseInt(process.versions.node.split('.')[0] ?? '0', 10) >= 22;

describe.skipIf(!supportsNodeSqlite)('staged recon service', () => {
  it('runs bounded stages, persists priorities, and proposes gated follow-ups', async () => {
    const { WebDatabase } = await import('../storage/database.js');
    const root = mkdtempSync(join(tmpdir(), 'agent-workbench-recon-'));
    roots.push(root);
    const database = new WebDatabase(join(root, 'db.sqlite3'));
    const engagement = database.createEngagement(
      'authorized target',
      createScope({
        allowedHosts: ['example.com', '*.example.com'],
        allowThirdPartyPassiveSources: true,
        allowDirectLowImpactRecon: true,
      }),
      'RECON',
    );
    const session = database.createSession(engagement.id, 'recon', 'ollama', 'model');
    const events = new EventHub(database);
    const artifacts = new ArtifactStore(join(root, 'artifacts'), database);
    const result = (stdout: string) => ({
      stdout,
      stderr: '',
      exitCode: 0,
      profile: 'safe' as const,
      image: 'test-safe',
    });
    const runner = {
      subfinder: async () => result('api.example.com\nauth.example.com\n'),
      dnsx: async () =>
        result(
          `${JSON.stringify({ host: 'example.com', a: ['203.0.113.10'] })}\n${JSON.stringify({ host: 'api.example.com', a: ['203.0.113.11'] })}\n`,
        ),
      httpx: async () =>
        result(
          `${JSON.stringify({ url: 'https://example.com/', status_code: 200, title: 'Home' })}\n${JSON.stringify({ url: 'https://api.example.com/', status_code: 401, title: 'API Login' })}\n`,
        ),
      rawProfileAvailable: () => false,
    } as unknown as DockerScannerRunner;
    const actions = new ActionService(database, artifacts, events, runner);
    const service = new ReconService(database, artifacts, events, runner, actions);

    const started = service.start(session.id, 'standard');
    const completed = await waitForRun(service, session.id, started.id);
    expect(completed).toMatchObject({
      status: 'completed',
      progress: 100,
      summary: { inScopeAssets: 3, httpObservations: 2, approvalProposals: 2 },
    });
    expect(completed.steps.map((step) => step.status)).toEqual([
      'completed',
      'completed',
      'completed',
      'completed',
      'completed',
    ]);
    expect(completed.insights).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ target: 'https://api.example.com/', priority: 'high' }),
        expect.objectContaining({ skill: 'api-authorization', type: 'manual-test' }),
      ]),
    );
    expect(
      database
        .listActionProposals(session.id)
        .map((proposal) => proposal.action)
        .sort(),
    ).toEqual(['katana', 'nuclei']);
    database.close();
  });

  it('preserves and merges valid partial output when a discovery tool fails', async () => {
    const { WebDatabase } = await import('../storage/database.js');
    const root = mkdtempSync(join(tmpdir(), 'agent-workbench-recon-partial-'));
    roots.push(root);
    const database = new WebDatabase(join(root, 'db.sqlite3'));
    const engagement = database.createEngagement(
      'partial target',
      createScope({
        allowedHosts: ['example.com', '*.example.com'],
        allowThirdPartyPassiveSources: true,
        allowDirectLowImpactRecon: true,
      }),
      'RECON',
    );
    const session = database.createSession(engagement.id, 'partial recon', 'ollama', 'model');
    const events = new EventHub(database);
    const artifacts = new ArtifactStore(join(root, 'artifacts'), database);
    const runner = {
      subfinder: async () => ({
        stdout: 'API.Example.com.\napi.example.com\nbad..example.com\n',
        stderr: 'provider failed after emitting results',
        exitCode: 2,
        profile: 'safe' as const,
        image: 'test-safe',
        termination: 'exit' as const,
      }),
      dnsx: async () => ({
        stdout: `${JSON.stringify({ host: 'api.example.com', a: ['203.0.113.20'] })}\n`,
        stderr: '',
        exitCode: 0,
        profile: 'safe' as const,
        image: 'test-safe',
      }),
      httpx: async () => ({
        stdout: `${JSON.stringify({
          input: 'api.example.com',
          url: 'https://api.example.com',
          status_code: 401,
          title: 'API Login',
          tech: ['nginx'],
        })}\n`,
        stderr: '',
        exitCode: 0,
        profile: 'safe' as const,
        image: 'test-safe',
      }),
      rawProfileAvailable: () => false,
    } as unknown as DockerScannerRunner;
    const actions = new ActionService(database, artifacts, events, runner);
    const service = new ReconService(database, artifacts, events, runner, actions);

    const started = service.start(session.id, 'quick');
    const completed = await waitForRun(service, session.id, started.id);
    expect(completed.status).toBe('completed');
    const toolRuns = database.listReconToolRuns(started.id);
    expect(toolRuns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          tool: 'subfinder',
          status: 'failed',
          rawResults: 3,
          validResults: 2,
          uniqueResults: 1,
          exitCode: 2,
        }),
        expect.objectContaining({ tool: 'httpx', status: 'completed', uniqueResults: 1 }),
      ]),
    );
    const apiAsset = database.findReconAsset(started.id, 'api.example.com');
    expect(apiAsset).toMatchObject({
      inScope: true,
      dns: { resolved: true, addresses: ['203.0.113.20'] },
      http: { live: true, statusCode: 401 },
    });
    expect(apiAsset?.sources.map((source) => source.tool)).toContain('subfinder');
    const files = database.listArtifacts(session.id).map((artifact) => artifact.filename);
    expect(files).toEqual(
      expect.arrayContaining([
        'raw.txt',
        'parsed.txt',
        'metadata.json',
        'all-domains.txt',
        'all-domains-with-sources.json',
        'live-hosts.jsonl',
        'live-hosts.txt',
        'failed-inputs.txt',
        'summary.json',
      ]),
    );
    expect(database.eventsAfter(0, session.id).map((event) => event.type)).toContain(
      'recon.tool.partial',
    );
    const proposal = await service.createScanProposal(session.id, {
      assetIds: [apiAsset?.id ?? ''],
      action: 'katana',
      reason: 'Operator-selected API crawl',
    });
    expect(proposal).toMatchObject({ action: 'katana', status: 'pending' });
    expect(
      database.getArtifact(String(proposal.arguments.inputArtifactId))?.metadata,
    ).toMatchObject({
      runId: started.id,
      assetIds: [apiAsset?.id],
    });
    database.close();
  });
});

async function waitForRun(
  service: ReconService,
  sessionId: string,
  runId: string,
): Promise<ReturnType<ReconService['list']>[number]> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const run = service.list(sessionId).find((item) => item.id === runId);
    if (run && !['queued', 'running'].includes(run.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('recon run did not finish');
}
