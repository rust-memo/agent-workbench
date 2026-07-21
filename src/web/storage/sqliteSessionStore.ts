import type { DatabaseSync } from 'node:sqlite';
import type { Message, SessionMemory, SessionStore } from '../../session/store.js';
import { Target } from '../../target/target.js';

/** SQLite-only Web session store. It never reads or writes CLI JSON sessions. */
export class SqliteSessionStore implements SessionStore {
  constructor(
    readonly id: string,
    private readonly db: DatabaseSync,
  ) {}

  load(): { messages: Message[]; target: Target | null; memory: SessionMemory | null } {
    const session = this.db
      .prepare('SELECT target_json, memory_json FROM sessions WHERE id = ?')
      .get(this.id) as { target_json: string | null; memory_json: string | null } | undefined;
    const rows = this.db
      .prepare('SELECT message_json FROM messages WHERE session_id = ? ORDER BY ordinal')
      .all(this.id) as Array<{ message_json: string }>;
    return {
      messages: rows.map((row) => JSON.parse(row.message_json) as Message),
      target: session?.target_json ? Target.fromJSON(JSON.parse(session.target_json)) : null,
      memory: session?.memory_json ? (JSON.parse(session.memory_json) as SessionMemory) : null,
    };
  }

  async save(
    messages: Message[],
    target: Target | null,
    memory?: SessionMemory | null,
  ): Promise<void> {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('DELETE FROM messages WHERE session_id = ?').run(this.id);
      const insert = this.db.prepare(
        'INSERT INTO messages (session_id, ordinal, message_json) VALUES (?, ?, ?)',
      );
      messages.forEach((message, ordinal) => insert.run(this.id, ordinal, JSON.stringify(message)));
      this.db
        .prepare(
          'UPDATE sessions SET target_json = ?, memory_json = ?, updated_at = ? WHERE id = ?',
        )
        .run(
          target && !target.empty() ? JSON.stringify(target.toJSON()) : null,
          memory ? JSON.stringify(memory) : null,
          new Date().toISOString(),
          this.id,
        );
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  async clear(): Promise<void> {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('DELETE FROM messages WHERE session_id = ?').run(this.id);
      this.db
        .prepare(
          'UPDATE sessions SET target_json = NULL, memory_json = NULL, context_snapshot = NULL, updated_at = ? WHERE id = ?',
        )
        .run(new Date().toISOString(), this.id);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  async saveContextSnapshot(markdown: string): Promise<string> {
    this.db
      .prepare('UPDATE sessions SET context_snapshot = ?, updated_at = ? WHERE id = ?')
      .run(markdown, new Date().toISOString(), this.id);
    return `sqlite:session/${this.id}/context`;
  }
}
