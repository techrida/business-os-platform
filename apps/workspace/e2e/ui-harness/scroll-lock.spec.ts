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
      await page.evaluate(() => window.scrollBy(0, 100));
      if (control.scope === 'dialog') {
        await page.getByRole('button', { name: 'Open dialog' }).click();
        await expect(page.getByRole('dialog')).toBeVisible();
      }
      await page.waitForTimeout(300);
      const before = await frame(page);
      expect(before.scrollY).toBeGreaterThan(0);
      if (control.scope === 'page') {
        expect(
          await page.evaluate(() => innerWidth - document.documentElement.clientWidth),
        ).toBeGreaterThan(0);
      }

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
  expect(await page.evaluate(() => getComputedStyle(document.body).overflow)).toBe('hidden');
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).overflow)).toBe(
    'visible',
  );

  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => document.documentElement.style.overflow)).toBe('');
  await page.mouse.wheel(0, 300);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(before.scrollY);
});

for (const scope of ['page', 'dialog'] as const) {
  test(`a Tooltip ${scope === 'dialog' ? 'in a dialog' : 'on the page'} leaves the shell where it was`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(origin);
    await page.getByTestId('page-controls').scrollIntoViewIfNeeded();
    await page.evaluate(() => window.scrollBy(0, 100));
    if (scope === 'dialog') await page.getByRole('button', { name: 'Open dialog' }).click();
    await page.waitForTimeout(300);
    const before = await frame(page);
    await page.getByRole('button', { name: new RegExp(`${scope} tip`, 'i') }).hover();
    await expect(page.getByRole('tooltip').first()).toBeVisible();
    expect(await frame(page)).toEqual(before);
  });
}

for (const scope of ['page', 'dialog'] as const) {
  test.describe(`keyboard navigation ${scope === 'dialog' ? 'in a dialog' : 'on the page'}`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(origin);
      await page.getByTestId('page-controls').scrollIntoViewIfNeeded();
      await page.evaluate(() => window.scrollBy(0, 100));
      if (scope === 'dialog') await page.getByRole('button', { name: 'Open dialog' }).click();
      await page.waitForTimeout(300);
    });

    test('arrowing through a Select longer than its list keeps the option in view and the shell still', async ({
      page,
    }) => {
      const before = await frame(page);
      await page.getByRole('button', { name: new RegExp(`${scope} long list`, 'i') }).click();
      const list = page.getByRole('listbox');
      await expect(list).toBeVisible();
      for (let i = 0; i < 45; i++) await page.keyboard.press('ArrowDown');
      await page.waitForTimeout(300);
      const state = await page.evaluate(() => {
        const box = document.querySelector('[role=listbox]') as HTMLElement;
        const active = box.querySelector('[data-focused]') as HTMLElement | null;
        const a = active?.getBoundingClientRect();
        const l = box.getBoundingClientRect();
        return {
          text: active?.textContent ?? null,
          inside: a ? a.top >= l.top - 1 && a.bottom <= l.bottom + 1 : false,
          scrolled: box.scrollTop > 0,
        };
      });
      expect(state.text).toContain('Option 45');
      expect(state.inside).toBe(true);
      expect(state.scrolled).toBe(true);
      expect(await frame(page)).toEqual(before);
    });

    test('arrowing across months in a DatePicker leaves the shell where it was', async ({
      page,
    }) => {
      const before = await frame(page);
      const root = scope === 'page' ? page.getByTestId('page-controls') : page.getByRole('dialog');
      await root.getByRole('button', { name: /calendar|date/i }).click();
      await expect(page.getByRole('grid')).toBeVisible();
      const header = () => page.getByRole('grid').first().getAttribute('aria-label');
      const first = await header();
      for (let i = 0; i < 70; i++) await page.keyboard.press('ArrowRight');
      for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowDown');
      await page.keyboard.press('PageDown');
      await page.waitForTimeout(300);
      expect(await header()).not.toBe(first);
      const focused = await page.evaluate(() => {
        const cell = document.activeElement as HTMLElement | null;
        const r = cell?.getBoundingClientRect();
        return { inView: r ? r.top >= 0 && r.bottom <= innerHeight : false, tag: cell?.tagName };
      });
      expect(focused.inView).toBe(true);
      expect(await frame(page)).toEqual(before);
    });
  });
}
