// Workflow 4 · Short follow-ups for the alternate paths (guide steps branches-1 … branches-12).
// Predictable steps are scripted here: branches-4, 5, 6, 7, 11, 12.
// Exploratory steps (branches-1, 2, 3, 8, 9, 10) stay unscripted and are reported as
// SKIPPED with a note; one exploratory agent pass per release covers them (see README.md).
//
// Current UI wording is taken directly from apps/workspace source (not stale guide text):
// - Invoices list: "Create Invoice" → /invoices/new ("Organization legal name", segmented DatePicker
//   "Due date", "+ Add items" / "Remove line 2", "Save draft invoice").
// - Credit/debit notes: Dev Finance creates them and cannot approve their own work (SoD), so
//   Dev Accountant then Dev Finance Two approve (TR-Q1: keep Dev Finance Two active), and Dev Finance
//   issues them.
// - Purchase requests: /procurement/requests ("New purchase request", "Cancel request" →
//   "Yes, cancel this request", "Save changes" stale-version alert "This page is out of date",
//   emergency checkbox "This is an emergency purchase" → "Why is it an emergency?").
/* global document -- referenced inside page.evaluate callbacks, which run in the browser */
import { escapeRe, runMatch, uniqueValues } from '../lib/config.mjs';
import { StepFailure } from '../lib/session.mjs';
import { demoFile } from '../lib/support.mjs';
import { listIsComplete } from './sales.mjs';

const ROLE = {
  'Dev Founder': 'founder',
  'Dev Accountant': 'accountant',
  'Dev Finance': 'finance',
  'Dev Finance Two': 'finance',
  'Dev Procurement': 'procurement',
  'Dev Department Head': 'operations_officer',
  'Dev Management': 'management',
};

const INV = /INV-\d{4}\/\d{2}-\d{5}/;
const CN = /CN-\d{4}\/\d{2}-\d{5}/;
const DN = /DN-\d{4}\/\d{2}-\d{5}/;
const RCPT = /RCPT-\d{4}\/\d{2}-\d{5}/;
const PR = /PR-\d{4}\/\d{2}-\d{5}/;

const EXPLORATORY_NOTE = 'Exploratory step (covered by one exploratory agent pass per release)';
const DEFAULT_FALLBACK_CUSTOMER = 'Dev Customer Co';

/**
 * "NPR 1,130.00" and "1,017.00" both match once grouping commas are removed. The amount must stand
 * alone: 130.00 does not match inside 1130.00.
 */
export const hasAmount = (text, amount) =>
  new RegExp(`(?<![\\d.])${escapeRe(Number(amount).toFixed(2))}(?!\\d)`).test(
    String(text).replace(/,/g, ''),
  );

/**
 * Reads an NPR amount out of UI text, optionally anchored after a label (e.g. "Open amount",
 * "Left on this payment"). Returns a finite number or null when absent.
 */
