import path from 'node:path';

import { defineConfig, devices, type PlaywrightTestConfig } from '@playwright/test';

import { devCaLaunchArgs } from './e2e/helpers/dev-ca';

/**
 * Two projects, two questions.
 *
 * - `dev`: do the six personas sign in through the real ZITADEL, and does sign-out end the
 *   session? Runs against the running stack (Caddy, ZITADEL, API, Workspace). The Workspace behind
 *   `BASE_URL` may be `next dev` or the prod-like `app` compose profile; both work.
 * - `prod`: is the persona switcher absent from a production build, and is the signed-in shell's
 *   LCP under 1.5 s?
 *   - `BASE_URL` unset: Playwright starts `next start -p 3100` (build first). Enough for the 404
 *     test. The LCP test skips itself: signing in needs ZITADEL's redirect URI, which is
 *     `https://app.localhost`, never `localhost:3100`.
 *   - `BASE_URL=https://app.localhost`: no server is started; both tests run against the `app`
 *     profile, which is a production build behind Caddy.
 *
 * TLS: `ignoreHTTPSErrors` stays false. Chromium is told to trust Caddy's local CA instead; see
 * e2e/helpers/dev-ca.ts for why this is a pin of the live chain and not of the root file.
 *
 * Traces, videos and the HTML report are off on purpose: Playwright records `fill()` values, and
 * the persona passwords would end up in `test-results/`. Failure screenshots are kept (the
 * password field is masked).
 */

const appOrigin = process.env.BASE_URL || undefined;
const authOrigin = process.env.BOS_E2E_AUTH_ORIGIN ?? 'https://auth.localhost';
const caFile = path.resolve(__dirname, process.env.BOS_E2E_CA_FILE ?? '../../.dev/caddy-root.crt');

const devBaseURL = appOrigin ?? 'https://app.localhost';
const prodBaseURL = appOrigin ?? 'http://localhost:3100';

/** `--project=prod` or `--project prod` (any position), so the dev run never starts a web server. */
function selectedProjects(): string[] {
  const names: string[] = [];
  const argv = process.argv;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? '';
    if (arg.startsWith('--project=')) names.push(arg.slice('--project='.length));
    else if (arg === '--project' && argv[i + 1] !== undefined) names.push(argv[i + 1] as string);
  }
  // Workers reload this config without CLI arguments; preserve the selected project.
  return names.length > 0 ? names : (process.env.BOS_E2E_PROJECTS ?? '').split(',').filter(Boolean);
}

const selected = selectedProjects();
if (selected.length > 0) process.env.BOS_E2E_PROJECTS = selected.join(',');
const startsProdServer = appOrigin === undefined && selected.includes('prod');

// Pins are only needed for projects that are actually selected, so `e2e:prod` without the stack
// (the CI job) never tries to reach ZITADEL.
const wantsDev = selected.length === 0 || selected.includes('dev');
const wantsHttpsProd = selected.length === 0 || selected.includes('prod');
const tlsOrigins = [
  ...(wantsDev ? [devBaseURL, authOrigin] : []),
  ...(wantsHttpsProd && prodBaseURL.startsWith('https:') ? [prodBaseURL, authOrigin] : []),
];
const launchArgs = devCaLaunchArgs([...new Set(tlsOrigins)], caFile);

// GitHub QA run (.github/workflows/qa.yml): keep a video of every test and an HTML report. Traces stay off, because
// Playwright records fill() values and the persona passwords would end up in them. Videos mask password inputs;
// the workflow scans the report for the seeded passwords before it uploads anything.
const record = process.env.BOS_E2E_RECORD === '1';

const common: NonNullable<PlaywrightTestConfig['use']> = {
  ...devices['Desktop Chrome'],
  ignoreHTTPSErrors: false,
  trace: 'off',
  video: record ? 'on' : 'off',
  screenshot: 'only-on-failure',
  launchOptions: { args: launchArgs },
};

export default defineConfig({
  testDir: './e2e',
  // One browser at a time: six logins against one ZITADEL are quick, and it keeps failures readable.
  workers: 1,
  fullyParallel: false,
  // No retries: a retry would hide exactly the flakiness this suite exists to expose.
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  forbidOnly: !!process.env.CI,
  reporter: record
    ? [
        ['list'],
        [
          'html',
          { open: 'never', outputFolder: process.env.BOS_E2E_REPORT_DIR ?? 'playwright-report' },
        ],
      ]
    : [['list']],
  outputDir: 'test-results',

  projects: [
    {
      name: 'dev',
      // Run platform journeys, the shell regression, and P2/P3/P4 business workflows.
      testMatch: [
        'personas.spec.ts',
        'exit.spec.ts',
        'inbox.spec.ts',
        'overview.spec.ts',
        'p0-shell.spec.ts',
        'p2/*.spec.ts',
        'p3/*.spec.ts',
        'p4/*.spec.ts',
      ],
      use: { ...common, baseURL: devBaseURL },
    },
    {
      name: 'prod',
      testMatch: ['prod-no-switcher.spec.ts', 'lcp.spec.ts'],
      use: { ...common, baseURL: prodBaseURL },
    },
  ],

  ...(startsProdServer && {
    webServer: {
      // `next build` must have run (the heavy command does it). `/healthz` touches no dependency.
      command: 'pnpm exec next start -p 3100',
      url: 'http://localhost:3100/healthz',
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      stdout: 'ignore',
      stderr: 'pipe',
    },
  }),
});
