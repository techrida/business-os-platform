import type { VendorBillLineBody } from '@bos/contracts';

import { isGuid } from '@/components/p2/customers/format';

import { toScaled, type Errors } from '../../procurement/orders/_lib/forms';

/**
 * Checks of the bill entry form, before anything is sent. Pure. Quantities and prices are compared
 * as scaled whole numbers, never floats, and nothing is added or multiplied: the server owns every
 * net, VAT, TDS and total. The API checks again and has the last word.
 */

export const MAX_LINES = 200;

/** The new bill page's heading: drawn by the page, or by the entry form when it holds the actions. */
export const NEW_BILL_HEADING = {
  title: 'New bill',
  description:
    "Key in a vendor's invoice, or start from an invoice in the inbox. The platform calculates VAT, withholding and totals from the lines.",
};

export interface LineRow {
  /** Set when the row was started from a purchase order line; the person cannot change it. */
  poLineId: string;
  /** Optional: the receipt line this row is matched against. */
  receiptLineId: string;
  accountId: string;
  quantity: string;
  unitPrice: string;
  taxCodeId: string;
  /** Optional withholding code; the rate comes from the code, never from the client. */
  tdsCodeId: string;
}

export const EMPTY_ROW: LineRow = {
  poLineId: '',
  receiptLineId: '',
  accountId: '',
  quantity: '',
  unitPrice: '',
  taxCodeId: '',
  tdsCodeId: '',
};

/** A row nobody typed in. The ids that came with a purchase order line do not count as typing. */
const isBlank = (r: LineRow): boolean =>
  [r.accountId, r.quantity, r.unitPrice, r.taxCodeId, r.tdsCodeId].every((v) => v.trim() === '');

/**
 * The lines of a bill from the form rows. A row left empty is not part of the bill (so a
 * purchase order line that is not billed now is simply skipped). Errors are keyed
 * `<row index>.<field>` against the original row order.
 */
export function parseBillLines(
  rows: readonly LineRow[],
): { ok: true; lines: VendorBillLineBody[] } | { ok: false; errors: Errors } {
  const errors: Errors = {};
  const lines: VendorBillLineBody[] = [];

  rows.forEach((row, i) => {
    if (isBlank(row)) return;
    const quantity = row.quantity.trim();
    const unitPrice = row.unitPrice.trim();
    const accountId = row.accountId.trim();
    const taxCodeId = row.taxCodeId.trim();
    const tdsCodeId = row.tdsCodeId.trim();
    let bad = false;
    const fail = (field: string, message: string): void => {
      errors[`${i}.${field}`] = message;
      bad = true;
    };

    const q = toScaled(quantity, 4);
    if (q === null) fail('quantity', 'Use a number with up to 4 decimal places.');
    else if (q === 0n) fail('quantity', 'The quantity must be above zero.');
    if (toScaled(unitPrice, 2) === null) {
      fail('unitPrice', 'Use an amount such as 1250.50, with up to 2 decimal places.');
    }
    if (!isGuid(accountId)) fail('accountId', 'Paste the account ID this line is booked to.');
    if (!isGuid(taxCodeId)) fail('taxCodeId', 'Choose the VAT treatment of this line.');
    if (tdsCodeId !== '' && !isGuid(tdsCodeId)) {
      fail('tdsCodeId', 'Paste a withholding code ID, or leave it empty.');
    }
    if (bad) return;

    lines.push({
      ...(row.poLineId.trim() !== '' ? { poLineId: row.poLineId.trim() } : {}),
      ...(row.receiptLineId.trim() !== '' ? { receiptLineId: row.receiptLineId.trim() } : {}),
      accountId,
      quantity,
      unitPrice,
      taxCodeId,
      ...(tdsCodeId !== '' ? { tdsCodeId } : {}),
    });
  });

  if (Object.keys(errors).length === 0) {
    if (lines.length === 0) errors['lines'] = 'Add at least one line with a quantity and a price.';
    else if (lines.length > MAX_LINES) errors['lines'] = `A bill takes at most ${MAX_LINES} lines.`;
  }
  return Object.keys(errors).length > 0 ? { ok: false, errors } : { ok: true, lines };
}
