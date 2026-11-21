import { failureWith, type ProcFailure } from './failure-core';

/**
 * Words for every refusal the purchase order screens can get, keyed on what the person was
 * doing. The codes are the API's own: upper case for orders (`VENDOR_NOT_APPROVED`,
 * `PO_HAS_RECEIPTS`, `PO_AMENDMENT_INVALID`), `invalid_transition` for a status that moved on.
 */

export type PoOp =
  'load' | 'issue' | 'amend' | 'shortClose' | 'cancel' | 'document' | 'changeVendor' | 'recreate';

/** The API's own refusal of a vendor change on an order that is no longer a draft, word for word. */
export const VENDOR_CHANGE_NOT_DRAFT = 'Cancel this order and create a new one';

const MOVED = "This purchase order's status does not allow that. Reload to see where it stands.";

const DRAFT_RECEIPT_HINT =
  "This purchase order can't be closed right now. It may have changed, or a draft receipt may still be open on it. Confirm or discard the draft receipt from its detail page, reload, and try again.";

const CONFLICT_FALLBACK: Record<PoOp, string> = {
  load: 'This purchase order changed since you opened it. Reload and try again.',
  issue: 'This purchase order changed since you opened it. Reload and try again.',
  amend: 'This purchase order changed since you opened it. Reload and try again.',
  document: 'This purchase order changed since you opened it. Reload and try again.',
  shortClose: DRAFT_RECEIPT_HINT,
  cancel: DRAFT_RECEIPT_HINT,
  changeVendor: 'This purchase order changed since you opened it. Reload and try again.',
  recreate: DRAFT_RECEIPT_HINT,
};

export function poFailure(err: unknown, op: PoOp): ProcFailure {
  return failureWith(err, {
    notFound:
      op === 'document'
        ? 'This PDF is not available. It may still be preparing or scanning.'
        : 'We could not find that purchase order. It may belong to another legal entity.',
    noPermission: 'Your roles do not allow this. Ask an administrator if you need it.',
    conflictFallback: CONFLICT_FALLBACK[op],
    conflict: (code) => {
      const moving = op === 'changeVendor';
      switch (code) {
        case 'VENDOR_NOT_APPROVED':
          return {
            message: moving
              ? "This vendor is not approved, so the order cannot move to it. Choose an approved vendor, or finish the vendor's KYB review and approval first."
              : "This vendor is not approved, so no purchase order can be issued to it. Finish the vendor's KYB review and approval first.",
            reload: false,
          };
        case 'VENDOR_NOT_IN_ENTITY':
          return {
            message: moving
              ? 'This vendor has no active account with your legal entity. Choose another vendor, or add or reactivate its terms on the vendor page.'
              : 'This vendor has no active account with your legal entity. Add or reactivate its terms on the vendor page, then try again.',
            reload: false,
          };
        // The vendor-change codes are worded only for a vendor change; any other op keeps its fallback.
        case 'VENDOR_NO_VERIFIED_BANK_ACCOUNT':
          return moving
            ? {
                message:
                  'This vendor has no verified bank account. Choose another vendor, or verify a bank account on the vendor page first.',
                reload: false,
              }
            : undefined;
        case 'PO_VENDOR_UNCHANGED':
          return moving
            ? {
                message: 'The purchase order already has this vendor. Choose a different one.',
                reload: false,
              }
            : undefined;
        case 'PO_VENDOR_CHANGE_NOT_DRAFT':
          return moving ? { message: VENDOR_CHANGE_NOT_DRAFT, reload: true } : undefined;
        case 'PO_REFERENCED':
          return moving
            ? {
                message:
                  'Payment requests or bills already refer to this order, so its vendor cannot be changed.',
                reload: false,
              }
            : undefined;
        case 'PO_HAS_NO_LINES':
          return {
            message:
              'This purchase order has no lines. It needs at least one line before it can be issued.',
            reload: false,
          };
        case 'PO_HAS_RECEIPTS':
          return {
            message:
              op === 'recreate'
                ? 'A draft receipt may still be open, or goods or services have already been received on this order, so it cannot be cancelled and raised again. Discard draft receipts from their detail pages and try again. If a receipt was confirmed, amend or short-close the order instead.'
                : 'A draft receipt may still be open, or goods or services have already been received on this order. Discard draft receipts from their detail pages and try cancelling again. If a receipt was confirmed and the rest will not arrive, short-close the order instead.',
            reload: false,
          };
        // The issue guard: the order was edited after this page showed it, so what would be issued is not what the
        // person reviewed.
        case 'PO_CHANGED':
          return op === 'issue' ? { message: CONFLICT_FALLBACK.issue, reload: true } : undefined;
        case 'invalid_transition':
          return { message: MOVED, reload: true };
        default:
          return undefined;
      }
    },
    unprocessable: (code) => {
      switch (code) {
        case 'PO_AMENDMENT_INVALID':
          return 'The platform refused these changes. A line cannot be ordered below what has been received plus cancelled, a changed line must really change, and each line can be changed once.';
        case 'NO_ELIGIBLE_APPROVER':
          return 'These changes need approval, but nobody can approve them right now. Nothing was changed. Ask an administrator to check the approvers for purchase order changes.';
        default:
          return undefined;
      }
    },
  });
}
