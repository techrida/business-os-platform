// Pure rules of goods and service receipts (P4 unit P4r): what a draft may take in, serial counts, the PO status that
// follows from what was received, the lines of a reversal and the progress rows. No I/O, so every rule is cheap to
// table-test. Serves the NFRs "amounts are exact" (decimal.js on numeric(18,4) strings, never JS numbers) and
// "no gaps in a numbered series" (the GRN number is the service's, taken last).
import {
  ConfirmReceiptBodySchema,
  type ConfirmReceiptBody,
  type PoStatus,
  type ReceiptKind,
} from '@bos/contracts';
import type { receiptLines, receipts, receiptSerials } from '@bos/db';
import Decimal from 'decimal.js';
import { z } from 'zod';

/** The numbering series key. Its prefix is `GRN`, as in GRN-2082/83-00001. */
export const RECEIPT_SERIES = 'GRN';

/** The audit entity type of the module's domain events. */
export const RECEIPT_AUDIT_ENTITY = 'receipts';

/** A PO takes new receipts only in these statuses. */
export const RECEIVING_PO_STATUSES: readonly PoStatus[] = ['issued', 'partially_received'];

/**
 * The PO statuses that follow the quantities received. Within these the service derives the status instead of
 * walking PO_TRANSITIONS (a reversal moves fully_received -> partially_received -> issued, which the table now
 * allows, but the status is what the quantities say, not a step). Any other status (amendment_pending, closed,
 * short_closed, cancelled) is not touched.
 */
export const RECEIPT_DERIVED_PO_STATUSES: readonly PoStatus[] = [
  'issued',
  'partially_received',
  'fully_received',
];

/** Machine-readable causes of a 422 from this module (the HTTP filter's whitelist is the lead's wiring). */
export const RECEIPT_ERROR_CODES = [
  'over_receipt',
  'over_receipt_exception_unknown',
  'po_line_unknown',
  'duplicate_po_line',
  'receipt_kind_mismatch',
  'serials_required',
  'serials_not_allowed',
  'serial_duplicate',
] as const;
export type ReceiptErrorCode = (typeof RECEIPT_ERROR_CODES)[number];

export interface ReceiptViolation {
  code: ReceiptErrorCode;
  message: string;
}
const violation = (code: ReceiptErrorCode, message: string): ReceiptViolation => ({
  code,
  message,
});

// ------------------------------------------------------------------------------------------------- body

/**
 * The create body is the contract's confirm body: one PO, kind, date, and lines with serials and an optional
 * `overReceiptExceptionId`. There is no exceptions table yet, so only null is accepted (validateDraftLines answers
 * 422 `over_receipt_exception_unknown` for an id). Still strict.
 */
export const CreateReceiptBodySchema = ConfirmReceiptBodySchema;
export type CreateReceiptBody = ConfirmReceiptBody;

export const ListReceiptsQuerySchema = z.strictObject({ purchaseOrderId: z.guid() });
export type ListReceiptsQuery = z.infer<typeof ListReceiptsQuerySchema>;

// ------------------------------------------------------------------------------------------------- facts

/** The fields of a PO line the rules read. Quantities are numeric(18,4) strings. */
export interface PoLineFacts {
  id: string;
  lineNo: number;
  kind: ReceiptKind;
  description: string;
  uom: string;
  orderedQuantity: string;
  cancelledQuantity: string;
  requiresSerials: boolean;
}

/** Quantities on one PO line: non-discarded lines (`net`, what the DB guard sums), confirmed ones and drafts. */
export interface LineQuantities {
  net: string;
  confirmed: string;
  draft: string;
}

const qty = (value: string | number | Decimal) => new Decimal(value).toFixed(4);

/** What a PO line has room for: ordered - cancelled - net received (drafts reserve their quantity). */
export function openQuantity(line: PoLineFacts, net: string | undefined): Decimal {
  return new Decimal(line.orderedQuantity).minus(line.cancelledQuantity).minus(net ?? 0);
}

// ------------------------------------------------------------------------------------------------- serials

/**
 * The serials rule of one line: a line that requires serials takes a whole number of units and exactly as many
 * serials; a line that does not, takes none. `quantity` is the line's quantity, `serialNos` the serials on it.
 */
