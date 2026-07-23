import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import type { WebServerHandle } from '../src/web/server.js';

let handle: WebServerHandle;
let dataDir: string;

test.beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'agent-workbench-playwright-'));
  const { startWebServer } = await import('../src/web/server.js');
  handle = await startWebServer({
    port: await availablePort(),
    dataDir,
    uiDir: join(process.cwd(), 'web-ui', 'dist'),
  });
});

test.afterAll(async () => {
  await handle?.close();
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
});

test('opens structured recon assets, combined files, viewer, and AI preview', async ({ page }) => {
  await page.goto(handle.pairingURL);
  await expect(page.getByText('Agent Workbench', { exact: true })).toBeVisible();

  await page.evaluate(async () => {
    const session = (await fetch('/api/v1/auth/session').then((response) => response.json())) as {
      csrfToken: string;
    };
    const request = async (path: string, body: unknown): Promise<unknown> => {
      const response = await fetch(`/api/v1${path}`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': session.csrfToken,
        },
        body: JSON.stringify(body),
      });
      if (!response.ok) throw new Error(await response.text());
      return response.json();
    };
    const engagement = (await request('/engagements', {
      name: 'Playwright Recon',
      mode: 'RECON',
      scope: {
        allowedHosts: ['example.com', '*.example.com'],
        allowThirdPartyPassiveSources: false,
        allowDirectLowImpactRecon: false,
        limits: {},
      },
    })) as { id: string };
    const workbenchSession = (await request('/sessions', {
      engagementId: engagement.id,
      title: 'Structured Results',
      provider: 'ollama',
      model: 'test-model',
    })) as { id: string };
    await request(`/sessions/${workbenchSession.id}/recon-runs`, { profile: 'quick' });
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const runs = (await fetch(`/api/v1/sessions/${workbenchSession.id}/recon-runs`).then(
        (response) => response.json(),
      )) as Array<{ status: string }>;
      if (runs[0] && !['queued', 'running'].includes(runs[0].status)) break;
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
  });
  await page.reload();
  await page.getByRole('button', { name: /Recon Results/ }).click();

  await expect(page.getByText('STRUCTURED RECON WORKSPACE')).toBeVisible();
  await expect(page.getByText('example.com', { exact: true })).toBeVisible();
  await expect(page.getByRole('table').getByText('scope', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: /Combined/ }).click();
  await expect(page.getByText('all-domains.txt', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Open' }).first().click();
  await expect(page.getByRole('dialog', { name: /Artifact viewer/ })).toBeVisible();
  await expect(page.getByText('SHA-256', { exact: false })).toBeVisible();
  await page.getByRole('dialog').getByRole('button', { name: '×' }).click();

  await page.getByRole('button', { name: /Assets/ }).click();
  await page.getByRole('checkbox', { name: 'Select example.com' }).check();
  await page.getByRole('button', { name: /AI Review/ }).click();
  await page.getByRole('button', { name: 'Generate redacted preview' }).click();
  await expect(page.getByText('Approval preview')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Approve and send once' })).toBeVisible();
});

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('failed to allocate E2E port');
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}
