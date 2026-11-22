// Pure rules of the customer and vendor CSV import (round 5, K1): the CSV reader, the per-line checks and the
// in-file duplicate marking. No database and no Nest, so a test can pin each rule. What the existing records hold is
// the service's business (party-imports.service.ts); this file never sees it.
import {
  EmailSchema,
  PanVatNoSchema,
  PARTY_IMPORT_COLUMNS,
  PARTY_IMPORT_MAX_ROWS,
  PARTY_IMPORT_REQUIRED,
  PhoneSchema,
  nepalPanProblem,
  VENDOR_KINDS,
  VendorPanSchema,
  type PartyImportIssue,
  type PartyImportKind,
  type PartyImportRow,
} from '@bos/contracts';

import {
  normalizeName,
  normalizeEmail,
  normalizePan,
  panMatchKey,
} from '../customers/customers.normalize';
import { kindCountryProblem } from '../vendors/vendors.rules';

/** A file-level refusal: the whole upload is unusable (400), not one line. */
export class PartyImportFileError extends Error {}

/**
 * Splits CSV text into records (RFC 4180): comma separated, `"` quotes a field, `""` is a quote inside one, a quoted
 * field may hold line breaks, rows end at CRLF, LF or CR. A leading byte-order mark is dropped, and a line with no
 * content at all is skipped. An unterminated quote and a stray quote inside an unquoted field are refused.
 */
export function parseCsv(input: string): string[][] {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const records: string[][] = [];
  let record: string[] = [];
  let field = '';
  let quoted = false;
  let wasQuoted = false;
  let i = 0;
  const endField = () => {
    record.push(field);
    field = '';
    wasQuoted = false;
  };
  const endRecord = () => {
    endField();
    if (!(record.length === 1 && record[0] === '')) records.push(record);
    record = [];
  };
  while (i < text.length) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i += 1;
        const next = text[i];
        if (next !== undefined && next !== ',' && next !== '\n' && next !== '\r')
          throw new PartyImportFileError(
            'A quoted field is followed by text before the next comma',
          );
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }
    if (ch === '"') {
      if (field !== '' || wasQuoted)
        throw new PartyImportFileError('A quote appears in the middle of an unquoted field');
      quoted = true;
      wasQuoted = true;
      i += 1;
    } else if (ch === ',') {
      endField();
      i += 1;
    } else if (ch === '\r' || ch === '\n') {
      endRecord();
      i += ch === '\r' && text[i + 1] === '\n' ? 2 : 1;
    } else {
      field += ch;
      i += 1;
    }
  }
  if (quoted) throw new PartyImportFileError('A quoted field is never closed');
  if (field !== '' || record.length > 0 || wasQuoted) endRecord();
  return records;
}

/** A cell a spreadsheet would run as a formula when the value is opened: it starts with = + - @, a tab or a CR. */
export const startsLikeFormula = (value: string): boolean => /^[=+\-@\t\r]/.test(value);

/** Columns where a leading + is a number (an E.164 phone) rather than a formula, or the value is a fixed word. */
const FORMULA_EXEMPT = new Set([
  'contact_phone',
  'kind',
  'vat_registered',
  'address_country',
  'country',
]);

export interface ReadCsv {
  /** Data lines in order, with their 1-based line number (the header is line 1). */
  records: { line: number; cells: Record<string, string> }[];
}

/** Reads the upload as `kind`'s template: the header must name exactly the template's columns, in any order. */
export function readPartyCsv(kind: PartyImportKind, input: string): ReadCsv {
  // A control character (NUL above all) cannot be stored and is never part of a name: refuse the file, not one cell.
  // eslint-disable-next-line no-control-regex -- refusing control characters is the point
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(input))
    throw new PartyImportFileError(
      'The file contains control characters. Re-save it as plain CSV UTF-8.',
    );
  const table = parseCsv(input);
  const header = table[0];
  if (header === undefined) throw new PartyImportFileError('The file is empty');
  const names = header.map((h) => h.trim().toLowerCase());
  const expected: readonly string[] = PARTY_IMPORT_COLUMNS[kind];
  const unknown = names.filter((n) => !expected.includes(n));
  if (unknown.length > 0)
    throw new PartyImportFileError(
      `Unknown column ${unknown.map((n) => `"${n.slice(0, 40)}"`).join(', ')}. Use the template's columns.`,
    );
  const repeated = names.filter((n, i) => names.indexOf(n) !== i);
  if (repeated.length > 0)
    throw new PartyImportFileError(`The column "${repeated[0]}" appears twice`);
  const missing = PARTY_IMPORT_REQUIRED[kind].filter((c) => !names.includes(c));
  if (missing.length > 0)
    throw new PartyImportFileError(
      `The column ${missing.map((c) => `"${c}"`).join(', ')} is missing`,
    );
  const dataRows = table.slice(1);
  if (dataRows.length === 0) throw new PartyImportFileError('The file has a header but no rows');
  if (dataRows.length > PARTY_IMPORT_MAX_ROWS)
    throw new PartyImportFileError(`The file has more than ${PARTY_IMPORT_MAX_ROWS} rows`);
  const records = dataRows.map((row, index) => {
    if (row.length > names.length)
      throw new PartyImportFileError(`Line ${index + 2} has more fields than the header`);
    const cells: Record<string, string> = {};
    names.forEach((name, column) => {
      cells[name] = (row[column] ?? '').normalize('NFC').trim();
    });
    return { line: index + 2, cells };
  });
  return { records };
}

