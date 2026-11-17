import {
  isChecklistComplete,
  ReviewVerificationBodySchema,
  VERIFICATION_STATUSES,
  type ChecklistItem,
  type DocumentVersionDto,
  type ReviewVerificationBody,
  type VerificationCaseDto,
  type VerificationStatus,
} from '@bos/contracts';

/**
 * Pure helpers for the customer and KYB screens. Server-side use (it imports the contracts'
 * runtime); Client Components get the answers as props.
 */

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True for a GUID: checked before an id from the URL goes into an API path. */
export function isGuid(value: string): boolean {
  return GUID.test(value);
}

export type BadgeTone = 'neutral' | 'info' | 'success' | 'warning' | 'error';

export const CHECKLIST_LABEL: Record<ChecklistItem['key'], string> = {
  registration_certificate: 'Company registration certificate',
  pan_vat_certificate: 'PAN or VAT certificate',
  authorised_signatory_id: 'Authorised signatory ID',
  address_proof: 'Proof of address',
  other: 'Other supporting document',
};

export const CHECKLIST_STATUS: Record<ChecklistItem['status'], { tone: BadgeTone; text: string }> =
  {
    missing: { tone: 'neutral', text: 'Missing' },
    provided: { tone: 'info', text: 'Provided, not reviewed' },
    accepted: { tone: 'success', text: 'Accepted' },
    rejected: { tone: 'error', text: 'Rejected' },
  };

export const VERIFICATION_STATUS_LABEL: Record<
  VerificationStatus,
  { tone: BadgeTone; text: string }
> = {
  draft: { tone: 'neutral', text: 'Draft' },
  submitted: { tone: 'warning', text: 'Awaiting review' },
  approved: { tone: 'success', text: 'Verified' },
  rejected: { tone: 'error', text: 'Rejected' },
  expired: { tone: 'neutral', text: 'Expired' },
};

export interface ChecklistProgress {
  accepted: number;
  required: number;
  complete: boolean;
}

/** How many required items are accepted, and whether acceptance is complete. */
export function checklistProgress(items: readonly ChecklistItem[]): ChecklistProgress {
  const required = items.filter((i) => i.required);
  return {
    accepted: required.filter((i) => i.status === 'accepted').length,
    required: required.length,
    complete: isChecklistComplete(items),
  };
}

/** Scan evidence is read server-side; unavailable evidence must never enable approval. */
export type ApprovalFile = { status: DocumentVersionDto['status'] } | null | 'unavailable';
export type ApprovalFiles = ReadonlyMap<string, ApprovalFile>;

/** Match the API: newest non-rejected version, even when currentVersionId points at an older clean file. */
export function approvalFile(
  versions: readonly Pick<DocumentVersionDto, 'version' | 'status'>[],
): ApprovalFile {
  return (
    versions.filter((v) => v.status !== 'rejected').sort((a, b) => b.version - a.version)[0] ?? null
  );
}

/** Customer document review requires explicit decisions before final case approval. */
export function approveBlockedReason(
  c: Pick<VerificationCaseDto, 'status' | 'checklist' | 'reviewPolicy' | 'approvalBlockedReason'>,
  files: ApprovalFiles = new Map(),
): string | null {
  if (c.approvalBlockedReason !== undefined) return c.approvalBlockedReason;
  if (c.status !== 'submitted') return 'Only a case awaiting review can be approved.';
  if (
    c.reviewPolicy === 'document_review_v1' &&
    c.checklist.some((i) => i.documentId && i.status !== 'accepted')
  )
    return 'Approve or reject every supplied document before approving the case.';
  const required = c.checklist.filter((i) => i.required);
  if (required.length === 0) return 'Approval requires at least one required document.';
  for (const item of required) {
    const label = CHECKLIST_LABEL[item.key];
    if (item.documentId === null || !['provided', 'accepted'].includes(item.status)) {
      return `${label}: a required document is missing or rejected. Reject the case to request a replacement.`;
    }
  }
  // Include optional attachments: the API also requires all case attachments to be clean.
  for (const item of c.checklist.filter((i) => i.documentId !== null)) {
    const file = files.get(item.documentId!);
    const label = CHECKLIST_LABEL[item.key];
    if (file === undefined || file === null || file === 'unavailable') {
      return `${label}: file or scan details are unavailable. Reload to check again.`;
    }
    if (file.status !== 'clean') {
      return `${label}: scan status is ${file.status}. Approval requires clean documents. Reload after scanning, or reject to request a replacement.`;
    }
  }
  return null;
}

export function canApprove(
  c: Pick<VerificationCaseDto, 'status' | 'checklist' | 'reviewPolicy' | 'approvalBlockedReason'>,
  files: ApprovalFiles = new Map(),
): boolean {
  return approveBlockedReason(c, files) === null;
}

/** A submitted case can always be rejected, whatever its checklist says. */
export function canReject(c: Pick<VerificationCaseDto, 'status'>): boolean {
  return c.status === 'submitted';
}

export type StatusFilter = VerificationStatus | 'all';

/** The queue's status filter from `?status=`. Anything unknown means the review queue. */
export function parseStatusFilter(raw: string | string[] | undefined): StatusFilter {
  if (typeof raw !== 'string') return 'submitted';
  if (raw === 'all') return 'all';
  return (VERIFICATION_STATUSES as readonly string[]).includes(raw)
    ? (raw as VerificationStatus)
    : 'submitted';
}

export type DecisionParse =
  | { ok: true; data: ReviewVerificationBody }
  | { ok: false; commentError: string }
  | { ok: false; formError: true };

const REASON_PROMPT = {
  approve: 'Say why you are approving. The reason is kept in the audit trail.',
  reject: 'Say why you are rejecting. The reason is kept in the audit trail.',
} as const;

/**
 * Checks the decision form. The brief asks for a reason on approve and on reject; the contract
 * requires one only on reject, so this is stricter on approve on purpose (the reason is the
 * audit trail of who vouched for the customer). `formError` means the form itself was tampered
 * with or is stale, not that the person typed something wrong.
 */
export function parseDecision(raw: {
  decision: string;
  comment: string;
  expectedVersion: string;
}): DecisionParse {
  if (raw.decision !== 'approve' && raw.decision !== 'reject')
    return { ok: false, formError: true };
  const comment = raw.comment.trim();
  if (comment === '') return { ok: false, commentError: REASON_PROMPT[raw.decision] };
  if (comment.length > 2000) {
    return { ok: false, commentError: 'The reason is too long. The limit is 2,000 characters.' };
  }
  const parsed = ReviewVerificationBodySchema.safeParse({
    decision: raw.decision,
    comment,
    expectedVersion: Number(raw.expectedVersion),
  });
  return parsed.success ? { ok: true, data: parsed.data } : { ok: false, formError: true };
}

/** A customer's name, or an explicit unavailable state when it cannot be read. */
export function customerLabel(
  customer: { legalName: string; number: string } | undefined,
  _partyId?: string,
): string {
  if (customer !== undefined) return customer.legalName;
  return 'Customer name unavailable';
}
