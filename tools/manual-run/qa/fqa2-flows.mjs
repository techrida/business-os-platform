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

export const LEAD_FLOWS = [
  {
    area: 'parties',
    flow: 'lead-form',
    persona: 'Dev Sales',
    mutates: true,
    async steps(c, S, step) {
      const p = () => c.page();
      const n = String((Date.now() % 9000) + 1000);
      const t1 = `FQA2 lead A ${S.tag}`;
      const t2 = `FQA2 lead B ${S.tag}`;
      const fillBasics = async (title, company, person = 'FQA2 Contact') => {
        await c.s.fill(p().getByRole('textbox', { name: 'Lead title', exact: true }), title);
        await c.s.choose(c.s.select(/(^| )Lead source$/), 'Referral');
        await c.s.fill(p().getByRole('textbox', { name: 'Company or organization', exact: true }), company);
        await c.s.fill('Contact person', person);
      };
      await step('1-as', 'Sign in as Dev Sales', async (c) => {
        await c.as('Dev Sales');
      });
      await step('2-new', 'Leads > New lead opens the form with Country Nepal', async (c) => {
        await goNav(c, S, 'Leads', '/leads');
        await c.s.click(p().getByRole('link', { name: /Add lead/ }).first(), 'Add lead');
        await c.see(p().getByRole('textbox', { name: 'Lead title', exact: true }), 'textbox Lead title');
        await c.see(p().getByRole('combobox', { name: 'Country', exact: true }), 'combobox Country');
        await noSideScroll(c, '/leads/new');
      });
      await step('3-needs-contact', 'A lead with no email and no phone is refused', async (c) => {
        await fillBasics(t1, `${t1} Co`);
        const before = await p().locator('main').innerText();
        await c.s.click(c.btn('Create lead'), 'Create lead');
        await p().waitForTimeout(1500);
        c.ok(new URL(p().url()).pathname === '/leads/new', 'nothing saved (still on /leads/new)');
        const added = (await p().locator('main').innerText()).split('\n').filter((l) => !before.includes(l) && /email|phone/i.test(l));
        c.ok(added.length > 0, 'a message about the email-or-phone rule appears', added.join(' | ') || 'no new line');
      });
      await step('4-two-phones-save', 'Two phones (Nepal, US) with the US one primary; the lead saves and shows the number', async (c) => {
        await c.s.fill(phone(c, 1), '9812345678');
        await c.s.click(c.btn('Add phone number'), 'Add phone number');
        await pickCountry(c, p().getByRole('combobox', { name: 'Phone 2 country' }), 'United States');
        await c.s.fill(phone(c, 2), `415555${n}`);
        await p().getByRole('radio', { name: 'Phone 2 primary' }).check();
        await reachable(c, p().getByRole('button', { name: 'Move phone 2 up' }), 'Move phone 2 up');
        await c.s.click(c.btn('Create lead'), 'Create lead');
        await p().waitForURL((u) => /^\/leads\/[0-9a-f-]{36}$/.test(u.pathname), { timeout: 90000 });
        S.leadA = new URL(p().url()).pathname;
        ledger({ kind: `lead ${t1}`, path: S.leadA, size: S.size });
        await c.see(p().getByText(/\+1\s+415\s+555\s+\d{4}/).first(), 'a +1 415 555 phone on the lead', 30000);
        c.ok((await p().locator('main').innerText()).replace(/[^\d+]/g, '').includes(`+1415555${n}`), 'the primary phone +1 415 555 ' + n + ' is shown on the lead');
      });
      await step('5-duplicate-hint', 'A second lead with the same primary phone shows the duplicate hint; moving primary to another number clears it', async (c) => {
        await c.open('/leads/new');
        await fillBasics(t2, `Unrelated Quokka ${S.tag}`, 'Pat Otherwise');
        await c.s.fill(phone(c, 1), `415555${n}`);
        // the first row is Nepal: the +1 prefix switches it to US
        const hint = p().locator('[data-duplicate-hint]');
        await c.s.fill(phone(c, 1), `+1 415555${n}`);
        await p().waitForTimeout(800);
        await c.see(hint.getByText(/matches[^)]*phone/i).first(), 'a duplicate hint that matches on the phone', 30000);
        await c.s.click(c.btn('Add phone number'), 'Add phone number');
        await c.s.fill(phone(c, 2), `+1 415556${n}`);
        await p().getByRole('radio', { name: 'Phone 2 primary' }).check();
        await p().waitForTimeout(2500);
        const gone = (await hint.getByText(/matches[^)]*phone/i).count()) === 0;
        c.ok(gone, 'the hint went away after another number became primary');
        await p().getByRole('radio', { name: 'Phone 1 primary' }).check();
        await p().waitForTimeout(800);
        await c.see(hint.getByText(/matches[^)]*phone/i).first(), 'the hint is back when the first number is primary again', 30000);
      });
      await step('6-save-b', 'Save the second lead (US contact)', async (c) => {
        await p().getByRole('radio', { name: 'Phone 2 primary' }).check();
        await c.s.click(c.btn('Create lead'), 'Create lead');
        await p().waitForURL((u) => /^\/leads\/[0-9a-f-]{36}$/.test(u.pathname), { timeout: 90000 });
        S.leadB = new URL(p().url()).pathname;
        ledger({ kind: `lead ${t2}`, path: S.leadB, size: S.size });
      });
      await step('7-edit-country-phones', 'Lead page: Edit country and phones changes the country and a phone', async (c) => {
        await c.s.click(c.btn('Edit country and phones'), 'Edit country and phones');
        const ctry = p().getByRole('combobox', { name: 'Country', exact: true });
        await c.see(ctry, 'Country combobox in the editor');
        await pickCountry(c, ctry, 'United States');
        await c.s.click(c.btn('Add phone number'), 'Add phone number');
        await pickCountry(c, p().getByRole('combobox', { name: /^Phone \d country$/ }).last(), 'India');
        await c.s.fill(p().getByRole('textbox', { name: /^Phone \d number$/ }).last(), `98${n}4321`);
        await c.s.click(p().getByRole('button', { name: /^Save/ }).first(), 'Save');
        await c.see(p().getByText('United States').first(), 'Country United States shown on the lead', 30000);
        await noSideScroll(c, 'lead page');
      });
      await step('8-contacted-qualified', 'Mark contacted (with a note) and Qualify', async (c) => {
        await c.s.click(c.btn('Mark contacted'), 'Mark contacted');
        const d = p().getByRole('dialog', { name: 'Mark this lead contacted?' });
        await d.getByLabel('Note').fill('FQA2 call');
        await d.getByRole('button', { name: 'Mark contacted', exact: true }).click();
        await c.see(p().getByText('Moved to Contacted.'), 'toast Moved to Contacted', 45000);
        await c.s.click(c.btn('Qualify'), 'Qualify');
        await p().getByRole('dialog', { name: 'Qualify this lead?' }).getByRole('button', { name: 'Qualify lead', exact: true }).click();
        await c.see(p().getByText('Moved to Qualified.'), 'toast Moved to Qualified', 45000);
      });
      await step('9-convert-foreign', 'Convert a US lead to a new US organization with no PAN; phones arrive pre-filled', async (c) => {
        await c.s.click(c.btn('Convert to opportunity'), 'Convert to opportunity');
        const d = p().getByRole('dialog', { name: 'Convert lead to opportunity' });
        await c.see(d, 'the Convert dialog');
        await d.getByLabel('Create a new organization').check();
        await c.see(d.getByRole('textbox', { name: /^Phone \d number$/ }).first(), 'phone rows in the dialog');
        const filled = await d.getByRole('textbox', { name: /^Phone \d number$/ }).evaluateAll((els) => els.map((e) => e.value).filter(Boolean).length);
        c.ok(filled >= 1, `the lead's phones are pre-filled in the dialog (${filled} filled)`);
        await d.getByLabel('Legal name', { exact: true }).fill(`FQA2 Convert Inc ${S.tag}`);
        await d.getByLabel('Address', { exact: true }).fill('9 Convert Ave');
        await d.getByLabel('City', { exact: true }).fill('Denver');
        await pickCountry(c, d.getByRole('combobox', { name: 'Country', exact: true }).last(), 'United States');
        await d.getByLabel('Contact name', { exact: true }).fill('FQA2 Contact');
        await d.getByRole('textbox', { name: 'Email', exact: true }).fill(`fqa2conv-${S.tag}@bos-demo.example.com`);
        await d.getByRole('button', { name: 'Convert', exact: true }).click();
        await p().waitForURL((u) => /^\/opportunities\/[0-9a-f-]{36}$/.test(u.pathname), { timeout: 60000 });
        c.controls.push('Convert opened the new opportunity ' + new URL(p().url()).pathname);
        await c.see(p().getByText(/FQA2 Convert Inc/).first(), 'the new US organization named on the opportunity', 30000);
        ledger({ kind: `convert ${S.leadB} to FQA2 Convert Inc`, path: S.leadB, size: S.size });
      });
    },
  },
];

