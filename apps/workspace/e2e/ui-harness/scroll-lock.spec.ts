import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import path from 'node:path';

import { expect, test, type Locator, type Page } from '@playwright/test';

import { buildHarness } from './build';

/**
 * Opening a floating control must not move the app shell. Radix locks the page's scroll while a
 * dialog is open, and React Aria locks it again while a Select or date picker is open; two locks
 * on different root elements once turned `body` into a clip box, so the sticky sidebar lost its
 * scroll container and jumped, and the column shifted by the scrollbar's width. The harness page
 * (`main.tsx`) is the shell's real frame and sidebar CSS around real components, so it needs no
 * stack: `pnpm --filter @bos/workspace exec playwright test --project=ui`.
 */

let server: Server;
let origin = '';

const MIME: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
};

test.beforeAll(async () => {
  const dir = await buildHarness();
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const file = path.join(dir, url.pathname === '/' ? 'index.html' : url.pathname);
    if (!file.startsWith(dir) || !existsSync(file) || !statSync(file).isFile()) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' });
    createReadStream(file).pipe(res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  origin = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
});

test.afterAll(() => {
  server?.close();
});

interface Frame {
  scrollY: number;
  sidebar: { x: number; y: number; width: number; height: number } | null;
  main: { x: number; y: number; width: number; height: number };
}

async function frame(page: Page): Promise<Frame> {
  return page.evaluate(() => {
    const rect = (el: Element) => {
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    };
    const sidebar = document.querySelector('[data-testid="sidebar"]');
    return {
      scrollY: window.scrollY,
      sidebar: sidebar && getComputedStyle(sidebar).display !== 'none' ? rect(sidebar) : null,
      main: rect(document.querySelector('[data-testid="main"]') as Element),
    };
  });
}

type Opener = (page: Page) => Locator;

const controls: { name: string; scope: 'page' | 'dialog'; trigger: Opener; opened: Opener }[] = [];
for (const scope of ['page', 'dialog'] as const) {
  controls.push(
    {
      name: 'Select',
      scope,
      trigger: (p) => p.getByRole('button', { name: new RegExp(`${scope} terms`, 'i') }),
      opened: (p) => p.getByRole('listbox'),
    },
    {
      name: 'Combobox',
      scope,
      trigger: (p) => p.getByRole('combobox', { name: new RegExp(`${scope} company`, 'i') }),
      opened: (p) => p.getByRole('listbox'),
    },
    {
      name: 'DatePicker',
      scope,
      trigger: (p) =>
        (scope === 'page' ? p.getByTestId('page-controls') : p.getByRole('dialog')).getByRole(
          'button',
          {
            name: /calendar|date/i,
          },
        ),
      opened: (p) => p.getByRole('grid'),
    },
    {
      name: 'RowMenu',
      scope,
      trigger: (p) => p.getByRole('button', { name: new RegExp(`${scope} actions`, 'i') }),
      opened: (p) => p.getByRole('link', { name: 'One' }),
    },
  );
}

const viewports = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'mobile', width: 390, height: 800 },
];

for (const viewport of viewports) {
  for (const control of controls) {
    test(`${control.name} ${control.scope === 'dialog' ? 'in a dialog' : 'on the page'} leaves the shell where it was (${viewport.name})`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.goto(origin);
      await page.getByTestId('page-controls').scrollIntoViewIfNeeded();
      await page.evaluate(() => window.scrollBy(0, 300));
      if (control.scope === 'dialog') {
        await page.getByRole('button', { name: 'Open dialog' }).click();
        await expect(page.getByRole('dialog')).toBeVisible();
      }
      await page.waitForTimeout(300);
      const before = await frame(page);
      expect(before.scrollY).toBeGreaterThan(0);

      const box = await control.trigger(page).boundingBox();
      if (!box) throw new Error('trigger has no box');
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      await expect(control.opened(page).first()).toBeVisible();
      await page.waitForTimeout(300);
      const after = await frame(page);

      expect(after.scrollY).toBe(before.scrollY);
      expect(after.sidebar).toEqual(before.sidebar);
      expect(after.main).toEqual(before.main);

      await page.keyboard.press('Escape');
      await expect(control.opened(page)).toHaveCount(0);
      await page.waitForTimeout(300);
      const closed = await frame(page);
      expect(closed.scrollY).toBe(before.scrollY);
      expect(closed.sidebar).toEqual(before.sidebar);
      expect(closed.main).toEqual(before.main);
    });
  }
}

test('the page stays locked behind a dialog while a Select is open', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(origin);
  await page.getByTestId('page-controls').scrollIntoViewIfNeeded();
  await page.getByRole('button', { name: 'Open dialog' }).click();
  await page.getByRole('button', { name: /dialog terms/i }).click();
  await expect(page.getByRole('listbox')).toBeVisible();
  const before = await frame(page);
  await page.mouse.move(700, 100);
  await page.mouse.wheel(0, 600);
  await page.waitForTimeout(300);
  expect(await frame(page)).toEqual(before);
});
