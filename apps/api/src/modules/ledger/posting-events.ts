// The PostingEvent union of LedgerService (P3 plan, U0-B). Spelled out here, not re-exported from @bos/db, so
// posting-events.test.ts can compare it against both the Drizzle list and the posting_events_event_check of
// 0019_open_items.sql: the three must name the same ten events.

/** P3 sales and invoicing. `allocation` and `allocation_reversed` are keyed by the allocation row. */
export const P3_POSTING_EVENTS = [
  'invoice_issued',
  'debit_note_issued',
  'credit_note_issued',
  'payment_verified',
  'payment_reversed',
  'allocation',
  'allocation_reversed',
] as const;

/** P4 procurement, declared here so the database CHECK and this union never need a P4 change. */
export const P4_POSTING_EVENTS = [
  'vendor_bill_posted',
  'vendor_payment_made',
  'vendor_debit_note_issued',
] as const;

export const POSTING_EVENTS = [...P3_POSTING_EVENTS, ...P4_POSTING_EVENTS] as const;

export type PostingEvent = (typeof POSTING_EVENTS)[number];

const EVENT_SET: ReadonlySet<string> = new Set(POSTING_EVENTS);

export function isPostingEvent(value: string): value is PostingEvent {
  return EVENT_SET.has(value);
}