export const VENDOR_FLOWS = [
  {
    area: 'parties',
    flow: 'vendor-form',
    persona: 'Dev Procurement',
    mutates: true,
    async steps(c, S, step) {
      const p = () => c.page();
      const n = String((Date.now() % 9000) + 1000);
      const vname = `FQA2 Foreign Vendor ${S.tag}`;
      await step('1-as', 'Sign in as Dev Procurement', async (c) => {
        await c.as('Dev Procurement');
      });
      await step('2-new', 'Vendors > Add vendor opens the form', async (c) => {
        await goNav(c, S, 'Vendors', '/vendors');
        await c.s.click(p().getByRole('link', { name: /Add vendor/ }).first(), 'Add vendor');
        await c.see(p().getByRole('textbox', { name: 'Legal name' }), 'textbox Legal name');
        await noSideScroll(c, '/vendors/new');
      });
      await step('3-foreign', 'Foreign vendor: no PAN box, a loose Tax ID, address with a foreign country; saves', async (c) => {
        await c.s.fill(p().getByRole('textbox', { name: 'Legal name' }), vname);
        await c.s.choose(c.s.select(/(^| )Kind$/), /Foreign/);
        await c.absent(p().getByRole('textbox', { name: 'PAN', exact: true }), 'textbox PAN (a foreign vendor has none)');
        await c.see(p().getByRole('textbox', { name: /Tax ID/ }), 'textbox Tax ID (optional)');
        await c.s.fill(p().getByRole('textbox', { name: /Tax ID/ }), `GSTIN-${n}-AB`);
        await c.s.fill(p().getByRole('textbox', { name: /^Address/ }), '12 Industrial Road');
        await c.s.fill(p().getByRole('textbox', { name: /^City/ }), 'Mumbai');
        await pickCountry(c, p().getByRole('combobox', { name: 'Country', exact: true }), 'India');
        await c.s.click(c.btn('Add vendor'), 'Add vendor');
        await p().waitForURL((u) => /^\/vendors\/[0-9a-f-]{36}$/.test(u.pathname), { timeout: 90000 });
        S.vendor = new URL(p().url()).pathname;
        ledger({ kind: `vendor ${vname}`, path: S.vendor, size: S.size });
      });
      await step('4-contact', 'A vendor contact with two phones in different countries and its own country', async (c) => {
        await c.s.fill(p().getByRole('textbox', { name: 'Name', exact: true }), 'FQA2 Vendor Contact');
        await c.s.fill(p().getByRole('textbox', { name: 'Email', exact: true }), `fqa2v-${S.tag}@bos-demo.example.com`);
        await pickCountry(c, p().getByRole('combobox', { name: 'Country', exact: true }).first(), 'India');
        await c.s.fill(phone(c, 1), `98${n}5678`);
        await c.s.click(c.btn('Add phone number'), 'Add phone number');
        await pickCountry(c, p().getByRole('combobox', { name: 'Phone 2 country' }), 'United States');
        await c.s.fill(phone(c, 2), `415557${n}`);
        await reachable(c, p().getByRole('button', { name: 'Move phone 2 up' }), 'Move phone 2 up');
        await noSideScroll(c, 'vendor contact form');
        await c.s.click(c.btn('Add contact'), 'Add contact');
        await c.see(p().getByText('FQA2 Vendor Contact').first(), 'the contact FQA2 Vendor Contact is listed', 45000);
      });
      await step('5-detail', 'Vendor page: address with city and country name; primary phone shown', async (c) => {
        await p().reload({ waitUntil: 'domcontentloaded' });
        await c.see(p().getByText(/12 Industrial Road, Mumbai, India/), 'address "12 Industrial Road, Mumbai, India"', 30000);
        c.ok((await p().locator('a[href^="tel:"]').count()) >= 1, 'a tel: link for the contact phone');
        await noSideScroll(c, 'vendor page');
      });
      await step('6-list', 'Vendors list shows the vendor', async (c) => {
        await c.open(`/vendors?q=${encodeURIComponent('FQA2 Foreign')}`);
        await c.see(p().getByRole('link', { name: new RegExp(vname) }).first(), `row ${vname}`, 30000);
        await noSideScroll(c, '/vendors list');
      });
    },
  },
];

