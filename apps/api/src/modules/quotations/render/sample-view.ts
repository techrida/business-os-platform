// A made-up quotation for the Settings thumbnails. It goes through the same renderer as a real PDF, so a
// preview cannot draw something the document cannot. Every name and figure here is invented.
import { defaultPortalDisplay, type CustomerQuotationView } from '@bos/contracts';

const LINES: readonly [string, string, string, string, string][] = [
  ['Inventory and dispatch modules', 'lot', '1', '480000.00', '480000.00'],
  ['Data migration and onboarding', 'lot', '1', '120000.00', '120000.00'],
  ['Barcode scanners, ruggedised', 'pcs', '6', '18500.00', '111000.00'],
  ['On-site training (3 days)', 'day', '3', '25000.00', '75000.00'],
  ['Support and hosting (12 months)', 'mo', '12', '15000.00', '180000.00'],
];

export function sampleQuotationView(): CustomerQuotationView {
  const subtotal = '966000.00';
  const discount = '48300.00';
  const taxable = '917700.00';
  const vat = '119301.00';
  return {
    id: '00000000-0000-4000-8000-000000000001',
    number: 'QT-2083/84-00001',
    revisionNo: 1,
    status: 'sent',
    issueDate: '2026-11-19',
    validUntil: '2026-12-04',
    currency: 'NPR',
    issuer: {
      legalName: 'Your Company Pvt. Ltd.',
      panVatNo: '123456789',
      country: 'NP',
      address: { line: 'Ward 3, Main Road', city: 'Kathmandu' },
    },
    customer: {
      legalName: 'Sample Customer Pvt. Ltd.',
      panVatNo: '987654321',
      country: 'NP',
      address: { line: 'Industrial Area', city: 'Lalitpur' },
    },
    contact: { fullName: 'Sunita Shrestha', email: 'sunita@example.com' },
    scope: 'Deliver and configure the platform and train your team.',
    assumptions: 'You provide timely access to your sites and data.',
    exclusions: 'Third-party licence fees.',
    termsAndConditions:
      'Prices are valid until the date shown. Payment is due within 15 days of invoice.',
    deliveryTimeline: 'Eight weeks from the advance payment.',
    paymentTermName: '50% advance, balance on go-live',
    paymentSchedule: [
      { label: 'Advance', percent: '50', amount: '518500.50', dueDescription: 'On order' },
      { label: 'Go-live', percent: '50', amount: '518500.50', dueDescription: 'On sign-off' },
    ],
    lines: LINES.map(([description, uom, quantity, unitPrice, amount], i) => ({
      lineNo: i + 1,
      description,
      uom,
      quantity,
      unitPrice,
      amount,
    })),
    totals: {
      subtotal,
      discountAmount: discount,
      taxableAmount: taxable,
      taxAmount: vat,
      total: '1037001.00',
    },
    taxSummary: [{ label: 'VAT', percent: '13', base: taxable, tax: vat }],
    // The renderer formats from its own snapshot, not from this field; the default keeps the view valid.
    display: defaultPortalDisplay(),
    file: null,
  };
}
