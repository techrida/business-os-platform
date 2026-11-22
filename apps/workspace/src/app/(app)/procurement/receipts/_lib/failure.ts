import { ErrorBodySchema, type ReceiptKind } from '@bos/contracts';

import { ApiError } from '@/lib/api';

import { failureWith, type ProcFailure } from '../../orders/_lib/failure-core';

/**
 * Words for every refusal the receipt screens can get, keyed on what the person was doing and, for
 * a 403, on the kind of receipt. The 422 codes are the receipts module's own (snake case); a 409
 * is `invalid_transition` when the receipt or the order moved on.
 */

export type ReceiptOp = 'load' | 'create' | 'confirm' | 'reverse' | 'discard';

/** The words for a 403 that names no better reason. Goods are the warehouse's; a service has two doors. */
export function noPermission(kind: ReceiptKind | undefined): string {
  if (kind === 'goods') {
    return 'Receiving goods is for the warehouse. Ask an administrator if you need that role.';
  }
  if (kind === 'service') {
    return 'A service can be confirmed by the person who raised the purchase request, or by the warehouse. Ask a colleague or an administrator if that is not you.';
  }
  return 'Your roles do not include receipts. They are for the warehouse, the procurement team and the person who raised the request.';
}

const MOVED: Record<ReceiptOp, string> = {
  discard:
    'This receipt can no longer be discarded. Only a draft can be. Reload to see where it stands.',
  load: 'This receipt changed since you opened it. Reload and try again.',
  create:
    'This purchase order is not open for receiving. It must be issued or partly received. If everything ordered has already arrived, ask Procurement to amend the purchase order first. Reload to see where it stands.',
  confirm:
    'This receipt can no longer be confirmed. It may already be confirmed, or the purchase order may be closed or waiting for an amendment. Reload to see where it stands.',
  reverse:
    'This receipt cannot be reversed. Only a confirmed receipt can be, a reversal cannot be reversed again, and the purchase order must still be open. Reload to see where it stands.',
};

/** After these the page is out of date: what is open has moved, so a reload beats a retry. */
const RELOAD_422 = new Set(['over_receipt', 'po_line_unknown']);

function codeOf(err: unknown): string | undefined {
  if (!(err instanceof ApiError)) return undefined;
  const parsed = ErrorBodySchema.safeParse(err.body);
  return parsed.success ? parsed.data.error.code : undefined;
}

export function receiptFailure(err: unknown, op: ReceiptOp, kind?: ReceiptKind): ProcFailure {
  const f = failureWith(err, {
    notFound:
      op === 'create'
        ? 'We could not find that purchase order. It may belong to another legal entity.'
        : op === 'load'
          ? 'We could not find that purchase order or receipt. It may belong to another legal entity.'
          : 'We could not find that receipt. It may belong to another legal entity.',
    noPermission: noPermission(kind),
    conflictFallback: MOVED[op],
    conflict: (code) =>
      code === 'invalid_transition' ? { message: MOVED[op], reload: true } : undefined,
    unprocessable: (code) => {
      switch (code) {
        case 'over_receipt':
          return 'More was entered than is still open on a line. A draft or another receipt may have used some of it since you opened this page. Reload to see what is left. To receive more than was ordered, ask Procurement to amend the purchase order first.';
        case 'RECEIPT_DATE_IN_FUTURE':
          return 'The receipt date is after today. Choose today or an earlier date.';
        case 'po_line_unknown':
          return 'A line in this form is no longer on the purchase order. Reload the page and start again.';
        case 'duplicate_po_line':
          return 'The same purchase order line appears twice in this receipt. Reload and try again.';
        case 'receipt_kind_mismatch':
          return 'A goods receipt takes only goods lines and a service confirmation only service lines. Check the kind you chose.';
        case 'serials_required':
          return 'A line that tracks serial numbers needs whole units and exactly one serial number for each.';
        case 'serials_not_allowed':
          return 'A line that does not track serial numbers cannot take any. Remove them and try again.';
        case 'serial_duplicate':
          return 'A serial number is there twice, or is already on another receipt. Check the numbers and try again.';
        default:
          return undefined;
      }
    },
  });
  return f.status === 422 && RELOAD_422.has(codeOf(err) ?? '') ? { ...f, reload: true } : f;
}