export const COMPANY_FLOWS = [
  {
    area: 'parties',
    flow: 'company-profile',
    persona: 'Dev Founder',
    mutates: true,
    async steps(c, S, step) {
      const p = () => c.page();
      await step('1-as', 'Sign in as Dev Founder', async (c) => {
        await c.as('Dev Founder');
      });
      await step('2-open', 'Settings > Company profile opens with Address, City, Country and the phone list', async (c) => {
        await goNav(c, S, 'Settings', '/settings');
        await c.s.click(p().getByRole('link', { name: 'Company profile' }).first(), 'Company profile');
        await p().waitForURL((u) => u.pathname === '/settings/company', { timeout: 60000 });
        await c.see(p().getByRole('textbox', { name: 'PAN number' }), 'textbox PAN number');
        await c.see(p().getByRole('textbox', { name: 'Address', exact: true }), 'textbox Address');
        await c.see(p().getByRole('textbox', { name: 'City', exact: true }), 'textbox City');
        await c.see(p().getByRole('combobox', { name: 'Country', exact: true }), 'combobox Country');
        await noSideScroll(c, '/settings/company');
        // A leftover from an interrupted earlier run: put the list back to one empty row first.
        const extra = await p().locator('input[aria-label^="Phone "][aria-label$=" number"]').count();
        if (extra > 1 || (await phone(c, 1).inputValue().catch(() => '')) !== '') {
          while ((await p().locator('input[aria-label="Phone 2 number"]').count()) > 0)
            await p().getByRole('button', { name: 'Remove phone 2' }).click();
          await phone(c, 1).fill('');
          const card0 = p().locator('form').filter({ has: p().locator('input[aria-label="Phone 1 number"]') });
          await card0.getByRole('button', { name: 'Save', exact: true }).click();
          await p().waitForTimeout(2500);
          await p().reload({ waitUntil: 'domcontentloaded' });
          c.controls.push('note: an earlier run had left company phones; they were cleared first');
        }
      });
      await step('3-pan-box', 'PAN number: letters are refused and a tenth digit is refused', async (c) => {
        const pan = p().getByRole('textbox', { name: 'PAN number' });
        const keep = await pan.inputValue();
        await pan.click();
        await p().keyboard.type('30a1234567890', { delay: 30 });
        const v = await pan.inputValue();
        c.ok(/^\d{0,9}$/.test(v.replace(/\s/g, '')) && v.replace(/\D/g, '').length <= 9, `the PAN box holds only digits, at most nine (${v})`);
        await pan.fill(keep);
      });
      await step('4-four-phones', 'Phones: up to 4 rows, each with its own country, and no Primary control', async (c) => {
        await c.s.fill(phone(c, 1), '9812345678');
        for (let k = 2; k <= 4; k++) {
          await c.s.click(c.btn('Add phone number'), 'Add phone number');
          if (k === 3) await pickCountry(c, p().getByRole('combobox', { name: `Phone ${k} country` }), 'United States');
          await c.s.fill(phone(c, k), k === 2 ? '14123456' : k === 3 ? '4155552671' : '9812345670');
        }
        c.ok((await c.btn('Add phone number').count()) === 0 || (await c.btn('Add phone number').isDisabled()), 'the add button stops at 4 rows');
        c.ok((await p().getByRole('radio', { name: /primary/i }).count()) === 0, 'no Primary control on the company phone list');
        await noSideScroll(c, 'company phones');
      });
      await step('5-save-and-reload', 'Saving the contact card keeps the numbers after a reload; the letterhead preview shows no country for Nepal', async (c) => {
        const card = p().locator('form').filter({ has: p().locator('input[aria-label="Phone 1 number"]') });
        await c.s.click(card.getByRole('button', { name: 'Save', exact: true }), 'Save (contact card)');
        await p().waitForTimeout(2500);
        await p().reload({ waitUntil: 'domcontentloaded' });
        await c.see(p().locator('input[aria-label="Phone 4 number"]'), 'four phone rows after a reload', 45000);
        S.companyChanged = true;
        ledger({ kind: 'settings: company contact phones set to four numbers (restored in the next step)', path: '/settings/company', size: S.size });
        const preview = await p().evaluate(() => [...document.querySelectorAll('*')].filter((e) => e.children.length === 0 && /12 Durbar Marg/.test(e.textContent || '')).map((e) => (e.parentElement?.innerText || '').replace(/\s+/g, ' ')).filter((t) => t.length < 400));
        c.ok(preview.length === 0 || preview.every((t) => !/Nepal/.test(t)), 'the letterhead address line does not print Nepal', preview.join(' | ').slice(0, 200));
      });
      await step('6-restore', 'Restore: remove the added numbers and save; the list is back to what it was', async (c) => {
        for (const k of [4, 3, 2]) await p().getByRole('button', { name: `Remove phone ${k}` }).click();
        await p().getByRole('button', { name: 'Remove phone 1' }).click().catch(() => {});
        await p().locator('input[aria-label="Phone 1 number"]').fill('').catch(() => {});
        const card = p().locator('form').filter({ has: p().locator('input[aria-label="Phone 1 number"]') });
        await c.s.click(card.getByRole('button', { name: 'Save', exact: true }), 'Save (contact card)');
        await p().waitForTimeout(2500);
        await p().reload({ waitUntil: 'domcontentloaded' });
        await c.see(p().locator('input[aria-label="Phone 1 number"]'), 'the phone list after a reload', 45000);
        c.ok((await p().locator('input[aria-label="Phone 2 number"]').count()) === 0, 'only one (empty) phone row is left');
        c.ok((await p().locator('input[aria-label="Phone 1 number"]').inputValue()) === '', 'phone 1 is empty again (the original state)');
        S.companyChanged = false;
      });
    },
  },
];

