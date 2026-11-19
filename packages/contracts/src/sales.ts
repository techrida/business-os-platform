// Contracts for sales orders and their billing schedule (P3). Serves the NFR "amounts are exact":
// money is numeric(18,2) strings. A sales order is the confirmed sale: a frozen copy of an accepted
// quotation version plus a billing schedule whose live lines add up to the order total (plan A7).
import { z } from 'zod';

import { InvoiceStatusSchema } from './invoicing.js';
import { CurrencySchema, DecimalString, NprSnapshotSchema } from './money.js';
import {
  FULL_PAYMENT_PERCENT_UNITS,
  NonNegativeDecimalString,
  paymentPercentUnits,
  PercentFourDecimals,
  QuantityString,
} from './quotations.js';

const isoDateTime = z.iso.datetime({ offset: true });
const text = (max: number) => z.string().trim().min(1).max(max);

// ---------------------------------------------------------------------------------------------
// Statuses and triggers
// ---------------------------------------------------------------------------------------------

export const SALES_ORDER_STATUSES = ['draft', 'confirmed', 'completed', 'cancelled'] as const;
export const SalesOrderStatusSchema = z.enum(SALES_ORDER_STATUSES);
export type SalesOrderStatus = z.infer<typeof SalesOrderStatusSchema>;

/** What makes a schedule line billable. An `advance` line starts billable when the order is confirmed. */
export const SCHEDULE_TRIGGERS = [
  'advance',
  'milestone',
  'uat',
  'delivery',
  'date',
  'manual',
] as const;
export const ScheduleTriggerSchema = z.enum(SCHEDULE_TRIGGERS);
export type ScheduleTrigger = z.infer<typeof ScheduleTriggerSchema>;

export const SCHEDULE_LINE_STATUSES = [
  'planned',
  'billable',
  'drafted',
  'invoiced',
  'cancelled',
] as const;
export const ScheduleLineStatusSchema = z.enum(SCHEDULE_LINE_STATUSES);
export type ScheduleLineStatus = z.infer<typeof ScheduleLineStatusSchema>;

/** Evidence kinds a sales order keeps: the customer's PO, a contract or the signed quotation. */
export const SALES_EVIDENCE_KINDS = ['contract', 'purchase_order', 'signed_quote'] as const;

// ---------------------------------------------------------------------------------------------
// The billing schedule template (also the shape of the `sales.default_schedule` setting)
// ---------------------------------------------------------------------------------------------

/** One planned slice of the order: a label, its share in percent, and what triggers the invoice. */
export const ScheduleLineInputSchema = z.strictObject({
  label: text(100),
  percent: PercentFourDecimals,
  trigger: ScheduleTriggerSchema,
});
export type ScheduleLineInput = z.infer<typeof ScheduleLineInputSchema>;

/** The slices must add up to exactly 100%: the schedule then adds up to the order total. */
export const ScheduleTemplateSchema = z
  .array(ScheduleLineInputSchema)
  .min(1)
  .max(12)
  .refine(
    (lines) =>
      lines.reduce((sum, l) => sum + paymentPercentUnits(l.percent), 0) ===
      FULL_PAYMENT_PERCENT_UNITS,
    {
      message: 'percentages must add up to 100',
    },
  );
export type ScheduleTemplate = z.infer<typeof ScheduleTemplateSchema>;

/** Plan A7: 60/20/20 when the accepted quotation carries no payment schedule of its own. */
export const DEFAULT_SALES_SCHEDULE: ScheduleTemplate = [
  { label: 'Advance 60%', percent: '60', trigger: 'advance' },
  { label: 'Milestone 20%', percent: '20', trigger: 'milestone' },
  { label: 'Final 20%', percent: '20', trigger: 'uat' },
];

// ---------------------------------------------------------------------------------------------
// DTOs
// ---------------------------------------------------------------------------------------------

/** The invoice a schedule line holds, as the order's reader may see it: its number (none until issued) and status. */
export const ScheduleLineInvoiceSchema = z.object({
  number: z.string().nullable(),
  status: InvoiceStatusSchema,
});
export type ScheduleLineInvoice = z.infer<typeof ScheduleLineInvoiceSchema>;

export const ScheduleLineDtoSchema = z
  .object({
    id: z.guid(),
    salesOrderId: z.guid(),
    seq: z.number().int().min(1),
    label: z.string().min(1),
    trigger: ScheduleTriggerSchema,
    /** Null for a line the revision flow added by amount. */
    percent: PercentFourDecimals.nullable(),
    /** The VAT-inclusive slice of the order total. */
    amount: NonNegativeDecimalString,
    status: ScheduleLineStatusSchema,
    billableEvidenceDocumentId: z.guid().nullable(),
    billableMarkedAt: isoDateTime.nullable(),
    /** Set exactly while the line is drafted or invoiced. */
    invoiceId: z.guid().nullable(),
    /** The held invoice's number and status, read with the order (no invoice.read needed); null without one. */
    invoice: ScheduleLineInvoiceSchema.nullable().optional(),
    /** Whether the caller may open the held invoice (invoice.read on that invoice). */
    can: z.object({ openInvoice: z.boolean() }).optional(),
  })
  .refine((l) => (l.status === 'drafted' || l.status === 'invoiced') === (l.invoiceId !== null), {
    message: 'invoiceId is set exactly when the line is drafted or invoiced',
    path: ['invoiceId'],
  });
