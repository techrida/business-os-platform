/**
 * One CSV cell, always quoted. A value a spreadsheet would run as a formula (it starts with = + - @, a tab or a CR, and
 * is not a plain number) gets a leading apostrophe, so text that came from a person or a file never executes when the
 * export is opened. Same rule as the VAT register exports.
 */
export function csvCell(value: string | null | undefined): string {
  let text = value ?? '';
  if (/^[\t\r]/.test(text) || (!/^-?\d+(?:\.\d+)?$/.test(text) && /^\s*[=+@-]/.test(text)))
    text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

/** Rows as a UTF-8 CSV with a byte-order mark (so Excel reads the encoding) and CRLF line ends. */
export function csvDocument(rows: readonly (readonly (string | null | undefined)[])[]): string {
  return `﻿${rows.map((row) => row.map(csvCell).join(',')).join('\r\n')}\r\n`;
}
