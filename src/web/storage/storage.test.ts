import { existsSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createScope } from '../scope.js';
import { ArtifactStore } from './artifacts.js';
import { SqliteSessionStore } from './sqliteSessionStore.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function fixture() {
  const { WebDatabase } = await import('./database.js');
  const root = mkdtempSync(join(tmpdir(), 'pf-web-storage-'));
  roots.push(root);
  const database = new WebDatabase(join(root, 'db.sqlite3'));
  const engagement = database.createEngagement(
    'test',
    createScope({ allowedHosts: ['example.com'] }),
    'PLAN',
  );
  const session = database.createSession(engagement.id, 'session', 'ollama', 'model');
  return { root, database, sessionId: session.id, engagementId: engagement.id };
}

const supportsNodeSqlite = Number.parseInt(process.versions.node.split('.')[0] ?? '0', 10) >= 22;

describe.skipIf(!supportsNodeSqlite)('Web persistence', () => {
  it('uses global monotonic event sequence values', async () => {
    const { database, sessionId, engagementId } = await fixture();
    const first = database.appendEvent({ engagementId, sessionId, type: 'one', payload: {} });
    const second = database.appendEvent({ engagementId, sessionId, type: 'two', payload: {} });
    expect(second.seq).toBe(first.seq + 1);
    database.close();
  });

  it('round-trips web messages only through SQLite', async () => {
    const { database, sessionId } = await fixture();
    const store = new SqliteSessionStore(sessionId, database.db);
    await store.save([{ role: 'user', content: 'hello' }], null, null);
    expect(store.load().messages).toEqual([{ role: 'user', content: 'hello' }]);
    database.close();
  });

  it('hash-checks artifacts and refuses symlink replacement', async () => {
    const { root, database, sessionId, engagementId } = await fixture();
    const store = new ArtifactStore(join(root, 'artifacts'), database);
    const record = await store.save({
      engagementId,
      sessionId,
      kind: 'test',
      filename: 'evidence.txt',
      body: 'safe',
    });
    expect(store.read(record).toString()).toBe('safe');
    const storedPath = join(store.root, record.relativePath);
    unlinkSync(storedPath);
    const outside = join(root, 'outside.txt');
    writeFileSync(outside, 'secret');
    symlinkSync(outside, storedPath);
    expect(() => store.read(record)).toThrow('regular file');
    database.close();
  });

  it('moves orphan files into recovery on startup', async () => {
    const { root, database } = await fixture();
    const artifactRoot = join(root, 'artifacts');
    const store = new ArtifactStore(artifactRoot, database);
    const orphan = join(artifactRoot, 'orphan.txt');
    writeFileSync(orphan, 'unfinished metadata transaction');
    expect(store.recover().orphans).toBe(1);
    expect(existsSync(orphan)).toBe(false);
    database.close();
  });
});
