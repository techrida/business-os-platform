// How a quotation status looks and reads in the workspace. Pure data and functions with no React
// import, so a list, a detail header and a test can all use them. Serves the NFR "the UI never
// shows data the contract does not promise": the filter accepts only the contract's statuses.
import { QUOTATION_STATUSES, type QuotationStatus } from '@bos/contracts';

import type { IconName } from '@/components/ui/icon';

export type StatusTone = 'neutral' | 'info' | 'success' | 'warning' | 'error';

export interface QuotationStatusMeta {
  label: string;
  tone: StatusTone;
  /** Drawn beside the label so the state reads without colour. */
  icon: IconName;
}

/**
 * Typed as a full record, so adding a status to the contract is a compile error here until it has a
 * label and a tone. Submitted reads as "Awaiting approval": the approval steps are not states, so a
 * Submitted version stays Submitted while the approvers decide (A2 C3).
 */
const META: Record<QuotationStatus, QuotationStatusMeta> = {
  draft: { label: 'Draft', tone: 'neutral', icon: 'file-text' },
  submitted: { label: 'Awaiting approval', tone: 'warning', icon: 'shield-check' },
  returned: { label: 'Returned', tone: 'warning', icon: 'undo-2' },
  approved: { label: 'Approved', tone: 'info', icon: 'check' },
  sent: { label: 'Sent', tone: 'info', icon: 'mail' },
  accepted: { label: 'Accepted', tone: 'success', icon: 'check-circle' },
  rejected: { label: 'Rejected', tone: 'error', icon: 'x-circle' },
  expired: { label: 'Expired', tone: 'neutral', icon: 'calendar-days' },
  cancelled: { label: 'Cancelled', tone: 'neutral', icon: 'x' },
  superseded: { label: 'Superseded', tone: 'neutral', icon: 'layers' },
};

export function quotationStatusMeta(status: QuotationStatus): QuotationStatusMeta {
  return META[status];
}

/** The filter's options, one per status in the contract's order. */
export const STATUS_FILTER_OPTIONS: readonly { value: QuotationStatus; label: string }[] =
  QUOTATION_STATUSES.map((value) => ({ value, label: META[value].label }));

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Rows per page offered on the list; the first is the default. */
export const QUOTATION_ROW_OPTIONS = [5, 10, 20] as const;
export const QUOTATION_DEFAULT_ROWS = 5;

/**
 * What the quotations URL may carry, for `readList`: repeated `status` and `customerId` are kept
 * (each valid value once), and `opportunityId` is one id. Anything else is dropped, so a hand-edited
 * URL never reaches the API as a filter it would refuse. `opportunityId` is a scope, not a filter:
 * Clear filters leaves it in place.
 */
export const QUOTATION_LIST_SPEC = {
  multi: { status: QUOTATION_STATUSES, customerId: GUID },
  single: { opportunityId: GUID },
  rows: { allowed: QUOTATION_ROW_OPTIONS, default: QUOTATION_DEFAULT_ROWS },
} as const;

/** The same spec without the scope, for the Clear filters link. */
export const QUOTATION_FILTER_SPEC = { multi: QUOTATION_LIST_SPEC.multi } as const;