export function parseNprAmount(text, label = '') {
  const re = label
    ? new RegExp(`${escapeRe(label)}[^0-9]*?NPR\\s*([\\d,]+\\.\\d{2})`)
    : /NPR\s*([\d,]+\.\d{2})/;
  const m = re.exec(String(text));
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

/**
 * Budget code for a run-scoped purchase request (PR form maxLength is 64). Throws if a prefix
 * and run key would overflow 64 characters so the driver never silently truncates them.
 */
export function budgetCodeFor(prefix, runKey) {
  const code = `${prefix}-${runKey}`;
  if (code.length > 64) throw new Error(`Budget code "${code}" is ${code.length} chars (max 64)`);
  return code;
}

/**
 * Picks which customer option to select in the invoice or payment customer dropdown.
 * Each option is rendered as "<legalName> (<customerNumber>)" (or plain "<legalName>").
 * - When `recordedName` is set (from an earlier step of this run), it must match exactly.
 * - Otherwise prefer this run's `runCompany` (created by sales-2 under the same label).
 * - If `branches` is running standalone without `sales`, fall back to `fallback` (Dev Customer Co).
 * @returns {{ ok: true, name: string, option: string, source: 'recorded' | 'run' | 'fallback' } |
 *   { ok: false, reason: string }}
 */
export function pickCustomerOption(
  options,
  runCompany,
  recordedName = null,
  fallback = DEFAULT_FALLBACK_CUSTOMER,
) {
  const cleaned = options.map((o) => String(o).replace(/\s+/g, ' ').trim()).filter(Boolean);
  const findExact = (name) => {
    const re = new RegExp(`^${escapeRe(name)}(?: \\([^()]+\\))?$`);
    return cleaned.filter((opt) => re.test(opt));
  };
  if (recordedName) {
    const hits = findExact(recordedName);
    if (hits.length === 1)
      return { ok: true, name: recordedName, option: hits[0], source: 'recorded' };
    return {
      ok: false,
      reason:
        hits.length === 0
          ? `recorded customer "${recordedName}" is not in the customer list`
          : `${hits.length} customer options match "${recordedName}"`,
    };
  }
  const runHits = findExact(runCompany);
  if (runHits.length === 1)
    return { ok: true, name: runCompany, option: runHits[0], source: 'run' };
  if (runHits.length > 1)
    return { ok: false, reason: `${runHits.length} customer options match "${runCompany}"` };
  const fbHits = findExact(fallback);
  if (fbHits.length === 1)
    return { ok: true, name: fallback, option: fbHits[0], source: 'fallback' };
  return {
    ok: false,
    reason:
      fbHits.length === 0
        ? `neither "${runCompany}" nor fallback "${fallback}" is in the customer list`
        : `${fbHits.length} customer options match fallback "${fallback}"`,
  };
}

/**
 * How branches-6 gets each NPR 10.00 payment (rejected or advance) without recording a second one.
 * Unlike sales.mjs, other payments of the same customer carrying different bank references (e.g.
 * sales-12/15 or earlier runs on Dev Customer Co) are expected and ignored; only an exact match
 * on `ref` is adopted, two matches fail, and an unreadable reference or failed lookup fails closed.
 * @returns {{ action: 'reuse' | 'adopt', url: string } | { action: 'record' } |
 *   { action: 'fail', reason: string }}
 */
export function branchesPaymentDecision({ recordedUrl, lookup, ref, knownUrls = [] }) {
  if (recordedUrl) return { action: 'reuse', url: recordedUrl };
  if (!lookup?.ok)
    return {
      action: 'fail',
      reason: lookup?.reason ?? 'the payments list did not load, so a payment may exist',
    };
  const listed = new Set(lookup.rows.map((r) => r.url));
  const missing = knownUrls.filter((u) => !listed.has(u));
  if (missing.length)
    return {
      action: 'fail',
      reason: `the list does not show this run's known payment ${missing.join(', ')}, so it may be incomplete`,
    };
  const others = lookup.rows.filter((r) => !knownUrls.includes(r.url));
  const unread = others.filter((r) => r.ref === null || r.ref === undefined);
  if (unread.length)
    return {
      action: 'fail',
      reason: `the bank reference of ${unread.map((r) => r.url).join(', ')} could not be read`,
    };
  const matches = others.filter((r) => r.ref.trim() === ref);
  if (matches.length > 1)
    return {
      action: 'fail',
      reason: `${matches.length} payments carry the bank reference ${ref} (${matches.map((r) => r.url).join(', ')}): possible duplicate`,
    };
  if (matches.length === 1) return { action: 'adopt', url: matches[0].url };
  return { action: 'record' };
}

/**
 * Distinct `/procurement/requests/<uuid>` paths from a loaded PR list whose row text contains one
 * of `texts` (this run's exact justifications; the row shows the justification in full).
 */
export function extractPrUrls(rows, texts, baseUrl = 'https://app.localhost') {
  const res = [texts].flat().map(runMatch);
  return [
    ...new Set(
      rows
        .filter((r) => res.some((re) => re.test(String(r.text ?? ''))))
        .flatMap((r) => r.hrefs ?? [])
        .map((h) => new URL(h, baseUrl).pathname)
        .filter((p) => /^\/procurement\/requests\/[0-9a-f-]{36}$/.test(p)),
    ),
  ];
}

export function workflow(cfg) {
  const u = uniqueValues(cfg.runKey);
  const v = {
    company: `BOS Demo Himalayan Labs${u.suffix}`,
    discardReason: `BOS Demo manual invoice and discard check.${u.suffix}`,
    adjustReason: `BOS Demo credit and debit note exercise.${u.suffix}`,
    rejectRef: `BOS-DEMO-REJECT-${cfg.runKey}`,
    advanceRef: `BOS-DEMO-ADVANCE-${cfg.runKey}`,
    cancelBudget: budgetCodeFor('BOS-DEMO-CANCEL', cfg.runKey),
    cancelReason: `Disposable cancellation demonstration.${u.suffix}`,
    staleBudget: budgetCodeFor('BOS-DEMO-STALE', cfg.runKey),
    staleInitialReason: `Disposable stale-edit demonstration.${u.suffix}`,
    // The two tabs' texts keep the run's suffix, so a re-run still finds this request by it.
    staleFirstReason: `First tab saved the demo change.${u.suffix}`,
    staleSecondReason: `Second tab must not overwrite the first.${u.suffix}`,
    emergencyBudget: budgetCodeFor('BOS-DEMO-EMERGENCY', cfg.runKey),
    emergencyReason: `Emergency-routing demonstration only.${u.suffix}`,
  };

  const as = async (s, name) => {
    const who = await s.switchTo(name);
    if (who)
      s.expect(
        who.roles.includes(ROLE[name]),
        `${name} has role ${ROLE[name]}`,
        who.roles.join(','),
      );
  };
  const main = (s) => s.text(s.page.getByRole('main'));
  const h1 = (p, name) => p.getByRole('heading', { level: 1, name });
  const status = (s, text) => s.page.getByText(text, { exact: true }).first();
  const visible = (locator) =>
    locator
      .first()
      .isVisible()
      .catch(() => false);
  const openUrl = (s, key, ready) => s.goto(s.need(key), ready);
  // A note's create action redirects from the original invoice to the new note; the original's
  // own URL already matches /invoices/<uuid>, so wait for a different one.
  const isNewInvoicePage = (originalPath) => (url) =>
    /^\/invoices\/[0-9a-f-]{36}$/.test(url.pathname) && url.pathname !== originalPath;
  // React Aria's Select labels its trigger by "<value/placeholder> <label>" or "<label>".
  const selectByLabel = (s, label, opts = {}) =>
    s.select(new RegExp(`(^| )${escapeRe(label)}$`), opts);

  /**
   * Picks the run's customer in a custom Select (`Organization legal name` on /invoices/new, or
   * `Customer` on /payments/new). Records `customerName` on first pick so later steps use the same
   * customer consistently.
   */
  const pickCustomer = async (s, selectLabel) => {
    const trigger = selectByLabel(s, selectLabel).first();
    await trigger.scrollIntoViewIfNeeded().catch(() => {});
    await s.hydrated(trigger);
    await trigger.click({ delay: 120 });
    const id = await trigger.getAttribute('aria-controls');
    const list = id ? s.page.locator(`[id="${id}"]`) : s.page.getByRole('listbox');
    const options = list.getByRole('option');
    await options.first().waitFor({ state: 'visible', timeout: 20000 });
    const texts = await options.allInnerTexts();
    const picked = pickCustomerOption(texts, v.company, s.state.customerName ?? null);
    if (!picked.ok) {
      await s.page.keyboard.press('Escape').catch(() => {});
      throw new StepFailure(`Could not choose customer in "${selectLabel}": ${picked.reason}`);
    }
    await list.getByRole('option', { name: picked.option, exact: true }).first().click({
      delay: 120,
    });
    await list
      .first()
      .waitFor({ state: 'hidden', timeout: 10000 })
      .catch(() => {});
    if (!s.state.customerName) {
      s.record('customerName', picked.name);
      if (picked.source === 'fallback')
        s.checks.push(
          `note: "${v.company}" not present (sales did not run under this label); using "${picked.name}"`,
        );
    }
    return picked.name;
  };

  /**
   * Fills a react-aria segmented DatePicker (`Due date` on /invoices/new) with YYYY-MM-DD by typing
   * year, month, day in that order (valid for any target date regardless of current day).
   */
  const fillDatePicker = async (s, label, iso) => {
    const [, year, month, day] = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso) ?? [];
    if (!year) throw new StepFailure(`Invalid ISO date "${iso}"`);
    const group = s.page.getByRole('group', { name: label }).first();
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
    const yText = await group.locator('[data-type="year"]').first().innerText();
    const mText = await group.locator('[data-type="month"]').first().innerText();
    const dText = await group.locator('[data-type="day"]').first().innerText();
    s.expect(
      yText.trim() === year &&
        Number(mText.trim()) === Number(month) &&
        Number(dText.trim()) === Number(day),
      `${label} set to ${iso}`,
      `${yText}-${mText}-${dText}`,
    );
  };

  /** Chooses an option only when the custom select does not already hold it (avoids re-opening). */
  const ensureSelect = async (s, label, wantRe, pickText, opts = {}) => {
    const sel = selectByLabel(s, label, opts);
    if ((await sel.count()) && !wantRe.test((await sel.first().innerText()).trim()))
      await s.choose(sel, pickText, opts);
  };

  /**
   * Fills the Create Invoice (/invoices/new) form header and line 1.
   * When `exerciseAddRemove` is true (branches-4), clicks "+ Add items" then "Remove line 2" and
   * verifies line 1 stays intact before saving.
   */
  const createManualInvoice = async (
    s,
    { reason, description, unitPrice = '1000.00', exerciseAddRemove = false, checkEmpty = false },
  ) => {
    await s.goto('/invoices', (p) => h1(p, 'Invoices'));
    const createLink = s.page.getByRole('link', { name: 'Create Invoice', exact: true });
    await s.see(createLink, 'Create Invoice link on /invoices');
    await s.click(createLink, 'Create Invoice');
    await s.see(h1(s.page, 'Create Invoice'), 'the Create Invoice form', cfg.navTimeout);
    await s.page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});

    if (checkEmpty) {
      await s.caption('branches-4 — Save draft invoice empty: inspect named field errors');
      await s.click(s.button('Save draft invoice'), 'Save draft invoice (empty)');
      for (const msg of [
        'Choose the customer.',
        'Say why this invoice is raised without a sales order. It stays on the invoice.',
        'Describe what is being charged.',
        'Enter the unit, such as pcs or hrs.',
        'Enter the price per unit, such as 1,500.00. Up to 2 decimals, not negative.',
        'Choose a tax code.',
      ]) {
        await s.see(s.page.getByText(msg, { exact: true }), `validation error "${msg}"`);
      }
      await s.pause();
    }

    await pickCustomer(s, 'Organization legal name');
    await ensureSelect(s, 'Currency', /NPR/, 'NPR');
    await fillDatePicker(s, 'Due date', '2030-12-31');
    await s.fill('Why is there no sales order?', reason);
    await s.fill('Description (line 1)', description);
    await s.fill('Unit (line 1)', 'lot');
    await s.fill('Quantity (line 1)', '1');
    await s.fill('Unit price (NPR) (line 1)', unitPrice);
    await s.choose(selectByLabel(s, 'Tax code (line 1)'), /VAT ?13/);

    if (exerciseAddRemove) {
      await s.caption('branches-4 — Add items (line 2), then Remove line 2');
      await s.click(s.button('Add items'), 'Add items');
      await s.see(s.field('Description (line 2)'), 'line 2 appeared');
      await s.click(s.button('Remove line 2'), 'Remove line 2');
      await s.notVisible(s.field('Description (line 2)'), 'line 2 after Remove line 2');
      s.expect(
        (await s.field('Description (line 1)').inputValue()) === description,
        'line 1 kept its description after removing line 2',
      );
    }

    await s.pause();
    await s.click(s.button('Save draft invoice'), 'Save draft invoice');
    await s.page.waitForURL(/\/invoices\/[0-9a-f-]{36}$/, { timeout: cfg.navTimeout });
    await s.see(s.page.getByText('Invoice details', { exact: true }), 'saved invoice detail');
    return s.page.url().split('?')[0].replace(cfg.appUrl, '');
  };

  /**
   * Invoice / note action dialogs (Submit for approval, Issue …, Discard): confirm, wait for Done,
   * click Done (reloads the page), and confirm the expected status badge appears.
   */
  const invoiceAction = async (s, { trigger, dialogName, confirm, fillDialog, expectStatus }) => {
    await s.click(s.button(trigger), trigger);
    const d = s.page.getByRole('dialog', { name: dialogName });
    await s.see(d, `dialog for ${trigger}`);
    if (fillDialog) await fillDialog(d);
    await s.pause(400);
    await d.getByRole('button', { name: confirm, exact: true }).click();
    const done = d.getByRole('button', { name: 'Done', exact: true });
    await s.see(done, `${trigger} succeeded (Done)`, 90000);
    await s.pause(600);
    await Promise.all([
      s.page.waitForEvent('load', { timeout: cfg.navTimeout }).catch(() => {}),
      done.click(),
    ]);
    if (expectStatus) {
      // r2-branches-5: after Issue the page occasionally needed one reload before the status flipped.
      for (let i = 0; i < 3 && !(await visible(status(s, expectStatus))); i++) {
        await s.page.waitForTimeout(3000);
        await s.page.reload({ waitUntil: 'domcontentloaded' });
      }
      await s.see(status(s, expectStatus), `status ${expectStatus} after ${trigger}`, 60000);
    }
  };

  /** Reads `/inbox/<uuid>` from the "Open the approval request" link on an invoice/note page. */
  const readInvoiceApprovalId = async (s) => {
    const link = s.page.getByRole('link', { name: 'Open the approval request', exact: true });
    await s.see(link, 'Open the approval request link');
    const href = await link.first().getAttribute('href');
    const id = /\/inbox\/([0-9a-f-]{36})/.exec(href ?? '')?.[1];
    s.expect(id, 'approval request id on invoice', href ?? '');
    return id;
  };

  /**
   * Inbox → open the matching waiting approval row → Approve with comment.
   * `target` is `{ requestId }` (exact link href match, immune to duplicate titles) or `{ match }`
   * (unique record number / text in the row, as in sales.mjs).
   */
  const approve = async (s, persona, target, comment, isDone) => {
    await as(s, persona);
    const label = target.requestId
      ? `request ${target.requestId.slice(0, 8)}`
      : String(target.match);
    await s.caption(`${s.captionText.split(' — ')[0]} — ${persona}: Inbox → approve ${label}`);
    await s.goto('/inbox', (p) => p.getByRole('heading', { name: 'Inbox', exact: true }));
    const table = s.page.getByRole('table', { name: 'Waiting approvals' });
    const row = target.requestId
      ? table.getByRole('row').filter({
          has: s.page.locator(`a[href="/inbox/${target.requestId}"]`),
        })
      : table.getByRole('row').filter({
          hasText: typeof target.match === 'string' ? runMatch(target.match) : target.match,
        });
    for (let i = 0; i < 8 && !(await visible(row)); i++) {
      await s.page.waitForTimeout(5000);
      await s.page.reload({ waitUntil: 'domcontentloaded' });
    }
    if (!(await visible(row)) && isDone) {
      if (await isDone(s)) {
        s.checks.push(
          `note: no waiting row for ${persona}; ${label} is already past this approval`,
        );
        return;
      }
      throw new StepFailure(
        `${persona} has no waiting approval for ${label}, and the record is not past approval yet. ` +
          'An earlier attempt may have approved it without recording that.',
      );
    }
    await s.see(row, `${persona}'s inbox row for ${label}`);
    await s.click(row.first().getByRole('link').first(), 'the inbox row');
    await s.page.waitForURL(
      target.requestId ? new RegExp(`/inbox/${target.requestId}`) : /\/inbox\/[0-9a-f-]{36}/,
      { timeout: cfg.navTimeout },
    );
    await s.pause();
    const dialog = s.page.getByRole('dialog', { name: 'Approve request' });
    const confirmApprove = dialog.getByRole('button', { name: 'Approve', exact: true });
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
            'The Approve request dialog stayed open after Cancel; not retrying, so confirm is not clicked by mistake',
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

  const approveOnce = async (s, progressKey, persona, target, comment, isDone) => {
    const done = s.state[progressKey] ?? [];
    if (done.includes(persona)) {
      s.checks.push(`note: ${persona} approved in an earlier attempt of this run`);
      return;
    }
    await approve(s, persona, target, comment, isDone);
    s.record(progressKey, [...done, persona]);
  };

  /** Submit (as Founder), approve (Accountant → Finance or Finance Two), and issue (as Finance). */
  const submitApproveAndIssue = async (
    s,
    {
      urlKey,
      approvalIdKey,
      progressKey,
      numberKey,
      numberRe,
      issueButton,
      secondApprover,
      sodCheckCreator = false,
      comments,
    },
  ) => {
    const pastApproval = async () => {
      await openUrl(s, urlKey, (p) => p.getByText('Invoice details', { exact: true }));
      return !(await visible(status(s, 'Awaiting approval')));
    };

    if (s.state[numberKey]) {
      s.checks.push(`note: ${s.state[numberKey]} was already issued by an earlier attempt`);
      await as(s, 'Dev Finance');
      await openUrl(s, urlKey, (p) => p.getByText(s.state[numberKey]).first());
      return s.state[numberKey];
    }

    await as(s, 'Dev Founder');
    await openUrl(s, urlKey, (p) =>
      p
        .getByRole('button', { name: 'Submit for approval', exact: true })
        .or(p.getByText('Awaiting approval', { exact: true }))
        .or(p.getByText('Approved', { exact: true }))
        .or(p.getByRole('button', { name: issueButton, exact: true }))
        .or(h1(p, numberRe)),
    );

    if (await visible(h1(s.page, numberRe))) {
      const num = numberRe.exec(await h1(s.page, numberRe).first().innerText())[0];
      s.record(numberKey, num);
      s.checks.push(`note: ${num} was issued by an earlier attempt of this run`);
      return num;
    }

    if (await visible(s.button('Submit for approval'))) {
      await invoiceAction(s, {
        trigger: 'Submit for approval',
        dialogName: /^Submit /,
        confirm: 'Submit for approval',
        expectStatus: 'Awaiting approval',
      });
    } else {
      s.checks.push(`note: ${urlKey} was already submitted by an earlier attempt`);
    }

    if (
      !s.state[approvalIdKey] &&
      (await visible(s.page.getByRole('link', { name: 'Open the approval request', exact: true })))
    ) {
      s.record(approvalIdKey, await readInvoiceApprovalId(s));
    }
    const requestId = s.need(approvalIdKey);

    await approveOnce(s, progressKey, 'Dev Accountant', { requestId }, comments[0], pastApproval);

    if (sodCheckCreator && !(s.state[progressKey] ?? []).includes(secondApprover)) {
      // TR-Q1 / R2-028: Dev Finance created the note and must be refused self-approval (SoD).
      await as(s, 'Dev Finance');
      await s.caption('branches-5 — SoD: creator Dev Finance cannot approve their own note');
      await s.goto(`/inbox/${requestId}`, (p) =>
        p.getByRole('list', { name: 'Approval route steps' }),
      );
      await s.see(
        s.page.getByText('This request is waiting for a different approver.', { exact: true }),
        'SoD notice for creator Dev Finance',
      );
      await s.notVisible(
        s.page.getByRole('main').getByRole('button', { name: 'Approve', exact: true }),
        'Approve button for creator Dev Finance',
      );
    }

    await approveOnce(s, progressKey, secondApprover, { requestId }, comments[1], pastApproval);

    await as(s, 'Dev Finance');
    await openUrl(s, urlKey, (p) =>
      p.getByRole('button', { name: issueButton, exact: true }).or(h1(p, numberRe)),
    );
    if (!(await visible(h1(s.page, numberRe)))) {
      await invoiceAction(s, {
        trigger: issueButton,
        dialogName: /^Issue /,
        confirm: issueButton,
        expectStatus: 'Issued',
      });
    }
    await s.see(h1(s.page, numberRe), `issued number matching ${numberRe}`, 90000);
    const num = numberRe.exec(await h1(s.page, numberRe).first().innerText())[0];
    s.record(numberKey, num);
    return num;
  };

  /**
   * Lists every NPR 10.00 payment of `customerName`, reading the exact `Bank reference` from each
   * unskipped payment page. Fails closed when the list does not load or does not fit on one page.
   */
  const sparePaymentsOf = async (s, customerName, skipUrls) => {
    const table = await s.loadList(`/payments?q=${encodeURIComponent(customerName)}&rows=100`, {
      heading: 'Payments',
      table: 'Payments',
      empty: ['No matching payments.', 'No payments match these filters.', 'No payments yet.'],
    });
    if (table) {
      const complete = listIsComplete({
        summary: await s.text(),
        hasNext: (await s.page.getByRole('link', { name: 'Next', exact: true }).count()) > 0,
      });
      if (!complete.ok)
        return {
          ok: false,
          reason: `the payments search for "${customerName}" is not one page (${complete.reason}), so a payment on a later page may exist`,
        };
    }
    const found = table
      ? await table.locator('tbody tr').evaluateAll((trs) =>
          trs.map((tr) => ({
            cells: [...tr.querySelectorAll('td')].map((td) =>
              td.textContent.replace(/\s+/g, ' ').trim(),
            ),
            hrefs: [...tr.querySelectorAll('a[href]')].map((a) => a.getAttribute('href')),
          })),
        )
      : [];
    // Narrow to rows of this customer with NPR 10.00 in any cell (plus already-known URLs), so the
    // lookup does not open sales-12/15's NPR 67,800.00 payments. A superset is harmless: every
    // opened payment's bank reference is compared exactly.
    const urls = [
      ...new Set(
        found
          .filter(
            (row) =>
              row.cells.includes(customerName) &&
              (row.cells.some((c) => hasAmount(c, 10)) ||
                row.hrefs.some((h) => skipUrls.includes(new URL(h, cfg.appUrl).pathname))),
          )
          .flatMap((row) => row.hrefs)
          .map((h) => new URL(h, cfg.appUrl).pathname)
          .filter((h) => /^\/payments\/[0-9a-f-]{36}$/.test(h)),
      ),
    ];
    const rows = [];
    for (const url of urls) {
      if (skipUrls.includes(url)) {
        rows.push({ url, ref: 'known' });
        continue;
      }
      await s.goto(url, (p) => p.getByText('Bank reference', { exact: true }));
      const ref = await s.page.evaluate(() => {
        const dts = [...document.querySelectorAll('dt')].filter(
          (d) => d.textContent.trim() === 'Bank reference',
        );
        return dts.length === 1 ? (dts[0].nextElementSibling?.textContent.trim() ?? null) : null;
      });
      rows.push({ url, ref });
    }
    return { ok: true, rows };
  };

  /** Records one NPR 10.00 payment with `payment-proof.pdf` (same reload-safe pattern as sales.mjs). */
  const recordSparePayment = async (s, ref) => {
    const warm = await s.page
      .evaluate(() => fetch('/payments/proofs', { credentials: 'include' }).then((r) => r.status))
      .catch(() => 'failed');
    s.checks.push(`compiled the proof upload route first (GET ${warm})`);
    await s.page.waitForTimeout(3000);
    const uploaded = s.page.getByRole('list', { name: 'Uploaded proof' });
    const formReset = async () =>
      (await visible(h1(s.page, 'Record payment'))) &&
      (await s.page
        .getByLabel('Bank reference', { exact: true })
        .inputValue()
        .catch(() => ref)) !== ref;

    for (let attempt = 1; ; attempt++) {
      await s.goto('/payments/new', (p) => h1(p, 'Record payment'));
      await s.page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
      await pickCustomer(s, 'Customer');
      await ensureSelect(s, 'Currency', /NPR/, 'NPR');
      await s.fill('Amount received', '10.00');
      await ensureSelect(s, 'Payment method', /Bank transfer/, 'Bank transfer');
      await s.fill('Bank reference', ref);
      await s.caption(`branches-6 — upload payment-proof.pdf for ${ref}`);
      await s.page.getByLabel('Add proof files').setInputFiles(demoFile(cfg, 'payment-proof.pdf'));
      const shown = await uploaded
        .getByText('payment-proof.pdf')
        .first()
        .waitFor({ state: 'visible', timeout: 90000 })
        .then(() => true)
        .catch(() => false);
      const emptied = await formReset();
      if (shown && !emptied) break;
      if (!emptied) {
        await s.see(uploaded.getByText('payment-proof.pdf'), 'payment-proof.pdf in Uploaded proof');
        break;
      }
      if (attempt === 2)
        throw new StepFailure(
          'The payment form was emptied by a page reload again after one refill',
        );
      s.checks.push('note: the payment form was emptied by a page reload; filling it again');
    }
    s.checks.push('saw: payment-proof.pdf in Uploaded proof');
    await s.pause();
    const submit = s.button('Record payment');
    const notReady = s.page.getByText(/A proof file is not ready yet/);
    const created = /\/payments\/[0-9a-f-]{36}$/;
    for (let i = 0; i < 20; i++) {
      await s.click(submit, 'Record payment');
      const outcome = await Promise.race([
        s.page
          .waitForURL(created, { timeout: cfg.navTimeout })
          .then(() => 'created')
          .catch(() => 'timeout'),
        notReady
          .first()
          .waitFor({ state: 'visible', timeout: cfg.navTimeout })
          .then(() => 'not-ready')
          .catch(() => 'timeout'),
      ]);
      if (outcome === 'created') break;
      if (outcome !== 'not-ready') {
        if (!(await formReset()))
          throw new StepFailure('Record payment neither opened the payment nor said why');
        s.checks.push('note: Record payment was sent, then the form came back reset (page reload)');
        return null;
      }
      await s.page.waitForTimeout(5000);
    }
    await s.page.waitForURL(created, { timeout: 30000 });
    return s.page.url().replace(cfg.appUrl, '');
  };

  /** Retry-safe NPR 10.00 payment lookup/record helper for branches-6. */
  const findOrRecordSparePayment = async (s, key, ref, otherKeys) => {
    await as(s, 'Dev Accountant');
    // Resolve customer name if branches-6 is run standalone (--only branches-6).
    if (!s.state.customerName) {
      await s.goto('/payments/new', (p) => h1(p, 'Record payment'));
      await pickCustomer(s, 'Customer');
    }
    const customerName = s.need('customerName');
    const known = otherKeys.map((k) => s.state[k]).filter(Boolean);
    const decision = s.state[key]
      ? branchesPaymentDecision({ recordedUrl: s.state[key], ref, knownUrls: known })
      : branchesPaymentDecision({
          lookup: await sparePaymentsOf(s, customerName, known),
          ref,
          knownUrls: known,
        });
    if (decision.action === 'reuse') {
      s.checks.push(`note: reusing ${key} from an earlier attempt of this run`);
      await openUrl(s, key, (p) => p.getByRole('heading', { level: 1 }));
      return decision.url;
    }
    if (decision.action === 'adopt') {
      s.checks.push(`note: adopting payment ${ref} recorded by an earlier attempt`);
      await s.goto(decision.url, (p) => p.getByRole('heading', { level: 1 }));
      return decision.url;
    }
    if (decision.action === 'fail')
      throw new StepFailure(
        `Not recording payment ${ref}: ${decision.reason}. Check payments by hand, or use a new label.`,
      );
    s.checks.push(`the payments lookup shows no payment ${ref} yet`);
    const url = await recordSparePayment(s, ref);
    if (url) return url;
    const after = branchesPaymentDecision({
      lookup: await sparePaymentsOf(s, customerName, known),
      ref,
      knownUrls: known,
    });
    if (after.action !== 'adopt')
      throw new StepFailure(
        `Record payment neither opened the payment nor said why, and the lookup ${
          after.action === 'record' ? 'shows no payment' : `is unclear (${after.reason})`
        } for ${ref}`,
      );
    s.checks.push(
      `note: Record payment saved ${ref} but the page reloaded before it opened; opening it from the list`,
    );
    await s.goto(after.url, (p) => p.getByRole('heading', { level: 1 }));
    return after.url;
  };

  /**
   * Loads the Purchase requests list searched for this run's suffix. The search covers the number
   * and the justification only (not the budget code), and every justification this workflow writes
   * ends with the suffix. Fails the step when the list does not fit on one page.
   */
  const runPrList = async (s) => {
    const q = encodeURIComponent(u.suffix.trim());
    const table = await s.loadList(`/procurement/requests?q=${q}&rows=100`, {
      heading: 'Purchase requests',
      table: 'Purchase requests',
      empty: ['No purchase requests match.', 'No purchase requests yet.'],
    });
    if (table) {
      const complete = listIsComplete({
        summary: await s.text(),
        hasNext: (await s.page.getByRole('link', { name: 'Next', exact: true }).count()) > 0,
      });
      if (!complete.ok)
        throw new StepFailure(
          `The purchase requests search for "${u.suffix.trim()}" is not one page (${complete.reason}); use a new label.`,
        );
    }
    return table;
  };

  /** The purchase requests of this run whose justification is one of `texts`. */
  const findPrs = async (s, texts) => {
    const table = await runPrList(s);
    if (!table) return [];
    const rows = await table.locator('tbody tr').evaluateAll((trs) =>
      trs.map((tr) => ({
        text: tr.textContent.replace(/\s+/g, ' ').trim(),
        hrefs: [...tr.querySelectorAll('a[href]')].map((a) => a.getAttribute('href')),
      })),
    );
    return extractPrUrls(rows, texts, cfg.appUrl);
  };

  /**
   * Fills `/procurement/requests/new` and saves a draft PR.
   * When `emergency` is set, first tests that leaving "Why is it an emergency?" blank is refused.
   */
  const createPrDraft = async (s, { budgetCode, reason, itemDescription, emergency = null }) => {
    await s.goto('/procurement/requests/new', (p) => h1(p, 'New purchase request'));
    await s.page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    await ensureSelect(s, 'Type', /^Goods$/, 'Goods');
    await s.fill('Needed by', '2030-12-31');
    await s.choose(selectByLabel(s, 'Department'), 'Operations');
    await s.choose(selectByLabel(s, 'Cost centre'), /^GENERAL/);
    await s.fill('Budget code', budgetCode);
    await ensureSelect(s, 'Currency', /^NPR$/, 'NPR');
    await s.fill('Why is this needed?', reason);

    const line1 = s.page.getByRole('group', { name: 'Line 1', exact: true });
    await s.fill(line1.getByLabel('Description', { exact: true }), itemDescription);
    await s.fill(line1.getByLabel('Unit', { exact: true }), 'pcs');
    await s.fill(line1.getByLabel('Quantity', { exact: true }), '1');
    await s.fill(line1.getByLabel('Estimated unit price (NPR)', { exact: true }), '100.00');
    const serials = line1.getByLabel('Record serial numbers at receipt', { exact: true });
    s.expect(!(await serials.isChecked()), 'Record serial numbers at receipt is unchecked');

    const emergencyBox = s.page.getByLabel('This is an emergency purchase', { exact: true });
    if (emergency) {
      await s.caption('branches-12 — check Emergency with empty reason: must refuse');
      await emergencyBox.check();
      await s.see(s.field('Why is it an emergency?'), 'Why is it an emergency? field');
      await s.click(s.button('Save draft'), 'Save draft (empty emergency reason)');
      await s.see(
        s.page.getByText('Say why this emergency cannot wait. It adds a Management approval.', {
          exact: true,
        }),
        'emergency reason required validation',
      );
      s.expect(
        new URL(s.page.url()).pathname === '/procurement/requests/new',
        'form stays on /procurement/requests/new when emergency reason is empty',
      );
      await s.fill('Why is it an emergency?', emergency);
    } else {
      s.expect(!(await emergencyBox.isChecked()), 'This is an emergency purchase is unchecked');
    }

    await s.pause();
    await s.click(s.button('Save draft'), 'Save draft');
    await s.page.waitForURL(/\/procurement\/requests\/[0-9a-f-]{36}(\?.*)?$/, {
      timeout: cfg.navTimeout,
    });
    await s.see(s.page.getByText('Request details', { exact: true }), 'saved PR detail');
    return s.page.url().split('?')[0].replace(cfg.appUrl, '');
  };

  /** Extracts `/customers/<uuid>` from a Customer link inside `<main>`. */
  const recordCustomerStatement = async (s) => {
    if (s.state.statementUrl) return s.state.statementUrl;
    const href = await s.page
      .getByRole('main')
      .locator('a[href^="/customers/"]')
      .first()
      .getAttribute('href')
      .catch(() => null);
    const id = /\/customers\/([0-9a-f-]{36})/.exec(href ?? '')?.[1];
    if (id) {
      const stmt = `/receivables/customers/${id}`;
      s.record('statementUrl', stmt);
      return stmt;
    }
    return null;
  };

  return {
    name: 'branches',
    title: 'Short follow-ups for the alternate paths',
    // Staff workspace only: none of the scripted branches steps touch portal, mail or auth.
    origins: ['app'],
    steps: [
      {
        id: 'branches-1',
        title: 'Return a memo, edit and resubmit',
        exploratory: true,
        note: EXPLORATORY_NOTE,
      },
      {
        id: 'branches-2',
        title: 'Reject a separate memo',
        exploratory: true,
        note: EXPLORATORY_NOTE,
      },
      {
        id: 'branches-3',
        title: 'Reject, revise and reprice a quotation',
        exploratory: true,
        note: EXPLORATORY_NOTE,
      },
      {
        id: 'branches-4',
        title: 'Manual invoice and draft discard',
        async run(s) {
          await as(s, 'Dev Founder');
          if (!s.state.discardInvoiceUrl) {
            const url = await createManualInvoice(s, {
              reason: v.discardReason,
              description: 'Disposable demo line',
              unitPrice: '1000.00',
              exerciseAddRemove: true,
              checkEmpty: true,
            });
            s.record('discardInvoiceUrl', url);
          } else {
            s.checks.push('note: reusing discardInvoiceUrl from an earlier attempt of this run');
            await openUrl(s, 'discardInvoiceUrl', (p) =>
              p.getByText('Invoice details', { exact: true }),
            );
          }

          await recordCustomerStatement(s);

          if (!(await visible(status(s, 'Discarded')))) {
            await s.caption(
              'branches-4 — verify draft priced at NPR 1,130 with no number, then discard',
            );
            await s.see(status(s, 'Draft'), 'manual invoice status Draft');
            const beforeText = await main(s);
            s.expect(hasAmount(beforeText, 1000), 'subtotal NPR 1,000.00 before discard');
            s.expect(hasAmount(beforeText, 130), 'VAT NPR 130.00 before discard');
            s.expect(hasAmount(beforeText, 1130), 'invoice total NPR 1,130.00 before discard');
            s.expect(!INV.test(beforeText), 'no invoice number on draft');
            s.expect(beforeText.includes('Not numbered yet'), 'draft reads Not numbered yet');
            s.expect(!beforeText.includes('Open amount'), 'draft creates no receivable');

            const discardReasonText = 'Discarded deliberately after the demo validation check.';
            await invoiceAction(s, {
              trigger: 'Discard',
              dialogName: /^Discard /,
              confirm: 'Discard invoice',
              expectStatus: 'Discarded',
              fillDialog: async (d) => {
                await s.see(
                  d.getByText(/The reason stays in its history/),
                  'discard dialog says reason stays in history',
                );
                await d.getByLabel('Reason', { exact: true }).fill(discardReasonText);
              },
            });
          } else {
            s.checks.push(
              'note: the spare manual invoice was already discarded by an earlier attempt',
            );
          }

          await s.see(status(s, 'Discarded'), 'invoice status Discarded');
          await s.see(
            s.page.getByText('A discarded invoice has no PDF.', { exact: true }),
            'discarded invoice has no PDF',
          );
          const afterText = await main(s);
          s.expect(!INV.test(afterText), 'discarded draft still has no invoice number');
          s.expect(!afterText.includes('Open amount'), 'discarded draft creates no receivable');
          await s.notVisible(s.button('Submit for approval'), 'Submit for approval after discard');
          await s.notVisible(s.button('Discard'), 'Discard button after discard');
          if (!afterText.includes('Discarded deliberately after the demo validation check.')) {
            s.finding(
              'Discard dialog promises "The reason stays in its history", but the discarded invoice page does not show the discard reason anywhere (R2-025).',
              'normal',
            );
          }
        },
      },
      {
        id: 'branches-5',
        title: 'Credit and debit notes on a separate invoice',
        timeoutMs: 600000,
        async run(s) {
          // 1. Original manual tax invoice (NPR 1,130.00): Founder drafts, submits; Accountant +
          //    Finance approve; Finance issues. Left unpaid.
          await as(s, 'Dev Founder');
          if (!s.state.adjustInvoiceUrl) {
            await s.caption('branches-5 — draft spare NPR 1,130 manual invoice');
            const url = await createManualInvoice(s, {
              reason: v.adjustReason,
              description: 'Demo adjustment base',
              unitPrice: '1000.00',
            });
            s.record('adjustInvoiceUrl', url);
          } else {
            s.checks.push('note: reusing adjustInvoiceUrl from an earlier attempt of this run');
            await openUrl(s, 'adjustInvoiceUrl', (p) =>
              p.getByText('Invoice details', { exact: true }),
            );
          }
          await recordCustomerStatement(s);

          const origNumber = await submitApproveAndIssue(s, {
            urlKey: 'adjustInvoiceUrl',
            approvalIdKey: 'adjustInvoiceApprovalId',
            progressKey: 'adjustInvoiceApprovals',
            numberKey: 'adjustInvoiceNumber',
            numberRe: INV,
            issueButton: 'Issue tax invoice',
            secondApprover: 'Dev Finance',
            comments: [
              'Demo adjustment base invoice checked.',
              'Demo adjustment base invoice approved.',
            ],
          });

          await as(s, 'Dev Finance');
          await openUrl(s, 'adjustInvoiceUrl', (p) => h1(p, origNumber));
          await s.see(status(s, 'Issued'), 'original adjustment invoice Issued');
          await s.see(s.button('Credit note'), 'Credit note button on issued invoice');
          await s.see(s.button('Debit note'), 'Debit note button on issued invoice');
          await s.notVisible(
            s.page.getByRole('button', { name: /void/i }),
            'no Void action on an issued invoice',
          );
          if (!s.state.creditNoteNumber) {
            const origText = await main(s);
            const open0 = parseNprAmount(origText, 'Open amount');
            s.expect(
              open0 === 1130,
              'original invoice starts at Open amount NPR 1,130.00',
              String(open0),
            );
          }

          // 2. Credit note (qty 0.1 → NPR 113.00): Finance creates, Founder submits, Accountant
          //    then Dev Finance Two approve (SoD: Finance cannot approve their own note), Finance issues.
          if (!s.state.creditNoteUrl) {
            await s.caption('branches-5 — Finance creates credit note (qty 0.1 = NPR 113)');
            await s.click(s.button('Credit note'), 'Credit note');
            const d = s.page.getByRole('dialog', { name: `Credit note for ${origNumber}` });
            await s.see(d, 'Credit note dialog');
            await d.getByLabel('Quantity to credit (line 1)', { exact: true }).fill('0.1');
            await d
              .getByLabel('Reason', { exact: true })
              .fill('Credit one tenth of the demo service.');
            await s.pause(400);
            await d.getByRole('button', { name: 'Create credit note', exact: true }).click();
            await s.page.waitForURL(isNewInvoicePage(s.state.adjustInvoiceUrl), {
              timeout: cfg.navTimeout,
            });
            const cnUrl = s.page.url().split('?')[0].replace(cfg.appUrl, '');
            s.expect(cnUrl !== s.state.adjustInvoiceUrl, 'credit note opened its own page', cnUrl);
            s.record('creditNoteUrl', cnUrl);
          } else {
            s.checks.push('note: reusing creditNoteUrl from an earlier attempt of this run');
          }

          await openUrl(s, 'creditNoteUrl', (p) => p.getByText('Invoice details', { exact: true }));
          const cnDraftText = await main(s);
          s.expect(hasAmount(cnDraftText, 113), 'credit note total is NPR 113.00');
          const cnOrigHref = await s.page
            .getByRole('link', { name: 'Open original invoice', exact: true })
            .first()
            .getAttribute('href');
          s.expect(
            cnOrigHref === s.state.adjustInvoiceUrl,
            'credit note links back to original invoice',
            cnOrigHref ?? '',
          );

          await submitApproveAndIssue(s, {
            urlKey: 'creditNoteUrl',
            approvalIdKey: 'creditNoteApprovalId',
            progressKey: 'creditNoteApprovals',
            numberKey: 'creditNoteNumber',
            numberRe: CN,
            issueButton: 'Issue credit note',
            secondApprover: 'Dev Finance Two',
            sodCheckCreator: true,
            comments: ['Demo credit note checked.', 'Demo credit note approved independently.'],
          });

          await as(s, 'Dev Finance');
          await openUrl(s, 'adjustInvoiceUrl', (p) => h1(p, origNumber));
          const openAfterCn = parseNprAmount(await main(s), 'Open amount');
          s.expect(
            openAfterCn === 1017,
            'original invoice open amount drops 1,130 → 1,017 after credit note',
            String(openAfterCn),
          );

          // 3. Debit note (NPR 100.00 + VAT13 = NPR 113.00): Finance creates, Founder submits,
          //    Accountant then Dev Finance Two approve, Finance issues.
          if (!s.state.debitNoteUrl) {
            await s.caption('branches-5 — Finance creates debit note (NPR 113)');
            await s.click(s.button('Debit note'), 'Debit note');
            const d = s.page.getByRole('dialog', { name: `Debit note for ${origNumber}` });
            await s.see(d, 'Debit note dialog');
            await d.getByLabel('Description (line 1)', { exact: true }).fill('Demo extra service');
            await d.getByLabel('Unit (line 1)', { exact: true }).fill('lot');
            await d.getByLabel('Quantity (line 1)', { exact: true }).fill('1');
            await d.getByLabel('Unit price (NPR) (line 1)', { exact: true }).fill('100.00');
            await s.choose(selectByLabel(s, 'Tax code (line 1)', { scope: d }), /VAT ?13/);
            await d
              .getByLabel('Reason', { exact: true })
              .fill('Restore the credited demo amount as an extra service.');
            await s.pause(400);
            await d.getByRole('button', { name: 'Create debit note', exact: true }).click();
            await s.page.waitForURL(isNewInvoicePage(s.state.adjustInvoiceUrl), {
              timeout: cfg.navTimeout,
            });
            const dnUrl = s.page.url().split('?')[0].replace(cfg.appUrl, '');
            s.expect(dnUrl !== s.state.adjustInvoiceUrl, 'debit note opened its own page', dnUrl);
            s.record('debitNoteUrl', dnUrl);
          } else {
            s.checks.push('note: reusing debitNoteUrl from an earlier attempt of this run');
          }

          await openUrl(s, 'debitNoteUrl', (p) => p.getByText('Invoice details', { exact: true }));
          s.expect(hasAmount(await main(s), 113), 'debit note total is NPR 113.00');
          const dnOrigHref = await s.page
            .getByRole('link', { name: 'Open original invoice', exact: true })
            .first()
            .getAttribute('href');
          s.expect(
            dnOrigHref === s.state.adjustInvoiceUrl,
            'debit note links back to original invoice',
            dnOrigHref ?? '',
          );

          const dnNumber = await submitApproveAndIssue(s, {
            urlKey: 'debitNoteUrl',
            approvalIdKey: 'debitNoteApprovalId',
            progressKey: 'debitNoteApprovals',
            numberKey: 'debitNoteNumber',
            numberRe: DN,
            issueButton: 'Issue debit note',
            secondApprover: 'Dev Finance Two',
            comments: ['Demo debit note checked.', 'Demo debit note approved independently.'],
          });

          await as(s, 'Dev Finance');
          await openUrl(s, 'debitNoteUrl', (p) => h1(p, dnNumber));
          const dnOpen = parseNprAmount(await main(s), 'Open amount');
          s.expect(dnOpen === 113, 'issued debit note has Open amount NPR 113.00', String(dnOpen));

          // Verify both open items on the customer statement (1,017 + 113 = 1,130 receivable).
          const stmt = await recordCustomerStatement(s);
          if (stmt) {
            await s.goto(stmt, (p) => p.getByText('Open items', { exact: true }).first());
            const origRow = s.page.getByRole('row').filter({ hasText: origNumber });
            const dnRow = s.page.getByRole('row').filter({ hasText: dnNumber });
            await s.see(origRow, `statement open row for ${origNumber}`);
            await s.see(dnRow, `statement open row for ${dnNumber}`);
            s.expect(
              hasAmount(await s.text(origRow.first()), 1017),
              `statement shows ${origNumber} open at NPR 1,017.00`,
            );
            s.expect(
              hasAmount(await s.text(dnRow.first()), 113),
              `statement shows ${dnNumber} open at NPR 113.00 (1,017 + 113 = 1,130)`,
            );
          }
        },
      },
      {
        id: 'branches-6',
        title: 'Payment rejection and unallocated advance',
        timeoutMs: 420000,
        async run(s) {
          // 1. Spare NPR 10.00 payment → Finance rejects it.
          const rejectUrl = await findOrRecordSparePayment(s, 'rejectedPaymentUrl', v.rejectRef, [
            'advancePaymentUrl',
          ]);
          if (s.state.rejectedPaymentUrl !== rejectUrl) s.record('rejectedPaymentUrl', rejectUrl);
          await recordCustomerStatement(s);

          await as(s, 'Dev Finance');
          await openUrl(s, 'rejectedPaymentUrl', (p) => p.getByRole('heading', { level: 1 }));
          const rejectReason = 'Rejected intentionally; duplicate demonstration proof.';
          if (!(await visible(status(s, 'Rejected')))) {
            await s.caption('branches-6 — Finance rejects the spare payment with a reason');
            await s.click(s.button('Reject'), 'Reject');
            const d = s.page.getByRole('dialog', { name: 'Reject this payment' });
            await s.see(d, 'Reject this payment dialog');
            await d.getByLabel('Reason for rejecting', { exact: true }).fill(rejectReason);
            await s.pause(400);
            await d.getByRole('button', { name: 'Reject payment', exact: true }).click();
            for (let i = 0; i < 4 && !(await visible(status(s, 'Rejected'))); i++) {
              await s.page.waitForTimeout(3000);
              if (i >= 1) await s.page.reload({ waitUntil: 'domcontentloaded' });
            }
          } else {
            s.checks.push('note: the spare payment was already rejected by an earlier attempt');
          }
          await s.see(status(s, 'Rejected'), 'rejected payment status Rejected');
          const rejText = await main(s);
          s.expect(rejText.includes(rejectReason), 'rejection reason shown on payment');
          s.expect(!RCPT.test(rejText), 'rejected payment creates no receipt number');
          await s.notVisible(
            s.page.getByRole('region', { name: 'Allocate this payment', exact: true }),
            'Allocate this payment panel on rejected payment',
          );
          await s.see(
            s.page.getByText('This payment has not been allocated to any invoice yet.', {
              exact: true,
            }),
            'no allocation on rejected payment',
          );

          // 2. Spare NPR 10.00 advance payment → Finance verifies and leaves it unallocated.
          const advUrl = await findOrRecordSparePayment(s, 'advancePaymentUrl', v.advanceRef, [
            'rejectedPaymentUrl',
          ]);
          if (s.state.advancePaymentUrl !== advUrl) s.record('advancePaymentUrl', advUrl);
          await recordCustomerStatement(s);

          await as(s, 'Dev Finance');
          await openUrl(s, 'advancePaymentUrl', (p) => p.getByRole('heading', { level: 1 }));
          const rcptHeading = h1(s.page, RCPT);
          if (!(await visible(rcptHeading))) {
            await s.caption(
              'branches-6 — Finance verifies advance payment and leaves it unallocated',
            );
            await s.click(s.button('Verify payment'), 'Verify payment');
            const d = s.page.getByRole('dialog', { name: 'Verify this payment' });
            await s.see(d, 'Verify this payment dialog');
            await d.getByRole('button', { name: 'Verify payment', exact: true }).click();
            await s.see(rcptHeading, 'verified receipt number (RCPT-…)', 90000);
          } else {
            s.checks.push('note: the advance payment was already verified by an earlier attempt');
          }
          const rcpt = RCPT.exec(await rcptHeading.first().innerText())[0];
          if (s.state.advanceReceiptNumber !== rcpt) s.record('advanceReceiptNumber', rcpt);
          await s.see(status(s, 'Verified'), 'advance payment status Verified');
          const left = parseNprAmount(await main(s), 'Left on this payment');
          s.expect(left === 10, 'advance payment has NPR 10.00 left unallocated', String(left));
          await s.see(
            s.page.getByText('This payment has not been allocated to any invoice yet.', {
              exact: true,
            }),
            'advance payment stays unallocated',
          );

          // 3. Customer statement: advance shows >= NPR 10.00 and does not silently pay the spare invoice.
          const stmt = s.need('statementUrl');
          await s.caption(
            'branches-6 — customer statement: Customer advance & untouched spare invoice',
          );
          await s.goto(stmt, (p) => p.getByText('Customer advance', { exact: true }).first());
          const advPanel = s.page
            .getByRole('complementary', { name: 'Customer advance' })
            .or(s.page.getByRole('region', { name: 'Customer advance' }));
          await s.see(advPanel, 'Customer advance panel');
          await s.notVisible(
            s.page.getByText('This customer has no advance.', { exact: true }),
            'no-advance placeholder when advance exists',
          );
          const advAmt = parseNprAmount(await s.text(advPanel.first()));
          if (s.state.customerName === v.company) {
            s.expect(advAmt === 10, 'Customer advance is NPR 10.00', String(advAmt));
          } else {
            s.expect(
              advAmt !== null && advAmt >= 10,
              'Customer advance is at least NPR 10.00 (shared customer may hold earlier advances)',
              String(advAmt),
            );
          }
          if (s.state.adjustInvoiceNumber) {
            const invRow = s.page.getByRole('row').filter({ hasText: s.state.adjustInvoiceNumber });
            await s.see(
              invRow,
              `spare invoice ${s.state.adjustInvoiceNumber} still open on statement`,
            );
            s.expect(
              hasAmount(await s.text(invRow.first()), 1017),
              'advance did not silently pay the spare adjustment invoice (still NPR 1,017.00 open)',
            );
          }
        },
      },
      {
        id: 'branches-7',
        title: 'Cancel a spare purchase request',
        async run(s) {
          await as(s, 'Dev Procurement');
          if (!s.state.cancelPrUrl) {
            const listed = await findPrs(s, v.cancelReason);
            if (listed.length > 1)
              throw new StepFailure(
                `${listed.length} PRs carry this run's cancel justification (${listed.join(', ')}); use a new label.`,
              );
            if (listed.length === 1) {
              s.record('cancelPrUrl', listed[0]);
              s.checks.push('note: adopted cancel PR created by an earlier attempt');
            } else {
              await s.caption('branches-7 — create disposable PR draft (BOS-DEMO-CANCEL)');
              const url = await createPrDraft(s, {
                budgetCode: v.cancelBudget,
                reason: v.cancelReason,
                itemDescription: 'Demo cable',
              });
              s.record('cancelPrUrl', url);
            }
          }

          await openUrl(s, 'cancelPrUrl', (p) => p.getByText('Request details', { exact: true }));
          if (!(await visible(status(s, 'Cancelled')))) {
            await s.see(status(s, 'Draft'), 'spare PR starts as Draft');
            const draftText = await main(s);
            s.expect(hasAmount(draftText, 100), 'spare PR estimated total is NPR 100.00');
            s.expect(!PR.test(draftText), 'draft PR has no PR number');
            await s.caption('branches-7 — Cancel request → Yes, cancel this request');
            await s.click(s.button('Cancel request'), 'Cancel request');
            const d = s.page.getByRole('dialog', { name: 'Cancel this draft?' });
            await s.see(d, 'Cancel this draft? dialog');
            await s.see(
              d.getByText('It cannot be reopened afterwards.', { exact: true }),
              'irreversible cancel warning',
            );
            await s.pause(400);
            await d.getByRole('button', { name: 'Yes, cancel this request', exact: true }).click();
            for (let i = 0; i < 4 && !(await visible(status(s, 'Cancelled'))); i++) {
              await s.page.waitForTimeout(2000);
              if (i >= 1) await s.page.reload({ waitUntil: 'domcontentloaded' });
            }
          } else {
            s.checks.push('note: spare PR was already cancelled by an earlier attempt');
          }

          await s.caption('branches-7 — reopen cancelled PR from Purchase requests list');
          const table = await runPrList(s);
          s.expect(Boolean(table), "the Purchase requests search lists this run's requests");
          const id = s.need('cancelPrUrl').split('/').pop();
          const row = table
            .getByRole('row')
            .filter({ has: s.page.locator(`a[href="/procurement/requests/${id}"]`) });
          await s.see(row, 'the cancelled PR row in the list');
          await s.see(row.getByText('Cancelled', { exact: true }), 'list row badge Cancelled');
          await s.click(
            row.locator(`a[href="/procurement/requests/${id}"]`).first(),
            'reopen cancelled PR',
          );
          await s.page.waitForURL(new RegExp(`/procurement/requests/${id}$`), {
            timeout: cfg.navTimeout,
          });

          await s.see(status(s, 'Cancelled'), 'reopened PR status Cancelled');
          await s.see(
            s.page.getByText('The request was cancelled before it was submitted.', { exact: true }),
            'cancelled PR status note',
          );
          await s.notVisible(s.link('Edit request'), 'Edit request link on cancelled PR');
          await s.notVisible(s.button('Submit for approval'), 'Submit button on cancelled PR');
          await s.notVisible(s.button('Cancel request'), 'Cancel button on cancelled PR');
          await s.notVisible(s.link('Start RFQ'), 'Start RFQ link on cancelled PR');
          await s.notVisible(s.link('Open RFQ'), 'Open RFQ link on cancelled PR');
        },
      },
      {
        id: 'branches-8',
        title: 'Create a vendor draft and inspect maker/checker',
        exploratory: true,
        note: EXPLORATORY_NOTE,
      },
      {
        id: 'branches-9',
        title: 'File rejection and scanner examples',
        exploratory: true,
        note: EXPLORATORY_NOTE,
      },
      {
        id: 'branches-10',
        title: 'Permission boundaries and administration',
        exploratory: true,
        note: EXPLORATORY_NOTE,
      },
      {
        id: 'branches-11',
        title: 'Stale edits and over-allocation',
        timeoutMs: 420000,
        async run(s) {
          // Part 1: Stale edit on a fresh PR draft opened in two tabs (Dev Procurement).
          await as(s, 'Dev Procurement');
          if (!s.state.stalePrUrl) {
            const listed = await findPrs(s, [
              v.staleInitialReason,
              v.staleFirstReason,
              v.staleSecondReason,
            ]);
            if (listed.length > 1)
              throw new StepFailure(
                `${listed.length} PRs carry this run's stale-edit justification (${listed.join(', ')}); use a new label.`,
              );
            if (listed.length === 1) {
              s.record('stalePrUrl', listed[0]);
              s.checks.push('note: adopted stale-edit PR created by an earlier attempt');
            } else {
              await s.caption('branches-11 — create fresh PR draft (BOS-DEMO-STALE)');
              const url = await createPrDraft(s, {
                budgetCode: v.staleBudget,
                reason: v.staleInitialReason,
                itemDescription: 'Demo cable',
              });
              s.record('stalePrUrl', url);
            }
          }

          const editPath = `${s.need('stalePrUrl')}/edit`;
          await s.caption('branches-11 — open Edit request in two tabs at the same version');
          await s.goto(editPath, (p) => h1(p, /^Edit /));
          await s.page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
          const v1 = await s.page.locator('input[name="expectedVersion"]').inputValue();
          s.expect(/^\d+$/.test(v1), `tab 1 holds expectedVersion (${v1})`, v1);

          // Open tab 2 in the same browser context (recorded as branches-page2.webm).
          const tab2 = s.watch(await s.context.newPage());
          await s.goto(editPath, (p) => h1(p, /^Edit /), { page: tab2 });
          await tab2.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
          const v2 = await tab2.locator('input[name="expectedVersion"]').inputValue();
          s.expect(
            v2 === v1,
            `both edit tabs opened at expectedVersion ${v1}`,
            `tab1=${v1} tab2=${v2}`,
          );

          // Tab 1 saves first.
          const firstReason = v.staleFirstReason;
          const secondReason = v.staleSecondReason;
          await s.page.bringToFront().catch(() => {});
          await s.caption('branches-11 — tab 1 saves the first edit');
          await s.fill('Why is this needed?', firstReason);
          await s.click(s.button('Save changes'), 'Save changes (tab 1)');
          await s.page.waitForURL(new RegExp(`${escapeRe(s.need('stalePrUrl'))}(\\?.*)?$`), {
            timeout: cfg.navTimeout,
          });
          await s.see(s.page.getByText(firstReason, { exact: true }), 'tab 1 save persisted');

          // Tab 2 (still holding the old expectedVersion) attempts to overwrite.
          await tab2.bringToFront().catch(() => {});
          const v2BeforeSave = await tab2.locator('input[name="expectedVersion"]').inputValue();
          if (v2BeforeSave !== v1) {
            throw new StepFailure(
              `Tab 2 reloaded from expectedVersion ${v1} to ${v2BeforeSave} before the stale save ` +
                '(likely a dev-server rebuild reload); re-run branches-11 to test the stale refusal.',
            );
          }
          await s.caption('branches-11 — stale tab 2 attempts Save changes: must be refused');
          await s.hydrated(tab2.getByLabel('Why is this needed?', { exact: true }));
          await tab2.getByLabel('Why is this needed?', { exact: true }).fill(secondReason);
          await s.hydrated(tab2.getByRole('button', { name: 'Save changes', exact: true }));
          await tab2.getByRole('button', { name: 'Save changes', exact: true }).click();

          const staleAlert = tab2
            .getByRole('alert')
            .filter({ hasText: 'This page is out of date' });
          await staleAlert.first().waitFor({ state: 'visible', timeout: cfg.actionTimeout });
          s.checks.push('saw: stale save alert "This page is out of date" in tab 2');
          const staleText = await s.text(staleAlert.first());
          s.expect(
            staleText.includes(
              'This request was submitted or changed since you opened it, so it can no longer be edited here. Reload to see where it stands.',
            ),
            'stale alert explains the conflict and asks to reload',
            staleText,
          );
          await staleAlert
            .getByRole('link', { name: 'Reload this request', exact: true })
            .first()
            .waitFor({ state: 'visible', timeout: 10000 });
          s.checks.push('saw: Reload this request link in stale alert');
          s.expect(
            new URL(tab2.url()).pathname === editPath,
            'stale tab stayed on the edit page',
            tab2.url(),
          );
          await s.pause();

          // Confirm tab 1's save is preserved after reload.
          await s.page.bringToFront().catch(() => {});
          await openUrl(s, 'stalePrUrl', (p) => p.getByText('Request details', { exact: true }));
          const prAfter = await main(s);
          s.expect(
            prAfter.includes(firstReason),
            'first tab edit is preserved after stale attempt',
          );
          s.expect(!prAfter.includes(secondReason), 'stale tab edit did not overwrite the first');

          // Part 2: Over-allocation refusal (Dev Finance).
          await as(s, 'Dev Finance');
          const invNumber = s.need('adjustInvoiceNumber');
          await s.caption(
            `branches-11 — over-allocate NPR 999,999.00 from ${s.state.advanceReceiptNumber ?? 'advance'} to ${invNumber}`,
          );
          await openUrl(s, 'advancePaymentUrl', (p) =>
            p.getByRole('region', { name: 'Allocate this payment', exact: true }),
          );
          const leftBefore = parseNprAmount(await main(s), 'Left on this payment');
          s.expect(
            leftBefore === 10,
            'advance payment starts with NPR 10.00 left',
            String(leftBefore),
          );

          const panel = s.page.getByRole('region', { name: 'Allocate this payment', exact: true });
          await s.fill(
            panel.getByRole('textbox', { name: `Amount to allocate to ${invNumber}` }),
            '999999.00',
          );
          await s.pause(400);
          await s.click(
            panel.getByRole('button', { name: 'Allocate payment', exact: true }),
            'Allocate payment (over-allocation)',
          );
          const overMsg =
            'These amounts are more than this payment has left, or more than an invoice has open. Nothing was allocated. Check the amounts and try again.';
          await s.see(
            panel.getByRole('alert').filter({ hasText: overMsg }),
            'over-allocation refusal alert',
          );

          await s.page.reload({ waitUntil: 'domcontentloaded' });
          await s.see(
            s.page.getByRole('region', { name: 'Allocate this payment', exact: true }),
            'Allocate panel after reload',
          );
          const leftAfter = parseNprAmount(await main(s), 'Left on this payment');
          s.expect(leftAfter === 10, 'advance payment still has NPR 10.00 left', String(leftAfter));
          await s.see(
            s.page.getByText('This payment has not been allocated to any invoice yet.', {
              exact: true,
            }),
            'advance payment remains unallocated',
          );

          await openUrl(s, 'adjustInvoiceUrl', (p) => h1(p, invNumber));
          const invOpen = parseNprAmount(await main(s), 'Open amount');
          s.expect(
            invOpen === 1017,
            `${invNumber} open balance is unchanged at NPR 1,017.00`,
            String(invOpen),
          );
        },
      },
      {
        id: 'branches-12',
        title: 'Emergency purchase approval',
        timeoutMs: 420000,
        async run(s) {
          await as(s, 'Dev Procurement');
          if (!s.state.emergencyPrUrl) {
            const listed = await findPrs(s, v.emergencyReason);
            if (listed.length > 1)
              throw new StepFailure(
                `${listed.length} PRs carry this run's emergency justification (${listed.join(', ')}); use a new label.`,
              );
            if (listed.length === 1) {
              s.record('emergencyPrUrl', listed[0]);
              s.checks.push('note: adopted emergency PR created by an earlier attempt');
            } else {
              await s.caption('branches-12 — create emergency PR (BOS-DEMO-EMERGENCY)');
              const url = await createPrDraft(s, {
                budgetCode: v.emergencyBudget,
                reason: v.emergencyReason,
                itemDescription: 'Demo emergency replacement',
                emergency: 'Simulated outage for testing; no real emergency.',
              });
              s.record('emergencyPrUrl', url);
            }
          }

          await openUrl(s, 'emergencyPrUrl', (p) =>
            p.getByText('Request details', { exact: true }),
          );
          await s.see(status(s, 'Emergency'), 'Emergency badge on PR');

          if (await visible(s.button('Submit for approval'))) {
            await s.see(
              s.page.getByText(
                'Submitting sends it to the department head, then to Management because it is an emergency.',
                { exact: true },
              ),
              'emergency route explanation before submit',
            );
            await s.caption('branches-12 — submit emergency PR (no confirm dialog)');
            await s.click(s.button('Submit for approval'), 'Submit for approval');
            for (let i = 0; i < 4 && !(await visible(h1(s.page, PR))); i++) {
              await s.page.waitForTimeout(2000);
              if (i >= 1) await s.page.reload({ waitUntil: 'domcontentloaded' });
            }
          } else {
            s.checks.push('note: emergency PR was already submitted by an earlier attempt');
          }

          await s.see(h1(s.page, PR), 'submitted emergency PR number (PR-…)', 60000);
          const prNumber = PR.exec(await h1(s.page, PR).first().innerText())[0];
          if (s.state.emergencyPrNumber !== prNumber) s.record('emergencyPrNumber', prNumber);

          const approvalSteps = s.page
            .getByRole('list', { name: 'Approval steps' })
            .getByRole('listitem');
          await s.see(approvalSteps, 'Approval steps timeline on PR');
          s.expect(
            (await approvalSteps.count()) >= 2,
            'emergency PR route has at least 2 steps (department head + Management)',
            String(await approvalSteps.count()),
          );

          const prPastApproval = async () => {
            await openUrl(s, 'emergencyPrUrl', (p) =>
              p.getByText('Request details', { exact: true }),
            );
            return await visible(status(s, 'Department approved'));
          };

          await approveOnce(
            s,
            'emergencyPrApprovals',
            'Dev Department Head',
            { match: prNumber },
            'Demo emergency need checked.',
            prPastApproval,
          );
          await approveOnce(
            s,
            'emergencyPrApprovals',
            'Dev Management',
            { match: prNumber },
            'Demo emergency route complete.',
            prPastApproval,
          );

          await as(s, 'Dev Procurement');
          await s.caption('branches-12 — verify PR reaches Department approved (no RFQ started)');
          await openUrl(s, 'emergencyPrUrl', (p) => h1(p, prNumber));
          await s.see(status(s, 'Department approved'), 'PR status Department approved');
          await s.see(status(s, 'Emergency'), 'Emergency badge stays visible');
          await s.see(
            s.page.getByText(
              'The department head approved the need. Procurement can now open an RFQ.',
              { exact: true },
            ),
            'Department approved status note',
          );
          await s.see(
            s.link('Start RFQ'),
            'Start RFQ link offered (normal sourcing still to come; not clicked)',
          );
          await s.notVisible(s.link('Open RFQ'), 'no RFQ started automatically');
          const finalSteps = await approvalSteps.allInnerTexts();
          s.expect(
            finalSteps.length >= 2 && finalSteps.every((t) => /Approved/i.test(t)),
            'both emergency approval steps read Approved',
            JSON.stringify(finalSteps),
          );
        },
      },
    ],
  };
}
