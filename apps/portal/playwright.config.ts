import path from 'node:path';

import { defineConfig, devices } from '@playwright/test';

import { devCaLaunchArgs } from '../workspace/e2e/helpers/dev-ca';

const portalOrigin = process.env.PORTAL_E2E_BASE_URL;
const configured = Boolean(portalOrigin && process.env.PORTAL_E2E_STORAGE_STATE);
const caFile = path.resolve(__dirname, process.env.BOS_E2E_CA_FILE ?? '../../.dev/caddy-root.crt');

export default defineConfig({
  testDir: './e2e',
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  forbidOnly: !!process.env.CI,
  reporter: [['list']],
  outputDir: 'test-results',
  use: {
    ...devices['Desktop Chrome'],
    baseURL: portalOrigin,
    ignoreHTTPSErrors: false,
    // Storage states and login flows contain credentials; keep recordings off.
    trace: 'off',
    video: 'off',
    screenshot: 'only-on-failure',
    launchOptions: {
      args: configured
        ? devCaLaunchArgs(
            [portalOrigin!, process.env.BOS_E2E_AUTH_ORIGIN ?? 'https://auth.localhost'],
            caFile,
          )
        : [],
    },
  },
});
