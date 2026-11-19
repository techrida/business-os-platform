import { describe, expect, it } from 'vitest';

import { renderPurchaseOrderHtml } from './purchase-order-html';

import {
  PurchaseOrderNotRenderableError,
  PurchaseOrderRenderViewSchema,
  purchaseOrderPdfFilename,
  toPurchaseOrderRenderView,
  type PurchaseOrderViewInput,
} from './purchase-order-view';

const VAT = '6f1a0c7e-0000-4000-8000-000000000001';
const EXEMPT = '6f1a0c7e-0000-4000-8000-000000000002';

// The snapshot carries more than the PDF may show: an FX rate, an internal note, the request and line links.
const snapshot = (over: { currency?: string; lines?: unknown[] } = {}) => ({
  purchaseOrder: {
    id: 'po-1',
    number: 'PO-2083/84-00007',
    purchaseRequestId: 'pr-1',
    vendorId: 'vendor-1',
    currency: over.currency ?? 'NPR',
    paymentTermsDays: 30,
    advancePercent: '25.00',
    fxRate: '133.500000',
    fxSource: 'NRB',
    fxDate: '2026-11-08',
    internalNote: 'comparison score 87 - vendor B was cheaper',
  },
  lines: over.lines ?? [
    {
      id: 'l2',
      lineNo: 2,
      prLineId: 'prl-2',
      kind: 'service',
      description: 'Installation',
      uom: 'job',
      orderedQuantity: '1.0000',
      cancelledQuantity: '0.0000',
      unitPrice: '100000.00',
      taxCodeId: EXEMPT,
      gross: '100000.00',
      taxAmount: '0.00',
      lineTotal: '100000.00',
      internalNote: 'negotiated down',
    },
    {
      id: 'l1',
      lineNo: 1,
      prLineId: 'prl-1',
      kind: 'goods',
      description: 'Solar panel',
      uom: 'pcs',
      orderedQuantity: '12.5000',
      cancelledQuantity: '0.0000',
      unitPrice: '150400.00',
      taxCodeId: VAT,
      gross: '1880000.00',
      taxAmount: '244400.00',
      lineTotal: '2124400.00',
    },
  ],
});

const input = (over: Partial<PurchaseOrderViewInput> = {}): PurchaseOrderViewInput => ({
  version: {
    version: 1,
    // 00:15 on 9 Nov in Kathmandu; a UTC slice would say the 8th.
    createdAt: new Date('2026-11-08T18:30:00Z'),
    total: '2224400.00',
    snapshot: snapshot(),
  },
  buyer: { legalName: 'Techrida Pvt. Ltd.', panVatNo: '301234567' },
  vendor: { legalName: 'Himal Solar Pvt. Ltd.', pan: '600123456' },
  delivery: { requiredBy: '2026-12-01', deliveryLocation: 'Teku warehouse' },
  taxCodes: new Map([
    [VAT, 'VAT13'],
    [EXEMPT, 'EXEMPT'],
  ]),
  ...over,
});

