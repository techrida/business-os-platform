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

// Forms whose line items show on the bare route. A new RFQ has no editable line items, and the quotation
// builder edits a line in a dialog, so neither is measured here.
const FORMS = [
  { persona: 'procurement', route: '/procurement/requests/new' },
  { persona: 'finance', route: '/invoices/new' },
] as const;

// Forms that need a record: the route is the first link of that shape on a list page, so the specs follow
// whatever the seed holds. A form with no record to open is a failure, not a skip: the seed must carry one.
const LINKED_FORMS = [
  {
    // The warehouse persona confirms receipts; procurement may not receive, so its order page has no receive link.
    persona: 'warehouse',
    name: 'receipt',
    list: '/procurement/orders',
    link: /^\/procurement\/receipts\/new\?po=/,
    open: /^\/procurement\/orders\/[0-9a-f-]{36}$/,
    minBoxes: 1,
  },
  {
    persona: 'procurement',
    name: 'RFQ quotation entry',
    list: '/procurement/rfqs',
    link: /^\/procurement\/rfqs\/[0-9a-f-]{36}\/quotations\/new/,
    open: /^\/procurement\/rfqs\/[0-9a-f-]{36}$/,
    // The delivery-days box is one; the two request lines of the fixture add a price box each, so 3 proves lines show.
    minBoxes: 3,
  },
  {
    // The bare /payables/bills/new route shows no line items until an order is picked, so the form is measured the way
    // a person reaches it: the "Enter bill" link of an order (QA fixture PO-QA-1, issued by qa-fixtures.spec).
    persona: 'founder',
    name: 'bill entry for an order',
    list: '/procurement/orders',
    link: /^\/payables\/bills\/new\?po=/,
    open: /^\/procurement\/orders\/[0-9a-f-]{36}$/,
    minBoxes: 2,
  },
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

/** Opens each record of a list until one shows the link to the form, and returns that link. */
async function findFormRoute(
  page: Page,
  form: (typeof LINKED_FORMS)[number],
): Promise<string | null> {
  await page.goto(form.list);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  const records = await page
    .locator('main a[href]')
    .evaluateAll((anchors) => anchors.map((a) => a.getAttribute('href') ?? ''));
  const candidates = [...new Set(records.filter((href) => form.open.test(href)))].slice(0, 12);
  for (const record of candidates) {
    await page.goto(record);
    const hrefs = await page
      .locator('main a[href]')
      .evaluateAll((anchors) => anchors.map((a) => a.getAttribute('href') ?? ''));
    const found = hrefs.find((href) => form.link.test(href));
    if (found !== undefined) return found;
  }
  return null;
}

for (const form of LINKED_FORMS) {
  test(`${form.name}: every line-item control is usable from 390 to 1440 px`, async ({
    browser,
    baseURL,
  }) => {
    test.setTimeout(180_000);
    const signed = await signInAs(browser, baseURL ?? 'https://app.localhost', form.persona);
    try {
      const { page } = signed;
      const route = await findFormRoute(page, form);
      expect(route, `a record on ${form.list} that links to the ${form.name} form`).not.toBeNull();
      for (const width of WIDTHS) {
        await page.setViewportSize({ width, height: 900 });
        await page.goto(route!);
        await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
        await page.waitForTimeout(1_500);
        const result = await measure(page);
        expect(
          result.numberBoxes,
          `${form.name} shows its line items at ${width}px`,
        ).toBeGreaterThanOrEqual(form.minBoxes);
        expect(result.narrow, `${form.name} at ${width}px`).toEqual([]);
        expect(result.overflow, `${form.name} scrolls sideways at ${width}px`).toBeLessThanOrEqual(
          0,
        );
      }
    } finally {
      await signed.context.close();
    }
  });
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
