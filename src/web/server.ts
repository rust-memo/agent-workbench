import { existsSync } from 'node:fs';
import { type Server, createServer } from 'node:http';
import { join, resolve } from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';
import helmet from 'helmet';
import { WebSocketServer } from 'ws';
import { ZodError, z } from 'zod';
import { ActionService, publicProposal } from './actions/service.js';
import { WEB_SLASH_COMMANDS, commandUsesProvider } from './commands.js';
import { EventHub } from './events.js';
import { WebProviderManager } from './providers/manager.js';
import { ReconService } from './recon/service.js';
import { WebRuntimeManager } from './runtime.js';
import { DockerScannerRunner } from './scanners/dockerRunner.js';
import { createScope, scopeSchema } from './scope.js';
import { PairingManager } from './security/pairing.js';
import { ArtifactStore } from './storage/artifacts.js';
import { WebDatabase } from './storage/database.js';
import { LegacySessionImporter } from './storage/legacyImport.js';

export interface WebServerOptions {
  port?: number;
  dataDir?: string;
  uiDir?: string;
  ollamaBaseURL?: string;
  legacySessionsDir?: string;
}

export interface WebServerHandle {
  server: Server;
  port: number;
  pairingURL: string;
  close(): Promise<void>;
}

const engagementBody = z
  .object({
    name: z.string().trim().min(1).max(120),
    mode: z.enum(['PLAN', 'RECON']).default('PLAN'),
    scope: scopeSchema,
  })
  .strict();
const webProvider = z.enum(['ollama', 'qwen', 'codex', 'claude', 'opencode', 'openclaude']);
const sessionBody = z
  .object({
    engagementId: z.string().uuid(),
    title: z.string().trim().min(1).max(120),
    provider: webProvider.default('qwen'),
    model: z
      .string()
      .trim()
      .min(1)
      .max(120)
      .regex(/^[a-zA-Z0-9._:@/+\-]+$/),
  })
  .strict();
const commandBody = z
  .object({
    command: z.string().trim().min(1).max(10_000),
    externalContextApproved: z.boolean().optional(),
  })
  .strict();
const turnBody = z
  .object({
    message: z.string().trim().min(1).max(100_000),
    externalContextApproved: z.boolean().optional(),
  })
  .strict();