export function serialViolation(
  requiresSerials: boolean,
  quantity: string,
  serialCount: number,
  serialNos: readonly string[] = [],
): ReceiptViolation | null {
  const q = new Decimal(quantity);
  if (!requiresSerials) {
    return serialCount > 0
      ? violation('serials_not_allowed', 'This line does not take serial numbers')
      : null;
  }
  if (!q.isInteger() || serialCount !== q.toNumber()) {
    return violation(
      'serials_required',
      `This line needs one serial number for each of its ${q.toFixed()} unit(s) (whole units), got ${serialCount}`,
    );
  }
  if (new Set(serialNos).size !== serialNos.length) {
    return violation('serial_duplicate', 'A serial number appears twice on this line');
  }
  return null;
}

// ------------------------------------------------------------------------------------------------- draft

/**
 * The first rule a draft's lines break, or null. `poLines` are the PO's own lines (so a line of another PO is
 * unknown), `netByLine` the net quantity every receipt line already took, by PO line id (a missing id is zero).
 * Run after the PO and its lines are locked, so nobody else changes what is open meanwhile.
 */
export function validateDraftLines(
  kind: ReceiptKind,
  lines: CreateReceiptBody['lines'],
  poLines: ReadonlyMap<string, PoLineFacts>,
  netByLine: ReadonlyMap<string, string>,
): ReceiptViolation | null {
  const seen = new Set<string>();
  for (const l of lines) {
    const po = poLines.get(l.poLineId);
    if (po === undefined) {
      return violation(
        'po_line_unknown',
        `PO line ${l.poLineId} is not a line of this purchase order`,
      );
    }
    if (seen.has(l.poLineId)) {
      return violation('duplicate_po_line', `PO line ${po.lineNo} appears twice in this receipt`);
    }
    seen.add(l.poLineId);
    if (po.kind !== kind) {
      return violation(
        'receipt_kind_mismatch',
        `PO line ${po.lineNo} is a ${po.kind} line; a ${kind} receipt cannot take it`,
      );
    }
    if (l.overReceiptExceptionId !== undefined && l.overReceiptExceptionId !== null) {
      return violation(
        'over_receipt_exception_unknown',
        'There are no over-receipt exceptions yet, so overReceiptExceptionId must be null',
      );
    }
    const open = openQuantity(po, netByLine.get(po.id));
    if (new Decimal(l.quantity).greaterThan(open)) {
      return violation(
        'over_receipt',
        `PO line ${po.lineNo}: receiving ${qty(l.quantity)} is more than the ${qty(Decimal.max(open, 0))} still open`,
      );
    }
    const serials = l.serials ?? [];
    const bad = serialViolation(
      po.requiresSerials,
      l.quantity,
      serials.length,
      serials.map((s) => s.serialNo),
    );
    if (bad !== null) return { ...bad, message: `PO line ${po.lineNo}: ${bad.message}` };
  }
  return null;
}

// ------------------------------------------------------------------------------------------------- PO status

export interface ReceivedRow {
  orderedQuantity: string;
  cancelledQuantity: string;
  /** Net of confirmed and reversed receipts (a reversed receipt nets to zero against its reversal). */
  receivedQuantity: string;
}

/**
 * The PO status the received quantities give: issued while nothing is, partially_received once anything is,
 * fully_received when every line has received at least what is left after cancellations.
 */
export function derivePoStatus(rows: readonly ReceivedRow[]): PoStatus {
  const anything = rows.some((r) => new Decimal(r.receivedQuantity).greaterThan(0));
  if (!anything) return 'issued';
  const covered = rows.every((r) =>
    new Decimal(r.receivedQuantity).greaterThanOrEqualTo(
      new Decimal(r.orderedQuantity).minus(r.cancelledQuantity),
    ),
  );
  return covered ? 'fully_received' : 'partially_received';
}

// ------------------------------------------------------------------------------------------------- reversal

/** The lines of a reversal: each original line negated in full, naming the line it reverses (AD16). */
export function reversalLinesOf(
  originals: readonly { id: string; lineNo: number; poLineId: string; quantity: string }[],
): { lineNo: number; poLineId: string; quantity: string; reversesReceiptLineId: string }[] {
  return originals.map((o) => ({
    lineNo: o.lineNo,
    poLineId: o.poLineId,
    quantity: qty(new Decimal(o.quantity).negated()),
    reversesReceiptLineId: o.id,
  }));
}

