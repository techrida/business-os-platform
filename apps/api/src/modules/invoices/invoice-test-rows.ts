// Test-only rows of an issued tax invoice, shaped like what Drizzle returns for `invoices`, `invoice_lines`,
// `invoice_tax_summary` and `invoice_print_log`, for the mapper unit tests (no database).
import type { DocumentFormatSnapshot } from '@bos/contracts';

import type {
  InvoiceLineRow,
  InvoicePrintRow,
  InvoiceRow,
  InvoiceTaxSummaryRow,
} from './invoice-mapping';

export const TENANT = '0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a';
export const ENTITY = '0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b';
export const INVOICE = '0c0c0c0c-0c0c-4c0c-8c0c-0c0c0c0c0c0c';
export const CUSTOMER = '0d0d0d0d-0d0d-4d0d-8d0d-0d0d0d0d0d0d';
export const ORDER = '0e0e0e0e-0e0e-4e0e-8e0e-0e0e0e0e0e0e';
export const TAX_CODE = '0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f';
export const USER = '10101010-1010-4010-8010-101010101010';

const AT = new Date('2026-11-01T06:15:00.000Z');

export function issuedInvoiceRow(over: Partial<InvoiceRow> = {}): InvoiceRow {
  return {
    id: INVOICE,
    tenantId: TENANT,
    organizationId: ENTITY,
    kind: 'tax_invoice',
    status: 'issued',
    customerPartyId: CUSTOMER,
    customerPartyKind: 'customer',
    salesOrderId: ORDER,
    scheduleLineId: null,
    originalInvoiceId: null,
    manualReason: null,
    noteReason: null,
    number: 'INV-2083/84-00001',
    seq: 1,
    fiscalYear: '2083/84',
    issueDate: '2026-11-01',
    issueDateBs: '2083-07-15',
    dueDate: '2026-11-15',
    currency: 'NPR',
    subtotal: '1500.00',
    discountAmount: '0.00',
    taxableVatAmount: '1000.00',
    exemptAmount: '300.00',
    zeroRatedAmount: '200.00',
    taxAmount: '130.00',
    total: '1630.00',
    fxRate: '1.000000',
    fxSource: 'NPR',
    fxDate: '2026-11-01',
    amountNpr: '1630.00',
    sellerSnapshot: {
      legalName: 'Techrida Pvt. Ltd.',
      panVatNo: '301234567',
      address: 'Kathmandu',
    },
    buyerSnapshot: { legalName: 'Buyer Ltd.', panVatNo: null, address: 'Lalitpur' },
    calcVersion: 1,
    contentHash: Buffer.alloc(32, 0xab),
    approvalRequestId: null,
    issuedAt: AT,
    issuedBy: USER,
    discardedAt: null,
    creditedInFullAt: null,
    createdBy: USER,
    version: 3,
    createdAt: AT,
    updatedAt: AT,
    ...over,
  };
}

export function lineRow(over: Partial<InvoiceLineRow> = {}): InvoiceLineRow {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    tenantId: TENANT,
    organizationId: ENTITY,
    invoiceId: INVOICE,
    lineNo: 1,
    description: 'Solar panel',
    uom: 'pcs',
    quantity: '2.0000',
    unitPrice: '500.00',
    taxCodeId: TAX_CODE,
    gross: '1000.00',
    discountAlloc: '0.00',
    taxable: '1000.00',
    originalLineId: null,
    createdAt: AT,
    updatedAt: AT,
    ...over,
  };
}

export function taxRow(over: Partial<InvoiceTaxSummaryRow> = {}): InvoiceTaxSummaryRow {
  return {
    id: '12121212-1212-4212-8212-121212121212',
    tenantId: TENANT,
    organizationId: ENTITY,
    invoiceId: INVOICE,
    taxCodeId: TAX_CODE,
    label: 'VAT',
    rate: '13.0000',
    base: '1000.00',
    tax: '130.00',
    createdAt: AT,
    ...over,
  };
}

/** The format the render sweeper's `formatFor` stores on print 1. */
export const STORED_FORMAT: DocumentFormatSnapshot = {
  numberSystems: { NPR: 'international', INR: 'south_asian', USD: 'international' },
  dateFormat: 'yyyy-MM-dd',
  capturedAt: '2026-11-01T06:15:00.000Z',
};

export function printRow(over: Partial<InvoicePrintRow> = {}): InvoicePrintRow {
  return {
    id: '13131313-1313-4313-8313-131313131313',
    tenantId: TENANT,
    organizationId: ENTITY,
    invoiceId: INVOICE,
    printNo: 1,
    printedBy: null,
    printedAt: AT,
    renderFormat: STORED_FORMAT,
    ...over,
  };
}
