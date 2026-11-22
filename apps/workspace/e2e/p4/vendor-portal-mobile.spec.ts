import { expect, test } from '@playwright/test';

import { signInAs } from '../helpers/memo-flow';

/**
 * FQA2 found the vendor portal home 435px wide in a 390px window: the tables' visually hidden cells
 * sat outside their scroll frame and widened the page. No vendor portal page may scroll sideways on
 * a phone. Against the real stack, as the vendor persona, on the portal origin.
 */

const PAGES = ['/vendor', '/vendor/purchase-orders', '/vendor/bills', '/vendor/rfqs'] as const;

test('the vendor portal pages fit a 390px window', async ({ browser, baseURL }) => {
  test.setTimeout(120_000);
  // The portal is the app's sibling origin: app.<host> becomes portal.<host>.
  const portal = (baseURL ?? 'https://app.localhost').replace('//app.', '//portal.');
  const vendor = await signInAs(browser, portal, 'vendor');
  try {
    const { page } = vendor;
    await page.setViewportSize({ width: 390, height: 844 });
    for (const route of PAGES) {
      await page.goto(route);
      const heading = page.getByRole('heading', { level: 1 });
      await expect(heading).toBeVisible();
      await expect(heading).not.toHaveText(/not found|404/i);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow, `${route} scrolls sideways`).toBeLessThanOrEqual(0);
    }
  } finally {
    await vendor.context.close();
  }
});
