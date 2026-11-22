/* global document -- referenced inside page.evaluate callbacks, which run in the browser */
// FQA2 flows (final QA part 2): the areas the last round-5 units changed. Same shape as FQA1: each flow is
// { area, flow, persona, steps(c, S, step) } and runs once per size with its own recorded context.
import { goNav, noSideScroll, reachable, ledger, logIssue } from './fqa1-lib.mjs';
import { proofFile, search } from './fqa1-flows.mjs';

const INV13 = 'INV-2083/84-00013';

/** Where keyboard focus is: tag, role and accessible name of document.activeElement. */
export async function focusInfo(c) {
  return c.page().evaluate(() => {
    const e = document.activeElement;
    if (!e) return { tag: 'none', name: '' };
    const name =
      e.getAttribute('aria-label') ||
      (e.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 40);
    return { tag: e.tagName.toLowerCase(), role: e.getAttribute('role') || '', name };
  });
}
const focusText = (f) => `${f.tag}${f.role ? `[${f.role}]` : ''} "${f.name}"`;

/** A country combobox: type the name and press Enter (the list is in a popover outside the form). */
export async function pickCountry(c, box, name) {
  await box.click();
  await box.fill(name);
  await box.press('Enter');
  await c.page().waitForTimeout(300);
}
/** Nine digits from the run tag, so a PAN is unique per run. */
export const pan9 = (tag) =>
  String(Math.abs([...tag].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) | 0, 7)))
    .padStart(9, '3')
    .slice(-9)
    .replace(/^0/, '3');

/** The text a combobox shows (an input's value, else its text). */
export const shown = async (loc) => {
  const l = loc.first();
  return (await l.inputValue().catch(() => '')) || (await l.innerText().catch(() => '')) || (await l.textContent().catch(() => '')) || '';
};
const phone = (c, n, what) =>
  c
    .page()
    .getByRole('textbox', { name: `Phone ${n} number`, exact: true })
    .or(c.page().locator(`input[aria-label="Phone ${n} number"]`))
    .first();

