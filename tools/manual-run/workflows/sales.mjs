// Workflow 2 · Lead → quotation → sales order → invoice → payment (guide steps sales-1 … sales-15).
// Exact values: the test-run guide steps sales-* plus the "Update 19 Nov" boxes:
// Qualify → Qualify lead; per-document Upload (native chooser) + Save, status "Virus free";
// per-document Approve then Approve customer (reason + confirm); one 100% Advance milestone
// (total NPR 135,600); payments are 67,800.00 twice; Dev Founder confirms the order.
// Unique values (names, PAN, e-mail, bank references) carry the run key so runs never collide.
/* global document -- referenced inside page.evaluate callbacks, which run in the browser */
import { escapeRe, runMatch, uniqueValues } from '../lib/config.mjs';
import { StepFailure } from '../lib/session.mjs';
import { demoFile, findMail, isPdf, mailMessage, pdfText } from '../lib/support.mjs';

const ROLE = {
  'Dev Sales': 'sales',
  'Dev Accountant': 'accountant',
  'Dev Finance': 'finance',
  'Dev Founder': 'founder',
  'Dev Management': 'management',
};
const QT = /QT-\d{4}\/\d{2}-\d{5}/;
const SO = /SO-\d{4}\/\d{2}-\d{5}/;
const INV = /INV-\d{4}\/\d{2}-\d{5}/;
const RCPT = /RCPT-\d{4}\/\d{2}-\d{5}/;
const DOCS = [
  ['Company registration certificate', 'registration-certificate.pdf'],
  ['PAN or VAT certificate', 'pan-certificate.pdf'],
  ['Authorised signatory ID', 'signatory-id.pdf'],
];

/** "NPR 1,35,600.00" and "135,600.00" both contain 135600.00 once separators are removed. */
const hasAmount = (text, amount) => text.replace(/,/g, '').includes(Number(amount).toFixed(2));

/**
 * Whether a loaded list shows every row it has: no enabled "Next" link, and no summary saying it
 * shows fewer rows than it holds ("Showing 1–5 of 7 payments", "Showing 25 of 30 payments").
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function listIsComplete({ summary = '', hasNext = false }) {
  if (hasNext) return { ok: false, reason: 'the list has a next page' };
  const n = (x) => Number(String(x).replace(/,/g, ''));
  const range = /Showing\s+([\d,]+)\s*[–-]\s*([\d,]+)\s+of\s+([\d,]+)/.exec(summary);
  if (range && n(range[2]) - n(range[1]) + 1 < n(range[3]))
    return { ok: false, reason: `the list shows rows ${range[1]}–${range[2]} of ${range[3]}` };
  const count = /Showing\s+([\d,]+)\s+of\s+([\d,]+)/.exec(summary);
  if (count && n(count[1]) < n(count[2]))
    return { ok: false, reason: `the list shows ${count[1]} of ${count[2]} rows` };
  return { ok: true };
}

/**
 * How sales-12 and sales-15 get their payment without recording a second one.
 * @param {{ recordedUrl?: string | null, ref: string, knownUrls: string[],
 *   lookup?: { ok: boolean, rows: { url: string, ref: string | null }[] } | null }} input
 *   `lookup` lists every payment of this run's customer, with the bank reference read from each
 *   payment's own page (null when it could not be read); `ok` is false when the list did not load.
 * @returns {{ action: 'reuse' | 'adopt', url: string } | { action: 'record' } |
 *   { action: 'fail', reason: string }}
 * - `reuse` the URL an earlier attempt recorded;
 * - `adopt` the one payment whose bank reference is exactly this run's (an attempt interrupted
 *   after the submit, before it could record the URL);
 * - `record` only after a successful lookup that shows no such payment;
 * - `fail` whenever a payment with this reference may exist but cannot be singled out: a failed
 *   lookup, a known payment missing from the list, an unreadable reference, two matches, or a
 *   payment of this customer with another reference.
 */
export function paymentDecision({ recordedUrl, lookup, ref, knownUrls }) {
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
  const strangers = others.filter((r) => r.ref.trim() !== ref);
  if (strangers.length)
    return {
      action: 'fail',
      reason: `this run's customer has a payment with another bank reference (${strangers.map((r) => r.url).join(', ')})`,
    };
  if (matches.length === 1) return { action: 'adopt', url: matches[0].url };
  return { action: 'record' };
}

/**
 * The address this run's customer was created with. sales-2 records it; a folder from before it did
 * (customer created, nothing recorded) used the earlier `anu.scr-` form.
 */
export function contactEmailFor(state, { email, legacyEmail }) {
  return state.contactEmail ?? (state.opportunityUrl ? legacyEmail : email);
}

