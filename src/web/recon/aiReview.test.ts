import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { EventHub } from '../events.js';
import type { WebProviderManager } from '../providers/manager.js';
import { createScope } from '../scope.js';
import { ArtifactStore } from '../storage/artifacts.js';
import type { WebDatabase } from '../storage/database.js';
import { ReconAIReviewService } from './aiReview.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const supportsNodeSqlite = Number.parseInt(process.versions.node.split('.')[0] ?? '0', 10) >= 22;

describe.skipIf(!supportsNodeSqlite)('recon AI review', () => {
  it('requires hash-bound approval and dispatches only the redacted payload', async () => {
    const { WebDatabase } = await import('../storage/database.js');
    const root = mkdtempSync(join(tmpdir(), 'agent-workbench-ai-review-'));
    roots.push(root);
    const database = new WebDatabase(join(root, 'db.sqlite3'));
    const engagement = database.createEngagement(
      'AI review target',
      createScope({ allowedHosts: ['example.com', '*.example.com'] }),
      'RECON',
    );
    const session = database.createSession(engagement.id, 'review', 'qwen', 'test-model');
    const run = database.createReconRun(session.id, engagement.id, 'quick', [
      { key: 'scope', label: 'Scope' },
    ]);
    const toolRun = database.createReconToolRun({
      reconRunId: run.id,
      engagementId: engagement.id,
      sessionId: session.id,
      tool: 'subfinder',
      actionName: 'passive_subdomains',
    });
    const artifacts = new ArtifactStore(join(root, 'artifacts'), database);
    const evidence = await artifacts.save({
      engagementId: engagement.id,
      sessionId: session.id,
      kind: 'recon-evidence',
      filename: 'evidence.txt',
      body: 'api.example.com\nAuthorization: Bearer abcdefghijklmnopqrstuvwxyz123456\n',
    });
    const asset = database.upsertReconAsset({
      engagementId: engagement.id,
      sessionId: session.id,
      runId: run.id,
      value: 'api.example.com',
      normalizedValue: 'api.example.com',
      type: 'subdomain',
      inScope: true,
      activeTestingAllowed: false,
      source: {
        tool: 'subfinder',
        toolRunId: toolRun.id,
        artifactId: evidence.id,
        rawValue: 'api.example.com',
      },
    }).asset;
    let dispatched = '';
    const providers = {
      create: () => ({
        name: () => 'qwen',
        model: () => 'test-model',
        chat: async (request: { messages: Array<{ content: string }> }) => {
          dispatched = request.messages.at(-1)?.content ?? '';
          return {
            message: {
              role: 'assistant' as const,
              content: 'api.example.com is an API-related asset worth manual review.',
            },
            finishReason: 'stop' as const,
          };
        },
      }),
    } as unknown as WebProviderManager;
    const service = new ReconAIReviewService(
      database,
      artifacts,
      new EventHub(database),
      providers,
    );

    const review = service.prepare(session.id, {
      runId: run.id,
      objective: 'interesting-assets',
      assetIds: [asset.id],
      artifactIds: [evidence.id],
    });
    expect(review.redactedPreview).not.toContain('abcdefghijklmnopqrstuvwxyz123456');
    expect(() => service.approve(session.id, review.id, [])).toThrow('hash mismatch');

    service.approve(session.id, review.id, review.inputHashes);
    const completed = await waitForReview(database, review.id);
    expect(dispatched).toBe(review.redactedPreview);
    expect(dispatched).not.toContain('abcdefghijklmnopqrstuvwxyz123456');
    expect(completed.status).toBe('completed');
    expect(completed.responseArtifactId).toBeTruthy();
    expect(database.listAssetInterest(asset.id)).toEqual(
      expect.arrayContaining([expect.objectContaining({ markedBy: 'ai', reviewStatus: 'new' })]),
    );
    database.close();
  });
});

async function waitForReview(database: WebDatabase, id: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const review = database.getAIReview(id);
    if (review && !['pending_approval', 'running'].includes(review.status)) return review;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('AI review did not finish');
}
