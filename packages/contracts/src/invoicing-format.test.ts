// The invoice detail and the customer invoice view carry the original print's number and date format; the customer
// view also carries the exempt and zero-rated totals and a four-key seller contact. Older answers without them parse.
import { describe, expect, it } from 'vitest';

import { CustomerInvoiceViewSchema, InvoiceDetailSchema } from './invoicing.js';

const FORMAT = {
  numberSystems: { NPR: 'international', INR: 'south_asian', USD: 'international' },
  dateFormat: 'yyyy-MM-dd',
  capturedAt: '2026-11-01T06:15:00.000Z',
};

const party = { legalName: 'Techrida Pvt. Ltd.', panVatNo: '301234567', address: 'Kathmandu' };

const olderView = {
  id: '0c0c0c0c-0c0c-4c0c-8c0c-0c0c0c0c0c0c',
  kind: 'tax_invoice',
  number: 'INV-2083/84-00001',
  issueDate: '2026-11-01',
  issueDateBs: '2083-07-15',
  dueDate: null,
  currency: 'NPR',
  seller: party,
  buyer: { ...party, legalName: 'Buyer Ltd.' },
  lines: [],
  totals: {
    subtotal: '0.00',
    discountAmount: '0.00',
    taxableAmount: '0.00',
    taxAmount: '0.00',
    total: '0.00',
  },
  taxSummary: [],
  file: null,
};

const contact = {
  phones: ['+977 1 5550100'],
  email: null,
  signatoryName: 'Asha',
  signatoryTitle: null,
};

describe('CustomerInvoiceViewSchema (format, totals, seller contact)', () => {
  it('parses an older answer without the new keys', () => {
    expect(CustomerInvoiceViewSchema.safeParse(olderView).success).toBe(true);
  });

  it('parses the new keys, and a null format and contact', () => {
    const full = {
      ...olderView,
      totals: { ...olderView.totals, exemptAmount: '300.00', zeroRatedAmount: '200.00' },
      format: FORMAT,
      sellerContact: contact,
    };
    expect(CustomerInvoiceViewSchema.parse(full)).toMatchObject({
      format: FORMAT,
      sellerContact: contact,
    });
    expect(
      CustomerInvoiceViewSchema.safeParse({ ...olderView, format: null, sellerContact: null })
        .success,
    ).toBe(true);
  });

  it('refuses an extra key in the contact or a malformed format', () => {
    expect(
      CustomerInvoiceViewSchema.safeParse({
        ...olderView,
        sellerContact: { ...contact, website: 'https://x.example' },
      }).success,
    ).toBe(false);
    expect(
      CustomerInvoiceViewSchema.safeParse({
        ...olderView,
        format: { ...FORMAT, dateFormat: 'whenever' },
      }).success,
    ).toBe(false);
  });
});

describe('InvoiceDetailSchema format', () => {
  const invoice = {
    id: '0c0c0c0c-0c0c-4c0c-8c0c-0c0c0c0c0c0c',
    kind: 'proforma',
    status: 'draft',
    number: null,
    fiscalYear: null,
    customerId: '0d0d0d0d-0d0d-4d0d-8d0d-0d0d0d0d0d0d',
    salesOrderId: null,
    scheduleLineId: null,
    originalInvoiceId: null,
    manualReason: null,
    noteReason: null,
    currency: 'NPR',
    totals: { ...olderView.totals, exemptAmount: '0.00', zeroRatedAmount: '0.00' },
    npr: null,
    issueDate: null,
    issueDateBs: null,
    dueDate: null,
    seller: null,
    buyer: null,
    calcVersion: 1,
    contentHash: null,
    approvalRequestId: null,
    version: 1,
    createdAt: '2026-11-01T06:15:00.000Z',
    updatedAt: '2026-11-01T06:15:00.000Z',
  };
  const older = { invoice, lines: [], taxSummary: [], prints: [] };

  it('parses an older answer without format, and a null or stored one', () => {
    expect(InvoiceDetailSchema.safeParse(older).success).toBe(true);
    expect(InvoiceDetailSchema.safeParse({ ...older, format: null }).success).toBe(true);
    expect(InvoiceDetailSchema.parse({ ...older, format: FORMAT }).format).toEqual(FORMAT);
  });
});