export function workflow(cfg) {
  const u = uniqueValues(cfg.runKey);
  const v = {
    leadTitle: `BOS Demo — Business OS service${u.suffix}`,
    company: `BOS Demo Himalayan Labs${u.suffix}`,
    contact: 'Anu Shrestha',
    email: `${u.emailLocal}@bos-demo.example.com`,
    legacyEmail: `${u.legacyEmailLocal}@bos-demo.example.com`,
    pan: u.pan,
    pay1: u.bankRef(1),
    pay2: u.bankRef(2),
  };
  // This run's records are found by these, never by a longer run key that starts with the same text.
  const L = runMatch(v.leadTitle);
  const C = runMatch(v.company);

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

  /**
   * Inbox → this run's row (matched by a unique number or name) → Approve with a comment.
   * Without a waiting row, `isDone(s)` decides: true means the record is already past this
   * approval (an earlier attempt approved it), so nothing is repeated; otherwise the step fails.
   */
  const approve = async (s, persona, match, comment, isDone) => {
    await as(s, persona);
    await s.caption(`${s.captionText.split(' — ')[0]} — ${persona}: Inbox → approve`);
    await s.goto('/inbox', (p) => p.getByRole('heading', { name: 'Inbox', exact: true }));
    const row = s.page
      .getByRole('table', { name: 'Waiting approvals' })
      .getByRole('row')
      .filter({ hasText: typeof match === 'string' ? runMatch(match) : match });
    for (
      let i = 0;
      i < 8 &&
      !(await row
        .first()
        .isVisible()
        .catch(() => false));
      i++
    ) {
      await s.page.waitForTimeout(5000);
      await s.page.reload({ waitUntil: 'domcontentloaded' });
    }
    if (
      !(await row
        .first()
        .isVisible()
        .catch(() => false)) &&
      isDone
    ) {
      if (await isDone(s)) {
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
    await s.see(row, `${persona}'s inbox row for ${match}`);
    await s.click(row.first().getByRole('link').first(), 'the inbox row');
    await s.page.waitForURL(/\/inbox\/[0-9a-f-]{36}/);
    await s.pause();
    const dialog = s.page.getByRole('dialog', { name: 'Approve request' });
    const confirmApprove = dialog.getByRole('button', { name: 'Approve', exact: true });
    // Nothing is decided before the confirm click, so a dialog lost to a dev-server rebuild
    // reload (r3s1 sales-11: it never opened; r3s2 sales-7: it closed before the confirm) is
    // opened and filled again, at most three times, each noted. The confirm is clicked once.
    // The opener and the confirm are both named "Approve": the opener is looked up in <main> (the
    // dialog is portalled outside it), and a still-open dialog is cancelled before a retry, so a
    // retry click can never land on the confirm and approve without the comment.
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

  const openUrl = (s, key, ready) => s.goto(s.need(key), ready);

  const visible = (locator) =>
    locator
      .first()
      .isVisible()
      .catch(() => false);

  /** The quotation left Approval pending (Approved, Sent or Accepted). */
  const quotePastApproval = async (s) => {
    await openUrl(s, 'quotationUrl', (p) => p.getByText('Status history', { exact: true }));
    for (const st of ['Approved', 'Sent', 'Accepted'])
      if (await visible(status(s, st))) return true;
    return false;
  };

  /** The invoice is no longer Awaiting approval (approved or issued). */
  const invoicePastApproval = async (s) => {
    await openUrl(s, 'invoiceUrl', (p) => p.getByText('Invoice details', { exact: true }));
    return !(await visible(status(s, 'Awaiting approval')));
  };

  /** sales-4's last check: optional evidence is left empty. */
  const optionalStaysMissing = async (s) => {
    const optional = s.page.getByRole('row').filter({
      has: s.page.getByRole('rowheader', { name: 'Proof of address', exact: true }),
    });
    await s.see(
      optional.getByText('Missing', { exact: true }),
      'optional evidence stays empty (Missing)',
    );
  };

  /** Invoice action dialogs: confirm, then the success state offers Done, which reloads the page. */
  const invoiceAction = async (s, trigger, dialogName, confirm) => {
    await s.click(s.button(trigger), trigger);
    const d = s.page.getByRole('dialog', { name: dialogName });
    await d.getByRole('button', { name: confirm, exact: true }).click();
    const done = d.getByRole('button', { name: 'Done', exact: true });
    await s.see(done, `${trigger} succeeded (Done)`, 90000);
    await s.pause(600);
    await Promise.all([s.page.waitForEvent('load', { timeout: cfg.navTimeout }), done.click()]);
  };

  /** Customer statement: the invoice's open-items row carries the expected open amount. */
  const statementOpen = async (s, amount) => {
    const row = s.page.getByRole('row').filter({ hasText: s.need('invoiceNumber') });
    await s.see(row, `the statement row for ${s.state.invoiceNumber}`);
    const text = await s.text(row.first());
    s.expect(hasAmount(text, amount), `the statement shows NPR ${amount} open`, text);
  };

  /** sales-8: wait for the clean PDF, download it, then send it to the contact. */
  const downloadAndSend = async (s) => {
    const send = s.button('Send to customer');
    await s.see(send, 'Send to customer');
    await s.caption('sales-8 — wait until the PDF is rendered and scanned clean');
    for (let i = 0; i < 30 && (await send.first().getAttribute('aria-disabled')) === 'true'; i++) {
      await s.page.waitForTimeout(5000);
      if (i % 3 === 2) await s.page.reload({ waitUntil: 'domcontentloaded' });
    }
    s.expect(
      (await send.first().getAttribute('aria-disabled')) !== 'true',
      'the PDF is clean (Send is enabled)',
    );
    const file = await s.download(s.page.getByRole('link', { name: /^Download/ }), s.dirs.files);
    s.expect(isPdf(file.bytes), 'the quotation download is a PDF');
    s.record('quotationPdf', file.path);
    const pdf = pdfText(file.path);
    if (pdf !== null) s.expect(hasAmount(pdf, 135600), 'the PDF total is NPR 135,600');

    await s.caption('sales-8 — Send to customer → Anu Shrestha');
    await s.click(send, 'Send to customer');
    const dialog = s.page.getByRole('dialog', { name: /^Send / });
    await s.see(dialog.getByText(/never sent as a file/), 'the dialog says the file is never sent');
    await s.choose(s.select('Send to', { scope: dialog }), new RegExp(escapeRe(v.contact)));
    await s.pause(400);
    await dialog.locator('footer').getByRole('button', { name: 'Send to customer' }).click();
    await s.see(dialog.getByRole('status').filter({ hasText: 'Sent to' }), 'Sent to …', 60000);
    await dialog.getByRole('button', { name: 'Done' }).click();
    await s.see(status(s, 'Sent'), 'quotation status Sent');
  };

  const checkDraft = async (s) => {
    await s.see(status(s, 'Draft'), 'the invoice is a draft');
    const inv = await main(s);
    if (/Customer details unavailable/.test(inv))
      s.finding('Draft invoice shows "Customer details unavailable" (I-18)', 'normal');
  };

  /**
   * Every payment of this run's unique customer (any status), each with the bank reference read
   * from its own page. The Payments list rows carry no reference. Throws (fails the step) when the
   * list does not load; a page whose reference cannot be read gives `ref: null`. The search for
   * the run's unique customer name (and 100 rows, where the app offers it) should fit one page;
   * a list that still has another page is not searched further: the lookup is not ok.
   */
  const customerPayments = async (s, skipUrls) => {
    const table = await s.loadList(`/payments?q=${encodeURIComponent(v.company)}&rows=100`, {
      heading: 'Payments',
      table: 'Payments',
      // Newer and older app versions; "No payments yet." when there are none at all.
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
          reason: `the payments search for this run's customer is not one page (${complete.reason}), so a payment on a later page may exist`,
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
    const urls = [
      ...new Set(
        found
          .filter((row) => row.cells.includes(v.company))
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

  /**
   * sales-12 and sales-15 record a payment at most once per run, whatever an earlier attempt did:
   * the recorded URL is reused; otherwise, after a lookup that loaded, the one payment of this
   * run's customer whose bank reference is exactly `ref` is adopted; only when the lookup shows
   * none is a new payment recorded. Anything uncertain fails the step without recording.
   */
  const findOrRecordPayment = async (s, key, ref, otherKeys) => {
    await as(s, 'Dev Accountant');
    const known = otherKeys.map((k) => s.state[k]).filter(Boolean);
    const decision = s.state[key]
      ? paymentDecision({ recordedUrl: s.state[key], ref, knownUrls: known })
      : paymentDecision({ lookup: await customerPayments(s, known), ref, knownUrls: known });
    if (decision.action === 'reuse') {
      s.checks.push(`note: reusing ${key} from an earlier attempt of this run`);
      await openUrl(s, key, (p) => p.getByRole('heading', { level: 1 }));
      return decision.url;
    }
    if (decision.action === 'adopt') {
      s.checks.push(`note: adopting the payment ${ref} an earlier attempt of this run recorded`);
      await s.goto(decision.url, (p) => p.getByRole('heading', { level: 1 }));
      return decision.url;
    }
    if (decision.action === 'fail')
      throw new StepFailure(
        `Not recording payment ${ref}: ${decision.reason}. Check the payments by hand, or use a new label.`,
      );
    s.checks.push(`the payments lookup shows no payment ${ref} yet`);
    const url = await recordPayment(s, ref);
    if (url) return url;
    // The submit went out but the payment never opened: in next dev, compiling the payment page
    // reloads the form first (r3s2 sales-12). Look once more; only exactly this payment is adopted.
    const after = paymentDecision({
      lookup: await customerPayments(s, known),
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

  const recordPayment = async (s, ref) => {
    // next dev compiles the proof upload route on the first upload, and the rebuild reloads the
    // form, emptying it (r3s2 sales-12). A plain GET compiles the route first (it answers 405).
    const warm = await s.page
      .evaluate(() => fetch('/payments/proofs', { credentials: 'include' }).then((r) => r.status))
      .catch(() => 'failed');
    s.checks.push(`compiled the proof upload route first (GET ${warm})`);
    // Let the rebuild's reload of the current page pass before the form is opened.
    await s.page.waitForTimeout(3000);
    const uploaded = s.page.getByRole('list', { name: 'Uploaded proof' });
    // A fresh Record payment form, as a reload leaves it: the heading shows and the bank reference
    // this step typed is gone. Read only as evidence of a reload, never as a reason to submit again.
    const formReset = async () =>
      (await visible(h1(s.page, 'Record payment'))) &&
      (await s.page
        .getByLabel('Bank reference', { exact: true })
        .inputValue()
        .catch(() => ref)) !== ref;
    // Nothing is recorded before the Record payment click, so a form a reload emptied is filled
    // once more (noted).
    for (let attempt = 1; ; attempt++) {
      await s.goto('/payments/new', (p) => h1(p, 'Record payment'));
      await s.page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
      await s.choose('Customer', C);
      // Round 3 preselects NPR; picking the selected option again left the list open over the form.
      const currency = s.select('Currency');
      if ((await currency.count()) && !/NPR/.test(await currency.first().innerText()))
        await s.choose('Currency', 'NPR').catch(() => {});
      await s.fill('Amount received', '67800.00');
      await s.choose('Payment method', 'Bank transfer');
      await s.fill('Bank reference', ref);
      const tds = s.page.getByLabel('The customer withheld tax at source (TDS)');
      if (await tds.count())
        s.expect(!(await tds.first().isChecked()), 'Tax withheld / TDS is left unchecked');
      await s.caption(
        `${s.captionText.split(' — ')[0]} — add payment-proof.pdf and wait for the clean scan`,
      );
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
      // One submit, then wait for the redirect or the scan-pending refusal. Clicking again while
      // a submit is in flight could record the payment twice.
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
        // Only a form a reload reset is handed back to the caller's lookup (never submitted
        // again); a form still holding the values is a real failure.
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

  const verifyAndAllocate = async (s, paymentKey, receiptKey) => {
    await as(s, 'Dev Finance');
    await s.goto('/payments', (p) => h1(p, 'Payments'));
    // Payments list: open this run's payment row (by its id), else the payment itself.
    const id = s.need(paymentKey).split('/').pop();
    const link = s.page.locator(`a[href$="${id}"]`).first();
    if (await link.isVisible().catch(() => false)) await s.click(link, 'the payment row');
    else await openUrl(s, paymentKey, (p) => p.getByRole('heading', { level: 1 }));
    const verify = s.button('Verify payment');
    const receiptHeading = h1(s.page, RCPT);
    await s.see(verify.or(receiptHeading), 'Verify payment (or the receipt of an earlier attempt)');
    if (await receiptHeading.isVisible().catch(() => false)) {
      // Retry after verification: keep the receipt and allocate only if nothing is allocated.
      const receipt = RCPT.exec(await receiptHeading.first().innerText())[0];
      if (!s.state[receiptKey]) s.record(receiptKey, receipt);
      s.checks.push(`note: ${receipt} was verified by an earlier attempt of this run`);
      await s.see(s.page.getByText('Left on this payment'), 'the allocation panel');
      if ((await leftOnPayment(s)) > 0) await allocate(s);
      else s.checks.push('note: this payment was already allocated by an earlier attempt');
      return;
    }
    await s.click(verify, 'Verify payment');
    const dialog = s.page.getByRole('dialog', { name: 'Verify this payment' });
    await dialog.getByRole('button', { name: 'Verify payment', exact: true }).click();
    await s.see(receiptHeading, 'a receipt number (RCPT-…)', 90000);
    const receipt = RCPT.exec(await s.page.getByRole('heading', { level: 1 }).innerText())[0];
    s.record(receiptKey, receipt);
    await allocate(s);
  };

  /** "Left on this payment" on a payment page, as a number (null when the panel is absent). */
  const leftOnPayment = async (s) => {
    const m = /Left on this payment\s*NPR ([\d,]+\.\d{2})/.exec(await main(s));
    return m ? Number(m[1].replace(/,/g, '')) : null;
  };

  const allocate = async (s) => {
    const inv = s.need('invoiceNumber');
    await s.caption(`${s.captionText.split(' — ')[0]} — allocate 67,800.00 to ${inv}`);
    const panel = s.page.getByRole('region', { name: 'Allocate this payment', exact: true });
    await s.see(panel, 'the Allocate this payment panel');
    const allocations = s.page.getByRole('region', { name: 'Allocations', exact: true });
    // Active allocation rows carry a Deallocate action; reversals and reversed rows do not.
    const active = allocations.getByRole('button', { name: `Deallocate ${inv}`, exact: true });
    const before = await active.count();
    await s.fill(panel.getByRole('textbox', { name: `Amount to allocate to ${inv}` }), '67800.00');
    await s.pause(400);
    await s.click(
      panel.getByRole('button', { name: 'Allocate payment', exact: true }),
      'Allocate payment',
    );
    await s.see(active.nth(before), `a new allocation row for ${inv}`, 60000);
    s.expect((await active.count()) === before + 1, `exactly one new allocation to ${inv}`);
    const left = await leftOnPayment(s);
    s.expect(left === 0, 'nothing is left on this payment', `left ${left}`);
  };

  return {
    name: 'sales',
    title: 'Lead → quotation → sales order → invoice → payment',
    // The origins whose certificates are checked before launch.
    origins: ['app', 'mail'],
    steps: [
      {
        id: 'sales-1',
        title: 'Create and qualify the lead',
        async run(s) {
          // Not repeatable: a second lead would carry the same unique name.
          if (s.state.leadUrl)
            throw new StepFailure(
              "sales-1 already created this run's lead in an earlier attempt; it is not created twice. " +
                'Resume from sales-2 if the lead reached Qualified, otherwise use a new label.',
            );
          await as(s, 'Dev Sales');
          // A lead an earlier attempt created but did not record (stopped right after Create lead)
          // is found by its exact title. It is recorded, and the step stops as above.
          const listed = await s.exactLinks(
            await s.loadList(`/leads?q=${encodeURIComponent(v.leadTitle)}`, {
              heading: 'Leads',
              table: 'Leads',
              empty: ['No leads match', 'No leads yet'],
            }),
            v.leadTitle,
          );
          if (listed.length > 1)
            throw new StepFailure(
              `${listed.length} leads carry this run's title (${listed.join(', ')}); use a new label.`,
            );
          if (listed.length === 1) {
            s.record('leadUrl', listed[0]);
            throw new StepFailure(
              `This run's lead ${listed[0]} exists already (an earlier attempt stopped before ` +
                'recording it); it is recorded now and not created twice. Resume from sales-2 if it ' +
                'reached Qualified, otherwise use a new label.',
            );
          }
          await s.goto('/leads/new', (p) =>
            p.getByRole('textbox', { name: 'Lead title', exact: true }),
          );
          await s.page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
          await s.fill(
            s.page.getByRole('textbox', { name: 'Lead title', exact: true }),
            v.leadTitle,
          );
          // Round 3: the trigger is labelled by its value and the field ("Choose a source Lead source").
          await s.choose(s.select(/(^| )Lead source$/), 'Referral');
          await s.fill(
            s.page.getByRole('textbox', { name: 'Company or organization', exact: true }),
            v.company,
          );
          await s.fill('Contact person', v.contact);
          await s.pause();
          await s.click(s.button('Create lead'), 'Create lead');
          await s.see(h1(s.page, L), 'the saved lead', cfg.navTimeout);
          s.record('leadUrl', s.page.url().split('?')[0].replace(cfg.appUrl, ''));

          await s.caption('sales-1 — log the discovery call');
          await s.page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
          await s.fill(
            'What it was about',
            'Demo discovery call completed; two service units requested.',
          );
          await s.click(s.button('Log activity'), 'Log activity');
          await s.seeText('Activity logged.');
          await s.see(
            s.page.getByText('Demo discovery call completed; two service units requested.'),
            'the activity in history',
          );

          await s.caption('sales-1 — Move to Contacted, then Qualify → Qualify lead');
          await s.choose(s.select('stage', { byName: true }), 'Contacted');
          await s.click(s.button('Move'), 'Move');
          await s.seeText('Moved to Contacted.');
          await s.click(s.button('Qualify'), 'Qualify');
          await s.page
            .getByRole('dialog', { name: 'Qualify this lead?' })
            .getByRole('button', { name: 'Qualify lead', exact: true })
            .click();
          await s.seeText('Moved to Qualified.');
          await s.page.reload({ waitUntil: 'domcontentloaded' });
          await s.see(status(s, 'Qualified'), 'stage Qualified after a reload');
          await s.see(
            s.page.getByText('Demo discovery call completed; two service units requested.'),
            'the activity persists',
          );
        },
      },
      {
        id: 'sales-2',
        title: 'Convert to customer and opportunity',
        async run(s) {
          await as(s, 'Dev Sales');
          // Retry-safe: an earlier attempt that converted the lead recorded the opportunity.
          // Round 3: Convert stays on the lead, now Converted, which links to its opportunity.
          const openOpportunity = s.page.getByRole('link', {
            name: 'Open the opportunity',
            exact: true,
          });
          const toOpportunity = async () => {
            await s.click(openOpportunity, 'Open the opportunity');
            await s.page.waitForURL(/\/opportunities\/[0-9a-f-]{36}/, { timeout: cfg.navTimeout });
            s.record('opportunityUrl', s.page.url().split('?')[0].replace(cfg.appUrl, ''));
          };
          if (!s.state.opportunityUrl) {
            await openUrl(s, 'leadUrl', (p) =>
              p
                .getByRole('button', { name: 'Convert to opportunity' })
                .or(p.getByRole('link', { name: 'Open the opportunity', exact: true })),
            );
          }
          if (!s.state.opportunityUrl && (await visible(openOpportunity))) {
            // An earlier attempt converted this run's lead before recording the opportunity.
            s.checks.push('note: the lead was converted by an earlier attempt of this run');
            await toOpportunity();
          }
          if (!s.state.opportunityUrl) {
            await s.click(s.button('Convert to opportunity'), 'Convert to opportunity');
            const d = s.page.getByRole('dialog', { name: 'Convert lead to opportunity' });
            await s.see(d, 'the Convert dialog');
            await d.getByLabel('Create a new organization').check();
            const fill = async (label, value) => {
              await d.getByLabel(label, { exact: true }).fill(value);
            };
            await fill('Legal name', v.company);
            await fill('PAN or VAT number', v.pan);
            await fill('Address', '17 Demo Marg');
            await fill('City', 'Kathmandu');
            // FX9: Country is the AddressFields CountrySelect, a searchable combobox. Typing highlights the best
            // match and Enter takes it; the list is in a popover outside the dialog, so no option click is scoped to d.
            const country = d.getByRole('combobox', { name: 'Country', exact: true });
            await country.fill('Nepal');
            await country.press('Enter');
            s.expect((await country.inputValue()) === 'Nepal', 'the Country box shows Nepal');
            const newContact = d.getByLabel('Create a new contact');
            if (await newContact.count()) await newContact.check();
            await fill('Contact name', v.contact);
            await fill('Email', v.email);
            s.record('contactEmail', v.email);
            await fill('Opportunity name', v.leadTitle);
            await s.pause();
            await d.getByRole('button', { name: 'Convert', exact: true }).click();
            // Older builds redirect to the opportunity; round 3 shows the Converted lead instead.
            const outcome = await Promise.race([
              s.page
                .waitForURL(/\/opportunities\/[0-9a-f-]{36}/, { timeout: cfg.navTimeout })
                .then(() => 'opportunity')
                .catch(() => 'timeout'),
              openOpportunity
                .first()
                .waitFor({ state: 'visible', timeout: cfg.navTimeout })
                .then(() => 'lead')
                .catch(() => 'timeout'),
            ]);
            if (outcome === 'timeout')
              throw new StepFailure(
                'Convert neither opened the opportunity nor showed the converted lead',
              );
            if (outcome === 'opportunity')
              s.record('opportunityUrl', s.page.url().split('?')[0].replace(cfg.appUrl, ''));
            else {
              await s.see(status(s, 'Converted'), 'lead stage Converted after Convert');
              await toOpportunity();
            }
          }
          // Checked on every attempt, also when an earlier attempt converted the lead.
          if (new URL(s.page.url()).pathname !== s.state.opportunityUrl)
            await openUrl(s, 'opportunityUrl', (p) => h1(p, L));
          await s.see(h1(s.page, L), 'the linked opportunity');
          await s.see(status(s, 'Qualified'), 'opportunity stage Qualified');
          const text = await main(s);
          s.expect(C.test(text), 'the opportunity names the new customer');
          await s.caption('sales-2 — the lead is Converted');
          await openUrl(s, 'leadUrl', (p) => h1(p, L));
          await s.see(status(s, 'Converted'), 'lead stage Converted');
          const customerHref = await s.page
            .getByRole('link', { name: C })
            .first()
            .getAttribute('href')
            .catch(() => null);
          if (customerHref) s.record('customerUrl', customerHref);

          await s.caption(
            'sales-2 — Opportunities board: Won and Quotation Sent are not manual moves',
          );
          await s.goto('/opportunities?view=board', (p) => h1(p, 'Opportunities'));
          await s.see(
            s.page.getByRole('region', { name: 'Won' }).getByText('Set by the system'),
            'Won is set by the system',
          );
          await s.see(
            s.page.getByRole('region', { name: 'Quotation Sent' }).getByText('Set by the system'),
            'Quotation Sent is set by the system',
          );
          const card = s.page.getByRole('link', { name: L });
          await s.see(card, 'this run’s opportunity card');
          // The card's own "Move to" select: the nearest ancestor of the card link that has one.
          const trigger = card
            .first()
            .locator('xpath=ancestor::*[.//button[@aria-haspopup="listbox"]][1]')
            .locator('button[aria-haspopup="listbox"]')
            .filter({ visible: true })
            .first();
          if (await trigger.count()) {
            await s.click(trigger, 'the card’s Move choices');
            const opts = (await s.page.getByRole('option').allInnerTexts()).map((t) => t.trim());
            await s.page.keyboard.press('Escape');
            s.expect(
              !opts.some((o) => /^(Won|Quotation Sent)/.test(o)),
              'Move choices exclude Won and Quotation Sent',
              opts.join(' | '),
            );
          } else
            s.checks.push(
              'card has no Move control in this layout; the region labels were checked',
            );
          await s.click(card, 'reopen the opportunity');
          await s.see(h1(s.page, L), 'the opportunity reopened');
        },
      },
      {
        id: 'sales-3',
        title: 'Open business verification',
        async run(s) {
          // Not repeatable: the case exists, and its "Submit refused" check holds only before uploads.
          if (s.state.verificationUrl)
            throw new StepFailure(
              "sales-3 already started this run's verification case in an earlier attempt. Resume from sales-4.",
            );
          await as(s, 'Dev Sales');
          // next dev compiles a route on its first visit, and the rebuild (Fast Refresh) reloads
          // the open page: a click on a not-yet-compiled customer page was undone by a reload of
          // the list. A plain GET of the page sales-2 recorded compiles it before the click.
          if (s.state.customerUrl) {
            const warm = await s.page
              .evaluate(
                (url) => fetch(url, { credentials: 'include' }).then((r) => r.status),
                s.state.customerUrl,
              )
              .catch(() => 'failed');
            s.checks.push(`compiled the customer page first (GET ${warm})`);
          }
          await s.goto('/customers', (p) => p.getByLabel('Search organizations'));
          await s.fill('Search organizations', v.company);
          const searchButton = s.button('Search').or(s.button('Apply'));
          if (await visible(searchButton)) await s.click(searchButton, 'Search');
          else {
            // Round 3: a search field with no button; Enter submits it.
            await s.page.getByLabel('Search organizations', { exact: true }).press('Enter');
            await s.page.waitForURL((u) => u.searchParams.get('q') === v.company, {
              timeout: cfg.navTimeout,
            });
            s.checks.push('searched with Enter (the list has no Search button)');
          }
          const row = s.page.getByRole('link', { name: C }).first();
          await s.see(row, `the customer ${v.company} in the results`);
          // The live search navigates in a transition (form aria-busy); a click while it is still
          // pending can be overtaken by it, so wait for the list to settle first.
          await s.page
            .locator('form[role="search"][aria-busy="true"]')
            .waitFor({ state: 'detached', timeout: cfg.navTimeout })
            .catch(() => {});
          const customerPage = h1(s.page, C);
          // A dev-server rebuild can still reload the list under the click (see above). A plain
          // link, so clicking it again changes nothing; at most three clicks, each noted.
          for (let attempt = 1; ; attempt++) {
            await s.click(row, attempt === 1 ? 'open the customer' : 'open the customer again');
            const opened = await customerPage
              .first()
              .waitFor({ state: 'visible', timeout: 45000 })
              .then(() => true)
              .catch(() => false);
            if (opened || attempt === 3 || !(await visible(row))) break;
            s.checks.push(
              `note: click ${attempt} on the customer did not leave the list (dev-server reload); clicking again`,
            );
          }
          await s.see(customerPage, 'the customer page', cfg.navTimeout);
          s.record('customerUrl', s.page.url().split('?')[0].replace(cfg.appUrl, ''));
          const owner = await main(s);
          if (/Owner name unavailable/.test(owner))
            s.finding(
              'Customer page shows "Owner name unavailable" to Dev Sales (I-13 again)',
              'normal',
            );

          await s.click(s.button('Start verification'), 'Start verification');
          await s.page.waitForURL(/\/verification\/[0-9a-f-]{36}$/, { timeout: cfg.navTimeout });
          s.record('verificationUrl', s.page.url().replace(cfg.appUrl, ''));
          await s.see(
            s.page.getByRole('table', { name: 'Verification documents' }),
            'the evidence checklist',
          );
          for (const [label] of DOCS)
            await s.see(
              s.page.getByRole('rowheader', { name: label, exact: true }),
              `checklist item ${label}`,
            );
          await s.caption('sales-3 — Submit for review before attaching anything is refused');
          const submit = s.button('Submit for review');
          await s.see(submit, 'Submit for review');
          s.expect(
            (await submit.first().getAttribute('aria-disabled')) === 'true',
            'Submit for review is refused while required documents are missing',
          );
          await s.see(
            s.page.getByText('Required before submitting').or(s.page.getByText(/^Missing:/)),
            'the required-documents message',
          );
        },
      },
      {
        id: 'sales-4',
        title: 'Attach the three required documents',
        timeoutMs: 420000,
        async run(s) {
          await as(s, 'Dev Sales');
          await openUrl(s, 'verificationUrl', (p) =>
            p.getByRole('table', { name: 'Verification documents' }),
          );
          // Retry-safe: a submitted case reads Awaiting review (or Verified once decided).
          if (
            (await visible(status(s, 'Awaiting review'))) ||
            (await visible(status(s, 'Verified')))
          ) {
            s.checks.push('note: the case was submitted by an earlier attempt of this run');
            return optionalStaysMissing(s);
          }
          for (const [label, file] of DOCS) {
            await s.caption(`sales-4 — Upload ${label}: ${file}, then Save`);
            const row = s.page
              .getByRole('row')
              .filter({ has: s.page.getByRole('rowheader', { name: label, exact: true }) });
            // Retry-safe: a row that already holds this run's file offers Change, not Upload.
            if (
              !(await visible(row.getByRole('button', { name: `Upload ${label}` }))) &&
              (await visible(row.getByRole('button', { name: /^Change/ })))
            ) {
              s.checks.push(`note: ${label} was uploaded by an earlier attempt of this run`);
              continue;
            }
            await s.chooseFile(
              row.getByRole('button', { name: `Upload ${label}` }),
              demoFile(cfg, file),
            );
            const editor = s.page.getByRole('dialog', { name: file });
            await s.see(
              editor.getByRole('button', { name: 'Save', exact: true }),
              `the ${file} preview with Save`,
              90000,
            );
            await s.pause(400);
            await editor.getByRole('button', { name: 'Save', exact: true }).click();
            await editor.waitFor({ state: 'hidden', timeout: 60000 });
            await s.see(row.getByText('Pending', { exact: true }), `${label} is Pending`);
          }
          await s.caption('sales-4 — wait for each file to read Virus free');
          for (let i = 0; i < 24; i++) {
            const clean = await s.page.getByText('Virus free', { exact: true }).count();
            if (clean >= DOCS.length) break;
            await s.page.waitForTimeout(5000);
            if (i % 4 === 3) await s.page.reload({ waitUntil: 'domcontentloaded' });
          }
          s.expect(
            (await s.page.getByText('Virus free', { exact: true }).count()) >= DOCS.length,
            'all three files read Virus free',
          );
          // A resumed row is skipped when it holds any file: before submitting, each row must hold
          // this run's fixture (its Remove button names the file) and read Virus free.
          for (const [label, file] of DOCS) {
            const row = s.page
              .getByRole('row')
              .filter({ has: s.page.getByRole('rowheader', { name: label, exact: true }) });
            if (!(await visible(row.getByRole('button', { name: `Remove ${file}`, exact: true }))))
              throw new StepFailure(
                `${label} does not hold ${file} (another file, or its name is not shown); not submitting`,
              );
            s.expect(
              await visible(row.getByText('Virus free', { exact: true })),
              `${label} holds ${file} and reads Virus free`,
            );
          }
          await s.click(s.button('Submit for review'), 'Submit for review');
          await s.page
            .getByRole('dialog')
            .getByRole('button', { name: 'Submit for review', exact: true })
            .click();
          await s.see(status(s, 'Awaiting review'), 'the case is Awaiting review', 60000);
          await optionalStaysMissing(s);
        },
      },
      {
        id: 'sales-5',
        title: 'Independently approve customer verification',
        async run(s) {
          await as(s, 'Dev Founder');
          await s.goto('/verification', (p) => h1(p, 'Verification'));
          const caseLink = s.page
            .locator(`a[href$="${s.need('verificationUrl').split('/').pop()}"]`)
            .first();
          if (await caseLink.isVisible().catch(() => false))
            await s.click(caseLink, 'the case in the queue');
          else
            await openUrl(s, 'verificationUrl', (p) =>
              p.getByRole('table', { name: 'Verification documents' }),
            );
          await s.see(s.page.getByRole('table', { name: 'Verification documents' }), 'the case');
          // Retry-safe: skip what an earlier attempt already decided.
          if (await visible(s.page.getByText('This customer is verified.'))) {
            s.checks.push('note: the customer was approved by an earlier attempt of this run');
          } else {
            const final = s.button('Approve customer');
            const docRow = (label) =>
              s.page
                .getByRole('row')
                .filter({ has: s.page.getByRole('rowheader', { name: label, exact: true }) });
            let accepted = 0;
            for (const [label] of DOCS)
              if (await visible(docRow(label).getByText('Accepted', { exact: true }))) accepted++;
            if (accepted === 0)
              s.expect(
                (await final.first().getAttribute('aria-disabled')) === 'true',
                'Approve customer waits for the per-document approvals',
              );
            else s.checks.push(`note: ${accepted} document(s) accepted by an earlier attempt`);
            for (const [label] of DOCS) {
              const row = docRow(label);
              if (await visible(row.getByText('Accepted', { exact: true }))) continue;
              await s.caption(`sales-5 — approve ${label}`);
              await s.click(
                row.getByRole('button', { name: `Approve ${label}` }),
                `Approve ${label}`,
              );
              await s.see(row.getByText('Accepted', { exact: true }), `${label} Accepted`);
            }
            await s.caption('sales-5 — Approve customer with the reason');
            await s.click(final, 'Approve customer');
            const dialog = s.page.getByRole('dialog', { name: 'Approve this customer?' });
            await dialog
              .getByLabel('Reason', { exact: true })
              .fill('Demo registration, tax and signatory documents independently checked.');
            await s.pause(400);
            await dialog.getByRole('button', { name: 'Approve customer', exact: true }).click();
            await s.seeText('This customer is verified.');
          }
          await s.caption('sales-5 — the customer shows the approved verification');
          await openUrl(s, 'customerUrl', (p) => h1(p, C));
          const text = await main(s);
          s.expect(
            /Verified|Approved/.test(text),
            'the customer shows its verification approved',
            text.slice(0, 300),
          );
        },
      },
      {
        id: 'sales-6',
        title: 'Build and price the quotation',
        async run(s) {
          // Not repeatable: a second quotation would be built on the same opportunity.
          if (s.state.quotationEditUrl)
            throw new StepFailure(
              "sales-6 already built this run's quotation in an earlier attempt; it is not built twice. " +
                'Resume from sales-7, or use a new label.',
            );
          await as(s, 'Dev Sales');
          await openUrl(s, 'opportunityUrl', (p) => h1(p, L));
          const start = s.page
            .getByRole('link', { name: 'New quotation' })
            .or(s.button('New quotation'));
          await s.click(start, 'New quotation');
          await s.see(h1(s.page, 'New quotation'), 'the quotation builder', cfg.navTimeout);
          await s.page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
          if (await s.select('Currency').count()) await s.choose('Currency', 'NPR').catch(() => {});
          await s.click(
            s.button('Add the first line').or(s.button('Add line')),
            'Add the first line',
          );
          const add = s.page.getByRole('dialog', { name: 'Add line' });
          await add.getByLabel('Description').fill('BOS Demo implementation service');
          await add.getByLabel('Unit', { exact: true }).fill('lot');
          await add.getByRole('spinbutton', { name: 'Quantity' }).fill('2');
          await add.getByRole('spinbutton', { name: /^Rate \(/ }).fill('60000.00');
          await s.choose(s.select('Tax code', { scope: add }), /VAT13|VAT 13/);
          await s.pause(400);
          await add.getByRole('button', { name: 'Add line', exact: true }).click();
          const lines = s.page.getByRole('table', { name: 'Quotation lines' });
          await s.see(lines.getByText('BOS Demo implementation service'), 'the line in the table');

          await s.caption('sales-6 — milestone Advance 50%: the 100% schedule rule');
          await s.click(s.button('Add milestone'), 'Add milestone');
          await s.fill('Milestone 1', 'Advance');
          const percent = s.page.getByRole('spinbutton', { name: 'Percent (%)' });
          await percent.fill('50');
          await s.click(s.button('Save draft'), 'Save draft');
          await s.see(
            s.page.getByText(/The payment schedule must add up to 100%/),
            'the 100%-schedule validation',
          );
          await s.pause();
          await percent.fill('100');
          await s.click(s.button('Save draft'), 'Save draft');
          await s.page.waitForURL(/\/quotations\/[^/]+\/edit/, { timeout: cfg.navTimeout });
          await s.see(
            s.page.getByText('Draft saved.').or(s.page.getByText('All changes saved')),
            'Draft saved',
          );
          s.record('quotationEditUrl', s.page.url().split('?')[0].replace(cfg.appUrl, ''));
          s.record('quotationUrl', s.state.quotationEditUrl.replace(/\/edit$/, ''));
          const totals = s.page.getByRole('complementary', { name: 'Totals' });
          const grand = totals.getByText('Grand total', { exact: true });
          // r3s1: after the first Save draft the panel stayed on "Updating totals" (the preview
          // request had answered 200), while a fresh load showed the totals. The step keeps
          // failing then; the reload only tells the finding which of the two it was.
          const priced = await grand
            .first()
            .waitFor({ state: 'visible', timeout: cfg.navTimeout })
            .then(() => true)
            .catch(() => false);
          if (!priced) {
            const stuck = await visible(totals.getByText('Updating totals', { exact: true }));
            await s.page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
            const afterReload = await grand
              .first()
              .waitFor({ state: 'visible', timeout: cfg.navTimeout })
              .then(() => true)
              .catch(() => false);
            s.finding(
              `After the first Save draft the Totals panel ${stuck ? 'stayed on "Updating totals"' : 'showed no totals'} ` +
                `for ${cfg.navTimeout / 1000} s; after a reload the totals ${afterReload ? 'appeared' : 'were still missing'}`,
              'normal',
            );
            throw new StepFailure(
              'The quotation builder did not show the server totals after saving',
            );
          }
          s.checks.push('saw: server totals');
          const t = await s.text(totals);
          s.expect(hasAmount(t, 120000), 'subtotal NPR 120,000', t);
          s.expect(hasAmount(t, 15600), 'VAT NPR 15,600', t);
          s.expect(hasAmount(t, 135600), 'total NPR 135,600', t);
          await s.see(
            s.page.getByRole('heading', { name: 'Approval requirements' }),
            'the approval requirements',
          );
        },
      },
      {
        id: 'sales-7',
        title: 'Submit and approve the quote',
        timeoutMs: 480000,
        async run(s) {
          await as(s, 'Dev Sales');
          const frozen = (p) => p.getByText('This version can no longer be edited');
          await openUrl(s, 'quotationEditUrl', (p) =>
            p.getByRole('button', { name: 'Submit for approval', exact: true }).or(frozen(p)),
          );
          let number = s.state.quotationNumber;
          if (await visible(frozen(s.page))) {
            // Retry-safe: an earlier attempt submitted it; only the approvals may remain.
            number ??= QT.exec(await main(s))?.[0];
            s.expect(number, 'the submitted quotation has a number');
            if (!s.state.quotationNumber) s.record('quotationNumber', number);
            s.checks.push('note: the quotation was submitted by an earlier attempt of this run');
          } else {
            await s.caption(
              'sales-7 — read the route: Accountant → Finance → Management (over NPR 1,00,000)',
            );
            const reqHeading = s.page.getByRole('heading', { name: 'Approval requirements' });
            await s.see(reqHeading, 'Approval requirements');
            // The requirements load after the heading. Ready = the "Approval steps" list is shown
            // and neither "Checking approval requirements" nor "Updating totals" is. The approver
            // picker ("Approver for step 1") appears only when the first step has eligible people.
            const steps = s.page.getByRole('list', { name: 'Approval steps', exact: true });
            const loading = ['Checking approval requirements', 'Updating totals'].map((t) =>
              s.page.getByText(t, { exact: true }),
            );
            await s.see(steps, 'the approval steps');
            for (const l of loading)
              await l
                .first()
                .waitFor({ state: 'hidden', timeout: cfg.navTimeout })
                .catch(() => {});
            s.expect(
              !(await visible(loading[0])) && !(await visible(loading[1])),
              'the approval requirements finished loading',
            );
            const r = await s.text(steps.first());
            // The panel (heading, steps, picker, and the warning when a step has nobody eligible).
            const panel = await s.text(
              s.page
                .locator('section, aside, div')
                .filter({ has: reqHeading })
                .filter({ has: steps })
                .last(),
            );
            const blockedAt = panel.indexOf('An approval step has no eligible approvers');
            const blockReason = blockedAt >= 0 ? panel.slice(blockedAt) : '';
            const picker = await visible(s.page.getByText('Approver for step 1').first());
            s.checks.push(
              `approval steps: ${r.slice(0, 200)}` +
                (picker ? ' (approver picker shown)' : ' (no approver picker)') +
                (blockReason ? `; blocked: ${blockReason.slice(0, 160)}` : ''),
            );
            const a = r.search(/accountant/i);
            const f = r.search(/finance/i);
            const m = r.search(/manager|management/i);
            s.expect(
              a >= 0 && f > a && m > f,
              'route Accountant → Finance → Management',
              r.slice(0, 300),
            );
            s.expect(!/founder/i.test(r), 'no Founder step at this amount', r.slice(0, 300));
            await s.pause();
            await s.click(s.button('Submit for approval'), 'Submit for approval');
            const confirm = s.page.getByRole('dialog', {
              name: 'Submit this quotation for approval?',
            });
            await s.pause();
            // Through s.click (hydration wait): on round 3 a raw click on the freshly opened dialog
            // left the quotation in Draft with no submit reaching the API; by hand it submits.
            await s.click(
              confirm.getByRole('button', { name: 'Submit quotation' }),
              'Submit quotation',
            );
            const submitted = await s.page
              .waitForURL(/[?&]submitted=1/, { timeout: cfg.navTimeout })
              .then(() => true)
              .catch(() => false);
            if (!submitted) {
              const said = await s.page
                .locator('[role="dialog"], [role="alert"]')
                .allInnerTexts()
                .catch(() => []);
              throw new StepFailure(
                `Submit quotation did not submit; the page says: ${said.join(' | ').replace(/\s+/g, ' ').slice(0, 300) || '(nothing)'}`,
              );
            }
            await s.see(status(s, 'Approval pending'), 'Approval pending');
            number = QT.exec(await main(s))?.[0];
            s.expect(number, 'the quotation has a number');
            s.record('quotationNumber', number);
            await s.notVisible(s.button('Approve'), 'an Approve button for the author');
          }

          // Each approver once; an approval an earlier attempt gave is not given again.
          const k = 'quotationApprovals';
          const done = quotePastApproval;
          await approveOnce(s, k, 'Dev Accountant', number, 'Demo quote pricing checked.', done);
          await approveOnce(s, k, 'Dev Finance', number, 'Demo quote budget approved.', done);
          await approveOnce(
            s,
            k,
            'Dev Management',
            number,
            'Demo threshold approval complete.',
            done,
          );
          await s.caption('sales-7 — the quotation is Approved');
          await openUrl(s, 'quotationUrl', (p) => p.getByRole('heading', { level: 1 }));
          // A re-run after sales-8/9 finds it Sent or Accepted: later steps' effects.
          const later =
            (await visible(status(s, 'Sent'))) || (await visible(status(s, 'Accepted')));
          if (later) s.checks.push('note: the quotation already moved past Approved (later steps)');
          else await s.see(status(s, 'Approved'), 'quotation status Approved');
        },
      },
      {
        id: 'sales-8',
        title: 'Download and send the quote',
        timeoutMs: 360000,
        async run(s) {
          await as(s, 'Dev Sales');
          await s.goto('/quotations', (p) => h1(p, 'Quotations'));
          const link = s.page.getByRole('link', { name: s.need('quotationNumber') }).first();
          if (await link.isVisible().catch(() => false))
            await s.click(link, 'the quotation in the list');
          else await openUrl(s, 'quotationUrl', (p) => p.getByRole('heading', { level: 1 }));
          await s.see(s.page.getByRole('heading', { level: 1 }), 'the quotation');
          await s.page.waitForTimeout(1500);
          // Retry-safe: an earlier attempt may already have sent it (Sent, or Accepted after sales-9);
          // then only the checks remain.
          if ((await visible(status(s, 'Sent'))) || (await visible(status(s, 'Accepted'))))
            s.checks.push('note: the quotation was sent by an earlier attempt of this run');
          else await downloadAndSend(s);

          await s.caption('sales-8 — Test mail: portal link, no attachment');
          const to = contactEmailFor(s.state, v);
          const mail = await findMail(cfg, `to:"${to}"`, 90000, { signal: s.signal });
          s.expect(mail, `a Mailpit message to ${to}`);
          const full = await mailMessage(cfg, mail.ID, { signal: s.signal });
          s.expect(
            (full.Attachments ?? []).length === 0,
            'the e-mail has no attachment',
            String((full.Attachments ?? []).length),
          );
          s.expect(
            /https?:\/\/\S*portal/i.test(full.Text ?? full.HTML ?? ''),
            'the e-mail has a portal link',
          );
          await s.goto(`${cfg.mailUrl}/view/${mail.ID}`, (p) =>
            p.getByText(mail.Subject).filter({ visible: true }).first(),
          );
          await s.pause(1500);
          await openUrl(s, 'opportunityUrl', (p) => h1(p, L));
          await s.see(status(s, 'Quotation Sent'), 'opportunity stage Quotation Sent');
        },
      },
      {
        id: 'sales-9',
        title: 'Record customer acceptance with evidence',
        async run(s) {
          await as(s, 'Dev Sales');
          await openUrl(s, 'quotationUrl', (p) =>
            p
              .getByRole('button', { name: 'Record outcome' })
              .or(p.getByText('Accepted', { exact: true })),
          );
          // Retry-safe: an outcome an earlier attempt recorded is not recorded again.
          if (await visible(status(s, 'Accepted'))) {
            s.checks.push('note: acceptance was recorded by an earlier attempt of this run');
          } else {
            await s.click(s.button('Record outcome'), 'Record outcome');
            const d = s.page.getByRole('dialog', { name: /^Record the outcome of / });
            await d.getByLabel('Accepted').check();
            await d.getByLabel('Signed quotation').check();
            await d
              .getByLabel('Comment')
              .fill(
                'Anu accepted the demo quotation; signed-quotation.pdf is the demonstration evidence.',
              );
            await s.pause(400);
            await d.getByRole('button', { name: 'Record outcome' }).click();
            await s.see(
              d.getByRole('status').filter({ hasText: /Recorded as accepted/i }),
              'Recorded as accepted',
              60000,
            );
            await d.getByRole('button', { name: 'Done' }).click();
          }
          await s.see(status(s, 'Accepted'), 'quotation Accepted');
          await openUrl(s, 'opportunityUrl', (p) => h1(p, L));
          await s.see(status(s, 'Won'), 'opportunity Won');
        },
      },
      {
        id: 'sales-10',
        title: 'Confirm the sales order',
        async run(s) {
          await as(s, 'Dev Founder');
          // Round 3: Confirm order stays on the Sales orders list; this run's order is the row
          // whose Quotation cell is exactly this run's quotation number.
          const qt = s.need('quotationNumber');
          const orderRow = s.page
            .getByRole('row')
            .filter({ has: s.page.getByRole('cell', { name: qt, exact: true }) });
          const openOrder = async () => {
            const n = await orderRow.count();
            if (n !== 1)
              throw new StepFailure(`${n} sales orders list quotation ${qt}; expected exactly one`);
            await s.click(
              orderRow.getByRole('link', { name: SO }).first(),
              'this run’s sales order',
            );
            await s.page.waitForURL(/\/sales-orders\/[0-9a-f-]{36}/, { timeout: cfg.navTimeout });
            s.record('salesOrderUrl', s.page.url().split('?')[0].replace(cfg.appUrl, ''));
          };
          if (!s.state.salesOrderUrl) {
            await s.goto('/sales-orders', (p) =>
              p.getByRole('button', { name: 'Confirm from quotation' }),
            );
            if (await visible(orderRow)) {
              // An earlier attempt confirmed the order before recording it.
              s.checks.push(`note: the order for ${qt} was confirmed by an earlier attempt`);
              await openOrder();
            }
          }
          if (s.state.salesOrderUrl) {
            // Retry after the order was already confirmed: open it instead of confirming twice.
            await openUrl(s, 'salesOrderUrl', (p) => h1(p, 'Sales order'));
          } else {
            await s.click(s.button('Confirm from quotation'), 'Confirm from quotation');
            const d = s.page.getByRole('dialog', { name: 'Confirm a sales order' });
            await s.choose(
              s.select('Accepted quotation', { scope: d }).or(d.getByLabel('Accepted quotation')),
              runMatch(s.need('quotationNumber')),
            );
            await s.pause(400);
            await s.click(d.getByRole('button', { name: 'Confirm order' }), 'Confirm order');
            const outcome = await Promise.race([
              s.page
                .waitForURL(/\/sales-orders\/[0-9a-f-]{36}/, { timeout: cfg.navTimeout })
                .then(() => 'order')
                .catch(() => 'timeout'),
              orderRow
                .first()
                .waitFor({ state: 'visible', timeout: cfg.navTimeout })
                .then(() => 'list')
                .catch(() => 'timeout'),
            ]);
            if (outcome === 'timeout')
              throw new StepFailure('Confirm order neither opened the order nor listed it');
            if (outcome === 'order')
              s.record('salesOrderUrl', s.page.url().split('?')[0].replace(cfg.appUrl, ''));
            else await openOrder();
          }
          await s.see(status(s, 'Confirmed'), 'order Confirmed');
          const text = await main(s);
          const so = SO.exec(text)?.[0];
          if (so) s.record('salesOrderNumber', so);
          const quoteHref = await s.page
            .getByRole('link', { name: 'View quotation' })
            .first()
            .getAttribute('href')
            .catch(() => null);
          s.expect(
            quoteHref === s.need('quotationUrl'),
            'the order links to the accepted quotation (View quotation)',
            `href ${quoteHref}`,
          );
          s.expect(text.includes('BOS Demo implementation service'), 'the copied line');
          s.expect(hasAmount(text, 135600), 'order total NPR 135,600');
          await s.see(
            s.page.getByRole('heading', { name: 'Billing schedule' }),
            'the billing schedule',
          );
          await s.see(s.page.getByText('Ready to bill').first(), 'Advance is Ready to bill');

          await s.caption('sales-10 — Draft invoice on the 100% Advance, then Open invoice');
          if (s.state.invoiceUrl) {
            await openUrl(s, 'invoiceUrl', (p) => p.getByRole('main'));
            return checkDraft(s);
          }
          await s.click(s.page.getByRole('button', { name: /^Draft invoice/ }), 'Draft invoice');
          const open = s.page.getByRole('link', { name: 'Open invoice' });
          await Promise.race([
            s.page.waitForURL(/\/invoices\/[0-9a-f-]{36}/, { timeout: cfg.navTimeout }),
            open.first().waitFor({ state: 'visible', timeout: cfg.navTimeout }),
          ]);
          if (!/\/invoices\//.test(s.page.url())) await s.click(open, 'Open invoice');
          await s.page.waitForURL(/\/invoices\/[0-9a-f-]{36}/, { timeout: cfg.navTimeout });
          s.record('invoiceUrl', s.page.url().split('?')[0].replace(cfg.appUrl, ''));
          await checkDraft(s);
        },
      },
      {
        id: 'sales-11',
        title: 'Approve and issue the tax invoice',
        timeoutMs: 480000,
        async run(s) {
          if (s.state.invoiceNumber) {
            // Retry after the invoice was issued: only the PDF and receivables checks remain.
            await as(s, 'Dev Finance');
            await openUrl(s, 'invoiceUrl', (p) => p.getByText(s.state.invoiceNumber).first());
          } else {
            await as(s, 'Dev Founder');
            const submit = (p) =>
              p.getByRole('button', { name: 'Submit for approval', exact: true });
            const issued = (p) => p.getByRole('heading', { level: 1, name: INV });
            await openUrl(s, 'invoiceUrl', (p) =>
              submit(p)
                .or(p.getByText('Awaiting approval', { exact: true }))
                .or(p.getByRole('button', { name: 'Issue tax invoice' }))
                .or(issued(p)),
            );
            if (await visible(issued(s.page))) {
              // Issued by an earlier attempt that stopped before it recorded the number.
              s.record('invoiceNumber', INV.exec(await issued(s.page).first().innerText())[0]);
              s.checks.push('note: the invoice was issued by an earlier attempt of this run');
              await as(s, 'Dev Finance');
              await openUrl(s, 'invoiceUrl', (p) => p.getByText(s.state.invoiceNumber).first());
            }
          }
          if (!s.state.invoiceNumber) {
            s.expect(!INV.test(await main(s)), 'no invoice number before it is issued');
            // Retry-safe: a re-run after the submit went through finds it past the draft.
            if (await visible(s.button('Submit for approval'))) {
              await invoiceAction(s, 'Submit for approval', /^Submit /, 'Submit for approval');
              await s.see(status(s, 'Awaiting approval'), 'invoice Awaiting approval', 60000);
            } else
              s.checks.push('note: the invoice was submitted by an earlier attempt of this run');

            // Each approver once; an approval an earlier attempt gave is not given again.
            const k = 'invoiceApprovals';
            const done = invoicePastApproval;
            // F1-Q30: an invoice from an approved billing schedule needs Finance only.
            await approveOnce(s, k, 'Dev Finance', v.company, 'Demo invoice ready to issue.', done);

            await s.caption('sales-11 — Finance issues the tax invoice');
            await as(s, 'Dev Finance');
            await openUrl(s, 'invoiceUrl', (p) =>
              p.getByRole('button', { name: 'Issue tax invoice' }),
            );
            await invoiceAction(s, 'Issue tax invoice', /^Issue /, 'Issue tax invoice');
            await s.see(s.page.getByText(INV).first(), 'an invoice number (INV-…)', 90000);
            s.record('invoiceNumber', INV.exec(await main(s))[0]);
          }
          await s.see(status(s, 'Issued'), 'invoice Issued');
          const text = await main(s);
          s.expect(/Issue date\s*\n?\s*\d/.test(text), 'the invoice has an issue date');

          // The guide says "Download PDF"; the screen has View PDF → preview dialog → Download.
          await s.caption('sales-11 — View PDF, then Download from the preview');
          const view = s.page.getByRole('button', { name: 'View PDF' });
          for (
            let i = 0;
            i < 24 &&
            !(await view
              .first()
              .isVisible()
              .catch(() => false));
            i++
          ) {
            await s.page.waitForTimeout(5000);
            if (i % 3 === 2) await s.page.reload({ waitUntil: 'domcontentloaded' });
          }
          // The PDF is rendered and virus-scanned in the background after issue; until then the
          // document route answers 404 and the preview says "This PDF is not available."
          const docUrl = `${cfg.appUrl}${s.need('invoiceUrl')}/document`;
          const docStatus = () =>
            s.page.evaluate(async (u) => (await fetch(u, { cache: 'no-store' })).status, docUrl);
          const waitStart = Date.now();
          let first = await docStatus();
          let st = first;
          while (st !== 200 && Date.now() - waitStart < 300000) {
            await s.page.waitForTimeout(10000);
            st = await docStatus();
          }
          s.expect(st === 200, 'the invoice PDF becomes available', `status ${st}`);
          if (first !== 200)
            s.finding(
              `View PDF is offered as soon as the invoice is issued, but its document route answered ${first} ` +
                `for about ${Math.round((Date.now() - waitStart) / 1000)} s (10 s polling) until the background ` +
                'render and scan finished. Download in the preview during that window replaces the whole tab ' +
                'with a bare text page "This PDF is not available." (SCR1 1440 sales-11 screenshot); nothing ' +
                'says the PDF is still being prepared.',
              'low',
            );
          await s.click(view, 'View PDF');
          const preview = s.page.getByRole('dialog', {
            name: `${s.state.invoiceNumber.replaceAll('/', '-')}.pdf`,
          });
          await s.see(preview, 'the invoice PDF preview');
          await s.pause(1500);
          const dl = preview
            .getByRole('link', { name: /^Download/ })
            .or(preview.getByRole('button', { name: /^Download/ }));
          const file = await s.download(dl, s.dirs.files);
          s.expect(isPdf(file.bytes), 'the invoice download is a PDF');
          await s.page.keyboard.press('Escape');
          const pdf = pdfText(file.path);
          if (pdf !== null) {
            s.expect(hasAmount(pdf, 135600), 'the invoice PDF total is NPR 135,600');
            s.expect(pdf.includes(v.pan), 'the invoice PDF shows the customer PAN');
          }
          await s.caption('sales-11 — the issued invoice is in receivables');
          await s.goto('/receivables/aging', (p) => h1(p, 'Receivables aging'));
          await s.see(s.page.getByRole('link', { name: C }), 'the customer in receivables aging');
        },
      },
      {
        id: 'sales-12',
        title: 'Record the first half-payment',
        timeoutMs: 360000,
        async run(s) {
          const url = await findOrRecordPayment(s, 'payment1Url', v.pay1, ['payment2Url']);
          if (s.state.payment1Url !== url) s.record('payment1Url', url);
          const heading = await s.page.getByRole('heading', { level: 1 }).first().innerText();
          if (RCPT.test(heading)) {
            s.checks.push(
              'note: payment 1 was verified by sales-13 of an earlier attempt; its ' +
                'Awaiting-verification checks cannot be repeated',
            );
            return;
          }
          const text = await main(s);
          await s.see(status(s, 'Awaiting verification'), 'payment Awaiting verification');
          s.expect(!RCPT.test(text), 'no receipt number yet');
          s.expect(!text.includes(s.need('invoiceNumber')), 'no invoice settled yet');
        },
      },
      {
        id: 'sales-13',
        title: 'Verify, allocate and inspect the balance',
        async run(s) {
          await verifyAndAllocate(s, 'payment1Url', 'receipt1');
          await s.caption('sales-13 — the invoice has NPR 67,800 open');
          await s.goto('/receivables/aging', (p) => h1(p, 'Receivables aging'));
          const row = s.page.getByRole('row').filter({ hasText: C });
          await s.see(row, 'the customer row in aging');
          s.expect(
            hasAmount(await s.text(row), 67800),
            'aging shows NPR 67,800 open',
            await s.text(row),
          );
          await s.click(s.page.getByRole('link', { name: C }), 'open the customer statement');
          await s.page.waitForURL(/\/receivables\/customers\//, { timeout: cfg.navTimeout });
          s.record('statementUrl', s.page.url().replace(cfg.appUrl, ''));
          await statementOpen(s, 67800);
        },
      },
      {
        id: 'sales-14',
        title: 'Exercise deallocation, then restore it',
        async run(s) {
          await as(s, 'Dev Finance');
          await openUrl(s, 'payment1Url', (p) =>
            p.getByRole('region', { name: 'Allocations', exact: true }),
          );
          const inv = s.need('invoiceNumber');
          const allocations = s.page.getByRole('region', { name: 'Allocations', exact: true });
          const reason = 'Demo reversal check; immediately reallocate.';
          const reversal = allocations.getByText(`Reversed: ${reason}`);
          // Retry-safe: each half (deallocate, re-allocate) runs only if its effect is missing.
          if (await visible(reversal)) {
            s.checks.push('note: the deallocation was done by an earlier attempt of this run');
          } else {
            await s.click(
              allocations.getByRole('button', { name: `Deallocate ${inv}`, exact: true }),
              `Deallocate ${inv}`,
            );
            const d = s.page.getByRole('dialog', { name: `Deallocate ${inv}`, exact: true });
            await d.getByLabel('Reason for deallocating', { exact: true }).fill(reason);
            await s.pause(400);
            await d.getByRole('button', { name: 'Deallocate', exact: true }).click();
            await s.see(reversal, 'the reversal row');
          }
          s.expect(
            hasAmount(await s.text(allocations), 67800),
            'the original allocation row is kept',
          );
          if ((await leftOnPayment(s)) > 0) await allocate(s);
          else s.checks.push('note: the re-allocation was done by an earlier attempt of this run');
          await s.goto(s.need('statementUrl'), (p) => p.getByRole('heading', { level: 1 }));
          await statementOpen(s, 67800);
        },
      },
      {
        id: 'sales-15',
        title: 'Collect the remaining half',
        timeoutMs: 480000,
        async run(s) {
          const url = await findOrRecordPayment(s, 'payment2Url', v.pay2, ['payment1Url']);
          if (s.state.payment2Url !== url) s.record('payment2Url', url);
          await verifyAndAllocate(s, 'payment2Url', 'receipt2');
          const left = await s.text(
            s.page
              .getByRole('region', { name: 'Allocate this payment', exact: true })
              .or(s.page.getByRole('main')),
          );
          s.checks.push(`payment panel after allocation: ${left.slice(0, 120)}`);

          await s.caption('sales-15 — invoice Paid with zero open; statement and aging');
          await openUrl(s, 'invoiceUrl', (p) => p.getByText('Open amount', { exact: true }));
          const paid = await status(s, 'Paid')
            .waitFor({ state: 'visible', timeout: 15000 })
            .then(() => true)
            .catch(() => false);
          if (paid) s.checks.push('saw: invoice Paid');
          else s.finding('Fully allocated invoice does not read Paid (I-24)', 'high');
          const inv = await main(s);
          s.expect(
            /Open amount\s*NPR 0\.00/.test(inv),
            'the invoice shows Open amount NPR 0.00',
            /Open amount\s*[^\n]*/.exec(inv)?.[0],
          );
          await s.goto(s.need('statementUrl'), (p) => p.getByText('Customer advance').first());
          await s.see(
            s.page.getByText('This customer has no advance.'),
            'no unallocated customer advance',
          );
          await s.notVisible(
            s.page.getByRole('row').filter({ hasText: s.state.invoiceNumber }),
            'an open-items row for the paid invoice',
          );
          await s.goto('/receivables/aging', (p) => h1(p, 'Receivables aging'));
          await s.notVisible(
            s.page.getByRole('row').filter({ hasText: C }),
            'an aging row for the fully paid customer',
          );
        },
      },
    ],
  };
}