// ------------------------------------------------------------------------------------------------- progress

export interface PoProgressLine {
  poLineId: string;
  lineNo: number;
  kind: ReceiptKind;
  description: string;
  uom: string;
  requiresSerials: boolean;
  orderedQuantity: string;
  cancelledQuantity: string;
  /** Confirmed receipts net of reversals. */
  receivedQuantity: string;
  /** Taken by drafts that are not confirmed yet. */
  pendingQuantity: string;
  /** ordered - cancelled - received. Can be negative after an over-receipt exception. */
  openQuantity: string;
  /** Always 0.0000 until vendor bills exist (P4 unit A1). */
  billedQuantity: string;
}

export interface PoProgress {
  purchaseOrderId: string;
  vendorId: string;
  vendorName: string;
  number: string;
  status: PoStatus;
  lines: PoProgressLine[];
}

export function progressRowsOf(
  poLines: readonly PoLineFacts[],
  quantities: ReadonlyMap<string, LineQuantities>,
): PoProgressLine[] {
  return [...poLines]
    .sort((a, b) => a.lineNo - b.lineNo)
    .map((l) => {
      const q = quantities.get(l.id);
      const received = new Decimal(q?.confirmed ?? 0);
      return {
        poLineId: l.id,
        lineNo: l.lineNo,
        kind: l.kind,
        description: l.description,
        uom: l.uom,
        requiresSerials: l.requiresSerials,
        orderedQuantity: qty(l.orderedQuantity),
        cancelledQuantity: qty(l.cancelledQuantity),
        receivedQuantity: qty(received),
        pendingQuantity: qty(q?.draft ?? 0),
        openQuantity: qty(
          new Decimal(l.orderedQuantity).minus(l.cancelledQuantity).minus(received),
        ),
        billedQuantity: qty(0),
      };
    });
}

// ------------------------------------------------------------------------------------------------- DTOs

export type ReceiptRow = typeof receipts.$inferSelect;
export type ReceiptLineRow = typeof receiptLines.$inferSelect;
export type ReceiptSerialRow = typeof receiptSerials.$inferSelect;

export interface ReceiptLineDto {
  id: string;
  lineNo: number;
  poLineId: string;
  quantity: string;
  reversesReceiptLineId: string | null;
  inspection: string | null;
  discrepancyNote: string | null;
  overReceiptExceptionId: string | null;
  serials: { serialNo: string; batchNo: string | null; warrantyUntil: string | null }[];
}

export interface ReceiptDto {
  id: string;
  number: string;
  purchaseOrderId: string;
  kind: ReceiptKind;
  receivedAt: string;
  location: string | null;
  status: 'draft' | 'confirmed' | 'reversed' | 'discarded';
  createdBy: string;
  confirmedBy: string | null;
  confirmedAt: string | null;
  reversesReceiptId: string | null;
  reversalReason: string | null;
  version: number;
  createdAt: string;
  lines: ReceiptLineDto[];
}

export function toReceiptDto(
  row: ReceiptRow,
  lines: readonly ReceiptLineRow[],
  serials: readonly ReceiptSerialRow[],
): ReceiptDto {
  return {
    id: row.id,
    number: row.number,
    purchaseOrderId: row.purchaseOrderId,
    kind: row.kind,
    receivedAt: row.receivedAt,
    location: row.location,
    status: row.status,
    createdBy: row.createdBy,
    confirmedBy: row.confirmedBy,
    confirmedAt: row.confirmedAt?.toISOString() ?? null,
    reversesReceiptId: row.reversesReceiptId,
    reversalReason: row.reversalReason,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    lines: [...lines]
      .sort((a, b) => a.lineNo - b.lineNo)
      .map((l) => ({
        id: l.id,
        lineNo: l.lineNo,
        poLineId: l.poLineId,
        quantity: l.quantity,
        reversesReceiptLineId: l.reversesReceiptLineId,
        inspection: l.inspection,
        discrepancyNote: l.discrepancyNote,
        overReceiptExceptionId: l.overReceiptExceptionId,
        serials: serials
          .filter((s) => s.receiptLineId === l.id)
          .map((s) => ({
            serialNo: s.serialNo,
            batchNo: s.batchNo,
            warrantyUntil: s.warrantyUntil,
          })),
      })),
  };
}
