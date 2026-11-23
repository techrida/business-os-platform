/* global document -- referenced inside page.evaluate callbacks, which run in the browser */
// FQA1 flows. Each flow: { area, flow, persona, steps(c, S, step) }. A flow reaches its list through the real
// navigation (sidebar, rail or drawer), opens a record from the list and takes the next action as one user.
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { goNav, noSideScroll, reachable, pickDate, ledger, logIssue } from './fqa1-lib.mjs';

const money = (t) => Number(String(t).replace(/[^0-9.-]/g, ''));

const INV13 = 'INV-2083/84-00013'; // issued, unpaid (seeded)

export const FLOWS = [
  {
    area: 'invoicing',
    flow: 'browse',
    persona: 'Dev Finance',
    async steps(c, S, step) {
      await step('1-as', 'Sign in as Dev Finance through the Dev switcher', async (c) => {
        await c.as('Dev Finance');
      });
      await step('2-list', 'Invoices list opens from the navigation', async (c) => {
        await goNav(c, S, 'Invoices', '/invoices');
        await c.see(c.heading('Invoices', { level: 1 }), 'heading Invoices');
        await c.see(c.page().getByRole('searchbox', { name: 'Search invoices' }), 'search box');
        await c.see(c.page().getByRole('link', { name: /Create Invoice/ }), 'link Create Invoice');
        await noSideScroll(c, '/invoices');
      });
      await step('3-search', `Search finds ${INV13}`, async (c) => {
        const box = c.page().getByRole('searchbox', { name: 'Search invoices' });
        await c.s.fill(box, INV13);
        await c.see(c.link(INV13), `row link ${INV13}`, 30000);
      });
      await step(
        '4-detail',
        `Open ${INV13}: View PDF and Record payment are offered`,
        async (c) => {
          await c.s.click(c.link(INV13), INV13);
          await c.see(c.heading(INV13, { level: 1 }), `heading ${INV13}`);
          await c.see(c.btn('View PDF'), 'button View PDF');
          await c.see(c.link('Record payment'), 'link Record payment');
          await reachable(c, c.link('Record payment'), 'Record payment');
          await noSideScroll(c, 'invoice detail');
        },
      );
      await step('5-pdf', 'View PDF opens the document or says it is being prepared', async (c) => {
        await c.s.click(c.btn('View PDF'), 'View PDF');
        const p = c.page();
        const ready = p.getByRole('dialog').or(p.locator('iframe, embed, object, canvas')).first();
        await ready.waitFor({ state: 'visible', timeout: 45000 });
        c.controls.push('visible: PDF viewer (dialog, iframe, embed or canvas)');
      });
      await step(
        '6-download',
        'The PDF viewer names the file and Download saves it under that name (Chromium)',
        async (c) => {
          const d = c.page().getByRole('dialog');
          const title = (await d.getByRole('heading').first().innerText()).trim();
          c.ok(/\.pdf$/.test(title), `the viewer title is a file name (${title})`);
          await c.see(d.getByText(/^Page \d+ of \d+$/), 'status "Page n of m"', 60000);
          const dir = mkdtempSync(path.join(os.tmpdir(), 'fqa1-pdf-'));
          const got = await c.s.download(
            d.getByRole('button', { name: 'Download', exact: true }),
            dir,
          );
          c.ok(
            got.name === title,
            `downloaded file name "${got.name}" equals the viewer title "${title}"`,
          );
          c.ok(
            got.bytes.subarray(0, 4).toString() === '%PDF',
            `the download is a PDF (${got.bytes.length} bytes)`,
          );
        },
      );
    },
  },

  {
    area: 'invoicing',
    flow: 'adjustments-view',
    persona: 'Dev Finance',
    async steps(c, S, step) {
      await step('1-as', 'Sign in as Dev Finance', async (c) => {
        await c.as('Dev Finance');
      });
      await step(
        '2-credit-note',
        'Open a credit note from the list: it links to its original invoice',
        async (c) => {
          await goNav(c, S, 'Invoices', '/invoices');
          await search(c, 'invoices', 'CN-2083/84-00002');
          await c.s.click(c.link('CN-2083/84-00002'), 'CN-2083/84-00002');
          await c.see(c.heading('CN-2083/84-00002', { level: 1 }), 'heading CN-2083/84-00002');
          await c.see(
            c.page().getByRole('heading', { name: 'CREDIT NOTE' }),
            'heading CREDIT NOTE',
          );
          await c.see(c.link('Open original invoice'), 'link Open original invoice');
          await noSideScroll(c, 'credit note');
        },
      );
      await step(
        '3-debit-note',
        'Open a debit note: titled DEBIT NOTE, billed to the customer, Record payment offered',
        async (c) => {
          await goNav(c, S, 'Invoices', '/invoices');
          await search(c, 'invoices', 'DN-2083/84-00002');
          await c.s.click(c.link('DN-2083/84-00002'), 'DN-2083/84-00002');
          await c.see(c.heading('DN-2083/84-00002', { level: 1 }), 'heading DN-2083/84-00002');
          await c.see(
            c.page().getByRole('heading', { name: /^debit note$/i }),
            'heading DEBIT NOTE',
          );
          await c.see(c.link('Record payment'), 'link Record payment');
          await reachable(c, c.link('Record payment'), 'Record payment');
          await noSideScroll(c, 'debit note');
        },
      );
      await step(
        '4-original',
        'Follow "Open original invoice" to the tax invoice, which offers Credit note and Debit note',
        async (c) => {
          await c.s.click(c.link('Open original invoice'), 'Open original invoice');
          await c.see(
            c.page().getByRole('heading', { name: 'TAX INVOICE' }),
            'heading TAX INVOICE',
          );
          await c.see(
            c.page().getByRole('heading', { name: 'Adjustments' }),
            'heading Adjustments',
          );
          await c.see(c.btn('Credit note'), 'button Credit note');
          await c.see(c.btn('Debit note'), 'button Debit note');
        },
      );
    },
  },
  {
    area: 'invoicing',
    flow: 'vat-register',
    persona: 'Dev Accountant',
    async steps(c, S, step) {
      await step('1-as', 'Sign in as Dev Accountant', async (c) => {
        await c.as('Dev Accountant');
      });
      await step(
        '2-open',
        'Sales VAT register opens from the navigation and asks for a period',
        async (c) => {
          await goNav(c, S, 'Sales VAT register', '/invoices/vat-register');
          await c.see(c.heading('Sales VAT register', { level: 1 }), 'heading Sales VAT register');
          await c.see(c.btn('Show register'), 'button Show register');
          await noSideScroll(c, 'vat register');
        },
      );
      await step(
        '3-period',
        'Pick the first and last day of this month and show the register',
        async (c) => {
          const now = new Date();
          const y = now.getUTCFullYear();
          const m = String(now.getUTCMonth() + 1).padStart(2, '0');
          const last = String(new Date(Date.UTC(y, now.getUTCMonth() + 1, 0)).getUTCDate());
          await pickDate(c, 0, `${y}-${m}-01`);
          await pickDate(c, 1, `${y}-${m}-${last}`);
          await c.s.click(c.btn('Show register'), 'Show register');
          await c.see(
            c.page().getByRole('table', { name: 'Sales VAT register' }),
            'table Sales VAT register',
            60000,
          );
        },
      );
      await step(
        '4-rows',
        'Rows are only tax invoices, credit notes and debit notes; credit negative, debit positive',
        async (c) => {
          const rows = await c
            .page()
            .getByRole('table', { name: 'Sales VAT register' })
            .locator('tbody tr')
            .evaluateAll((trs) =>
              trs.map((tr) =>
                [...tr.querySelectorAll('td')].map((td) =>
                  td.innerText.replace(/\s+/g, ' ').trim(),
                ),
              ),
            );
          c.ok(rows.length > 0, 'the register has rows', String(rows.length));
          const head = await c
            .page()
            .getByRole('table', { name: 'Sales VAT register' })
            .locator('thead th')
            .allInnerTexts();
          const col = (n) => head.findIndex((h) => h.replace(/\s+/g, ' ').trim() === n);
          const iKind = col('Document');
          const iTax = col('Taxable');
          c.ok(iKind >= 0 && iTax >= 0, 'columns Document and Taxable exist', head.join('|'));
          const bad = rows.filter(
            (r) => !/Tax invoice|Credit note|Debit note/.test(r[iKind] ?? ''),
          );
          c.ok(
            bad.length === 0,
            'every row is a tax invoice, credit note or debit note',
            JSON.stringify(bad.slice(0, 2)),
          );
          const cn = rows.filter((r) => /Credit note/.test(r[iKind]));
          const dn = rows.filter((r) => /Debit note/.test(r[iKind]));
          c.ok(
            cn.every((r) => money(r[iTax]) < 0),
            `credit notes are negative (${cn.length})`,
          );
          c.ok(
            dn.every((r) => money(r[iTax]) > 0),
            `debit notes are positive (${dn.length})`,
          );
          S.vatRows = rows.length;
        },
      );
      await step(
        '5-totals',
        'The NPR total card equals the sum of the NPR rows (summed here, no fixed numbers)',
        async (c) => {
          const t = c.page().getByRole('table', { name: 'Sales VAT register' });
          const head = (await t.locator('thead th').allInnerTexts()).map((h) =>
            h.replace(/\s+/g, ' ').trim(),
          );
          const iCur = head.indexOf('Currency');
          const iTax = head.indexOf('Taxable');
          const iNprTax = head.indexOf('Taxable (NPR)');
          const rows = await t
            .locator('tbody tr')
            .evaluateAll((trs) =>
              trs.map((tr) =>
                [...tr.querySelectorAll('td')].map((td) =>
                  td.innerText.replace(/\s+/g, ' ').trim(),
                ),
              ),
            );
          const sumNpr = rows
            .filter((r) => r[iCur] === 'NPR')
            .reduce((a, r) => a + money(r[iTax]), 0);
          const sumEq = rows.reduce((a, r) => a + money(r[iNprTax]), 0);
          const text = await c.s.text();
          const m1 = /Taxable sales \(NPR\)\s*NPR\s*([-0-9.,]+)/.exec(text);
          const m2 = /Taxable sales \(NPR equivalent, all currencies\)\s*NPR\s*([-0-9.,]+)/.exec(
            text,
          );
          c.ok(
            !!m1 && Math.abs(money(m1[1]) - sumNpr) < 0.01,
            `Taxable sales (NPR) card ${m1?.[1]} = rows ${sumNpr.toFixed(2)}`,
          );
          c.ok(
            !!m2 && Math.abs(money(m2[1]) - sumEq) < 0.01,
            `NPR-equivalent filing total ${m2?.[1]} = rows ${sumEq.toFixed(2)} (FU11)`,
          );
        },
      );
      await step(
        '6-csv',
        'Export CSV downloads the same rows with a total row per currency',
        async (c) => {
          const dir = mkdtempSync(path.join(os.tmpdir(), 'fqa1-vat-'));
          const d = await c.s.download(c.link('Export CSV'), dir);
          const text = d.bytes.toString('utf8');
          const lines = text.split(/\r?\n/).filter(Boolean);
          c.ok(lines.length > 2, `the CSV has ${lines.length} lines`);
          c.ok(/Total NPR/.test(text), 'a "Total NPR" row exists');
          c.ok(
            /2026-\d\d-\d\d/.test(text) && /20\d\d-\d\d-\d\d/.test(text),
            'AD dates are present',
          );
          c.controls.push(`file ${d.name}, ${d.bytes.length} bytes`);
        },
      );
      await step(
        '7-sales-refused',
        'As Dev Sales the register is refused and not in the navigation',
        async (c) => {
          await c.as('Dev Sales');
          await c.open('/invoices/vat-register');
          await c.see(
            c.page().getByText('Your roles do not include the sales VAT register.'),
            'refusal sentence',
          );
          await c.absent(
            c
              .page()
              .locator('a[href="/invoices/vat-register"]')
              .filter({ hasText: 'Sales VAT register' }),
            'nav link Sales VAT register',
          );
        },
      );
    },
  },
  {
    area: 'payments',
    flow: 'browse',
    persona: 'Dev Finance',
    async steps(c, S, step) {
      await step('1-as', 'Sign in as Dev Finance', async (c) => {
        await c.as('Dev Finance');
      });
      await step('2-list', 'Payments list opens from the navigation', async (c) => {
        await goNav(c, S, 'Payments', '/payments');
        await c.see(c.heading('Payments', { level: 1 }), 'heading Payments');
        await c.see(c.page().getByRole('link', { name: /Record payment/ }), 'link Record payment');
        await noSideScroll(c, '/payments');
      });
      await step(
        '3-detail',
        'Open receipt RCPT-2083/84-00024: proof of payment and allocation are shown',
        async (c) => {
          await search(c, 'payments', 'RCPT-2083/84-00024');
          await c.s.click(c.link('RCPT-2083/84-00024'), 'RCPT-2083/84-00024');
          await c.see(c.heading('RCPT-2083/84-00024', { level: 1 }), 'heading RCPT-2083/84-00024');
          await c.see(
            c.page().getByRole('heading', { name: 'Proof of payment' }),
            'heading Proof of payment',
          );
          await c.see(c.btn('payment-proof.pdf'), 'proof file button');
          await c.see(c.btn('Allocate payment'), 'button Allocate payment');
          await noSideScroll(c, 'receipt detail');
        },
      );
      await step('4-customer', 'The receipt links to its customer', async (c) => {
        await c.s.click(c.link('BOS Demo Himalayan Labs'), 'customer link');
        await c.page().waitForURL(/\/customers\//, { timeout: 60000 });
        await c.see(c.page().getByRole('heading', { level: 1 }), 'customer page heading');
      });
    },
  },
  {
    area: 'payments',
    flow: 'statement',
    persona: 'Dev Finance',
    async steps(c, S, step) {
      await step('1-as', 'Sign in as Dev Finance', async (c) => {
        await c.as('Dev Finance');
      });
      await step(
        '2-aging',
        'Receivables aging opens from the navigation and lists the customer',
        async (c) => {
          await goNav(c, S, 'Receivables', '/receivables/aging');
          await c.see(c.heading('Receivables aging', { level: 1 }), 'heading Receivables aging');
          await c.see(c.link('BOS Demo Himalayan Labs'), 'customer row link');
          await noSideScroll(c, 'aging');
        },
      );
      await step(
        '3-statement',
        'Open the customer statement: open items, overdue count and Record payment',
        async (c) => {
          await c.s.click(c.link('BOS Demo Himalayan Labs'), 'customer');
          await c.see(
            c.page().getByRole('heading', { name: 'Open items', level: 2 }),
            'heading Open items',
          );
          await c.see(c.link('Record payment'), 'link Record payment');
          await c.see(c.link('View payments'), 'link View payments');
          await noSideScroll(c, 'statement');
        },
      );
      await step(
        '4-record',
        'Record payment from the statement opens the form for that customer',
        async (c) => {
          await c.s.click(c.link('Record payment'), 'Record payment');
          await c.see(c.heading('Record payment', { level: 1 }), 'heading Record payment');
          await c.see(c.page().getByRole('button', { name: 'Customer' }), 'Customer control');
        },
      );
    },
  },
  {
    area: 'approvals',
    flow: 'inbox',
    persona: 'Dev Finance',
    async steps(c, S, step) {
      await step('1-as', 'Sign in as Dev Finance', async (c) => {
        await c.as('Dev Finance');
      });
      await step(
        '2-list',
        'Inbox opens from the navigation with a search and a document-type filter',
        async (c) => {
          await goNav(c, S, 'Inbox', '/inbox');
          await c.see(c.heading('Inbox', { level: 1 }), 'heading Inbox');
          await c.see(c.page().getByRole('searchbox', { name: 'Search approvals' }), 'search box');
          await c.see(
            c.page().getByRole('button', { name: /document types?/i }),
            'button Document type filter',
          );
          await noSideScroll(c, '/inbox');
        },
      );
      await step(
        '3-request',
        'Open the first request in the list: route, decision and submitted details show',
        async (c) => {
          const first = c.page().locator('main a[href^="/inbox/"]').first();
          await c.see(first, 'a request row link', 30000);
          await c.s.click(first, 'first request');
          await c.see(
            c.page().getByRole('heading', { name: 'Approval route' }),
            'heading Approval route',
          );
          await c.see(
            c.page().getByRole('heading', { name: 'Your decision' }),
            'heading Your decision',
          );
          await c.see(
            c.page().getByRole('heading', { name: 'Submitted details' }),
            'heading Submitted details',
          );
          await noSideScroll(c, 'request detail');
        },
      );
    },
  },
  {
    area: 'finance',
    flow: 'dashboard',
    persona: 'Dev Finance',
    async steps(c, S, step) {
      await step('1-as', 'Sign in as Dev Finance', async (c) => {
        await c.as('Dev Finance');
      });
      await step(
        '2-overview',
        'Overview shows the approvals count and the waiting-for-decision list',
        async (c) => {
          await goNav(c, S, 'Overview', '/');
          await c.see(
            c.page().getByRole('heading', { name: /approvals? to review/ }),
            'heading "<n> approvals to review"',
          );
          await c.see(
            c.page().getByRole('heading', { name: 'Waiting for your decision' }),
            'heading Waiting for your decision',
          );
          await noSideScroll(c, 'overview');
        },
      );
      await step('3-settings', 'Settings lists Currencies and exchange rates', async (c) => {
        await goNav(c, S, 'Settings', '/settings');
        await c.see(
          c
            .page()
            .getByRole('link', { name: /Currencies/ })
            .first(),
          'link Currencies',
        );
      });
      await step(
        '4-fx',
        'Exchange rates display: recent rates table lists a rate per currency, newest first',
        async (c) => {
          await c.s.click(
            c
              .page()
              .getByRole('link', { name: /Currencies/ })
              .first(),
            'Currencies',
          );
          await c.see(
            c.heading('Currencies and exchange rates', { level: 1 }),
            'heading Currencies and exchange rates',
          );
          await c.see(
            c.page().getByRole('heading', { name: 'Recent rates' }),
            'heading Recent rates',
          );
          const tbl = c.page().getByRole('table', { name: 'Exchange rates, newest first' });
          await c.see(tbl, 'table Exchange rates, newest first');
          const rows = await tbl.locator('tbody tr').count();
          c.ok(rows >= 1, `the rate table has ${rows} rows`);
          await noSideScroll(c, 'currencies');
        },
      );
    },
  },

  {
    area: 'invoicing',
    flow: 'debit-note-chain',
    persona: 'Dev Finance',
    mutates: true,
    async steps(c, S, step) {
      await step('1-as', 'Sign in as Dev Finance', async (c) => {
        await c.as('Dev Finance');
      });
      await step(
        '2-open-invoice',
        `Open ${INV13} from the Invoices list and press Debit note`,
        async (c) => {
          await goNav(c, S, 'Invoices', '/invoices');
          await search(c, 'invoices', INV13);
          await c.s.click(c.link(INV13), INV13);
          await c.see(c.heading(INV13, { level: 1 }), `heading ${INV13}`);
          await c.s.click(c.btn('Debit note'), 'Debit note');
          await c.see(
            c
              .page()
              .getByRole('dialog')
              .getByRole('heading', { name: /^Debit note for / }),
            'dialog Debit note for ...',
          );
        },
      );
      await step(
        '3-create',
        'Create the debit note (one line, VAT 13%, a reason): it opens as a Draft',
        async (c) => {
          const d = c.page().getByRole('dialog');
          await d
            .getByRole('textbox', { name: /^Description/ })
            .fill(`FQA1 ${S.tag} extra service`);
          await d.getByRole('textbox', { name: /^Unit \(line/ }).fill('pcs');
          await d.getByRole('textbox', { name: /^Unit price/ }).fill('10');
          await c.s.choose(d.locator('button[aria-haspopup="listbox"]').first(), 'VAT 13%');
          await d.getByRole('textbox', { name: 'Reason' }).fill(`FQA1 ${S.tag} clip`);
          await d
            .getByRole('button', { name: 'Create debit note', exact: true })
            .click({ delay: 80 });
          await c
            .page()
            .waitForURL(
              (u) =>
                /^\/invoices\/[0-9a-f-]{36}$/.test(u.pathname) && !u.pathname.includes('694353a2'),
              { timeout: 90000 },
            );
          await c.see(c.btn('Submit for approval'), 'button Submit for approval');
          await c.see(c.page().getByText('Draft', { exact: true }).first(), 'status Draft');
          S.dn = new URL(c.page().url()).pathname;
          ledger({ kind: 'debit-note draft', invoice: INV13, path: S.dn, size: S.size });
        },
      );
      await step(
        '4-submit',
        'Submit it for approval: the page says it waits for an approver',
        async (c) => {
          await c.s.click(c.btn('Submit for approval'), 'Submit for approval');
          const d = c.page().getByRole('dialog');
          await d
            .getByRole('button', { name: 'Submit for approval', exact: true })
            .click({ delay: 80 });
          await doneDialog(c);
          await c.see(c.link('Open the approval request'), 'link Open the approval request', 90000);
          S.req = await c.link('Open the approval request').getAttribute('href');
          c.controls.push(`approval request ${S.req}`);
        },
      );
      await step(
        '5-issue-gate',
        'Before approval, Issue is not offered as an enabled button',
        async (c) => {
          const issue = c.page().getByRole('button', { name: /^Issue/ });
          const n = await issue.count();
          const enabled = n ? await issue.first().isEnabled() : false;
          c.ok(!enabled, `no enabled Issue button before approval (${n} Issue buttons)`);
        },
      );
      await step(
        '6-accountant',
        'Dev Accountant opens the request from the Inbox and approves (step 1)',
        async (c) => {
          await c.as('Dev Accountant');
          await goNav(c, S, 'Inbox', '/inbox');
          await c.s.goto(S.req, (p) => p.getByRole('heading', { name: 'Your decision' }));
          await decide(c, 'Approve', S.req);
        },
      );
      await step('7-finance-two', 'Dev Finance Two approves (step 2)', async (c) => {
        await c.as('Dev Finance Two');
        await goNav(c, S, 'Inbox', '/inbox');
        await c.s.goto(S.req, (p) => p.getByRole('heading', { name: 'Your decision' }));
        await decide(c, 'Approve', S.req);
      });
      await step(
        '8-finance-blocked',
        'Dev Finance (the creator) cannot issue: Issue is off with a reason',
        async (c) => {
          await c.as('Dev Finance');
          await c.open(S.dn);
          const issue = c.page().getByRole('button', { name: /^Issue/ });
          await c.see(issue.first(), 'an Issue button');
          c.ok(!(await issue.first().isEnabled()), 'Issue is disabled for the creator');
        },
      );
      await step(
        '9-issue',
        'Dev Finance Two issues the debit note; it is numbered DN-...',
        async (c) => {
          await c.as('Dev Finance Two');
          await c.open(S.dn);
          await c.s.click(
            c
              .page()
              .getByRole('button', { name: /^Issue/ })
              .first(),
            'Issue',
          );
          const d = c.page().getByRole('dialog');
          await d
            .getByRole('button', { name: /^Issue/ })
            .last()
            .click({ delay: 80 });
          await doneDialog(c);
          await c.see(
            c
              .page()
              .getByText(/DN-\d{4}\/\d\d-\d{5}/)
              .first(),
            'a DN- number',
            90000,
          );
          await c.see(c.btn('View PDF'), 'button View PDF');
        },
      );
      await step(
        '10-due-date',
        "Due date = issue date + the customer's net days (shown as AD and BS)",
        async (c) => {
          const t = await c.s.text();
          const m = /Issue date\s+(\d{1,2} \w{3} \d{4}).*?Due date\s+(\d{1,2} \w{3} \d{4})/.exec(t);
          c.ok(!!m, 'issue date and due date are both shown', t.slice(0, 200));
          const days = Math.round(
            (Date.parse(m[2] + ' UTC') - Date.parse(m[1] + ' UTC')) / 86400000,
          );
          c.controls.push(`issue ${m[1]} due ${m[2]} = ${days} days`);
          c.ok(days >= 0, 'due date is not before the issue date', String(days));
          S.dueDays = days;
        },
      );
    },
  },
  {
    area: 'payments',
    flow: 'record-from-invoice',
    persona: 'Dev Finance',
    mutates: true,
    async steps(c, S, step) {
      await step('1-as', 'Sign in as Dev Finance', async (c) => {
        await c.as('Dev Finance');
      });
      await step('2-open', `Open ${INV13} and press Record payment`, async (c) => {
        await goNav(c, S, 'Invoices', '/invoices');
        await search(c, 'invoices', INV13);
        await c.s.click(c.link(INV13), INV13);
        await c.s.click(c.link('Record payment'), 'Record payment');
        await c.see(c.heading('Record payment', { level: 1 }), 'heading Record payment');
      });
      await step(
        '3-prefill',
        'The form starts on the invoice currency and its open amount; the customer is read-only',
        async (c) => {
          const cust = c.page().getByRole('textbox', { name: 'Customer', exact: true });
          await c.see(cust, 'textbox Customer');
          c.ok((await cust.isEditable()) === false, 'the Customer box is read-only');
          c.ok(
            (await cust.inputValue()).includes('BOS Demo Himalayan Labs'),
            'the customer is named',
            await cust.inputValue(),
          );
          await c.see(
            c
              .page()
              .getByText(/open amount of INV-/i)
              .first(),
            'hint "open amount of INV-..."',
          );
          await c.see(
            c.page().getByRole('button', { name: /^NPR/ }).first(),
            'currency NPR chosen',
          );
          await noSideScroll(c, 'payment form');
        },
      );
      await step(
        '4-currency-hint',
        'Changing the currency removes the "open amount" hint',
        async (c) => {
          await c.s.choose(
            c.page().locator('button[aria-haspopup="listbox"]').filter({ hasText: /^NPR/ }).first(),
            /^INR/,
          );
          await c.absent(
            c.page().getByText(/open amount of INV-/i),
            'hint "open amount of INV-..."',
          );
          await c.s.choose(
            c.page().locator('button[aria-haspopup="listbox"]').filter({ hasText: /^INR/ }).first(),
            /^NPR/,
          );
        },
      );
      await step(
        '5-part-payment',
        'Type a smaller amount, add a proof file and save: a part payment is accepted',
        async (c) => {
          await c.s.fill(
            c.page().getByRole('textbox', { name: 'Amount received', exact: true }),
            '1.00',
          );
          await c.s.fill(
            c.page().getByRole('textbox', { name: 'Bank reference', exact: true }),
            `FQA1-${S.tag}`,
          );
          const pdf = proofFile('fqa1-proof.pdf');
          await c.page().getByLabel('Add proof files').setInputFiles(pdf);
          await c.see(c.btn(/Remove fqa1-proof\.pdf/), 'chip Remove fqa1-proof.pdf', 120000);
          await c
            .page()
            .getByText(/^Uploading/)
            .first()
            .waitFor({ state: 'hidden', timeout: 120000 })
            .catch(() => {});
          await c.s.click(
            c.page().getByRole('button', { name: 'Record payment', exact: true }),
            'Record payment (submit)',
          );
          await c
            .page()
            .waitForURL((u) => /^\/payments\/[0-9a-f-]{36}$/.test(u.pathname), { timeout: 120000 });
          S.pay = new URL(c.page().url()).pathname;
          ledger({ kind: 'payment (NPR 1.00 part payment on INV-13)', path: S.pay, size: S.size });
        },
      );
      await step(
        '6-detail',
        'The payment page shows its status, proof and the invoice to allocate to',
        async (c) => {
          await c.see(
            c.page().getByRole('heading', { name: 'Payment overview' }),
            'heading Payment overview',
          );
          await c.see(
            c.page().getByRole('heading', { name: 'Proof of payment' }),
            'heading Proof of payment',
          );
          await c.see(
            c
              .page()
              .getByText(/Awaiting verification|Verified/)
              .first(),
            'a status badge',
          );
          await noSideScroll(c, 'new payment');
        },
      );
      await step(
        '7-invoice',
        'The invoice still opens and shows what is left to pay',
        async (c) => {
          await c.open(`/invoices?q=${encodeURIComponent(INV13)}`);
          await c.s.click(c.link(INV13), INV13);
          await c.see(
            c
              .page()
              .getByText(/Open amount/)
              .first(),
            'Open amount',
          );
        },
      );
    },
  },
  {
    area: 'payments',
    flow: 'promise-to-pay',
    persona: 'Dev Finance',
    mutates: true,
    async steps(c, S, step) {
      await step('1-as', 'Sign in as Dev Finance', async (c) => {
        await c.as('Dev Finance');
      });
      await step(
        '2-card',
        `${INV13} shows a Promise to pay card with Record promise`,
        async (c) => {
          await goNav(c, S, 'Invoices', '/invoices');
          await search(c, 'invoices', INV13);
          await c.s.click(c.link(INV13), INV13);
          await c.see(
            c.page().getByRole('heading', { name: 'Promise to pay' }),
            'heading Promise to pay',
          );
          await c.see(c.btn('Record promise'), 'button Record promise');
        },
      );
      await step(
        '3-record',
        'Record a promise for 7 days ahead with a note: the card shows it',
        async (c) => {
          await c.s.click(c.btn('Record promise'), 'Record promise');
          const d = c.page().getByRole('dialog');
          await c.see(
            d.getByRole('heading', { name: 'Record a promise to pay' }),
            'dialog Record a promise to pay',
          );
          const when = new Date(Date.now() + 7 * 86400000);
          const iso = when.toISOString().slice(0, 10);
          await pickDate(c, 0, iso, d);
          await d.getByRole('textbox', { name: /^Note/ }).fill(`FQA1 ${S.tag}`);
          await d
            .getByRole('button', { name: /^(Record|Save)/ })
            .last()
            .click({ delay: 80 });
          await doneDialog(c);
          await c.see(
            c.page().getByText(`FQA1 ${S.tag}`).first(),
            'the promise note on the card',
            60000,
          );
          S.promiseOn = iso;
          ledger({
            kind: 'promise to pay on INV-13',
            date: iso,
            note: `FQA1 ${S.tag}`,
            size: S.size,
          });
        },
      );
      await step(
        '4-aging',
        'Receivables aging shows "Promised to pay by <date> on <invoice>" linking back',
        async (c) => {
          await goNav(c, S, 'Receivables', '/receivables/aging');
          await c.see(
            c
              .page()
              .getByText(/Promised to pay by/)
              .first(),
            'text "Promised to pay by ..."',
            60000,
          );
          await c.s.click(c.link(INV13), `link ${INV13}`);
          await c.see(c.heading(INV13, { level: 1 }), `heading ${INV13}`);
        },
      );
      await step(
        '5-sales-no-card',
        'As Dev Sales the invoice opens normally with no Promise to pay card',
        async (c) => {
          await c.as('Dev Sales');
          await c.open(new URL(c.page().url()).pathname);
          await c.rendered();
          await c.absent(c.btn('Record promise'), 'button Record promise');
        },
      );
    },
  },
  {
    area: 'documents',
    flow: 'upload-scan',
    persona: 'Dev Finance',
    mutates: true,
    async steps(c, S, step) {
      await step(
        '1-as',
        'Sign in as Dev Finance and open Record payment from Payments',
        async (c) => {
          await c.as('Dev Finance');
          await goNav(c, S, 'Payments', '/payments');
          await c.s.click(c.page().getByRole('link', { name: /Record payment/ }), 'Record payment');
          await c.see(c.heading('Record payment', { level: 1 }), 'heading Record payment');
        },
      );
      await step('2-needs-customer', 'The proof upload waits for a customer', async (c) => {
        c.ok(
          await c.page().getByLabel('Add proof files').isDisabled(),
          'the proof chooser is disabled before a customer is chosen',
        );
        await c.s.choose(
          c.page().locator('button[aria-haspopup="listbox"]').first(),
          /BOS Demo Himalayan Labs/,
        );
        await c.page().waitForFunction(
          () => {
            const i = document.querySelector('input[type=file]');
            return i && !i.disabled;
          },
          null,
          { timeout: 30000 },
        );
      });
      await step(
        '3-clean-file',
        'A clean PDF uploads and appears as a chip with its scan finishing',
        async (c) => {
          await c.page().getByLabel('Add proof files').setInputFiles(proofFile('fqa1-clean.pdf'));
          await c.see(c.btn(/Remove fqa1-clean\.pdf/), 'chip Remove fqa1-clean.pdf', 120000);
          ledger({
            kind: 'proof upload (clean, unlinked, swept by the hourly job)',
            name: 'fqa1-clean.pdf',
            size: S.size,
          });
        },
      );
      await step(
        '4-eicar',
        'The EICAR test file is refused with a virus message and no chip',
        async (c) => {
          await c.page().getByLabel('Add proof files').setInputFiles(eicarFile('fqa1-eicar.pdf'));
          await c
            .page()
            .getByText(/virus|infected|malware|refused|rejected/i)
            .first()
            .waitFor({ state: 'visible', timeout: 120000 });
          c.controls.push('visible: a virus/refusal message');
          await c.absent(c.btn(/Remove fqa1-eicar\.pdf/), 'chip for the infected file');
          ledger({ kind: 'proof upload (EICAR, refused)', name: 'fqa1-eicar.pdf', size: S.size });
        },
      );
    },
  },
  {
    area: 'invoicing',
    flow: 'issue-chain',
    persona: 'Dev Finance',
    mutates: true,
    async steps(c, S, step) {
      await step(
        '1-as',
        'Sign in as Dev Finance and open Create Invoice from the Invoices list',
        async (c) => {
          await c.as('Dev Finance');
          await goNav(c, S, 'Invoices', '/invoices');
          await c.s.click(c.page().getByRole('link', { name: /Create Invoice/ }), 'Create Invoice');
          await c.see(c.heading('Create Invoice', { level: 1 }), 'heading Create Invoice');
          await noSideScroll(c, 'new invoice form');
        },
      );
      await step(
        '2-draft',
        'Draft a manual invoice (customer, reason, one line with VAT 13%) and save it',
        async (c) => {
          const p = c.page();
          await c.s.choose(
            p.locator('button[aria-haspopup="listbox"]').first(),
            /^BOS Demo Himalayan Labs \(CUS/,
          );
          await p
            .getByRole('textbox', { name: 'Why is there no sales order?' })
            .fill(`FQA1 ${S.tag} clip`);
          await p.getByRole('textbox', { name: /^Description/ }).fill(`FQA1 ${S.tag} service`);
          await p.getByRole('textbox', { name: /^Unit \(line/ }).fill('hrs');
          await p.getByRole('textbox', { name: /^Unit price/ }).fill('100');
          await c.s.choose(
            p
              .locator('button[aria-haspopup="listbox"]')
              .filter({ hasText: /^Choose$/ })
              .first(),
            'VAT 13%',
          );
          await c.s.click(
            p.getByRole('button', { name: 'Save draft invoice', exact: true }),
            'Save draft invoice',
          );
          await p.waitForURL((u) => /^\/invoices\/[0-9a-f-]{36}$/.test(u.pathname), {
            timeout: 120000,
          });
          await c.see(c.btn('Submit for approval'), 'button Submit for approval', 60000);
          S.inv = new URL(p.url()).pathname;
          ledger({ kind: 'manual invoice draft', path: S.inv, size: S.size });
        },
      );
      await step('3-submit', 'Submit it for approval', async (c) => {
        await c.s.click(c.btn('Submit for approval'), 'Submit for approval');
        await c
          .page()
          .getByRole('dialog')
          .getByRole('button', { name: 'Submit for approval', exact: true })
          .click({ delay: 80 });
        await doneDialog(c);
        await c.see(c.link('Open the approval request'), 'link Open the approval request', 90000);
        S.req = await c.link('Open the approval request').getAttribute('href');
      });
      await step(
        '4-accountant',
        'Dev Accountant approves (step 1: a manual invoice goes to the Accountant first)',
        async (c) => {
          await c.as('Dev Accountant');
          await goNav(c, S, 'Inbox', '/inbox');
          await c.s.goto(S.req, (p) => p.getByRole('heading', { name: 'Your decision' }));
          await decide(c, 'Approve', S.req);
        },
      );
      await step('5-finance-two', 'Dev Finance Two approves (step 2)', async (c) => {
        await c.as('Dev Finance Two');
        await goNav(c, S, 'Inbox', '/inbox');
        await c.s.goto(S.req, (p) => p.getByRole('heading', { name: 'Your decision' }));
        await decide(c, 'Approve', S.req);
      });
      await step(
        '6-issue',
        'Dev Finance Two issues the invoice: it is numbered INV-...',
        async (c) => {
          await c.open(S.inv);
          await c.s.click(
            c
              .page()
              .getByRole('button', { name: /^Issue/ })
              .first(),
            'Issue',
          );
          await c
            .page()
            .getByRole('dialog')
            .getByRole('button', { name: /^Issue/ })
            .last()
            .click({ delay: 80 });
          await doneDialog(c);
          await c.see(
            c
              .page()
              .getByText(/INV-\d{4}\/\d\d-\d{5}/)
              .first(),
            'an INV- number',
            90000,
          );
          S.issuedAt = Date.now();
        },
      );
      await step(
        '7-pdf',
        'View PDF straight after issue: "Preparing PDF", then the PDF appears by itself',
        async (c) => {
          await c.s.click(c.btn('View PDF'), 'View PDF');
          const p = c.page();
          const prep = p.getByText(/Preparing/i).first();
          const seen = await prep.isVisible({ timeout: 4000 }).catch(() => false);
          c.controls.push(`"Preparing PDF" seen: ${seen}`);
          const ready = p.getByRole('dialog').locator('iframe, embed, object, canvas, img').first();
          await ready.waitFor({ state: 'visible', timeout: 120000 });
          c.controls.push(
            `visible: PDF viewer after ${Math.round((Date.now() - S.issuedAt) / 1000)} s from issue`,
          );
        },
      );
    },
  },
  {
    area: 'finance',
    flow: 'codes',
    persona: 'Dev Founder',
    mutates: true,
    async steps(c, S, step) {
      const code = `FQ${Date.now().toString(36).slice(-5).toUpperCase()}`;
      const name = `FQA1 ${code}`;
      // Retiring a tax code opens a dialog (effective date, then "Retire tax code"); a payment term retires at once.
      const confirm = async (c) => {
        const d = c.page().getByRole('dialog');
        if (await d.isVisible({ timeout: 4000 }).catch(() => false))
          await d.getByRole('button', { name: /^Retire/ }).click({ delay: 80 });
      };
      await step('1-as', 'Sign in as Dev Founder and open Settings, Tax', async (c) => {
        await c.as('Dev Founder');
        await goNav(c, S, 'Settings', '/settings');
        await c.open('/settings/tax');
        await c.see(c.heading('Tax', { level: 1 }), 'heading Tax');
        await c.see(c.btn('Add tax code'), 'button Add tax code');
        await noSideScroll(c, 'tax settings');
      });
      await step('2-add-code', 'Add a VAT code: it appears with Change and Retire', async (c) => {
        await c.s.click(c.btn('Add tax code'), 'Add tax code');
        const d = c.page().getByRole('dialog');
        await d.getByRole('textbox', { name: 'Name', exact: true }).fill(name);
        await d.getByRole('textbox', { name: 'Code', exact: true }).fill(code);
        await d.getByRole('spinbutton', { name: 'Rate (%)' }).fill('5');
        await d.getByRole('button', { name: 'Add tax code', exact: true }).click({ delay: 80 });
        await c.see(c.btn(`Change ${code}`), `button Change ${code}`, 90000);
        await c.see(c.btn(`Retire ${code}`), `button Retire ${code}`);
        ledger({ kind: 'tax code added then retired', code, size: S.size });
      });
      await step('3-change-code', 'Change its rate and name', async (c) => {
        await c.s.click(c.btn(`Change ${code}`), `Change ${code}`);
        const d = c.page().getByRole('dialog');
        await d.getByRole('textbox', { name: 'Name', exact: true }).fill(`${name} changed`);
        await d.getByRole('spinbutton', { name: 'Rate (%)' }).fill('6');
        await d.getByRole('button', { name: 'Save change', exact: true }).click({ delay: 80 });
        await c.see(
          c
            .page()
            .getByRole('row', { name: new RegExp(code) })
            .getByText(/Changes to 6% on/)
            .first(),
          'the scheduled change "Changes to 6% on <date>" in the Status column',
          90000,
        );
      });
      await step(
        '4-retire-code',
        'Retire it: Change and Retire are gone for that code',
        async (c) => {
          await c.s.click(c.btn(`Retire ${code}`), `Retire ${code}`);
          await confirm(c);
          await c
            .page()
            .getByRole('dialog')
            .waitFor({ state: 'hidden', timeout: 90000 })
            .catch(() => {});
          await c.absent(c.btn(`Retire ${code}`), `button Retire ${code}`);
        },
      );
      await step(
        '5-terms',
        'Add, rename and retire a payment term under Saved terms',
        async (c) => {
          await c.open('/settings/terms');
          await c.s.click(c.btn('Add payment term'), 'Add payment term');
          const d = c.page().getByRole('dialog');
          await d.getByRole('textbox', { name: 'Name', exact: true }).fill(name);
          await d.getByRole('textbox', { name: 'Code', exact: true }).fill(code);
          await d.getByRole('textbox', { name: 'Days to pay', exact: true }).fill('15');
          await d
            .getByRole('button', { name: 'Add payment term', exact: true })
            .click({ delay: 80 });
          await c.see(c.btn(`Rename ${name}`), `button Rename ${name}`, 90000);
          await c.s.click(c.btn(`Rename ${name}`), 'Rename');
          await c
            .page()
            .getByRole('dialog')
            .getByRole('textbox', { name: 'Name', exact: true })
            .fill(`${name} r`);
          await c
            .page()
            .getByRole('dialog')
            .getByRole('button', { name: 'Save name', exact: true })
            .click({ delay: 80 });
          await c.see(c.btn(`Retire ${name} r`), `button Retire ${name} r`, 90000);
          await c.s.click(c.btn(`Retire ${name} r`), 'Retire');
          await confirm(c);
          await c
            .page()
            .getByRole('dialog')
            .waitFor({ state: 'hidden', timeout: 90000 })
            .catch(() => {});
          await c.absent(c.btn(`Retire ${name} r`), 'the retired term');
          ledger({ kind: 'payment term added, renamed, retired', name, size: S.size });
        },
      );
    },
  },
];

/** A tiny valid PDF the scanner accepts. */
export function proofFile(name) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'fqa1-up-'));
  const file = path.join(dir, name);
  const body =
    '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 100]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n';
  writeFileSync(file, body);
  return file;
}

/** The standard anti-virus test string (EICAR): harmless, but every scanner flags it. */
export function eicarFile(name) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'fqa1-up-'));
  const file = path.join(dir, name);
  writeFileSync(file, 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*');
  return file;
}
/** Decide an inbox request: press the decision button, add a reason if it asks, confirm. */
export async function decide(c, word, req) {
  const p = c.page();
  const btn = p
    .getByRole('main')
    .getByRole('button', { name: new RegExp(`^${word}`) })
    .first();
  await c.see(btn, `a decision button "${word}..."`, 120000);
  // Under load a click before hydration is lost: retry (after a reload) until the button is gone.
  for (let attempt = 1; attempt <= 4; attempt++) {
    await p.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
    await p.waitForTimeout(1500);
    await btn.click({ delay: 120 });
    const d = p.getByRole('dialog');
    if (await d.isVisible({ timeout: 4000 }).catch(() => false)) {
      for (const f of await d.locator('textarea').all())
        await f.fill('FQA1 round-5 final QA decision');
      await d
        .getByRole('button', { name: new RegExp(`^${word}`) })
        .last()
        .click({ delay: 120 });
    }
    // Wait on the page itself: leaving it would drop the action in flight.
    // The app returns to the Inbox after a decision; a request page that says "decided" also counts.
    const decided = await Promise.any([
      p.waitForURL((u) => u.pathname === '/inbox', { timeout: 120000 }),
      p
        .getByText(/This request has been decided/)
        .first()
        .waitFor({ state: 'visible', timeout: 120000 }),
    ])
      .then(() => true)
      .catch(() => false);
    if (decided) break;
    c.controls.push(`note: decision click ${attempt} not confirmed in 120 s, reloading`);
    if (attempt === 4) throw new Error(`the ${word} button never took the decision`);
    await p.reload({ waitUntil: 'domcontentloaded' });
    const again = await btn.isVisible({ timeout: 60000 }).catch(() => false);
    if (!again) break;
  }
  // Re-read the request until it names the decider; the wait is recorded (a stale page is a finding).
  const t1 = Date.now();
  let seen = false;
  for (let i = 0; i < 40 && !seen; i++) {
    await c.s.goto(req, (pg) => pg.getByRole('heading', { name: 'Your decision' }));
    seen = await p
      .getByText(`Decided by ${c.persona}`)
      .first()
      .isVisible({ timeout: 8000 })
      .catch(() => false);
    if (!seen) await p.waitForTimeout(8000);
  }
  const lag = Math.round((Date.now() - t1) / 1000);
  c.controls.push(`the request page named "${c.persona}" as decider after ${lag} s of re-reading`);
  if (!seen) throw new Error(`the request page never showed "Decided by ${c.persona}" in 5 min`);
  if (lag > 20)
    logIssue({
      id: `I-03 ${c.persona}`,
      severity: 'medium',
      area: 'approvals',
      found: `After ${c.persona} approved, the request page kept showing Pending with the Approve button for ${lag} s, although History already recorded the approval`,
      repro: `Approve a request as ${c.persona}, then reload ${req}: Pending and Approve show until about ${lag} s later`,
    });
  c.controls.push(`decision "${word}" recorded`);
}

