import type { VendorBillLineBody, WithholdingCode } from '@bos/contracts';
import { Dec, hasInnerSpace, NO_SPACES, postedAmount } from '@bos/locale';

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

/** A withholding code as the bill line picker offers it, with its rate: "TDS-5 - Rent (5%)". */
export function withholdingOption(code: Pick<WithholdingCode, 'id' | 'code' | 'name' | 'rateBp'>): {
  id: string;
  label: string;
} {
  // Basis points to a percent without trailing zeros: 150 is 1.5%, 500 is 5%.
  const percent = new Dec(code.rateBp).div(100).toString();
  return { id: code.id, label: `${code.code} - ${code.name} (${percent}%)` };
}

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
    const quantity = postedAmount(row.quantity);
    const unitPrice = postedAmount(row.unitPrice);
    const accountId = row.accountId.trim();
    const taxCodeId = row.taxCodeId.trim();
    const tdsCodeId = row.tdsCodeId.trim();
    let bad = false;
    const fail = (field: string, message: string): void => {
      errors[`${i}.${field}`] = message;
      bad = true;
    };

    // "10 50" is refused with its own reason: joining the halves would be a silent 10 to 100 times error.
    const q = toScaled(quantity, 4);
    if (q === null) {
      fail(
        'quantity',
        hasInnerSpace(quantity) ? NO_SPACES : 'Use a number with up to 4 decimal places.',
      );
    } else if (q === 0n) fail('quantity', 'The quantity must be above zero.');
    if (toScaled(unitPrice, 2) === null) {
      fail(
        'unitPrice',
        hasInnerSpace(unitPrice)
          ? NO_SPACES
          : 'Use an amount such as 1250.50, with up to 2 decimal places.',
      );
    }
    if (!isGuid(accountId)) fail('accountId', 'Choose the expense account this line is booked to.');
    if (!isGuid(taxCodeId)) fail('taxCodeId', 'Choose the VAT treatment of this line.');
    if (tdsCodeId !== '' && !isGuid(tdsCodeId)) {
      fail('tdsCodeId', 'Choose a withholding code from the list, or No withholding.');
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

/** The API's 422 code for a line whose account is not an active expense account of this company. */
export const EXPENSE_ACCOUNT_INVALID = 'EXPENSE_ACCOUNT_INVALID';

export const EXPENSE_ACCOUNT_REFUSED =
  "This account was retired or is not one of this company's expense accounts. Choose an active account.";

/** The hidden field the bill entry form posts: the ids of the active expense accounts its page loaded. */
export const ACTIVE_ACCOUNT_IDS_FIELD = 'activeAccountIds';

/** The ids `ACTIVE_ACCOUNT_IDS_FIELD` carries (comma separated, lowercase); undefined when the field was not sent. */
export function parseActiveAccountIds(value: FormDataEntryValue | null): Set<string> | undefined {
  if (typeof value !== 'string') return undefined;
  return new Set(
    value
      .split(',')
      .map((id) => id.trim().toLowerCase())
      .filter((id) => id !== ''),
  );
}

/**
 * Field errors for an `EXPENSE_ACCOUNT_INVALID` refusal, keyed like `parseBillLines`. The refusal does not say which
 * line it means, so the account field of each sent row (a blank row was not sent) whose account is not in `active`
 * (the active accounts the page loaded) is marked. Every sent row is marked when no list is given, or when each
 * sent account is in it (one was retired after the page loaded), so the refusal never shows on no field.
 */
export function expenseAccountErrors(
  rows: readonly LineRow[],
  active?: ReadonlySet<string>,
): Errors {
  const sent = rows.flatMap((row, i) => (isBlank(row) ? [] : [{ row, i }]));
  const outside =
    active === undefined
      ? []
      : sent.filter(({ row }) => !active.has(row.accountId.trim().toLowerCase()));
  const errors: Errors = {};
  for (const { i } of outside.length > 0 ? outside : sent)
    errors[`${i}.accountId`] = EXPENSE_ACCOUNT_REFUSED;
  return errors;
}
