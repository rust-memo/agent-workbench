import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmdirSync,
  unlinkSync,
} from 'node:fs';
import { chmod, open } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import type { ArtifactRecord, RuntimeEvent } from '../types.js';
import type { WebDatabase } from './database.js';

export class ArtifactStore {
  readonly root: string;

  constructor(
    root: string,
    private readonly database: WebDatabase,
    private readonly onEvent?: (event: RuntimeEvent) => void,
  ) {
    this.root = resolve(root);
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
  }

  async save(input: {
    engagementId: string;
    sessionId: string;
    turnId?: string;
    kind: string;
    filename: string;
    mediaType?: string;
    body: string | Uint8Array;
    metadata?: Record<string, unknown>;
    /**
     * Optional server-owned path segments. Callers must use fixed identifiers
     * (engagement/run/tool), never arbitrary scanner or model output.
     */
    directory?: string[];
  }): Promise<ArtifactRecord> {
    const id = randomUUID();
    const safeName =
      basename(input.filename)
        .replace(/[^a-zA-Z0-9._-]/g, '_')
        .slice(0, 120) || 'artifact.txt';
    const directory = input.directory?.map(safePathSegment);
    const relativePath = directory
      ? `${directory.join('/')}/${safeName}`
      : `${input.engagementId}/${input.sessionId}/${id}-${safeName}`;
    const finalPath = this.resolveStoredPath(relativePath);
    mkdirSync(resolve(finalPath, '..'), { recursive: true, mode: 0o700 });
    const tmpPath = `${finalPath}.tmp`;
    const bytes =
      typeof input.body === 'string' ? Buffer.from(input.body) : Buffer.from(input.body);
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(tmpPath, 'wx', 0o600);
      await handle.writeFile(bytes);
      await handle.sync();
      await handle.close();
      handle = undefined;
      renameSync(tmpPath, finalPath);
      await chmod(finalPath, 0o600);
    } catch (error) {
      await handle?.close().catch(() => undefined);
      try {
        unlinkSync(tmpPath);
      } catch {
        /* best effort */
      }
      throw error;
    }
    const record: ArtifactRecord = {
      id,
      engagementId: input.engagementId,
      sessionId: input.sessionId,
      turnId: input.turnId,
      kind: input.kind,
      filename: safeName,
      relativePath,
      mediaType: serverMediaType(safeName, input.mediaType),
      size: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      status: 'ready',
      metadata: input.metadata ?? {},
      createdAt: new Date().toISOString(),
    };
    try {
      this.database.db.exec('BEGIN IMMEDIATE');
      this.database.insertArtifact(record);
      const event = this.database.appendEvent({
        engagementId: record.engagementId,
        sessionId: record.sessionId,
        turnId: record.turnId,
        type: 'artifact.saved',
        payload: record,
      });
      this.database.db.exec('COMMIT');
      try {
        this.onEvent?.(event);
      } catch {
        /* persistence already committed */
      }
    } catch (error) {
      this.database.db.exec('ROLLBACK');
      // Keep the durable file for startup recovery instead of deleting evidence.
      throw error;
    }
    return record;
  }

  read(record: ArtifactRecord): Buffer {
    const path = this.resolveStoredPath(record.relativePath);
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('artifact is not a regular file');
    const body = readFileSync(path);
    const digest = createHash('sha256').update(body).digest('hex');
    if (digest !== record.sha256) {
      this.database.updateArtifactStatus(record.id, 'corrupt');
      throw new Error('artifact integrity check failed');
    }
    return body;
  }

  recover(): { removedTemps: number; missing: number; corrupt: number; orphans: number } {
    const result = { removedTemps: 0, missing: 0, corrupt: 0, orphans: 0 };
    const known = new Map(this.database.listArtifactPaths().map((row) => [row.relativePath, row]));
    for (const row of known.values()) {
      const path = this.resolveStoredPath(row.relativePath);
      if (!existsSync(path)) {
        this.database.updateArtifactStatus(row.id, 'missing');
        result.missing += 1;
        continue;
      }
      const info = lstatSync(path);
      if (!info.isFile() || info.isSymbolicLink()) {
        this.database.updateArtifactStatus(row.id, 'corrupt');
        result.corrupt += 1;
        continue;
      }
      const digest = createHash('sha256').update(readFileSync(path)).digest('hex');
      if (digest !== row.sha256) {
        this.database.updateArtifactStatus(row.id, 'corrupt');
        result.corrupt += 1;
      }
    }
    const recoveryRoot = join(this.root, 'recovery');
    mkdirSync(recoveryRoot, { recursive: true, mode: 0o700 });
    for (const path of walkFiles(this.root, recoveryRoot)) {
      const rel = path.slice(this.root.length + 1);
      if (rel.endsWith('.tmp')) {
        try {
          unlinkSync(path);
          result.removedTemps += 1;
        } catch {
          /* best effort */
        }
        continue;
      }
      if (!known.has(rel)) {
        try {
          renameSync(path, join(recoveryRoot, `${randomUUID()}-${basename(path)}.orphan`));
        } catch {
          /* best effort */
        }
        result.orphans += 1;
      }
    }
    return result;
  }

  deleteSession(sessionId: string): number {
    const records = this.database.listArtifacts(sessionId);
    let removed = 0;
    for (const record of records) {
      const path = this.resolveStoredPath(record.relativePath);
      const info = lstatSync(path, { throwIfNoEntry: false });
      if (!info) continue;
      if (!info.isFile() || info.isSymbolicLink())
        throw new Error('refusing to delete a non-regular artifact');
      unlinkSync(path);
      removed += 1;
    }
    const engagementId = records[0]?.engagementId;
    if (engagementId) {
      const sessionDir = resolve(this.root, engagementId, sessionId);
      if (sessionDir.startsWith(`${this.root}/`)) {
        try {
          rmdirSync(sessionDir);
        } catch {
          /* only prune an empty, exact session directory */
        }
      }
    }
    return removed;
  }

  private resolveStoredPath(relativePath: string): string {
    const path = resolve(this.root, relativePath);
    if (!path.startsWith(`${this.root}/`)) throw new Error('artifact path escaped storage root');
    return path;
  }
}

function safePathSegment(value: string): string {
  if (!/^[a-zA-Z0-9._-]{1,120}$/.test(value) || value === '.' || value === '..')
    throw new Error('invalid server-owned artifact directory');
  return value;
}

function serverMediaType(filename: string, hint?: string): string {
  if (filename.endsWith('.json')) return 'application/json';
  if (filename.endsWith('.jsonl')) return 'application/x-ndjson';
  if (filename.endsWith('.csv')) return 'text/csv; charset=utf-8';
  if (filename.endsWith('.xml')) return 'application/xml';
  if (filename.endsWith('.md')) return 'text/markdown; charset=utf-8';
  if (filename.endsWith('.txt') || filename.endsWith('.log')) return 'text/plain; charset=utf-8';
  return hint === 'application/json' ? hint : 'application/octet-stream';
}

function walkFiles(root: string, skipRoot?: string): string[] {
  const out: string[] = [];
  if (!existsSync(root)) return out;
  for (const entry of readdirSync(root)) {
    const path = join(root, entry);
    if (skipRoot && resolve(path) === resolve(skipRoot)) continue;
    const info = lstatSync(path, { throwIfNoEntry: false });
    if (!info) continue;
    if (info.isDirectory() && !info.isSymbolicLink()) out.push(...walkFiles(path, skipRoot));
    else out.push(path);
  }
  return out;
}
