// Contracts for promises to pay (F1-Q33, decision D56). Finance or an Accountant records the day a customer promised
// to pay an issued, unpaid invoice. When that day passes with the invoice still open, the payment-promise job marks
// the promise `missed`, plans one collection call for Finance and the receivables aging flags the customer.
import { z } from 'zod';

const isoDate = z.iso.date();
const isoDateTime = z.iso.datetime({ offset: true });

/**
 * open until the job settles it: `missed` (the day passed, the invoice is still open) or `kept` (it was settled); or
 * `replaced` when a newer promise was recorded on the invoice while this one was open (decision R4c1 Q6).
 */
export const PAYMENT_PROMISE_STATUSES = ['open', 'missed', 'kept', 'replaced'] as const;
export const PaymentPromiseStatusSchema = z.enum(PAYMENT_PROMISE_STATUSES);
export type PaymentPromiseStatus = z.infer<typeof PaymentPromiseStatusSchema>;

/**
 * `POST /v1/receivables/invoices/:id/promises` (Idempotency-Key header). The day is today or later, Kathmandu. An open
 * promise on the invoice becomes `replaced` in the same transaction.
 */
export const RecordPaymentPromiseBodySchema = z.strictObject({
  promisedDate: isoDate,
  note: z.string().trim().min(1).max(1000).optional(),
});
export type RecordPaymentPromiseBody = z.infer<typeof RecordPaymentPromiseBodySchema>;

export const PaymentPromiseDtoSchema = z.object({
  id: z.guid(),
  invoiceId: z.guid(),
  promisedDate: isoDate,
  note: z.string().nullable(),
  status: PaymentPromiseStatusSchema,
  recordedByUserId: z.guid(),
  /** When the job marked it missed; null otherwise. */
  missedAt: isoDateTime.nullable(),
  /** The collection call the job planned (an activity id); null until the promise is missed. */
  collectionActivityId: z.guid().nullable(),
  createdAt: isoDateTime,
});
export type PaymentPromiseDto = z.infer<typeof PaymentPromiseDtoSchema>;

/** Why the caller may not record a promise on this invoice now: no `payment.record`, or nothing is owed on it. */
export const PAYMENT_PROMISE_RECORD_BLOCKS = ['no_permission', 'invoice_not_open'] as const;
export const PaymentPromiseRecordBlockSchema = z.enum(PAYMENT_PROMISE_RECORD_BLOCKS);
export type PaymentPromiseRecordBlock = z.infer<typeof PaymentPromiseRecordBlockSchema>;

/** One promise in the invoice's history: the stored promise, who recorded it and when it last changed. */
export const PaymentPromiseListItemSchema = PaymentPromiseDtoSchema.extend({
  /** The recorder's display name; null when the user has none. */
  recordedByName: z.string().nullable(),
  /** When it was recorded, missed, kept or replaced (the last change). */
  updatedAt: isoDateTime,
});
export type PaymentPromiseListItem = z.infer<typeof PaymentPromiseListItemSchema>;

/** `GET /v1/receivables/invoices/:id/promises`: every promise on the invoice, newest first, and what the caller may do. */
export const PaymentPromiseListSchema = z.object({
  items: z.array(PaymentPromiseListItemSchema),
  can: z.object({
    /** True when the caller holds `payment.record` on the customer and the invoice still has money owed. */
    record: z.boolean(),
    /** Why `record` is false; null when it is true. */
    reason: PaymentPromiseRecordBlockSchema.nullable(),
  }),
});
export type PaymentPromiseList = z.infer<typeof PaymentPromiseListSchema>;
