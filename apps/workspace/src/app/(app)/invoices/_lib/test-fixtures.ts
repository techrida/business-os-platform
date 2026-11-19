import { InvoiceDetailSchema, type InvoiceDetail } from '@bos/contracts';

// Shared by the invoice screen tests. Parsed with the contract, so a fixture that drifts from it fails here.
export const ID = '11111111-1111-4111-8111-111111111111';
export const CUSTOMER = '33333333-3333-4333-8333-333333333333';
export const SALES_ORDER = '77777777-7777-4777-8777-777777777777';
export const TAX = '66666666-6666-4666-8666-666666666666';
export const APPROVAL = '88888888-8888-4888-8888-888888888888';
export const KEY = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const WHEN = '2026-11-08T05:45:00.000Z';

const ISSUED = {
  status: 'issued',
  number: 'INV-2083/84-00001',
  fiscalYear: '2083/84',
  issueDate: '2026-11-08',
  issueDateBs: '2083-07-23',
  contentHash: 'a'.repeat(64),
  npr: { amountNpr: '2018180.00', rate: '1.000000', rateSource: 'NRB', rateDate: '2026-11-08' },
  seller: { legalName: 'Techrida Pvt. Ltd.', panVatNo: '123456789', address: 'Kathmandu' },
  buyer: { legalName: 'Himalayan Agro Foods', panVatNo: '987654321', address: 'Lalitpur' },
} as const;

export function invoiceDetail(
  invoice: Record<string, unknown> = {},
  rest: Partial<Pick<InvoiceDetail, 'lines' | 'taxSummary' | 'customerName'>> = {},
): InvoiceDetail {
  const issued = invoice['status'] === 'issued';
  return InvoiceDetailSchema.parse({
    invoice: {
      id: ID,
      kind: 'tax_invoice',
      status: 'draft',
      number: null,
      fiscalYear: null,
      customerId: CUSTOMER,
      salesOrderId: SALES_ORDER,
      scheduleLineId: null,
      originalInvoiceId: null,
      manualReason: null,
      noteReason: null,
      currency: 'NPR',
      totals: {
        subtotal: '1880000.00',
        discountAmount: '94000.00',
        taxableAmount: '1786000.00',
        exemptAmount: '12000.00',
        zeroRatedAmount: '3500.00',
        taxAmount: '232180.00',
        total: '2018180.00',
      },
      npr: null,
      issueDate: null,
      issueDateBs: null,
      dueDate: '2026-12-08',
      seller: null,
      buyer: null,
      calcVersion: 1,
      contentHash: null,
      approvalRequestId: null,
      version: 4,
      createdAt: WHEN,
      updatedAt: WHEN,
      ...(issued ? ISSUED : {}),
      ...invoice,
    },
    ...(rest.customerName === undefined ? {} : { customerName: rest.customerName }),
    lines: rest.lines ?? [
      {
        lineNo: 1,
        catalogItemId: null,
        description: 'Advance 40% of the website build',
        uom: 'lot',
        quantity: '1.0000',
        unitPrice: '1880000.00',
        taxCodeId: TAX,
        gross: '1880000.00',
        discountAlloc: '94000.00',
        taxable: '1786000.00',
        taxAmount: '232180.00',
      },
    ],
    taxSummary: rest.taxSummary ?? [
      { taxCodeId: TAX, label: 'VAT', percent: '13', base: '1786000.00', tax: '232180.00' },
    ],
    prints: [],
  });
}