/** At most `max` UTF-16 units without splitting a character, so a cut never leaves half of a surrogate pair. */
export function clip(value: string, max: number): string {
  if (value.length <= max) return value;
  const cut = value.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

const issue = (column: string | null, message: string): PartyImportIssue => ({ column, message });
const upper = (v: string) => v.toUpperCase();

const YES = new Set(['yes', 'y', 'true', '1']);
const NO = new Set(['no', 'n', 'false', '0']);

/** The names a person sees for a column in a message. */
const label = (column: string) => column.replaceAll('_', ' ');

export interface CheckedLine {
  name: string;
  pan: string | null;
  issues: PartyImportIssue[];
  /** The columns as they will be created. Present when there is no issue. */
  values?: Record<string, string>;
}

/** Checks one data line. Every problem of the line is listed, not only the first. */
export function checkLine(kind: PartyImportKind, cells: Record<string, string>): CheckedLine {
  const issues: PartyImportIssue[] = [];
  const get = (column: string): string => cells[column] ?? '';
  const out: Record<string, string> = {};
  const text = (column: string, max: number, required: boolean): string => {
    const value = get(column);
    if (value === '') {
      if (required) issues.push(issue(column, `${label(column)} is required`));
      return '';
    }
    if (value.length > max)
      issues.push(issue(column, `${label(column)} is longer than ${max} characters`));
    else if (!FORMULA_EXEMPT.has(column) && startsLikeFormula(value))
      issues.push(
        issue(
          column,
          `${label(column)} starts with =, +, - or @, which a spreadsheet would run as a formula`,
        ),
      );
    return value;
  };

  const legalName = text('legal_name', 200, true);
  if (legalName !== '' && normalizeName(legalName) === '')
    issues.push(issue('legal_name', 'legal name needs letters or digits'));
  out.legal_name = legalName;

  const email = (required: boolean): string => {
    const raw = get('contact_email');
    if (raw === '') {
      if (required) issues.push(issue('contact_email', 'contact email is required'));
      return '';
    }
    if (!EmailSchema.safeParse(raw).success) {
      issues.push(issue('contact_email', 'contact email is not a valid email address'));
      return '';
    }
    return normalizeEmail(raw);
  };
  const phone = (): string => {
    const raw = get('contact_phone');
    if (raw === '') return '';
    if (!PhoneSchema.safeParse(raw).success) {
      issues.push(
        issue(
          'contact_phone',
          'contact phone must be an E.164 number such as +9779812345678 (a +977 number is a 10-digit mobile starting with 9, or a landline of 7 to 9 digits)',
        ),
      );
      return '';
    }
    return raw;
  };

  let pan: string | null = null;
  if (kind === 'customer') {
    const rawPan = get('pan_vat_no');
    if (rawPan !== '') {
      if (!PanVatNoSchema.safeParse(rawPan).success || !/[A-Za-z0-9]/.test(rawPan))
        issues.push(
          issue('pan_vat_no', 'PAN or VAT number must be 5 to 20 letters, digits or hyphens'),
        );
      else pan = normalizePan(rawPan);
    }
    out.pan_vat_no = pan ?? '';
    out.industry = text('industry', 100, false);
    out.address_line1 = text('address_line1', 200, true);
    out.address_city = text('address_city', 100, true);
    const country = upper(get('address_country') || 'NP');
    if (!/^[A-Z]{2}$/.test(country))
      issues.push(issue('address_country', 'address country must be a 2-letter code such as NP'));
    out.address_country = country;
    if (pan !== null && nepalPanProblem(country, pan) !== null)
      issues.push(issue('pan_vat_no', 'a PAN for a customer in Nepal must be exactly 9 digits'));
    out.contact_email = email(true);
    out.contact_name = text('contact_name', 200, false) || legalName;
    out.contact_phone = phone();
  } else {
    const rawKind = (get('kind') || 'company').toLowerCase();
    const vendorKind = VENDOR_KINDS.find((k) => k === rawKind);
    if (vendorKind === undefined)
      issues.push(issue('kind', `kind must be one of ${VENDOR_KINDS.join(', ')}`));
    out.kind = vendorKind ?? rawKind;
    const rawCountry = upper(get('country'));
    const country = rawCountry === '' ? (vendorKind === 'foreign' ? '' : 'NP') : rawCountry;
    if (!/^[A-Z]{2}$/.test(country))
      issues.push(
        issue(
          'country',
          rawCountry === ''
            ? 'country is required for a foreign vendor'
            : 'country must be a 2-letter code such as NP',
        ),
      );
    else if (vendorKind !== undefined) {
      const problem = kindCountryProblem(vendorKind, country);
      if (problem !== undefined) issues.push(issue('country', problem));
    }
    out.country = country;
    const rawPan = get('pan');
    if (rawPan !== '') {
      if (!VendorPanSchema.safeParse(rawPan).success)
        issues.push(issue('pan', 'PAN must be 9 digits'));
      else pan = rawPan;
    } else if (vendorKind !== 'foreign' && vendorKind !== undefined) {
      issues.push(issue('pan', 'PAN is required unless the vendor is foreign'));
    }
    out.pan = pan ?? '';
    const vat = get('vat_registered').toLowerCase();
    if (vat !== '' && !YES.has(vat) && !NO.has(vat))
      issues.push(issue('vat_registered', 'VAT registered must be yes or no'));
    out.vat_registered = YES.has(vat) ? 'yes' : 'no';
    out.contact_email = email(false);
    out.contact_phone = phone();
    const hasContact = out.contact_email !== '' || out.contact_phone !== '';
    const contactName = text('contact_name', 120, false);
    out.contact_name = contactName !== '' ? contactName : hasContact ? clip(legalName, 120) : '';
  }
  return issues.length === 0
    ? {
        name: legalName,
        pan: get(kind === 'customer' ? 'pan_vat_no' : 'pan') || null,
        issues,
        values: out,
      }
    : { name: legalName, pan: get(kind === 'customer' ? 'pan_vat_no' : 'pan') || null, issues };
}

/**
 * What identifies a line against the existing records and against the other lines: the PAN when it has one (compared
 * without spaces and hyphens for a customer, exactly for a vendor), otherwise the normalised name. Null when the line
 * has neither (an invalid line is never keyed).
 */
export function identityKey(kind: PartyImportKind, values: Record<string, string>): string | null {
  const pan = kind === 'customer' ? values.pan_vat_no : values.pan;
  if (pan !== undefined && pan !== '') {
    const key = kind === 'customer' ? panMatchKey(pan) : pan;
    if (key !== null) return `pan:${key}`;
  }
  const name = normalizeName(values.legal_name ?? '');
  return name === '' ? null : `name:${name}`;
}

/** The checked lines of one file as the preview's rows. A key seen on an earlier line makes the later line a duplicate. */
export function buildRows(
  kind: PartyImportKind,
  records: readonly { line: number; cells: Record<string, string> }[],
): PartyImportRow[] {
  const firstLine = new Map<string, number>();
  // Every accepted line also reserves its name, so a later line without a PAN cannot repeat a company that an
  // earlier line created with one (the database matches a name-only line against all customers).
  const nameLine = new Map<string, number>();
  return records.map(({ line, cells }): PartyImportRow => {
    const checked = checkLine(kind, cells);
    const base = {
      line,
      name: clip(checked.name, 500),
      pan: checked.pan === null ? null : clip(checked.pan, 100),
    };
    if (checked.values === undefined) return { ...base, status: 'error', issues: checked.issues };
    const key = identityKey(kind, checked.values);
    const nameKey = identityKey(kind, { legal_name: checked.values.legal_name ?? '' });
    const earlier =
      key === null
        ? undefined
        : key.startsWith('name:')
          ? (nameLine.get(key) ?? firstLine.get(key))
          : firstLine.get(key);
    if (key !== null && earlier === undefined) firstLine.set(key, line);
    if (earlier === undefined && nameKey !== null && !nameLine.has(nameKey))
      nameLine.set(nameKey, line);
    if (earlier !== undefined)
      return {
        ...base,
        status: 'duplicate',
        issues: [
          issue(
            null,
            `Same ${key!.startsWith('pan:') ? 'PAN' : 'name'} as line ${earlier} of this file`,
          ),
        ],
      };
    return { ...base, status: 'valid', issues: [], values: checked.values };
  });
}

export const countStatuses = (rows: readonly PartyImportRow[]) => ({
  rowCount: rows.length,
  validCount: rows.filter((r) => r.status === 'valid').length,
  createdCount: rows.filter((r) => r.status === 'created').length,
  duplicateCount: rows.filter((r) => r.status === 'duplicate').length,
  errorCount: rows.filter((r) => r.status === 'error').length,
});
