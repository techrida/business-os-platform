import { expect, test } from '@playwright/test';

import { pickCountry } from '../helpers/country';
import { minimalPdf } from '../helpers/pdf-fixture';
import { signInAs, type Signed } from '../helpers/memo-flow';
import { searchBox } from '../helpers/multi-select';

/**
 * The P4 vendor screens, against the real stack. Not run by the unit that wrote it: it needs the
 * vendor, bank-account and verification API routes, the P4 permission grants, and the seeded
 * founder persona (who holds every vendor permission, so the maker-checker refusals can be seen
 * with one person). Written for the lead to run; it skips unless BOS_E2E_P4=1.
 *
 * (1) The list loads and a search with no match says so, keeping the text.
 * (2) A foreign vendor is created, gets a contact, and starts its KYB review.
 * (3) The proposer cannot verify their own bank account, and the refusal is shown in plain words.
 * The bank account shows its last four characters only.
 */

test.skip(process.env.BOS_E2E_P4 !== '1', 'set BOS_E2E_P4=1 to run the P4 vendor screens');

test('the vendor list loads and searches', async ({ browser, baseURL }) => {
  test.setTimeout(120_000);
  const appBase = baseURL ?? 'https://app.localhost';
  const opened: Signed[] = [];
  try {
    const founder = await signInAs(browser, appBase, 'founder');
    opened.push(founder);
    await founder.page.goto('/vendors');
    await expect(founder.page.getByRole('heading', { level: 1, name: 'Vendors' })).toBeVisible();
    // Search is instant (debounced) and lives in the URL: no Apply button. A nonsense token, because
    // the typo-tolerant search also returns close matches when few vendors match exactly.
    const query = 'qzxjwkv4471';
    const search = searchBox(founder.page, 'Search vendors');
    await search.fill(query);
    await expect(founder.page).toHaveURL((url) => url.searchParams.get('q') === query);
    await expect(founder.page.getByText('No vendors match.')).toBeVisible();
    await expect(search).toHaveValue(query);
  } finally {
    await Promise.all(opened.map((s) => s.context.close()));
  }
});

test('a vendor goes from draft to KYB review, and its maker-checker refusals read plainly', async ({
  browser,
  baseURL,
}) => {
  test.setTimeout(180_000);
  const appBase = baseURL ?? 'https://app.localhost';
  const opened: Signed[] = [];
  const name = `E2E Vendor ${Date.now()}`;
  try {
    const founder = await signInAs(browser, appBase, 'founder');
    opened.push(founder);
    const { page } = founder;

    await test.step('a foreign vendor is created without a PAN', async () => {
      await page.goto('/vendors/new');
      await page.getByLabel('Legal name').fill(name);
      // Choosing a country outside Nepal makes the vendor foreign by itself (vendor-form.tsx setAddress): the country
      // is picked first, because choosing the foreign kind while the country is still Nepal puts it back to a company.
      await pickCountry(
        page.getByRole('combobox', { name: 'Country', exact: true }),
        'india',
        'India',
      );
      // Exact role match: the Kind control's option text ("Company (registered, with a PAN)") also contains "PAN".
      await expect(page.getByRole('textbox', { name: 'PAN', exact: true })).toHaveCount(0);
      await page.getByRole('button', { name: 'Add vendor' }).click();
      await expect(page).toHaveURL(/\/vendors\/[0-9a-f-]{36}\?created=1/);
      await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();
      await expect(page.getByText('Draft', { exact: true }).first()).toBeVisible();
    });

    await test.step('a contact is added', async () => {
      await page.getByLabel('Name', { exact: true }).fill('Anil Rao');
      await page.getByLabel('Email').fill('anil@example.com');
      await page.getByRole('button', { name: 'Add contact' }).click();
      await expect(page.getByText('Anil Rao was added.')).toBeVisible();
    });

    await test.step('a bank account is proposed and shows its last four only', async () => {
      await page.getByLabel('Bank', { exact: true }).fill('HDFC Bank');
      await page.getByLabel('Account name').fill(name);
      await page.getByLabel('Account number').fill('5010 0123 4567');
      await page.getByRole('button', { name: 'Propose bank account' }).click();
      await expect(page.getByText(/different person must verify/)).toBeVisible();
      await expect(page.getByText('Account ending')).toBeVisible();
      await expect(page.getByText('4567').first()).toBeVisible();
      await expect(page.getByText('501001234567')).toHaveCount(0);
    });

    await test.step('the proposer verifying their own account is refused in plain words', async () => {
      await page.getByLabel('Call-back evidence').setInputFiles({
        name: 'callback.pdf',
        mimeType: 'application/pdf',
        buffer: minimalPdf('call-back evidence'),
      });
      await page.getByRole('button', { name: 'Verify account' }).click();
      // The virus scan may still be running (409), or finished (403 for the proposer): both are plain.
      await expect(
        page.getByText(/You proposed this bank account, so someone else must verify it|virus scan/),
      ).toBeVisible({ timeout: 60_000 });
    });

    await test.step('the KYB review starts and the status moves', async () => {
      await page.getByRole('button', { name: 'Start KYB review' }).click();
      // The button opens a "Start KYB review?" confirm; the same words label its confirm button.
      const confirm = page.getByRole('dialog', { name: 'Start KYB review?' });
      await confirm.getByRole('button', { name: 'Start KYB review', exact: true }).click();
      await expect(page.getByText('KYB review started.')).toBeVisible();
    });
  } finally {
    await Promise.all(opened.map((s) => s.context.close()));
  }
});
