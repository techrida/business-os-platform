import { expect, test, type Page } from '@playwright/test';

import { fillDateField } from '../helpers/date-fields';
import {
  approveInboxRequest,
  idFromUrl,
  pickFromCombobox,
  recordFixtureIds,
} from '../helpers/fixture-flow';
import { signInAs, type Signed } from '../helpers/memo-flow';
import { minimalPdf } from '../helpers/pdf-fixture';
import { chooseOption, selectByLabel, selectByName } from '../helpers/select';

/**
 * Warm-up step of the qa workflow ("qa fixtures": the specs skip it). The Journey 11 specs (p4/p4-exit.spec.ts here and
 * in apps/portal) need one connected purchase chain and an open RFQ. Each step is made by the persona who would make it,
 * through the same screens, in the order the business rules force:
 *   Procurement raises a purchase request of two serialized devices (NPR 120000) -> the department head approves ->
 *   Procurement opens an RFQ for the three approved vendors, enters their three quotations, recommends the cheapest ->
 *   commitment approval by the Accountant, Finance and Management -> the draft order is issued by Procurement ->
 *   the warehouse receives both devices with their serial numbers -> the Founder keys in the invoice against the order
 *   (a bill needs the "enter" grant, held by the Accountant and the Founder) -> the Accountant and a second Finance
 *   user approve the bill, which posts it.
 * A second purchase request is approved and given an RFQ that invites the dev vendor and stays open, for the portal's
 * quotation upload. The ids go to .dev/qa-fixture-ids.json for export-ids.sh. A fresh stack only.
 */
test.use({ actionTimeout: 30_000 });

const VENDORS = ['Dev Vendor Co', 'Dev Vendor Two Co', 'Mumbai Industrial Supplies'] as const;
const SERIALS = ['SN-J11-0001', 'SN-J11-0002'] as const;
const ZERO_RATED = /zero/i;

/** A page the signed-in personas share the open contexts of, closed together at the end. */
class Personas {
  private readonly opened: Signed[] = [];
  constructor(
    private readonly browser: Parameters<typeof signInAs>[0],
    private readonly base: string,
  ) {}
  async as(key: string): Promise<Page> {
    const signed = await signInAs(this.browser, this.base, key);
    this.opened.push(signed);
    return signed.page;
  }
  async closeAll(): Promise<void> {
    await Promise.all(this.opened.map((s) => s.context.close()));
  }
}

/** Procurement saves and submits a purchase request; returns its id and number. */
async function raiseRequest(
  page: Page,
  why: string,
  serialized: boolean,
): Promise<{ id: string; number: string }> {
  await page.goto('/procurement/requests/new');
  await page.waitForLoadState('networkidle');
  await fillDateField(page, 'Needed by', '2030-12-31');
  await chooseOption(selectByName(page, 'departmentId'), { label: /operations/i });
  await chooseOption(selectByName(page, 'costCenterId'), { label: /operations/i });
  await page.getByLabel('Budget code').fill('P4-EXIT');
  await page.getByLabel('Why is this needed?').fill(why);
  await page.getByLabel('Description', { exact: true }).fill('Two serialized devices');
  await page.getByLabel('Unit', { exact: true }).fill('pcs');
  await page.getByLabel('Quantity', { exact: true }).fill('2');
  await page.getByLabel(/Estimated unit price/).fill('60000.00');
  if (serialized)
    await page.getByRole('checkbox', { name: 'Record serial numbers at receipt' }).check();
  await page.getByRole('button', { name: 'Save draft', exact: true }).click();
  await expect(page).toHaveURL(/\/procurement\/requests\/[0-9a-f-]{36}\?created=1$/);
  const id = idFromUrl(page);
  await page.getByRole('button', { name: 'Submit for approval', exact: true }).click();
  await expect(page.getByText('Awaiting approval', { exact: true })).toBeVisible();
  return { id, number: (await page.getByRole('heading', { level: 1 }).innerText()).trim() };
}

