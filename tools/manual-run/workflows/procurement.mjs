// Workflow 3 · Buy two devices and prepare vendor payment (guide steps procurement-1 … procurement-15).
// Exact values: docs/testrun-2026-11-19/steps/procurement-*.md. Labels and routes are the current UI's,
// read from apps/workspace and apps/portal (p4-main), not the guide's older wording (GUIDE-DRIFT notes
// of run 2). Dev Vendor Co and its portal account Dev Vendor are shared seed records: every record this
// run creates (PR, RFQ, PO, receipt, bill, payment request) is found again by its own number or id, never
// by the vendor's name. Unique values (budget code, vendor references, serials, bank account) carry the
// run key, so runs on one stack never collide. The vendor works in a second recorded window
// (`vendor-portal`), signed in for real (password and one-time code): the portal has no Dev switcher.
//
// TR-Q1 (procurement-14): the guide expects a "no eligible approver" refusal because it assumed one
// Finance identity. The seed has Dev Finance Two (finance role, not involved in the bill), so the
// submit succeeds and Dev Finance Two is an eligible, independent approver. The step checks that the
// requester (Dev Finance) is not offered Approve and that Dev Finance Two is, and does not approve:
// procurement-15 is the VAT register, so the guide never asks for the approval. The refusal when the
// requester is the only Finance person is covered by the API unit tests, not by this run.
/* global document -- referenced inside page.evaluate callbacks, which run in the browser */
import { escapeRe, runMatch, uniqueValues } from '../lib/config.mjs';
import { realLogin, StepFailure } from '../lib/session.mjs';
import { demoFile, isPdf, pdfText } from '../lib/support.mjs';

const ROLE = {
  'Dev Procurement': 'procurement',
  'Dev Department Head': 'operations_officer',
  'Dev Accountant': 'accountant',
  'Dev Finance': 'finance',
  'Dev Finance Two': 'finance',
  'Dev Management': 'management',
  'Dev Warehouse': 'warehouse',
  'Dev Founder': 'founder',
};
const PR = /PR-\d{4}\/\d{2}-\d{5}/;
const RFQ = /RFQ-\d{4}\/\d{2}-\d{5}/;
const PO = /PO-\d{4}\/\d{2}-\d{5}/;
const GRN = /GRN-\d{4}\/\d{2}-\d{5}/;
const BILL = /BILL-\d{4}\/\d{2}-\d{5}/;
const UUID = '[0-9a-f-]{36}';
const VENDOR = 'Dev Vendor Co';
// The demo account of the chart of accounts (guide procurement-11): there is no account picker yet.
const ACCOUNT_ID = '74d53859-bdfb-49af-9fc3-784915e96a10';
// The paying entity's bank account: a raw GUID field with no list to pick from (ISSUES I-40, open).
// The seeded payment requests use this placeholder; nothing is paid from it.
const PAYING_ACCOUNT_ID = '6200d257-61ec-4e6b-a9a9-7686511b5838';

/** "NPR 1,13,000.00" and "113000.00" both contain 113000.00 once separators are removed. */
const hasAmount = (text, amount) => text.replace(/,/g, '').includes(Number(amount).toFixed(2));

/**
 * The values this run types that must not collide with another run on the same stack. The guide's
 * fixed values (BOS-DEMO-DEVICES, BOS-DEMO-VI-01, 000000001717 …) get the run key appended; the
 * bank account number is 12 digits hashed from the run key, so its last four differ between runs
 * (one run key in 10,000 shares them; the account name carries the run key to tell them apart).
 */
export function procurementValues(runKey) {
  const u = uniqueValues(runKey);
  const digits = u.pan.slice(1); // 8 digits hashed from the run key
  return {
    budgetCode: `BOS-DEMO-DEVICES-${runKey}`,
    justification: `BOS Demo — two serialized devices for service delivery.${u.suffix}`,
    quoteRef: `BOS-DEMO-VQ-01-${runKey}`,
    invoiceNo: `BOS-DEMO-VI-01-${runKey}`,
    serials: [`BOS-DEMO-SN-001-${runKey}`, `BOS-DEMO-SN-002-${runKey}`],
    bankName: 'Demo Bank',
    bankAccountName: `${VENDOR}${u.suffix}`,
    bankAccountNumber: `0000${digits}`,
    bankLast4: digits.slice(-4),
  };
}

/**
 * What procurement-13 does with the vendor's bank accounts, from the list on the vendor page
 * (`{ status, accountName, last4 }` per account, status as the badge reads). Only this run's account
 * (its account name carries the run key) is ever proposed or verified.
 * @returns {{ action: 'propose' | 'verify' | 'done' } | { action: 'fail', reason: string }}
 */
export function bankAccountPlan(accounts, { accountName, last4 }) {
  const mine = accounts.filter((a) => a.accountName === accountName);
  if (mine.length > 1)
    return {
      action: 'fail',
      reason: `${mine.length} bank accounts carry this run's account name; check them by hand`,
    };
  if (!mine.length) return { action: 'propose' };
  const [a] = mine;
  if (a.last4 !== last4)
    return {
      action: 'fail',
      reason: `this run's account ends in ${a.last4}, not ${last4}; check it by hand`,
    };
  if (a.status === 'Verified, in use') return { action: 'done' };
  if (a.status === 'Awaiting verification') return { action: 'verify' };
  // Retired (a later verification replaced it) or Rejected: a payment would go elsewhere.
  return {
    action: 'fail',
    reason: `this run's bank account is ${a.status}; use a new label`,
  };
}

