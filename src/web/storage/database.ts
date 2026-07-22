import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import type {
  ActionProposalRecord,
  ArtifactRecord,
  CoverageStatus,
  FindingStatus,
  ReconInsightRecord,
  ReconProfile,
  ReconRunRecord,
  ReconRunStatus,
  ReconStepRecord,
  ReconStepStatus,
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
        action TEXT NOT NULL CHECK(action IN ('katana','nuclei','ffuf','nmap_connect','nmap_raw','validate_http')),
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
      CREATE TABLE IF NOT EXISTS legacy_imports (
        source_sha256 TEXT PRIMARY KEY,
        file_name TEXT NOT NULL,
        source_updated_at TEXT,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        imported_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS recon_runs (
        id TEXT PRIMARY KEY,
        engagement_id TEXT NOT NULL REFERENCES engagements(id) ON DELETE CASCADE,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        profile TEXT NOT NULL CHECK(profile IN ('quick','standard','advanced')),
        status TEXT NOT NULL CHECK(status IN ('queued','running','completed','failed','cancelled')),
        current_step TEXT,
        progress INTEGER NOT NULL DEFAULT 0,
        summary_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT
      );
      CREATE INDEX IF NOT EXISTS recon_runs_session_created
        ON recon_runs(session_id, created_at DESC);
      CREATE TABLE IF NOT EXISTS recon_steps (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES recon_runs(id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL,
        step_key TEXT NOT NULL,
        label TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending','running','completed','skipped','failed','cancelled')),
        artifact_id TEXT REFERENCES artifacts(id) ON DELETE SET NULL,
        detail TEXT,
        metrics_json TEXT NOT NULL DEFAULT '{}',
        started_at TEXT,
        completed_at TEXT,
        UNIQUE(run_id, step_key)
      );
      CREATE TABLE IF NOT EXISTS recon_insights (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES recon_runs(id) ON DELETE CASCADE,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        type TEXT NOT NULL CHECK(type IN ('asset','signal','recommendation','manual-test')),
        priority TEXT NOT NULL CHECK(priority IN ('critical','high','medium','low','info')),
        title TEXT NOT NULL,
        rationale TEXT NOT NULL,
        target TEXT,
        skill TEXT,
        status TEXT NOT NULL CHECK(status IN ('new','accepted','dismissed','completed')),
        source_step TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS recon_insights_run_priority
        ON recon_insights(run_id, priority, created_at DESC);
    `);
    this.migrateActionProposalActions();
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
      "UPDATE sessions SET state = 'error' WHERE state = 'running'; UPDATE turns SET status = 'error', completed_at = datetime('now') WHERE status = 'running'; UPDATE action_proposals SET status = 'failed', error = 'server restarted during execution', updated_at = datetime('now') WHERE status = 'running'; UPDATE recon_runs SET status = 'failed', completed_at = datetime('now'), summary_json = '{\"error\":\"server restarted during recon\"}' WHERE status IN ('queued','running'); UPDATE recon_steps SET status = 'failed', detail = 'server restarted during recon', completed_at = datetime('now') WHERE status = 'running';",
    );
  }

  private migrateActionProposalActions(): void {
    const row = this.db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'action_proposals'")
      .get() as { sql?: string } | undefined;
    if (row?.sql?.includes("'validate_http'")) return;
    this.db.exec(`
      PRAGMA foreign_keys=OFF;
      BEGIN IMMEDIATE;
      CREATE TABLE action_proposals_v4 (
        id TEXT PRIMARY KEY,
        engagement_id TEXT NOT NULL REFERENCES engagements(id) ON DELETE CASCADE,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        turn_id TEXT,
        action TEXT NOT NULL CHECK(action IN ('katana','nuclei','ffuf','nmap_connect','nmap_raw','validate_http')),
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
      INSERT INTO action_proposals_v4 SELECT * FROM action_proposals;
      DROP TABLE action_proposals;
      ALTER TABLE action_proposals_v4 RENAME TO action_proposals;
      CREATE INDEX action_proposals_session_created
        ON action_proposals(session_id, created_at DESC);
      COMMIT;
      PRAGMA foreign_keys=ON;
    `);
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

  rejectActionProposal(id: string, sessionId: string): ActionProposalRecord {
    const result = this.db
      .prepare(
        `UPDATE action_proposals
         SET status = 'cancelled', error = 'declined by the operator', updated_at = ?
         WHERE id = ? AND session_id = ? AND status = 'pending'`,
      )
      .run(new Date().toISOString(), id, sessionId);
    if (Number(result.changes) !== 1) throw new Error('action proposal is no longer pending');
    const rejected = this.getActionProposal(id);
    if (!rejected) throw new Error('action proposal not found');
    return rejected;
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

  getFinding(id: string): WebFindingRecord | undefined {
    const row = this.db.prepare('SELECT * FROM findings WHERE id = ?').get(id) as
      | SqlRow
      | undefined;
    return row ? findingFromRow(row) : undefined;
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

  createReconRun(
    sessionId: string,
    engagementId: string,
    profile: ReconProfile,
    steps: Array<{ key: string; label: string }>,
  ): ReconRunRecord {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db
        .prepare(
          `INSERT INTO recon_runs
          (id, engagement_id, session_id, profile, status, progress, summary_json, created_at)
          VALUES (?, ?, ?, ?, 'queued', 0, '{}', ?)`,
        )
        .run(id, engagementId, sessionId, profile, now);
      const insert = this.db.prepare(
        `INSERT INTO recon_steps
        (id, run_id, ordinal, step_key, label, status, metrics_json)
        VALUES (?, ?, ?, ?, ?, 'pending', '{}')`,
      );
      steps.forEach((step, ordinal) => insert.run(randomUUID(), id, ordinal, step.key, step.label));
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    const run = this.getReconRun(id);
    if (!run) throw new Error('recon run was not created');
    return run;
  }

  getReconRun(id: string): ReconRunRecord | undefined {
    const row = this.db.prepare('SELECT * FROM recon_runs WHERE id = ?').get(id) as
      | SqlRow
      | undefined;
    return row
      ? reconRunFromRow(row, this.listReconSteps(id), this.listReconInsights(id))
      : undefined;
  }

  listReconRuns(sessionId: string): ReconRunRecord[] {
    return (
      this.db
        .prepare('SELECT * FROM recon_runs WHERE session_id = ? ORDER BY created_at DESC')
        .all(sessionId) as SqlRow[]
    ).map((row) => {
      const id = String(row.id);
      return reconRunFromRow(row, this.listReconSteps(id), this.listReconInsights(id));
    });
  }

  startReconRun(id: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        "UPDATE recon_runs SET status = 'running', started_at = ?, current_step = NULL WHERE id = ? AND status = 'queued'",
      )
      .run(now, id);
  }

  updateReconStep(
    runId: string,
    key: string,
    status: ReconStepStatus,
    input: {
      artifactId?: string;
      detail?: string;
      metrics?: Record<string, unknown>;
    } = {},
  ): ReconStepRecord {
    const now = new Date().toISOString();
    const startedAt = status === 'running' ? now : undefined;
    const completedAt = ['completed', 'skipped', 'failed', 'cancelled'].includes(status)
      ? now
      : undefined;
    this.db
      .prepare(
        `UPDATE recon_steps SET status = ?, artifact_id = COALESCE(?, artifact_id),
         detail = COALESCE(?, detail), metrics_json = ?,
         started_at = COALESCE(?, started_at), completed_at = COALESCE(?, completed_at)
         WHERE run_id = ? AND step_key = ?`,
      )
      .run(
        status,
        input.artifactId ?? null,
        input.detail ?? null,
        JSON.stringify(input.metrics ?? {}),
        startedAt ?? null,
        completedAt ?? null,
        runId,
        key,
      );
    const steps = this.listReconSteps(runId);
    const step = steps.find((item) => item.key === key);
    if (!step) throw new Error('recon step not found');
    const finished = steps.filter((item) =>
      ['completed', 'skipped', 'failed', 'cancelled'].includes(item.status),
    ).length;
    this.db
      .prepare('UPDATE recon_runs SET current_step = ?, progress = ? WHERE id = ?')
      .run(status === 'running' ? key : null, Math.round((finished / steps.length) * 100), runId);
    return step;
  }

  finishReconRun(
    id: string,
    status: Extract<ReconRunStatus, 'completed' | 'failed' | 'cancelled'>,
    summary: Record<string, unknown>,
  ): void {
    this.db
      .prepare(
        "UPDATE recon_runs SET status = ?, current_step = NULL, progress = CASE WHEN ? = 'completed' THEN 100 ELSE progress END, summary_json = ?, completed_at = ? WHERE id = ?",
      )
      .run(status, status, JSON.stringify(summary), new Date().toISOString(), id);
  }

  addReconInsight(
    input: Omit<ReconInsightRecord, 'id' | 'status' | 'createdAt' | 'updatedAt'>,
  ): ReconInsightRecord {
    const now = new Date().toISOString();
    const record: ReconInsightRecord = {
      ...input,
      id: randomUUID(),
      status: 'new',
      createdAt: now,
      updatedAt: now,
    };
    this.db
      .prepare(
        `INSERT INTO recon_insights
        (id, run_id, session_id, type, priority, title, rationale, target, skill, status, source_step, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.runId,
        record.sessionId,
        record.type,
        record.priority,
        record.title,
        record.rationale,
        record.target ?? null,
        record.skill ?? null,
        record.status,
        record.sourceStep ?? null,
        now,
        now,
      );
    return record;
  }

  updateReconInsight(
    id: string,
    sessionId: string,
    status: ReconInsightRecord['status'],
  ): ReconInsightRecord {
    const result = this.db
      .prepare(
        'UPDATE recon_insights SET status = ?, updated_at = ? WHERE id = ? AND session_id = ?',
      )
      .run(status, new Date().toISOString(), id, sessionId);
    if (Number(result.changes) !== 1) throw new Error('recon insight not found');
    const row = this.db.prepare('SELECT * FROM recon_insights WHERE id = ?').get(id) as SqlRow;
    return reconInsightFromRow(row);
  }

  private listReconSteps(runId: string): ReconStepRecord[] {
    return (
      this.db
        .prepare('SELECT * FROM recon_steps WHERE run_id = ? ORDER BY ordinal')
        .all(runId) as SqlRow[]
    ).map(reconStepFromRow);
  }

  private listReconInsights(runId: string): ReconInsightRecord[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM recon_insights WHERE run_id = ? ORDER BY CASE priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END, created_at DESC",
        )
        .all(runId) as SqlRow[]
    ).map(reconInsightFromRow);
  }

  getLegacyImport(sourceSha256: string): { sessionId: string; importedAt: string } | undefined {
    const row = this.db
      .prepare('SELECT session_id, imported_at FROM legacy_imports WHERE source_sha256 = ?')
      .get(sourceSha256) as { session_id: string; imported_at: string } | undefined;
    return row ? { sessionId: row.session_id, importedAt: row.imported_at } : undefined;
  }

  recordLegacyImport(input: {
    sourceSha256: string;
    fileName: string;
    sourceUpdatedAt?: string;
    sessionId: string;
  }): void {
    this.db
      .prepare(
        'INSERT INTO legacy_imports (source_sha256, file_name, source_updated_at, session_id, imported_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(
        input.sourceSha256,
        input.fileName,
        input.sourceUpdatedAt ?? null,
        input.sessionId,
        new Date().toISOString(),
      );
  }

  exportSession(sessionId: string): Record<string, unknown> {
    const session = this.getSession(sessionId);
    if (!session) throw new Error('session not found');
    const engagement = this.getEngagement(session.engagementId);
    if (!engagement) throw new Error('engagement not found');
    const state = this.db
      .prepare('SELECT target_json, memory_json, context_snapshot FROM sessions WHERE id = ?')
      .get(sessionId) as {
      target_json: string | null;
      memory_json: string | null;
      context_snapshot: string | null;
    };
    const messages = this.db
      .prepare('SELECT message_json FROM messages WHERE session_id = ? ORDER BY ordinal')
      .all(sessionId) as Array<{ message_json: string }>;
    const turns = this.db
      .prepare(
        'SELECT id, status, user_message, created_at, completed_at FROM turns WHERE session_id = ? ORDER BY created_at',
      )
      .all(sessionId);
    return {
      format: 'agent-workbench-session',
      formatVersion: 1,
      exportedAt: new Date().toISOString(),
      engagement,
      session,
      target: state.target_json ? JSON.parse(state.target_json) : null,
      memory: state.memory_json ? JSON.parse(state.memory_json) : null,
      contextSnapshot: state.context_snapshot,
      messages: messages.map((row) => JSON.parse(row.message_json)),
      turns,
      events: this.eventsAfter(0, sessionId, 100_000),
      artifacts: this.listArtifacts(sessionId),
      actions: this.listActionProposals(sessionId),
      findings: this.listFindings(sessionId),
      coverage: this.listCoverage(sessionId),
      reconRuns: this.listReconRuns(sessionId),
    };
  }

  deleteSession(sessionId: string): void {
    if (!this.getSession(sessionId)) throw new Error('session not found');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('DELETE FROM recon_insights WHERE session_id = ?').run(sessionId);
      this.db
        .prepare(
          'DELETE FROM recon_steps WHERE run_id IN (SELECT id FROM recon_runs WHERE session_id = ?)',
        )
        .run(sessionId);
      this.db.prepare('DELETE FROM recon_runs WHERE session_id = ?').run(sessionId);
      this.db.prepare('DELETE FROM findings WHERE session_id = ?').run(sessionId);
      this.db.prepare('DELETE FROM coverage WHERE session_id = ?').run(sessionId);
      this.db.prepare('DELETE FROM action_proposals WHERE session_id = ?').run(sessionId);
      this.db.prepare('DELETE FROM messages WHERE session_id = ?').run(sessionId);
      this.db.prepare('DELETE FROM turns WHERE session_id = ?').run(sessionId);
      this.db.prepare('DELETE FROM events WHERE session_id = ?').run(sessionId);
      this.db.prepare('DELETE FROM audit_log WHERE session_id = ?').run(sessionId);
      this.db.prepare('DELETE FROM artifacts WHERE session_id = ?').run(sessionId);
      this.db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
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

function reconRunFromRow(
  r: SqlRow,
  steps: ReconStepRecord[],
  insights: ReconInsightRecord[],
): ReconRunRecord {
  return {
    id: String(r.id),
    engagementId: String(r.engagement_id),
    sessionId: String(r.session_id),
    profile: String(r.profile) as ReconProfile,
    status: String(r.status) as ReconRunStatus,
    currentStep: r.current_step ? String(r.current_step) : undefined,
    progress: Number(r.progress),
    summary: JSON.parse(String(r.summary_json)),
    createdAt: String(r.created_at),
    startedAt: r.started_at ? String(r.started_at) : undefined,
    completedAt: r.completed_at ? String(r.completed_at) : undefined,
    steps,
    insights,
  };
}

function reconStepFromRow(r: SqlRow): ReconStepRecord {
  return {
    id: String(r.id),
    runId: String(r.run_id),
    ordinal: Number(r.ordinal),
    key: String(r.step_key),
    label: String(r.label),
    status: String(r.status) as ReconStepStatus,
    artifactId: r.artifact_id ? String(r.artifact_id) : undefined,
    detail: r.detail ? String(r.detail) : undefined,
    metrics: JSON.parse(String(r.metrics_json)),
    startedAt: r.started_at ? String(r.started_at) : undefined,
    completedAt: r.completed_at ? String(r.completed_at) : undefined,
  };
}

function reconInsightFromRow(r: SqlRow): ReconInsightRecord {
  return {
    id: String(r.id),
    runId: String(r.run_id),
    sessionId: String(r.session_id),
    type: String(r.type) as ReconInsightRecord['type'],
    priority: String(r.priority) as ReconInsightRecord['priority'],
    title: String(r.title),
    rationale: String(r.rationale),
    target: r.target ? String(r.target) : undefined,
    skill: r.skill ? String(r.skill) : undefined,
    status: String(r.status) as ReconInsightRecord['status'],
    sourceStep: r.source_step ? String(r.source_step) : undefined,
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}
