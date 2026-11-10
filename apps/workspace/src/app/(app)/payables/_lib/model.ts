import type { BillStatus, MatchStatus } from '@bos/contracts';

import { hasPermission } from '@/components/p2/customers/permissions';

import type { BadgeTone } from '../../procurement/orders/_lib/model';

/**
 * What the payables screens show and offer, decided from the bill's status and the person's roles.
 * Pure. The API still decides every call (deny by default); this only keeps buttons away from
 * people and statuses that would be refused. The status rules mirror the API's `submittable` and
 * the bill transitions in the contracts.
 */

export const BILL_STATUS_LABEL: Record<BillStatus, { tone: BadgeTone; text: string }> = {
  draft: { tone: 'neutral', text: 'Draft' },
  discarded: { tone: 'neutral', text: 'Discarded' },
  matching: { tone: 'info', text: 'Matching' },
  variance: { tone: 'warning', text: 'Outside tolerance' },
  exception_pending: { tone: 'warning', text: 'Exception pending' },
  pending_approval: { tone: 'info', text: 'Waiting for approval' },
  approved: { tone: 'success', text: 'Approved' },
  partially_paid: { tone: 'info', text: 'Partly paid' },
  paid: { tone: 'success', text: 'Paid' },
  voided: { tone: 'neutral', text: 'Voided' },
  rejected: { tone: 'error', text: 'Rejected' },
};

export const MATCH_STATUS_LABEL: Record<MatchStatus, { tone: BadgeTone; text: string }> = {
  not_required: { tone: 'neutral', text: 'No order to match' },
  pending: { tone: 'neutral', text: 'Not matched yet' },
  matched: { tone: 'success', text: 'Matched' },
  variance: { tone: 'warning', text: 'Outside tolerance' },
  exception_approved: { tone: 'success', text: 'Exception approved' },
};

/** A line's match run. The API's status set can grow, so an unknown one shows as it came. */
export function matchResultLabel(status: string): { tone: BadgeTone; text: string } {
  if (status === 'matched') return { tone: 'success', text: 'Matched' };
  if (status === 'variance') return { tone: 'warning', text: 'Variance' };
  return { tone: 'neutral', text: status };
}

/** The scan status of a submitted file; a bill can be keyed from it only once it is clean. */
export function fileStatusLabel(status: string | null): { tone: BadgeTone; text: string } {
  if (status === null) return { tone: 'neutral', text: 'Not scanned yet' };
  if (status === 'clean') return { tone: 'success', text: 'Scanned clean' };
  if (status === 'infected') return { tone: 'error', text: 'Infected' };
  if (status === 'failed' || status === 'scan_failed')
    return { tone: 'error', text: 'Scan failed' };
  if (status === 'rejected') return { tone: 'error', text: 'File rejected' };
  return { tone: 'info', text: 'Scan in progress' };
}

export interface BillGrants {
  /** `payables.bill.enter`: accountants, who key in, match, submit and void bills. */
  enter: boolean;
  /** `payables.bill.read`: accountants and finance. */
  read: boolean;
}

/** The permissions the session's roles hold by default. Server-side only. */
export function billGrants(roles: readonly string[]): BillGrants {
  return {
    enter: hasPermission(roles, 'payables.bill.enter'),
    read: hasPermission(roles, 'payables.bill.read'),
  };
}

export interface BillActions {
  match: boolean;
  submit: boolean;
  void: boolean;
}

const MATCHABLE: readonly BillStatus[] = ['draft', 'matching', 'variance'];

/** Mirrors the API's `submittable`: matched, an approved exception, or a bill with no order. */
function submittable(status: BillStatus, matchStatus: MatchStatus): boolean {
  if (matchStatus === 'matched') return status === 'matching';
  if (matchStatus === 'exception_approved') return status === 'exception_pending';
  if (matchStatus === 'not_required') return status === 'draft' || status === 'matching';
  return false;
}

/** Match again while a PO bill is still being matched; submit when matched; void once approved. */
export function billActions(
  bill: { status: BillStatus; matchStatus: MatchStatus; purchaseOrderId: string | null },
  can: { enter: boolean },
): BillActions {
  const on = can.enter;
  return {
    match: on && bill.purchaseOrderId !== null && MATCHABLE.includes(bill.status),
    submit: on && submittable(bill.status, bill.matchStatus),
    void: on && bill.status === 'approved',
  };
}
