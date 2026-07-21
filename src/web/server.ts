import { existsSync } from 'node:fs';
import { type Server, createServer } from 'node:http';
import { join, resolve } from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';
import helmet from 'helmet';
import { WebSocketServer } from 'ws';
import { ZodError, z } from 'zod';
import { WEB_SLASH_COMMANDS, commandUsesProvider } from './commands.js';
import { EventHub } from './events.js';
import { WebProviderManager } from './providers/manager.js';
import { WebRuntimeManager } from './runtime.js';
import { LocalScannerRunner } from './scanners/localRunner.js';
import { createScope, scopeSchema } from './scope.js';
import { PairingManager } from './security/pairing.js';
import { ArtifactStore } from './storage/artifacts.js';
import { WebDatabase } from './storage/database.js';

export interface WebServerOptions {
  port?: number;
  dataDir?: string;
  uiDir?: string;
  ollamaBaseURL?: string;
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
const sessionBody = z
  .object({
    engagementId: z.string().uuid(),
    title: z.string().trim().min(1).max(120),
    provider: z.enum(['ollama', 'qwen', 'opencode', 'openclaude']).default('qwen'),
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
    externalContextApproved: z.boolean().default(false),
  })
  .strict();
const turnBody = z
  .object({
    message: z.string().trim().min(1).max(100_000),
    externalContextApproved: z.boolean().default(false),
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
  const runner = new LocalScannerRunner();
  const providers = new WebProviderManager(
    options.ollamaBaseURL ?? process.env.PENTESTERFLOW_OLLAMA_URL ?? 'http://127.0.0.1:11434',
  );
  const runtime = new WebRuntimeManager(database, artifacts, events, runner, providers);
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
      version: '0.2.2',
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
  app.get('/api/v1/commands', (_req, res) => res.json(WEB_SLASH_COMMANDS));
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
        provider: z.enum(['ollama', 'qwen', 'opencode', 'openclaude']),
        model: z
          .string()
          .trim()
          .min(1)
          .max(160)
          .regex(/^[a-zA-Z0-9._:@/+\-]+$/),
        externalContextApproved: z.boolean().default(false),
      })
      .strict()
      .parse(req.body);
    if (body.provider !== 'ollama' && !body.externalContextApproved) {
      return res.status(400).json({
        error:
          'External CLI providers may send session context to their configured remote model; explicit approval is required',
      });
    }
    database.audit(id, 'session.provider_changed', {
      provider: body.provider,
      model: body.model,
      externalContextApproved: body.externalContextApproved,
    });
    return res.json(runtime.configureProvider(id, body.provider, body.model));
  });
  app.get('/api/v1/events', (req, res) => {
    const after = z.coerce.number().int().min(0).default(0).parse(req.query.after);
    const sessionId =
      typeof req.query.sessionId === 'string'
        ? z.string().uuid().parse(req.query.sessionId)
        : undefined;
    res.json(database.eventsAfter(after, sessionId));
  });
  app.post('/api/v1/sessions/:id/turns', async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    const body = turnBody.parse(req.body);
    const session = database.getSession(id);
    if (!session) return res.status(404).json({ error: 'session not found' });
    if (session.provider !== 'ollama' && !body.externalContextApproved) {
      return res.status(400).json({
        error: 'explicit approval is required before sending this turn through a CLI provider',
      });
    }
    if (session.provider !== 'ollama') {
      database.audit(id, 'provider.external_turn_approved', {
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
    if (
      commandUsesProvider(body.command) &&
      session.provider !== 'ollama' &&
      !body.externalContextApproved
    ) {
      return res.status(400).json({
        error:
          'explicit approval is required before this command sends session context to a CLI provider',
      });
    }
    if (commandUsesProvider(body.command) && session.provider !== 'ollama') {
      database.audit(id, 'provider.external_command_approved', {
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
      : message.includes('already running')
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
      /\b(?:api[_-]?key|authorization|token|password|secret)\b\s*[:=]\s*[^\s,}"']+/gi,
      '$1=[REDACTED]',
    )
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer [REDACTED]');
}
