import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import type {
  AIReviewRecord,
  ActionProposalRecord,
  ArtifactRecord,
  AssetInterest,
  CoverageStatus,
  FindingStatus,
  ReconArtifactLink,
  ReconAsset,
  ReconAssetSource,
  ReconHttpResult,
  ReconInsightRecord,
  ReconProfile,
  ReconRunRecord,
  ReconRunStatus,
  ReconStepRecord,
  ReconStepStatus,
  ReconToolRunRecord,
  ReconToolRunStatus,
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
      CREATE TABLE IF NOT EXISTS recon_tool_runs (
        id TEXT PRIMARY KEY,
        recon_run_id TEXT NOT NULL REFERENCES recon_runs(id) ON DELETE CASCADE,
        engagement_id TEXT NOT NULL REFERENCES engagements(id) ON DELETE CASCADE,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        tool TEXT NOT NULL,
        action_name TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('queued','running','saving','completed','failed','cancelled','timed_out')),
        started_at TEXT,
        ended_at TEXT,
        exit_code INTEGER,
        raw_results INTEGER NOT NULL DEFAULT 0,
        valid_results INTEGER NOT NULL DEFAULT 0,
        unique_results INTEGER NOT NULL DEFAULT 0,
        artifact_ids_json TEXT NOT NULL DEFAULT '[]',
        error TEXT,
        partial_stdout TEXT,
        partial_stderr TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS recon_tool_runs_run_created
        ON recon_tool_runs(recon_run_id, created_at);
      CREATE TABLE IF NOT EXISTS recon_assets (
        id TEXT PRIMARY KEY,
        engagement_id TEXT NOT NULL REFERENCES engagements(id) ON DELETE CASCADE,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        run_id TEXT NOT NULL REFERENCES recon_runs(id) ON DELETE CASCADE,
        value TEXT NOT NULL,
        normalized_value TEXT NOT NULL,
        type TEXT NOT NULL CHECK(type IN ('domain','subdomain','url','ip')),
        in_scope INTEGER NOT NULL CHECK(in_scope IN (0,1)),
        active_testing_allowed INTEGER NOT NULL CHECK(active_testing_allowed IN (0,1)),
        dns_json TEXT,
        http_json TEXT,
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        UNIQUE(run_id, normalized_value)
      );
      CREATE INDEX IF NOT EXISTS recon_assets_session_value
        ON recon_assets(session_id, normalized_value);
      CREATE INDEX IF NOT EXISTS recon_assets_run_scope
        ON recon_assets(run_id, in_scope, type);
      CREATE TABLE IF NOT EXISTS recon_asset_sources (
        id TEXT PRIMARY KEY,
        asset_id TEXT NOT NULL REFERENCES recon_assets(id) ON DELETE CASCADE,
        tool TEXT NOT NULL,
        run_id TEXT NOT NULL REFERENCES recon_runs(id) ON DELETE CASCADE,
        tool_run_id TEXT NOT NULL REFERENCES recon_tool_runs(id) ON DELETE CASCADE,
        artifact_id TEXT REFERENCES artifacts(id) ON DELETE SET NULL,
        raw_value TEXT NOT NULL,
        discovered_at TEXT NOT NULL,
        UNIQUE(asset_id, tool_run_id, raw_value)
      );
      CREATE INDEX IF NOT EXISTS recon_asset_sources_asset
        ON recon_asset_sources(asset_id, discovered_at);
      CREATE TABLE IF NOT EXISTS recon_http_results (
        id TEXT PRIMARY KEY,
        asset_id TEXT NOT NULL REFERENCES recon_assets(id) ON DELETE CASCADE,
        run_id TEXT NOT NULL REFERENCES recon_runs(id) ON DELETE CASCADE,
        tool_run_id TEXT NOT NULL REFERENCES recon_tool_runs(id) ON DELETE CASCADE,
        input TEXT NOT NULL,
        url TEXT NOT NULL,
        host TEXT NOT NULL,
        port INTEGER,
        scheme TEXT,
        status_code INTEGER,
        content_length INTEGER,
        title TEXT,
        technologies_json TEXT NOT NULL DEFAULT '[]',
        web_server TEXT,
        content_type TEXT,
        final_url TEXT,
        ip TEXT,
        cname TEXT,
        response_time TEXT,
        raw_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(tool_run_id, url)
      );
      CREATE INDEX IF NOT EXISTS recon_http_results_run_status
        ON recon_http_results(run_id, status_code);
      CREATE TABLE IF NOT EXISTS recon_artifact_links (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES recon_runs(id) ON DELETE CASCADE,
        tool_run_id TEXT REFERENCES recon_tool_runs(id) ON DELETE CASCADE,
        artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK(role IN ('raw','parsed','metadata','combined','httpx','failed-inputs','ai-review')),
        created_at TEXT NOT NULL,
        UNIQUE(artifact_id, role)
      );
      CREATE INDEX IF NOT EXISTS recon_artifact_links_run
        ON recon_artifact_links(run_id, tool_run_id);
      CREATE TABLE IF NOT EXISTS asset_interest (
        id TEXT PRIMARY KEY,
        asset_id TEXT NOT NULL REFERENCES recon_assets(id) ON DELETE CASCADE,
        score INTEGER NOT NULL CHECK(score BETWEEN 0 AND 100),
        reasons_json TEXT NOT NULL,
        marked_by TEXT NOT NULL CHECK(marked_by IN ('user','ai')),
        review_status TEXT NOT NULL CHECK(review_status IN ('new','reviewing','dismissed','promoted')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS asset_interest_asset_status
        ON asset_interest(asset_id, review_status, score DESC);
      CREATE TABLE IF NOT EXISTS ai_reviews (
        id TEXT PRIMARY KEY,
        engagement_id TEXT NOT NULL REFERENCES engagements(id) ON DELETE CASCADE,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        run_id TEXT REFERENCES recon_runs(id) ON DELETE SET NULL,
        status TEXT NOT NULL CHECK(status IN ('pending_approval','running','completed','failed','cancelled')),
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        objective TEXT NOT NULL,
        input_artifact_ids_json TEXT NOT NULL DEFAULT '[]',
        input_asset_ids_json TEXT NOT NULL DEFAULT '[]',
        input_hashes_json TEXT NOT NULL DEFAULT '[]',
        redacted_preview TEXT NOT NULL,
        payload_bytes INTEGER NOT NULL,
        response_artifact_id TEXT REFERENCES artifacts(id) ON DELETE SET NULL,
        error TEXT,
        created_at TEXT NOT NULL,
        approved_at TEXT,
        completed_at TEXT
      );
      CREATE INDEX IF NOT EXISTS ai_reviews_session_created
        ON ai_reviews(session_id, created_at DESC);
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
      "UPDATE sessions SET state = 'error' WHERE state = 'running'; UPDATE turns SET status = 'error', completed_at = datetime('now') WHERE status = 'running'; UPDATE action_proposals SET status = 'failed', error = 'server restarted during execution', updated_at = datetime('now') WHERE status = 'running'; UPDATE recon_runs SET status = 'failed', completed_at = datetime('now'), summary_json = '{\"error\":\"server restarted during recon\",\"partialResultsPreserved\":true}' WHERE status IN ('queued','running'); UPDATE recon_steps SET status = 'failed', detail = 'server restarted during recon; completed artifacts remain available', completed_at = datetime('now') WHERE status = 'running'; UPDATE recon_tool_runs SET status = 'failed', error = 'server restarted during tool execution; partial artifacts remain available', ended_at = datetime('now'), updated_at = datetime('now') WHERE status IN ('queued','running','saving'); UPDATE ai_reviews SET status = 'failed', error = 'server restarted during AI review', completed_at = datetime('now') WHERE status = 'running';",
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

  updateEngagementScope(id: string, scope: ScopeDefinition): EngagementRow {
    const now = new Date().toISOString();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = this.db
        .prepare('UPDATE engagements SET scope_json = ?, updated_at = ? WHERE id = ?')
        .run(JSON.stringify(scope), now, id);
      if (Number(result.changes) !== 1) throw new Error('engagement not found');
      this.db
        .prepare(
          `UPDATE action_proposals
           SET status = 'expired', error = 'scope policy changed', updated_at = ?
           WHERE engagement_id = ? AND status = 'pending'`,
        )
        .run(now, id);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    const engagement = this.getEngagement(id);
    if (!engagement) throw new Error('engagement not found');
    return engagement;
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

  createReconToolRun(input: {
    reconRunId: string;
    engagementId: string;
    sessionId: string;
    tool: string;
    actionName: string;
    metadata?: Record<string, unknown>;
  }): ReconToolRunRecord {
    const now = new Date().toISOString();
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO recon_tool_runs
        (id, recon_run_id, engagement_id, session_id, tool, action_name, status,
         artifact_ids_json, metadata_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 'queued', '[]', ?, ?, ?)`,
      )
      .run(
        id,
        input.reconRunId,
        input.engagementId,
        input.sessionId,
        input.tool,
        input.actionName,
        JSON.stringify(input.metadata ?? {}),
        now,
        now,
      );
    return this.getReconToolRun(id) as ReconToolRunRecord;
  }

  updateReconToolRun(
    id: string,
    status: ReconToolRunStatus,
    input: {
      exitCode?: number;
      rawResults?: number;
      validResults?: number;
      uniqueResults?: number;
      artifactIds?: string[];
      error?: string;
      partialStdout?: string;
      partialStderr?: string;
      metadata?: Record<string, unknown>;
    } = {},
  ): ReconToolRunRecord {
    const now = new Date().toISOString();
    const startedAt = status === 'running' ? now : null;
    const endedAt = ['completed', 'failed', 'cancelled', 'timed_out'].includes(status) ? now : null;
    const result = this.db
      .prepare(
        `UPDATE recon_tool_runs SET status = ?,
         started_at = COALESCE(started_at, ?), ended_at = COALESCE(?, ended_at),
         exit_code = COALESCE(?, exit_code),
         raw_results = COALESCE(?, raw_results),
         valid_results = COALESCE(?, valid_results),
         unique_results = COALESCE(?, unique_results),
         artifact_ids_json = COALESCE(?, artifact_ids_json),
         error = COALESCE(?, error),
         partial_stdout = COALESCE(?, partial_stdout),
         partial_stderr = COALESCE(?, partial_stderr),
         metadata_json = COALESCE(?, metadata_json),
         updated_at = ?
         WHERE id = ?`,
      )
      .run(
        status,
        startedAt,
        endedAt,
        input.exitCode ?? null,
        input.rawResults ?? null,
        input.validResults ?? null,
        input.uniqueResults ?? null,
        input.artifactIds ? JSON.stringify(input.artifactIds) : null,
        input.error ?? null,
        input.partialStdout ?? null,
        input.partialStderr ?? null,
        input.metadata ? JSON.stringify(input.metadata) : null,
        now,
        id,
      );
    if (Number(result.changes) !== 1) throw new Error('recon tool run not found');
    return this.getReconToolRun(id) as ReconToolRunRecord;
  }

  getReconToolRun(id: string): ReconToolRunRecord | undefined {
    const row = this.db.prepare('SELECT * FROM recon_tool_runs WHERE id = ?').get(id) as
      | SqlRow
      | undefined;
    return row ? reconToolRunFromRow(row) : undefined;
  }

  listReconToolRuns(runId: string): ReconToolRunRecord[] {
    return (
      this.db
        .prepare('SELECT * FROM recon_tool_runs WHERE recon_run_id = ? ORDER BY created_at')
        .all(runId) as SqlRow[]
    ).map(reconToolRunFromRow);
  }

  upsertReconAsset(input: {
    engagementId: string;
    sessionId: string;
    runId: string;
    value: string;
    normalizedValue: string;
    type: ReconAsset['type'];
    inScope: boolean;
    activeTestingAllowed: boolean;
    source: {
      tool: string;
      toolRunId: string;
      artifactId?: string;
      rawValue: string;
      discoveredAt?: string;
    };
  }): { asset: ReconAsset; created: boolean; sourceCreated: boolean } {
    const now = input.source.discoveredAt ?? new Date().toISOString();
    const id = randomUUID();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const inserted = this.db
        .prepare(
          `INSERT INTO recon_assets
          (id, engagement_id, session_id, run_id, value, normalized_value, type,
           in_scope, active_testing_allowed, first_seen_at, last_seen_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(run_id, normalized_value) DO UPDATE SET
            last_seen_at = excluded.last_seen_at,
            in_scope = MAX(recon_assets.in_scope, excluded.in_scope),
            active_testing_allowed = MAX(recon_assets.active_testing_allowed, excluded.active_testing_allowed)`,
        )
        .run(
          id,
          input.engagementId,
          input.sessionId,
          input.runId,
          input.value,
          input.normalizedValue,
          input.type,
          input.inScope ? 1 : 0,
          input.activeTestingAllowed ? 1 : 0,
          now,
          now,
        );
      const row = this.db
        .prepare('SELECT id FROM recon_assets WHERE run_id = ? AND normalized_value = ?')
        .get(input.runId, input.normalizedValue) as { id: string };
      const sourceId = randomUUID();
      const sourceInserted = this.db
        .prepare(
          `INSERT OR IGNORE INTO recon_asset_sources
          (id, asset_id, tool, run_id, tool_run_id, artifact_id, raw_value, discovered_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          sourceId,
          row.id,
          input.source.tool,
          input.runId,
          input.source.toolRunId,
          input.source.artifactId ?? null,
          input.source.rawValue,
          now,
        );
      this.db.exec('COMMIT');
      const asset = this.getReconAsset(row.id);
      if (!asset) throw new Error('recon asset was not persisted');
      return {
        asset,
        created: Number(inserted.changes) === 1 && row.id === id,
        sourceCreated: Number(sourceInserted.changes) === 1,
      };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  getReconAsset(id: string): ReconAsset | undefined {
    const row = this.db.prepare('SELECT * FROM recon_assets WHERE id = ?').get(id) as
      | SqlRow
      | undefined;
    return row ? reconAssetFromRow(row, this.listReconAssetSources(id)) : undefined;
  }

  findReconAsset(runId: string, normalizedValue: string): ReconAsset | undefined {
    const row = this.db
      .prepare('SELECT * FROM recon_assets WHERE run_id = ? AND normalized_value = ?')
      .get(runId, normalizedValue) as SqlRow | undefined;
    return row ? reconAssetFromRow(row, this.listReconAssetSources(String(row.id))) : undefined;
  }

  listReconAssets(sessionId: string, runId?: string): ReconAsset[] {
    const rows = runId
      ? this.db
          .prepare(
            'SELECT * FROM recon_assets WHERE session_id = ? AND run_id = ? ORDER BY normalized_value',
          )
          .all(sessionId, runId)
      : this.db
          .prepare('SELECT * FROM recon_assets WHERE session_id = ? ORDER BY last_seen_at DESC')
          .all(sessionId);
    return (rows as SqlRow[]).map((row) =>
      reconAssetFromRow(row, this.listReconAssetSources(String(row.id))),
    );
  }

  private listReconAssetSources(assetId: string): ReconAssetSource[] {
    return (
      this.db
        .prepare('SELECT * FROM recon_asset_sources WHERE asset_id = ? ORDER BY discovered_at')
        .all(assetId) as SqlRow[]
    ).map(reconAssetSourceFromRow);
  }

  updateReconAssetDns(id: string, dns: NonNullable<ReconAsset['dns']>): ReconAsset {
    this.db
      .prepare('UPDATE recon_assets SET dns_json = ?, last_seen_at = ? WHERE id = ?')
      .run(JSON.stringify(dns), new Date().toISOString(), id);
    const asset = this.getReconAsset(id);
    if (!asset) throw new Error('recon asset not found');
    return asset;
  }

  updateReconAssetHttp(id: string, http: NonNullable<ReconAsset['http']>): ReconAsset {
    this.db
      .prepare('UPDATE recon_assets SET http_json = ?, last_seen_at = ? WHERE id = ?')
      .run(JSON.stringify(http), new Date().toISOString(), id);
    const asset = this.getReconAsset(id);
    if (!asset) throw new Error('recon asset not found');
    return asset;
  }

  addReconHttpResult(input: Omit<ReconHttpResult, 'id' | 'createdAt'>): ReconHttpResult {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO recon_http_results
        (id, asset_id, run_id, tool_run_id, input, url, host, port, scheme, status_code,
         content_length, title, technologies_json, web_server, content_type, final_url,
         ip, cname, response_time, raw_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(tool_run_id, url) DO UPDATE SET
          status_code = excluded.status_code, title = excluded.title,
          technologies_json = excluded.technologies_json, raw_json = excluded.raw_json`,
      )
      .run(
        id,
        input.assetId,
        input.runId,
        input.toolRunId,
        input.input,
        input.url,
        input.host,
        input.port ?? null,
        input.scheme ?? null,
        input.statusCode ?? null,
        input.contentLength ?? null,
        input.title ?? null,
        JSON.stringify(input.technologies),
        input.webServer ?? null,
        input.contentType ?? null,
        input.finalUrl ?? null,
        input.ip ?? null,
        input.cname ?? null,
        input.responseTime ?? null,
        JSON.stringify(input.raw),
        now,
      );
    const row = this.db
      .prepare('SELECT * FROM recon_http_results WHERE tool_run_id = ? AND url = ?')
      .get(input.toolRunId, input.url) as SqlRow;
    return reconHttpResultFromRow(row);
  }

  listReconHttpResults(runId: string): ReconHttpResult[] {
    return (
      this.db
        .prepare('SELECT * FROM recon_http_results WHERE run_id = ? ORDER BY url')
        .all(runId) as SqlRow[]
    ).map(reconHttpResultFromRow);
  }

  linkReconArtifact(input: {
    runId: string;
    toolRunId?: string;
    artifactId: string;
    role: ReconArtifactLink['role'];
  }): ReconArtifactLink {
    const record: ReconArtifactLink = {
      id: randomUUID(),
      runId: input.runId,
      toolRunId: input.toolRunId,
      artifactId: input.artifactId,
      role: input.role,
      createdAt: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT OR REPLACE INTO recon_artifact_links
        (id, run_id, tool_run_id, artifact_id, role, created_at)
        VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.runId,
        record.toolRunId ?? null,
        record.artifactId,
        record.role,
        record.createdAt,
      );
    return record;
  }

  listReconArtifactLinks(runId: string): ReconArtifactLink[] {
    return (
      this.db
        .prepare('SELECT * FROM recon_artifact_links WHERE run_id = ? ORDER BY created_at')
        .all(runId) as SqlRow[]
    ).map(reconArtifactLinkFromRow);
  }

  addAssetInterest(input: Omit<AssetInterest, 'id' | 'createdAt' | 'updatedAt'>): AssetInterest {
    const now = new Date().toISOString();
    const record: AssetInterest = { ...input, id: randomUUID(), createdAt: now, updatedAt: now };
    this.db
      .prepare(
        `INSERT INTO asset_interest
        (id, asset_id, score, reasons_json, marked_by, review_status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.assetId,
        record.score,
        JSON.stringify(record.reasons),
        record.markedBy,
        record.reviewStatus,
        now,
        now,
      );
    return record;
  }

  listAssetInterest(assetId: string): AssetInterest[] {
    return (
      this.db
        .prepare('SELECT * FROM asset_interest WHERE asset_id = ? ORDER BY created_at DESC')
        .all(assetId) as SqlRow[]
    ).map(assetInterestFromRow);
  }

  createAIReview(
    input: Omit<
      AIReviewRecord,
      'id' | 'createdAt' | 'approvedAt' | 'completedAt' | 'responseArtifactId' | 'error'
    >,
  ): AIReviewRecord {
    const record: AIReviewRecord = {
      ...input,
      id: randomUUID(),
      createdAt: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO ai_reviews
        (id, engagement_id, session_id, run_id, status, provider, model, objective,
         input_artifact_ids_json, input_asset_ids_json, input_hashes_json,
         redacted_preview, payload_bytes, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.engagementId,
        record.sessionId,
        record.runId ?? null,
        record.status,
        record.provider,
        record.model,
        record.objective,
        JSON.stringify(record.inputArtifactIds),
        JSON.stringify(record.inputAssetIds),
        JSON.stringify(record.inputHashes),
        record.redactedPreview,
        record.payloadBytes,
        record.createdAt,
      );
    return record;
  }

  listAIReviews(sessionId: string): AIReviewRecord[] {
    return (
      this.db
        .prepare('SELECT * FROM ai_reviews WHERE session_id = ? ORDER BY created_at DESC')
        .all(sessionId) as SqlRow[]
    ).map(aiReviewFromRow);
  }

  getAIReview(id: string): AIReviewRecord | undefined {
    const row = this.db.prepare('SELECT * FROM ai_reviews WHERE id = ?').get(id) as
      | SqlRow
      | undefined;
    return row ? aiReviewFromRow(row) : undefined;
  }

  updateAIReview(
    id: string,
    status: AIReviewRecord['status'],
    input: { responseArtifactId?: string; error?: string; approved?: boolean } = {},
  ): AIReviewRecord {
    const now = new Date().toISOString();
    const result = this.db
      .prepare(
        `UPDATE ai_reviews SET status = ?,
         response_artifact_id = COALESCE(?, response_artifact_id),
         error = COALESCE(?, error),
         approved_at = COALESCE(?, approved_at),
         completed_at = COALESCE(?, completed_at)
         WHERE id = ?`,
      )
      .run(
        status,
        input.responseArtifactId ?? null,
        input.error ?? null,
        input.approved ? now : null,
        ['completed', 'failed', 'cancelled'].includes(status) ? now : null,
        id,
      );
    if (Number(result.changes) !== 1) throw new Error('AI review not found');
    return this.getAIReview(id) as AIReviewRecord;
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
      reconToolRuns: this.listReconRuns(sessionId).flatMap((run) => this.listReconToolRuns(run.id)),
      reconAssets: this.listReconAssets(sessionId),
      reconHttpResults: this.listReconRuns(sessionId).flatMap((run) =>
        this.listReconHttpResults(run.id),
      ),
      aiReviews: this.listAIReviews(sessionId),
    };
  }

  deleteSession(sessionId: string): void {
    if (!this.getSession(sessionId)) throw new Error('session not found');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('DELETE FROM ai_reviews WHERE session_id = ?').run(sessionId);
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

function reconToolRunFromRow(r: SqlRow): ReconToolRunRecord {
  return {
    id: String(r.id),
    reconRunId: String(r.recon_run_id),
    engagementId: String(r.engagement_id),
    sessionId: String(r.session_id),
    tool: String(r.tool),
    actionName: String(r.action_name),
    status: String(r.status) as ReconToolRunStatus,
    startedAt: r.started_at ? String(r.started_at) : undefined,
    endedAt: r.ended_at ? String(r.ended_at) : undefined,
    exitCode: r.exit_code === null || r.exit_code === undefined ? undefined : Number(r.exit_code),
    rawResults: Number(r.raw_results),
    validResults: Number(r.valid_results),
    uniqueResults: Number(r.unique_results),
    artifactIds: JSON.parse(String(r.artifact_ids_json)) as string[],
    error: r.error ? String(r.error) : undefined,
    partialStdout: r.partial_stdout ? String(r.partial_stdout) : undefined,
    partialStderr: r.partial_stderr ? String(r.partial_stderr) : undefined,
    metadata: JSON.parse(String(r.metadata_json)),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

function reconAssetFromRow(r: SqlRow, sources: ReconAssetSource[]): ReconAsset {
  return {
    id: String(r.id),
    engagementId: String(r.engagement_id),
    sessionId: String(r.session_id),
    runId: String(r.run_id),
    value: String(r.value),
    normalizedValue: String(r.normalized_value),
    type: String(r.type) as ReconAsset['type'],
    sources,
    inScope: Boolean(r.in_scope),
    activeTestingAllowed: Boolean(r.active_testing_allowed),
    firstSeenAt: String(r.first_seen_at),
    lastSeenAt: String(r.last_seen_at),
    dns: r.dns_json ? (JSON.parse(String(r.dns_json)) as ReconAsset['dns']) : undefined,
    http: r.http_json ? (JSON.parse(String(r.http_json)) as ReconAsset['http']) : undefined,
  };
}

function reconAssetSourceFromRow(r: SqlRow): ReconAssetSource {
  return {
    id: String(r.id),
    assetId: String(r.asset_id),
    tool: String(r.tool),
    runId: String(r.run_id),
    toolRunId: String(r.tool_run_id),
    artifactId: r.artifact_id ? String(r.artifact_id) : undefined,
    rawValue: String(r.raw_value),
    discoveredAt: String(r.discovered_at),
  };
}

function reconHttpResultFromRow(r: SqlRow): ReconHttpResult {
  return {
    id: String(r.id),
    assetId: String(r.asset_id),
    runId: String(r.run_id),
    toolRunId: String(r.tool_run_id),
    input: String(r.input),
    url: String(r.url),
    host: String(r.host),
    port: r.port === null || r.port === undefined ? undefined : Number(r.port),
    scheme: r.scheme ? String(r.scheme) : undefined,
    statusCode:
      r.status_code === null || r.status_code === undefined ? undefined : Number(r.status_code),
    contentLength:
      r.content_length === null || r.content_length === undefined
        ? undefined
        : Number(r.content_length),
    title: r.title ? String(r.title) : undefined,
    technologies: JSON.parse(String(r.technologies_json)) as string[],
    webServer: r.web_server ? String(r.web_server) : undefined,
    contentType: r.content_type ? String(r.content_type) : undefined,
    finalUrl: r.final_url ? String(r.final_url) : undefined,
    ip: r.ip ? String(r.ip) : undefined,
    cname: r.cname ? String(r.cname) : undefined,
    responseTime: r.response_time ? String(r.response_time) : undefined,
    raw: JSON.parse(String(r.raw_json)),
    createdAt: String(r.created_at),
  };
}

function reconArtifactLinkFromRow(r: SqlRow): ReconArtifactLink {
  return {
    id: String(r.id),
    runId: String(r.run_id),
    toolRunId: r.tool_run_id ? String(r.tool_run_id) : undefined,
    artifactId: String(r.artifact_id),
    role: String(r.role) as ReconArtifactLink['role'],
    createdAt: String(r.created_at),
  };
}

function assetInterestFromRow(r: SqlRow): AssetInterest {
  return {
    id: String(r.id),
    assetId: String(r.asset_id),
    score: Number(r.score),
    reasons: JSON.parse(String(r.reasons_json)) as string[],
    markedBy: String(r.marked_by) as AssetInterest['markedBy'],
    reviewStatus: String(r.review_status) as AssetInterest['reviewStatus'],
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

function aiReviewFromRow(r: SqlRow): AIReviewRecord {
  return {
    id: String(r.id),
    engagementId: String(r.engagement_id),
    sessionId: String(r.session_id),
    runId: r.run_id ? String(r.run_id) : undefined,
    status: String(r.status) as AIReviewRecord['status'],
    provider: String(r.provider) as WebProviderId,
    model: String(r.model),
    objective: String(r.objective),
    inputArtifactIds: JSON.parse(String(r.input_artifact_ids_json)) as string[],
    inputAssetIds: JSON.parse(String(r.input_asset_ids_json)) as string[],
    inputHashes: JSON.parse(String(r.input_hashes_json)) as string[],
    redactedPreview: String(r.redacted_preview),
    payloadBytes: Number(r.payload_bytes),
    responseArtifactId: r.response_artifact_id ? String(r.response_artifact_id) : undefined,
    error: r.error ? String(r.error) : undefined,
    createdAt: String(r.created_at),
    approvedAt: r.approved_at ? String(r.approved_at) : undefined,
    completedAt: r.completed_at ? String(r.completed_at) : undefined,
  };
}
