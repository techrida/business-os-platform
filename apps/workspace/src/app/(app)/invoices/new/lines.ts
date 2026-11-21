import {
  MONEY_LIMITS,
  QUANTITY_LIMITS,
  decimalPattern,
  type InvoiceLineInput,
} from '@bos/contracts';
import { NO_SPACES, USE_A_POINT, hasInnerSpace, hasStrayComma, plainAmount } from '@bos/locale';

// The line model and the rules around it, shared by the manual invoice, the debit note and the
// credit note. No React and no server imports, so the client form, the server actions and the tests
// use one definition. Nothing here computes money: a line says what, how many and at what price, and
// the server works out every amount, tax and total.

export const MAX_LINES = 200;
const DESCRIPTION_MAX = 500;
const UOM_MAX = 20;

/** Field errors keyed by field name: `reason`, `lines`, `lines.<index>.quantity`. */
export type FieldErrors = Record<string, string>;

export type Parsed<T> = { ok: true; data: T } | { ok: false; errors: FieldErrors };

/** A line as the person typed it. `key` is local identity for React and is never sent. */
export interface LineValues {
  key: string;
  description: string;
  uom: string;
  quantity: string;
  unitPrice: string;
  taxCodeId: string;
}

export const newLine = (key: string): LineValues => ({
  key,
  description: '',
  uom: '',
  quantity: '1',
  unitPrice: '',
  taxCodeId: '',
});

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isGuid = (value: string): boolean => GUID.test(value);

/**
 * People type 12,50,000.00 in Nepal; the contract wants plain digits, so drop the grouping. A comma that is not
 * grouping ("1,5", "10,50") stays, fails the check below and is named in the error: it is never read as 15 or 1050.
 */
export const plainNumber = plainAmount;

/**
 * The field's words, or what went wrong when it is a typing slip: a space inside the number
 * ("10 50" is never read as 1050) or a decimal comma.
 */
const withPointHint = (words: string, raw: string): string => {
  if (hasInnerSpace(raw)) return NO_SPACES;
  return hasStrayComma(raw) ? `${USE_A_POINT} ${words}` : words;
};

const QUANTITY = decimalPattern(QUANTITY_LIMITS);
const PRICE = decimalPattern(MONEY_LIMITS);
const aboveZero = (s: string): boolean => /[1-9]/.test(s);

const QUANTITY_WORDS = 'Enter a quantity above zero, such as 2 or 1.5. Up to 4 decimals.';

/** Checks every line and returns the body lines, or one sentence per wrong field. */
export function parseLines(lines: readonly LineValues[]): Parsed<InvoiceLineInput[]> {
  const errors: FieldErrors = {};
  if (lines.length === 0) return { ok: false, errors: { lines: 'Add at least one line.' } };
  if (lines.length > MAX_LINES) {
    return { ok: false, errors: { lines: `An invoice holds up to ${MAX_LINES} lines.` } };
  }
  const data: InvoiceLineInput[] = [];
  lines.forEach((line, i) => {
    const at = (field: string, words: string): void => {
      errors[`lines.${i}.${field}`] = words;
    };
    const description = line.description.trim();
    const uom = line.uom.trim();
    const quantity = plainNumber(line.quantity);
    const unitPrice = plainNumber(line.unitPrice);
    if (description === '') at('description', 'Describe what is being charged.');
    else if (description.length > DESCRIPTION_MAX) {
      at('description', `Keep the description under ${DESCRIPTION_MAX} characters.`);
    }
    if (uom === '') at('uom', 'Enter the unit, such as pcs or hrs.');
    else if (uom.length > UOM_MAX) at('uom', `Keep the unit under ${UOM_MAX} characters.`);
    if (!QUANTITY.test(quantity) || !aboveZero(quantity)) {
      at('quantity', withPointHint(QUANTITY_WORDS, line.quantity));
    }
    if (!PRICE.test(unitPrice)) {
      at(
        'unitPrice',
        withPointHint(
          'Enter the price per unit, such as 1,500.00. Up to 2 decimals, not negative.',
          line.unitPrice,
        ),
      );
    }
    if (!isGuid(line.taxCodeId)) at('taxCodeId', 'Choose a tax code.');
    data.push({ description, uom, quantity, unitPrice, taxCodeId: line.taxCodeId });
  });
  return Object.keys(errors).length > 0 ? { ok: false, errors } : { ok: true, data };
}

const LIST_LIMIT = 1000;

/** The `lines` field a form posts: a list of objects with text fields. Anything else is null. */
export function parseLinesJson(raw: string): LineValues[] | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(value) || value.length > LIST_LIMIT) return null;
  const out: LineValues[] = [];
  for (const item of value as unknown[]) {
    if (typeof item !== 'object' || item === null) return null;
    const r = item as Record<string, unknown>;
    const fields = ['key', 'description', 'uom', 'quantity', 'unitPrice', 'taxCodeId'] as const;
    if (fields.some((f) => typeof r[f] !== 'string')) return null;
    out.push({
      key: r['key'] as string,
      description: r['description'] as string,
      uom: r['uom'] as string,
      quantity: r['quantity'] as string,
      unitPrice: r['unitPrice'] as string,
      taxCodeId: r['taxCodeId'] as string,
    });
  }
  return out;
}

/** One original invoice line and the quantity the person wants to credit (blank or 0: not credited). */
export interface CreditLineValues {
  lineNo: number;
  quantity: string;
}

export interface CreditLine {
  originalLineNo: number;
  quantity: string;
}

/** The lines to credit, by original line number. The server prices them and enforces the credit cap. */
export function parseCreditLines(values: readonly CreditLineValues[]): Parsed<CreditLine[]> {
  const errors: FieldErrors = {};
  const data: CreditLine[] = [];
  values.forEach((v, i) => {
    const quantity = plainNumber(v.quantity);
    if (quantity === '' || (/^0*(\.0*)?$/.test(quantity) && quantity !== '.')) return;
    if (!QUANTITY.test(quantity) || !aboveZero(quantity)) {
      errors[`lines.${i}.quantity`] = withPointHint(QUANTITY_WORDS, v.quantity);
      return;
    }
    data.push({ originalLineNo: v.lineNo, quantity });
  });
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  if (data.length === 0) {
    return { ok: false, errors: { lines: 'Enter a quantity to credit on at least one line.' } };
  }
  return { ok: true, data };
}

/** The `lines` field of a credit note: `[{ lineNo, quantity }]`. Anything else is null. */
export function parseCreditLinesJson(raw: string): CreditLineValues[] | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(value) || value.length > LIST_LIMIT) return null;
  const out: CreditLineValues[] = [];
  for (const item of value as unknown[]) {
    if (typeof item !== 'object' || item === null) return null;
    const r = item as Record<string, unknown>;
    const lineNo = r['lineNo'];
    if (typeof lineNo !== 'number' || !Number.isInteger(lineNo) || lineNo < 1) return null;
    if (typeof r['quantity'] !== 'string') return null;
    out.push({ lineNo, quantity: r['quantity'] });
  }
  return out;
}