export async function startWebServer(options: WebServerOptions = {}): Promise<WebServerHandle> {
  const port = validPort(options.port ?? 9099);
  const dataDir = resolve(options.dataDir ?? join(process.cwd(), '.pentesterflow', 'web'));
  const uiDir = resolve(options.uiDir ?? join(process.cwd(), 'web-ui', 'dist'));
  const database = new WebDatabase(join(dataDir, 'workbench.sqlite3'));
  const events = new EventHub(database);
  const artifacts = new ArtifactStore(join(dataDir, 'artifacts'), database, (event) =>
    events.broadcast(event),
  );
  const recovery = artifacts.recover();
  const pairing = new PairingManager();
  const runner = new DockerScannerRunner();
  const providers = new WebProviderManager(
    options.ollamaBaseURL ?? process.env.PENTESTERFLOW_OLLAMA_URL ?? 'http://127.0.0.1:11434',
  );
  const actions = new ActionService(database, artifacts, events, runner);
  const recon = new ReconService(database, artifacts, events, runner, actions);
  const legacySessions = new LegacySessionImporter(database, options.legacySessionsDir);
  const runtime = new WebRuntimeManager(database, artifacts, events, runner, providers, actions);
  const app = express();

  app.disable('x-powered-by');
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'"],
          imgSrc: ["'self'", 'data:'],
          connectSrc: ["'self'", 'ws://127.0.0.1:*', 'ws://localhost:*'],
          objectSrc: ["'none'"],
          baseUri: ["'none'"],
          frameAncestors: ["'none'"],
        },
      },
      crossOriginEmbedderPolicy: false,
      strictTransportSecurity: false,
    }),
  );
  app.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
  });
  app.use((req, res, next) => {
    if (!allowedHost(req.headers.host, port))
      return res.status(400).json({ error: 'invalid host' });
    if (req.headers.origin && !allowedOrigin(req.headers.origin, port))
      return res.status(403).json({ error: 'invalid origin' });
    next();
  });
  app.use(express.json({ limit: '256kb', type: 'application/json' }));

  app.get('/healthz', (_req, res) => res.json({ ok: true }));
  app.post('/api/v1/auth/pair', (req, res) => {
    const body = z
      .object({ token: z.string().min(1).max(200) })
      .strict()
      .parse(req.body);
    const session = pairing.pair(body.token);
    if (!session)
      return res.status(401).json({ error: 'pairing token is invalid, expired, or already used' });
    res.setHeader('Set-Cookie', pairing.cookie(session.sessionId));
    database.audit(undefined, 'auth.paired', { remoteAddress: req.socket.remoteAddress });
    return res.json({ csrfToken: session.csrfToken });
  });

  app.use('/api/v1', (req, res, next) => {
    const session = pairing.authenticate(req.headers.cookie);
    if (!session) return res.status(401).json({ error: 'authentication required' });
    if (
      !['GET', 'HEAD', 'OPTIONS'].includes(req.method) &&
      !pairing.verifyCsrf(session.sessionId, req.header('x-csrf-token'))
    ) {
      return res.status(403).json({ error: 'invalid CSRF token' });
    }
    res.locals.browserSession = session;
    next();
  });

  app.get('/api/v1/auth/session', (_req, res) =>
    res.json({ csrfToken: res.locals.browserSession.csrfToken }),
  );
  app.get('/api/v1/status', async (_req, res) => {
    const [providerCapabilities, scanners] = await Promise.all([
      providers.capabilities(),
      runner.health(),
    ]);
    res.json({
      version: '0.5.0',
      providers: providerCapabilities,
      scanners,
      recovery,
      scopeEnforcement: 'fail-closed inputs; best-effort network enforcement',
    });
  });
  app.get('/api/v1/engagements', (_req, res) => res.json(database.listEngagements()));
  app.post('/api/v1/engagements', (req, res) => {
    const body = engagementBody.parse(req.body);
    const engagement = database.createEngagement(body.name, createScope(body.scope), body.mode);
    database.audit(undefined, 'engagement.created', {
      engagementId: engagement.id,
      scopeVersion: engagement.scope.version,
    });
    res.status(201).json(engagement);
  });
  app.get('/api/v1/sessions', (req, res) => {
    const engagementId =
      typeof req.query.engagementId === 'string' ? req.query.engagementId : undefined;
    res.json(database.listSessions(engagementId));
  });
  app.get('/api/v1/legacy-sessions', (_req, res) => res.json(legacySessions.list()));
  app.post('/api/v1/legacy-sessions/:legacyId/import', async (req, res) => {
    const legacyId = z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .parse(req.params.legacyId);
    const body = z
      .object({
        title: z.string().trim().min(1).max(120),
        provider: webProvider,
        model: z
          .string()
          .trim()
          .min(1)
          .max(160)
          .regex(/^[a-zA-Z0-9._:@/+\-]+$/),
        mode: z.enum(['PLAN', 'RECON']).default('PLAN'),
        allowedHosts: z.array(z.string().trim().min(1).max(253)).min(1).max(100).optional(),
      })
      .strict()
      .parse(req.body);
    res.status(201).json(await legacySessions.import(legacyId, body));
  });
  app.get('/api/v1/commands', (_req, res) => res.json(WEB_SLASH_COMMANDS));
  app.get('/api/v1/skills', (_req, res) => res.json(runtime.listSkills()));
  app.post('/api/v1/sessions', (req, res) => {
    const body = sessionBody.parse(req.body);
    if (!database.getEngagement(body.engagementId))
      return res.status(404).json({ error: 'engagement not found' });
    res
      .status(201)
      .json(database.createSession(body.engagementId, body.title, body.provider, body.model));
  });
  app.patch('/api/v1/sessions/:id/provider', (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    const body = z
      .object({
        provider: webProvider,
        model: z
          .string()
          .trim()
          .min(1)
          .max(160)
          .regex(/^[a-zA-Z0-9._:@/+\-]+$/),
        externalContextApproved: z.boolean().optional(),
      })
      .strict()
      .parse(req.body);
    database.audit(id, 'session.provider_changed', {
      provider: body.provider,
      model: body.model,
      dispatchMode: body.provider === 'ollama' ? 'local' : 'direct-redacted',
    });
    return res.json(runtime.configureProvider(id, body.provider, body.model));
  });
  app.post('/api/v1/sessions/:id/skills/:name/load', async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    const name = z
      .string()
      .regex(/^[a-z0-9-]{1,64}$/)
      .parse(req.params.name);
    if (!database.getSession(id)) return res.status(404).json({ error: 'session not found' });
    res.json(await runtime.injectSkill(id, name));
  });
  app.get('/api/v1/events', (req, res) => {
    const after = z.coerce.number().int().min(0).default(0).parse(req.query.after);
    const sessionId =
      typeof req.query.sessionId === 'string'
        ? z.string().uuid().parse(req.query.sessionId)
        : undefined;
    res.json(database.eventsAfter(after, sessionId));
  });
  app.get('/api/v1/sessions/:id/recon-runs', (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    if (!database.getSession(id)) return res.status(404).json({ error: 'session not found' });
    res.json(recon.list(id));
  });
  app.post('/api/v1/sessions/:id/recon-runs', (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    const body = z
      .object({ profile: z.enum(['quick', 'standard', 'advanced']) })
      .strict()
      .parse(req.body);
    res.status(202).json(recon.start(id, body.profile));
  });
  app.post('/api/v1/sessions/:id/recon-runs/:runId/cancel', (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    const runId = z.string().uuid().parse(req.params.runId);
    res.json({ cancelled: recon.cancel(id, runId) });
  });
  app.patch('/api/v1/sessions/:id/recon-insights/:insightId', (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    const insightId = z.string().uuid().parse(req.params.insightId);
    const body = z
      .object({ status: z.enum(['new', 'accepted', 'dismissed', 'completed']) })
      .strict()
      .parse(req.body);
    res.json(recon.updateInsight(id, insightId, body.status));
  });
  app.post('/api/v1/sessions/:id/turns', async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    const body = turnBody.parse(req.body);
    const session = database.getSession(id);
    if (!session) return res.status(404).json({ error: 'session not found' });
    if (session.provider !== 'ollama') {
      database.audit(id, 'provider.external_turn_direct', {
        provider: session.provider,
        model: session.model,
        messageBytes: Buffer.byteLength(body.message),
      });
    }
    const result = await runtime.runTurn(id, body.message);
    res.status(202).json(result);
  });
  app.post('/api/v1/sessions/:id/cancel', (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    res.json({ cancelled: runtime.cancel(id) });
  });
  app.post('/api/v1/sessions/:id/commands', async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    const body = commandBody.parse(req.body);
    const session = database.getSession(id);
    if (!session) return res.status(404).json({ error: 'session not found' });
    if (commandUsesProvider(body.command) && session.provider !== 'ollama') {
      database.audit(id, 'provider.external_command_direct', {
        provider: session.provider,
        model: session.model,
        command: body.command.split(/\s+/, 1)[0],
      });
    }
    const result = await runtime.runCommand(id, body.command);
    res.status(result.turnId ? 202 : 200).json(result);
  });
  app.get('/api/v1/sessions/:id/artifacts', (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    res.json(database.listArtifacts(id));
  });
  app.get('/api/v1/sessions/:id/actions', (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    if (!database.getSession(id)) return res.status(404).json({ error: 'session not found' });
    res.json(database.listActionProposals(id).map(publicProposal));
  });
  app.post('/api/v1/sessions/:id/findings/:findingId/validation-proposals', (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    const findingId = z.string().uuid().parse(req.params.findingId);
    const body = z
      .object({
        method: z.enum(['GET', 'HEAD']).default('GET'),
        expectedStatus: z.number().int().min(100).max(599).optional(),
        bodyContains: z.string().min(1).max(200).optional(),
        reason: z.string().trim().min(1).max(500),
      })
      .strict()
      .parse(req.body);
    const session = database.getSession(id);
    if (!session) return res.status(404).json({ error: 'session not found' });
    const finding = database.getFinding(findingId);
    if (!finding || finding.sessionId !== id)
      return res.status(404).json({ error: 'finding not found' });
    const engagement = database.getEngagement(session.engagementId);
    if (!engagement) return res.status(404).json({ error: 'engagement not found' });
    const proposal = actions.propose({
      engagementId: engagement.id,
      sessionId: id,
      action: 'validate_http',
      arguments: {
        findingId,
        method: body.method,
        ...(body.expectedStatus ? { expectedStatus: body.expectedStatus } : {}),
        ...(body.bodyContains ? { bodyContains: body.bodyContains } : {}),
      },
      reason: body.reason,
      scopeVersion: engagement.scope.version,
      mode: engagement.mode,
    });
    res.status(201).json(publicProposal(proposal));
  });
  app.post('/api/v1/sessions/:id/actions/:proposalId/approve', (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    const proposalId = z.string().uuid().parse(req.params.proposalId);
    const body = z
      .object({ approvalHash: z.string().regex(/^[a-f0-9]{64}$/) })
      .strict()
      .parse(req.body);
    const browserSessionId = z.string().min(1).parse(res.locals.browserSession.sessionId);
    res
      .status(202)
      .json(runtime.approveAction(id, proposalId, body.approvalHash, browserSessionId));
  });
  app.get('/api/v1/sessions/:id/findings', (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    if (!database.getSession(id)) return res.status(404).json({ error: 'session not found' });
    res.json(database.listFindings(id));
  });
  app.patch('/api/v1/sessions/:id/findings/:findingId', (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    const findingId = z.string().uuid().parse(req.params.findingId);
    const body = z
      .object({
        status: z.enum(['needs_validation', 'confirmed', 'false_positive', 'informational']),
        validationArtifactId: z.string().uuid().optional(),
        validationNote: z.string().trim().min(10).max(2000).optional(),
      })
      .strict()
      .superRefine((value, context) => {
        if (value.status === 'confirmed' && (!value.validationArtifactId || !value.validationNote))
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'confirmed findings require a validation artifact and note',
          });
      })
      .parse(req.body);
    if (body.validationArtifactId) {
      const evidence = database.getArtifact(body.validationArtifactId);
      if (!evidence || evidence.sessionId !== id)
        return res.status(400).json({ error: 'validation artifact was not found in this session' });
    }
    const finding = database.updateFindingStatus(
      findingId,
      id,
      body.status,
      body.validationArtifactId && body.validationNote
        ? { artifactId: body.validationArtifactId, note: body.validationNote }
        : undefined,
    );
    database.audit(id, 'finding.status_changed', {
      findingId,
      status: body.status,
      validationArtifactId: body.validationArtifactId,
    });
    events.publish({
      engagementId: finding.engagementId,
      sessionId: id,
      type: 'finding.updated',
      payload: finding,
    });
    res.json(finding);
  });
  app.get('/api/v1/sessions/:id/coverage', (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    const status = req.query.status
      ? z
          .enum(['untested', 'tried', 'passed', 'failed', 'waf-blocked', 'skipped'])
          .parse(req.query.status)
      : undefined;
    if (!database.getSession(id)) return res.status(404).json({ error: 'session not found' });
    res.json({ summary: database.coverageSummary(id), rows: database.listCoverage(id, status) });
  });
  app.get('/api/v1/sessions/:id/export', (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    const snapshot = redactExport(database.exportSession(id));
    database.audit(id, 'session.exported_redacted', {});
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="agent-workbench-${id}.json"`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    return res.send(`${JSON.stringify(snapshot, null, 2)}\n`);
  });
  app.delete('/api/v1/sessions/:id', (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    const body = z
      .object({ confirmTitle: z.string().min(1).max(120) })
      .strict()
      .parse(req.body);
    const session = database.getSession(id);
    if (!session) return res.status(404).json({ error: 'session not found' });
    if (session.state === 'running')
      return res.status(409).json({ error: 'cancel the turn first' });
    if (body.confirmTitle !== session.title)
      return res.status(409).json({ error: 'session title confirmation does not match' });
    const removedArtifacts = artifacts.deleteSession(id);
    database.deleteSession(id);
    database.audit(undefined, 'session.deleted', {
      sessionId: id,
      engagementId: session.engagementId,
      removedArtifacts,
    });
    return res.json({ deleted: true, removedArtifacts });
  });
  app.get('/api/v1/artifacts/:id/preview', (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    const artifact = database.getArtifact(id);
    if (!artifact) return res.status(404).json({ error: 'artifact not found' });
    const body = artifacts.read(artifact).toString('utf8').slice(0, 200_000);
    database.audit(artifact.sessionId, 'artifact.preview_redacted', { artifactId: id });
    res.json({ artifact, body: redactPreview(body), truncated: artifact.size > 200_000 });
  });
  app.get('/api/v1/artifacts/:id/raw', (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    const artifact = database.getArtifact(id);
    if (!artifact) return res.status(404).json({ error: 'artifact not found' });
    const body = artifacts.read(artifact);
    database.audit(artifact.sessionId, 'artifact.raw_download', { artifactId: id });
    res.setHeader('Content-Type', artifact.mediaType);
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${artifact.filename.replace(/["\\]/g, '_')}"`,
    );
    res.setHeader('X-Content-Type-Options', 'nosniff');
    return res.send(body);
  });

  if (existsSync(uiDir)) {
    app.use(express.static(uiDir, { index: false, etag: false, maxAge: 0 }));
    app.get('*path', (_req, res) => res.sendFile(join(uiDir, 'index.html')));
  } else {
    app.get('/', (_req, res) =>
      res.status(503).type('text/plain').send('Web UI is not built. Run: npm run build:web-ui'),
    );
  }

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof ZodError)
      return res.status(400).json({ error: 'invalid request', issues: error.issues });
    const message = error instanceof Error ? error.message : 'internal error';
    const status = message.includes('not found')
      ? 404
      : message.includes('already running') ||
          message.includes('no longer pending') ||
          message.includes('already consumed') ||
          message.includes('expired') ||
          message.includes('scope changed') ||
          message.includes('already imported') ||
          message.includes('raw-socket scanner profile is disabled')
        ? 409
        : 500;
    return res.status(status).json({ error: status === 500 ? 'request failed' : message });
  });

  const server = createServer(app);
  const websocket = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });
  server.on('upgrade', (req, socket, head) => {
    try {
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
      const session = pairing.authenticate(req.headers.cookie);
      if (
        url.pathname !== '/api/v1/events/ws' ||
        !session ||
        !allowedHost(req.headers.host, port) ||
        (req.headers.origin !== undefined && !allowedOrigin(req.headers.origin, port))
      ) {
        socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      const after = Number.parseInt(url.searchParams.get('after') ?? '0', 10);
      websocket.handleUpgrade(req, socket, head, (client) => {
        events.addClient(client);
        for (const event of database.eventsAfter(
          Number.isSafeInteger(after) && after >= 0 ? after : 0,
        ))
          client.send(JSON.stringify(event));
      });
    } catch {
      socket.destroy();
    }
  });

  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolveListen());
  });
  return {
    server,
    port,
    pairingURL: `http://127.0.0.1:${port}/#pair=${pairing.rawPairingToken}`,
    close: async () => {
      for (const client of websocket.clients) client.close(1001, 'server shutdown');
      await new Promise<void>((resolveClose, reject) =>
        server.close((error) => (error ? reject(error) : resolveClose())),
      );
      database.close();
    },
  };
}

function allowedHost(host: string | undefined, port: number): boolean {
  return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
}
function allowedOrigin(origin: string, port: number): boolean {
  return origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`;
}
function validPort(value: number): number {
  if (!Number.isInteger(value) || value < 1024 || value > 65535)
    throw new Error('port must be between 1024 and 65535');
  return value;
}
function redactPreview(value: string): string {
  return value
    .replace(
      /\b(api[_-]?key|authorization|token|password|secret)\b\s*[:=]\s*[^\s,}"']+/gi,
      '$1=[REDACTED]',
    )
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer [REDACTED]');
}

function redactExport(value: unknown, key = ''): unknown {
  if (/api[_-]?key|authorization|token|password|secret|credential/i.test(key)) return '[REDACTED]';
  if (typeof value === 'string') return redactPreview(value);
  if (Array.isArray(value)) return value.map((entry) => redactExport(entry));
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([entryKey, entry]) => [entryKey, redactExport(entry, entryKey)]),
    );
  return value;
}