/** An invoice action dialog shows its result and next step (EF1), then Done reloads the page with the new state. */
async function doneDialog(c) {
  const done = c.page().getByRole('dialog').getByRole('button', { name: 'Done', exact: true });
  await c.see(done, 'button Done after the action', 90000);
  // EF1: the dialog now shows the server's result and what happens next, not an empty body.
  const body = (await c.page().getByRole('dialog').innerText()).replace(/\s+/g, ' ');
  const words = body
    .replace(/Done|Close|Cancel/g, '')
    .trim()
    .split(' ').length;
  c.controls.push(`dialog body before Done: ${body.slice(0, 240)}`);
  c.ok(words >= 8, 'the dialog body says what happened and what happens next', body.slice(0, 160));
  await done.click({ delay: 80 });
  await c
    .page()
    .waitForLoadState('load', { timeout: 60000 })
    .catch(() => {});
}

/** Type in a list search box and wait until the table has narrowed to the one matching row. */
export async function search(c, what, text) {
  const box = c.page().getByRole('searchbox', { name: `Search ${what}` });
  const rows = c.page().locator('main table tbody tr');
  for (let i = 0; i < 3; i++) {
    await c.s.fill(box, text);
    for (let w = 0; w < 10; w++) {
      if ((await rows.count()) === 1 && (await box.inputValue()) === text) return;
      await c.page().waitForTimeout(1000);
    }
    if (i < 2) {
      await box.fill('');
      await c.page().waitForTimeout(1500);
    }
  }
  c.controls.push('note: the table never narrowed to one row after the search');
}
