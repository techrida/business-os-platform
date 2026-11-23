import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { expect, test, type BrowserContext, type Locator, type Page } from '@playwright/test';

import { signInAs } from '../helpers/memo-flow';
import { chooseOption, selectByName } from '../helpers/select';

/**
 * Browser acceptance for the server-rendered, URL-backed list filters: no Apply or Search button,
 * the URL follows what is typed or picked, reload and back/forward restore it, the result count is
 * a live region, and the toolbar fits a phone. Against the real stack, as the founder persona.
 * NOT RUN by the unit that wrote it; the lead runs it with the stack up.
 *
 * Screenshots of every list page land in EVIDENCE_DIR (created by the tests).
 */

const EVIDENCE_DIR =
  process.env.EVIDENCE_DIR ?? path.join(os.tmpdir(), 'bos-list-filters-evidence');
const BASE = process.env.BASE_URL ?? 'https://app.localhost';

/** No filter control may need a click to apply itself. */
const APPLY_BUTTON = /^(Apply|Apply filters?|Search|Show .*)$/i;

/** The search box (type=search) inside the page's own content, not the shell. */
const searchBox = (page: Page): Locator => page.locator('main').getByRole('searchbox').first();

/** The filter form's trigger for one MultiSelect, found by its label ("Status"). */
const trigger = (page: Page, label: RegExp): Locator =>
  page
    .locator('main form[role="search"] button[aria-haspopup="listbox"]')
    .and(page.getByRole('button', { name: label }));

/** One hidden input per picked value: what a GET form would submit, and what the control shows. */
const pickedValues = (page: Page, name: string): Locator =>
  page.locator(`main form[role="search"] input[type="hidden"][name="${name}"]`);

/** The polite live region that reads the result count. */
const liveCount = (page: Page): Locator =>
  page.locator('main p[aria-live="polite"][aria-atomic="true"]');

const params = (page: Page): URLSearchParams => new URL(page.url()).searchParams;
const urlParam = (name: string, value: string) => (url: URL) =>
  url.searchParams.get(name) === value;
const urlHasAll =
  (name: string, count: number) =>
  (url: URL): boolean =>
    url.searchParams.getAll(name).length === count;

/** Row titles of the lead table, in order. */
const rowTitles = (page: Page): Promise<string[]> =>
  page.locator('main table tbody tr td:first-child a').allTextContents();

