// How a quotation status looks and reads in the workspace. Pure data and functions with no React
// import, so a list, a detail header and a test can all use them. Serves the NFR "the UI never
// shows data the contract does not promise": the filter accepts only the contract's statuses.
import { QUOTATION_STATUSES, type QuotationStatus } from '@bos/contracts';

export type StatusTone = 'neutral' | 'info' | 'success' | 'warning' | 'error';

export interface QuotationStatusMeta {
  label: string;
  tone: StatusTone;
}

/**
 * Typed as a full record, so adding a status to the contract is a compile error here until it has a
 * label and a tone. Submitted reads as "Awaiting approval": the approval steps are not states, so a
 * Submitted version stays Submitted while the approvers decide (A2 C3).
 */
const META: Record<QuotationStatus, QuotationStatusMeta> = {
  draft: { label: 'Draft', tone: 'neutral' },
  submitted: { label: 'Awaiting approval', tone: 'warning' },
  returned: { label: 'Returned', tone: 'warning' },
  approved: { label: 'Approved', tone: 'info' },
  sent: { label: 'Sent', tone: 'info' },
  accepted: { label: 'Accepted', tone: 'success' },
  rejected: { label: 'Rejected', tone: 'error' },
  expired: { label: 'Expired', tone: 'neutral' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
  superseded: { label: 'Superseded', tone: 'neutral' },
};

export function quotationStatusMeta(status: QuotationStatus): QuotationStatusMeta {
  return META[status];
}

/** The filter's options, one per status in the contract's order. */
export const STATUS_FILTER_OPTIONS: readonly { value: QuotationStatus; label: string }[] =
  QUOTATION_STATUSES.map((value) => ({ value, label: META[value].label }));

/**
 * Reads the `status` query parameter. Anything that is not exactly one contract status (absent,
 * empty, wrong case, repeated, or an object key such as `toString`) means "no filter", so a
 * hand-edited URL never reaches the API as a filter it would refuse.
 */
export function parseStatusFilter(raw: string | string[] | undefined): QuotationStatus | undefined {
  if (typeof raw !== 'string') return undefined;
  return (QUOTATION_STATUSES as readonly string[]).includes(raw)
    ? (raw as QuotationStatus)
    : undefined;
}
