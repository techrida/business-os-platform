/* global document, getComputedStyle -- referenced inside page.evaluate callbacks, which run in the browser */
// FQA3 flows (final QA after the end fix pass): checks that are new since FQA2. Same shape as FQA1/FQA2:
// { area, flow, persona, steps(c, S, step) }, one recorded clip per flow per size.
import { goNav, noSideScroll, ledger } from './fqa1-lib.mjs';
import { focusInfo, portalSignIn } from './fqa2-flows.mjs';

const focusText = (f) => `${f.tag}${f.role ? `[${f.role}]` : ''} "${f.name}"`;
const rectsOverlap = (a, b) =>
  !!a &&
  !!b &&
  !(a.x >= b.x + b.width || a.x + a.width <= b.x || a.y >= b.y + b.height || a.y + a.height <= b.y);

/** One deal per size for Dev Customer Co (the portal fixture) with a Sent quotation (prep-lost.sh). */
const LOST_LABEL = { desktop: 'fqa3mg', laptop: 'fqa3mh', tablet: 'fqa3mc', mobile: 'fqa3md' };

/** Visible text-like controls under main narrower than a readable value, and sideways page overflow. */
async function measureLines(page, min = 60) {
  return page.evaluate((limit) => {
    const narrow = [];
    const controls = document.querySelectorAll(
      'main input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([type="file"]):not([tabindex="-1"]), main textarea',
    );
    for (const el of controls) {
      const box = el.getBoundingClientRect();
      if (box.width === 0 && box.height === 0 && getComputedStyle(el).display === 'none') continue;
      if (getComputedStyle(el).position === 'absolute') continue;
      const width = Math.round(box.width);
      if (width < limit)
        narrow.push(
          `${el.getAttribute('aria-label') ?? el.getAttribute('name') ?? el.tagName}: ${width}px`,
        );
    }
    const qty = [...document.querySelectorAll('main input')].find((e) =>
      /^quantity/i.test(e.getAttribute('aria-label') ?? ''),
    );
    return {
      narrow,
      numberBoxes: document.querySelectorAll(
        'main input[inputmode="decimal"], main input[inputmode="numeric"]',
      ).length,
      qtyWidth: qty ? Math.round(qty.getBoundingClientRect().width) : null,
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  }, min);
}

export const FQA3_FLOWS = [
  {
    area: 'navigation',
    flow: 'dev-chip-settings',
    persona: 'Dev Finance',
    async steps(c, S, step) {
      const p = () => c.page();
      await step('1-as', 'Sign in as Dev Finance', async (c) => {
        await c.as('Dev Finance');
      });
      await step(
        '2-gear-reachable',
        'EF1: the Settings link can be pressed with a pointer and the Dev chip does not sit on it',
        async (c) => {
          await c.open('/');
          await p()
            .waitForLoadState('networkidle', { timeout: 15000 })
            .catch(() => {});
          const link = () => p().locator('a[href="/settings"]').first();
          if (
            !(await link()
              .isVisible()
              .catch(() => false))
          ) {
            const menu = p().getByRole('button', { name: /^Open menu$/ });
            if (await menu.isVisible().catch(() => false)) await menu.click();
          }
          await c.see(link(), 'link Settings (/settings)');
          const chip = p().locator('[aria-label="Dev menu"], [aria-label="Show dev menu"]').first();
          const lb = await link().boundingBox();
          const cb = await chip.boundingBox().catch(() => null);
          c.controls.push(
            `Settings link ${JSON.stringify(lb)}; Dev chip ${cb ? JSON.stringify(cb) : 'not found'}`,
          );
          c.ok(!rectsOverlap(lb, cb), 'the Dev chip does not overlap the Settings link');
          await link().click({ timeout: 5000 });
          await p().waitForURL((u) => u.pathname.startsWith('/settings'), { timeout: 60000 });
          c.controls.push('Settings opened from a pointer click (no keyboard fallback)');
        },
      );
    },
  },
  {
    area: 'procurement',
    flow: 'line-widths',
    persona: 'Dev Procurement',
    async steps(c, S, step) {
      const p = () => c.page();
      const widths = [Number(S.viewport.split('x')[0])];
      if (S.size === 'laptop') widths.push(1100);
      const [w0, h0] = S.viewport.split('x').map(Number);
      const check = async (route, label) => {
        for (const w of widths) {
          await p().setViewportSize({ width: w, height: h0 });
          await c.open(route);
          await c.see(p().getByRole('heading', { level: 1 }), 'page heading');
          await p().waitForTimeout(2500); // the number boxes take their final shape after hydration
          const m = await measureLines(p());
          const qtyBox = await p()
            .getByLabel(/Quantity/i)
            .first()
            .boundingBox()
            .catch(() => null);
          m.qtyWidth = qtyBox ? Math.round(qtyBox.width) : null;
          c.controls.push(
            `${label} at ${w}px: Quantity box ${m.qtyWidth ?? 'not found'} px, ${m.numberBoxes} number boxes, narrow: ${m.narrow.join(', ') || 'none'}, page overflow ${m.overflow}px`,
          );
          c.ok(m.numberBoxes >= 2, `${label} shows its line items at ${w}px`);
          c.ok(
            m.qtyWidth !== null && m.qtyWidth >= 60,
            `the Quantity box is readable (${m.qtyWidth} px) at ${w}px`,
          );
          c.ok(
            m.narrow.length === 0,
            `no control narrower than 60 px at ${w}px`,
            m.narrow.join(', '),
          );
          c.ok(m.overflow <= 1, `the page does not scroll sideways at ${w}px`, `${m.overflow}px`);
        }
        await p().setViewportSize({ width: w0, height: h0 });
      };
      await step('1-as', 'Sign in as Dev Procurement', async (c) => {
        await c.as('Dev Procurement');
      });
      await step(
        '2-purchase-request',
        `Purchase request line items at ${widths.join(' and ')} px`,
        async () => check('/procurement/requests/new', 'purchase request'),
      );
      await step('3-as-finance', 'Sign in as Dev Finance', async (c) => {
        await c.as('Dev Finance');
      });
      await step(
        '4-manual-invoice',
        `Manual invoice line items at ${widths.join(' and ')} px`,
        async () => check('/invoices/new', 'manual invoice'),
      );
    },
  },
  {
    area: 'focus',
    flow: 'date-picker-label',
    persona: 'Dev Procurement',
    async steps(c, S, step) {
      const p = () => c.page();
      await step('1-as', 'Sign in as Dev Procurement', async (c) => {
        await c.as('Dev Procurement');
      });
      await step(
        '2-label-click',
        'EF1: clicking the "Needed by" label puts focus on the first date segment',
        async (c) => {
          await c.open('/procurement/requests/new');
          await c.see(c.btn('Save draft'), 'button Save draft');
          await p()
            .waitForLoadState('networkidle', { timeout: 15000 })
            .catch(() => {});
          await p().getByText('Needed by', { exact: true }).first().click();
          await p().waitForTimeout(400);
          const f = await p().evaluate(() => {
            const e = document.activeElement;
            return {
              role: e?.getAttribute('role') ?? '',
              label: e?.getAttribute('aria-label') ?? '',
            };
          });
          c.controls.push(`focus after the label click: ${f.role} "${f.label}"`);
          c.ok(
            f.role === 'spinbutton' && /^(day|month)/i.test(f.label),
            `focus is on the first date segment (${f.role} "${f.label}")`,
          );
        },
      );
    },
  },
  {
    area: 'portal',
    flow: 'compiled-build',
    persona: 'Dev Customer (portal)',
    async steps(c, S, step) {
      const p = () => c.page();
      await step('1-sign-in', 'The fixture customer signs in on the portal for real', async (c) => {
        await portalSignIn(c, S, 'customer');
        await p()
          .waitForLoadState('networkidle', { timeout: 15000 })
          .catch(() => {});
        await c.see(p().getByRole('link', { name: 'Milestones' }).first(), 'link Milestones');
      });
      await step(
        '2-no-dev-tools',
        'I-F2: the portal is a compiled build (no "Open Next.js Dev Tools" button, no dev overlay element)',
        async (c) => {
          await c.absent(
            p().getByRole('button', { name: /Next\.js Dev Tools/i }),
            'a button "Open Next.js Dev Tools"',
          );
          const overlay = await p().evaluate(
            () => document.querySelectorAll('nextjs-portal, [data-nextjs-dev-tools-button]').length,
          );
          c.ok(overlay === 0, `no Next.js dev overlay element on the page (${overlay})`);
          const hmr = await p().evaluate(
            () =>
              performance
                .getEntriesByType('resource')
                .filter((e) => /webpack-hmr|_next\/static\/development|__nextjs_/.test(e.name))
                .length,
          );
          c.ok(hmr === 0, `no dev-server resources were loaded (${hmr})`);
        },
      );
    },
  },
  {
    area: 'sales',
    flow: 'deal-lost-refusals-portal',
    persona: 'Dev Sales',
    mutates: true,
    async steps(c, S, step) {
      const p = () => c.page();
      const label = LOST_LABEL[S.size];
      const reason = `FQA3 lost ${S.tag}`;
      const portal = S.qa.cfg.portalUrl;
      await step('1-as', 'Sign in as Dev Sales', async (c) => {
        await c.as('Dev Sales');
      });
      await step(
        '2-deal',
        `Open the Dev Customer Co deal with a Sent quotation (${label})`,
        async (c) => {
          await goNav(c, S, 'Opportunities', '/opportunities');
          await c.s.fill(
            p()
              .getByRole('searchbox', { name: /Search/ })
              .first(),
            `SCR-${label}`,
          );
          const link = p()
            .locator('main a[href^="/opportunities/"]')
            .filter({ hasText: `SCR-${label}` })
            .first();
          await c.s.click(link, `the deal ${label}`);
          await p().waitForURL((u) => /^\/opportunities\/[0-9a-f-]{36}$/.test(u.pathname), {
            timeout: 60000,
          });
          S.deal = new URL(p().url()).pathname;
          await c.see(p().getByText('Quotation Sent').first(), 'stage Quotation Sent', 30000);
          const q = p().locator('main a[href^="/quotations/"]:not([href*="/new"])').first();
          S.quote = await q.getAttribute('href');
          const noOf = async () =>
            /QT-\d{4}\/\d{2}-\d+/.exec(
              (await p().locator('main').innerText()).replace(/\s+/g, ' '),
            )?.[0];
          S.qno = await noOf();
          if (!S.qno) {
            await c.s.click(q, 'the quotation');
            S.qno = await noOf();
          }
          c.controls.push(`quotation ${S.quote} is ${S.qno}`);
          c.ok(!!S.qno, 'the quotation number is known', String(S.qno));
        },
      );
      await step(
        '3-portal-open',
        'The portal customer opens the Sent quotation link: it is open (not "no longer open")',
        async (c) => {
          await portalSignIn(c, S, 'customer');
          await p()
            .waitForLoadState('networkidle', { timeout: 15000 })
            .catch(() => {});
          const link = p().locator('a[href^="/quotations/"]').filter({ hasText: S.qno }).first();
          await c.see(link, `the portal lists ${S.qno}`, 30000);
          S.pquote = await link.getAttribute('href');
          const row = (
            await link
              .locator('xpath=ancestor::tr[1]')
              .innerText()
              .catch(() => '')
          ).replace(/\s+/g, ' ');
          c.controls.push(`portal list row: ${row}`);
          await c.s.click(link, S.qno);
          await p().waitForURL((u) => u.pathname === S.pquote, { timeout: 60000 });
          await c.see(p().getByRole('heading', { level: 1 }), 'a page heading on the quotation');
          await p()
            .waitForFunction(
              () => !/Loading/.test(document.querySelector('main')?.innerText ?? ''),
              null,
              {
                timeout: 30000,
              },
            )
            .catch(() => {});
          const text = (await p().locator('main').first().innerText()).replace(/\s+/g, ' ');
          c.ok(text.includes(S.qno), `the page is quotation ${S.qno}`, text.slice(0, 160));
          c.ok(
            !/no longer open/i.test(text),
            'the Sent quotation does not say "no longer open"',
            text.slice(0, 160),
          );
          c.ok(
            !/not found/i.test(text),
            'the Sent quotation is not "not found"',
            text.slice(0, 160),
          );
          await noSideScroll(c, 'portal quotation (sent)');
        },
      );
      await step(
        '4-mark-lost',
        'Dev Sales marks the deal Lost: the quotation is cancelled',
        async (c) => {
          await c.as('Dev Sales');
          await c.open(S.deal);
          await c.s.click(p().getByRole('button', { name: 'Mark lost', exact: true }), 'Mark lost');
          const dlg = p().getByRole('dialog');
          const cb = dlg.getByRole('combobox', { name: 'Reason' });
          await cb.click();
          await cb.fill(reason);
          await p().getByRole('option').first().click({ delay: 80 });
          await dlg.getByRole('textbox', { name: 'Note' }).fill('FQA3 note');
          await dlg.getByRole('button', { name: 'Mark lost', exact: true }).click({ delay: 80 });
          await c.see(
            p().getByText(/This opportunity is lost/),
            'text "This opportunity is lost."',
            60000,
          );
          ledger({ kind: `deal ${label} marked lost (FQA3)`, path: S.deal, size: S.size });
        },
      );
      await step(
        '5-refusals',
        'EF2: on the lost deal a quotation cannot be drafted, and the cancelled quotation cannot be revised',
        async (c) => {
          await p().reload({ waitUntil: 'domcontentloaded' });
          await c.see(
            p().getByText(/This opportunity is lost/),
            'text "This opportunity is lost."',
          );
          await c.absent(
            p().getByRole('link', { name: 'New quotation', exact: true }),
            'a New quotation link on the lost deal',
          );
          const dealId = S.deal.split('/').pop();
          await p().goto(
            `${p().url().split('/opportunities')[0]}/quotations/new?opportunity=${dealId}`,
            {
              waitUntil: 'domcontentloaded',
            },
          );
          await p().waitForTimeout(3000);
          const text = (await p().locator('main').innerText()).replace(/\s+/g, ' ');
          c.controls.push(`direct new-quotation page on the lost deal says: ${text.slice(0, 200)}`);
          c.ok(
            /lost|cannot|can't|not open|closed/i.test(text) ||
              (await p()
                .getByRole('button', { name: /^(Create|Save)/ })
                .count()) === 0,
            'the direct new-quotation page refuses a lost deal (or offers no create button)',
            text.slice(0, 200),
          );
          await c.open(S.quote);
          await c.see(
            p().getByText('Cancelled', { exact: true }).first(),
            'status Cancelled',
            30000,
          );
          await c.absent(
            p().getByRole('button', { name: 'Revise', exact: true }),
            'a Revise button on the cancelled quotation',
          );
        },
      );
      await step(
        '6-portal-closed',
        'EF2: the cancelled quotation link on the portal reads "no longer open", not "not found"',
        async (c) => {
          // The portal session from step 3 is still in this browser context; sign in again only if it ended.
          await p().goto(`${portal}${S.pquote}`, { waitUntil: 'domcontentloaded' });
          await p()
            .waitForURL((u) => u.origin === new URL(portal).origin, { timeout: 20000 })
            .catch(() => {});
          if (new URL(p().url()).origin !== new URL(portal).origin) {
            await portalSignIn(c, S, 'customer');
            await p().goto(`${portal}${S.pquote}`, { waitUntil: 'domcontentloaded' });
          }
          await c.see(
            p().getByRole('heading', { name: /Quotation no longer open/ }),
            'heading "Quotation no longer open"',
            30000,
          );
          const text = (await p().locator('main').first().innerText()).replace(/\s+/g, ' ');
          c.ok(!/not found/i.test(text), 'the page does not say "not found"', text.slice(0, 160));
          await noSideScroll(c, 'portal quotation (cancelled)');
        },
      );
    },
  },
];

export { focusInfo, focusText };
