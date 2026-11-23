import type { VendorKind, VendorStatus } from '@bos/contracts';

import { hasPermission, type PermissionSource } from '@/components/p2/customers/permissions';

/**
 * What the vendor screens show and offer, decided from the vendor's status and the person's
 * roles. Pure. The API still decides every call (deny by default); this only keeps buttons away
 * from people and statuses that would be refused.
 */

export type BadgeTone = 'neutral' | 'info' | 'success' | 'warning' | 'error';

export const VENDOR_STATUS_LABEL: Record<VendorStatus, { tone: BadgeTone; text: string }> = {
  draft: { tone: 'neutral', text: 'Draft' },
  pending_kyc: { tone: 'info', text: 'KYC pending' },
  under_review: { tone: 'warning', text: 'Under review' },
  approved: { tone: 'success', text: 'Approved' },
  suspended: { tone: 'warning', text: 'Suspended' },
  blocked: { tone: 'error', text: 'Blocked' },
  archived: { tone: 'neutral', text: 'Archived' },
};

export const VENDOR_KIND_LABEL: Record<VendorKind, string> = {
  company: 'Company',
  sole_proprietor: 'Sole proprietor',
  individual: 'Individual',
  foreign: 'Foreign vendor',
};

export interface VendorGrants {
  read: boolean;
  write: boolean;
  activate: boolean;
  propose: boolean;
  verify: boolean;
}

/**
 * The vendor permissions the person holds. Pass the live grants (`grantsFrom` over `getMeOrNull`), the saved
 * role rows the API enforces; role keys still read the built-in defaults for callers not yet moved.
 * Server-side only.
 */
export function vendorGrants(source: PermissionSource): VendorGrants {
  return {
    read: hasPermission(source, 'vendor.read'),
    write: hasPermission(source, 'vendor.write'),
    activate: hasPermission(source, 'vendor.activate'),
    propose: hasPermission(source, 'vendor.bank.propose'),
    verify: hasPermission(source, 'vendor.bank.verify'),
  };
}

/** A blocked or archived vendor takes no edits (the API answers 409 `vendor_not_editable`). */
export function isEditable(status: VendorStatus): boolean {
  return status !== 'blocked' && status !== 'archived';
}

/** Once approved, the legal name, PAN, kind and country change through a new KYB review, not an edit. */
export function identityLocked(status: VendorStatus): boolean {
  return status === 'approved' || status === 'suspended';
}

export type LifecycleCommand = 'submit_kyc' | 'activate' | 'suspend' | 'block' | 'archive';

export interface LifecycleOption {
  command: LifecycleCommand;
  label: string;
  /** What the button does, in a sentence under it. */
  help: string;
  /** Suspend, block and archive ask why; the audit trail keeps the answer. */
  needsReason: boolean;
  tone: 'primary' | 'secondary';
}

const SUBMIT_DRAFT: LifecycleOption = {
  command: 'submit_kyc',
  label: 'Start KYB review',
  help: 'Opens the KYB case, where the vendor documents are collected.',
  needsReason: false,
  tone: 'primary',
};
const SUBMIT_PENDING: LifecycleOption = {
  command: 'submit_kyc',
  label: 'Send for review',
  help: 'The KYB case is submitted. Someone with approval access then approves the vendor.',
  needsReason: false,
  tone: 'primary',
};
const ACTIVATE: LifecycleOption = {
  command: 'activate',
  label: 'Approve vendor',
  help: 'Needs an approved KYB case. The person who created the vendor cannot approve it.',
  needsReason: false,
  tone: 'primary',
};
const REINSTATE: LifecycleOption = {
  ...ACTIVATE,
  label: 'Reinstate vendor',
  help: 'Moves the vendor back to approved.',
};
const SUSPEND: LifecycleOption = {
  command: 'suspend',
  label: 'Suspend vendor',
  help: 'Pauses new purchases from this vendor. It can be reinstated.',
  needsReason: true,
  tone: 'secondary',
};
const BLOCK: LifecycleOption = {
  command: 'block',
  label: 'Block vendor',
  help: 'Stops all dealings. A blocked vendor can only be archived.',
  needsReason: true,
  tone: 'secondary',
};
const ARCHIVE: LifecycleOption = {
  command: 'archive',
  label: 'Archive vendor',
  help: 'Closes the record for good.',
  needsReason: true,
  tone: 'secondary',
};

/**
 * The lifecycle buttons for this status and these grants. `vendor.write` starts and sends the KYB
 * review; `vendor.activate` approves, suspends, blocks and archives (the API's own split).
 * "Send for review" also needs the KYB case submitted (`kybSubmitted`, read from the API's
 * review-readiness, the state the API checks); unknown counts as not submitted.
 */
export function lifecycleOptions(
  status: VendorStatus,
  can: {
    write: boolean;
    activate: boolean;
    suspend?: boolean;
    block?: boolean;
    archive?: boolean;
  },
  kybSubmitted?: boolean,
): LifecycleOption[] {
  switch (status) {
    case 'draft':
      return can.write ? [SUBMIT_DRAFT] : [];
    case 'pending_kyc':
      return can.write && kybSubmitted === true ? [SUBMIT_PENDING] : [];
    case 'under_review':
      return can.activate ? [ACTIVATE] : [];
    case 'approved': {
      const options: LifecycleOption[] = [];
      if (can.suspend ?? can.activate) options.push(SUSPEND);
      if (can.block ?? can.activate) options.push(BLOCK);
      return options;
    }
    case 'suspended': {
      const options: LifecycleOption[] = [];
      if (can.activate) options.push(REINSTATE);
      if (can.block ?? can.activate) options.push(BLOCK);
      return options;
    }
    case 'blocked':
      return (can.archive ?? can.activate) ? [ARCHIVE] : [];
    case 'archived':
      return [];
  }
}

/** The portal grant is for approved vendors and ones waiting for KYC (the API answers 409 otherwise). */
export function mayGrantPortal(status: VendorStatus, canWrite: boolean): boolean {
  return canWrite && (status === 'approved' || status === 'pending_kyc');
}

/**
 * Why a writer sees no "Send for review" on a pending_kyc vendor: the KYB case is not submitted
 * yet (`false`), or its state could not be read (`undefined`). Null when the button is there or
 * does not apply.
 */
export function sendForReviewHint(
  status: VendorStatus,
  canWrite: boolean,
  kybSubmitted: boolean | undefined,
): string | null {
  if (status !== 'pending_kyc' || !canWrite || kybSubmitted === true) return null;
  return kybSubmitted === false
    ? 'The vendor can be sent for review once its KYB case is submitted. Collect the vendor documents in the KYB case and submit it there.'
    : 'We could not check the KYB case, so the vendor cannot be sent for review from here right now. Reload the page to try again.';
}