const OPP_NOQUOTE = '/opportunities/1f8c2e1b-64bd-483c-8110-22a92c232c6a'; // DEAL-2083/84-00002, Qualified, no quotation (seeded by earlier runs)

export const FX5_FLOWS = [
  {
    area: 'sales',
    flow: 'discount-pair-manual-invoice',
    persona: 'Dev Finance',
    async steps(c, S, step) {
      const p = () => c.page();
      const pct = () => p().getByRole('spinbutton', { name: /Discount %/ });
      const amt = () => p().getByRole('textbox', { name: /^Discount amount/ });
      await step('1-as', 'Sign in as Dev Finance', async (c) => {
        await c.as('Dev Finance');
      });
      await step('2-new', 'Invoices > Create Invoice opens the manual invoice form', async (c) => {
        await goNav(c, S, 'Invoices', '/invoices');
        await c.s.click(p().getByRole('link', { name: /Create Invoice/ }), 'Create Invoice');
        await c.see(c.btn('Save draft invoice'), 'button Save draft invoice');
        await c.see(pct(), 'spinbutton Discount %');
        await c.see(amt(), 'textbox Discount amount');
        await noSideScroll(c, '/invoices/new');
      });
      await step('3-line', 'A 5,000 line is the base for the discount', async (c) => {
        await c.s.fill(p().getByRole('textbox', { name: 'Description (line 1)' }), 'FQA2 discount check');
        await c.s.fill(p().getByRole('textbox', { name: 'Unit (line 1)' }), 'lot');
        await c.s.fill(p().getByRole('textbox', { name: /^Unit price .*\(line 1\)/ }), '5000');
        await p().keyboard.press('Tab');
      });
      await step('4-pct-to-amount', 'Typing 10 in Discount % fills Discount amount with 500.00', async (c) => {
        await c.s.fill(pct(), '10');
        await p().keyboard.press('Tab');
        await p().waitForTimeout(600);
        const v = await amt().inputValue();
        c.ok(/^500(\.00)?$/.test(v.replace(/,/g, '')), `Discount amount reads 500.00 (${v})`);
        await reachable(c, amt(), 'Discount amount');
      });
      await step('5-amount-to-pct', 'Clearing it and typing 250 in Discount amount shows 5 in Discount %', async (c) => {
        await c.s.fill(pct(), '');
        await c.s.fill(amt(), '250');
        await p().keyboard.press('Tab');
        await p().waitForTimeout(600);
        const v = await pct().inputValue();
        c.ok(/^5(\.0+)?$/.test(v), `Discount % reads 5 (${v})`);
      });
      await step('6-price-follows', 'Changing the line price: the other box follows', async (c) => {
        await c.s.fill(p().getByRole('textbox', { name: /^Unit price .*\(line 1\)/ }), '10000');
        await p().keyboard.press('Tab');
        await p().waitForTimeout(800);
        const v = await pct().inputValue();
        c.ok(/^2\.5/.test(v), `Discount % follows the new base: 250 of 10,000 is 2.5 (${v})`);
        await noSideScroll(c, 'manual invoice with discount');
      });
    },
  },
  {
    area: 'sales',
    flow: 'discount-pair-quote-builder',
    persona: 'Dev Sales',
    async steps(c, S, step) {
      const p = () => c.page();
      const pct = () => p().getByRole('spinbutton', { name: /Discount %/ });
      const amt = () => p().getByRole('textbox', { name: /^Discount amount/ });
      await step('1-as', 'Sign in as Dev Sales', async (c) => {
        await c.as('Dev Sales');
      });
      await step('2-builder', 'A Qualified deal opens the quotation builder', async (c) => {
        await c.open(OPP_NOQUOTE);
        const start = p().getByRole('link', { name: 'New quotation' }).or(c.btn('New quotation')).first();
        await c.s.click(start, 'New quotation');
        await c.see(c.heading('New quotation', { level: 1 }), 'heading New quotation');
        await p().waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
      });
      await step('3-line', 'Add a 5,000 line', async (c) => {
        await c.s.click(c.btn('Add the first line').or(c.btn('Add line')).first(), 'Add the first line');
        const add = p().getByRole('dialog', { name: 'Add line' });
        await add.getByLabel('Description').fill('FQA2 discount check');
        await add.getByLabel('Unit', { exact: true }).fill('lot');
        await add.getByLabel(/^Rate/).first().fill('5000');
        await c.s.choose(c.s.select('Tax code', { scope: add }), /VAT13|VAT 13/);
        await add.getByRole('button', { name: 'Add line', exact: true }).click();
        await c.see(p().getByRole('table', { name: 'Quotation lines' }).getByText('FQA2 discount check'), 'the line in the table');
      });
      await step('4-pair', 'Discount % 10 gives amount 500.00; typing 250 in the amount gives 5; the two boxes stack on a narrow screen', async (c) => {
        await c.s.fill(pct(), '10');
        await p().keyboard.press('Tab');
        await p().waitForTimeout(600);
        const v = await amt().inputValue();
        c.ok(/^500(\.00)?$/.test(v.replace(/,/g, '')), `Discount amount reads 500.00 (${v})`);
        await c.s.fill(pct(), '');
        await c.s.fill(amt(), '250');
        await p().keyboard.press('Tab');
        await p().waitForTimeout(600);
        const w = await pct().inputValue();
        c.ok(/^5(\.0+)?$/.test(w), `Discount % reads 5 (${w})`);
        const a = await pct().boundingBox();
        const b = await amt().boundingBox();
        if (S.viewport.startsWith('390')) c.ok(b.y > a.y + a.height - 2, 'on a phone the two discount boxes stack (amount below percent)');
        else c.controls.push(`discount boxes at ${S.viewport}: percent y=${Math.round(a.y)}, amount y=${Math.round(b.y)}`);
        await reachable(c, amt(), 'Discount amount');
        await noSideScroll(c, 'quote builder');
      });
    },
  },
];

