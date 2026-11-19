import type {
  CustomerInvoiceView,
  DocumentFormatSnapshot,
  PortalInvoiceListItem,
} from '@bos/contracts';

import type { PortalSettlement } from '@/lib/api.billing';

/** Test fixtures for the portal invoice screens. Every nullable field is filled. Not imported by any page. */

/** The format the first print was drawn with: the defaults (lakh grouping, `8 Dec 2026` dates). */
export function sampleFormat(over: Partial<DocumentFormatSnapshot> = {}): DocumentFormatSnapshot {
  return {
    numberSystems: { NPR: 'south_asian', INR: 'south_asian', USD: 'international' },
    dateFormat: 'dd MMM yyyy',
    capturedAt: '2026-11-08T06:15:00.000Z',
    ...over,
  };
}

export const INVOICE_ID = '1f8fad5b-d9cb-469f-a165-70867728950e';

export function sampleInvoice(over: Partial<CustomerInvoiceView> = {}): CustomerInvoiceView {
  return {
    id: INVOICE_ID,
    kind: 'tax_invoice',
    number: 'INV-2083/84-00001',
    issueDate: '2026-11-08',
    issueDateBs: '2083-07-22',
    dueDate: '2026-12-08',
    currency: 'NPR',
    seller: {
      legalName: 'Techrida Pvt. Ltd.',
      panVatNo: '601234567',
      address: 'Jhamsikhel Road, Lalitpur',
    },
    buyer: {
      legalName: 'Big Kahuna Burger Ltd.',
      panVatNo: '609876543',
      address: 'Durbar Marg, Kathmandu',
    },
    lines: [
      {
        lineNo: 1,
        description: 'Managed switch, 48 port',
        uom: 'pcs',
        quantity: '4.0000',
        unitPrice: '470000.00',
        amount: '1880000.00',
      },
    ],
    totals: {
      subtotal: '1880000.00',
      discountAmount: '94000.00',
      taxableAmount: '1786000.00',
      exemptAmount: '0.00',
      zeroRatedAmount: '0.00',
      taxAmount: '232180.00',
      total: '2018180.00',
    },
    taxSummary: [{ label: 'VAT', percent: '13', base: '1786000.00', tax: '232180.00' }],
    file: {
      documentId: '2f8fad5b-d9cb-469f-a165-70867728950e',
      filename: 'INV-2083-84-00001.pdf',
      sha256: 'a'.repeat(64),
    },
    format: sampleFormat(),
    sellerContact: {
      phones: ['+977 1 5551234', '+977 9801234567'],
      email: 'accounts@techrida.example',
      signatoryName: 'Amanda Vance',
      signatoryTitle: 'Finance Manager',
    },
    ...over,
  };
}

export function sampleSettlement(over: Partial<PortalSettlement> = {}): PortalSettlement {
  return {
    invoiceId: INVOICE_ID,
    currency: 'NPR',
    total: '2018180.00',
    openAmount: '2018180.00',
    dueDate: '2026-12-08',
    daysOverdue: 0,
    settlement: 'unpaid',
    ...over,
  };
}

export function sampleListItem(over: Partial<PortalInvoiceListItem> = {}): PortalInvoiceListItem {
  return {
    id: INVOICE_ID,
    kind: 'tax_invoice',
    number: 'INV-2083/84-00001',
    issueDate: '2026-11-08',
    dueDate: '2026-12-08',
    currency: 'NPR',
    total: '2018180.00',
    openAmount: '2018180.00',
    ...over,
  };
}
