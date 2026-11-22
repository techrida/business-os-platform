import type { AmendPurchaseOrderBody } from '@bos/contracts';
import { NO_SPACES } from '@bos/locale';

import { storedNumberText } from '../../_lib/stored-number';

/**
 * Checks of the purchase order forms, before anything is sent. Pure. Amounts are compared as scaled
 * whole numbers (`1100.5` is `110050` at scale 2), never as floats, and nothing is added or
 * multiplied: the server owns every total. The API checks again and has the last word.
 */

export type Errors = Record<string, string>;
export type Parsed<T> = { ok: true; data: T } | { ok: false; error: string };

/** `12.5` at scale 2 is `1250n`; null when it is not a plain non-negative decimal with that many places. */
export function toScaled(value: string, scale: number): bigint | null {
  const m = new RegExp(`^(\\d{1,16})(?:\\.(\\d{1,${scale}}))?$`).exec(value.trim());
  if (m === null) return null;
  return BigInt(`${m[1] ?? '0'}${(m[2] ?? '').padEnd(scale, '0')}`);
}

/** A number typed with a space inside (`10 50`), which toScaled refuses: the fix is to remove the space. */
const SPACED = /\S\s+\S/;

export function parseReason(raw: string, max = 500): Parsed<string> {
  const reason = raw.trim();
  if (reason === '') return { ok: false, error: 'Say why. The audit trail keeps the answer.' };
  if (reason.length > max) return { ok: false, error: `Keep the reason under ${max} characters.` };
  return { ok: true, data: reason };
}

export interface AmendValues {
  reason: string;
  paymentTermsDays: string;
  lines: Record<string, { quantity: string; unitPrice: string }>;
}

export interface CurrentLine {
  id: string;
  orderedQuantity: string;
  unitPrice: string;
}

/**
 * The amend body: only the lines whose quantity or price really changed, the terms only when they
 * changed, and a reason. A change of the payment terms alone is an amendment too (F1-Q40). Nothing
 * changed is refused here, because the API refuses it too.
 */
export function parseAmend(
  values: AmendValues,
  current: readonly CurrentLine[],
  currentTerms: number,
): { ok: true; body: AmendPurchaseOrderBody } | { ok: false; errors: Errors } {
  const errors: Errors = {};
  const reason = parseReason(values.reason, 1000);
  if (!reason.ok) errors['reason'] = reason.error;

  const lines: NonNullable<AmendPurchaseOrderBody['lines']> = [];
  for (const line of current) {
    const v = values.lines[line.id];
    if (v === undefined) continue;
    const quantity = v.quantity.trim();
    const unitPrice = v.unitPrice.trim();
    const q = toScaled(quantity, 4);
    const p = toScaled(unitPrice, 2);
    let bad = false;
    if (q === null) {
      errors[`${line.id}.quantity`] = SPACED.test(quantity)
        ? NO_SPACES
        : 'Use a number with up to 4 decimal places.';
      bad = true;
    } else if (q === 0n) {
      errors[`${line.id}.quantity`] = 'The quantity must be above zero.';
      bad = true;
    }
    if (p === null) {
      errors[`${line.id}.unitPrice`] = SPACED.test(unitPrice)
        ? NO_SPACES
        : 'Use an amount such as 1250.50, with up to 2 decimal places.';
      bad = true;
    }
    if (bad || q === null || p === null) continue;
    const qChanged = q !== toScaled(storedNumberText(line.orderedQuantity, 4), 4);
    const pChanged = p !== toScaled(storedNumberText(line.unitPrice, 2), 2);
    if (qChanged || pChanged) {
      lines.push({
        poLineId: line.id,
        ...(qChanged ? { quantity } : {}),
        ...(pChanged ? { unitPrice } : {}),
      });
    }
  }

  let terms: number | undefined;
  const termsText = values.paymentTermsDays.trim();
  if (termsText !== '') {
    if (!/^\d{1,3}$/.test(termsText) || Number(termsText) > 365) {
      errors['paymentTermsDays'] = SPACED.test(termsText)
        ? NO_SPACES
        : 'Use a whole number of days from 0 to 365.';
    } else if (Number(termsText) !== currentTerms) {
      terms = Number(termsText);
    }
  }

  if (Object.keys(errors).length === 0 && lines.length === 0 && terms === undefined) {
    errors['lines'] = 'Change a quantity, a price or the payment terms.';
  }
  if (Object.keys(errors).length > 0 || !reason.ok) return { ok: false, errors };
  return {
    ok: true,
    body: {
      reason: reason.data,
      ...(terms !== undefined ? { paymentTermsDays: terms } : {}),
      lines,
    },
  };
}