/** Procurement opens an RFQ for an approved request, inviting the vendors whose names are given; returns the RFQ id. */
async function openRfq(page: Page, requestId: string, vendors: readonly string[]): Promise<string> {
  await page.goto(`/procurement/requests/${requestId}`);
  // The request is approved by the department head in another context: reload until the RFQ link is offered.
  await expect(async () => {
    await page.reload();
    await expect(page.getByRole('link', { name: 'Start RFQ', exact: true })).toBeVisible({
      timeout: 3_000,
    });
  }).toPass({ timeout: 60_000 });
  await page.getByRole('link', { name: 'Start RFQ', exact: true }).click();
  await page.waitForLoadState('networkidle');
  await fillDateField(page, 'Quotation deadline', '2030-12-01', '17:00');
  for (const name of vendors) await page.getByRole('checkbox', { name: new RegExp(name) }).check();
  await page.getByRole('button', { name: 'Open RFQ', exact: true }).click();
  await expect(page).toHaveURL(/\/procurement\/rfqs\/[0-9a-f-]{36}\?created=1$/);
  await expect(
    page.getByText(`Invited vendors (${vendors.length})`, { exact: true }),
  ).toBeVisible();
  return idFromUrl(page);
}

/** Procurement records one vendor's quotation: two devices at `unitPrice`, zero-rated, with a document. */
async function enterQuotation(
  page: Page,
  rfqId: string,
  vendor: string,
  unitPrice: string,
): Promise<void> {
  await page.goto(`/procurement/rfqs/${rfqId}/quotations/new`);
  await page.waitForLoadState('networkidle');
  await pickFromCombobox(page, 'Vendor', vendor.split(' ')[0] ?? vendor, vendor);
  await page.getByLabel('Quotation document').setInputFiles({
    name: 'quotation.pdf',
    mimeType: 'application/pdf',
    buffer: minimalPdf(`QA fixture quotation of ${vendor}`),
  });
  await page.waitForLoadState('networkidle');
  await page.getByLabel('Unit price (line 1)').first().fill(unitPrice);
  await chooseOption(selectByLabel(page, /^Tax code/), { label: ZERO_RATED });
  await page.getByRole('button', { name: 'Record quotation', exact: true }).click();
  await expect(page).toHaveURL(/\/procurement\/rfqs\/[0-9a-f-]{36}\?quoted=1$/);
}

/** Reloads until the document route of a version answers with the PDF: the worker renders and scans it first. */
async function waitForPdf(page: Page, orderId: string): Promise<void> {
  await expect(async () => {
    const res = await page.request.get(`/procurement/orders/${orderId}/versions/1/document`);
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toContain('application/pdf');
  }).toPass({ timeout: 180_000 });
}