// One deal with a Sent quotation per size, made through the real sales workflow (prep-lost.sh); the label is in the deal name.
const LOST_LABEL = { desktop: 'fqa2li', laptop: 'fqa2lf', tablet: 'fqa2lg', mobile: 'fqa2lh' };

export const LOST_FLOWS = [
  {
    area: 'sales',
    flow: 'deal-lost',
    persona: 'Dev Sales',
    mutates: true,
    async steps(c, S, step) {
      const p = () => c.page();
      const label = LOST_LABEL[S.size];
      const reason = `FQA2 lost ${S.tag}`;
      await step('1-as', 'Sign in as Dev Sales', async (c) => {
        await c.as('Dev Sales');
      });
      await step('2-deal', `Open the deal with a Sent quotation (${label})`, async (c) => {
        await goNav(c, S, 'Opportunities', '/opportunities');
        const box = p().getByRole('searchbox', { name: /Search/ }).first();
        await c.s.fill(box, `SCR-${label}`);
        const link = p().locator('main a[href^="/opportunities/"]').filter({ hasText: `SCR-${label}` }).first();
        await c.s.click(link, `the deal ${label}`);
        await p().waitForURL((u) => /^\/opportunities\/[0-9a-f-]{36}$/.test(u.pathname), { timeout: 60000 });
        S.deal = new URL(p().url()).pathname;
        await c.see(p().getByText('Quotation Sent').first(), 'stage Quotation Sent', 30000);
        await c.see(p().getByRole('button', { name: 'Mark lost', exact: true }), 'button Mark lost');
        await noSideScroll(c, 'the deal');
      });
      await step('3-quote-sent', 'The quotation is Sent and offers no ordinary Cancel button', async (c) => {
        const q = p().locator('main a[href^="/quotations/"]:not([href*="/new"])').first();
        const href = await q.getAttribute('href');
        S.quote = href;
        await c.s.click(q, 'the quotation');
        await c.see(p().getByText('Sent', { exact: true }).first(), 'status Sent', 30000);
        await c.absent(p().getByRole('button', { name: /^Cancel/ }), 'a Cancel button on a Sent quotation');
      });
      await step('4-lost-dialog', 'Mark lost: the dialog says open quotations will be cancelled; a reason and note save it', async (c) => {
        await c.open(S.deal);
        await c.s.click(p().getByRole('button', { name: 'Mark lost', exact: true }), 'Mark lost');
        const d = p().getByRole('dialog');
        await c.see(d.getByText(/Open quotations on this deal will be cancelled/), 'text "Open quotations on this deal will be cancelled."');
        await p().keyboard.press('Escape');
        await d.waitFor({ state: 'hidden', timeout: 10000 });
        await c.s.click(p().getByRole('button', { name: 'Mark lost', exact: true }), 'Mark lost');
        const dlg = p().getByRole('dialog');
        const cb = dlg.getByRole('combobox', { name: 'Reason' });
        await cb.click();
        await cb.fill(reason);
        await p().getByRole('option').first().click({ delay: 80 });
        await dlg.getByRole('textbox', { name: 'Note' }).fill('FQA2 note');
        await dlg.getByRole('button', { name: 'Mark lost', exact: true }).click({ delay: 80 });
        await c.see(p().getByText(/This opportunity is lost/), 'text "This opportunity is lost."', 60000);
        ledger({ kind: `deal ${label} marked lost`, path: S.deal, size: S.size });
      });
      await step('5-timeline', 'After Lost, the timeline still reads Quotation Sent as reached', async (c) => {
        await p().reload({ waitUntil: 'domcontentloaded' });
        const sent = p().getByText('Quotation Sent').first();
        await c.see(sent, 'timeline step Quotation Sent', 30000);
        const box = sent.locator('xpath=ancestor::*[contains(., "Not yet") or contains(., "Reached")][1]');
        const txt = (await box.innerText()).replace(/\s+/g, ' ');
        c.ok(!/Quotation Sent\s+Not yet/.test(txt), 'Quotation Sent does not read "Not yet"', txt.slice(0, 160));
      });
      await step('6-quote-cancelled', 'The quotation is Cancelled; its history names the reason and who marked the deal lost', async (c) => {
        await c.open(S.quote);
        await c.see(p().getByText('Cancelled', { exact: true }).first(), 'status Cancelled', 30000);
        await c.see(p().getByText(new RegExp(`Opportunity marked lost: ${reason}`)).first(), 'history reason "Opportunity marked lost: ..."');
        await c.see(p().getByText(/Dev Sales/).first(), 'the history names Dev Sales');
        await noSideScroll(c, 'cancelled quotation');
      });
    },
  },
];