const slug = (route: string) => route.replace(/^\//, '').replace(/[^a-z0-9]+/gi, '-') || 'home';

async function shoot(page: Page, name: string): Promise<void> {
  await mkdir(EVIDENCE_DIR, { recursive: true });
  await page.screenshot({ path: path.join(EVIDENCE_DIR, `${name}.png`), fullPage: true });
}

/** Creates a lead through the real form, as the persona that is signed in. */
async function createLead(
  page: Page,
  lead: { title: string; source: string; company: string; contact: string },
): Promise<void> {
  await page.goto('/leads/new');
  // Controlled inputs: text typed before React hydrates is wiped.
  await page.waitForLoadState('networkidle');
  const title = page.getByRole('textbox', { name: 'Lead title', exact: true });
  await title.fill(lead.title);
  await chooseOption(selectByName(page, 'source'), lead.source);
  await page
    .getByRole('textbox', { name: 'Company or organization', exact: true })
    .fill(lead.company);
  await page.getByLabel('Contact person').fill(lead.contact);
  // A lead needs an email or at least one phone number.
  await page
    .getByRole('textbox', { name: 'Email', exact: true })
    .fill(`${randomUUID()}@example.test`);
  await expect(title).toHaveValue(lead.title);
  await page.getByRole('button', { name: 'Create lead' }).click();
  await expect(page.getByRole('heading', { level: 1, name: lead.title })).toBeVisible();
}

async function noFilterButtons(page: Page): Promise<void> {
  await expect(page.locator('main').getByRole('button', { name: APPLY_BUTTON })).toHaveCount(0);
}

async function listRendered(page: Page, route: string): Promise<void> {
  const response = await page.goto(route);
  expect(response?.status(), `${route} status`).toBeLessThan(400);
  await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
  // The route announcer is a role=alert outside <main>; anything inside <main> is a page error.
  await expect(page.locator('main [role="alert"]')).toHaveCount(0);
}

test.describe('leads: live, URL-backed filters', () => {
  test('search and status filters follow the URL, reload and back/forward', async ({ browser }) => {
    test.setTimeout(240_000);
    const tag = Date.now().toString(36);
    const himalyan = `Himalyan Traders ${tag}`;
    const { context, page } = await signInAs(browser, BASE, 'founder');
    try {
      await test.step('create three leads with different sources', async () => {
        await createLead(page, {
          title: himalyan,
          source: 'referral',
          company: `Everest Supply ${tag}`,
          contact: `Sunita ${tag}`,
        });
        await createLead(page, {
          title: `Kathmandu Carpets ${tag}`,
          source: 'website',
          company: `Valley Weavers ${tag}`,
          contact: `Binod ${tag}`,
        });
        await createLead(page, {
          title: `Pokhara Tea ${tag}`,
          source: 'event',
          company: `Lakeside Estates ${tag}`,
          contact: `Anita ${tag}`,
        });
      });

      const baselineCount =
        await test.step('the list opens without an Apply or Search button', async () => {
          await page.goto('/leads');
          await page.waitForLoadState('networkidle');
          await expect(page.getByRole('heading', { level: 1, name: 'Leads' })).toBeVisible();
          await expect(
            page.getByRole('search').getByRole('searchbox', { name: 'Search leads' }),
          ).toBeVisible();
          await noFilterButtons(page);
          await expect(liveCount(page)).toHaveText(/\blead/);
          await shoot(page, 'leads');
          return (await liveCount(page).textContent()) ?? '';
        });

      await test.step('a misspelt search reaches the URL by itself, without a click', async () => {
        const box = page.getByRole('searchbox', { name: 'Search leads' });
        await box.fill('Himalayan');
        await expect(page).toHaveURL(urlParam('q', 'Himalayan'), { timeout: 2_500 });
        await noFilterButtons(page);
        // Narrow it to this run's lead (older runs leave their own "Himalyan Traders" rows). The
        // stored name is spelt "Himalyan"; the query is not, so this is the fuzzy match.
        await box.fill(`Himalayan Traders ${tag}`);
        await expect(page).toHaveURL(urlParam('q', `Himalayan Traders ${tag}`), { timeout: 2_500 });
        await expect(page.getByRole('link', { name: himalyan })).toBeVisible();
        await expect(page.getByRole('link', { name: `Pokhara Tea ${tag}` })).toHaveCount(0);
        // The count region changed with the results.
        await expect(liveCount(page)).not.toHaveText(baselineCount);
      });

      let filteredTitles: string[] = [];
      let filteredCount = '';
      await test.step('two statuses reach the URL as repeated stage params', async () => {
        const status = trigger(page, /status/i);
        await status.click();
        await expect(status).toHaveAttribute('aria-expanded', 'true');
        await page.locator('[role="option"][data-key="new"]').click();
        await expect(page).toHaveURL(urlHasAll('stage', 1));
        await page.locator('[role="option"][data-key="contacted"]').click();
        await expect(page).toHaveURL(urlHasAll('stage', 2));
        await page.keyboard.press('Escape');
        await expect(status).toHaveAttribute('aria-expanded', 'false');

        expect(params(page).getAll('stage').sort()).toEqual(['contacted', 'new']);
        expect(params(page).get('q')).toBe(`Himalayan Traders ${tag}`);
        await expect(pickedValues(page, 'stage')).toHaveCount(2);
        await expect(page.getByRole('link', { name: himalyan })).toBeVisible();
        await noFilterButtons(page);
        filteredTitles = await rowTitles(page);
        filteredCount = (await liveCount(page).textContent()) ?? '';
        expect(filteredTitles).toContain(himalyan);
      });

      await test.step('a reload keeps both selections and the same results', async () => {
        const before = page.url();
        await page.reload();
        expect(page.url()).toBe(before);
        await expect(pickedValues(page, 'stage')).toHaveCount(2);
        await expect(trigger(page, /status/i)).toContainText('2 statuses');
        await expect.poll(() => rowTitles(page)).toEqual(filteredTitles);
        await expect(liveCount(page)).toHaveText(filteredCount);
        await expect(searchBox(page)).toHaveValue(`Himalayan Traders ${tag}`);
      });

      await test.step('Back restores the previous selection, Forward the later one', async () => {
        await page.goBack();
        await expect(page).toHaveURL(urlHasAll('stage', 1));
        expect(params(page).get('stage')).toBe('new');
        await expect(pickedValues(page, 'stage')).toHaveCount(1);
        await expect(pickedValues(page, 'stage')).toHaveValue('new');
        await expect(page.getByRole('link', { name: himalyan })).toBeVisible();

        await page.goForward();
        await expect(page).toHaveURL(urlHasAll('stage', 2));
        await expect(pickedValues(page, 'stage')).toHaveCount(2);
      });

      await test.step('the Clear row empties the status filter and keeps the search', async () => {
        const status = trigger(page, /status/i);
        await status.click();
        await expect(status).toHaveAttribute('aria-expanded', 'true');
        await page.getByRole('button', { name: 'Clear', exact: true }).click();
        await expect(page).toHaveURL(urlHasAll('stage', 0));
        await expect(pickedValues(page, 'stage')).toHaveCount(0);
        await expect(status).toContainText('All statuses');
        expect(params(page).get('q')).toBe(`Himalayan Traders ${tag}`);
        await expect(page.getByRole('link', { name: himalyan })).toBeVisible();
      });

      await test.step('a search with no match updates the live count and says so', async () => {
        await searchBox(page).fill(`zzqxjvkwp`);
        await expect(page).toHaveURL(urlParam('q', `zzqxjvkwp`), { timeout: 2_500 });
        await expect(liveCount(page)).toHaveText('No leads found');
        await expect(page.getByRole('heading', { name: 'No leads match' })).toBeVisible();
        await expect(page.locator('main [role="alert"]')).toHaveCount(0);
      });
    } finally {
      await context.close();
    }
  });

  test('the toolbar fits a phone and the page does not scroll sideways', async ({ browser }) => {
    test.setTimeout(120_000);
    const { context, page } = await signInAs(browser, BASE, 'founder');
    try {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto('/leads');
      await page.waitForLoadState('networkidle');
      await expect(page.getByRole('heading', { level: 1, name: 'Leads' })).toBeVisible();

      const fitsViewport = () =>
        page.evaluate(() => {
          const el = document.scrollingElement ?? document.documentElement;
          return el.scrollWidth <= window.innerWidth;
        });
      await expect.poll(fitsViewport).toBe(true);

      const box = searchBox(page);
      await expect(box).toBeVisible();
      const status = trigger(page, /status/i);
      await expect(status).toBeVisible();
      for (const control of [box, status]) {
        const rect = await control.boundingBox();
        expect(rect, 'toolbar control has a box').not.toBeNull();
        expect(rect!.x).toBeGreaterThanOrEqual(0);
        expect(rect!.x + rect!.width).toBeLessThanOrEqual(390);
      }

      // Typing and picking work at this width, and the open list stays on screen.
      await box.fill('zz');
      await expect(page).toHaveURL(urlParam('q', 'zz'), { timeout: 2_500 });
      await status.click();
      await expect(status).toHaveAttribute('aria-expanded', 'true');
      const option = page.locator('[role="option"][data-key="new"]');
      await expect(option).toBeVisible();
      const optionBox = await option.boundingBox();
      expect(optionBox).not.toBeNull();
      expect(optionBox!.x).toBeGreaterThanOrEqual(0);
      expect(optionBox!.x + optionBox!.width).toBeLessThanOrEqual(390);
      await option.click();
      await expect(page).toHaveURL(urlHasAll('stage', 1));
      await page.keyboard.press('Escape');
      await expect.poll(fitsViewport).toBe(true);
      await noFilterButtons(page);

      await page.goto('/leads');
      await page.waitForLoadState('networkidle');
      await expect.poll(fitsViewport).toBe(true);
      await shoot(page, 'leads-390');
    } finally {
      await context.close();
    }
  });
});

const LIST_PAGES = [
  '/opportunities',
  '/customers',
  '/vendors',
  '/quotations',
  '/sales-orders',
  '/invoices',
  '/payments',
  '/procurement/requests',
  '/procurement/rfqs',
  '/procurement/orders',
  '/payables/bills',
  '/payables/payment-requests',
  '/payables/inbox',
  '/memos',
  '/inbox',
  '/verification',
  '/activities',
  '/settings/users',
] as const;

test.describe('every list page: no filter button, search is live', () => {
  // One sign-in for the group; each test opens its own page in it, so they stay independent.
  let context: BrowserContext;

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(90_000);
    context = (await signInAs(browser, BASE, 'founder')).context;
    await mkdir(EVIDENCE_DIR, { recursive: true });
  });

  test.afterAll(async () => {
    await context?.close();
  });

  for (const route of LIST_PAGES) {
    test(`${route} renders, has no Apply or Search button, and searches as you type`, async () => {
      test.setTimeout(90_000);
      const page = await context.newPage();
      try {
        await listRendered(page, route);
        await noFilterButtons(page);
        await page.waitForLoadState('networkidle');
        await shoot(page, slug(route));

        const box = searchBox(page);
        if ((await box.count()) > 0) {
          await box.pressSequentially('zz');
          await expect(page).toHaveURL(urlParam('q', 'zz'), { timeout: 2_500 });
          await box.pressSequentially('zz');
          await expect(page).toHaveURL(urlParam('q', 'zzzz'), { timeout: 2_500 });
          await expect(page.locator('main form[role="search"]').first()).toHaveAttribute(
            'aria-busy',
            'false',
          );
          await expect(page.locator('main [role="alert"]')).toHaveCount(0);
          await noFilterButtons(page);
        }
      } finally {
        await page.close();
      }
    });
  }

  test('a repeated status param shows every selection on the invoices list', async () => {
    const page = await context.newPage();
    try {
      await listRendered(page, '/invoices?status=draft&status=issued');
      await expect(pickedValues(page, 'status')).toHaveCount(2);
      await expect(trigger(page, /status/i)).toContainText('2 statuses');
      await noFilterButtons(page);
    } finally {
      await page.close();
    }
  });

  test('a repeated status param shows every selection on the sales orders list', async () => {
    const page = await context.newPage();
    try {
      await listRendered(page, '/sales-orders?status=draft&status=confirmed');
      await expect(pickedValues(page, 'status')).toHaveCount(2);
      await expect(trigger(page, /status/i)).toContainText('2 statuses');
      await noFilterButtons(page);
    } finally {
      await page.close();
    }
  });
});
