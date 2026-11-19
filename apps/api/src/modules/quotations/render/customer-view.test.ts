import {
  CreateDocumentBodySchema,
  CUSTOMER_VIEW_FORBIDDEN_WORDS,
  CustomerQuotationViewSchema,
} from '@bos/contracts';
import { describe, expect, it } from 'vitest';

import {
  QuotationNotCustomerVisibleError,
  quotationPdfFilename,
  toCustomerQuotationView,
  type CustomerViewInput,
} from './customer-view.js';

const address = { line1: '1 Durbar Marg', city: 'Kathmandu', country: 'NP' };
const versionId = '11111111-1111-4111-8111-111111111111';
const documentId = '22222222-2222-4222-8222-222222222222';

/** A full internal row: every secret column is set, so a leak shows up in the output. */
const input = (over: Partial<CustomerViewInput> = {}): CustomerViewInput => ({
  version: {
    id: versionId,
    revisionNo: 2,
    status: 'sent',
    rejectionSource: null,
    currency: 'USD',
    issueDate: '2026-11-08',
    validUntil: '2026-11-23',
    scope: 'Supply and install 12 panels',
    assumptions: null,
    exclusions: 'Civil works',
    termsAndConditions: null,
    deliveryTimeline: '6 weeks',
    paymentSchedule: [{ label: 'Advance', percent: '60', dueDescription: 'On order' }],
    subtotal: '540000.00',
    discountAmount: '0.00',
    taxableAmount: '540000.00',
    taxAmount: '70200.00',
    total: '610200.00',
    renderState: 'none',
    renderedDocumentId: null,
    renderedSha256: null,
    // Internal columns a whole-row caller would pass along.
    fxRate: '133.500000',
    fxSource: 'NRB',
    amountNpr: '81463700.00',
    nprTaxableAmount: '72090000.00',
    internalCostTotal: '400000.00',
    marginPct: '25.9259',
    approvalRequestId: '33333333-3333-4333-8333-333333333333',
    contentSha256: Buffer.alloc(32, 1),
  } as CustomerViewInput['version'],
  quotation: { number: 'QT-2082-0042' },
  customer: { legalName: 'Himal Traders Pvt. Ltd.', panVatNo: 'ABC-12345', address },
  contact: { fullName: 'Sita Rai', emailNorm: 'sita@himal.example' },
  paymentTerm: { name: 'Net 30' },
  lines: [
    {
      lineNo: 2,
      description: 'Inverter 10kW',
      uom: 'pcs',
      quantity: '1.0000',
      unitPrice: '1000.00',
      gross: '1000.00',
      unitCost: '700.00',
    } as CustomerViewInput['lines'][number],
    {
      lineNo: 1,
      description: 'Solar panel 550W',
      uom: 'pcs',
      quantity: '12.0000',
      unitPrice: '45000.00',
      gross: '540000.00',
      unitCost: '30000.00',
    } as CustomerViewInput['lines'][number],
  ],
  taxSummary: [{ label: 'VAT', rate: '13.0000', base: '540000.00', tax: '70200.00' }],
  issuer: { legalName: 'Techrida Pvt. Ltd.', panVatNo: '301234567', address },
  ...over,
});

