import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import type {
  ActionProposalRecord,
  ArtifactRecord,
  CoverageStatus,
  FindingStatus,
  RuntimeEvent,
  ScopeDefinition,
  WebCoverageRecord,
  WebFindingRecord,
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
      CREATE TABLE IF NOT EXISTS action_proposals (
        id TEXT PRIMARY KEY,
        engagement_id TEXT NOT NULL REFERENCES engagements(id) ON DELETE CASCADE,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        turn_id TEXT,
        action TEXT NOT NULL CHECK(action IN ('katana','nuclei')),
        arguments_json TEXT NOT NULL,
        reason TEXT NOT NULL,
        risk TEXT NOT NULL CHECK(risk IN ('medium','high')),
        scope_version INTEGER NOT NULL,
        approval_hash TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending','running','completed','failed','cancelled','expired')),
        expires_at TEXT NOT NULL,
        approved_by TEXT,
        approved_at TEXT,
        consumed_at TEXT,
        result_artifact_id TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS action_proposals_session_created
        ON action_proposals(session_id, created_at DESC);
      CREATE TABLE IF NOT EXISTS findings (
        id TEXT PRIMARY KEY,
        engagement_id TEXT NOT NULL REFERENCES engagements(id) ON DELETE CASCADE,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        action_proposal_id TEXT REFERENCES action_proposals(id) ON DELETE SET NULL,
        evidence_artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE RESTRICT,
        title TEXT NOT NULL,
        severity TEXT NOT NULL CHECK(severity IN ('critical','high','medium','low','info')),
        status TEXT NOT NULL CHECK(status IN ('needs_validation','confirmed','false_positive','informational')),
        confidence TEXT NOT NULL CHECK(confidence = 'scanner'),
        url TEXT NOT NULL,
        scanner TEXT NOT NULL CHECK(scanner = 'nuclei'),
        scanner_reference TEXT NOT NULL,
        description TEXT,
        remediation TEXT,
        validation_artifact_id TEXT REFERENCES artifacts(id) ON DELETE RESTRICT,
        validation_note TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(session_id, scanner, scanner_reference, url)
      );
      CREATE INDEX IF NOT EXISTS findings_session_created ON findings(session_id, created_at DESC);
      CREATE TABLE IF NOT EXISTS coverage (
        id TEXT PRIMARY KEY,
        engagement_id TEXT NOT NULL REFERENCES engagements(id) ON DELETE CASCADE,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        asset TEXT NOT NULL,
        endpoint TEXT NOT NULL,
        parameter TEXT NOT NULL,
        vulnerability_class TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('untested','tried','passed','failed','waf-blocked','skipped')),
        source TEXT NOT NULL,
        notes TEXT,
        attempts INTEGER NOT NULL,
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        UNIQUE(session_id, endpoint, parameter, vulnerability_class)
      );
      CREATE INDEX IF NOT EXISTS coverage_session_status ON coverage(session_id, status);
    `);
    const sessionColumns = this.db.prepare('PRAGMA table_info(sessions)').all() as Array<{
      name: string;
    }>;
    if (!sessionColumns.some((column) => column.name === 'provider')) {
      this.db.exec("ALTER TABLE sessions ADD COLUMN provider TEXT NOT NULL DEFAULT 'ollama'");
    }
    const findingColumns = this.db.prepare('PRAGMA table_info(findings)').all() as Array<{
      name: string;
    }>;
    if (!findingColumns.some((column) => column.name === 'validation_artifact_id'))
      this.db.exec('ALTER TABLE findings ADD COLUMN validation_artifact_id TEXT');
    if (!findingColumns.some((column) => column.name === 'validation_note'))
      this.db.exec('ALTER TABLE findings ADD COLUMN validation_note TEXT');
    // A process died while running these turns; do not present them as live
    // after restart and never preserve an in-memory approval implicitly.
    this.db.exec(
      "UPDATE sessions SET state = 'error' WHERE state = 'running'; UPDATE turns SET status = 'error', completed_at = datetime('now') WHERE status = 'running'; UPDATE action_proposals SET status = 'failed', error = 'server restarted during execution', updated_at = datetime('now') WHERE status = 'running';",
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

  createActionProposal(
    input: Omit<
      ActionProposalRecord,
      | 'id'
      | 'status'
      | 'approvedBy'
      | 'approvedAt'
      | 'consumedAt'
      | 'resultArtifactId'
      | 'error'
      | 'createdAt'
      | 'updatedAt'
    >,
  ): ActionProposalRecord {
    const now = new Date().toISOString();
    const record: ActionProposalRecord = {
      ...input,
      id: randomUUID(),
      status: 'pending',
      createdAt: now,
      updatedAt: now,
    };
    this.db
      .prepare(`INSERT INTO action_proposals
      (id, engagement_id, session_id, turn_id, action, arguments_json, reason, risk, scope_version, approval_hash, status, expires_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        record.id,
        record.engagementId,
        record.sessionId,
        record.turnId ?? null,
        record.action,
        JSON.stringify(record.arguments),
        record.reason,
        record.risk,
        record.scopeVersion,
        record.approvalHash,
        record.status,
        record.expiresAt,
        now,
        now,
      );
    return record;
  }

  getActionProposal(id: string): ActionProposalRecord | undefined {
    const row = this.db.prepare('SELECT * FROM action_proposals WHERE id = ?').get(id) as
      | SqlRow
      | undefined;
    return row ? actionProposalFromRow(row) : undefined;
  }

  listActionProposals(sessionId: string): ActionProposalRecord[] {
    this.db
      .prepare(
        "UPDATE action_proposals SET status = 'expired', updated_at = ? WHERE session_id = ? AND status = 'pending' AND expires_at <= ?",
      )
      .run(new Date().toISOString(), sessionId, new Date().toISOString());
    return (
      this.db
        .prepare('SELECT * FROM action_proposals WHERE session_id = ? ORDER BY created_at DESC')
        .all(sessionId) as SqlRow[]
    ).map(actionProposalFromRow);
  }

  claimActionProposal(
    id: string,
    approvalHash: string,
    approvedBy: string,
    scopeVersion: number,
  ): ActionProposalRecord {
    const proposal = this.getActionProposal(id);
    if (!proposal) throw new Error('action proposal not found');
    if (proposal.status !== 'pending') throw new Error('action proposal is no longer pending');
    if (proposal.approvalHash !== approvalHash) throw new Error('action proposal hash mismatch');
    if (proposal.scopeVersion !== scopeVersion)
      throw new Error('scope changed; create a new proposal');
    if (Date.parse(proposal.expiresAt) <= Date.now()) {
      this.finishActionProposal(id, 'expired', undefined, 'approval expired');
      throw new Error('action proposal expired');
    }
    const now = new Date().toISOString();
    const result = this.db
      .prepare(`UPDATE action_proposals
        SET status = 'running', approved_by = ?, approved_at = ?, consumed_at = ?, updated_at = ?
        WHERE id = ? AND status = 'pending'`)
      .run(approvedBy, now, now, now, id);
    if (Number(result.changes) !== 1) throw new Error('action proposal was already consumed');
    const claimed = this.getActionProposal(id);
    if (!claimed) throw new Error('action proposal not found');
    return claimed;
  }

  finishActionProposal(
    id: string,
    status: 'completed' | 'failed' | 'cancelled' | 'expired',
    resultArtifactId?: string,
    error?: string,
  ): void {
    this.db
      .prepare(
        'UPDATE action_proposals SET status = ?, result_artifact_id = ?, error = ?, updated_at = ? WHERE id = ?',
      )
      .run(status, resultArtifactId ?? null, error ?? null, new Date().toISOString(), id);
  }

  insertFinding(
    input: Omit<WebFindingRecord, 'id' | 'createdAt' | 'updatedAt'>,
  ): WebFindingRecord | undefined {
    const now = new Date().toISOString();
    const record: WebFindingRecord = { ...input, id: randomUUID(), createdAt: now, updatedAt: now };
    const result = this.db
      .prepare(`INSERT OR IGNORE INTO findings
      (id, engagement_id, session_id, action_proposal_id, evidence_artifact_id, title, severity, status, confidence, url, scanner, scanner_reference, description, remediation, validation_artifact_id, validation_note, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        record.id,
        record.engagementId,
        record.sessionId,
        record.actionProposalId ?? null,
        record.evidenceArtifactId,
        record.title,
        record.severity,
        record.status,
        record.confidence,
        record.url,
        record.scanner,
        record.scannerReference,
        record.description ?? null,
        record.remediation ?? null,
        record.validationArtifactId ?? null,
        record.validationNote ?? null,
        now,
        now,
      );
    return Number(result.changes) === 1 ? record : undefined;
  }

  listFindings(sessionId: string): WebFindingRecord[] {
    return (
      this.db
        .prepare('SELECT * FROM findings WHERE session_id = ? ORDER BY created_at DESC')
        .all(sessionId) as SqlRow[]
    ).map(findingFromRow);
  }

  updateFindingStatus(
    id: string,
    sessionId: string,
    status: FindingStatus,
    validation?: { artifactId: string; note: string },
  ): WebFindingRecord {
    const result = this.db
      .prepare(
        'UPDATE findings SET status = ?, validation_artifact_id = ?, validation_note = ?, updated_at = ? WHERE id = ? AND session_id = ?',
      )
      .run(
        status,
        validation?.artifactId ?? null,
        validation?.note ?? null,
        new Date().toISOString(),
        id,
        sessionId,
      );
    if (Number(result.changes) !== 1) throw new Error('finding not found');
    const row = this.db.prepare('SELECT * FROM findings WHERE id = ?').get(id) as SqlRow;
    return findingFromRow(row);
  }

  upsertCoverage(
    input: Omit<WebCoverageRecord, 'id' | 'attempts' | 'firstSeenAt' | 'lastSeenAt'>,
  ): WebCoverageRecord {
    const now = new Date().toISOString();
    this.db
      .prepare(`INSERT INTO coverage
      (id, engagement_id, session_id, asset, endpoint, parameter, vulnerability_class, status, source, notes, attempts, first_seen_at, last_seen_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
      ON CONFLICT(session_id, endpoint, parameter, vulnerability_class) DO UPDATE SET
        asset = excluded.asset,
        status = excluded.status,
        source = excluded.source,
        notes = excluded.notes,
        attempts = coverage.attempts + 1,
        last_seen_at = excluded.last_seen_at`)
      .run(
        randomUUID(),
        input.engagementId,
        input.sessionId,
        input.asset,
        input.endpoint,
        input.parameter,
        input.vulnerabilityClass,
        input.status,
        input.source,
        input.notes ?? null,
        now,
        now,
      );
    const row = this.db
      .prepare(
        'SELECT * FROM coverage WHERE session_id = ? AND endpoint = ? AND parameter = ? AND vulnerability_class = ?',
      )
      .get(input.sessionId, input.endpoint, input.parameter, input.vulnerabilityClass) as SqlRow;
    return coverageFromRow(row);
  }

  listCoverage(sessionId: string, status?: CoverageStatus): WebCoverageRecord[] {
    const rows = status
      ? this.db
          .prepare(
            'SELECT * FROM coverage WHERE session_id = ? AND status = ? ORDER BY last_seen_at DESC',
          )
          .all(sessionId, status)
      : this.db
          .prepare('SELECT * FROM coverage WHERE session_id = ? ORDER BY last_seen_at DESC')
          .all(sessionId);
    return (rows as SqlRow[]).map(coverageFromRow);
  }

  coverageSummary(sessionId: string): Record<CoverageStatus | 'total', number> {
    const summary: Record<CoverageStatus | 'total', number> = {
      total: 0,
      untested: 0,
      tried: 0,
      passed: 0,
      failed: 0,
      'waf-blocked': 0,
      skipped: 0,
    };
    for (const row of this.db
      .prepare(
        'SELECT status, COUNT(*) AS count FROM coverage WHERE session_id = ? GROUP BY status',
      )
      .all(sessionId) as SqlRow[]) {
      const status = String(row.status) as CoverageStatus;
      summary[status] = Number(row.count);
      summary.total += Number(row.count);
    }
    return summary;
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

function actionProposalFromRow(r: SqlRow): ActionProposalRecord {
  return {
    id: String(r.id),
    engagementId: String(r.engagement_id),
    sessionId: String(r.session_id),
    turnId: r.turn_id ? String(r.turn_id) : undefined,
    action: String(r.action) as ActionProposalRecord['action'],
    arguments: JSON.parse(String(r.arguments_json)),
    reason: String(r.reason),
    risk: String(r.risk) as ActionProposalRecord['risk'],
    scopeVersion: Number(r.scope_version),
    approvalHash: String(r.approval_hash),
    status: String(r.status) as ActionProposalRecord['status'],
    expiresAt: String(r.expires_at),
    approvedBy: r.approved_by ? String(r.approved_by) : undefined,
    approvedAt: r.approved_at ? String(r.approved_at) : undefined,
    consumedAt: r.consumed_at ? String(r.consumed_at) : undefined,
    resultArtifactId: r.result_artifact_id ? String(r.result_artifact_id) : undefined,
    error: r.error ? String(r.error) : undefined,
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

function findingFromRow(r: SqlRow): WebFindingRecord {
  return {
    id: String(r.id),
    engagementId: String(r.engagement_id),
    sessionId: String(r.session_id),
    actionProposalId: r.action_proposal_id ? String(r.action_proposal_id) : undefined,
    evidenceArtifactId: String(r.evidence_artifact_id),
    title: String(r.title),
    severity: String(r.severity) as WebFindingRecord['severity'],
    status: String(r.status) as WebFindingRecord['status'],
    confidence: 'scanner',
    url: String(r.url),
    scanner: 'nuclei',
    scannerReference: String(r.scanner_reference),
    description: r.description ? String(r.description) : undefined,
    remediation: r.remediation ? String(r.remediation) : undefined,
    validationArtifactId: r.validation_artifact_id ? String(r.validation_artifact_id) : undefined,
    validationNote: r.validation_note ? String(r.validation_note) : undefined,
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

function coverageFromRow(r: SqlRow): WebCoverageRecord {
  return {
    id: String(r.id),
    engagementId: String(r.engagement_id),
    sessionId: String(r.session_id),
    asset: String(r.asset),
    endpoint: String(r.endpoint),
    parameter: String(r.parameter),
    vulnerabilityClass: String(r.vulnerability_class),
    status: String(r.status) as WebCoverageRecord['status'],
    source: String(r.source),
    notes: r.notes ? String(r.notes) : undefined,
    attempts: Number(r.attempts),
    firstSeenAt: String(r.first_seen_at),
    lastSeenAt: String(r.last_seen_at),
  };
}
