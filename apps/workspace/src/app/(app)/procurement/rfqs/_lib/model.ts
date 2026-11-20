import type { PrStatus, RfqStatus } from '@bos/contracts';

import type { BadgeTone } from '../../requests/_lib/model';

/**
 * What the RFQ screens show and offer, decided from the RFQ's status and the person's live grants. Pure.
 * The API still decides every call (deny by default); this only keeps buttons away from people and
 * statuses that would be refused.
 */

export const RFQ_STATUS_LABEL: Record<RfqStatus, { tone: BadgeTone; text: string }> = {
  open: { tone: 'info', text: 'Open' },
  closed: { tone: 'neutral', text: 'Closed' },
  recommended: { tone: 'success', text: 'Recommended' },
  cancelled: { tone: 'neutral', text: 'Cancelled' },
};

/** One line under the status on the detail page: what happens next, in plain words. */
export const RFQ_STATUS_NOTE: Record<RfqStatus, string> = {
  open: 'Invited vendors can send a quotation, and you can enter one for them. Recommend a quotation once enough are in.',
  closed: 'No more quotations are taken. A quotation can still be recommended.',
  recommended:
    'A quotation was recommended. Submit it for the commitment approvals to move towards a purchase order.',
  cancelled: 'This RFQ was cancelled.',
};

export interface RfqGrants {
  /** Sourcing: open RFQs, enter or convert quotations, score, recommend and commit. */
  sourcing: boolean;
}

/**
 * The live-grant predicate from `getPermissionCheck`. Role keys are not accepted: a grant changed in
 * Settings > Access must show here the way the API enforces it.
 */
export type RfqGrantSource = (permission: string) => boolean;

/** The sourcing permission from live grants. Server-side only. */
export function rfqGrants(source: RfqGrantSource): RfqGrants {
  return { sourcing: source('procurement.sourcing') };
}

/** "Start RFQ" on a purchase request: department-approved, no RFQ yet, and the person may source. */
export function canStartRfq(
  status: PrStatus,
  rfqId: string | null | undefined,
  source: RfqGrantSource,
): boolean {
  return status === 'dept_approved' && !rfqId && rfqGrants(source).sourcing;
}

/** Quotations are entered and converted only while the RFQ is open (the API answers 409 otherwise). */
export function takesQuotations(status: RfqStatus): boolean {
  return status === 'open';
}

export interface Convertibility {
  convertible: boolean;
  /** Short label for the scan column. */
  label: string;
  tone: BadgeTone;
  /** Why it cannot be converted yet; empty when it can. */
  reason: string;
}

/** Only a file whose scan passed (`clean`) can be turned into a quotation. */
export function submissionConvertibility(scanStatus: string | null): Convertibility {
  switch (scanStatus) {
    case 'clean':
      return { convertible: true, label: 'Scan passed', tone: 'success', reason: '' };
    case 'quarantined':
      return {
        convertible: false,
        label: 'Scanning',
        tone: 'warning',
        reason: 'The file is still being scanned. Try again in a moment.',
      };
    case 'awaiting_content':
      return {
        convertible: false,
        label: 'Waiting for upload',
        tone: 'warning',
        reason: 'The vendor has not finished uploading the file.',
      };
    case 'infected':
      return {
        convertible: false,
        label: 'Virus found',
        tone: 'error',
        reason: 'The scan found a virus. This file cannot be used.',
      };
    case 'rejected':
      return {
        convertible: false,
        label: 'File rejected',
        tone: 'error',
        reason: 'The file was rejected. Ask the vendor to send it again.',
      };
    case null:
      return {
        convertible: false,
        label: 'No file yet',
        tone: 'warning',
        reason: 'The submission has no file version yet.',
      };
    default:
      return {
        convertible: false,
        label: 'Scan failed',
        tone: 'error',
        reason: 'The scan did not finish. Ask the vendor to send the file again.',
      };
  }
}

/**
 * Scores and a recommendation are taken while the RFQ is open or closed. The API refuses a
 * recommendation in any other status; scoring has no status check there, so this is the screen's
 * own choice: scoring a recommended or cancelled RFQ would change nothing anyone acts on.
 */
export function takesDecisions(status: RfqStatus): boolean {
  return status === 'open' || status === 'closed';
}

export interface CommitOffer {
  show: boolean;
  /** Why the button is missing when the person would otherwise expect it. */
  why?: string;
}

/**
 * The commitment submit: the RFQ holds a recommendation and its purchase request is back in
 * `sourcing` (the same two facts the API checks), and the person may source. Not the approval
 * request id: a request returned to sourcing after a decision may be submitted again.
 */
export function canCommit(
  rfq: { status: RfqStatus; recommendedQuotationId: string | null; prStatus: string | null },
  source: RfqGrantSource,
): CommitOffer {
  if (!rfqGrants(source).sourcing) return { show: false };
  if (rfq.status !== 'recommended' || rfq.recommendedQuotationId === null) return { show: false };
  if (rfq.prStatus === null) {
    return {
      show: false,
      why: 'The purchase request did not load, so we cannot tell whether this can be submitted. Reload the page to try again.',
    };
  }
  return { show: rfq.prStatus === 'sourcing' };
}