export type ScheduleLineDto = z.infer<typeof ScheduleLineDtoSchema>;

export const SalesOrderLineDtoSchema = z.object({
  lineNo: z.number().int().min(1),
  catalogItemId: z.guid().nullable(),
  description: z.string(),
  uom: z.string(),
  quantity: QuantityString,
  unitPrice: NonNegativeDecimalString,
  taxCodeId: z.guid(),
  gross: DecimalString,
  discountAlloc: DecimalString,
  taxable: DecimalString,
});
export type SalesOrderLineDto = z.infer<typeof SalesOrderLineDtoSchema>;

export const SalesOrderTotalsSchema = z.object({
  subtotal: DecimalString,
  discountAmount: DecimalString,
  taxableAmount: DecimalString,
  taxAmount: DecimalString,
  total: DecimalString,
});
export type SalesOrderTotals = z.infer<typeof SalesOrderTotalsSchema>;

export const SalesOrderEvidenceDtoSchema = z.object({
  documentId: z.guid(),
  kind: z.enum(SALES_EVIDENCE_KINDS),
});
export type SalesOrderEvidenceDto = z.infer<typeof SalesOrderEvidenceDtoSchema>;

/** The order header. Number, fiscal year and confirmation time exist from `confirmed` on. */
export const SalesOrderDtoSchema = z
  .object({
    id: z.guid(),
    number: z.string().min(1).max(40).nullable(),
    fiscalYear: z.string().min(1).nullable(),
    customerId: z.guid(),
    quotationId: z.guid(),
    quotationVersionId: z.guid(),
    status: SalesOrderStatusSchema,
    currency: CurrencySchema,
    totals: SalesOrderTotalsSchema,
    npr: NprSnapshotSchema,
    creditDays: z.number().int().min(0),
    confirmedAt: isoDateTime.nullable(),
    version: z.number().int().min(1),
    createdAt: isoDateTime,
    updatedAt: isoDateTime,
  })
  .refine((o) => o.status === 'draft' || (o.number !== null && o.confirmedAt !== null), {
    message: 'a confirmed order has a number and a confirmation time',
    path: ['number'],
  });
export type SalesOrderDto = z.infer<typeof SalesOrderDtoSchema>;

/** One row of `GET /v1/sales-orders`. */
export const SalesOrderListItemSchema = z.object({
  id: z.guid(),
  number: z.string().nullable(),
  customerId: z.guid(),
  customerName: z.string().min(1),
  status: SalesOrderStatusSchema,
  currency: CurrencySchema,
  total: DecimalString,
  confirmedAt: isoDateTime.nullable(),
});
export type SalesOrderListItem = z.infer<typeof SalesOrderListItemSchema>;

export const SalesOrderDetailSchema = z.object({
  order: SalesOrderDtoSchema,
  lines: z.array(SalesOrderLineDtoSchema),
  schedule: z.array(ScheduleLineDtoSchema),
  evidence: z.array(SalesOrderEvidenceDtoSchema),
  /** Plan A14: true when the advance invoice has an open amount of 0. P4's delivery module reads it. */
  deliveryReleased: z.boolean(),
  /** What the caller may do on this order's schedule, from its live grants. */
  can: z.object({ markBillable: z.boolean(), draftInvoice: z.boolean() }).optional(),
});
export type SalesOrderDetail = z.infer<typeof SalesOrderDetailSchema>;

// ---------------------------------------------------------------------------------------------
// Bodies (an `Idempotency-Key` header goes with every command; it is not a body field)
// ---------------------------------------------------------------------------------------------

/** Confirm an accepted quotation version as a sales order. The evidence policy decides what must be attached. */
export const ConfirmSalesOrderBodySchema = z.strictObject({
  quotationVersionId: z.guid(),
  evidenceDocumentIds: z.array(z.guid()).max(10).default([]),
});
export type ConfirmSalesOrderBody = z.infer<typeof ConfirmSalesOrderBodySchema>;

/** A milestone or UAT fired. An advance line needs no evidence; every other trigger does. */
export const MarkBillableBodySchema = z.strictObject({
  evidenceDocumentId: z.guid().optional(),
  expectedVersion: z.number().int().min(1),
});
export type MarkBillableBody = z.infer<typeof MarkBillableBodySchema>;

/** Re-split the live lines. Approved through the approval engine; the new lines must keep the 100% total. */
export const ReviseScheduleBodySchema = z.strictObject({
  lines: ScheduleTemplateSchema,
  reason: text(1000),
  expectedVersion: z.number().int().min(1),
});
export type ReviseScheduleBody = z.infer<typeof ReviseScheduleBodySchema>;

export const CancelSalesOrderBodySchema = z.strictObject({
  reason: text(1000),
  expectedVersion: z.number().int().min(1),
});
export type CancelSalesOrderBody = z.infer<typeof CancelSalesOrderBodySchema>;
