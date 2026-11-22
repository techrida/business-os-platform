import type { CustomerQuotationView, PortalQuotationListItem } from '@bos/contracts';
import { DEFAULT_NUMBER_SYSTEMS } from '@bos/locale';

/**
 * Test fixtures for the portal quotation screens. Every nullable field is filled, so a test that
 * scans the rendered markup sees every field the view can show. Not imported by any page.
 */

export function sampleListItem(
  over: Partial<PortalQuotationListItem> = {},
): PortalQuotationListItem {
  return {
    id: '0f8fad5b-d9cb-469f-a165-70867728950e',
    number: 'QT-2082-0042',
    revisionNo: 2,
    status: 'sent',
    issueDate: '2026-11-08',
    validUntil: '2026-11-23',
    currency: 'USD',
    total: '2690999.99',
    ...over,
  };
}

export function sampleView(over: Partial<CustomerQuotationView> = {}): CustomerQuotationView {
  return {
    id: '0f8fad5b-d9cb-469f-a165-70867728950e',
    number: 'QT-2082-0042',
    revisionNo: 2,
    status: 'sent',
    issueDate: '2026-11-08',
    validUntil: '2026-11-23',
    currency: 'USD',
    issuer: {
      legalName: 'Techrida Pvt. Ltd.',
      panVatNo: '601234567',
      country: 'NP',
      address: { line: 'Jhamsikhel Road, Ward 3', city: 'Lalitpur' },
    },
    customer: {
      legalName: 'Big Kahuna Burger Ltd.',
      panVatNo: '609876543',
      country: 'NP',
      address: { line: 'Durbar Marg', city: 'Kathmandu' },
    },
    contact: { fullName: 'Jules Winnfield', email: 'jules@example.com' },
    scope: 'Supply and install office network.\nTwo floors, forty seats.',
    assumptions: 'Site access between 9am and 6pm.',
    exclusions: 'Civil works and painting.',
    termsAndConditions: 'Goods remain ours until paid in full.',
    deliveryTimeline: 'Three weeks from the purchase order.',
    paymentTermName: 'Net 30',
    paymentSchedule: [
      { label: 'Advance', percent: '40', amount: '1356.00', dueDescription: 'On order' },
      { label: 'On completion', percent: '60', amount: '2034.00' },
    ],
    lines: [
      {
        lineNo: 1,
        description: 'Managed switch, 48 port',
        uom: 'pcs',
        quantity: '2',
        unitPrice: '1200.00',
        amount: '2400.00',
      },
      {
        lineNo: 2,
        description: 'Cabling and termination',
        uom: 'lot',
        quantity: '1',
        unitPrice: '800.00',
        amount: '800.00',
      },
    ],
    totals: {
      subtotal: '3200.00',
      discountAmount: '200.00',
      taxableAmount: '3000.00',
      taxAmount: '390.00',
      total: '3390.00',
    },
    taxSummary: [{ label: 'VAT', percent: '13', base: '3000.00', tax: '390.00' }],
    display: { numberSystems: DEFAULT_NUMBER_SYSTEMS, dateFormat: 'dd MMM yyyy' },
    file: {
      documentId: '6ba7b810-9dad-41d1-80b4-00c04fd430c8',
      filename: 'QT-2082-0042-rev2.pdf',
      sha256: 'a'.repeat(64),
    },
    ...over,
  };
}
