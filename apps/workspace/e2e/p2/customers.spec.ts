import { expect, test } from '@playwright/test';

import { pickCountry } from '../helpers/country';
import { signInAs, type Signed } from '../helpers/memo-flow';
import { searchBox } from '../helpers/multi-select';

/**
 * The P2 customer and KYB screens, against the real stack. Not run by the unit that wrote it: it
 * needs the customer and verification API routes, the K3 permission grants (until they land every
 * P2 nav entry is hidden on purpose), and a case in the review queue. Written for the lead to run
 * once those exist; see the hand-back for the command.
 *
 * (1) The founder sees the CRM nav entries and the customer list loads, search included.
 * (2) The 403 wording is a fixme: K3 gives every staff persona `customer.read`, so no seeded persona
 *     can reach it. Add a persona without it (or a role-edit step) to turn it on.
 * (3) The KYB queue opens a case, and deciding without a reason is refused in place.
 */

test('the customer list loads and searches', async ({ browser, baseURL }) => {
  test.setTimeout(120_000);
  const appBase = baseURL ?? 'https://app.localhost';
  const opened: Signed[] = [];

  try {
    const founder = await signInAs(browser, appBase, 'founder');
    opened.push(founder);

    await test.step('the CRM group lists Customers and Verification', async () => {
      await founder.page.goto('/');
      const nav = founder.page.getByRole('navigation', { name: 'Main' });
      await expect(nav.getByRole('link', { name: 'Customers' })).toBeVisible();
      await expect(nav.getByRole('link', { name: 'Verification' })).toBeVisible();
    });

    await test.step('the list shows a table or an empty state, and the search keeps its text', async () => {
      await founder.page.goto('/customers');
      await expect(
        founder.page.getByRole('heading', { level: 1, name: 'Organizations' }),
      ).toBeVisible();
      // Search is instant (debounced) and lives in the URL: no Search button. A nonsense token,
      // because the typo-tolerant search also returns close matches when few rows match exactly.
      const query = 'qzxjwkv4471';
      const search = searchBox(founder.page, 'Search organizations');
      await search.fill(query);
      await expect(founder.page).toHaveURL((url) => url.searchParams.get('q') === query);
      await expect(founder.page.getByText('No organizations match.')).toBeVisible();
      await expect(search).toHaveValue(query);
    });
  } finally {
    await Promise.all(opened.map((s) => s.context.close()));
  }
});

test.fixme('a role without customer access sees words, not a blank page', () => {
  // Needs a seeded staff persona with no `customer.read`; none exists after K3.
});

test('a US customer without a PAN keeps its country and a contact number typed with +1', async ({
  browser,
  baseURL,
}) => {
  test.setTimeout(120_000);
  const { page, context } = await signInAs(browser, baseURL ?? 'https://app.localhost', 'founder');
  const stamp = Date.now();
  const name = `US customer ${stamp}`;

  try {
    await page.goto('/customers/new');
    await page.waitForLoadState('networkidle');
    await page.getByLabel('Organization legal name').fill(name);

    // The address's Country comes first: the contact's country and each new phone row follow it.
    // The organization's picker is "Country" and the contact's "Contact country"; each is still scoped.
    const address = page.getByRole('region', { name: 'Business Address' });
    await address.getByLabel('Address', { exact: true }).fill('1 Market Street');
    await address.getByLabel('City', { exact: true }).fill('San Francisco');
    await pickCountry(
      address.getByRole('combobox', { name: 'Country', exact: true }),
      'us',
      'United States',
    );

    const contact = page.getByRole('region', { name: 'Primary Contact' });
    await contact.getByLabel('Full name').fill('Jordan Lee');
    await contact.getByLabel('Email', { exact: true }).fill(`jordan.${stamp}@example.test`);
    await expect(
      contact.getByRole('combobox', { name: 'Contact country', exact: true }),
    ).toHaveValue('United States');

    // Typing + and the code switches the row's country: the box remounts and keeps the focus.
    const first = contact.getByLabel('Phone 1 number', { exact: true });
    await first.click();
    await page.keyboard.type('+');
    await expect(first).toBeFocused();
    await page.keyboard.type('1 4155552671');
    await expect(
      contact.getByRole('combobox', { name: 'Phone 1 country', exact: true }),
    ).toHaveValue('+1');

    await contact.getByRole('button', { name: 'Add phone number' }).click();
    await pickCountry(
      contact.getByRole('combobox', { name: 'Phone 2 country', exact: true }),
      '+977',
      '+977',
    );
    const second = contact.getByLabel('Phone 2 number', { exact: true });
    await second.click();
    await page.keyboard.type('9812345678');

    // What the form posts, as E.164: both rows are complete before the save.
    await expect(page.locator('input[name="contactPhones.0.number"]')).toHaveValue('+14155552671');
    await expect(page.locator('input[name="contactPhones.1.number"]')).toHaveValue(
      '+9779812345678',
    );
    await expect(page.getByLabel('PAN or VAT number')).toHaveValue('');

    await page.getByRole('button', { name: 'Create Organization', exact: true }).click();
    await expect(page).toHaveURL(/\/customers\/[0-9a-f-]{36}(?:\?created=1)?$/);
    await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();

    await expect(
      page.getByText('1 Market Street, San Francisco, United States', { exact: true }),
    ).toBeVisible();
    const phone = page
      .getByRole('table', { name: 'Contacts', exact: true })
      .getByRole('link', { name: '+1 415 555 2671', exact: true });
    await expect(phone).toBeVisible();
    await expect(phone).toHaveAttribute('href', 'tel:+14155552671');
  } finally {
    await context.close();
  }
});