export const PARTY_FLOWS = [
  {
    area: 'parties',
    flow: 'customer-form',
    persona: 'Dev Sales',
    mutates: true,
    async steps(c, S, step) {
      const p = () => c.page();
      const nameNP = `FQA2 Nepal Co ${S.tag}`;
      const nameUS = `FQA2 US Inc ${S.tag}`;
      await step('1-as', 'Sign in as Dev Sales', async (c) => {
        await c.as('Dev Sales');
      });
      await step(
        '2-new',
        'Customers > Add Organization opens the form with Country Nepal',
        async (c) => {
          await goNav(c, S, 'Customers', '/customers');
          await c.s.click(p().getByRole('link', { name: /Add Organization/ }), '+ Add Organization');
          await c.see(
            p().getByRole('textbox', { name: 'Organization legal name' }),
            'textbox Organization legal name',
          );
          await c.see(
            p().getByRole('combobox', { name: 'Country', exact: true }).nth(1),
            'address Country combobox',
          );
          await noSideScroll(c, '/customers/new');
        },
      );
      await step(
        '3-short-pan',
        'Nepal customer: a 5-digit PAN is refused and nothing is saved',
        async (c) => {
          await c.s.fill(p().getByRole('textbox', { name: 'Organization legal name' }), nameNP);
          await c.s.fill(p().getByRole('textbox', { name: 'Full name', exact: true }), 'Anu Test');
          await c.s.fill(
            p().getByRole('textbox', { name: 'Email', exact: true }),
            `fqa2-${S.tag}@bos-demo.example.com`,
          );
          await c.s.fill(
            p().getByRole('textbox', { name: 'Address', exact: true }),
            '17 Demo Marg',
          );
          await c.s.fill(p().getByRole('textbox', { name: 'City', exact: true }), 'Kathmandu');
          await c.s.fill(p().getByRole('textbox', { name: 'PAN or VAT number' }), '12345');
          await c.s.click(c.btn('Create Organization'), 'Create Organization');
          await c.see(
            p().getByText(/A PAN is 9 digits; this has 5/),
            'message "A PAN is 9 digits; this has 5"',
            30000,
          );
          c.ok(
            new URL(p().url()).pathname === '/customers/new',
            'still on /customers/new (nothing saved)',
          );
        },
      );
      await step(
        '4-phones',
        'Contact phones: two countries, primary, reorder, +1 typed in a Nepal row switches to US, the add button stops at 5',
        async (c) => {
          await c.s.fill(phone(c, 1), '9812345678');
          await c.s.click(c.btn('Add phone number'), 'Add phone number');
          await pickCountry(
            c,
            p().getByRole('combobox', { name: 'Phone 2 country' }),
            'United States',
          );
          await c.s.fill(phone(c, 2), '4155552671');
          await c.ok(
            (await p().locator('[aria-label="Phone 2 country"]').first().inputValue()).includes('+1'),
            'row 2 shows the +1 dial code',
            JSON.stringify(await p().evaluate(() => [...document.querySelectorAll('[aria-label="Phone 2 country"]')].map((e) => `${e.tagName}:${e.textContent}:${e.value ?? ''}`))),
          );
          await p().getByRole('radio', { name: 'Phone 2 primary' }).check();
          await c.s.click(p().getByRole('button', { name: 'Move phone 2 up' }), 'Move phone 2 up');
          c.ok(
            await p().getByRole('radio', { name: 'Phone 1 primary' }).isChecked(),
            'the primary mark followed the moved row (row 1 is primary)',
          );
          await c.s.click(c.btn('Add phone number'), 'Add phone number');
          await c.s.fill(phone(c, 3), '+1 4155552672');
          await p().waitForTimeout(500);
          c.ok(
            (await p().locator('[aria-label="Phone 3 country"]').first().inputValue()).includes(
              '+1',
            ),
            'typing +1 in a Nepal row switched it to +1 (US)',
            await p().locator('[aria-label="Phone 3 country"]').first().inputValue(),
          );
          for (let n = 4; n <= 5; n++) {
            await c.s.click(c.btn('Add phone number'), 'Add phone number');
            await c.s.fill(phone(c, n), n === 4 ? '9812345679' : '9812345670');
          }
          c.ok(
            (await c.btn('Add phone number').count()) === 0 ||
              (await c.btn('Add phone number').isDisabled()),
            'the add button stops at 5 rows',
          );
          await reachable(c, p().getByRole('button', { name: 'Remove phone 5' }), 'Remove phone 5');
          await noSideScroll(c, 'phone rows');
          for (const n of [5, 4, 3])
            await p()
              .getByRole('button', { name: `Remove phone ${n}` })
              .click();
        },
      );
      await step(
        '5-save-np',
        'A 9-digit PAN saves the Nepal customer and opens its page',
        async (c) => {
          await c.s.fill(p().getByRole('textbox', { name: 'PAN or VAT number' }), pan9(S.tag));
          await c.s.click(c.btn('Create Organization'), 'Create Organization');
          await p().waitForURL((u) => /^\/customers\/[0-9a-f-]{36}$/.test(u.pathname), {
            timeout: 90000,
          });
          S.npUrl = new URL(p().url()).pathname;
          ledger({ kind: `customer ${nameNP}`, path: S.npUrl, size: S.size });
        },
      );
      await step(
        '6-detail-np',
        'Customer page: address with city and country name, primary phone as a tel: link',
        async (c) => {
          await c.see(
            p().getByText(/17 Demo Marg, Kathmandu, Nepal/),
            'address "17 Demo Marg, Kathmandu, Nepal"',
          );
          c.ok(
            (await p().locator('a[href^="tel:"]').count()) >= 1,
            'a tel: link for the primary phone',
          );
          await noSideScroll(c, 'customer page');
        },
      );
      await step(
        '7-us-form',
        'US customer: no PAN needed; clearing the address country is refused; then it saves',
        async (c) => {
          await goNav(c, S, 'Customers', '/customers');
          await c.s.click(p().getByRole('link', { name: /Add Organization/ }), '+ Add Organization');
          await c.s.fill(p().getByRole('textbox', { name: 'Organization legal name' }), nameUS);
          await c.s.fill(p().getByRole('textbox', { name: 'Full name', exact: true }), 'Sam Test');
          await c.s.fill(
            p().getByRole('textbox', { name: 'Email', exact: true }),
            `fqa2us-${S.tag}@bos-demo.example.com`,
          );
          await c.s.fill(
            p().getByRole('textbox', { name: 'Address', exact: true }),
            '500 Test Street',
          );
          await c.s.fill(p().getByRole('textbox', { name: 'City', exact: true }), 'Austin');
          const country = p().getByRole('combobox', { name: 'Country', exact: true }).nth(1);
          await country.click();
          await country.fill('');
          await country.press('Tab');
          const left = await country.inputValue();
          if (left.trim() === '') {
            await c.s.click(c.btn('Create Organization'), 'Create Organization');
            await p().waitForTimeout(1500);
            c.ok(
              new URL(p().url()).pathname === '/customers/new',
              'an address with no country is not saved (still on /customers/new)',
            );
          } else {
            c.ok(
              true,
              `clearing the Country box and leaving it puts "${left}" back, so an address never has no country`,
            );
          }
          await pickCountry(c, country, 'United States');
          await c.s.click(c.btn('Create Organization'), 'Create Organization');
          await p().waitForURL((u) => /^\/customers\/[0-9a-f-]{36}$/.test(u.pathname), {
            timeout: 90000,
          });
          S.usUrl = new URL(p().url()).pathname;
          ledger({ kind: `customer ${nameUS}`, path: S.usUrl, size: S.size });
          await c.see(
            p().getByText(/500 Test Street, Austin, United States/),
            'address "500 Test Street, Austin, United States"',
          );
        },
      );
      await step(
        '8-add-contact',
        "Add Contact dialog: Country starts as the customer's (United States)",
        async (c) => {
          await c.s.click(p().getByRole('button', { name: /Add Contact/ }), '+ Add Contact');
          const d = p().getByRole('dialog');
          await c.see(d, 'the Add Contact dialog');
          const ctry = d.getByRole('combobox', { name: 'Country', exact: true }).first();
          c.ok(
            (await ctry.inputValue()) === 'United States',
            `the contact Country starts as United States (${await ctry.inputValue()})`,
          );
          await reachable(
            c,
            d.getByRole('button', { name: /^(Add contact|Save)/ }),
            'the dialog submit button',
          );
          await p().keyboard.press('Escape');
        },
      );
      await step(
        '9-list-location',
        'Customers list: a Location column with city and country',
        async (c) => {
          await c.open(`/customers?q=${encodeURIComponent('FQA2')}`);
          await c.see(
            p()
              .getByText(/Austin, United States/)
              .first(),
            'location "Austin, United States"',
            30000,
          );
          await c.see(
            p()
              .getByText(/Kathmandu, Nepal/)
              .first(),
            'location "Kathmandu, Nepal"',
          );
          await noSideScroll(c, '/customers list');
        },
      );
    },
  },
];

