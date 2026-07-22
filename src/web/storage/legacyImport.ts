import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { z } from 'zod';
import type { Message, SessionFile, SessionMemory } from '../../session/store.js';
import { Target } from '../../target/target.js';
import { createScope } from '../scope.js';
import type { WebMode, WebProviderId } from '../types.js';
import type { WebDatabase } from './database.js';
import { SqliteSessionStore } from './sqliteSessionStore.js';

const MAX_LEGACY_BYTES = 5 * 1024 * 1024;
const toolCallSchema = z
  .object({
    id: z.string().max(200),
    type: z.literal('function'),
    function: z.object({ name: z.string().max(200), arguments: z.string().max(500_000) }).strict(),
  })
  .strict();
const messageSchema = z
  .object({
    role: z.enum(['system', 'user', 'assistant', 'tool']),
    content: z.string().max(500_000),
    toolCalls: z.array(toolCallSchema).max(200).optional(),
    toolCallID: z.string().max(200).optional(),
    name: z.string().max(200).optional(),
  })
  .strict();
const memorySchema = z
  .object({
    version: z.literal(1),
    updatedAt: z.string().max(100),
    compactions: z.number().int().min(0).max(1_000_000),
    lastCompactedAt: z.string().max(100).optional(),
    lastSummary: z.string().max(500_000).optional(),
    objectives: z.array(z.string().max(20_000)).max(2_000),
    plan: z.array(z.string().max(20_000)).max(2_000),
    completed: z.array(z.string().max(20_000)).max(2_000),
    findings: z.array(z.string().max(20_000)).max(2_000),
    tested: z.array(z.string().max(20_000)).max(2_000),
    files: z.array(z.string().max(20_000)).max(2_000),
    commands: z.array(z.string().max(20_000)).max(2_000),
    credentials: z.array(z.string().max(20_000)).max(2_000),
    todos: z.array(z.string().max(20_000)).max(2_000),
  })
  .strict();
const legacySchema = z
  .object({
    updated_at: z.string().max(100),
    id: z.string().max(200).optional(),
    target: z
      .object({ baseURL: z.string().max(4096), name: z.string().max(500) })
      .strict()
      .nullable()
      .optional(),
    memory: memorySchema.nullable().optional(),
    messages: z.array(messageSchema).max(10_000),
  })
  .strict();

export interface LegacySessionSummary {
  id: string;
  fileName: string;
  updatedAt: string;
  preview: string;
  sourceSha256: string;
  imported?: { sessionId: string; importedAt: string };
}

export class LegacySessionImporter {
  readonly root: string;

  constructor(
    private readonly database: WebDatabase,
    root = join(homedir(), '.pentesterflow', 'sessions'),
  ) {
    this.root = resolve(root);
  }

  list(): LegacySessionSummary[] {
    if (!existsSync(this.root)) return [];
    const sessions: LegacySessionSummary[] = [];
    for (const fileName of readdirSync(this.root).filter((name) => name.endsWith('.json'))) {
      try {
        const path = this.safePath(fileName);
        const info = lstatSync(path);
        if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_LEGACY_BYTES) continue;
        const bytes = readFileSync(path);
        const sourceSha256 = createHash('sha256').update(bytes).digest('hex');
        const parsed = legacySchema.parse(JSON.parse(bytes.toString('utf8')));
        sessions.push({
          id: sourceSha256,
          fileName,
          updatedAt: parsed.updated_at,
          preview:
            parsed.messages.find((message) => message.role === 'user')?.content.slice(0, 120) ??
            '(empty session)',
          sourceSha256,
          imported: this.database.getLegacyImport(sourceSha256),
        });
      } catch {
        // Corrupt, oversized, and unsafe entries are intentionally hidden.
      }
    }
    return sessions.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  }

  async import(
    legacyId: string,
    input: {
      title: string;
      provider: WebProviderId;
      model: string;
      mode: WebMode;
      allowedHosts?: string[];
    },
  ) {
    const summary = this.list().find((entry) => entry.id === legacyId);
    if (!summary) throw new Error('legacy session not found');
    if (summary.imported) throw new Error('legacy session was already imported');
    const bytes = readFileSync(this.safePath(summary.fileName));
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (digest !== legacyId) throw new Error('legacy session changed; refresh and try again');
    const parsed = legacySchema.parse(JSON.parse(bytes.toString('utf8'))) as SessionFile;
    const target = parsed.target ? Target.fromJSON(parsed.target) : null;
    const targetHost = target?.baseURL() ? safeHostname(target.baseURL()) : undefined;
    const allowedHosts = [
      ...new Set([...(input.allowedHosts ?? []), ...(targetHost ? [targetHost] : [])]),
    ];
    if (allowedHosts.length === 0) throw new Error('an allowed host is required for this import');
    const engagement = this.database.createEngagement(
      `Imported: ${input.title}`,
      createScope({
        allowedHosts,
        allowThirdPartyPassiveSources: false,
        allowDirectLowImpactRecon: false,
      }),
      input.mode,
    );
    const session = this.database.createSession(
      engagement.id,
      input.title,
      input.provider,
      input.model,
    );
    try {
      const store = new SqliteSessionStore(session.id, this.database.db);
      await store.save(
        parsed.messages as Message[],
        target,
        (parsed.memory ?? null) as SessionMemory | null,
      );
      this.database.recordLegacyImport({
        sourceSha256: digest,
        fileName: basename(summary.fileName),
        sourceUpdatedAt: parsed.updated_at,
        sessionId: session.id,
      });
      this.database.audit(session.id, 'legacy_session.imported', {
        sourceSha256: digest,
        fileName: basename(summary.fileName),
      });
      return { engagement, session: this.database.getSession(session.id) };
    } catch (error) {
      this.database.deleteSession(session.id);
      throw error;
    }
  }

  private safePath(fileName: string): string {
    if (basename(fileName) !== fileName || !fileName.endsWith('.json'))
      throw new Error('invalid legacy session name');
    const path = resolve(this.root, fileName);
    if (!path.startsWith(`${this.root}/`)) throw new Error('legacy path escaped import root');
    return path;
  }
}

function safeHostname(value: string): string | undefined {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.hostname : undefined;
  } catch {
    return undefined;
  }
}
