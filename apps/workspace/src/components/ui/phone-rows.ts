/**
 * Reads the fields a `PhoneListInput name={name}` posts (`<name>.<row>.number`, `.country`, `.label`,
 * `.isPrimary`) into plain rows. Each form's parser maps these rows to its own shape: upper-cased
 * countries, normalised numbers, known labels, the primary fallback. Nothing here judges a number.
 */

/** Anything with `FormData`'s `get`: a real form, or a test's plain object. */
export interface PhoneFormLike {
  get(name: string): unknown;
}

/** One posted row with a number, values trimmed, nothing else changed. */
export interface RawPhoneRow {
  /** The row's position in the list, for putting a refusal back on the right row. */
  row: number;
  /** As posted, trimmed; `''` when none was posted. */
  country: string;
  /** As posted, trimmed; never `''` (a blank row is left out). */
  number: string;
  /** As posted, trimmed; `''` for no label. */
  label: string;
  isPrimary: boolean;
}

export interface RawPhoneRowsOptions {
  /**
   * The rows to read, in order. A row among them with no number is skipped. Without it, rows are read
   * from 0 up to the first row that posted no number field at all.
   */
  rows?: Iterable<number>;
  /** Without `rows`, at most this many rows are read; it only bounds the loop. */
  limit?: number;
}

const ROW_FIELD = /^(\d+)\.(number|country|label|isPrimary)$/;

/** Every row position that posted any phone field under `name`, ascending. */
export function postedPhoneRowIndexes(form: { keys(): Iterable<string> }, name: string): number[] {
  const prefix = `${name}.`;
  const rows = new Set<number>();
  for (const key of form.keys()) {
    if (!key.startsWith(prefix)) continue;
    const match = ROW_FIELD.exec(key.slice(prefix.length));
    if (match) rows.add(Number(match[1]));
  }
  return [...rows].sort((a, b) => a - b);
}

/** The posted rows that hold a number, in row order. A row whose number is blank (or not text) is left out. */
export function rawPhoneRows(
  form: PhoneFormLike,
  name: string,
  options: RawPhoneRowsOptions = {},
): RawPhoneRow[] {
  const text = (row: number, part: string): string => {
    const value = form.get(`${name}.${row}.${part}`);
    return typeof value === 'string' ? value.trim() : '';
  };
  const out: RawPhoneRow[] = [];
  const read = (row: number) => {
    const number = text(row, 'number');
    if (number === '') return;
    out.push({
      row,
      country: text(row, 'country'),
      number,
      label: text(row, 'label'),
      isPrimary: text(row, 'isPrimary') === 'true',
    });
  };
  if (options.rows !== undefined) {
    for (const row of options.rows) read(row);
    return out;
  }
  const limit = options.limit ?? Number.POSITIVE_INFINITY;
  for (let row = 0; row < limit; row += 1) {
    const posted = form.get(`${name}.${row}.number`);
    if (posted === null || posted === undefined) break;
    read(row);
  }
  return out;
}