test('qa fixtures: one connected Journey 11 (request, RFQ, order, serialized receipt, approved bill) and an open RFQ', async ({
  browser,
  baseURL,
}) => {
  test.setTimeout(1_800_000);
  const people = new Personas(browser, baseURL ?? 'https://app.localhost');
  try {
    const procurement = await people.as('procurement');
    const ids: Record<string, string> = {};

    await test.step('Procurement raises the request and the department head approves it', async () => {
      const request = await raiseRequest(procurement, `Journey 11 fixture ${Date.now()}`, true);
      ids['p4ExitPr'] = request.id;
      await approveInboxRequest(
        await people.as('depthead'),
        request.number,
        'QA fixture: approved',
      );
    });

    let rfqNumber = '';
    await test.step('Procurement opens the RFQ for the three vendors, records three quotations and recommends the cheapest', async () => {
      ids['p4ExitRfq'] = await openRfq(procurement, ids['p4ExitPr'] ?? '', VENDORS);
      rfqNumber = (await procurement.getByRole('heading', { level: 1 }).innerText()).trim();
      await enterQuotation(procurement, ids['p4ExitRfq'], VENDORS[0], '60000.00');
      await enterQuotation(procurement, ids['p4ExitRfq'], VENDORS[1], '62000.00');
      await enterQuotation(procurement, ids['p4ExitRfq'], VENDORS[2], '65000.00');
      await procurement.goto(`/procurement/rfqs/${ids['p4ExitRfq']}`);
      await chooseOption(selectByName(procurement, 'vendorQuotationId'), { label: VENDORS[0] });
      await procurement
        .getByLabel('Why this quotation', { exact: false })
        .fill('Lowest compliant quotation with the required warranty');
      await procurement
        .getByRole('button', { name: 'Recommend this quotation', exact: true })
        .click();
      await expect(procurement.getByText('The quotation was recommended.')).toBeVisible();
    });

    await test.step('the commitment goes to the Accountant, Finance and Management', async () => {
      await procurement
        .getByRole('button', { name: 'Submit for commitment approval', exact: true })
        .click();
      await procurement
        .getByRole('dialog', { name: /Submit for commitment approval/ })
        .getByRole('button', { name: 'Submit', exact: true })
        .click();
      await expect(
        procurement.getByRole('region', { name: 'Commitment approval', exact: true }),
      ).toBeVisible({ timeout: 60_000 });
      await approveInboxRequest(await people.as('accountant'), rfqNumber, 'QA fixture: checked');
      await approveInboxRequest(await people.as('finance'), rfqNumber, 'QA fixture: budget ok');
      await approveInboxRequest(await people.as('management'), rfqNumber, 'QA fixture: approved');
    });

    await test.step('Procurement issues the draft order the approval created', async () => {
      await procurement.goto(`/procurement/requests/${ids['p4ExitPr']}`);
      // The request lists its purchase order, each linked to its receipts by the order's id.
      await expect(async () => {
        await procurement.reload();
        const href = await procurement
          .locator('main a[href*="/procurement/receipts?po="]')
          .first()
          .getAttribute('href', { timeout: 3_000 });
        ids['p4ExitPo'] = /po=([0-9a-f-]{36})/.exec(href ?? '')?.[1] ?? '';
        expect(ids['p4ExitPo'], 'the request lists its purchase order').not.toBe('');
      }).toPass({ timeout: 60_000 });
      await procurement.goto(`/procurement/orders/${ids['p4ExitPo']}`);
      await procurement.getByRole('button', { name: 'Issue purchase order', exact: true }).click();
      const dialog = procurement.getByRole('dialog');
      await dialog.getByRole('button', { name: 'Issue purchase order', exact: true }).click();
      const done = dialog.getByRole('button', { name: 'Done', exact: true });
      if (await done.isVisible({ timeout: 30_000 }).catch(() => false)) await done.click();
      await expect(
        procurement.getByRole('button', { name: 'Issue purchase order', exact: true }),
      ).toHaveCount(0, { timeout: 30_000 });
      await waitForPdf(procurement, ids['p4ExitPo'] ?? '');
    });

    await test.step('the warehouse receives both devices with their serial numbers', async () => {
      const warehouse = await people.as('warehouse');
      await warehouse.goto(`/procurement/receipts/new?po=${ids['p4ExitPo']}`);
      await warehouse.waitForLoadState('networkidle');
      await warehouse.getByLabel('Quantity received (line 1)').first().fill('2');
      await warehouse.getByLabel('Serial numbers (line 1)').fill(SERIALS.join('\n'));
      await warehouse.getByRole('button', { name: 'Save draft receipt', exact: true }).click();
      await expect(warehouse).toHaveURL(/\/procurement\/receipts\/[0-9a-f-]{36}\?created=1$/);
      ids['p4ExitReceipt'] = idFromUrl(warehouse);
      await warehouse.getByRole('button', { name: 'Confirm receipt', exact: true }).click();
      const dialog = warehouse.getByRole('dialog');
      await dialog.getByRole('button', { name: 'Confirm receipt', exact: true }).click();
      const done = dialog.getByRole('button', { name: 'Done', exact: true });
      if (await done.isVisible({ timeout: 30_000 }).catch(() => false)) await done.click();
      await expect(
        warehouse.getByRole('button', { name: 'Confirm receipt', exact: true }),
      ).toHaveCount(0, { timeout: 30_000 });
    });

    let billNumber = '';
    await test.step('the Founder keys in the invoice against the order and submits the matched bill', async () => {
      const enterer = await people.as('founder');
      await enterer.goto(`/payables/bills/new?po=${ids['p4ExitPo']}`);
      await enterer.waitForLoadState('networkidle');
      await enterer.locator('input[name="vendorInvoiceNo"]').fill('J11-INV-001');
      await enterer.locator('input[type="file"]').setInputFiles({
        name: 'invoice.pdf',
        mimeType: 'application/pdf',
        buffer: minimalPdf('Journey 11 vendor invoice'),
      });
      await enterer.getByRole('button', { name: 'Upload invoice', exact: true }).click();
      await expect(enterer.getByText('Invoice uploaded').first()).toBeVisible({ timeout: 60_000 });
      await enterer.getByLabel('Quantity', { exact: true }).first().fill('2');
      await enterer.getByLabel('Unit price', { exact: true }).first().fill('60000.00');
      await chooseOption(selectByLabel(enterer, 'VAT'), { label: ZERO_RATED });
      await enterer.getByRole('combobox', { name: 'Expense account', exact: true }).click();
      await enterer.getByRole('option').first().click();
      await enterer.getByRole('button', { name: 'Create bill', exact: true }).click();
      await expect(enterer).toHaveURL(/\/payables\/bills\/[0-9a-f-]{36}(\?created=1)?$/);
      ids['p4ExitBill'] = idFromUrl(enterer);
      await expect(enterer.getByText('Matched', { exact: true }).first()).toBeVisible();
      const submit = enterer.getByRole('button', { name: 'Submit for approval', exact: true });
      await submit.click();
      await enterer
        .getByRole('dialog', { name: /^Submit / })
        .getByRole('button', { name: 'Submit for approval', exact: true })
        .click();
      // The invoice file is scanned in the background; the submit is refused until it is clean.
      await expect(async () => {
        await enterer.goto(`/payables/bills/${ids['p4ExitBill']}`);
        await expect(enterer.getByText('Awaiting approval', { exact: true }).first()).toBeVisible({
          timeout: 3_000,
        });
      }).toPass({ timeout: 90_000 });
      billNumber =
        /BILL-\S+/.exec(await enterer.getByRole('heading', { level: 1 }).innerText())?.[0] ?? '';
      expect(billNumber, 'the bill number is on its page').not.toBe('');
    });

    await test.step('the Accountant and a second Finance user approve the bill', async () => {
      await approveInboxRequest(await people.as('accountant'), billNumber, 'QA fixture: checked');
      const finance2 = await people.as('finance2');
      await approveInboxRequest(finance2, billNumber, 'QA fixture: approved');
      await finance2.goto(`/payables/bills/${ids['p4ExitBill']}`);
      await expect(finance2.getByText('Approved', { exact: true }).first()).toBeVisible();
    });

    await test.step('a second approved request gets an RFQ that stays open for the dev vendor', async () => {
      const request = await raiseRequest(procurement, `Journey 11 open RFQ ${Date.now()}`, false);
      await approveInboxRequest(
        await people.as('depthead'),
        request.number,
        'QA fixture: approved',
      );
      ids['p4ExitOpenRfq'] = await openRfq(procurement, request.id, [VENDORS[0]]);
    });

    recordFixtureIds({ ...ids, p4ExitSerials: [...SERIALS] });
  } finally {
    await people.closeAll();
  }
});
