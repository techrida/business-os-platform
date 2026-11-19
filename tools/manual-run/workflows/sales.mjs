// Workflow 2 · Lead → quotation → sales order → invoice → payment (guide steps sales-1 … sales-15).
// Exact values: docs/testrun-2026-11-19/steps/sales-*.md plus the "Update 19 Nov" boxes:
// Qualify → Qualify lead; per-document Upload (native chooser) + Save, status "Virus free";
// per-document Approve then Approve customer (reason + confirm); one 100% Advance milestone
// (total NPR 135,600); payments are 67,800.00 twice; Dev Founder confirms the order.
// Unique values (names, PAN, e-mail, bank references) carry the run key so runs never collide.
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
 * How sales-12 and sales-15 get their payment without recording a second one:
 * - `reuse` the URL an earlier attempt recorded;
 * - `adopt` a payment of this run's customer that is not one of the known payments (an attempt
 *   that was interrupted after the submit, before it could record the URL);
 * - `record` a new payment only when neither exists.
 */
export function paymentDecision({ recordedUrl, rowUrls, knownUrls }) {
  if (recordedUrl) return { action: 'reuse', url: recordedUrl };
  const others = [...new Set(rowUrls)].filter((u) => !knownUrls.includes(u));
  if (others.length) return { action: 'adopt', urls: others };
  return { action: 'record' };
}