describe('toCustomerQuotationView', () => {
  it('builds a view the strict customer schema accepts', () => {
    const view = toCustomerQuotationView(input());
    expect(CustomerQuotationViewSchema.safeParse(view).success).toBe(true);
    expect(view.id).toBe(versionId);
    expect(view.number).toBe('QT-2082-0042');
    expect(view.revisionNo).toBe(2);
    expect(view.issuer.legalName).toBe('Techrida Pvt. Ltd.');
    expect(view.customer).toEqual({
      legalName: 'Himal Traders Pvt. Ltd.',
      panVatNo: 'ABC-12345',
      address,
    });
    expect(view.contact).toEqual({ fullName: 'Sita Rai', email: 'sita@himal.example' });
    expect(view.termsAndConditions).toBeNull();
    expect(view.paymentTermName).toBe('Net 30');
    expect(view.paymentSchedule).toEqual([
      { label: 'Advance', percent: '60', dueDescription: 'On order' },
    ]);
    expect(view.totals).toEqual({
      subtotal: '540000.00',
      discountAmount: '0.00',
      taxableAmount: '540000.00',
      taxAmount: '70200.00',
      total: '610200.00',
    });
  });

  it('passes the terms and conditions through unchanged', () => {
    const base = input();
    const view = toCustomerQuotationView({
      ...base,
      version: { ...base.version, termsAndConditions: 'Payment within 15 days.' },
    });
    expect(view.termsAndConditions).toBe('Payment within 15 days.');
    expect(CustomerQuotationViewSchema.safeParse(view).success).toBe(true);
  });

  it('leaks no internal column: cost, margin, FX, NPR equivalent, approval, hashes', () => {
    const json = JSON.stringify(toCustomerQuotationView(input()));
    for (const secret of [
      'unitCost',
      'internalCostTotal',
      'marginPct',
      'fxRate',
      'fxSource',
      'amountNpr',
      'nprTaxableAmount',
      'approvalRequestId',
      'contentSha256',
      '133.5',
      '25.9259',
      '700.00',
      '30000.00',
      '81463700.00',
    ]) {
      expect(json, secret).not.toContain(secret);
    }
    const keys = [...json.matchAll(/"([A-Za-z]+)":/g)].map((m) => m[1]!.toLowerCase());
    for (const word of CUSTOMER_VIEW_FORBIDDEN_WORDS) {
      expect(
        keys.filter((k) => k.includes(word)),
        word,
      ).toEqual([]);
    }
  });

  it('orders lines by line number and trims the padding of quantities and tax percent', () => {
    const view = toCustomerQuotationView(input());
    expect(view.lines.map((l) => l.lineNo)).toEqual([1, 2]);
    expect(view.lines[0]).toEqual({
      lineNo: 1,
      description: 'Solar panel 550W',
      uom: 'pcs',
      quantity: '12',
      unitPrice: '45000.00',
      amount: '540000.00',
    });
    expect(view.lines[1]?.quantity).toBe('1');
    expect(view.taxSummary).toEqual([
      { label: 'VAT', percent: '13', base: '540000.00', tax: '70200.00' },
    ]);
    const frac = toCustomerQuotationView(
      input({ taxSummary: [{ label: 'Levy', rate: '2.5000', base: '1.00', tax: '0.03' }] }),
    );
    expect(frac.taxSummary[0]?.percent).toBe('2.5');
  });

  it('shows the customer only the states they may see', () => {
    for (const status of ['draft', 'submitted', 'returned', 'approved', 'cancelled'] as const) {
      const base = input();
      expect(
        () => toCustomerQuotationView({ ...base, version: { ...base.version, status } }),
        status,
      ).toThrow(QuotationNotCustomerVisibleError);
    }
    for (const status of ['sent', 'accepted', 'expired', 'superseded'] as const) {
      const base = input();
      expect(
        toCustomerQuotationView({ ...base, version: { ...base.version, status } }).status,
        status,
      ).toBe(status);
    }
  });

  it('refuses an approved version for the portal, also when the purpose is named', () => {
    const base = input();
    const approved = { ...base, version: { ...base.version, status: 'approved' as const } };
    expect(() => toCustomerQuotationView(approved)).toThrow(QuotationNotCustomerVisibleError);
    expect(() => toCustomerQuotationView(approved, {})).toThrow(QuotationNotCustomerVisibleError);
    expect(() => toCustomerQuotationView(approved, { purpose: 'portal' })).toThrow(
      QuotationNotCustomerVisibleError,
    );
  });

  it('draws an approved version as the document that will be sent, for the render purpose only', () => {
    const base = input();
    const approved = { ...base, version: { ...base.version, status: 'approved' as const } };
    const view = toCustomerQuotationView(approved, { purpose: 'render' });
    // `approved` is not a customer-visible status; the PDF shows what the customer will receive.
    expect(view.status).toBe('sent');
    expect(view.number).toBe('QT-2082-0042');
    // The same content as the sent version: nothing in the view depends on the approved state.
    expect(view).toEqual(toCustomerQuotationView(base, { purpose: 'render' }));
    expect(view).toEqual(toCustomerQuotationView(base));
  });

  it('keeps every other hidden state hidden for the render purpose', () => {
    for (const status of ['draft', 'submitted', 'returned', 'cancelled'] as const) {
      const base = input();
      expect(
        () =>
          toCustomerQuotationView(
            { ...base, version: { ...base.version, status } },
            { purpose: 'render' },
          ),
        status,
      ).toThrow(QuotationNotCustomerVisibleError);
    }
    const base = input();
    expect(() =>
      toCustomerQuotationView(
        {
          ...base,
          version: { ...base.version, status: 'rejected', rejectionSource: 'internal' },
        },
        { purpose: 'render' },
      ),
    ).toThrow(QuotationNotCustomerVisibleError);
    // The states a customer may see keep their own status under the render purpose.
    expect(
      toCustomerQuotationView(
        { ...base, version: { ...base.version, status: 'accepted' } },
        { purpose: 'render' },
      ).status,
    ).toBe('accepted');
  });

  it('hides an internal rejection and shows only a customer rejection', () => {
    const base = input();
    const rejected = (rejectionSource: 'internal' | 'customer' | null) => ({
      ...base,
      version: { ...base.version, status: 'rejected' as const, rejectionSource },
    });
    expect(() => toCustomerQuotationView(rejected('internal'))).toThrow(
      QuotationNotCustomerVisibleError,
    );
    expect(() => toCustomerQuotationView(rejected(null))).toThrow(QuotationNotCustomerVisibleError);
    expect(toCustomerQuotationView(rejected('customer')).status).toBe('rejected');
  });

  it('carries the file only when it is rendered and scanned clean (deny by default)', () => {
    const base = input();
    const sha = Buffer.alloc(32, 0xab);
    const rendered = {
      ...base.version,
      renderState: 'rendered' as const,
      renderedDocumentId: documentId,
      renderedSha256: sha,
    };
    expect(toCustomerQuotationView({ ...base, version: rendered }).file).toBeNull();
    expect(
      toCustomerQuotationView({ ...base, version: rendered, renderedScanClean: false }).file,
    ).toBeNull();
    expect(
      toCustomerQuotationView({
        ...base,
        version: { ...rendered, renderState: 'pending' },
        renderedScanClean: true,
      }).file,
    ).toBeNull();
    expect(
      toCustomerQuotationView({ ...base, version: rendered, renderedScanClean: true }).file,
    ).toEqual({ documentId, filename: 'QT-2082-0042-R2.pdf', sha256: 'ab'.repeat(32) });
  });

  it('names the PDF of a real fiscal-year number (QT-2083/84-00001) in a form the documents module accepts', () => {
    const name = quotationPdfFilename('QT-2083/84-00001', 1);
    expect(name).toBe('QT-2083-84-00001-R1.pdf');
    expect(CreateDocumentBodySchema.shape.filename.safeParse(name).success).toBe(true);
    expect(quotationPdfFilename('QT-2082-0042', 2)).toBe('QT-2082-0042-R2.pdf');
  });

  it('allows a missing contact, payment term and PAN', () => {
    const view = toCustomerQuotationView(
      input({
        contact: null,
        paymentTerm: null,
        customer: { legalName: 'Walk-in', panVatNo: null, address },
      }),
    );
    expect(view.contact).toBeNull();
    expect(view.paymentTermName).toBeNull();
    expect(view.customer.panVatNo).toBeNull();
  });

  it('refuses malformed row data instead of passing it on', () => {
    const base = input();
    expect(() =>
      toCustomerQuotationView({ ...base, customer: { ...base.customer, address: { bad: 1 } } }),
    ).toThrow();
    expect(() =>
      toCustomerQuotationView({
        ...base,
        version: { ...base.version, paymentSchedule: [{ label: 'x' }] },
      }),
    ).toThrow();
    expect(() =>
      toCustomerQuotationView({ ...base, version: { ...base.version, total: 'NaN' } }),
    ).toThrow();
  });
});
