// Guide: round4/guide/r4c1.html (invoices, notes, payments)
import { check, skip } from './harness.mjs';

export async function run(qa, rec, shared) {
  const G = 'r4c1';
  const NA = 'NOT-RUN';
  await check(qa, rec, G, '1.1', 'At 360 px, the Status and Action columns of six tables are sticky (Quotations: last column only)', async (c) => {
    await c.as('Dev Finance');
    await c.page().setViewportSize({ width: 360, height: 800 });
    try {
      for (const [name, href] of [['Invoices', '/invoices'], ['Payments', '/payments'], ['Bills', '/payables/bills'], ['Sales orders', '/sales-orders'], ['Vendors', '/vendors'], ['Quotations', '/quotations']]) {
        await c.open(href);
        const info = await c.page().locator('main table').first().evaluate((t) => {
          const rows = [...t.querySelectorAll('tr')].slice(0, 3);
          const sticky = (el) => getComputedStyle(el).position === 'sticky';
          const head = [...t.querySelectorAll('thead th')];
          return { headers: head.map((h) => h.innerText.trim()), stickyHeaders: head.filter(sticky).map((h) => h.innerText.trim()), scrolls: t.parentElement.scrollWidth > t.parentElement.clientWidth || t.scrollWidth > innerWidth };
        });
        c.controls.push(`${name}: sticky header cells = [${info.stickyHeaders.join(', ')}], scrolls sideways = ${info.scrolls}`);
        c.ok(info.stickyHeaders.length >= 1, `${name}: at least one sticky column`, JSON.stringify(info));
        if (name !== 'Quotations') c.ok(info.stickyHeaders.some((h) => /Status|Action/i.test(h)), `${name}: Status/Action column is sticky`, JSON.stringify(info));
      }
    } finally { await c.page().setViewportSize({ width: 1440, height: 900 }); }
  });

  await check(qa, rec, G, '2.1', 'Invoices: paid-state words, Record payment on rows that owe, total row per currency', async (c) => {
    await c.as('Dev Finance');
    await c.open('/invoices');
    const rows = await c.page().locator('main table tbody tr').evaluateAll((rs) => rs.map((r) => r.innerText.replace(/\s+/g, ' ')));
    c.ok(rows.length > 0, 'invoice rows exist', String(rows.length));
    const payable = rows.filter((r) => !/Credit note/.test(r));
    const states = payable.map((r) => (r.match(/\b(Unpaid|Partial|Paid|Overdue|Credited|Draft|Discarded)\b/) || [])[1]);
    c.controls.push('row states (invoices and debit notes): ' + states.join(','));
    c.ok(states.every(Boolean), 'every invoice and debit note row reads a paid-state word', states.join(','));
    const cn = rows.filter((r) => /Credit note/.test(r));
    c.controls.push(`credit-note rows: ${cn.length}, each reads: ${cn.map((r) => (r.match(/\b(Issued|Draft|Discarded)\b/) || ['?'])[0]).join(',')} (a credit note owes nothing, so no paid-state word)`);
    const owing = rows.filter((r) => /Unpaid|Partial|Overdue/.test(r));
    const paid = rows.filter((r) => /\bPaid\b/.test(r));
    c.controls.push(`rows owing: ${owing.length}, paid: ${paid.length}`);
    const withRecord = await c.page().locator('main table tbody tr').filter({ hasText: /Unpaid|Partial|Overdue/ }).filter({ has: c.page().getByRole('link', { name: /Record payment/ }).or(c.page().getByRole('button', { name: /Record payment/ })) }).count();
    c.ok(owing.length === 0 || withRecord === owing.length, 'every owing row offers "Record payment"', `${withRecord}/${owing.length}`);
    const paidWith = await c.page().locator('main table tbody tr').filter({ hasText: /\bPaid\b/ }).filter({ has: c.page().getByText('Record payment') }).count();
    c.ok(paidWith === 0, 'no paid row offers "Record payment"', String(paidWith));
    const last = (await c.page().locator('main table tfoot tr, main table tbody tr').last().innerText()).replace(/\s+/g, ' ');
    c.controls.push('last table row: ' + last.slice(0, 120));
    c.ok(/NPR|USD|INR/.test(last) && /total/i.test(last), 'last row is a per-currency total', last.slice(0, 120));
  });
  skip(rec, G, '3.1', 'Debit note: create, approve (Accountant, Finance Two), issue gating (Finance off, Finance Two on)', NA, 'Multi-persona create/approve/issue chain that adds financial documents to the shared stack; deferred to the mutating pass.');
  skip(rec, G, '3.2', 'Issued debit note due date = issue date + customer net days', NA, 'Depends on 3.1.');
  skip(rec, G, '4.1', 'Schedule-line invoice goes to Finance only; manual invoice goes Accountant then Finance', NA, 'Needs a billing-schedule line and invoice drafting; deferred to the mutating pass.');
  skip(rec, G, '5.1', 'F1-Q33 missed promise to pay (API only)', 'BLOCKED', 'The guide says it needs the promised day to pass or a test clock; none exists on the stack. A screen for it is the round-5 P4 unit.', { classify: '' });
  await check(qa, rec, G, '6.1', 'Staff payment form starts on "Choose a currency"', async (c) => {
    await c.as('Dev Finance');
    await c.open('/payments');
    await c.see(c.page().getByRole('link', { name: /Record payment/ }).first(), 'link "Record payment" on /payments');
    await c.open('/payments/new');
    await c.see(c.page().getByText('Choose a currency').first(), 'text "Choose a currency" on the payment form', 60000);
    c.controls.push('not run: switching USD off in Settings and recording a USD payment (a persistent setting)');
  });
}