export function workflow(cfg) {
  const u = uniqueValues(cfg.runKey);
  const v = {
    leadTitle: `BOS Demo — Business OS service${u.suffix}`,
    company: `BOS Demo Himalayan Labs${u.suffix}`,
    contact: 'Anu Shrestha',
    email: `${u.emailLocal}@bos-demo.example.com`,
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

  /** Inbox → this run's row (matched by a unique number or name) → Approve with a comment. */
  const approve = async (s, persona, match, comment) => {
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
    await s.see(row, `${persona}'s inbox row for ${match}`);
    await s.click(row.first().getByRole('link').first(), 'the inbox row');
    await s.page.waitForURL(/\/inbox\/[0-9a-f-]{36}/);
    await s.pause();
    await s.click(s.button('Approve'), 'Approve');
    const dialog = s.page.getByRole('dialog', { name: 'Approve request' });
    await dialog.getByLabel('Comment (optional)', { exact: true }).fill(comment);
    await s.pause(400);
    await dialog.getByRole('button', { name: 'Approve', exact: true }).click();
    await s.page.waitForURL(/\/inbox\?decided=approve/, { timeout: cfg.navTimeout });
    const who = await s.whoami();
    s.expect(
      who && who.roles.includes(ROLE[persona]),
      `${persona} is still signed in after Approve`,
    );
  };

  const openUrl = (s, key, ready) => s.goto(s.need(key), ready);

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

  /** The payment links in the Payments list rows of this run's unique customer (all statuses). */
  const customerPayments = async (s) => {
    await s.goto(`/payments?q=${encodeURIComponent(v.company)}`, (p) => h1(p, 'Payments'));
    await s.page.waitForTimeout(1500);
    const hrefs = await s.page
      .getByRole('row')
      .filter({ hasText: C })
      .locator('a[href*="/payments/"]')
      .evaluateAll((links) => links.map((a) => a.getAttribute('href')));
    return hrefs
      .map((h) => new URL(h, cfg.appUrl).pathname)
      .filter((h) => /^\/payments\/[0-9a-f-]{36}$/.test(h));
  };

  /**
   * sales-12 and sales-15 record a payment at most once per run, whatever an earlier attempt did:
   * the recorded URL is reused; otherwise a payment of this run's customer that is not one of the
   * known payments is adopted after its bank reference is checked; only when there is none is a new
   * payment recorded.
   */
  const findOrRecordPayment = async (s, key, ref, otherKeys) => {
    await as(s, 'Dev Accountant');
    const known = otherKeys.map((k) => s.state[k]).filter(Boolean);
    let decision = paymentDecision({ recordedUrl: s.state[key], rowUrls: [], knownUrls: known });
    if (decision.action !== 'reuse')
      decision = paymentDecision({
        recordedUrl: null,
        rowUrls: await customerPayments(s),
        knownUrls: known,
      });
    if (decision.action === 'reuse') {
      s.checks.push(`note: reusing ${key} from an earlier attempt of this run`);
      await openUrl(s, key, (p) => p.getByRole('heading', { level: 1 }));
      return decision.url;
    }
    if (decision.action === 'adopt') {
      for (const url of decision.urls) {
        await s.goto(url, (p) => p.getByText('Bank reference', { exact: true }));
        if (runMatch(ref).test(await main(s))) {
          s.checks.push(
            `note: adopting the payment ${ref} an earlier attempt of this run recorded`,
          );
          return url;
        }
      }
      throw new StepFailure(
        `This run's customer already has a payment that is not ${ref} (${decision.urls.join(', ')}); ` +
          'not recording another. Check it by hand, or use a new label.',
      );
    }
    return recordPayment(s, ref);
  };

  const recordPayment = async (s, ref) => {
    await s.goto('/payments/new', (p) => h1(p, 'Record payment'));
    await s.page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    await s.choose('Customer', C);
    if (await s.select('Currency').count()) await s.choose('Currency', 'NPR').catch(() => {});
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
    const uploaded = s.page.getByRole('list', { name: 'Uploaded proof' });
    await s.see(
      uploaded.getByText('payment-proof.pdf'),
      'payment-proof.pdf in Uploaded proof',
      90000,
    );
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
      if (outcome !== 'not-ready')
        throw new StepFailure('Record payment neither opened the payment nor said why');
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
          await as(s, 'Dev Sales');
          await s.goto('/leads/new', (p) =>
            p.getByRole('textbox', { name: 'Lead title', exact: true }),
          );
          await s.page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
          await s.fill(
            s.page.getByRole('textbox', { name: 'Lead title', exact: true }),
            v.leadTitle,
          );
          await s.choose(s.select('source', { byName: true }), 'Referral');
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
          if (!s.state.opportunityUrl) {
            await openUrl(s, 'leadUrl', (p) =>
              p.getByRole('button', { name: 'Convert to opportunity' }),
            );
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
            await fill('Country code', 'NP');
            const newContact = d.getByLabel('Create a new contact');
            if (await newContact.count()) await newContact.check();
            await fill('Contact name', v.contact);
            await fill('Email', v.email);
            await fill('Opportunity name', v.leadTitle);
            await s.pause();
            await d.getByRole('button', { name: 'Convert', exact: true }).click();
            await s.page.waitForURL(/\/opportunities\/[0-9a-f-]{36}/, { timeout: cfg.navTimeout });
            s.record('opportunityUrl', s.page.url().split('?')[0].replace(cfg.appUrl, ''));
            await s.see(h1(s.page, L), 'the linked opportunity');
            await s.see(status(s, 'Qualified'), 'opportunity stage Qualified');
            const text = await main(s);
            s.expect(C.test(text), 'the opportunity names the new customer');
          }
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
          await as(s, 'Dev Sales');
          await s.goto('/customers', (p) => p.getByLabel('Search organizations'));
          await s.fill('Search organizations', v.company);
          await s.click(s.button('Search').or(s.button('Apply')), 'Search');
          const row = s.page.getByRole('link', { name: C }).first();
          await s.see(row, `the customer ${v.company} in the results`);
          await s.click(row, 'open the customer');
          await s.see(h1(s.page, C), 'the customer page');
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
          for (const [label, file] of DOCS) {
            await s.caption(`sales-4 — Upload ${label}: ${file}, then Save`);
            const row = s.page
              .getByRole('row')
              .filter({ has: s.page.getByRole('rowheader', { name: label, exact: true }) });
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
          await s.click(s.button('Submit for review'), 'Submit for review');
          await s.page
            .getByRole('dialog')
            .getByRole('button', { name: 'Submit for review', exact: true })
            .click();
          await s.see(status(s, 'Awaiting review'), 'the case is Awaiting review', 60000);
          const optional = s.page.getByRole('row').filter({
            has: s.page.getByRole('rowheader', { name: 'Proof of address', exact: true }),
          });
          await s.see(
            optional.getByText('Missing', { exact: true }),
            'optional evidence stays empty (Missing)',
          );
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
          const final = s.button('Approve customer');
          s.expect(
            (await final.first().getAttribute('aria-disabled')) === 'true',
            'Approve customer waits for the per-document approvals',
          );
          for (const [label] of DOCS) {
            await s.caption(`sales-5 — approve ${label}`);
            const row = s.page
              .getByRole('row')
              .filter({ has: s.page.getByRole('rowheader', { name: label, exact: true }) });
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
          await s.see(totals.getByText('Grand total', { exact: true }), 'server totals');
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
          await openUrl(s, 'quotationEditUrl', (p) =>
            p.getByRole('button', { name: 'Submit for approval', exact: true }),
          );
          await s.caption(
            'sales-7 — read the route: Accountant → Finance → Management (over NPR 1,00,000)',
          );
          const reqHeading = s.page.getByRole('heading', { name: 'Approval requirements' });
          await s.see(reqHeading, 'Approval requirements');
          const route = await s.text(
            s.page
              .locator('section, aside, div')
              .filter({ has: reqHeading, hasText: /Approver for step 1/ })
              .last(),
          );
          s.checks.push(`approval requirements: ${route.slice(0, 200)}`);
          const r = route.slice(0, route.search(/Approver for step 1|$/));
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
          await confirm.getByRole('button', { name: 'Submit quotation' }).click();
          await s.page.waitForURL(/[?&]submitted=1/, { timeout: cfg.navTimeout });
          await s.see(status(s, 'Approval pending'), 'Approval pending');
          const number = QT.exec(await main(s))?.[0];
          s.expect(number, 'the quotation has a number');
          s.record('quotationNumber', number);
          await s.notVisible(s.button('Approve'), 'an Approve button for the author');

          await approve(s, 'Dev Accountant', number, 'Demo quote pricing checked.');
          await approve(s, 'Dev Finance', number, 'Demo quote budget approved.');
          await approve(s, 'Dev Management', number, 'Demo threshold approval complete.');
          await s.caption('sales-7 — the quotation is Approved');
          await openUrl(s, 'quotationUrl', (p) => p.getByRole('heading', { level: 1 }));
          await s.see(status(s, 'Approved'), 'quotation status Approved');
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
          // Retry-safe: an earlier attempt may already have sent it; then only the checks remain.
          if (
            await status(s, 'Sent')
              .isVisible()
              .catch(() => false)
          )
            s.checks.push('note: the quotation was sent by an earlier attempt of this run');
          else await downloadAndSend(s);

          await s.caption('sales-8 — Test mail: portal link, no attachment');
          const mail = await findMail(cfg, `to:"${v.email}"`, 90000);
          s.expect(mail, `a Mailpit message to ${v.email}`);
          const full = await mailMessage(cfg, mail.ID);
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
            p.getByRole('button', { name: 'Record outcome' }),
          );
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
          if (s.state.salesOrderUrl) {
            // Retry after the order was already confirmed: open it instead of confirming twice.
            await openUrl(s, 'salesOrderUrl', (p) => h1(p, 'Sales order'));
          } else {
            await s.goto('/sales-orders', (p) =>
              p.getByRole('button', { name: 'Confirm from quotation' }),
            );
            await s.click(s.button('Confirm from quotation'), 'Confirm from quotation');
            const d = s.page.getByRole('dialog', { name: 'Confirm a sales order' });
            await s.choose(
              s.select('Accepted quotation', { scope: d }).or(d.getByLabel('Accepted quotation')),
              runMatch(s.need('quotationNumber')),
            );
            await s.pause(400);
            await d.getByRole('button', { name: 'Confirm order' }).click();
            await s.page.waitForURL(/\/sales-orders\/[0-9a-f-]{36}/, { timeout: cfg.navTimeout });
            s.record('salesOrderUrl', s.page.url().split('?')[0].replace(cfg.appUrl, ''));
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
            await openUrl(s, 'invoiceUrl', (p) =>
              submit(p).or(p.getByText('Awaiting approval', { exact: true })),
            );
            s.expect(!INV.test(await main(s)), 'no invoice number before it is issued');
            // Retry-safe: a re-run after the submit went through finds it Awaiting approval.
            if (await submit(s.page).isVisible())
              await invoiceAction(s, 'Submit for approval', /^Submit /, 'Submit for approval');
            await s.see(status(s, 'Awaiting approval'), 'invoice Awaiting approval', 60000);

            await approve(s, 'Dev Accountant', v.company, 'Demo invoice lines and tax checked.');
            await approve(s, 'Dev Finance', v.company, 'Demo invoice ready to issue.');

            await s.caption('sales-11 — Finance issues the tax invoice');
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
          await s.click(
            allocations.getByRole('button', { name: `Deallocate ${inv}`, exact: true }),
            `Deallocate ${inv}`,
          );
          const d = s.page.getByRole('dialog', { name: `Deallocate ${inv}`, exact: true });
          await d
            .getByLabel('Reason for deallocating', { exact: true })
            .fill('Demo reversal check; immediately reallocate.');
          await s.pause(400);
          await d.getByRole('button', { name: 'Deallocate', exact: true }).click();
          await s.see(
            allocations.getByText('Reversed: Demo reversal check; immediately reallocate.'),
            'the reversal row',
          );
          s.expect(
            hasAmount(await s.text(allocations), 67800),
            'the original allocation row is kept',
          );
          await allocate(s);
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
