import {
  DEFAULT_ROLE_PERMISSIONS,
  type ApprovalRequestDto,
  type PrRequestType,
  type PrStatus,
} from '@bos/contracts';

import { hasPermission } from '@/components/p2/customers/permissions';

/**
 * What the purchase request screens show and offer, decided from the request's status and the
 * person's roles. Pure. The API still decides every call (deny by default); this only keeps
 * buttons away from people and statuses that would be refused.
 */

export type BadgeTone = 'neutral' | 'info' | 'success' | 'warning' | 'error';

export const PR_STATUS_LABEL: Record<PrStatus, { tone: BadgeTone; text: string }> = {
  draft: { tone: 'neutral', text: 'Draft' },
  submitted: { tone: 'warning', text: 'Awaiting approval' },
  returned: { tone: 'warning', text: 'Returned' },
  dept_approved: { tone: 'success', text: 'Department approved' },
  sourcing: { tone: 'info', text: 'Sourcing' },
  commitment_pending: { tone: 'warning', text: 'Commitment pending' },
  approved: { tone: 'success', text: 'Approved' },
  po_issued: { tone: 'success', text: 'PO issued' },
  closed: { tone: 'neutral', text: 'Closed' },
  rejected: { tone: 'error', text: 'Rejected' },
  cancelled: { tone: 'neutral', text: 'Cancelled' },
};

/** One line under the status on the detail page: what happens next, in plain words. */
export const PR_STATUS_NOTE: Record<PrStatus, string> = {
  draft: 'Not sent yet. Check the lines, then submit it to the department head.',
  submitted: 'With the department head for a decision. It cannot be edited while it waits.',
  returned: 'The approver sent this back. Edit it, then submit it again.',
  dept_approved: 'The department head approved the need. Procurement can now open an RFQ.',
  sourcing: 'An RFQ is open and vendors are being asked to quote.',
  commitment_pending: 'A quotation was recommended and is waiting for the commitment approvals.',
  approved: 'The commitment is approved. A purchase order comes next.',
  po_issued: 'A purchase order was issued to the vendor.',
  closed: 'This request is complete.',
  rejected: 'The request was rejected. It cannot be reopened.',
  cancelled: 'The request was cancelled before it was submitted.',
};

export const REQUEST_TYPE_LABEL: Record<PrRequestType, string> = {
  goods: 'Goods',
  service: 'Service',
  mixed: 'Goods and service',
};

export interface PrGrants {
  read: boolean;
  /** The grant covers every request in the entity, not only the person's own. */
  readAll: boolean;
  create: boolean;
}

/** The purchase request permissions the session's roles hold by default. Server-side only. */
export function prGrants(roles: readonly string[]): PrGrants {
  const grants: Record<string, Record<string, unknown> | undefined> = DEFAULT_ROLE_PERMISSIONS;
  return {
    read: hasPermission(roles, 'procurement.pr.read'),
    readAll: roles.some(
      (role) => Object.hasOwn(grants, role) && grants[role]?.['procurement.pr.read'] === 'all',
    ),
    create: hasPermission(roles, 'procurement.pr.create'),
  };
}

/** A draft or returned request can be edited and submitted; every other status is read-only. */
export function isPrEditable(status: PrStatus): boolean {
  return status === 'draft' || status === 'returned';
}

/** Only a draft can be cancelled (the API answers 409 otherwise). */
export function canCancelPr(status: PrStatus): boolean {
  return status === 'draft';
}

/** The status groups the list's count cards show, in card order. */
export const PR_COUNT_GROUPS = {
  awaiting: ['submitted'],
  sourcing: ['dept_approved', 'sourcing', 'commitment_pending'],
  approved: ['approved', 'po_issued'],
} as const satisfies Record<string, readonly PrStatus[]>;

/**
 * The statuses to count for one card under the list's status filter: the group itself when no status is
 * picked, else only the picked statuses inside the group. An empty answer means the card is 0 and needs
 * no call (an empty `status` would count every status).
 */
export function countStatuses(group: readonly PrStatus[], picked: readonly PrStatus[]): PrStatus[] {
  return picked.length === 0 ? [...group] : group.filter((s) => picked.includes(s));
}

type ApprovalRequestStatus = ApprovalRequestDto['status'];

/** Where the approval of a request stands, as one sentence; `decided` is the formatted decision time. */
export function approvalSummary(status: ApprovalRequestStatus, decided: string | null): string {
  const on = decided !== null ? ` on ${decided}` : '';
  const text: Record<ApprovalRequestStatus, string> = {
    pending: 'Waiting for a decision.',
    approved: `Approved${on}.`,
    returned: `Sent back for changes${on}.`,
    rejected: `Rejected${on}.`,
    blocked: 'Blocked: no approver is available for a step. Ask an administrator.',
    cancelled: `Withdrawn${on}.`,
  };
  return text[status];
}
