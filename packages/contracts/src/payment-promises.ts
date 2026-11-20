// Contracts for promises to pay (F1-Q33, decision D56). Finance or an Accountant records the day a customer promised
// to pay an issued, unpaid invoice. When that day passes with the invoice still open, the payment-promise job marks
// the promise `missed`, plans one collection call for Finance and the receivables aging flags the customer.
import { z } from 'zod';

const isoDate = z.iso.date();
const isoDateTime = z.iso.datetime({ offset: true });

/** open until the job settles it: `missed` (the day passed, the invoice is still open) or `kept` (it was settled). */
export const PAYMENT_PROMISE_STATUSES = ['open', 'missed', 'kept'] as const;
export const PaymentPromiseStatusSchema = z.enum(PAYMENT_PROMISE_STATUSES);
export type PaymentPromiseStatus = z.infer<typeof PaymentPromiseStatusSchema>;

/** `POST /v1/receivables/invoices/:id/promises` (Idempotency-Key header). The day is today or later, Kathmandu. */
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
