import { expect, test, type Page } from '@playwright/test';

import {
  approveInboxRequest,
  idFromUrl,
  pickFromCombobox,
  recordFixtureIds,
} from '../helpers/fixture-flow';
import { signInAs, type Signed } from '../helpers/memo-flow';
import { minimalPdf } from '../helpers/pdf-fixture';
import { chooseOption, selectByLabel } from '../helpers/select';

/**
 * Warm-up step of the qa workflow ("qa fixtures": the specs skip it). The payment request spec (p4/payment-requests,
 * "a seeded draft") opens a draft request, which needs a payable item and a verified vendor bank account. Each comes
 * from the persona who would make it, through the same screens, in the order the business rules force:
 * Procurement proposes the vendor's bank account, Finance verifies it with a call-back evidence file (a different person
 * must verify); the Founder (who holds the bill-entry grant) keys in the vendor's bill and submits it, the Accountant and a second
 * Finance user approve it (approval posts the payable item); Finance drafts the payment request from that bill.
 * The draft's id goes to .dev/qa-fixture-ids.json for export-ids.sh. A fresh stack only: it makes new documents each run.
 */
test.use({ actionTimeout: 30_000 });

const VENDOR = 'Dev Vendor Co';
const INVOICE_NO = 'QA-PAY-INV-1';

async function openVendor(page: Page): Promise<void> {
  await page.goto('/vendors');
  await page.getByRole('link', { name: VENDOR }).first().click();
  await expect(page).toHaveURL(/\/vendors\/[0-9a-f-]{36}/);
  await expect(page.getByRole('heading', { level: 1, name: VENDOR })).toBeVisible();
}

test('qa fixtures: a draft payment request on a verified vendor account and an approved bill', async ({
  browser,
  baseURL,
}) => {
  test.setTimeout(900_000);
  const base = baseURL ?? 'https://app.localhost';
  const opened: Signed[] = [];
  const as = async (key: string): Promise<Page> => {
    const signed = await signInAs(browser, base, key);
    opened.push(signed);
    return signed.page;
  };
  try {
    await test.step('Procurement proposes the vendor bank account', async () => {
      const procurement = await as('procurement');
      await openVendor(procurement);
      await procurement.getByLabel('Bank', { exact: true }).fill('QA Fixture Bank');
      await procurement.getByLabel('Account name').fill(VENDOR);
      await procurement.getByLabel('Account number').fill('0011 2233 4455');
      await procurement.getByRole('button', { name: 'Propose bank account' }).click();
      await expect(procurement.getByText('Account ending').first()).toBeVisible();
    });

    await test.step('Finance verifies it with call-back evidence', async () => {
      const finance = await as('finance');
      await openVendor(finance);
      await finance.getByLabel('Call-back evidence').setInputFiles({
        name: 'callback-evidence.pdf',
        mimeType: 'application/pdf',
        buffer: minimalPdf('QA fixture call-back evidence'),
      });
      const verify = finance.getByRole('button', { name: 'Verify account', exact: true });
      // The evidence is virus-scanned first: a verify sent before the scan ends is refused, so the click is repeated.
      await expect(async () => {
        if (await verify.isVisible()) await verify.click();
        await expect(verify).toHaveCount(0, { timeout: 8_000 });
      }).toPass({ timeout: 120_000 });
    });

    let billId = '';
    let billNumber = '';
    await test.step('the Founder keys in the vendor bill and submits it', async () => {
      const enterer = await as('founder');
      await enterer.goto('/payables/bills/new');
      await enterer.waitForLoadState('networkidle');
      await pickFromCombobox(enterer, 'Vendor', 'Dev Vendor', VENDOR);
      await enterer.locator('input[name="vendorInvoiceNo"]').fill(INVOICE_NO);
      await enterer.locator('input[type="file"]').setInputFiles({
        name: 'invoice.pdf',
        mimeType: 'application/pdf',
        buffer: minimalPdf('QA fixture vendor invoice'),
      });
      await enterer.getByRole('button', { name: 'Upload invoice', exact: true }).click();
      await expect(enterer.getByText('Invoice uploaded').first()).toBeVisible({
        timeout: 60_000,
      });
      await enterer.getByLabel('Quantity').fill('1');
      await enterer.getByLabel('Unit price').fill('10000.00');
      await chooseOption(selectByLabel(enterer, 'VAT'), { index: 1 });
      const account = enterer.getByRole('combobox', { name: 'Expense account', exact: true });
      await account.click();
      await enterer.getByRole('option').first().click();
      await enterer.getByRole('button', { name: 'Create bill', exact: true }).click();
      await expect(enterer).toHaveURL(/\/payables\/bills\/[0-9a-f-]{36}$/);
      billId = idFromUrl(enterer);
      // The invoice file is scanned in the background; the submit is refused until it is clean.
      const submit = enterer.getByRole('button', { name: 'Submit for approval', exact: true });
      await expect(submit).toBeVisible();
      await submit.click();
      const dialog = enterer.getByRole('dialog', { name: /^Submit / });
      await dialog.getByRole('button', { name: 'Submit for approval', exact: true }).click();
      await expect(async () => {
        await enterer.goto(`/payables/bills/${billId}`);
        await expect(enterer.getByText('Awaiting approval', { exact: true }).first()).toBeVisible({
          timeout: 3_000,
        });
      }).toPass({ timeout: 60_000 });
      billNumber =
        /BILL-\S+/.exec(await enterer.getByRole('heading', { level: 1 }).innerText())?.[0] ?? '';
      expect(billNumber, 'the bill number is on its page').not.toBe('');
    });

    await test.step('two approvers other than the bill enterer approve it, which posts the payable item', async () => {
      const accountant = await as('accountant');
      await approveInboxRequest(accountant, billNumber, 'QA fixture: checked');
      const finance2 = await as('finance2');
      await approveInboxRequest(finance2, billNumber, 'QA fixture: approved');
      await finance2.goto(`/payables/bills/${billId}`);
      await expect(finance2.getByText('Approved', { exact: true }).first()).toBeVisible();
    });

    await test.step('Finance drafts the payment request from the bill', async () => {
      const finance = await as('finance');
      await finance.goto(`/payables/payment-requests/new?bill=${billId}`);
      await finance.waitForLoadState('networkidle');
      await expect(
        finance.getByRole('heading', { level: 1, name: 'New payment request' }),
      ).toBeVisible();
      const bill = selectByLabel(finance, 'Bill 1');
      // `?bill=` fills the first item; choose it by hand when it did not.
      if ((await bill.innerText()).includes('Choose an approved bill')) {
        await chooseOption(bill, { index: 1 });
      }
      const amount = finance.getByLabel('Amount 1');
      if ((await amount.inputValue()) === '') await amount.fill('11300.00');
      const bank = finance.getByRole('combobox', { name: 'Pay from bank account', exact: true });
      await bank.click();
      await finance.getByRole('option').first().click();
      await finance.getByRole('button', { name: 'Create draft request', exact: true }).click();
      await expect(finance).toHaveURL(/\/payables\/payment-requests\/[0-9a-f-]{36}$/);
      await expect(
        finance.getByText('Verified vendor account snapshot', { exact: true }),
      ).toBeVisible();
      recordFixtureIds({ paymentRequestDraft: idFromUrl(finance) });
    });
  } finally {
    await Promise.all(opened.map((s) => s.context.close()));
  }
});