describe('toPurchaseOrderRenderView', () => {
  it('builds exactly the allow-listed fields, in order, from the version snapshot', () => {
    const view = toPurchaseOrderRenderView(input());
    expect(Object.keys(view)).toEqual([
      'number',
      'version',
      'issueDate',
      'issueDateBs',
      'currency',
      'buyer',
      'vendor',
      'paymentTermsDays',
      'advancePercent',
      'requiredBy',
      'deliveryLocation',
      'lines',
      'totals',
      'taxSummary',
    ]);
    expect(view.number).toBe('PO-2083/84-00007');
    expect(view.version).toBe(1);
    expect(view.buyer).toEqual({ legalName: 'Techrida Pvt. Ltd.', panVatNo: '301234567' });
    expect(view.vendor).toEqual({ legalName: 'Himal Solar Pvt. Ltd.', panVatNo: '600123456' });
    expect(view.paymentTermsDays).toBe(30);
    expect(view.advancePercent).toBe('25');
    expect(view.totals).toEqual({
      subtotal: '1980000.00',
      taxAmount: '244400.00',
      total: '2224400.00',
    });
    expect(view.taxSummary).toEqual([
      { code: 'EXEMPT', base: '100000.00', tax: '0.00' },
      { code: 'VAT13', base: '1880000.00', tax: '244400.00' },
    ]);
    expect(PurchaseOrderRenderViewSchema.safeParse(view).success).toBe(true);
  });

  it('sorts lines by number, trims padded quantities and names the tax code', () => {
    const { lines } = toPurchaseOrderRenderView(input());
    expect(lines.map((l) => l.lineNo)).toEqual([1, 2]);
    expect(lines[0]).toEqual({
      lineNo: 1,
      description: 'Solar panel',
      uom: 'pcs',
      quantity: '12.5',
      unitPrice: '150400.00',
      taxCode: 'VAT13',
      amount: '1880000.00',
      taxAmount: '244400.00',
    });
    expect(lines[1]?.quantity).toBe('1');
  });

  it('leaves out every internal field: scores, notes, FX, links and the NPR value', () => {
    const view = toPurchaseOrderRenderView(
      input({ version: { ...input().version, snapshot: snapshot({ currency: 'USD' }) } }),
    );
    const text = JSON.stringify(view);
    for (const hidden of [
      'internalNote',
      'comparison score',
      'negotiated',
      '133.5',
      'NRB',
      'fxRate',
      'totalNpr',
      'band',
      'approvalRequestId',
      'prLineId',
      'purchaseRequestId',
      'vendorQuotationId',
      'createdBy',
      'reason',
      'pr-1',
      'prl-1',
    ]) {
      expect(text).not.toContain(hidden);
    }
    expect(view.currency).toBe('USD');
  });

  it('is strict: a key that is not named in the schema is refused', () => {
    const view = toPurchaseOrderRenderView(input());
    expect(PurchaseOrderRenderViewSchema.safeParse({ ...view, internalNote: 'x' }).success).toBe(
      false,
    );
    expect(
      PurchaseOrderRenderViewSchema.safeParse({
        ...view,
        vendor: { ...view.vendor, bankAccount: '123' },
      }).success,
    ).toBe(false);
  });

  it('takes the issue date from the Kathmandu day of the version, with its BS date', () => {
    const view = toPurchaseOrderRenderView(input());
    expect(view.issueDate).toBe('2026-11-09');
    expect(view.issueDateBs).toBe('2083-07-23');
  });

  it('carries a four-place advance through the frozen version to the printed order', () => {
    const snap = snapshot();
    snap.purchaseOrder.advancePercent = '33.3334';
    const view = toPurchaseOrderRenderView(
      input({ version: { ...input().version, snapshot: snap } }),
    );
    const html = renderPurchaseOrderHtml(view);
    expect(html).toContain('33.3334%');
    expect(html).toContain('09 Nov 2026');
    expect(html).toContain('01 Dec 2026');
  });

  it('prints no advance when it is zero and keeps a missing delivery as null', () => {
    const snap = snapshot();
    snap.purchaseOrder.advancePercent = '0.00';
    const view = toPurchaseOrderRenderView(
      input({
        version: { ...input().version, snapshot: snap },
        delivery: { requiredBy: null, deliveryLocation: null },
        vendor: { legalName: 'Foreign Supplier Ltd.', pan: null },
      }),
    );
    expect(view.advancePercent).toBeNull();
    expect(view.requiredBy).toBeNull();
    expect(view.deliveryLocation).toBeNull();
    expect(view.vendor.panVatNo).toBeNull();
  });

  it('refuses a version whose lines and total disagree', () => {
    expect(() =>
      toPurchaseOrderRenderView(input({ version: { ...input().version, total: '1.00' } })),
    ).toThrow(PurchaseOrderNotRenderableError);
  });

  it('refuses a malformed snapshot and an unknown tax code', () => {
    expect(() =>
      toPurchaseOrderRenderView(input({ version: { ...input().version, snapshot: {} } })),
    ).toThrow(PurchaseOrderNotRenderableError);
    expect(() => toPurchaseOrderRenderView(input({ taxCodes: new Map() }))).toThrow(
      PurchaseOrderNotRenderableError,
    );
  });
});

describe('purchaseOrderPdfFilename', () => {
  it('replaces the slash of the fiscal year and carries the version', () => {
    expect(purchaseOrderPdfFilename('PO-2083/84-00007', 1)).toBe('PO-2083-84-00007-v1.pdf');
    expect(purchaseOrderPdfFilename('PO-2083/84-00007', 3)).toBe('PO-2083-84-00007-v3.pdf');
  });
});
