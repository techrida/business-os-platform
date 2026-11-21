// Table tests of the purchase order rules (P4 unit P3; AD4; F1-Q40). Pure: no database.
// Run: pnpm --filter @bos/api exec vitest run src/modules/procurement/orders/purchase-order.rules.test.ts
import { WorkflowSpecSchema } from '@bos/contracts';
import { describe, expect, it } from 'vitest';

import {
  AmendPurchaseOrderBodySchema,
  ChangePurchaseOrderVendorBodySchema,
  ListPurchaseOrdersQuerySchema,
  PO_AMENDMENT_DOCUMENT_TYPE,
  PO_AMENDMENT_WORKFLOW_SPEC,
  PO_VENDOR_CHANGE_NOT_DRAFT,
  amendLines,
  amendmentApprovalReasons,
  shortCloseCancelled,
  vendorChangeRefusal,
  versionTotals,
  type PoLineState,
} from './purchase-order.rules';

const VAT = 'vat13';
const rate = () => 1300;
const line = (over: Partial<PoLineState> = {}): PoLineState => ({
  id: 'l1',
  orderedQuantity: '1.0000',
  cancelledQuantity: '0.0000',
  unitPrice: '79646.02',
  taxCodeId: VAT,
  receivedQuantity: '0.0000',
  ...over,
});

describe('PO_AMENDMENT_WORKFLOW_SPEC', () => {
  it('is a valid workflow spec for po_amendment', () => {
    const spec = WorkflowSpecSchema.parse(PO_AMENDMENT_WORKFLOW_SPEC);
    expect(spec.documentType).toBe(PO_AMENDMENT_DOCUMENT_TYPE);
  });
});

describe('amendmentApprovalReasons (F1-Q40)', () => {
  const at = (nextTotal: string, nextTermsDays = 30) =>
    amendmentApprovalReasons({
      currentTotal: '90000.00',
      nextTotal,
      currentTermsDays: 30,
      nextTermsDays,
    });

  it('re-runs approvals when the total rises, even inside the same band', () => {
    expect(at('90000.01')).toEqual(['value_rises']);
    expect(at('99000.00')).toEqual(['value_rises']);
    expect(at('150000.00')).toEqual(['value_rises']);
  });

  it('re-runs approvals when the payment terms change, whichever way', () => {
    expect(at('90000.00', 45)).toEqual(['terms_change']);
    expect(at('80000.00', 15)).toEqual(['terms_change']);
    expect(at('95000.00', 45)).toEqual(['value_rises', 'terms_change']);
  });

  it('only audits a total that stays or falls with the same terms', () => {
    expect(at('90000.00')).toEqual([]);
    expect(at('1.00')).toEqual([]);
  });
});

describe('versionTotals', () => {
  it('is the grand total incl. VAT, its NPR value and its band (strict > 100,000.00)', () => {
    expect(versionTotals(['90000.00'], '1')).toEqual({
      total: '90000.00',
      totalNpr: '90000.00',
      band: 'base',
    });
    expect(versionTotals(['100000.00'], '1').band).toBe('base');
    expect(versionTotals(['100000.01'], '1').band).toBe('management');
    expect(versionTotals(['1000.00'], '133.456789')).toEqual({
      total: '1000.00',
      totalNpr: '133456.79',
      band: 'management',
    });
  });
});

describe('amendLines (done check 2 arithmetic)', () => {
  it('90,000 -> 99,000 stays in the base band', () => {
    const v = amendLines([line()], [{ poLineId: 'l1', unitPrice: '87610.62' }], rate);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.changed).toBe(true);
    expect(v.lines[0]).toMatchObject({
      gross: '87610.62',
      taxAmount: '11389.38',
      lineTotal: '99000.00',
    });
    const t = versionTotals(
      v.lines.map((l) => l.lineTotal),
      '1',
    );
    expect(t.band).toBe('base');
  });

  it('90,000 -> 1,50,000 lands in the management band', () => {
    const v = amendLines([line()], [{ poLineId: 'l1', unitPrice: '132743.36' }], rate);
    if (!v.ok) throw new Error(v.message);
    expect(v.lines[0]!.lineTotal).toBe('150000.00');
    expect(versionTotals([v.lines[0]!.lineTotal], '1').band).toBe('management');
  });

  it('keeps a line it does not name', () => {
    const v = amendLines(
      [line(), line({ id: 'l2', unitPrice: '100.00', orderedQuantity: '2.0000' })],
      [{ poLineId: 'l1', quantity: '2' }],
      rate,
    );
    if (!v.ok) throw new Error(v.message);
    expect(v.lines[1]).toMatchObject({ id: 'l2', orderedQuantity: '2.0000', lineTotal: '226.00' });
  });

  it('refuses a line of another PO and a line named twice, and marks a no-op unchanged', () => {
    expect(amendLines([line()], [{ poLineId: 'x', quantity: '2' }], rate).ok).toBe(false);
    expect(
      amendLines(
        [line()],
        [
          { poLineId: 'l1', quantity: '2' },
          { poLineId: 'l1', quantity: '3' },
        ],
        rate,
      ).ok,
    ).toBe(false);
    expect(amendLines([line()], [{ poLineId: 'l1', quantity: '1' }], rate)).toMatchObject({
      ok: true,
      changed: false,
    });
    expect(amendLines([line()], [], rate)).toMatchObject({ ok: true, changed: false });
  });

  it('refuses ordering below received plus cancelled', () => {
    const l = line({
      orderedQuantity: '10.0000',
      receivedQuantity: '4.0000',
      cancelledQuantity: '1',
    });
    expect(amendLines([l], [{ poLineId: 'l1', quantity: '4.9999' }], rate).ok).toBe(false);
    expect(amendLines([l], [{ poLineId: 'l1', quantity: '5' }], rate).ok).toBe(true);
  });
});

