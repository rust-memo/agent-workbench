import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { EventHub } from '../events.js';
import type { DockerScannerRunner } from '../scanners/dockerRunner.js';
import { createScope } from '../scope.js';
import { ArtifactStore } from '../storage/artifacts.js';
import { ActionService } from './service.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const supportsNodeSqlite = Number.parseInt(process.versions.node.split('.')[0] ?? '0', 10) >= 22;

describe.skipIf(!supportsNodeSqlite)('approved scanner actions', () => {
  it('lets the operator decline a pending action without executing it', async () => {
    const { WebDatabase } = await import('../storage/database.js');
    const root = mkdtempSync(join(tmpdir(), 'agent-workbench-actions-reject-'));
    roots.push(root);
    const database = new WebDatabase(join(root, 'db.sqlite3'));
    const engagement = database.createEngagement(
      'approved target',
      createScope({ allowedHosts: ['example.com'], allowDirectLowImpactRecon: true }),
      'RECON',
    );
    const session = database.createSession(engagement.id, 'scan', 'ollama', 'model');
    const events = new EventHub(database);
    const artifacts = new ArtifactStore(join(root, 'artifacts'), database);
    const actions = new ActionService(
      database,
      artifacts,
      events,
      {} as unknown as DockerScannerRunner,
    );
    const proposal = actions.propose({
      engagementId: engagement.id,
      sessionId: session.id,
      action: 'nmap_connect',
      arguments: { inputArtifactId: randomUUID(), ports: [80, 443] },
      reason: 'bounded port follow-up',
      scopeVersion: engagement.scope.version,
      mode: engagement.mode,
    });

    const rejected = actions.reject(proposal.id, session.id);

    expect(rejected.status).toBe('cancelled');
    expect(rejected.error).toBe('declined by the operator');
    expect(database.eventsAfter(0, session.id).at(-1)?.type).toBe('action.rejected');
    expect(() => actions.claim(proposal.id, proposal.approvalHash, 'browser-session')).toThrow(
      'action proposal is no longer pending',
    );
    expect(() => actions.reject(proposal.id, session.id)).toThrow(
      'action proposal is no longer pending',
    );
    database.close();
  });

  it('creates only in-scope, unconfirmed findings and persistent coverage', async () => {
    const { WebDatabase } = await import('../storage/database.js');
    const root = mkdtempSync(join(tmpdir(), 'agent-workbench-actions-'));
    roots.push(root);
    const database = new WebDatabase(join(root, 'db.sqlite3'));
    const engagement = database.createEngagement(
      'approved target',
      createScope({ allowedHosts: ['example.com'], allowDirectLowImpactRecon: true }),
      'RECON',
    );
    const session = database.createSession(engagement.id, 'scan', 'ollama', 'model');
    const events = new EventHub(database);
    const artifacts = new ArtifactStore(join(root, 'artifacts'), database);
    const input = await artifacts.save({
      engagementId: engagement.id,
      sessionId: session.id,
      kind: 'http-observations',
      filename: 'httpx.json',
      body: JSON.stringify([{ url: 'https://example.com/' }]),
    });
    const scannerOutput = [
      {
        'template-id': 'safe-test',
        'matched-at': 'https://example.com/test',
        info: { name: 'In-scope signal', severity: 'medium' },
      },
      {
        'template-id': 'outside-test',
        'matched-at': 'https://outside.example/test',
        info: { name: 'Outside signal', severity: 'high' },
      },
    ]
      .map((row) => JSON.stringify(row))
      .join('\n');
    const runner = {
      nuclei: async () => ({
        stdout: `${scannerOutput}\n`,
        stderr: '',
        exitCode: 0,
        profile: 'safe',
        image: 'test-safe',
      }),
      validateHttp: async () => ({
        stdout: 'HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\n\r\nvalidated-marker',
        stderr: '',
        exitCode: 0,
        profile: 'safe',
        image: 'test-safe',
      }),
    } as unknown as DockerScannerRunner;
    const actions = new ActionService(database, artifacts, events, runner);
    const proposal = actions.propose({
      engagementId: engagement.id,
      sessionId: session.id,
      action: 'nuclei',
      arguments: { inputArtifactId: input.id, severities: ['medium', 'high'] },
      reason: 'safe HTTP template triage',
      scopeVersion: engagement.scope.version,
      mode: engagement.mode,
    });
    const claimed = actions.claim(proposal.id, proposal.approvalHash, 'browser-session');
    await actions.executeClaimed(claimed, new AbortController().signal);

    expect(database.getActionProposal(proposal.id)?.status).toBe('completed');
    expect(database.listFindings(session.id)).toMatchObject([
      {
        title: 'In-scope signal',
        status: 'needs_validation',
        scannerReference: 'safe-test',
      },
    ]);
    expect(database.coverageSummary(session.id)).toMatchObject({ total: 1, tried: 1 });

    const finding = database.listFindings(session.id)[0];
    if (!finding) throw new Error('expected scanner finding');
    const validation = actions.propose({
      engagementId: engagement.id,
      sessionId: session.id,
      action: 'validate_http',
      arguments: {
        findingId: finding.id,
        method: 'GET',
        expectedStatus: 200,
        bodyContains: 'validated-marker',
      },
      reason: 'bounded HTTP evidence check',
      scopeVersion: engagement.scope.version,
      mode: engagement.mode,
    });
    expect(validation.risk).toBe('high');
    await actions.executeClaimed(
      actions.claim(validation.id, validation.approvalHash, 'browser-session'),
      new AbortController().signal,
    );
    expect(database.getFinding(finding.id)?.status).toBe('needs_validation');
    expect(database.listCoverage(session.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ vulnerabilityClass: 'validation:safe-test', status: 'passed' }),
      ]),
    );
    database.close();
  });

  it('saves valid partial scanner output before marking an approved action failed', async () => {
    const { WebDatabase } = await import('../storage/database.js');
    const root = mkdtempSync(join(tmpdir(), 'agent-workbench-actions-partial-'));
    roots.push(root);
    const database = new WebDatabase(join(root, 'db.sqlite3'));
    const engagement = database.createEngagement(
      'partial action target',
      createScope({ allowedHosts: ['example.com'], allowDirectLowImpactRecon: true }),
      'RECON',
    );
    const session = database.createSession(engagement.id, 'partial scan', 'ollama', 'model');
    const reconRun = database.createReconRun(session.id, engagement.id, 'quick', [
      { key: 'http', label: 'HTTP' },
    ]);
    const events = new EventHub(database);
    const artifacts = new ArtifactStore(join(root, 'artifacts'), database);
    const input = await artifacts.save({
      engagementId: engagement.id,
      sessionId: session.id,
      kind: 'http-observations',
      filename: 'httpx.json',
      body: JSON.stringify([{ url: 'https://example.com/' }]),
      metadata: { runId: reconRun.id },
    });
    const runner = {
      katana: async () => ({
        stdout: `${JSON.stringify({ request: { endpoint: 'https://example.com/api' } })}\n`,
        stderr: 'crawler timed out after partial output',
        exitCode: 2,
        profile: 'safe' as const,
        image: 'test-safe',
        termination: 'timed_out' as const,
      }),
    } as unknown as DockerScannerRunner;
    const actions = new ActionService(database, artifacts, events, runner);
    const proposal = actions.propose({
      engagementId: engagement.id,
      sessionId: session.id,
      action: 'katana',
      arguments: { inputArtifactId: input.id, depth: 1 },
      reason: 'bounded partial crawler test',
      scopeVersion: engagement.scope.version,
      mode: engagement.mode,
    });
    const claimed = actions.claim(proposal.id, proposal.approvalHash, 'browser-session');

    await expect(actions.executeClaimed(claimed, new AbortController().signal)).rejects.toThrow(
      'katana exited 2',
    );
    const failed = database.getActionProposal(proposal.id);
    expect(failed).toMatchObject({ status: 'failed' });
    expect(failed?.resultArtifactId).toBeTruthy();
    expect(database.getArtifact(failed?.resultArtifactId ?? '')?.metadata).toMatchObject({
      partial: true,
      exitCode: 2,
    });
    expect(database.eventsAfter(0, session.id).at(-1)?.payload).toMatchObject({
      partialResultsSaved: true,
      artifactId: failed?.resultArtifactId,
    });
    expect(database.listReconToolRuns(reconRun.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          tool: 'katana',
          status: 'timed_out',
          validResults: 1,
          uniqueResults: 1,
          artifactIds: [failed?.resultArtifactId],
        }),
      ]),
    );
    database.close();
  });
});
