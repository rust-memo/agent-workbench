// HTTP ingest server for the PentesterFlow Chrome extension companion.
// Binds to 127.0.0.1 only — never exposed off-host — and accepts JSON
// payloads from the extension's forwardUrl. Same instance also serves a
// tiny status endpoint so the extension popup / tooling can sanity-check.

import { type IncomingMessage, type ServerResponse, createServer } from 'node:http';
import * as logger from '../logger/logger.js';
import type { CaptureStore } from './store.js';

const MAX_BODY_BYTES = 4 * 1024 * 1024; // 4 MiB — bigger than any reasonable single response body slice

export interface IngestServerOptions {
  store: CaptureStore;
  port: number;
  host?: string;
  onEvent?: (text: string) => void;
}

export interface IngestServerHandle {
  port: number;
  host: string;
  url: string;
  close(): Promise<void>;
}

export function startIngestServer(opts: IngestServerOptions): Promise<IngestServerHandle> {
  const host = opts.host ?? '127.0.0.1';
  const server = createServer((req, res) => handle(req, res, opts.store, opts.onEvent));
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, host, () => {
      const addr = server.address();
      const boundPort =
        addr && typeof addr === 'object' && 'port' in addr ? (addr.port as number) : opts.port;
      const url = `http://${host}:${boundPort}`;
      logger.info('burp bridge server listening', { url });
      resolve({
        port: boundPort,
        host,
        url,
        close: () =>
          new Promise<void>((res) => {
            server.close(() => res());
          }),
      });
    });
  });
}

function handle(
  req: IncomingMessage,
  res: ServerResponse,
  store: CaptureStore,
  onEvent?: (text: string) => void,
): void {
  // CORS — allow the extension's chrome-extension://<id> origin without
  // needing to know the id ahead of time. Since we bind to 127.0.0.1 only,
  // this is acceptable for a local-dev tool.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, DELETE');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Pentesterflow-Source');

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return;
  }

  const url = req.url ?? '/';

  if (req.method === 'GET' && (url === '/' || url === '/status')) {
    sendJSON(res, 200, { ok: true, ...store.status() });
    return;
  }

  if (req.method === 'GET' && url === '/endpoints') {
    sendJSON(res, 200, store.listEndpoints());
    return;
  }

  if (req.method === 'GET' && url === '/requests') {
    sendJSON(res, 200, store.listRequests({ limit: 500 }));
    return;
  }

  if (req.method === 'GET' && url === '/burp/tasks') {
    sendJSON(res, 200, store.listBurpTasks());
    return;
  }

  if (req.method === 'GET' && url === '/burp/issues') {
    sendJSON(res, 200, store.listBurpIssues());
    return;
  }

  if (req.method === 'DELETE' && url === '/clear') {
    store.clear();
    sendJSON(res, 200, { ok: true });
    return;
  }

  if (req.method !== 'POST') {
    res.statusCode = 405;
    res.end('method not allowed');
    return;
  }

  if (url !== '/ingest' && url !== '/snapshot' && url !== '/burp/task' && url !== '/burp/issues') {
    res.statusCode = 404;
    res.end('not found');
    return;
  }

  readBody(req)
    .then((body) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch {
        sendJSON(res, 400, { ok: false, error: 'invalid JSON' });
        return;
      }
      const result =
        url === '/snapshot'
          ? store.ingestSnapshot(parsed)
          : url === '/burp/task'
            ? store.ingestBurpTask(parsed)
            : url === '/burp/issues'
              ? store.ingestBurpIssue(parsed)
              : store.ingest(parsed);
      if (!result.ok) {
        sendJSON(res, 400, { ok: false, error: result.reason });
        return;
      }
      onEvent?.(eventText(url, parsed));
      sendJSON(res, 202, { ok: true });
    })
    .catch((err) => {
      logger.warn('burp bridge read error', { err: (err as Error).message });
      res.statusCode = 400;
      res.end('bad request');
    });
}

function eventText(url: string, parsed: unknown): string {
  if (!parsed || typeof parsed !== 'object') return 'Burp bridge: received event';
  const obj = parsed as Record<string, unknown>;
  const method = typeof obj.method === 'string' ? obj.method : '';
  const target =
    typeof obj.url === 'string' ? obj.url : typeof obj.target === 'string' ? obj.target : '';
  if (url === '/burp/task') {
    const action = typeof obj.action === 'string' ? obj.action : 'task';
    return `Burp bridge: queued ${action}${target ? ` for ${method ? `${method} ` : ''}${target}` : ''}`;
  }
  if (url === '/burp/issues') return 'Burp bridge: received issue for import';
  if (url === '/snapshot') return 'Burp bridge: received session snapshot';
  return `Burp bridge: captured request${target ? ` ${method ? `${method} ` : ''}${target}` : ''}`;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('payload too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJSON(res: ServerResponse, status: number, payload: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(payload));
}

// Convenience: don't crash the process if a misbehaving Node ESM loader
// imports this file in a worker without store wiring. Exported for tests.
export { handle as _handleForTest };
