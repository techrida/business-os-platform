import { describe, expect, it } from 'vitest';

import {
  InvoiceNotRenderableError,
  InvoiceRenderViewSchema,
  invoicePdfFilename,
  toInvoiceRenderView,
  type InvoiceViewHead,
  type InvoiceViewInput,
} from './invoice-view';

const seller = { legalName: 'Techrida Pvt. Ltd.', panVatNo: '301234567', address: 'Durbar Marg 1' };
const buyer = { legalName: 'Himal Traders Pvt. Ltd.', panVatNo: 'ABC-12345', address: 'Thamel 4' };

// The golden case of P3 done check 1: 1,880,000.00 less 5% discount, VAT 13%.
const head: InvoiceViewHead = {
  kind: 'tax_invoice',
  status: 'issued',
  number: 'INV-2083/84-00001',
  issueDate: '2026-11-09',
  issueDateBs: '2083-07-24',
  dueDate: '2026-12-09',
  currency: 'NPR',
  subtotal: '1880000.00',
  discountAmount: '94000.00',
  taxableVatAmount: '1786000.00',
  exemptAmount: '0.00',
  zeroRatedAmount: '0.00',
  taxAmount: '232180.00',
  total: '2018180.00',
  sellerSnapshot: seller,
  buyerSnapshot: buyer,
};

const input = (over: Partial<InvoiceViewInput> = {}): InvoiceViewInput => ({
  invoice: head,
  lines: [
    {
      lineNo: 2,
      description: 'Commissioning',
      uom: 'job',
      quantity: '1.0000',
      unitPrice: '0.00',
      gross: '0.00',
    },
    {
      lineNo: 1,
      description: 'Solar panel',
      uom: 'pcs',
      quantity: '12.5000',
      unitPrice: '150400.00',
      gross: '1880000.00',
    },
  ],
  taxSummary: [{ label: 'VAT 13%', rate: '13.0000', base: '1786000.00', tax: '232180.00' }],
  printNo: 1,
  ...over,
});

describe('toInvoiceRenderView', () => {
  it('builds exactly the whitelisted fields, in order, from the frozen row', () => {
    const view = toInvoiceRenderView(input());
    expect(Object.keys(view)).toEqual([
      'kind',
      'number',
      'issueDate',
      'issueDateBs',
      'dueDate',
      'currency',
      'seller',
      'buyer',
      'copyNo',
      'lines',
      'totals',
      'taxSummary',
    ]);
    expect(view.seller).toEqual(seller);
    expect(view.buyer).toEqual(buyer);
    expect(view.issueDateBs).toBe('2083-07-24');
    expect(view.totals).toEqual({
      subtotal: '1880000.00',
      discountAmount: '94000.00',
      taxableAmount: '1786000.00',
      exemptAmount: '0.00',
      zeroRatedAmount: '0.00',
      taxAmount: '232180.00',
      total: '2018180.00',
    });
    // Lines are ordered by number; padded quantities and rates lose their zeros.
    expect(view.lines.map((l) => l.lineNo)).toEqual([1, 2]);
    expect(view.lines[0]).toEqual({
      lineNo: 1,
      description: 'Solar panel',
      uom: 'pcs',
      quantity: '12.5',
      unitPrice: '150400.00',
      amount: '1880000.00',
    });
    expect(view.taxSummary).toEqual([
      { label: 'VAT 13%', percent: '13', base: '1786000.00', tax: '232180.00' },
    ]);
  });

  it('carries no internal field, even when the caller passes whole rows', () => {
    const wholeRow = {
      ...head,
      id: '11111111-1111-4111-8111-111111111111',
      customerPartyId: '22222222-2222-4222-8222-222222222222',
      salesOrderId: '33333333-3333-4333-8333-333333333333',
      manualReason: 'internal: customer shouted',
      amountNpr: '2018180.00',
      fxRate: '1.000000',
      fxSource: 'NRB',
      contentHash: Buffer.alloc(32, 7),
      approvalRequestId: '44444444-4444-4444-8444-444444444444',
      createdBy: '55555555-5555-4555-8555-555555555555',
      issuedBy: '66666666-6666-4666-8666-666666666666',
      version: 9,
    } as InvoiceViewHead;
    const wholeSeller = { ...seller, internalNote: 'margin 40%' };
    const view = toInvoiceRenderView(
      input({ invoice: { ...wholeRow, sellerSnapshot: wholeSeller } }),
    );
    const json = JSON.stringify(view);
    for (const key of [
      'amountNpr',
      'fxRate',
      'fxSource',
      'contentHash',
      'approvalRequestId',
      'createdBy',
      'issuedBy',
      'customerPartyId',
      'salesOrderId',
      'manualReason',
      'version',
      'internalNote',
    ]) {
      expect(json).not.toContain(key);
    }
    expect(json).not.toContain('customer shouted');
    expect(json).not.toContain('margin 40%');
  });

  it('is a strict schema: an extra key fails to parse instead of leaking', () => {
    const view = toInvoiceRenderView(input());
    expect(InvoiceRenderViewSchema.safeParse({ ...view, amountNpr: '1.00' }).success).toBe(false);
    expect(
      InvoiceRenderViewSchema.safeParse({ ...view, seller: { ...view.seller, note: 'x' } }).success,
    ).toBe(false);
  });

  it('numbers copies from the print log: print 1 is the original, print 2 is "copy 1"', () => {
    expect(toInvoiceRenderView(input({ printNo: 1 })).copyNo).toBeNull();
    expect(toInvoiceRenderView(input({ printNo: 2 })).copyNo).toBe(1);
    expect(toInvoiceRenderView(input({ printNo: 4 })).copyNo).toBe(3);
  });

  it('draws a proforma as a proforma', () => {
    const view = toInvoiceRenderView(input({ invoice: { ...head, kind: 'proforma' } }));
    expect(view.kind).toBe('proforma');
  });

  it.each([
    ['a draft', { ...head, status: 'draft' as const, number: null }],
    ['a discarded invoice', { ...head, status: 'discarded' as const, number: null }],
    ['a credit note', { ...head, kind: 'credit_note' as const }],
    ['a debit note', { ...head, kind: 'debit_note' as const }],
  ])('refuses %s', (_name, invoice) => {
    expect(() => toInvoiceRenderView(input({ invoice }))).toThrow(InvoiceNotRenderableError);
  });

  it('refuses a malformed party snapshot and a bad print number', () => {
    expect(() =>
      toInvoiceRenderView(input({ invoice: { ...head, buyerSnapshot: { legalName: '' } } })),
    ).toThrow(InvoiceNotRenderableError);
    expect(() => toInvoiceRenderView(input({ printNo: 0 }))).toThrow(InvoiceNotRenderableError);
  });
});

describe('invoicePdfFilename', () => {
  it('turns the fiscal-year slash into a dash and marks copies', () => {
    expect(invoicePdfFilename('INV-2083/84-00001', null)).toBe('INV-2083-84-00001.pdf');
    expect(invoicePdfFilename('PI-2083/84-00007', 2)).toBe('PI-2083-84-00007-copy2.pdf');
    expect(invoicePdfFilename('INV-2083/84-00001', null)).not.toContain('/');
  });
});
