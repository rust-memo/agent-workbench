import { defineConfig } from '@playwright/test';

const executablePath = process.env.AGENT_WORKBENCH_E2E_CHROME;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 45_000,
  expect: { timeout: 8_000 },
  use: {
    browserName: 'chromium',
    headless: true,
    viewport: { width: 1500, height: 950 },
    launchOptions: executablePath ? { executablePath } : {},
  },
});
