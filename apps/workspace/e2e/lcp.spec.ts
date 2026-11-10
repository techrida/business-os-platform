import { expect, test } from '@playwright/test';

import { persona } from './helpers/personas';
import { signInOnZitadel } from './helpers/zitadel-login';

/**
 * The LAN performance gate: Largest Contentful Paint of the signed-in shell under 1500 ms.
 * Measured with the browser's own `PerformanceObserver`, the same API the real-user `web-vitals`
 * beacon uses.
 *
 * Signing in needs ZITADEL, whose redirect URI is `https://app.localhost`, so this only runs
 * against the stack (`BASE_URL=https://app.localhost`, the prod-like `app` profile). Without
 * BASE_URL the prod project serves `localhost:3100`, where login cannot complete.
 */
const LCP_BUDGET_MS = 1500;

test.skip(
  !process.env.BASE_URL,
  'LCP needs a signed-in session: run with BASE_URL=https://app.localhost (the stack Workspace)',
);

test('signed-in staff shell: LCP is under 1500 ms', async ({ page, baseURL }) => {
  const appOrigin = new URL(baseURL ?? '').origin;

  // Registered before any page script runs; `buffered` also replays entries from before the
  // observer existed. Each document gets a fresh array.
  await page.addInitScript(() => {
    const w = window as unknown as { __lcp: number[] };
    w.__lcp = [];
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) w.__lcp.push(entry.startTime);
    }).observe({ type: 'largest-contentful-paint', buffered: true });
  });

  // Sign in first, outside the measurement: login pages and OIDC redirects are not the shell.
  await page.goto('/');
  await signInOnZitadel(page, persona('founder'), appOrigin);
  await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible();

  // A fresh load of `/` with the session cookie already set: this is the page being gated.
  await page.goto('/', { waitUntil: 'load' });
  await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible();
  await page.waitForFunction(() => (window as unknown as { __lcp: number[] }).__lcp.length > 0);
  // The browser keeps reporting new candidates until the user interacts, so a click freezes the
  // value the same way a real visitor's first input does.
  await page.mouse.click(1, 1);

  const entries = await page.evaluate(() => (window as unknown as { __lcp: number[] }).__lcp);
  const lcp = entries[entries.length - 1] ?? 0;
  // `> 0` guards against a measurement that silently produced nothing.
  expect(lcp, `LCP candidates: ${entries.join(', ')}`).toBeGreaterThan(0);
  expect(lcp).toBeLessThan(LCP_BUDGET_MS);
});
