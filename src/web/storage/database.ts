import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import type {
  ArtifactRecord,
  RuntimeEvent,
  ScopeDefinition,
  WebMode,
  WebProviderId,
} from '../types.js';

// Keep the specifier dynamic so Node-20-targeted bundlers do not rewrite the
// newer built-in to the unrelated npm package named "sqlite".
const sqliteModule = await import(`node:${'sqlite'}`);
const DatabaseSync = sqliteModule.DatabaseSync;

export interface EngagementRow {
  id: string;
  name: string;
  scope: ScopeDefinition;
  mode: WebMode;
  createdAt: string;
  updatedAt: string;
}

export interface SessionRow {
  id: string;
  engagementId: string;
  title: string;
  provider: WebProviderId;
  model: string;
  state: 'idle' | 'running' | 'cancelled' | 'error';
  createdAt: string;
  updatedAt: string;
}

type SqlRow = Record<string, unknown>;

export class WebDatabase {
  readonly db: DatabaseSyncType;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL;');
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS engagements (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        scope_json TEXT NOT NULL,
        mode TEXT NOT NULL CHECK(mode IN ('PLAN','RECON')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        engagement_id TEXT NOT NULL REFERENCES engagements(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        provider TEXT NOT NULL DEFAULT 'qwen',
        model TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('idle','running','cancelled','error')),
        target_json TEXT,
        memory_json TEXT,
        context_snapshot TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS messages (
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL,
        message_json TEXT NOT NULL,
        PRIMARY KEY(session_id, ordinal)
      );
      CREATE TABLE IF NOT EXISTS turns (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        status TEXT NOT NULL,
        user_message TEXT NOT NULL,
        created_at TEXT NOT NULL,
        completed_at TEXT
      );
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL UNIQUE,
        engagement_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        turn_id TEXT,
        type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS events_session_seq ON events(session_id, id);
      CREATE TABLE IF NOT EXISTS artifacts (
        id TEXT PRIMARY KEY,
        engagement_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        turn_id TEXT,
        kind TEXT NOT NULL,
        filename TEXT NOT NULL,
        relative_path TEXT NOT NULL UNIQUE,
        media_type TEXT NOT NULL,
        size INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        status TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS artifacts_session_created ON artifacts(session_id, created_at);
      CREATE TABLE IF NOT EXISTS audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT,
        action TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
    const sessionColumns = this.db.prepare('PRAGMA table_info(sessions)').all() as Array<{
      name: string;
    }>;
    if (!sessionColumns.some((column) => column.name === 'provider')) {
      this.db.exec("ALTER TABLE sessions ADD COLUMN provider TEXT NOT NULL DEFAULT 'ollama'");
    }
    // A process died while running these turns; do not present them as live
    // after restart and never preserve an in-memory approval implicitly.
    this.db.exec(
      "UPDATE sessions SET state = 'error' WHERE state = 'running'; UPDATE turns SET status = 'error', completed_at = datetime('now') WHERE status = 'running';",
    );
  }

  createEngagement(name: string, scope: ScopeDefinition, mode: WebMode): EngagementRow {
    const now = new Date().toISOString();
    const row: EngagementRow = {
      id: randomUUID(),
      name,
      scope,
      mode,
      createdAt: now,
      updatedAt: now,
    };
    this.db
      .prepare('INSERT INTO engagements VALUES (?, ?, ?, ?, ?, ?)')
      .run(row.id, row.name, JSON.stringify(scope), row.mode, now, now);
    return row;
  }

  listEngagements(): EngagementRow[] {
    return (
      this.db.prepare('SELECT * FROM engagements ORDER BY updated_at DESC').all() as SqlRow[]
    ).map(engagementFromRow);
  }

  getEngagement(id: string): EngagementRow | undefined {
    const row = this.db.prepare('SELECT * FROM engagements WHERE id = ?').get(id) as
      | SqlRow
      | undefined;
    return row ? engagementFromRow(row) : undefined;
  }

  createSession(
    engagementId: string,
    title: string,
    provider: WebProviderId,
    model: string,
  ): SessionRow {
    const now = new Date().toISOString();
    const row: SessionRow = {
      id: randomUUID(),
      engagementId,
      title,
      provider,
      model,
      state: 'idle',
      createdAt: now,
      updatedAt: now,
    };
    this.db
      .prepare(`INSERT INTO sessions
      (id, engagement_id, title, provider, model, state, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(row.id, row.engagementId, row.title, row.provider, row.model, row.state, now, now);
    return row;
  }

  listSessions(engagementId?: string): SessionRow[] {
    const rows = engagementId
      ? this.db
          .prepare('SELECT * FROM sessions WHERE engagement_id = ? ORDER BY updated_at DESC')
          .all(engagementId)
      : this.db.prepare('SELECT * FROM sessions ORDER BY updated_at DESC').all();
    return (rows as SqlRow[]).map(sessionFromRow);
  }

  getSession(id: string): SessionRow | undefined {
    const row = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as
      | SqlRow
      | undefined;
    return row ? sessionFromRow(row) : undefined;
  }

  setSessionState(id: string, state: SessionRow['state']): void {
    this.db
      .prepare('UPDATE sessions SET state = ?, updated_at = ? WHERE id = ?')
      .run(state, new Date().toISOString(), id);
  }

  updateSessionProvider(id: string, provider: WebProviderId, model: string): SessionRow {
    this.db
      .prepare('UPDATE sessions SET provider = ?, model = ?, updated_at = ? WHERE id = ?')
      .run(provider, model, new Date().toISOString(), id);
    const session = this.getSession(id);
    if (!session) throw new Error('session not found');
    return session;
  }

  createTurn(sessionId: string, message: string): string {
    const id = randomUUID();
    this.db
      .prepare('INSERT INTO turns VALUES (?, ?, ?, ?, ?, NULL)')
      .run(id, sessionId, 'running', message, new Date().toISOString());
    return id;
  }

  finishTurn(id: string, status: 'completed' | 'cancelled' | 'error'): void {
    this.db
      .prepare('UPDATE turns SET status = ?, completed_at = ? WHERE id = ?')
      .run(status, new Date().toISOString(), id);
  }

  appendEvent(input: Omit<RuntimeEvent, 'seq' | 'eventId' | 'createdAt'>): RuntimeEvent {
    const eventId = randomUUID();
    const createdAt = new Date().toISOString();
    const result = this.db
      .prepare(`INSERT INTO events
      (event_id, engagement_id, session_id, turn_id, type, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(
        eventId,
        input.engagementId,
        input.sessionId,
        input.turnId ?? null,
        input.type,
        JSON.stringify(input.payload),
        createdAt,
      );
    return { ...input, seq: Number(result.lastInsertRowid), eventId, createdAt };
  }

  eventsAfter(after: number, sessionId?: string, limit = 1000): RuntimeEvent[] {
    const rows = sessionId
      ? this.db
          .prepare('SELECT * FROM events WHERE id > ? AND session_id = ? ORDER BY id LIMIT ?')
          .all(after, sessionId, limit)
      : this.db.prepare('SELECT * FROM events WHERE id > ? ORDER BY id LIMIT ?').all(after, limit);
    return (rows as SqlRow[]).map(eventFromRow);
  }

  insertArtifact(record: ArtifactRecord): void {
    this.db
      .prepare(`INSERT INTO artifacts
      (id, engagement_id, session_id, turn_id, kind, filename, relative_path, media_type, size, sha256, status, metadata_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        record.id,
        record.engagementId,
        record.sessionId,
        record.turnId ?? null,
        record.kind,
        record.filename,
        record.relativePath,
        record.mediaType,
        record.size,
        record.sha256,
        record.status,
        JSON.stringify(record.metadata),
        record.createdAt,
      );
  }

  updateArtifactStatus(id: string, status: ArtifactRecord['status']): void {
    this.db.prepare('UPDATE artifacts SET status = ? WHERE id = ?').run(status, id);
  }

  getArtifact(id: string): ArtifactRecord | undefined {
    const row = this.db.prepare('SELECT * FROM artifacts WHERE id = ?').get(id) as
      | SqlRow
      | undefined;
    return row ? artifactFromRow(row) : undefined;
  }

  listArtifacts(sessionId: string): ArtifactRecord[] {
    return (
      this.db
        .prepare('SELECT * FROM artifacts WHERE session_id = ? ORDER BY created_at DESC')
        .all(sessionId) as SqlRow[]
    ).map(artifactFromRow);
  }

  listArtifactPaths(): Array<{ id: string; relativePath: string; sha256: string }> {
    return (
      this.db.prepare('SELECT id, relative_path, sha256 FROM artifacts').all() as SqlRow[]
    ).map((r) => ({
      id: String(r.id),
      relativePath: String(r.relative_path),
      sha256: String(r.sha256),
    }));
  }

  audit(sessionId: string | undefined, action: string, payload: unknown): void {
    this.db
      .prepare(
        'INSERT INTO audit_log (session_id, action, payload_json, created_at) VALUES (?, ?, ?, ?)',
      )
      .run(sessionId ?? null, action, JSON.stringify(payload), new Date().toISOString());
  }
}

function engagementFromRow(r: SqlRow): EngagementRow {
  return {
    id: String(r.id),
    name: String(r.name),
    scope: JSON.parse(String(r.scope_json)) as ScopeDefinition,
    mode: String(r.mode) as WebMode,
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}
function sessionFromRow(r: SqlRow): SessionRow {
  return {
    id: String(r.id),
    engagementId: String(r.engagement_id),
    title: String(r.title),
    provider: String(r.provider ?? 'ollama') as WebProviderId,
    model: String(r.model),
    state: String(r.state) as SessionRow['state'],
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}
function eventFromRow(r: SqlRow): RuntimeEvent {
  return {
    seq: Number(r.id),
    eventId: String(r.event_id),
    engagementId: String(r.engagement_id),
    sessionId: String(r.session_id),
    turnId: r.turn_id ? String(r.turn_id) : undefined,
    type: String(r.type),
    payload: JSON.parse(String(r.payload_json)),
    createdAt: String(r.created_at),
  };
}
function artifactFromRow(r: SqlRow): ArtifactRecord {
  return {
    id: String(r.id),
    engagementId: String(r.engagement_id),
    sessionId: String(r.session_id),
    turnId: r.turn_id ? String(r.turn_id) : undefined,
    kind: String(r.kind),
    filename: String(r.filename),
    relativePath: String(r.relative_path),
    mediaType: String(r.media_type),
    size: Number(r.size),
    sha256: String(r.sha256),
    status: String(r.status) as ArtifactRecord['status'],
    metadata: JSON.parse(String(r.metadata_json)),
    createdAt: String(r.created_at),
  };
}
