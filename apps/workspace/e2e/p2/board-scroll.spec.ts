import { expect, test } from '@playwright/test';

import { signInAs } from '../helpers/memo-flow';
import { chooseOption, selectByName } from '../helpers/select';

/**
 * Kanban boards scroll inside themselves, never the whole app (Kuu, 2026-11-23: on Leads > Board,
 * shift + wheel moved the sidebar, header and page sideways, with no scrollbar to show it). The
 * board wrapper could not shrink below its columns side by side, so the page grew wider than the
 * screen. Standard (Trello, Jira, Linear, GitHub Projects): the shell is fixed, the board is its
 * own horizontal scroll box. Real layout, so it runs against the stack. The seed holds no leads and
 * the board draws only with one, so the spec creates a lead first. Opportunities use the same Board
 * component (components/p2/crm/board.tsx).
 */

const WIDTHS = [390, 834, 1440] as const;
const BOARDS = ['/leads?view=board'] as const;

for (const route of BOARDS) {
  test(`${route}: the board scrolls sideways inside itself and the shell never does`, async ({
    browser,
    baseURL,
  }) => {
    test.setTimeout(180_000);
    const { context, page } = await signInAs(browser, baseURL ?? 'https://app.localhost', 'sales');
    try {
      await page.goto('/leads/new');
      await page
        .getByRole('textbox', { name: 'Lead title', exact: true })
        .fill(`Board scroll e2e ${Date.now()}`);
      await chooseOption(selectByName(page, 'source'), 'referral');
      await page
        .getByRole('textbox', { name: 'Company or organization', exact: true })
        .fill('Binford');
      await page.getByLabel('Contact person').fill('Sunita Shrestha');
      await page
        .getByRole('textbox', { name: 'Email', exact: true })
        .fill(`board.${Date.now()}@example.test`);
      await page.getByRole('button', { name: 'Create lead' }).click();
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();

      for (const width of WIDTHS) {
        await page.setViewportSize({ width, height: 900 });
        await page.goto(route);
        const board = page.getByRole('region', { name: /board \(scrolls sideways\)/ });
        await expect(board).toBeVisible();

        const shell = () =>
          page.evaluate(() => ({
            doc: document.documentElement.scrollWidth - document.documentElement.clientWidth,
            left: document.documentElement.scrollLeft,
          }));
        expect(await shell(), `${route} shell overflows at ${width}px`).toEqual({
          doc: 0,
          left: 0,
        });

        const measure = await board.evaluate((el) => ({
          scroll: el.scrollWidth,
          client: el.clientWidth,
        }));
        // Fixed-width columns: more of them than fit means the board, not the page, is the wide thing.
        if (width <= 834) expect(measure.scroll, `${width}px`).toBeGreaterThan(measure.client);

        // Shift + wheel over the board moves the board, not the app.
        await board.hover();
        await page.keyboard.down('Shift');
        await page.mouse.wheel(400, 0);
        await page.keyboard.up('Shift');
        await page.waitForTimeout(150);
        const after = await shell();
        expect(after.left, `${route} shell scrolled at ${width}px`).toBe(0);
        if (width <= 834) {
          expect(await board.evaluate((el) => el.scrollLeft)).toBeGreaterThan(0);
        }
      }
    } finally {
      await context.close();
    }
  });
}