export const FLAG_FLOWS = [
  {
    area: 'parties',
    flow: 'country-picker-flags',
    persona: 'Dev Sales',
    async steps(c, S, step) {
      const p = () => c.page();
      const fs = await import('node:fs');
      const path = await import('node:path');
      const dir = path.join(process.env.FQA_EVIDENCE, 'flags');
      fs.mkdirSync(dir, { recursive: true });
      await step('1-as', 'Sign in as Dev Sales', async (c) => {
        await c.as('Dev Sales');
      });
      await step('2-address-picker', 'FX9 Q3: the address Country list opens; screenshot of how the flags render', async (c) => {
        await c.open('/customers/new');
        const box = p().getByRole('combobox', { name: 'Country', exact: true }).nth(1);
        await box.scrollIntoViewIfNeeded();
        await box.click();
        await box.fill('');
        await p().waitForTimeout(800);
        const opts = p().getByRole('option');
        await opts.first().waitFor({ state: 'visible', timeout: 15000 });
        const first = (await opts.first().innerText()).replace(/\s+/g, ' ');
        c.ok(/Nepal/.test(first), `Nepal is listed first (${first})`);
        await p().screenshot({ path: path.join(dir, `country-picker-${S.size}.png`) });
        c.controls.push(`screenshot flags/country-picker-${S.size}.png`);
        S.flagText = (await opts.nth(1).innerText()).replace(/\s+/g, ' ');
        await p().keyboard.press('Escape');
      });
      await step('3-phone-picker', 'The phone country list opens; screenshot', async (c) => {
        const box = p().getByRole('combobox', { name: 'Phone 1 country' });
        await box.scrollIntoViewIfNeeded();
        await box.click();
        await p().waitForTimeout(800);
        await p().getByRole('option').first().waitFor({ state: 'visible', timeout: 15000 });
        await p().screenshot({ path: path.join(dir, `phone-country-picker-${S.size}.png`) });
        c.controls.push(`screenshot flags/phone-country-picker-${S.size}.png`);
        await p().keyboard.press('Escape');
      });
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
  ...LEAD_FLOWS,
  ...VENDOR_FLOWS,
  ...COMPANY_FLOWS,
  ...FX5_FLOWS,
  ...LOST_FLOWS,
  ...FLAG_FLOWS,
];
