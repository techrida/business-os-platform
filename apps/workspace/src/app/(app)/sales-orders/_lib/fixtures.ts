// Test data for the sales-order screens: valid DTOs, parsed with the contract's own schema, so a
// fixture that drifts from the contract fails here instead of in a screen. Not imported by any route.
import {
  SalesOrderDetailSchema,
  SalesOrderListItemSchema,
  type SalesOrderDetail,
  type SalesOrderListItem,
} from '@bos/contracts';

export const IDS = {
  order: '11111111-1111-4111-8111-111111111111',
  customer: '33333333-3333-4333-8333-333333333333',
  quotation: '77777777-7777-4777-8777-777777777777',
  version: '22222222-2222-4222-8222-222222222222',
  tax: '66666666-6666-4666-8666-666666666666',
  advance: '55555555-5555-4555-8555-555555555551',
  milestone: '55555555-5555-4555-8555-555555555552',
  final: '55555555-5555-4555-8555-555555555553',
  invoice: '99999999-9999-4999-8999-999999999999',
  po: '88888888-8888-4888-8888-888888888881',
  contract: '88888888-8888-4888-8888-888888888882',
} as const;

export const NOW = '2026-11-08T05:45:00.000Z';

type Line = SalesOrderDetail['schedule'][number];

export function scheduleLine(over: Partial<Line> & { id: string; seq: number }): Line {
  return {
    salesOrderId: IDS.order,
    label: 'Advance 60%',
    trigger: 'advance',
    percent: '60',
    amount: '3027270.00',
    status: 'planned',
    billableEvidenceDocumentId: null,
    billableMarkedAt: null,
    invoiceId: null,
    ...over,
  };
}

/** A confirmed order with the default 60/20/20 schedule: advance billable, the rest planned. */
export function salesOrderDetail(
  over: {
    order?: Record<string, unknown>;
    schedule?: Line[];
    evidence?: SalesOrderDetail['evidence'];
    lines?: SalesOrderDetail['lines'];
    deliveryReleased?: boolean;
    can?: SalesOrderDetail['can'];
  } = {},
): SalesOrderDetail {
  return SalesOrderDetailSchema.parse({
    order: {
      id: IDS.order,
      number: 'SO-2083/84-00001',
      fiscalYear: '2083/84',
      customerId: IDS.customer,
      quotationId: IDS.quotation,
      quotationVersionId: IDS.version,
      status: 'confirmed',
      currency: 'NPR',
      totals: {
        subtotal: '5045450.00',
        discountAmount: '0.00',
        taxableAmount: '5045450.00',
        taxAmount: '655908.50',
        total: '5701358.50',
      },
      npr: { amountNpr: '5701358.50', rate: '1', rateSource: 'base', rateDate: '2026-11-08' },
      creditDays: 30,
      confirmedAt: NOW,
      version: 3,
      createdAt: NOW,
      updatedAt: NOW,
      ...over.order,
    },
    lines: over.lines ?? [
      {
        lineNo: 1,
        catalogItemId: null,
        description: 'Website build',
        uom: 'job',
        quantity: '1.0000',
        unitPrice: '5045450.00',
        taxCodeId: IDS.tax,
        gross: '5045450.00',
        discountAlloc: '0.00',
        taxable: '5045450.00',
      },
    ],
    schedule: over.schedule ?? [
      scheduleLine({ id: IDS.advance, seq: 1, status: 'billable' }),
      scheduleLine({
        id: IDS.milestone,
        seq: 2,
        label: 'Milestone 20%',
        trigger: 'milestone',
        percent: '20',
        amount: '1009090.00',
      }),
      scheduleLine({
        id: IDS.final,
        seq: 3,
        label: 'Final 20%',
        trigger: 'uat',
        percent: '20',
        amount: '1009090.00',
      }),
    ],
    evidence: over.evidence ?? [
      { documentId: IDS.po, kind: 'purchase_order' },
      { documentId: IDS.contract, kind: 'contract' },
    ],
    deliveryReleased: over.deliveryReleased ?? false,
    can: over.can ?? { markBillable: true, draftInvoice: true },
  });
}

/** What `POST /v1/invoices/from-schedule` answers: a draft invoice, shaped as the contract says. */
export function invoiceDetail(): unknown {
  return {
    invoice: {
      id: IDS.invoice,
      kind: 'tax_invoice',
      status: 'draft',
      number: null,
      fiscalYear: null,
      customerId: IDS.customer,
      salesOrderId: IDS.order,
      scheduleLineId: IDS.advance,
      originalInvoiceId: null,
      manualReason: null,
      noteReason: null,
      currency: 'NPR',
      totals: {
        subtotal: '1880000.00',
        discountAmount: '94000.00',
        taxableAmount: '1786000.00',
        exemptAmount: '0.00',
        zeroRatedAmount: '0.00',
        taxAmount: '232180.00',
        total: '2018180.00',
      },
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
      createdAt: NOW,
      updatedAt: NOW,
    },
    lines: [],
    taxSummary: [],
    prints: [],
  };
}

export function listItem(over: Partial<SalesOrderListItem> = {}): SalesOrderListItem {
  return SalesOrderListItemSchema.parse({
    id: IDS.order,
    number: 'SO-2083/84-00001',
    customerId: IDS.customer,
    customerName: 'Himal Traders Pvt. Ltd.',
    quotationNumber: 'QT-2082-0042',
    status: 'confirmed',
    currency: 'NPR',
    total: '5701358.50',
    confirmedAt: NOW,
    ...over,
  });
}
