import { expect, test, type Page, type TestInfo } from '@playwright/test';

import { signInAs, type Signed } from '../helpers/memo-flow';

/**
 * No page may scroll sideways on a phone or a tablet (Kuu, round 6 decision OQ-R6-04). One case per page and
 * width: the page loads, its heading shows, the network settles, and the document is no wider than the window
 * (1 px of rounding allowed). The inbox, every list page, the procurement pages and the vendor portal home, at
 * 390 px (phone) and 834 px (tablet). Against the real stack: staff pages as the founder, the portal as the vendor.
 *
 * A failure names the page, the width and the widest elements past the right edge, and attaches a full-page
 * screenshot (it lands in the Playwright report artifact of the qa run).
 */

const WIDTHS = [390, 834] as const;

const STAFF_PAGES = [
  '/inbox',
  '/leads',
  '/opportunities',
  '/quotations',
  '/sales-orders',
  '/invoices',
  '/payments',
  '/customers',
  '/vendors',
  '/memos',
  '/payables/bills',
  '/payables/payment-requests',
  '/procurement/requests',
  '/procurement/rfqs',
  '/procurement/orders',
  '/procurement/receipts',
] as const;

const PORTAL_PAGES = ['/vendor'] as const;

interface Overflow {
  scrollWidth: number;
  clientWidth: number;
  offenders: string[];
}

async function measure(page: Page): Promise<Overflow> {
  return page.evaluate(() => {
    const root = document.scrollingElement ?? document.documentElement;
    const clientWidth = root.clientWidth;
    const offenders: string[] = [];
    for (const el of document.body.querySelectorAll('*')) {
      const right = el.getBoundingClientRect().right;
      if (right > clientWidth + 1 && offenders.length < 5) {
        const id = el.id ? `#${el.id}` : '';
        const cls =
          typeof el.className === 'string' && el.className
            ? `.${el.className.trim().split(/\s+/)[0]}`
            : '';
        offenders.push(
          `${el.tagName.toLowerCase()}${id}${cls} (right edge ${Math.round(right)}px)`,
        );
      }
    }
    return { scrollWidth: root.scrollWidth, clientWidth, offenders };
  });
}

async function checkFits(
  page: Page,
  testInfo: TestInfo,
  route: string,
  width: number,
): Promise<void> {
  await page.setViewportSize({ width, height: 900 });
  await page.goto(route);
  const heading = page.getByRole('heading', { level: 1 }).first();
  await expect(heading).toBeVisible();
  await expect(heading).not.toHaveText(/not found|404/i);
  await page.waitForLoadState('networkidle');
  const result = await measure(page);
  if (result.scrollWidth > result.clientWidth + 1) {
    await testInfo.attach(`${route} at ${width}px`, {
      body: await page.screenshot({ fullPage: true }),
      contentType: 'image/png',
    });
  }
  expect(
    result.scrollWidth,
    `${route} at ${width}px is ${result.scrollWidth}px wide in a ${result.clientWidth}px window; ` +
      `past the right edge: ${result.offenders.join(', ') || 'none found'}`,
  ).toBeLessThanOrEqual(result.clientWidth + 1);
}

function suite(
  title: string,
  persona: string,
  origin: (appBase: string) => string,
  routes: readonly string[],
) {
  test.describe(title, () => {
    let signed: Signed;

    test.beforeAll(async ({ browser, baseURL }) => {
      test.setTimeout(120_000);
      signed = await signInAs(browser, origin(baseURL ?? 'https://app.localhost'), persona);
    });

    test.afterAll(async () => {
      await signed?.context.close();
    });

    for (const route of routes) {
      for (const width of WIDTHS) {
        test(`${route} at ${width}px does not scroll sideways`, async () => {
          await checkFits(signed.page, test.info(), route, width);
        });
      }
    }
  });
}

suite('no sideways scroll: staff pages', 'founder', (appBase) => appBase, STAFF_PAGES);
// The portal is the app's sibling origin: app.<host> becomes portal.<host>.
suite(
  'no sideways scroll: vendor portal',
  'vendor',
  (appBase) => appBase.replace('//app.', '//portal.'),
  PORTAL_PAGES,
);
