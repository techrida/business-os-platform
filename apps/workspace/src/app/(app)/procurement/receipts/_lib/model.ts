import type { PoStatus, ReceiptKind, ReceiptStatus } from '@bos/contracts';

import { toScaled } from '../../orders/_lib/forms';
import { isReceivable, PO_READ_GRANTS, qtyText, type BadgeTone } from '../../orders/_lib/model';

/**
 * What the receipt screens show and offer. Pure. The API still decides every call (deny by
 * default); this only keeps buttons and choices away from people and statuses it would refuse.
 * Quantities are compared as scale-4 whole numbers and nothing is added or multiplied beyond the
 * one subtraction the line cap needs (open minus pending); the server owns every total.
 */

export const RECEIPT_STATUS_LABEL: Record<ReceiptStatus, { tone: BadgeTone; text: string }> = {
  draft: { tone: 'neutral', text: 'Draft' },
  discarded: { tone: 'neutral', text: 'Discarded' },
  confirmed: { tone: 'success', text: 'Confirmed' },
  reversed: { tone: 'warning', text: 'Reversed' },
};

export const KIND_LABEL: Record<ReceiptKind, string> = {
  goods: 'Goods receipt',
  service: 'Service confirmation',
};

/** The kind of an order in the receiving list: `mixed` when it has goods and service lines. */
export const WAITING_KIND_LABEL: Record<'goods' | 'service' | 'mixed', string> = {
  goods: 'Goods',
  service: 'Service',
  mixed: 'Mixed',
};

export interface ReceiptGrants {
  /** `procurement.receipt.confirm`: the warehouse, who receives goods. */
  confirm: boolean;
  /**
   * May open the purchase order itself: procurement, and read-only the warehouse and the bill roles (F1-Q52,
   * PO_READ_GRANTS).
   */
  openOrder: boolean;
}

/**
 * The live-grant predicate from `getPermissionCheck`. Role keys are not accepted: a grant changed in
 * Settings > Access must show here the way the API enforces it.
 */
export type ReceiptGrantSource = (permission: string) => boolean;

/** The permissions from live grants. Server-side only. */
export function receiptGrants(source: ReceiptGrantSource): ReceiptGrants {
  return {
    confirm: source('procurement.receipt.confirm'),
    openOrder: PO_READ_GRANTS.some((g) => source(g)),
  };
}

/**
 * Goods need the warehouse grant. A service receipt may also be made or confirmed by the person
 * who raised the purchase request, which the screen cannot know, so it is offered to every staff
 * user and the API's 403 is worded for it.
 */
export function mayHandleKind(kind: ReceiptKind, grants: { confirm: boolean }): boolean {
  return kind === 'service' || grants.confirm;
}

/** The PO statuses a draft can be confirmed in, and those a confirmed receipt can be reversed in. */
const REVERSIBLE: readonly PoStatus[] = ['issued', 'partially_received', 'fully_received'];

export interface ReceiptActions {
  confirm: boolean;
  discard: boolean;
  reverse: boolean;
}

/**
 * Confirm a draft; discard a draft; reverse a confirmed receipt that is not itself a reversal. The receipt's own
 * `can` flags decide when the API sent them (the detail and list reads: the person's live grants on this order and
 * the statuses each command needs), so a read-only buyer sees none, a service included. Without them the screen
 * guesses from the grants; when the order's status is known and no longer allows it, the button goes away.
 */
export function receiptActions(
  receipt: {
    status: ReceiptStatus;
    kind: ReceiptKind;
    reversesReceiptId: string | null;
    can?: ReceiptActions | undefined;
  },
  grants: { confirm: boolean },
  poStatus?: PoStatus,
): ReceiptActions {
  if (receipt.can !== undefined) {
    const { confirm, discard, reverse } = receipt.can;
    return { confirm, discard, reverse };
  }
  const may = mayHandleKind(receipt.kind, grants);
  return {
    confirm:
      may && receipt.status === 'draft' && (poStatus === undefined || isReceivable(poStatus)),
    discard: may && receipt.status === 'draft',
    reverse:
      may &&
      receipt.status === 'confirmed' &&
      receipt.reversesReceiptId === null &&
      (poStatus === undefined || REVERSIBLE.includes(poStatus)),
  };
}

/** A quantity from the server as scale-4 whole units, with an optional minus sign; null if it is not one. */
export function signedScaled(value: string): bigint | null {
  const text = value.trim();
  if (text.startsWith('-')) {
    const unsigned = toScaled(text.slice(1), 4);
    return unsigned === null ? null : -unsigned;
  }
  return toScaled(text, 4);
}

/** Scale-4 whole units back to the server's text: `50000n` is `5.0000`. */
export function scaledText(value: bigint): string {
  const negative = value < 0n;
  const digits = (negative ? -value : value).toString().padStart(5, '0');
  return `${negative ? '-' : ''}${digits.slice(0, -4)}.${digits.slice(-4)}`;
}

export interface CapSource {
  openQuantity: string;
  pendingQuantity: string;
}

/**
 * How much a new receipt may take on one PO line: still open minus what draft receipts already
 * reserve, never below zero. The open quantity can be negative after an over-receipt exception and
 * a value that does not read as a quantity counts as nothing, so the form errs on the side of "no".
 */
export function lineCap(line: CapSource): bigint {
  const open = signedScaled(line.openQuantity) ?? 0n;
  const pending = signedScaled(line.pendingQuantity) ?? 0n;
  const cap = open - pending;
  return cap > 0n ? cap : 0n;
}

/** The cap for people: `5.0000` shown as `5`. */
export function capText(line: CapSource): string {
  return qtyText(scaledText(lineCap(line)));
}

/**
 * The kinds a person can start a receipt for: lines with room left, and kinds they may handle. `allowed` is the
 * order's own answer (the progress read's `can`, from the person's live grants on this order); without it the screen
 * guesses from the grants as mayHandleKind does.
 */
export function kindsOffered(
  lines: readonly (CapSource & { kind: ReceiptKind })[],
  grants: { confirm: boolean },
  allowed?: { goods: boolean; service: boolean },
): ReceiptKind[] {
  const kinds: ReceiptKind[] = [];
  for (const kind of ['goods', 'service'] as const) {
    if (!(allowed !== undefined ? allowed[kind] : mayHandleKind(kind, grants))) continue;
    if (lines.some((l) => l.kind === kind && lineCap(l) > 0n)) kinds.push(kind);
  }
  return kinds;
}