/** RFC 4180 cells of a CSV text (quoted cells, doubled quotes, CRLF or LF, a leading BOM). */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  const src = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  if (cell !== '' || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

const VAT_HEADER = [
  'PAN',
  'Vendor',
  'Invoice number',
  'Invoice date (BS)',
  'Invoice date (AD)',
  'Taxable amount (NPR)',
  'VAT (NPR)',
];

/**
 * The exported purchase VAT register's row for one vendor invoice number (exact match; the Total row
 * and every other run's rows are ignored).
 * @returns {{ ok: true, row: { pan: string, vendor: string, invoiceNo: string, taxable: string,
 *   vat: string } } | { ok: false, reason: string }}
 */
export function vatCsvRow(csv, invoiceNo) {
  const [header, ...rows] = parseCsv(csv);
  if (!header || header.join('|') !== VAT_HEADER.join('|'))
    return { ok: false, reason: `unexpected header: ${(header ?? []).join(', ')}` };
  const hits = rows.filter((r) => r[2] === invoiceNo);
  if (hits.length !== 1)
    return { ok: false, reason: `${hits.length} rows carry invoice ${invoiceNo}` };
  const [pan, vendor, no, , , taxable, vat] = hits[0];
  return { ok: true, row: { pan, vendor, invoiceNo: no, taxable, vat } };
}

export function workflow(cfg) {
  const v = procurementValues(cfg.runKey);

  const as = async (s, name) => {
    const who = await s.switchTo(name);
    if (who)
      s.expect(
        who.roles.includes(ROLE[name]),
        `${name} has role ${ROLE[name]}`,
        who.roles.join(','),
      );
  };
  const step = (s) => s.captionText.split(' — ')[0];
  const main = (s, page = s.page) => s.text(page.getByRole('main'));
  const h1 = (p, name) => p.getByRole('heading', { level: 1, name });
  // The status badge sits beside the page's h1 (PageHeader in the workspace, the document header in
  // the portal). Scoped to that row, because words such as "Issued" or "Approved" are also fact
  // labels and approval-history entries further down the page.
  const status = (p, text) =>
    p.getByRole('heading', { level: 1 }).locator('..').getByText(text, { exact: true }).first();
  const pathOf = (url) => new URL(url, cfg.appUrl).pathname;
  const idOf = (url) => pathOf(url).split('/').pop();
  const visible = (locator) =>
    locator
      .first()
      .isVisible()
      .catch(() => false);
  /**
   * A segmented date picker (react-aria, round 5): a group named after the field whose month, day and
   * year are typed one by one. `iso` is YYYY-MM-DD.
   */
  const dateGroup = (p, label) => p.getByRole('group', { name: label, exact: true }).first();
  const fillDate = async (s, label, iso, page = s.page) => {
    const [, year, month, day, hh, mm] =
      /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?$/.exec(iso) ?? [];
    if (!year) throw new StepFailure(`Invalid ISO date "${iso}"`);
    const group = dateGroup(page, label);
    await s.hydrated(group.locator('[data-type="year"]'));
    for (const [segment, digits] of [
      ['year', year],
      ['month', month],
      ['day', day],
    ]) {
      const seg = group.locator(`[data-type="${segment}"]`).first();
      await seg.click();
      await seg.pressSequentially(digits);
    }
    const got = await readDate(group);
    s.expect(got === iso.slice(0, 10), `${label} is ${iso.slice(0, 10)}`, got);
    if (hh) {
      // A date and time picker has a second group, "<label> Time", beside the date: hour and minute
      // (plus AM/PM on a 12-hour clock). Segments are typed by data-type, so the order does not matter.
      const time = page.getByRole('group', { name: `${label} Time`, exact: true }).first();
      await s.hydrated(time.locator('[data-type="hour"]'));
      const twelve = (await time.locator('[data-type="dayPeriod"]').count()) > 0;
      const hour = twelve ? String(((Number(hh) + 11) % 12) + 1).padStart(2, '0') : hh;
      const clock = [
        ['hour', hour],
        ['minute', mm],
        ...(twelve ? [['dayPeriod', Number(hh) >= 12 ? 'P' : 'A']] : []),
      ];
      for (const [segment, digits] of clock) {
        const seg = time.locator(`[data-type="${segment}"]`).first();
        await seg.click();
        await seg.pressSequentially(digits);
      }
      const shown = (await time.innerText()).replace(/\s+/g, ' ');
      s.expect(
        new RegExp(`${hour}\\s*:\\s*${mm}`).test(shown),
        `${label} time is ${hh}:${mm}`,
        shown,
      );
    }
  };
  /** The YYYY-MM-DD a segmented date picker shows ('' while a segment is empty). */
  const readDate = async (group) => {
    const part = async (t) =>
      (await group.locator(`[data-type="${t}"]`).first().innerText()).trim();
    const [y, m, d] = [await part('year'), await part('month'), await part('day')];
    return /^\d+$/.test(y + m + d)
      ? `${y.padStart(4, '0')}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`
      : '';
  };

  /**
   * The route steps of an Approval or Commitment approval panel. Round 5 added a "Who acted" list
   * (its own section) inside the panel; its entries are not steps.
   */
  const approvalSteps = (region) =>
    region.locator(
      'xpath=.//li[not(ancestor::section[@aria-labelledby="approval-actions-title"])]',
    );
  const openUrl = (s, key, ready) => s.goto(s.need(key), ready);
  const headingNumber = async (s, re) => {
    // Round 5: a route shows a loading skeleton with a plain h1 first; wait for the numbered heading.
    await s.page
      .getByRole('heading', { level: 1, name: re })
      .first()
      .waitFor({ state: 'visible', timeout: 60000 })
      .catch(() => {});
    const m = re.exec(await s.page.getByRole('heading', { level: 1 }).first().innerText());
    if (!m) throw new StepFailure(`The page heading has no ${re.source} number`);
    return m[0];
  };

  /**
   * Reloads `page` (plain GETs) until `locator` shows, up to `tries` times `everyMs`. With
   * `waitFirstMs`, it first waits that long in place: right after a submit the page may still be
   * saving, and a reload then could lose or repeat the action.
   */
  const reloadUntil = async (
    s,
    locator,
    tries = 12,
    everyMs = 10000,
    { page = s.page, waitFirstMs = 0 } = {},
  ) => {
    if (waitFirstMs)
      await locator
        .first()
        .waitFor({ state: 'visible', timeout: waitFirstMs })
        .catch(() => {});
    for (let i = 0; i < tries && !(await visible(locator)); i++) {
      await s.pause(everyMs);
      await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
      await locator
        .first()
        .waitFor({ state: 'visible', timeout: 5000 })
        .catch(() => {});
    }
    return visible(locator);
  };

  /**
   * A confirmation dialog of the procurement and payables pages: the trigger (looked up in <main>,
   * since the confirm button often has the same name), the confirm inside the dialog, then the
   * dialog's Done, which reloads the page to the new status. The confirm is clicked once.
   */
  const actionDialog = async (s, trigger, dialogName, confirm, timeout = 120000) => {
    await s.click(
      s.page.getByRole('main').getByRole('button', { name: trigger, exact: true }),
      trigger,
    );
    const d = s.page.getByRole('dialog', { name: dialogName });
    await s.see(d, `the "${trigger}" dialog`);
    await s.pause(400);
    await d.getByRole('button', { name: confirm, exact: true }).click();
    const done = d.getByRole('button', { name: 'Done', exact: true });
    // Round 5: once the action lands, the page behind can re-render with the new status and take the
    // dialog (and its Done) with it. Either ending is a success; the page is reloaded to the new status.
    const ended = await Promise.race([
      done
        .waitFor({ state: 'visible', timeout })
        .then(() => 'done')
        .catch(() => 'timeout'),
      d
        .waitFor({ state: 'detached', timeout })
        .then(() => 'closed')
        .catch(() => 'timeout'),
    ]);
    if (ended === 'timeout') await s.see(done, `${trigger} succeeded (Done)`, 1000);
    if (ended === 'done') {
      await s.pause(600);
      await Promise.all([s.page.waitForEvent('load', { timeout: cfg.navTimeout }), done.click()]);
    } else {
      s.checks.push(`note: the ${trigger} dialog closed by itself; reloading to the new status`);
      await s.page.reload({ waitUntil: 'load', timeout: cfg.navTimeout });
    }
    s.checks.push(`confirmed ${trigger}`);
  };

  /**
   * Inbox → this run's row (matched by its unique number) → Approve with a comment; as in
   * sales.mjs. Without a waiting row, `isDone(s)` decides: true means the record is already past this
   * approval (an earlier attempt approved it), otherwise the step fails rather than approve twice.
   */
  const approve = async (s, persona, match, comment, isDone) => {
    await as(s, persona);
    await s.caption(`${step(s)} — ${persona}: Inbox → approve`);
    // Round 5: the inbox is a searchable list of links (the "Waiting approvals" table is gone), as in sales.mjs.
    const q = (match.match(/[A-Z]{2,3}-\d{4}\/\d{2}-\d{5}/) ?? [match])[0];
    await s.goto(`/inbox?q=${encodeURIComponent(q)}`, (p) =>
      p.getByRole('heading', { name: 'Inbox', exact: true }),
    );
    const row = s.page.locator('main a[href^="/inbox/"]').filter({ hasText: runMatch(match) });
    for (let i = 0; i < 8 && !(await visible(row)); i++) {
      await s.page.waitForTimeout(5000);
      await s.page.reload({ waitUntil: 'domcontentloaded' });
    }
    if (!(await visible(row))) {
      if (isDone && (await isDone(s))) {
        s.checks.push(
          `note: no waiting row for ${persona}; ${match} is already past this approval`,
        );
        return;
      }
      throw new StepFailure(
        `${persona} has no waiting approval for ${match}, and it is not approved yet. An earlier ` +
          'attempt may have approved it without recording that; resume from the next step.',
      );
    }
    s.expect(
      (await row.count()) === 1,
      `exactly one inbox row for ${match}`,
      `${await row.count()}`,
    );
    await s.see(row, `${persona}'s inbox row for ${match}`);
    await s.click(row.first(), 'the inbox row');
    await s.page.waitForURL(new RegExp(`/inbox/${UUID}`));
    await s.pause();
    const dialog = s.page.getByRole('dialog', { name: 'Approve request' });
    const confirmApprove = dialog.getByRole('button', { name: 'Approve', exact: true });
    // A dialog lost to a dev-server rebuild reload is opened again (at most three times, each
    // noted); the confirm is clicked once. See sales.mjs for why the opener is looked up in <main>.
    const opener = s.page.getByRole('main').getByRole('button', { name: 'Approve', exact: true });
    for (let attempt = 1; ; attempt++) {
      if (attempt > 1 && (await visible(dialog))) {
        await dialog
          .getByRole('button', { name: 'Cancel', exact: true })
          .click({ timeout: 5000 })
          .catch(() => s.page.keyboard.press('Escape'));
        const closed = await dialog
          .waitFor({ state: 'hidden', timeout: 10000 })
          .then(() => true)
          .catch(() => false);
        if (!closed)
          throw new StepFailure(
            'The Approve request dialog stayed open after Cancel; not retrying, so the confirm ' +
              'is not clicked by mistake',
          );
      }
      await s.click(opener, attempt === 1 ? 'Approve' : 'Approve again');
      const ready = await dialog
        .waitFor({ state: 'visible', timeout: 20000 })
        .then(() => dialog.getByLabel('Comment (optional)', { exact: true }).fill(comment))
        .then(() => s.pause(400))
        .then(() => confirmApprove.waitFor({ state: 'visible', timeout: 5000 }))
        .then(() => true)
        .catch(() => false);
      if (ready) break;
      if (attempt === 3)
        throw new StepFailure('The Approve request dialog closed or never opened, three times');
      s.checks.push('note: the Approve request dialog was lost (page reloaded); opening it again');
      await s.page.waitForLoadState('load').catch(() => {});
    }
    await s.click(confirmApprove, 'confirm Approve');
    await s.page.waitForURL(/\/inbox\?decided=approve/, { timeout: cfg.navTimeout });
    const who = await s.whoami();
    s.expect(
      who && who.roles.includes(ROLE[persona]),
      `${persona} is still signed in after Approve`,
    );
  };

  /** One approval per approver per record: approvers already done are kept in state[progressKey]. */
  const approveOnce = async (s, progressKey, persona, match, comment, isDone) => {
    const done = s.state[progressKey] ?? [];
    if (done.includes(persona)) {
      s.checks.push(`note: ${persona} approved ${match} in an earlier attempt of this run`);
      return;
    }
    await approve(s, persona, match, comment, isDone);
    s.record(progressKey, [...done, persona]);
  };

  /** Whether the opened page's status badge is one of `texts`. */
  const statusIn = async (s, texts, page = s.page) => {
    for (const t of texts) if (await visible(status(page, t))) return t;
    return null;
  };

  /**
   * The vendor's own window on the portal, signed in for real as Dev Vendor. Opened on first use (a
   * resumed run starts without it) and signed in again when the portal has sent it to the sign-in
   * page (run 2 saw a mid-run bounce). Everything the vendor does happens in this window.
   */
  const vendorPage = async (s) => {
    const home = `${cfg.portalUrl}/vendor`;
    const account = (p) => h1(p, 'Your account');
    const loginField = (p) => p.locator('input[name=loginName]');
    if (!s.vendorWindow) {
      await s.caption(`${step(s)} — Dev Vendor signs in to the vendor portal in its own window`);
      const { page } = await s.openWindow('vendor-portal');
      s.vendorWindow = page;
      await realLogin(s, page, 'vendor', home);
    }
    const page = s.vendorWindow;
    await s.goto(home, (p) => account(p).or(loginField(p)), { page });
    if (await visible(loginField(page))) {
      s.checks.push('note: the vendor portal asked to sign in again; signing in');
      await realLogin(s, page, 'vendor', home);
      await s.goto(home, account, { page });
    }
    await s.see(account(page), 'the vendor portal, signed in as Dev Vendor');
    return page;
  };

  /** Opens a portal list and the row link of this run's record (by its id). */
  const portalOpen = async (s, vp, listPath, heading, href) => {
    await s.goto(`${cfg.portalUrl}${listPath}`, (p) => h1(p, heading), { page: vp });
    const link = vp.locator(`main a[href="${href}"]`);
    await s.see(link, `this run's row in ${heading}`);
    await s.click(link, `this run's row in ${heading}`);
    await vp.waitForURL((u) => new URL(u).pathname === href, { timeout: cfg.navTimeout });
  };

  /** Every purchase order on the Purchase orders list (first page, newest first): number, id, row text. */
  const listedOrders = async (s) => {
    await s.goto('/procurement/orders?rows=100', (p) => h1(p, 'Purchase orders'));
    const rows = s.page.locator('main tbody tr');
    await s.see(rows.first(), 'the purchase orders list loaded');
    return (
      await rows.evaluateAll((trs) =>
        trs.map((tr) => ({
          text: tr.innerText.replace(/\s+/g, ' ').trim(),
          href: tr.querySelector('a[href^="/procurement/orders/"]')?.getAttribute('href') ?? '',
        })),
      )
    )
      .map((r) => ({ ...r, number: PO.exec(r.text)?.[0], id: r.href.split('/').pop() }))
      .filter((r) => r.number && r.id);
  };

  /**
   * The draft purchase order the commitment approval created. Round 5: the request's page lists
   * only orders that are no longer drafts (the API leaves drafts out), and the order does not link
   * its request, so the order is the one on the Purchase orders list that was not there before the
   * approvals (`poBaseline`, taken by procurement-7). Without a baseline (a resumed run), it is the
   * only Draft of this vendor at the approved total. Anything else fails rather than guess.
   */
  const orderOfRequest = async (s) => {
    const rows = await listedOrders(s);
    const baseline = s.state.poBaseline;
    const mine = baseline
      ? rows.filter((r) => !baseline.includes(r.number))
      : rows.filter(
          (r) => /\bDraft\b/.test(r.text) && r.text.includes(VENDOR) && hasAmount(r.text, 113000),
        );
    if (mine.length !== 1)
      throw new StepFailure(
        `Expected one new purchase order for ${s.state.prNumber}, found ${mine.length}` +
          (mine.length ? `: ${mine.map((r) => r.number).join(', ')}` : '') +
          `; check the Purchase orders list by hand (listed: ${
            rows.map((r) => `${r.number} ${r.text.slice(0, 90)}`).join(' | ') || 'none'
          }; baseline: ${baseline ? baseline.join(', ') : 'none'})`,
      );
    return { number: mine[0].number, id: mine[0].id, text: mine[0].text };
  };

  return {
    name: 'procurement',
    title: 'Buy two devices and prepare vendor payment',
    // The origins whose certificates are checked before launch: the workspace, the vendor portal
    // and the sign-in service the vendor signs in through.
    origins: ['app', 'portal', 'auth'],
    steps: [
      {
        id: 'procurement-1',
        title: 'Raise the purchase request',
        timeoutMs: 420000,
        async run(s) {
          await as(s, 'Dev Procurement');
          // Retry-safe: an earlier attempt's request (recorded right after Save draft) is reused,
          // and Submit is clicked only while it is a Draft.
          if (!s.state.prUrl) {
            await s.goto('/procurement/requests/new', (p) => h1(p, 'New purchase request'));
            await s.page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
            await s.caption('procurement-1 — fill the request (Emergency stays off)');
            await fillDate(s, 'Needed by', '2030-12-31');
            await s.choose(s.select('departmentId', { byName: true }), 'Operations');
            await s.choose(s.select('costCenterId', { byName: true }), /^GENERAL\s*·\s*General$/);
            await s.fill('Budget code', v.budgetCode);
            const currency = s.select('currency', { byName: true });
            if (!/NPR/.test(await currency.first().innerText())) await s.choose(currency, 'NPR');
            await s.fill('Delivery location', 'Demo office, Kathmandu');
            await s.fill('Why is this needed?', v.justification);
            await s.fill('Description', 'BOS Demo serialized device');
            await s.fill(
              'Specification (optional)',
              'Demo device; serial number required at receipt.',
            );
            await s.fill('Unit', 'pcs');
            await s.fill('Quantity', '2');
            await s.fill('Estimated unit price', '60000.00');
            const serials = s.page.getByRole('checkbox', {
              name: 'Record serial numbers at receipt',
              exact: true,
            });
            await s.hydrated(serials);
            await serials.check();
            const type = s.select('requestType', { byName: true });
            const typeText = await type.first().innerText();
            s.expect(
              /\bGoods\b/.test(typeText) && !/service/i.test(typeText),
              'Type keeps its default, Goods',
              typeText,
            );
            s.expect(
              !(await s.page
                .getByRole('checkbox', { name: 'This is an emergency purchase' })
                .isChecked()),
              'Emergency is off',
            );
            await s.pause();
            await s.click(s.button('Save draft'), 'Save draft');
            await s.page.waitForURL(new RegExp(`/procurement/requests/${UUID}\\?created=1`), {
              timeout: cfg.navTimeout,
            });
            s.record('prUrl', pathOf(s.page.url()));
            await s.seeText('The draft was saved.');
          } else {
            s.checks.push('note: reusing the purchase request an earlier attempt saved');
            await openUrl(s, 'prUrl', (p) => p.getByRole('heading', { level: 1 }));
          }
          const total = await main(s);
          s.expect(hasAmount(total, 120000), 'Estimated total is NPR 120,000');

          if (await visible(status(s.page, 'Draft'))) {
            await s.caption('procurement-1 — reopen Edit request and confirm the saved values');
            await s.click(s.link('Edit request'), 'Edit request');
            await s.page.waitForURL(/\/edit$/, { timeout: cfg.navTimeout });
            await s.see(s.field('Budget code'), 'the edit form');
            const val = (label) => s.field(label).first().inputValue();
            s.expect(
              (await readDate(dateGroup(s.page, 'Needed by'))) === '2030-12-31',
              'Needed by is 2030-12-31',
            );
            s.expect((await val('Budget code')) === v.budgetCode, `Budget code is ${v.budgetCode}`);
            s.expect(
              (await val('Delivery location')) === 'Demo office, Kathmandu',
              'Delivery location is kept',
            );
            s.expect((await val('Why is this needed?')) === v.justification, 'the reason is kept');
            const qty = await val('Quantity');
            s.expect(Number(qty) === 2, 'Quantity is 2', qty);
            if (qty !== '2')
              s.finding(`Edit request shows Quantity "${qty}" for a quantity entered as 2`, 'low');
            s.expect(
              await s.page
                .getByRole('checkbox', { name: 'Record serial numbers at receipt' })
                .isChecked(),
              'Record serial numbers at receipt stays checked',
            );
            await openUrl(s, 'prUrl', (p) => p.getByRole('heading', { level: 1 }));
            await s.caption('procurement-1 — Submit for approval');
            await s.click(
              s.page
                .getByRole('main')
                .getByRole('button', { name: 'Submit for approval', exact: true }),
              'Submit for approval',
            );
            // Round 5: Submit asks "Submit for approval?" first; the confirm shares the opener's name.
            const confirm = s.page.getByRole('dialog', { name: 'Submit for approval?' });
            await s.see(confirm, 'the Submit for approval? dialog');
            await s.pause(400);
            await confirm.getByRole('button', { name: 'Submit for approval', exact: true }).click();
          } else s.checks.push('note: the request was submitted by an earlier attempt');
          await s.see(status(s.page, 'Awaiting approval'), 'status Awaiting approval', 90000);
          const steps = approvalSteps(
            s.page.getByRole('region', { name: 'Approval', exact: true }),
          );
          s.expect(
            (await steps.count()) === 1,
            'exactly one approval step',
            `${await steps.count()}`,
          );
          s.expect(
            /head of the requesting department/.test(await s.text(steps.first())),
            'the step is the department head',
          );
          s.record('prNumber', await headingNumber(s, PR));
        },
      },
      {
        id: 'procurement-2',
        title: 'Department approval',
        timeoutMs: 420000,
        async run(s) {
          const pr = s.need('prNumber');
          // The inbox row names the PR number, not the budget code (run-2 GUIDE-DRIFT).
          await approveOnce(
            s,
            'prApprovals',
            'Dev Department Head',
            pr,
            'Two demo devices approved for Operations.',
            async (x) => {
              await as(x, 'Dev Procurement');
              await openUrl(x, 'prUrl', (p) => h1(p, pr));
              return (await statusIn(x, ['Awaiting approval', 'Draft', 'Returned'])) === null;
            },
          );
          await as(s, 'Dev Procurement');
          await openUrl(s, 'prUrl', (p) => h1(p, pr));
          if (await visible(s.link('Open RFQ'))) {
            s.checks.push('note: the RFQ was opened by an earlier attempt');
            return;
          }
          await s.see(status(s.page, 'Department approved'), 'status Department approved');
          await s.click(s.link('Start RFQ'), 'Start RFQ');
          await s.page.waitForURL(/\/procurement\/rfqs\/new\?pr=/, { timeout: cfg.navTimeout });
          const picked = s.select('purchaseRequestId', { byName: true });
          await s.see(picked, 'the Purchase request field');
          s.expect(
            (await picked.first().innerText()).includes(pr),
            `the RFQ form keeps ${pr} selected`,
            await picked.first().innerText(),
          );
        },
      },
      {
        id: 'procurement-3',
        title: 'Open the RFQ',
        async run(s) {
          await as(s, 'Dev Procurement');
          const pr = s.need('prNumber');
          // Retry-safe: the request links its RFQ once opened, so an RFQ an earlier attempt opened
          // (recorded or not) is adopted from there instead of opening a second one.
          if (!s.state.rfqUrl) {
            await openUrl(s, 'prUrl', (p) => h1(p, pr));
            const open = s.link('Open RFQ');
            if (await visible(open)) {
              s.record('rfqUrl', pathOf(await open.first().getAttribute('href')));
              s.checks.push('note: adopting the RFQ an earlier attempt opened');
            } else {
              await s.goto(`/procurement/rfqs/new?pr=${idOf(s.state.prUrl)}`, (p) =>
                dateGroup(p, 'Quotation deadline'),
              );
              await s.page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
              await fillDate(s, 'Quotation deadline', '2030-12-01T17:00');
              const vendor = s.page
                .getByRole('group', { name: /Invited vendors/ })
                .getByRole('checkbox', { name: VENDOR, exact: true });
              await s.hydrated(vendor);
              await vendor.check();
              await s.see(
                s.page.getByText('Invited vendors (1 chosen)'),
                'Invited vendors (1 chosen)',
              );
              await s.pause();
              await s.click(s.button('Open RFQ'), 'Open RFQ');
              await s.page.waitForURL(new RegExp(`/procurement/rfqs/${UUID}\\?created=1`), {
                timeout: cfg.navTimeout,
              });
              s.record('rfqUrl', pathOf(s.page.url()));
            }
          }
          await openUrl(s, 'rfqUrl', (p) => p.getByRole('heading', { level: 1 }));
          s.record('rfqNumber', await headingNumber(s, RFQ));
          // The guide's "Open for quotations" is the vendor portal's wording; the staff badge reads Open.
          await s.see(status(s.page, 'Open'), 'status Open');
          await s.see(
            s.page.getByText('Invited vendors (1)', { exact: true }),
            'Invited vendors (1)',
          );
          await s.see(
            s.page
              .getByRole('region', { name: 'RFQ', exact: true })
              .getByRole('link', { name: pr }),
            `the RFQ links ${pr}`,
          );
          if (!s.state.quoteSent)
            await s.seeText('No quotation has been recorded yet.', 'no quotation exists yet');
        },
      },
      {
        id: 'procurement-4',
        title: 'Send the vendor quotation',
        timeoutMs: 480000,
        async run(s) {
          const rfqId = idOf(s.need('rfqUrl'));
          // Retry-safe: the staff RFQ page lists the submission (by this run's reference) until it is
          // converted, and the quotation after that, so a sent quotation is never sent twice.
          if (!s.state.quoteSent) {
            await as(s, 'Dev Procurement');
            await openUrl(s, 'rfqUrl', (p) => p.getByRole('heading', { level: 1 }));
            const listed = s.page
              .getByRole('table', { name: 'Vendor submissions waiting to be converted' })
              .getByRole('row')
              .filter({ hasText: v.quoteRef });
            const quoted = s.page.getByRole('table', { name: 'Quotations received' });
            if ((await visible(listed)) || (await visible(quoted))) s.record('quoteSent', true);
          }
          const vp = await vendorPage(s);
          if (s.state.quoteSent) {
            s.checks.push('note: the quotation was sent by an earlier attempt');
            return;
          }
          await s.caption('procurement-4 — Dev Vendor: Requests for quotation → this RFQ');
          await portalOpen(
            s,
            vp,
            '/vendor/rfqs',
            'Requests for quotation',
            `/vendor/rfqs/${rfqId}`,
          );
          await s.click(
            vp.getByRole('link', { name: 'Submit quotation', exact: true }),
            'Submit quotation',
          );
          await s.see(h1(vp, 'Submit a quotation'), 'the Submit a quotation form');
          await vp.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
          await s.caption('procurement-4 — attach vendor-quotation.pdf and fill the quotation');
          const file = vp.getByLabel('Your quotation', { exact: true });
          await s.hydrated(file);
          await file.setInputFiles(demoFile(cfg, 'vendor-quotation.pdf'));
          await s
            .see(
              vp.getByRole('list', { name: 'Uploaded file' }).getByText('vendor-quotation.pdf'),
              'vendor-quotation.pdf uploaded',
              90000,
            )
            .catch(async (e) => {
              // The failure screenshot is of the staff window; keep the vendor window's too.
              const alert = await vp
                .getByRole('alert')
                .first()
                .innerText({ timeout: 2000 })
                .catch(() => '(no alert)');
              await vp.screenshot({
                path: `${s.dirs.shots}/procurement-4-VENDOR.png`,
                fullPage: true,
              });
              throw new StepFailure(`${e.message} Vendor window alert: ${alert}`);
            });
          const currency = s.select('currency', { scope: vp, byName: true });
          if ((await currency.count()) && !/NPR/.test(await currency.first().innerText()))
            await s.choose(currency, 'NPR', { scope: vp });
          await s.fill(vp.getByLabel('Total of your quotation'), '113000.00');
          await s.fill(vp.getByLabel('Your reference (optional)'), v.quoteRef);
          await s.fill(vp.getByLabel('Delivery time in days (optional)'), '14');
          await s.pause();
          await s.click(
            vp.getByRole('button', { name: 'Submit quotation', exact: true }),
            'Submit quotation',
          );
          await s.see(
            vp.getByRole('status').filter({ hasText: 'We received your quotation' }),
            'the portal confirms it received the quotation',
            90000,
          );
          s.record('quoteSent', true);
          // The guide keeps the portal window open for the order and bill steps; it stays open.
          await s.caption('procurement-4 — staff side: the submission waits in the RFQ inbox');
          await as(s, 'Dev Procurement');
          await openUrl(s, 'rfqUrl', (p) => p.getByRole('heading', { level: 1 }));
          await s.see(
            s.page
              .getByRole('table', { name: 'Vendor submissions waiting to be converted' })
              .getByRole('row')
              .filter({ hasText: v.quoteRef }),
            'the submission in the staff RFQ inbox',
          );
          await s.seeText('No quotation has been recorded yet.', 'not yet a commercial quotation');
        },
      },
      {
        id: 'procurement-5',
        title: 'Convert and score the quote',
        timeoutMs: 480000,
        async run(s) {
          await as(s, 'Dev Procurement');
          await openUrl(s, 'rfqUrl', (p) => p.getByRole('heading', { level: 1 }));
          const quotes = s.page.getByRole('table', { name: 'Quotations received' });
          const ours = quotes.getByRole('row').filter({ hasText: VENDOR });
          // Retry-safe: once converted, the submission leaves the inbox table and the quotation row
          // exists; the conversion is then skipped.
          if (!s.state.quoteConverted && !(await visible(ours))) {
            const row = s.page
              .getByRole('table', { name: 'Vendor submissions waiting to be converted' })
              .getByRole('row')
              .filter({ hasText: v.quoteRef });
            const convert = row.getByRole('link', {
              name: `Convert the submission from ${VENDOR}`,
              exact: true,
            });
            await s.caption('procurement-5 — reload until the submission shows Scan passed');
            const ready = await reloadUntil(s, convert, 18, 10000);
            s.expect(
              ready,
              'the submission offers Convert (scan passed)',
              await s.text(row.first()),
            );
            await s.see(row.getByText('Scan passed', { exact: true }), 'Scan passed');
            await s.click(convert, `Convert the submission from ${VENDOR}`);
            await s.page.waitForURL(/\/quotations\/new\?submission=/, { timeout: cfg.navTimeout });
            await s.see(h1(s.page, 'Convert a vendor submission'), 'the convert form');
            await s.page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
            const include = s.page.getByRole('checkbox', { name: /^Quote line 1:/ });
            await s.hydrated(include);
            if (!(await include.isChecked())) await include.check();
            await s.fill('Quantity (line 1)', '2');
            await s.fill('Unit price (line 1)', '50000.00');
            await s.choose(s.select('lines.0.taxCodeId', { byName: true }), /VAT\s*13/);
            await s.pause();
            await s.click(s.button('Convert to quotation'), 'Convert to quotation');
            await s.page.waitForURL(/\?quoted=1/, { timeout: cfg.navTimeout });
            await s.seeText('The quotation was recorded.');
            s.record('quoteConverted', true);
          } else s.checks.push('note: the submission was converted by an earlier attempt');
          await s.see(ours, `a ${VENDOR} row in Quotations received`);
          s.expect((await ours.count()) === 1, `one ${VENDOR} quotation`, `${await ours.count()}`);
          s.expect(
            hasAmount(await s.text(ours.first()), 113000),
            'the quotation totals NPR 113,000',
          );

          await s.caption('procurement-5 — score: Delivery readiness 90');
          if (!/\b90(\.00)?\b/.test(await s.text(ours.first()))) {
            await s.fill('Criterion 1', 'Delivery readiness');
            await s.fill('Score 1 (0 to 100)', '90');
            await s.click(s.button('Save scores'), 'Save scores');
            const scored = quotes
              .getByRole('row')
              .filter({ hasText: VENDOR })
              .filter({ hasText: /\b90(\.00)?\b/ });
            s.expect(
              await reloadUntil(s, scored, 6, 5000, { waitFirstMs: 60000 }),
              'the Score column shows 90',
            );
          } else s.checks.push('note: the score was saved by an earlier attempt');

          await s.caption('procurement-5 — the vendor sees no comparison or score');
          const vp = await vendorPage(s);
          await s.goto(
            `${cfg.portalUrl}/vendor/rfqs/${idOf(s.state.rfqUrl)}`,
            (p) => h1(p, s.state.rfqNumber),
            { page: vp },
          );
          const portalText = await main(s, vp);
          // A positive anchor first: an empty text would pass the negative check below.
          s.expect(
            portalText.includes(s.state.rfqNumber),
            `the vendor page shows ${s.state.rfqNumber}`,
          );
          s.expect(
            !/Delivery readiness|Recommended|Score/.test(portalText),
            'the vendor RFQ page shows no score, comparison or recommendation',
          );
        },
      },
      {
        id: 'procurement-6',
        title: 'Recommend with the explicit sourcing exception',
        timeoutMs: 420000,
        async run(s) {
          await as(s, 'Dev Procurement');
          await openUrl(s, 'rfqUrl', (p) => p.getByRole('heading', { level: 1 }));
          const exception =
            'Single-vendor demonstration using the seeded approved supplier; no real procurement.';
          const why = 'Meets the demo specification and 14-day delivery target.';
          // Retry-safe: Recommended and the commitment panel are read before each change.
          if (!(await visible(status(s.page, 'Recommended')))) {
            await s.caption('procurement-6 — recommend without the exception first');
            await s.choose(
              s.select('vendorQuotationId', { byName: true }),
              new RegExp(`^${escapeRe(VENDOR)}, `),
            );
            await s.fill('Why this quotation', why);
            s.expect(
              (await s.field('If fewer quotations than required').inputValue()) === '',
              'the exception field is empty',
            );
            await s.click(s.button('Recommend this quotation'), 'Recommend this quotation');
            const refusal = s.page
              .getByRole('alert')
              .filter({ hasText: 'The recommendation was not saved' });
            await s.see(refusal, 'the refusal', 60000);
            s.expect(
              /fewer quotations than the minimum/i.test(await s.text(refusal.first())),
              'the refusal names the missing quotations',
              await s.text(refusal.first()),
            );
            s.expect(
              (await s.field('Why this quotation').inputValue()) === why,
              'the reason was kept',
            );
            await s.caption('procurement-6 — add the exception and recommend again');
            await s.fill('If fewer quotations than required', exception);
            await s.click(s.button('Recommend this quotation'), 'Recommend this quotation again');
            await s.page.waitForURL(/\?recommended=1/, { timeout: cfg.navTimeout });
            await s.seeText('The quotation was recommended.');
          } else s.checks.push('note: the quotation was recommended by an earlier attempt');
          await s.see(status(s.page, 'Recommended'), 'the RFQ is Recommended');
          await s.seeText(exception, 'the recorded exception (Why fewer quotations)');
          await s.seeText(why, 'the recorded reason (Why this one)');

          const commitment = s.page.getByRole('region', {
            name: 'Commitment approval',
            exact: true,
          });
          if (!(await visible(commitment))) {
            await s.caption('procurement-6 — Submit for commitment approval');
            await s.click(
              s.button('Submit for commitment approval'),
              'Submit for commitment approval',
            );
            const dialog = s.page.getByRole('dialog', { name: 'Submit for commitment approval?' });
            await s.see(dialog, 'the confirmation dialog');
            await s.pause(400);
            await dialog.getByRole('button', { name: 'Submit', exact: true }).click();
            await s.see(commitment, 'the Commitment approval panel', 90000);
          } else s.checks.push('note: the commitment was submitted by an earlier attempt');
          const items = approvalSteps(commitment);
          s.expect((await items.count()) === 3, 'three commitment steps', `${await items.count()}`);
          const texts = await items.allInnerTexts();
          s.expect(
            /an Accountant checks the recommended quotation/.test(texts[0]),
            'step 1 is the Accountant',
            texts[0],
          );
          s.expect(/Finance commits the budget/.test(texts[1]), 'step 2 is Finance', texts[1]);
          // Step 3 is Management's "above NPR 100,000" rule; the screen names the rule, not the role.
          s.expect(
            /Commitment of NPR 1,?13,?000\.00 is above NPR 1,?00,?000\.00/.test(texts[2]),
            'step 3 is the commitment above NPR 100,000 (Management)',
            texts[2],
          );
        },
      },
      {
        id: 'procurement-7',
        title: 'Approve the commitment',
        timeoutMs: 600000,
        async run(s) {
          const rfq = s.need('rfqNumber');
          const pastApproval = async (x) => {
            await as(x, 'Dev Procurement');
            await openUrl(x, 'rfqUrl', (p) => p.getByRole('heading', { level: 1 }));
            return /Approval approved/.test(
              await x.text(
                x.page.getByRole('region', { name: 'Commitment approval', exact: true }),
              ),
            );
          };
          // The new order is told from the older ones by the list as it was before the approvals.
          if (!s.state.poBaseline && !(s.state.commitApprovals ?? []).length)
            s.record(
              'poBaseline',
              (await listedOrders(s)).map((r) => r.number),
            );
          // The inbox row reads "Commitment RFQ-… (PR-…)": matched by this run's RFQ number.
          const approvers = [
            ['Dev Accountant', 'Demo sourcing and quote arithmetic checked.'],
            ['Dev Finance', 'Demo procurement budget approved.'],
            ['Dev Management', 'Demo commitment above NPR 100000 approved.'],
          ];
          for (const [persona, comment] of approvers)
            await approveOnce(
              s,
              'commitApprovals',
              persona,
              `Commitment ${rfq}`,
              comment,
              pastApproval,
            );

          await as(s, 'Dev Procurement');
          await openUrl(s, 'rfqUrl', (p) => p.getByRole('heading', { level: 1 }));
          const commitment = s.page.getByRole('region', {
            name: 'Commitment approval',
            exact: true,
          });
          await s.see(commitment.getByText(/Approval approved/), 'the commitment is approved');
          const items = await approvalSteps(commitment).allInnerTexts();
          s.expect(
            items.length === 3 && items.every((t) => /Approved/.test(t)),
            'all three steps Approved, no Founder step',
            items.join(' | '),
          );
          await s.caption('procurement-7 — the approval created one draft purchase order');
          const po = await orderOfRequest(s);
          s.expect(po !== null, 'the request lists its purchase order');
          s.expect(
            /Draft|Issued|received/.test(po.text),
            'the order is a draft (or later)',
            po.text,
          );
          s.expect(po.text.includes(VENDOR), `the order is for ${VENDOR}`, po.text);
          s.record('poNumber', po.number);
          s.record('poUrl', `/procurement/orders/${po.id}`);
        },
      },
      {
        id: 'procurement-8',
        title: 'Issue the purchase order and view its PDF',
        timeoutMs: 600000,
        async run(s) {
          await as(s, 'Dev Procurement');
          const po = s.need('poNumber');
          await s.goto('/procurement/orders', (p) => h1(p, 'Purchase orders'));
          await s.see(
            s.page.getByRole('main').getByText(po, { exact: true }),
            `${po} in Purchase orders`,
          );
          await openUrl(s, 'poUrl', (p) => h1(p, po));
          // Retry-safe: Issue only while the order is a Draft.
          if (await visible(status(s.page, 'Draft'))) {
            await s.caption('procurement-8 — Issue purchase order (renders the PDF, ~30 s)');
            await actionDialog(
              s,
              'Issue purchase order',
              `Issue ${po}`,
              'Issue purchase order',
              180000,
            );
          } else s.checks.push('note: the order was issued by an earlier attempt');
          await s.see(status(s.page, 'Issued'), 'status Issued', 60000);
          const text = await main(s);
          s.expect(hasAmount(text, 113000), 'the order totals NPR 113,000');
          const lines = await s.text(s.page.getByRole('table', { name: 'Purchase order lines' }));
          // The Ordered cell reads "<quantity> <unit>" (qtyText), e.g. "2 pcs".
          s.expect(/\b2(\.0+)? pcs\b/.test(lines), 'the line orders 2 pcs', lines);
          await s.caption('procurement-8 — wait for the version 1 PDF, then open it');
          // Round 5: the version row's Download is a button (named "Download of version 1").
          const download = s.page
            .getByRole('button', { name: 'Download of version 1', exact: true })
            .or(s.page.getByRole('link', { name: 'Download of version 1', exact: true }));
          s.expect(
            await reloadUntil(s, download, 18, 10000),
            'version 1 has its PDF (Download of version 1)',
          );
          await s.see(
            s.page.getByRole('table', { name: 'Purchase order versions' }).getByText('Current'),
            'version 1 is kept as the current version',
          );
          const view = s.page.getByRole('button', { name: /View PDF of version 1/ });
          if (await visible(view)) {
            await s.click(view, 'View PDF of version 1');
            await s.see(s.page.getByRole('dialog'), 'the PDF viewer');
            await s.pause(1500);
            await s.page.keyboard.press('Escape');
          }
          const staff = await s.download(download, s.dirs.files);
          s.expect(isPdf(staff.bytes), 'the staff download is a PDF');
          s.record('poPdf', staff.path);
          const staffPdf = pdfText(staff.path);
          if (staffPdf === null)
            s.checks.push('note: pdftotext is not installed; PDF text not checked');
          else s.expect(hasAmount(staffPdf, 113000), 'the PDF total is NPR 113,000');

          await s.caption(
            'procurement-8 — Dev Vendor: Purchase orders → this order → Download PDF',
          );
          const vp = await vendorPage(s);
          const poId = idOf(s.state.poUrl);
          await portalOpen(
            s,
            vp,
            '/vendor/purchase-orders',
            'Your purchase orders',
            `/vendor/purchase-orders/${poId}`,
          );
          await s.see(
            vp.getByRole('table', { name: /^Items on / }),
            'the order lines in the portal',
          );
          await s.see(status(vp, 'Issued'), 'the vendor sees it Issued');
          const vendorFile = await s.download(
            vp.getByRole('link', { name: 'Download', exact: true }),
            s.dirs.files,
          );
          s.expect(isPdf(vendorFile.bytes), 'the vendor download is a PDF');
          const vendorPdf = pdfText(vendorFile.path);
          if (vendorPdf !== null) {
            s.expect(hasAmount(vendorPdf, 113000), 'the vendor PDF totals NPR 113,000');
            s.expect(
              !/Delivery readiness|Single-vendor demonstration|Meets the demo specification/.test(
                vendorPdf,
              ),
              'the vendor PDF carries no internal scores or sourcing notes',
            );
          }
        },
      },
      {
        id: 'procurement-9',
        title: 'Receive the serialized devices',
        timeoutMs: 480000,
        async run(s) {
          await as(s, 'Dev Warehouse');
          const po = s.need('poNumber');
          const poId = idOf(s.need('poUrl'));
          // The warehouse holds no purchase-order grant (procurement.po.issue), so the order's status
          // is read on its receipts page, whose header carries the order's badge.
          const orderReceipts = () =>
            s.goto(`/procurement/receipts?po=${poId}`, (p) => h1(p, `Receipts for ${po}`));
          // Retry-safe: a receipt an earlier attempt saved is recorded at once; one it saved without
          // recording is found on the order's receipts page, and two of them fail the step. The
          // lookup counts only once that page shows its receipts table or its empty state.
          if (!s.state.receiptUrl) {
            await orderReceipts();
            const table = s.page.getByRole('table', { name: 'Receipts of this purchase order' });
            const none = s.page.getByRole('heading', { name: 'Nothing has been received yet.' });
            await s.see(table.or(none), `the receipts of ${po} loaded`);
            const found = (await visible(table))
              ? [
                  ...new Set(
                    (
                      await table
                        .locator('a[href^="/procurement/receipts/"]')
                        .evaluateAll((links) => links.map((a) => a.getAttribute('href')))
                    ).filter((h) => new RegExp(`^/procurement/receipts/${UUID}$`).test(h)),
                  ),
                ]
              : [];
            if (found.length > 1)
              throw new StepFailure(
                `${po} has ${found.length} receipts already (${found.join(', ')}); check them by hand`,
              );
            if (found.length === 1) {
              s.record('receiptUrl', found[0]);
              s.checks.push('note: adopting the receipt an earlier attempt saved');
            }
          }
          if (!s.state.receiptUrl) {
            await s.goto('/procurement/receipts', (p) => h1(p, 'Receipts'));
            const add = s.page.getByRole('link', { name: `New receipt for ${po}`, exact: true });
            await s.click(add, `New receipt for ${po}`);
            await s.see(h1(s.page, 'New receipt'), 'the New receipt form');
            await s.page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
            const on = await s.field('Received on').inputValue();
            s.expect(/^\d{4}-\d{2}-\d{2}$/.test(on), 'Received on has its default date', on);
            await s.caption('procurement-9 — Save draft receipt with no quantities first');
            await s.click(s.button('Save draft receipt'), 'Save draft receipt (empty)');
            await s.seeText('Enter a quantity on at least one line.', 'the validation message');
            s.expect(/\/procurement\/receipts\/new/.test(s.page.url()), 'nothing was saved');
            await s.caption('procurement-9 — 2 pcs, two serials, Demo shelf A');
            await s.fill('Quantity received (pcs) (line 1)', '2');
            await s.fill('Serial numbers (line 1)', v.serials.join('\n'));
            await s.fill('Location', 'Demo shelf A');
            await s.pause();
            await s.click(s.button('Save draft receipt'), 'Save draft receipt');
            await s.page.waitForURL(new RegExp(`/procurement/receipts/${UUID}(\\?|$)`), {
              timeout: cfg.navTimeout,
            });
            s.record('receiptUrl', pathOf(s.page.url()));
          }
          await openUrl(s, 'receiptUrl', (p) => p.getByRole('heading', { level: 1 }));
          const grn = await headingNumber(s, GRN);
          s.record('receiptNumber', grn);
          if (await visible(status(s.page, 'Draft'))) {
            // A draft does not count as received: the order is still Issued.
            await orderReceipts();
            await s.see(
              status(s.page, 'Issued'),
              'the order is still Issued while the receipt is a draft',
            );
            await openUrl(s, 'receiptUrl', (p) => h1(p, grn));
            await s.caption('procurement-9 — Confirm receipt');
            await actionDialog(s, 'Confirm receipt', `Confirm ${grn}`, 'Confirm receipt');
          } else s.checks.push('note: the receipt was confirmed by an earlier attempt');
          await s.see(status(s.page, 'Confirmed'), 'the receipt is Confirmed', 60000);
          const details = s.page.locator('main details');
          await s.click(
            details.locator('summary').filter({ hasText: '2 serial numbers' }),
            'the serial details',
          );
          const listed = details.getByRole('listitem');
          s.expect((await listed.count()) === 2, 'exactly two serials', `${await listed.count()}`);
          for (const serial of v.serials)
            await s.see(listed.filter({ hasText: serial }), `serial ${serial}`);
          await orderReceipts();
          await s.see(status(s.page, 'Fully received'), 'the order is Fully received');
        },
      },
      {
        id: 'procurement-10',
        title: 'Submit the vendor invoice',
        timeoutMs: 420000,
        async run(s) {
          const poId = idOf(s.need('poUrl'));
          // Retry-safe: a submitted bill waits in the staff Bill inbox under this run's invoice
          // number (or is already a bill), so it is never submitted twice.
          if (!s.state.billSent && !s.state.billUrl) {
            await as(s, 'Dev Founder');
            await s.goto('/payables/inbox', (p) => h1(p, 'Bill inbox'));
            const row = s.page
              .getByRole('table', { name: 'Vendor invoice submissions, oldest first' })
              .getByRole('row')
              .filter({ hasText: v.invoiceNo });
            const loaded = s.page
              .getByRole('table', { name: 'Vendor invoice submissions, oldest first' })
              .or(s.page.getByRole('heading', { name: 'The inbox is empty.' }));
            await s.see(loaded, 'the Bill inbox loaded');
            if (await visible(row)) s.record('billSent', true);
          }
          const vp = await vendorPage(s);
          if (s.state.billSent || s.state.billUrl) {
            s.checks.push('note: the bill was submitted by an earlier attempt');
            return;
          }
          await s.caption('procurement-10 — Dev Vendor: the received order → Submit a bill');
          await portalOpen(
            s,
            vp,
            '/vendor/purchase-orders',
            'Your purchase orders',
            `/vendor/purchase-orders/${poId}`,
          );
          await s.see(status(vp, 'Fully received'), 'the vendor sees the order Fully received');
          await s.click(
            vp.getByRole('link', { name: 'Submit a bill', exact: true }),
            'Submit a bill',
          );
          await vp.waitForURL(/\/vendor\/bills\/new\?po=/, { timeout: cfg.navTimeout });
          await s.see(h1(vp, 'Submit a bill'), 'the Submit a bill form');
          await vp.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
          const order = s.select('purchaseOrderId', { scope: vp, byName: true });
          s.expect(
            (await order.first().innerText()).includes(s.state.poNumber),
            'the order is preselected',
            await order.first().innerText(),
          );
          const file = vp.getByLabel('Your bill', { exact: true });
          await s.hydrated(file);
          await file.setInputFiles(demoFile(cfg, 'vendor-invoice.pdf'));
          await s.see(
            vp.getByRole('list', { name: 'Uploaded file' }).getByText('vendor-invoice.pdf'),
            'vendor-invoice.pdf uploaded',
            90000,
          );
          await s.fill(vp.getByLabel('Your invoice number'), v.invoiceNo);
          // Run 2: the date is empty, not "supplied". Today in UTC is never ahead of Nepal's date.
          const date = vp.getByLabel('Invoice date', { exact: true });
          if (!(await date.inputValue())) {
            s.checks.push('note: Invoice date was empty; entering today');
            await s.fill(date, new Date().toISOString().slice(0, 10));
          }
          await s.fill(vp.getByLabel('Total on your invoice'), '113000.00');
          await s.pause();
          await s.click(
            vp.getByRole('button', { name: 'Submit bill', exact: true }),
            'Submit bill',
          );
          await s.see(
            vp.getByText(/We received your bill\./),
            'the portal acknowledges the bill',
            90000,
          );
          s.record('billSent', true);
          await s.caption('procurement-10 — staff side: it waits in the Bill inbox, not as a bill');
          await as(s, 'Dev Founder');
          await s.goto('/payables/inbox', (p) => h1(p, 'Bill inbox'));
          await s.see(
            s.page
              .getByRole('table', { name: 'Vendor invoice submissions, oldest first' })
              .getByRole('row')
              .filter({ hasText: v.invoiceNo }),
            `${v.invoiceNo} in the Bill inbox`,
          );
        },
      },
      {
        id: 'procurement-11',
        title: 'Convert the submission and inspect matching',
        timeoutMs: 480000,
        async run(s) {
          await as(s, 'Dev Founder');
          const po = s.need('poNumber');
          const poId = idOf(s.need('poUrl'));
          // Not repeatable once the bill exists: the recorded bill is reused; a submission that no
          // longer offers Create bill without a recorded bill fails closed.
          if (!s.state.billUrl) {
            await s.goto('/payables/inbox', (p) => h1(p, 'Bill inbox'));
            const row = s.page
              .getByRole('table', { name: 'Vendor invoice submissions, oldest first' })
              .getByRole('row')
              .filter({ hasText: v.invoiceNo });
            await s.see(row, `${v.invoiceNo} in the Bill inbox`);
            const create = row.getByRole('link', { name: 'Create bill', exact: true });
            await s.caption('procurement-11 — wait until the file is Scanned clean');
            s.expect(
              await reloadUntil(s, row.getByText('Scanned clean', { exact: true }), 18, 10000),
              'the file is Scanned clean',
            );
            if (!(await visible(create)))
              throw new StepFailure(
                `${v.invoiceNo} offers no Create bill (${await s.text(row.first())}). If an earlier ` +
                  'attempt created the bill, record it by hand or use a new label.',
              );
            await s.click(create, 'Create bill');
            await s.page.waitForURL(/\/payables\/bills\/new\?submission=/, {
              timeout: cfg.navTimeout,
            });
            await s.see(h1(s.page, 'New bill'), 'the New bill form');
            await s.page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
            const form = await main(s);
            s.expect(form.includes(po), `the submission's order ${po} is linked`);
            s.expect(form.includes(VENDOR), `the vendor ${VENDOR} is kept`);
            await s.fill('Quantity', '2');
            await s.fill('Unit price (NPR)', '50000.00');
            // The guide's "Tax code VAT13" is the "VAT" field, option "VAT 13%".
            await s.choose(s.select('line:0:taxCodeId', { byName: true }), /VAT\s*13/);
            await s.fill('Account ID', ACCOUNT_ID);
            await s.pause();
            await s.click(s.button('Create bill'), 'Create bill');
            await s.page.waitForURL(new RegExp(`/payables/bills/${UUID}\\?created=1`), {
              timeout: cfg.navTimeout,
            });
            s.record('billUrl', pathOf(s.page.url()));
            await s.seeText('The bill was created.');
          } else {
            s.checks.push('note: reusing the bill an earlier attempt created');
            await openUrl(s, 'billUrl', (p) => p.getByRole('heading', { level: 1 }));
          }
          const text = await main(s);
          s.expect(hasAmount(text, 113000), 'the payable is NPR 113,000');
          s.expect(
            /Net\s*NPR 1,?00,?000\.00/.test(text) && /\bVAT\s*NPR 13,000\.00/.test(text),
            'net NPR 100,000 and VAT NPR 13,000',
          );
          await s.see(
            s.page.getByRole('table', { name: 'Match result by bill line' }).getByText('Matched'),
            'three-way match Matched',
          );
          await s.caption('procurement-11 — follow the order and vendor links');
          const poLink = s.page.locator(`main a[href="/procurement/orders/${poId}"]`);
          await s.see(s.page.locator('main a[href^="/vendors/"]'), 'the vendor link');
          await s.click(poLink, 'the order link');
          await s.see(h1(s.page, po), `the link opens ${po}`);
          await openUrl(s, 'billUrl', (p) => p.getByRole('heading', { level: 1 }));
          if (
            await visible(
              s.page
                .getByRole('main')
                .getByRole('button', { name: 'Submit for approval', exact: true }),
            )
          ) {
            await s.caption('procurement-11 — Submit for approval');
            await actionDialog(s, 'Submit for approval', /^Submit /, 'Submit for approval');
          } else s.checks.push('note: the bill was submitted by an earlier attempt');
          await s.see(status(s.page, 'Awaiting approval'), 'the bill is Awaiting approval', 60000);
          s.record('billNumber', await headingNumber(s, BILL));
          // The Founder entered and submitted the bill and must not approve it.
          await s.click(s.link('See the approval request'), 'See the approval request');
          await s.page.waitForURL(new RegExp(`/inbox/${UUID}`), { timeout: cfg.navTimeout });
          await s.seeText(
            'This request is waiting for a different approver.',
            'the Founder may not decide',
          );
          await s.notVisible(
            s.page.getByRole('main').getByRole('button', { name: 'Approve', exact: true }),
            'an Approve button for the Founder',
          );
        },
      },
      {
        id: 'procurement-12',
        title: 'Approve the bill',
        timeoutMs: 600000,
        async run(s) {
          s.need('billUrl');
          const approved = async (x) => {
            await as(x, 'Dev Founder');
            await openUrl(x, 'billUrl', (p) => p.getByRole('heading', { level: 1 }));
            return visible(status(x.page, 'Approved'));
          };
          // The inbox row reads "Vendor bill <invoice number> — BILL-…".
          await approveOnce(
            s,
            'billApprovals',
            'Dev Accountant',
            v.invoiceNo,
            'Demo bill matches order and confirmed receipt.',
            approved,
          );
          await approveOnce(
            s,
            'billApprovals',
            'Dev Finance',
            v.invoiceNo,
            'Demo payable approved.',
            approved,
          );
          await openUrl(s, 'billUrl', (p) => p.getByRole('heading', { level: 1 }));
          await s.see(status(s.page, 'Approved'), 'the bill is Approved');
          s.expect(
            /Payable\s*NPR 1,?13,?000\.00/.test(await main(s)),
            'the payable NPR 113,000 is recorded',
          );

          await s.caption('procurement-12 — Dev Vendor: Your bills → this invoice');
          const vp = await vendorPage(s);
          const billId = idOf(s.state.billUrl);
          await portalOpen(s, vp, '/vendor/bills', 'Your bills', `/vendor/bills/${billId}`);
          await s.see(status(vp, 'Approved for payment'), 'the vendor sees Approved for payment');
          await s.see(vp.getByRole('heading', { name: 'Payments' }), 'the Payments section');
          const portalText = await main(s, vp);
          s.expect(portalText.includes(v.invoiceNo), `the vendor page shows ${v.invoiceNo}`);
          s.expect(
            !/Match result|Matched|Dev Accountant|Dev Finance|Demo bill matches|Demo payable approved/.test(
              portalText,
            ),
            'no internal matching or approval detail for the vendor',
          );
        },
      },
      {
        id: 'procurement-13',
        title: 'Propose and independently verify the vendor bank account',
        timeoutMs: 420000,
        async run(s) {
          // Changes the shared seed vendor: verifying this run's account retires the account an
          // earlier run verified (one active account per vendor). Only this run's account (its name
          // carries the run key) is proposed or verified.
          await as(s, 'Dev Procurement');
          if (!s.state.vendorUrl) {
            const links = await s.exactLinks(
              await s.loadList(`/vendors?q=${encodeURIComponent(VENDOR)}`, {
                heading: 'Vendors',
                table: 'Vendors',
                empty: ['No vendors match.', 'No vendors yet.'],
              }),
              VENDOR,
            );
            if (links.length !== 1)
              throw new StepFailure(`Expected one vendor named ${VENDOR}, found ${links.length}`);
            s.record('vendorUrl', links[0]);
          }
          const accounts = async () => {
            await openUrl(s, 'vendorUrl', (p) => h1(p, VENDOR));
            await s.see(
              s.page.getByRole('heading', { name: 'Bank accounts' }),
              'the Bank accounts panel',
            );
            return s.page.evaluate(() =>
              [...document.querySelectorAll('main li')]
                .filter((li) => /Account ending/.test(li.textContent))
                .map((li) => {
                  const spans = [...li.querySelectorAll(':scope > span')].map((x) =>
                    x.textContent.trim(),
                  );
                  return {
                    status: li.querySelector('div span')?.textContent.trim() ?? '',
                    accountName: spans[0] ?? '',
                    last4: /Account ending\s*(\d{4})/.exec(li.textContent)?.[1] ?? '',
                  };
                }),
            );
          };
          const mine = () => s.page.getByRole('listitem').filter({ hasText: v.bankAccountName });
          let plan = bankAccountPlan(await accounts(), {
            accountName: v.bankAccountName,
            last4: v.bankLast4,
          });
          if (plan.action === 'fail') throw new StepFailure(`procurement-13: ${plan.reason}`);
          if (plan.action === 'propose') {
            await s.caption('procurement-13 — Dev Procurement proposes the bank account');
            await s.fill('Bank', v.bankName);
            await s.fill('Account name', v.bankAccountName);
            await s.fill('Account number', v.bankAccountNumber);
            await s.click(s.button('Propose bank account'), 'Propose bank account');
            await s.see(
              s.page.getByText(/different person must verify/),
              'the proposal is saved',
              60000,
            );
            plan = bankAccountPlan(await accounts(), {
              accountName: v.bankAccountName,
              last4: v.bankLast4,
            });
            s.expect(
              plan.action === 'verify',
              "this run's account is Awaiting verification",
              JSON.stringify(plan),
            );
            await s.notVisible(
              mine().getByRole('button', { name: 'Verify account' }),
              'Verify account for the proposer',
            );
          }
          if (plan.action === 'verify') {
            await s.caption('procurement-13 — Dev Founder attaches bank-callback.pdf and verifies');
            await as(s, 'Dev Founder');
            await openUrl(s, 'vendorUrl', (p) => h1(p, VENDOR));
            // Choosing the file only selects it; Verify account uploads, scans and verifies in one go.
            const evidence = mine().getByLabel('Call-back evidence');
            await s.hydrated(evidence);
            await evidence.setInputFiles(demoFile(cfg, 'bank-callback.pdf'));
            await s.click(
              mine().getByRole('button', { name: 'Verify account', exact: true }),
              'Verify account',
            );
            const verified = mine().filter({ hasText: 'Verified, in use' });
            s.expect(
              await reloadUntil(s, verified, 6, 10000, { waitFirstMs: 90000 }),
              "this run's account is Verified, in use",
            );
          } else s.checks.push('note: the account was verified by an earlier attempt');
          await s.see(
            mine().filter({ hasText: `Account ending ${v.bankLast4}` }),
            `only the ending ${v.bankLast4} is shown`,
          );
          s.expect(
            !(await main(s)).includes(v.bankAccountNumber),
            'the full account number is not shown',
          );
          s.record('bankLast4', v.bankLast4);
        },
      },
      {
        id: 'procurement-14',
        title: 'Prepare the payment request (independent approver available)',
        timeoutMs: 480000,
        async run(s) {
          await as(s, 'Dev Finance');
          const bill = s.need('billNumber');
          const last4 = s.need('bankLast4');
          // Retry-safe: the request is recorded right after Create draft request, and Submit is used
          // only while it is a Draft. A stop between the create and the record leaves a draft behind;
          // a re-run then finds the bill's amount no longer available and the create is refused.
          if (!s.state.paymentRequestUrl) {
            await s.goto('/payables/payment-requests/new', (p) => h1(p, 'New payment request'));
            await s.page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
            await s.caption(`procurement-14 — ${VENDOR}, ${bill}, NPR 113,000.00`);
            await s.choose(s.select('vendorPartyId', { byName: true }), VENDOR);
            // Not in the guide (ISSUES I-40): a raw GUID; the seed's placeholder is used.
            await s.fill('Paying entity bank account ID', PAYING_ACCOUNT_ID);
            await s.choose(
              s.select('allocation:0:openItemId', { byName: true }),
              new RegExp(`^${escapeRe(`${bill} · ${v.invoiceNo} · `)}`),
            );
            await s.fill('Amount 1', '113000.00');
            await s.pause();
            await s.click(s.button('Create draft request'), 'Create draft request');
            await s.page.waitForURL(new RegExp(`/payables/payment-requests/${UUID}$`), {
              timeout: cfg.navTimeout,
            });
            s.record('paymentRequestUrl', pathOf(s.page.url()));
          } else await openUrl(s, 'paymentRequestUrl', (p) => p.getByRole('heading', { level: 1 }));
          const items = await s.text(s.page.getByRole('main'));
          s.expect(hasAmount(items, 113000), 'Total requested NPR 113,000');
          s.expect(
            new RegExp(`Verified vendor account snapshot\\s*Ending ${last4}`).test(items),
            `the snapshotted account ends in ${last4}`,
            /Ending \d{4}/.exec(items)?.[0] ?? 'no ending shown',
          );
          if (await visible(status(s.page, 'Draft'))) {
            s.expect(items.includes(v.invoiceNo), `the items list ${v.invoiceNo}`);
            await s.caption('procurement-14 — Submit for approval (approval does not send money)');
            await s.click(
              s.page
                .getByRole('main')
                .getByRole('button', { name: 'Submit for approval', exact: true }),
              'Submit for approval',
            );
            const dialog = s.page.getByRole('dialog', { name: 'Submit for approval', exact: true });
            await s.see(
              dialog.getByText(/Approval does not send money\./),
              'the dialog says approval does not send money',
            );
            await s.pause(400);
            await dialog.getByRole('button', { name: 'Submit for approval', exact: true }).click();
            const done = dialog.getByRole('button', { name: 'Done', exact: true });
            await s.see(done, 'the submission is accepted (Done)', 90000);
            await Promise.all([
              s.page.waitForEvent('load', { timeout: cfg.navTimeout }),
              done.click(),
            ]);
          } else s.checks.push('note: the request was submitted by an earlier attempt');
          // TR-Q1: no refusal is expected; Dev Finance Two is an eligible independent approver.
          await s.see(
            status(s.page, 'Awaiting approval'),
            'the request is Awaiting approval',
            60000,
          );
          const approval = s.link('Open the approval request');
          await s.see(approval, 'the request links its approval');
          s.record('paymentApprovalUrl', pathOf(await approval.first().getAttribute('href')));
          await s.click(approval, 'Open the approval request');
          await s.page.waitForURL(new RegExp(`/inbox/${UUID}`), { timeout: cfg.navTimeout });
          await s.seeText(
            'This request is waiting for a different approver.',
            'the requester may not approve',
          );
          await s.notVisible(
            s.page.getByRole('main').getByRole('button', { name: 'Approve', exact: true }),
            'Approve for the requester',
          );
          await s.caption('procurement-14 — Dev Finance Two is offered Approve (not clicked)');
          await as(s, 'Dev Finance Two');
          await openUrl(s, 'paymentApprovalUrl', (p) => p.getByRole('heading', { level: 1 }));
          await s.see(
            s.page.getByRole('main').getByRole('button', { name: 'Approve', exact: true }),
            'Approve offered to Dev Finance Two (independent approver)',
          );
          // The demo ends at the recorded request: nothing is approved and no money moves.
        },
      },
      {
        id: 'procurement-15',
        title: 'Export the VAT register',
        timeoutMs: 360000,
        async run(s) {
          await as(s, 'Dev Accountant');
          await s.goto('/payables/vat-register', (p) => h1(p, 'Purchase VAT register'));
          await s.page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
          await s.caption(
            'procurement-15 — From (AD) 2026-01-01, To (AD) 2030-12-31 → Show register',
          );
          // The date fields are segmented (month, day, year), each a spinbutton named after the field.
          const enter = async (label, [year, month, day]) => {
            for (const [segment, value] of [
              ['month', month],
              ['day', day],
              ['year', year],
            ]) {
              const field = s.page.getByRole('spinbutton', {
                name: new RegExp(`${segment}.*${label} \\(AD\\)`, 'i'),
              });
              await s.hydrated(field);
              await field.first().click();
              await field.first().pressSequentially(value);
            }
          };
          await enter('From', ['2026', '01', '01']);
          await enter('To', ['2030', '12', '31']);
          await s.click(s.button('Show register'), 'Show register');
          await s.page.waitForURL(/from=2026-01-01&to=2030-12-31/, { timeout: cfg.navTimeout });
          await s.see(
            s.page.getByRole('heading', { name: 'Purchase VAT', exact: true }),
            'the register',
          );
          // The period holds every run's bills: only this run's row is compared, never the totals.
          const row = s.page
            .getByRole('table', { name: 'Purchase VAT register' })
            .getByRole('row')
            .filter({ hasText: v.invoiceNo });
          await s.see(row, `the ${v.invoiceNo} row`);
          s.expect((await row.count()) === 1, `one row for ${v.invoiceNo}`, `${await row.count()}`);
          const text = await s.text(row.first());
          s.expect(text.includes(VENDOR), `the row is ${VENDOR}'s`, text);
          s.expect(
            /(^|[^\d,])1,?00,?000\.00/.test(text) && /(^|[^\d,])13,000\.00/.test(text),
            'taxable NPR 100,000 and VAT NPR 13,000',
            text,
          );
          await s.caption('procurement-15 — Export CSV');
          const file = await s.download(
            s.page.getByRole('link', { name: 'Export CSV', exact: true }),
            s.dirs.files,
          );
          s.record('vatCsv', file.path);
          const csv = vatCsvRow(file.bytes.toString('utf8'), v.invoiceNo);
          s.expect(csv.ok, `the CSV has one ${v.invoiceNo} row`, csv.reason);
          s.expect(csv.row.vendor === VENDOR, `the CSV row is ${VENDOR}'s`, csv.row.vendor);
          s.expect(
            csv.row.taxable === '100000.00' && csv.row.vat === '13000.00',
            'the CSV has the same tax values (100000.00 / 13000.00)',
            `${csv.row.taxable} / ${csv.row.vat}`,
          );
        },
      },
    ],
  };
}
