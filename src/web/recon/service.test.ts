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