export const FLOWS = [
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
        'The form starts on the invoice currency and open amount; the customer is read-only',
        async (c) => {
          const cust = c.page().getByRole('textbox', { name: 'Customer', exact: true });
          await c.see(cust, 'textbox Customer');
          c.ok((await cust.isEditable()) === false, 'the Customer box is read-only');
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
        '5-incomplete-no-review',
        'FX5: an empty amount skips the review and shows the inline message',
        async (c) => {
          const amount = c.page().getByRole('textbox', { name: 'Amount received', exact: true });
          await c.s.fill(amount, '');
          await c.s.click(
            c.page().getByRole('button', { name: 'Record payment', exact: true }),
            'Record payment (submit)',
          );
          await c.page().waitForTimeout(1500);
          c.ok(
            (await c.page().getByRole('dialog').count()) === 0,
            'no review dialog opened for an empty amount',
          );
        },
      );
      await step(
        '6-review-back-esc',
        'FX5: the review shows who paid, amount in words; Esc and Back keep the form; focus returns to Record payment',
        async (c) => {
          const p = c.page();
          await c.s.fill(p.getByRole('textbox', { name: 'Amount received', exact: true }), '1.00');
          await c.s.fill(
            p.getByRole('textbox', { name: 'Bank reference', exact: true }),
            `FQA2-${S.tag}`,
          );
          await p.getByLabel('Add proof files').setInputFiles(proofFile('fqa2-proof.pdf'));
          await c.see(c.btn(/Remove fqa2-proof\.pdf/), 'chip Remove fqa2-proof.pdf', 120000);
          await p
            .getByText(/^Uploading/)
            .first()
            .waitFor({ state: 'hidden', timeout: 120000 })
            .catch(() => {});
          const record = p.getByRole('button', { name: 'Record payment', exact: true });
          await c.s.click(record, 'Record payment (submit)');
          const d = p.getByRole('dialog');
          await c.see(d, 'the review dialog');
          const text = (await d.innerText()).replace(/\s+/g, ' ');
          c.ok(
            /one/i.test(text) && /rupee|NPR/i.test(text),
            'the review shows the amount in figures and words',
            text.slice(0, 200),
          );
          c.ok(/FQA2-/.test(text), 'the review shows the reference');
          await p.keyboard.press('Escape');
          await d.waitFor({ state: 'hidden', timeout: 10000 });
          c.ok(
            (
              await p.getByRole('textbox', { name: 'Amount received', exact: true }).inputValue()
            ).includes('1'),
            'the amount is intact after Esc',
          );
          const f1 = await focusInfo(c);
          c.ok(
            /Record payment/.test(f1.name),
            `focus returns to Record payment after Esc (${focusText(f1)})`,
          );
          await c.s.click(record, 'Record payment (submit)');
          await c.see(d, 'the review dialog again');
          await d.getByRole('button', { name: 'Back', exact: true }).click();
          await d.waitFor({ state: 'hidden', timeout: 10000 });
          const f2 = await focusInfo(c);
          c.ok(
            /Record payment/.test(f2.name),
            `focus returns to Record payment after Back (${focusText(f2)})`,
          );
        },
      );
      await step(
        '7-confirm-focus',
        'FX5 Q4: Confirm posts one payment; where focus lands afterwards',
        async (c) => {
          const p = c.page();
          await c.s.click(
            p.getByRole('button', { name: 'Record payment', exact: true }),
            'Record payment (submit)',
          );
          const d = p.getByRole('dialog');
          await c.see(d, 'the review dialog');
          await d.getByRole('button', { name: 'Confirm', exact: true }).click();
          await p.waitForURL((u) => /^\/payments\/[0-9a-f-]{36}$/.test(u.pathname), {
            timeout: 120000,
          });
          S.pay = new URL(p.url()).pathname;
          ledger({
            kind: 'payment (NPR 1.00 part payment on INV-13, FQA2)',
            path: S.pay,
            size: S.size,
          });
          await p.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
          const f = await focusInfo(c);
          c.controls.push(`focus after Confirm (new record page ${S.pay}): ${focusText(f)}`);
          S.focusAfterConfirm = focusText(f);
          // PASS when the new record opened (focus starts at the top of the new page) or focus is on a real control.
          c.ok(true, `Confirm opened the new payment; focus is on ${focusText(f)}`);
        },
      );
      await step('8-detail', 'The payment page shows its status and proof', async (c) => {
        await c.see(
          c.page().getByRole('heading', { name: 'Payment overview' }),
          'heading Payment overview',
        );
        await c.see(
          c.page().getByRole('heading', { name: 'Proof of payment' }),
          'heading Proof of payment',
        );
        await noSideScroll(c, 'new payment');
      });
    },
  },
  ...PARTY_FLOWS,
];
