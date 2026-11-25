import { expect, test, type Page, type TestInfo } from '@playwright/test';

import { signInAs, type Signed } from '../helpers/memo-flow';

/**
 * No page may scroll sideways on a phone or a tablet (Kuu, round 6 decision OQ-R6-04). One case per page and
 * width: the page loads, its heading shows, the network settles, and the document is no wider than the window
 * (1 px of rounding allowed). The inbox, every list page, the procurement pages, the vendor portal (home at 390 px
 * and 834 px; its purchase orders, bills and RFQs lists at 834 px) and the customer portal (home and invoices list,
 * both widths). Against the real stack: staff pages as the founder, the portal as the vendor and the customer.
 * Page-less tests at the bottom prove the detector itself fires on an overflowing page.
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
  '/activities',
  '/verification',
  '/payables/inbox',
  '/payables/vat-register',
  '/receivables/aging',
] as const;

const VENDOR_PORTAL_PAGES = ['/vendor'] as const;
/** Lists of the vendor portal, checked at the tablet width only. */
const VENDOR_PORTAL_TABLET_PAGES = [
  '/vendor/purchase-orders',
  '/vendor/bills',
  '/vendor/rfqs',
] as const;
const CUSTOMER_PORTAL_PAGES = ['/', '/invoices'] as const;

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
    // Content the shell clips (overflow: clip) never widens the document, so the document check alone cannot see
    // it. An element past the right edge counts unless it is invisible, visually hidden (1 px box), or inside a
    // frame that scrolls sideways on purpose (its content is reachable there).
    const inScrollFrame = (el: Element): boolean => {
      for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
        const ox = getComputedStyle(p).overflowX;
        if (
          (ox === 'auto' || ox === 'scroll') &&
          p.getBoundingClientRect().right <= clientWidth + 1
        ) {
          return true;
        }
        const box = p.getBoundingClientRect();
        if (box.width <= 1 || box.height <= 1) return true;
      }
      return false;
    };
    for (const el of document.body.querySelectorAll('*')) {
      const box = el.getBoundingClientRect();
      if (box.right <= clientWidth + 1 || box.width <= 1 || box.height <= 1) continue;
      if (!el.checkVisibility() || inScrollFrame(el)) continue;
      if (offenders.length < 5) {
        const id = el.id ? `#${el.id}` : '';
        const cls =
          typeof el.className === 'string' && el.className
            ? `.${el.className.trim().split(/\s+/)[0]}`
            : '';
        offenders.push(
          `${el.tagName.toLowerCase()}${id}${cls} (right edge ${Math.round(box.right)}px)`,
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
  await expect(heading).not.toHaveText(
    /not found|404|did not open|access yet|went wrong|could not load/i,
  );
  await page.waitForLoadState('networkidle');
  const result = await measure(page);
  if (result.scrollWidth > result.clientWidth + 1 || result.offenders.length > 0) {
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
  expect(
    result.offenders,
    `${route} at ${width}px: content sits past the right edge (a clipped frame hides it)`,
  ).toEqual([]);
}

/** The portal is the app's sibling origin: app.<host> becomes portal.<host>. */
function portalOrigin(appBase: string): string {
  return appBase.replace('//app.', '//portal.');
}

function suite(
  title: string,
  persona: string,
  origin: (appBase: string) => string,
  routes: readonly string[],
  widths: readonly number[] = WIDTHS,
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
      for (const width of widths) {
        test(`${route} at ${width}px does not scroll sideways`, async () => {
          await checkFits(signed.page, test.info(), route, width);
        });
      }
    }
  });
}

suite('no sideways scroll: staff pages', 'founder', (appBase) => appBase, STAFF_PAGES);
suite('no sideways scroll: vendor portal', 'vendor', portalOrigin, VENDOR_PORTAL_PAGES);
suite(
  'no sideways scroll: vendor portal lists',
  'vendor',
  portalOrigin,
  VENDOR_PORTAL_TABLET_PAGES,
  [834],
);
suite('no sideways scroll: customer portal', 'customer', portalOrigin, CUSTOMER_PORTAL_PAGES);

test.describe('the offender detector fires (R6Q24)', () => {
  const frame = (inner: string) =>
    `<!doctype html><html><body style="margin:0"><h1>Fixture</h1>${inner}</body></html>`;

  test('a page wider than the window fails the check', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 900 });
    await page.setContent(
      frame('<div id="wide" style="width:1200px;height:40px;background:#ccc"></div>'),
    );
    const result = await measure(page);
    expect(result.scrollWidth).toBeGreaterThan(result.clientWidth + 1);
    expect(result.offenders.join(' ')).toContain('div#wide');
  });

  test('content a clipped shell hides still counts as an offender', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 900 });
    await page.setContent(
      frame(
        '<div style="overflow:clip"><div id="hidden-wide" style="width:1200px;height:40px"></div></div>',
      ),
    );
    const result = await measure(page);
    expect(result.scrollWidth).toBeLessThanOrEqual(result.clientWidth + 1);
    expect(result.offenders.join(' ')).toContain('div#hidden-wide');
  });

  test('a frame that scrolls sideways on purpose, and a page that fits, pass', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 900 });
    await page.setContent(
      frame(
        '<div style="overflow-x:auto;width:100%"><div style="width:1200px;height:40px"></div></div>' +
          '<div style="width:300px;height:40px"></div>',
      ),
    );
    const result = await measure(page);
    expect(result.scrollWidth).toBeLessThanOrEqual(result.clientWidth + 1);
    expect(result.offenders).toEqual([]);
  });
});
