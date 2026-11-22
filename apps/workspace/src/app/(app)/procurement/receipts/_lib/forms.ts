import {
  decimalPattern,
  QUANTITY_LIMITS,
  ReceiptKindSchema,
  type ConfirmReceiptBody,
  type ReceiptKind,
} from '@bos/contracts';
import { NO_SPACES, postedAmount } from '@bos/locale';

import { toScaled, type Errors } from '../../orders/_lib/forms';

import { capText, lineCap } from './model';

/**
 * Checks of the new-receipt form, before anything is sent. Pure. Quantities are scale-4 whole
 * numbers, never floats. The API checks again and has the last word: this only saves the person a
 * round trip. A line left empty is not part of the receipt.
 */

export const MAX_SERIALS = 1000;

export interface LineValues {
  quantity: string;
  /** One serial number per line of text. */
  serials: string;
  inspection: string;
  note: string;
}

export const EMPTY_LINE: LineValues = { quantity: '', serials: '', inspection: '', note: '' };

export interface ReceiptValues {
  kind: string;
  receivedAt: string;
  location: string;
  lines: Record<string, LineValues>;
}

/** What the form needs to know about each purchase order line (from the progress route). */
export interface CapLine {
  poLineId: string;
  lineNo: number;
  kind: ReceiptKind;
  uom: string;
  requiresSerials: boolean;
  openQuantity: string;
  pendingQuantity: string;
}

/** Serial numbers typed one per line; blank lines and spaces around a number do not count. */
export function splitSerials(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

function isRealDate(value: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (m === null) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d;
}

/** The contract's quantity shape: up to 14 whole digits and 4 decimals. */
const QUANTITY_SHAPE = decimalPattern(QUANTITY_LIMITS);

export function parseReceipt(
  purchaseOrderId: string,
  values: ReceiptValues,
  lines: readonly CapLine[],
): { ok: true; body: ConfirmReceiptBody } | { ok: false; errors: Errors } {
  const errors: Errors = {};

  const kind = ReceiptKindSchema.safeParse(values.kind);
  if (!kind.success) errors['kind'] = 'Choose whether this is goods or a service.';

  const receivedAt = values.receivedAt.trim();
  if (!isRealDate(receivedAt)) errors['receivedAt'] = 'Use a real date, such as 2026-11-09.';

  const location = values.location.trim();
  if (location.length > 200) errors['location'] = 'Keep the location under 200 characters.';

  const out: ConfirmReceiptBody['lines'] = [];
  if (kind.success) {
    for (const line of lines) {
      if (line.kind !== kind.data) continue;
      const v = values.lines[line.poLineId];
      if (v === undefined) continue;
      const key = (field: string): string => `${line.poLineId}.${field}`;
      const quantity = postedAmount(v.quantity);
      const serialNos = splitSerials(v.serials);

      if (quantity === '') {
        if (serialNos.length > 0) {
          errors[key('quantity')] =
            'Enter the quantity these serial numbers belong to, or clear them.';
        }
        continue;
      }

      if (/\s/.test(quantity)) {
        errors[key('quantity')] = NO_SPACES;
        continue;
      }
      const q = QUANTITY_SHAPE.test(quantity) ? toScaled(quantity, QUANTITY_LIMITS.scale) : null;
      if (q === null) {
        errors[key('quantity')] = 'Use a number with up to 4 decimal places.';
        continue;
      }
      if (q === 0n) {
        errors[key('quantity')] = 'Enter more than zero, or leave the line empty to skip it.';
        continue;
      }
      const cap = lineCap(line);
      if (cap === 0n) {
        errors[key('quantity')] =
          'Nothing is left to receive on this line. Receipts and drafts already cover what was ordered.';
        continue;
      }
      if (q > cap) {
        errors[key('quantity')] =
          `Only ${capText(line)} ${line.uom} can still be received on this line. Receipts and drafts already cover the rest.`;
        continue;
      }

      let serialsOk = true;
      if (line.requiresSerials) {
        if (q % 10000n !== 0n) {
          errors[key('quantity')] = 'This item tracks serial numbers, so receive whole units.';
          continue;
        }
        const units = q / 10000n;
        if (units > BigInt(MAX_SERIALS)) {
          errors[key('quantity')] =
            `Receive at most ${MAX_SERIALS} units of a serial-tracked item in one receipt.`;
          continue;
        }
        if (serialNos.length !== Number(units)) {
          errors[key('serials')] =
            `Enter ${units} serial number${units === 1n ? '' : 's'}, one per line. You entered ${serialNos.length}.`;
          serialsOk = false;
        } else if (serialNos.some((s) => s.length > 100)) {
          errors[key('serials')] = 'A serial number can be at most 100 characters.';
          serialsOk = false;
        } else {
          const seen = new Set<string>();
          const twice = serialNos.find((s) => (seen.has(s) ? true : (seen.add(s), false)));
          if (twice !== undefined) {
            errors[key('serials')] =
              `Serial numbers must all be different. "${twice}" is there twice.`;
            serialsOk = false;
          }
        }
      } else if (serialNos.length > 0) {
        errors[key('serials')] = 'This item does not take serial numbers. Clear them.';
        serialsOk = false;
      }

      const inspection = v.inspection.trim();
      const note = v.note.trim();
      if (inspection.length > 500) {
        errors[key('inspection')] = 'Keep the inspection result under 500 characters.';
        serialsOk = false;
      }
      if (note.length > 1000) {
        errors[key('note')] = 'Keep the discrepancy note under 1000 characters.';
        serialsOk = false;
      }
      if (!serialsOk) continue;

      out.push({
        poLineId: line.poLineId,
        quantity,
        ...(line.requiresSerials ? { serials: serialNos.map((serialNo) => ({ serialNo })) } : {}),
        ...(inspection !== '' ? { inspection } : {}),
        ...(note !== '' ? { discrepancyNote: note } : {}),
      });
    }
  }

  if (Object.keys(errors).length === 0 && out.length === 0) {
    errors['lines'] = 'Enter a quantity on at least one line.';
  }
  if (Object.keys(errors).length > 0 || !kind.success) return { ok: false, errors };
  return {
    ok: true,
    body: {
      purchaseOrderId,
      kind: kind.data,
      receivedAt,
      ...(location !== '' ? { location } : {}),
      lines: out,
    },
  };
}