describe('shortCloseCancelled', () => {
  it('cancels what is still open on each line', () => {
    expect(
      shortCloseCancelled([
        { id: 'a', orderedQuantity: '5.0000', receivedQuantity: '2.0000' },
        { id: 'b', orderedQuantity: '3.0000', receivedQuantity: '3.0000' },
      ]),
    ).toEqual([
      { id: 'a', cancelledQuantity: '3.0000' },
      { id: 'b', cancelledQuantity: '0.0000' },
    ]);
  });
});

describe('AmendPurchaseOrderBodySchema', () => {
  it('takes a change of payment terms alone, with no line (F1-Q40)', () => {
    expect(
      AmendPurchaseOrderBodySchema.safeParse({
        reason: 'Vendor asked for 45 days',
        paymentTermsDays: 45,
        lines: [],
      }).success,
    ).toBe(true);
  });

  it('has no vendor field: a change of vendor is a cancel and a new PO', () => {
    const r = AmendPurchaseOrderBodySchema.safeParse({
      reason: 'Switch supplier',
      vendorId: '00000000-0000-4000-8000-000000000000',
      lines: [{ poLineId: '00000000-0000-4000-8000-000000000001', quantity: '2' }],
    });
    expect(r.success).toBe(false);
  });
});

describe('ListPurchaseOrdersQuerySchema', () => {
  it('takes a repeated status, a search and a page window, and pages 25 by default', () => {
    expect(ListPurchaseOrdersQuerySchema.parse({})).toEqual({ limit: 25, offset: 0 });
    expect(
      ListPurchaseOrdersQuerySchema.parse({
        status: ['draft', 'issued'],
        q: 'acme',
        limit: '100',
        offset: '200',
      }),
    ).toEqual({ status: ['draft', 'issued'], q: 'acme', limit: 100, offset: 200 });
  });

  it('refuses an unknown status, a limit over 100 and an unknown key', () => {
    expect(ListPurchaseOrdersQuerySchema.safeParse({ status: ['draft', 'nope'] }).success).toBe(
      false,
    );
    expect(ListPurchaseOrdersQuerySchema.safeParse({ limit: '101' }).success).toBe(false);
    expect(ListPurchaseOrdersQuerySchema.safeParse({ vendorId: 'x' }).success).toBe(false);
  });
});

describe('vendor change on a draft (F1-Q40 a)', () => {
  const A = '11111111-1111-4111-8111-111111111111';
  const B = '22222222-2222-4222-8222-222222222222';

  it('lets a draft change to another vendor', () => {
    expect(vendorChangeRefusal({ status: 'draft', vendorId: A, nextVendorId: B })).toBeNull();
  });

  it.each([
    'issued',
    'partially_received',
    'fully_received',
    'amendment_pending',
    'cancelled',
  ] as const)('refuses a %s order with the cancel-and-recreate message', (status) => {
    expect(vendorChangeRefusal({ status, vendorId: A, nextVendorId: B })).toEqual({
      code: 'PO_VENDOR_CHANGE_NOT_DRAFT',
      message: 'Cancel this order and create a new one',
    });
  });

  it('refuses the same vendor, and the status refusal wins on a non-draft', () => {
    expect(vendorChangeRefusal({ status: 'draft', vendorId: A, nextVendorId: A })).toMatchObject({
      code: 'PO_VENDOR_UNCHANGED',
    });
    expect(vendorChangeRefusal({ status: 'issued', vendorId: A, nextVendorId: A })).toBe(
      PO_VENDOR_CHANGE_NOT_DRAFT,
    );
  });

  it('takes a vendor id and an optional VAT acknowledgement only', () => {
    expect(ChangePurchaseOrderVendorBodySchema.safeParse({ vendorId: A }).success).toBe(true);
    expect(ChangePurchaseOrderVendorBodySchema.safeParse({ vendorId: 'x' }).success).toBe(false);
    expect(ChangePurchaseOrderVendorBodySchema.safeParse({}).success).toBe(false);
    expect(
      ChangePurchaseOrderVendorBodySchema.safeParse({ vendorId: A, acknowledgeVatWarning: true })
        .success,
    ).toBe(true);
    expect(
      ChangePurchaseOrderVendorBodySchema.safeParse({ vendorId: A, acknowledgeVatWarning: 'yes' })
        .success,
    ).toBe(false);
    expect(
      ChangePurchaseOrderVendorBodySchema.safeParse({ vendorId: A, paymentTermsDays: 5 }).success,
    ).toBe(false);
  });
});
