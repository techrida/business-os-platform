import path from 'node:path';

import { defineConfig, devices } from '@playwright/test';

import { devCaLaunchArgs } from '../workspace/e2e/helpers/dev-ca';

const baseURL = process.env.PORTAL_E2E_BASE_URL;
const workspace = process.env.BOS_E2E_P4_EXIT_WORKSPACE_URL;
const caFile = path.resolve(__dirname, process.env.BOS_E2E_CA_FILE ?? '../../.dev/caddy-root.crt');
// HTTPS request.get() checks also require this CA in Node's trust store (NODE_EXTRA_CA_CERTS).
// Without an explicitly configured stack the fixture-gated specs can still be listed/skipped.
const origins = [
  ...(baseURL ? [baseURL, process.env.BOS_E2E_AUTH_ORIGIN ?? 'https://auth.localhost'] : []),
  ...(workspace ? [workspace, process.env.BOS_E2E_AUTH_ORIGIN ?? 'https://auth.localhost'] : []),
];

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
    ...(baseURL ? { baseURL } : {}),
    ignoreHTTPSErrors: false,
    trace: 'off',
    video: 'off',
    screenshot: 'only-on-failure',
    launchOptions: { args: devCaLaunchArgs([...new Set(origins)], caFile) },
  },
});
