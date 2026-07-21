import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { WebServerHandle } from './server.js';

const nodeMajor = Number.parseInt(process.versions.node.split('.')[0] ?? '0', 10);

describe.runIf(nodeMajor >= 22)('Web turn cancellation', () => {
  let root = '';
  let handle: WebServerHandle | undefined;
  const previousOpenClaude = process.env.PENTESTERFLOW_OPENCLAUDE_PATH;

  afterEach(async () => {
    await handle?.close();
    handle = undefined;
    if (previousOpenClaude === undefined)
      Reflect.deleteProperty(process.env, 'PENTESTERFLOW_OPENCLAUDE_PATH');
    else process.env.PENTESTERFLOW_OPENCLAUDE_PATH = previousOpenClaude;
    if (root) await rm(root, { recursive: true, force: true });
    root = '';
  });

  it('kills a provider launcher and its signal-resistant child process', async () => {
    const { startWebServer } = await import('./server.js');
    root = await mkdtemp(join(tmpdir(), 'agent-workbench-cancel-'));
    const childPidPath = join(root, 'provider-child.pid');
    const providerPath = join(root, 'fake-openclaude');
    const stubbornChild = [
      `require('node:fs').writeFileSync(${JSON.stringify(childPidPath)}, String(process.pid));`,
      "process.on('SIGTERM', () => undefined);",
      'setInterval(() => undefined, 1000);',
    ].join('');
    await writeFile(
      providerPath,
      [
        '#!/usr/bin/env node',
        "const { spawnSync } = require('node:child_process');",
        "if (process.argv.includes('--version')) { console.log('fake 1.0.0'); process.exit(0); }",
        `const result = spawnSync(process.execPath, ['-e', ${JSON.stringify(stubbornChild)}], { stdio: 'inherit' });`,
        'process.exit(result.status ?? 1);',
      ].join('\n'),
      { mode: 0o700 },
    );
    await chmod(providerPath, 0o700);
    process.env.PENTESTERFLOW_OPENCLAUDE_PATH = providerPath;

    handle = await startWebServer({
      port: await freePort(),
      dataDir: join(root, 'data'),
      uiDir: join(root, 'missing-ui'),
      ollamaBaseURL: 'http://127.0.0.1:1',
    });
    const base = `http://127.0.0.1:${handle.port}`;
    const pairingToken = new URL(handle.pairingURL).hash.slice('#pair='.length);
    const paired = await fetch(`${base}/api/v1/auth/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: pairingToken }),
    });
    const { csrfToken } = (await paired.json()) as { csrfToken: string };
    const cookie = paired.headers.getSetCookie()[0]?.split(';', 1)[0] ?? '';
    const request = async (path: string, body: unknown) =>
      fetch(`${base}/api/v1${path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: cookie,
          'X-CSRF-Token': csrfToken,
        },
        body: JSON.stringify(body),
      });
    const engagementResponse = await request('/engagements', {
      name: 'cancel test',
      mode: 'PLAN',
      scope: { allowedHosts: ['example.com'] },
    });
    const engagement = (await engagementResponse.json()) as { id: string };
    const sessionResponse = await request('/sessions', {
      engagementId: engagement.id,
      title: 'cancel test',
      provider: 'openclaude',
      model: 'default',
    });
    const session = (await sessionResponse.json()) as { id: string };
    const turnResponse = await request(`/sessions/${session.id}/turns`, {
      message: 'wait forever',
      externalContextApproved: true,
    });
    expect(turnResponse.status).toBe(202);
    await waitForFile(childPidPath);

    const started = Date.now();
    const cancelResponse = await request(`/sessions/${session.id}/cancel`, {});
    expect(await cancelResponse.json()).toEqual({ cancelled: true });
    const finished = await waitForCancelled(base, cookie, session.id);
    expect(finished.payload).toEqual({ status: 'cancelled' });
    expect(Date.now() - started).toBeLessThan(4_000);

    const childPid = Number.parseInt(await readFile(childPidPath, 'utf8'), 10);
    expect(processExists(childPid)).toBe(false);
  }, 15_000);
});

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 4_000;
  while (Date.now() < deadline) {
    try {
      await readFile(path);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw new Error('provider child did not start');
}

async function waitForCancelled(
  base: string,
  cookie: string,
  sessionId: string,
): Promise<{ payload: Record<string, unknown> }> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const response = await fetch(
      `${base}/api/v1/events?after=0&sessionId=${encodeURIComponent(sessionId)}`,
      { headers: { Cookie: cookie } },
    );
    const events = (await response.json()) as Array<{
      type: string;
      payload: Record<string, unknown>;
    }>;
    const finished = events.find(
      (event) => event.type === 'turn.finished' && event.payload.status === 'cancelled',
    );
    if (finished) return finished;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('turn did not reach cancelled state');
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('could not reserve a test port');
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}
