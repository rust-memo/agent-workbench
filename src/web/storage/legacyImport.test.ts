import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ArtifactStore } from './artifacts.js';
import { LegacySessionImporter } from './legacyImport.js';
import { SqliteSessionStore } from './sqliteSessionStore.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const supportsNodeSqlite = Number.parseInt(process.versions.node.split('.')[0] ?? '0', 10) >= 22;

describe.skipIf(!supportsNodeSqlite)('legacy JSON migration and session lifecycle', () => {
  it('imports once without mutating JSON, exports metadata, and deletes exact artifacts', async () => {
    const { WebDatabase } = await import('./database.js');
    const root = mkdtempSync(join(tmpdir(), 'agent-workbench-import-'));
    roots.push(root);
    const legacyRoot = join(root, 'legacy');
    mkdirSync(legacyRoot, { mode: 0o700 });
    const dataRoot = join(root, 'web');
    const database = new WebDatabase(join(dataRoot, 'db.sqlite3'));
    const source = join(legacyRoot, 'safe.json');
    const body = `${JSON.stringify({
      updated_at: '2026-01-01T00:00:00.000Z',
      id: 'legacy-safe',
      target: { baseURL: 'https://example.com/', name: 'Example' },
      memory: null,
      messages: [{ role: 'user', content: 'review this target' }],
    })}\n`;
    writeFileSync(source, body, { mode: 0o600, flag: 'wx' });
    symlinkSync(source, join(legacyRoot, 'linked.json'));
    const importer = new LegacySessionImporter(database, legacyRoot);
    const listed = importer.list();
    expect(listed).toHaveLength(1);
    const legacyId = listed[0]?.id;
    if (!legacyId) throw new Error('legacy fixture was not listed');
    const imported = await importer.import(legacyId, {
      title: 'Imported review',
      provider: 'qwen',
      model: 'test-model',
      mode: 'PLAN',
    });
    expect(readFileSync(source, 'utf8')).toBe(body);
    expect(importer.list()[0]?.imported?.sessionId).toBe(imported.session?.id);
    await expect(
      importer.import(legacyId, {
        title: 'Again',
        provider: 'qwen',
        model: 'test-model',
        mode: 'PLAN',
      }),
    ).rejects.toThrow('already imported');
    const sessionId = imported.session?.id;
    if (!sessionId) throw new Error('legacy session was not imported');
    const store = new SqliteSessionStore(sessionId, database.db);
    expect(store.load().messages).toEqual([{ role: 'user', content: 'review this target' }]);
    const artifacts = new ArtifactStore(join(dataRoot, 'artifacts'), database);
    await artifacts.save({
      engagementId: imported.engagement.id,
      sessionId,
      kind: 'test',
      filename: 'evidence.txt',
      body: 'evidence',
    });
    expect(database.exportSession(sessionId)).toMatchObject({
      format: 'agent-workbench-session',
      formatVersion: 1,
      session: { title: 'Imported review' },
      messages: [{ role: 'user', content: 'review this target' }],
    });
    expect(artifacts.deleteSession(sessionId)).toBe(1);
    database.deleteSession(sessionId);
    expect(database.getSession(sessionId)).toBeUndefined();
    database.close();
  });
});