test('the KYB queue opens a case and refuses a decision without a reason', async ({
  browser,
  baseURL,
}) => {
  test.setTimeout(120_000);
  const appBase = baseURL ?? 'https://app.localhost';
  const reviewer = await signInAs(browser, appBase, 'founder');

  try {
    const page = reviewer.page;
    await page.goto('/verification?status=submitted');
    await expect(page.getByRole('heading', { level: 1, name: 'Verification' })).toBeVisible();

    const firstCase = page
      .getByRole('table', { name: 'Verification cases' })
      .getByRole('link')
      .first();
    test.skip(
      (await firstCase.count()) === 0,
      'No case is awaiting review: seed a submitted verification case to run this.',
    );

    await firstCase.click();
    await expect(page.getByRole('table', { name: 'Verification documents' })).toBeVisible();

    // No reason: refused in place, with the field named, and nothing is sent to the API.
    await page.getByRole('button', { name: 'Reject', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Reject case' }).click();
    await expect(
      page.getByText('Say why you are rejecting. The reason is kept in the audit trail.'),
    ).toBeVisible();
  } finally {
    await reviewer.context.close();
  }
});

test('verification uploads immediately and only saves changes confirmed in the preview', async ({
  browser,
  baseURL,
}) => {
  test.setTimeout(180_000);
  const { page, context } = await signInAs(browser, baseURL ?? 'https://app.localhost', 'founder');
  const name = `Verification test ${Date.now()}`;
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGMwazkIAAJvAXxaFZv2AAAAAElFTkSuQmCC',
    'base64',
  );

  try {
    await page.goto('/customers/new');
    await page.waitForLoadState('networkidle');
    await page.getByLabel('Organization legal name').fill(name);
    await page.getByLabel('Address', { exact: true }).fill('Fixture road');
    await page.getByLabel('City', { exact: true }).fill('Kathmandu');
    // Every customer starts with a main contact who has an email (quotations are sent by email).
    await page.getByLabel('Full name').fill('Fixture Contact');
    await page.getByLabel('Email', { exact: true }).fill(`fixture.${Date.now()}@example.test`);
    await page.getByRole('button', { name: 'Create Organization', exact: true }).click();
    await expect(page).toHaveURL(/\/customers\/[0-9a-f-]{36}(?:\?created=1)?$/);
    await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();
    await page.getByRole('button', { name: 'Start verification' }).click();
    await expect(page).toHaveURL(/\/verification\/[0-9a-f-]{36}$/);

    const row = page
      .getByRole('row')
      .filter({ has: page.getByRole('rowheader', { name: 'PAN or VAT certificate' }) });
    const submit = page.getByRole('button', { name: 'Submit for review' });
    await expect(submit).toHaveAttribute('aria-disabled', 'true');
    await submit.press('Enter');
    await expect(page.getByText('Required before submitting')).toBeVisible();
    await submit.press('Escape');

    const choose = page.waitForEvent('filechooser');
    await row.getByRole('button', { name: 'Upload PAN or VAT certificate' }).click();
    const uploaded = page.waitForResponse(
      (res) => res.url().endsWith('/documents') && res.request().method() === 'POST',
    );
    await (await choose).setFiles({ name: 'certificate.png', mimeType: 'image/png', buffer: png });
    expect((await uploaded).status()).toBe(201);

    const editor = page.getByRole('dialog', { name: 'certificate.png' });
    await expect(editor.getByRole('img', { name: 'certificate.png' })).toBeVisible({
      timeout: 30_000,
    });
    await expect(editor.getByRole('img')).toHaveAttribute(
      'src',
      /^\/api\/documents\/[^/]+\/versions\/[^/]+\/preview$/,
    );
    await expect(editor.getByRole('img')).toHaveJSProperty('naturalWidth', 1);
    await expect(page.locator('tr').filter({ hasText: 'PAN or VAT certificate' })).toContainText(
      'Missing',
    );
    for (const [segment, digits] of [
      ['year', '2030'],
      ['month', '06'],
      ['day', '15'],
    ] as const) {
      await editor.locator(`[data-type="${segment}"]`).pressSequentially(digits);
    }
    await editor.getByRole('button', { name: /calendar/i }).click();
    const calendar = editor.getByRole('grid');
    await expect(calendar).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(calendar).toBeHidden();
    await expect(editor).toBeVisible();
    await editor.getByRole('button', { name: /calendar/i }).click();
    await calendar.locator('[data-selected]').click();
    await expect(calendar).toBeHidden();
    await editor.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(editor).toHaveCount(0);
    await expect(row.getByText('Pending', { exact: true })).toBeVisible();
    await expect(row.locator('time')).toHaveAttribute('datetime', '2030-06-15');

    const replacement = await page.evaluateHandle(
      (bytes) => {
        const transfer = new DataTransfer();
        transfer.items.add(
          new File([new Uint8Array(bytes)], 'replacement.png', { type: 'image/png' }),
        );
        return transfer;
      },
      [...png],
    );
    const stagedUpload = page.waitForResponse(
      (res) => res.url().endsWith('/documents') && res.request().method() === 'POST',
    );
    const target = row
      .getByRole('cell')
      .filter({ has: page.getByRole('button', { name: 'Change PAN or VAT certificate' }) });
    await target
      .getByRole('button', { name: 'Change PAN or VAT certificate' })
      .dispatchEvent('drop', { dataTransfer: replacement });
    const staged = (await (await stagedUpload).json()) as { documentId: string };
    await replacement.dispose();

    const replacementEditor = page.getByRole('dialog', { name: 'replacement.png' });
    await replacementEditor.getByRole('button', { name: 'Clear date' }).click();
    const cleanup = page.waitForResponse(
      (res) =>
        res.url().endsWith(`/api/documents/${staged.documentId}`) &&
        res.request().method() === 'DELETE',
    );
    await replacementEditor.getByRole('button', { name: 'Cancel' }).click();
    expect((await cleanup).ok()).toBe(true);

    await page.reload();
    await expect(row.locator('time')).toHaveAttribute('datetime', '2030-06-15');
    await row.getByRole('button', { name: 'Change PAN or VAT certificate' }).click();
    await expect(editor).toBeVisible();
    await editor.getByRole('button', { name: 'Cancel' }).click();

    await row.getByRole('button', { name: 'Remove certificate.png' }).click();
    const removal = page.getByRole('dialog', { name: 'Remove certificate.png?' });
    await removal.getByRole('button', { name: 'Remove file' }).click();
    await expect(row.getByRole('button', { name: 'Upload PAN or VAT certificate' })).toBeVisible();
    await expect(row.getByText('No expiry', { exact: true })).toBeVisible();
  } finally {
    await context.close();
  }
});
