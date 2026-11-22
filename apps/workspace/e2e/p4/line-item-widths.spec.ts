import { expect, test, type Page } from '@playwright/test';

import { signInAs } from '../helpers/memo-flow';

/**
 * Line-item forms at laptop widths. FQA2 found the purchase request's Quantity box 41 px wide at
 * 1440, 23 px at 1280 and 0 px at 1100: the number box keeps its currency, unit and stepper parts
 * at a fixed size, so a narrow grid column left the real input nothing. Every control in a line
 * item must stay usable (wide enough to read a value) and the page must not scroll sideways, from
 * a phone to a desktop. Against the real stack, one persona per form. The number boxes only take their
 * final shape after the page hydrates, so each page is given a moment before it is measured.
 */

const MIN_CONTROL_WIDTH = 60;
const WIDTHS = [390, 834, 1100, 1280, 1440] as const;

// Forms whose line items show on the bare route. Others need a record id or a query (receipts need a
// purchase order, quotations an opportunity) or have no editable line items (a new RFQ), so they are
// not measured here.
const FORMS = [
  { persona: 'procurement', route: '/procurement/requests/new' },
  { persona: 'finance', route: '/invoices/new' },
] as const;

interface Measure {
  narrow: string[];
  overflow: number;
  numberBoxes: number;
}

/** Visible text-like controls under main that are narrower than a readable value, and sideways overflow. */
async function measure(page: Page): Promise<Measure> {
  return page.evaluate((min) => {
    const narrow: string[] = [];
    // The custom select keeps a hidden native twin (tabindex -1); it is not what a person types in.
    const controls = document.querySelectorAll<HTMLElement>(
      'main input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([type="file"]):not([tabindex="-1"]), main textarea',
    );
    for (const el of controls) {
      const box = el.getBoundingClientRect();
      if (box.width === 0 && box.height === 0 && getComputedStyle(el).display === 'none') continue;
      if (getComputedStyle(el).position === 'absolute') continue;
      // The number boxes keep a unit, steppers and a currency beside the bare input: judge the input.
      const width = Math.round(box.width);
      if (width < min) {
        const name = el.getAttribute('aria-label') ?? el.getAttribute('name') ?? el.tagName;
        narrow.push(`${name}: ${width}px`);
      }
    }
    return {
      narrow,
      numberBoxes: document.querySelectorAll(
        'main input[inputmode="decimal"], main input[inputmode="numeric"]',
      ).length,
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  }, MIN_CONTROL_WIDTH);
}

for (const form of FORMS) {
  test(`${form.route}: every line-item control is usable from 390 to 1440 px`, async ({
    browser,
    baseURL,
  }) => {
    test.setTimeout(120_000);
    const signed = await signInAs(browser, baseURL ?? 'https://app.localhost', form.persona);
    try {
      const { page } = signed;
      for (const width of WIDTHS) {
        await page.setViewportSize({ width, height: 900 });
        await page.goto(form.route);
        await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
        // The number boxes swap their server-rendered input for the live one on hydration; measure that one.
        await page.waitForTimeout(1_500);
        const result = await measure(page);
        // Quantity and Unit price are number boxes: without them nothing line-item was measured.
        expect(
          result.numberBoxes,
          `${form.route} shows its line items at ${width}px`,
        ).toBeGreaterThanOrEqual(2);
        expect(result.narrow, `${form.route} at ${width}px`).toEqual([]);
        expect(result.overflow, `${form.route} scrolls sideways at ${width}px`).toBeLessThanOrEqual(
          0,
        );
      }
    } finally {
      await signed.context.close();
    }
  });
}
