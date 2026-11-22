// Contracts of the customer and vendor CSV import (round 5, K1; Kuu decision K-M3). Serves the NFR "inputs are validated
// at the edge" and "no double effects": the upload is parsed and checked into a stored preview (one row per CSV line,
// with its errors), and only the valid rows of that preview are committed, in one transaction. The file itself is never
// stored; the batch record holds what was read from it.
import { z } from 'zod';

import { AddressLinesSchema } from './addresses.js';
import { isCountryCode } from './countries.js';
import { nepalPanProblem } from './crm.js';
import {
  MAX_PARTY_PHONES,
  type PartyPhoneInput,
  PartyPhonesSchema,
  phoneCountryFromE164,
  phoneProblem,
} from './phones.js';

export const PARTY_IMPORT_KINDS = ['customer', 'vendor'] as const;
export const PartyImportKindSchema = z.enum(PARTY_IMPORT_KINDS);
export type PartyImportKind = z.infer<typeof PartyImportKindSchema>;

/** The largest upload (2 MiB) and the most data rows (header excluded) one file may hold. */
export const PARTY_IMPORT_MAX_BYTES = 2 * 1024 * 1024;
export const PARTY_IMPORT_MAX_ROWS = 2000;

/** The columns of each template, in order. The header row of an upload must use exactly these names. */
export const CUSTOMER_IMPORT_COLUMNS = [
  'legal_name',
  'pan_vat_no',
  'industry',
  'address_line',
  'address_city',
  'address_country',
  'contact_name',
  'contact_email',
  'contact_phones',
  'contact_country',
] as const;
export const VENDOR_IMPORT_COLUMNS = [
  'legal_name',
  'kind',
  'pan',
  'vat_registered',
  'country',
  'address_line',
  'address_city',
  'contact_name',
  'contact_email',
  'contact_phone',
  'contact_country',
] as const;
export const PARTY_IMPORT_COLUMNS = {
  customer: CUSTOMER_IMPORT_COLUMNS,
  vendor: VENDOR_IMPORT_COLUMNS,
} as const satisfies Record<PartyImportKind, readonly string[]>;

/** Columns a row must fill. Everything else is optional or has a default (see the template's example row). */
export const PARTY_IMPORT_REQUIRED = {
  customer: [
    'legal_name',
    'address_line',
    'address_city',
    'address_country',
    'contact_email',
    'contact_country',
  ],
  vendor: ['legal_name'],
} as const satisfies Record<PartyImportKind, readonly string[]>;

/** The example row of each template (the first data line a person overwrites). */
export const PARTY_IMPORT_EXAMPLE = {
  customer: [
    'Himalayan Traders Pvt. Ltd.',
    '123456789',
    'Retail',
    'Thapathali Marg 12',
    'Kathmandu',
    'NP',
    'Sita Sharma',
    'accounts@example.com',
    '+977 9812345678; +977 1-4123456',
    'NP',
  ],
  vendor: [
    'Everest Supplies Pvt. Ltd.',
    'company',
    '987654321',
    'yes',
    'NP',
    'Balaju Industrial Area',
    'Kathmandu',
    'Ram Karki',
    'sales@example.com',
    '+977 9801234567',
    'NP',
  ],
} as const satisfies Record<PartyImportKind, readonly string[]>;

/** Shortens a cell for a message, so one long cell cannot push the message past its limit. */
const quoteCell = (value: string): string =>
  `"${value.length > 40 ? `${value.slice(0, 40)}…` : value}"`;

/**
 * Reads a phones cell (FX9): numbers separated by semicolons, each `+<code> <number>` or plain E.164
 * (`+1 4155552671; +977 9812345678`). Spaces, hyphens and brackets inside a number are dropped; anything else is
 * refused rather than guessed. The country of each number comes from its calling code, and the first number is the
 * primary one. An empty cell is no numbers. One leading apostrophe is dropped: the downloaded template writes
 * `'+977 …` so a spreadsheet does not run the `+` as a formula (`csvCell` in the workspace).
 */
export function parsePhonesCell(
  cell: string,
): { ok: true; phones: PartyPhoneInput[] } | { ok: false; message: string } {
  const text = cell.trim().replace(/^'/, '');
  if (text.trim() === '') return { ok: true, phones: [] };
  const items = text.split(';').map((item) => item.trim());
  if (items.some((item) => item === ''))
    return { ok: false, message: 'separate phone numbers with one semicolon, with no empty item' };
  if (items.length > MAX_PARTY_PHONES)
    return { ok: false, message: `at most ${MAX_PARTY_PHONES} phone numbers` };
  const phones: PartyPhoneInput[] = [];
  const seen = new Set<string>();
  for (const [index, item] of items.entries()) {
    const e164 = item.replace(/[\s\-()]/g, '');
    if (!/^\+\d+$/.test(e164))
      return {
        ok: false,
        message: `${quoteCell(item)} must be + and the country code, then the number, such as +977 9812345678`,
      };
    const country = phoneCountryFromE164(e164);
    if (country === null)
      return { ok: false, message: `${quoteCell(item)} does not start with a known country code` };
    const problem = phoneProblem(country, e164);
    if (problem !== null) return { ok: false, message: `${quoteCell(item)}: ${problem}` };
    if (seen.has(e164)) return { ok: false, message: `${quoteCell(item)} is listed twice` };
    seen.add(e164);
    phones.push({ country, e164, isPrimary: index === 0 });
  }
  // The list rules (one primary, the cap, no repeats) are the form's; the checks above already meet them.
  const list = PartyPhonesSchema.safeParse(phones);
  if (!list.success)
    return { ok: false, message: list.error.issues[0]?.message ?? 'invalid phones' };
  return { ok: true, phones: list.data };
}

/** The canonical text of a phones cell: the E.164 numbers, primary first, joined by `;`. `parsePhonesCell` reads it. */
export const formatPhonesCell = (phones: readonly { e164: string }[]): string =>
  phones.map((phone) => phone.e164).join(';');

/** What `checkPartyImportPlace` found: every problem, and the checked columns as they will be created. */
export interface PartyImportPlaceCheck {
  issues: PartyImportIssue[];
  values: Record<string, string>;
}

const columnLabel = (column: string) => column.replaceAll('_', ' ');

/**
 * The FX9 checks of one import line: the address (line and city), the countries, the phones and the Nepal PAN rule.
 * A customer needs an address and its country (no default); its contact needs a country, and a Nepal customer's PAN
 * is 9 digits (a foreign one keeps the loose tax id). A vendor's address is optional, but line and city come
 * together; its country, kind and PAN stay with the caller. A vendor's contact may name its own country (empty means
 * the vendor's, which the caller fills in), independent of the countries of its phones. Phones cells are read by `parsePhonesCell` and written
 * back in the canonical form. Cells are expected trimmed; the PAN is judged as passed, so pass the normalised one.
 */
export function checkPartyImportPlace(
  kind: PartyImportKind,
  cells: Readonly<Record<string, string>>,
): PartyImportPlaceCheck {
  const issues: PartyImportIssue[] = [];
  const values: Record<string, string> = {};
  const get = (column: string): string => (cells[column] ?? '').trim();

  const line = get('address_line');
  const city = get('address_city');
  const addressRequired = kind === 'customer' || line !== '' || city !== '';
  if (addressRequired) {
    if (line === '')
      issues.push({
        column: 'address_line',
        message:
          kind === 'customer'
            ? 'address line is required'
            : 'address line is required when a city is given',
      });
    if (city === '')
      issues.push({
        column: 'address_city',
        message:
          kind === 'customer'
            ? 'address city is required'
            : 'address city is required when an address line is given',
      });
    if (line !== '' && city !== '') {
      const parsed = AddressLinesSchema.safeParse({ line, city });
      if (!parsed.success)
        for (const problem of parsed.error.issues)
          issues.push({
            column: `address_${String(problem.path[0])}`,
            message: `${columnLabel(`address_${String(problem.path[0])}`)} is too long`,
          });
    }
  }
  values.address_line = line;
  values.address_city = city;

  const country = (column: string, required: boolean): string => {
    const raw = get(column).toUpperCase();
    if (raw === '') {
      if (required) issues.push({ column, message: `${columnLabel(column)} is required` });
      return '';
    }
    if (!isCountryCode(raw)) {
      issues.push({
        column,
        message: `${columnLabel(column)} must be a 2-letter country code such as NP`,
      });
      return '';
    }
    return raw;
  };

  const phonesColumn = kind === 'customer' ? 'contact_phones' : 'contact_phone';
  const phones = parsePhonesCell(get(phonesColumn));
  if (phones.ok) values[phonesColumn] = formatPhonesCell(phones.phones);
  else
    issues.push({
      column: phonesColumn,
      message: `${columnLabel(phonesColumn)}: ${phones.message}`,
    });

  if (kind === 'customer') {
    const partyCountry = country('address_country', true);
    values.address_country = partyCountry;
    const pan = get('pan_vat_no');
    if (pan !== '' && nepalPanProblem(partyCountry, pan) !== null)
      issues.push({
        column: 'pan_vat_no',
        message: 'a PAN for a customer in Nepal must be exactly 9 digits',
      });
    const hasContact =
      get('contact_name') !== '' || get('contact_email') !== '' || get(phonesColumn) !== '';
    values.contact_country = country('contact_country', hasContact);
  } else {
    values.contact_country = country('contact_country', false);
  }
  return { issues, values };
}

export const PARTY_IMPORT_ROW_STATUSES = ['valid', 'duplicate', 'error', 'created'] as const;
export const PartyImportRowStatusSchema = z.enum(PARTY_IMPORT_ROW_STATUSES);
export type PartyImportRowStatus = z.infer<typeof PartyImportRowStatusSchema>;

export const PARTY_IMPORT_BATCH_STATUSES = ['previewed', 'committed', 'expired'] as const;
export const PartyImportBatchStatusSchema = z.enum(PARTY_IMPORT_BATCH_STATUSES);
export type PartyImportBatchStatus = z.infer<typeof PartyImportBatchStatusSchema>;

export const PartyImportIssueSchema = z.strictObject({
  /** The column the problem is in, or null for a problem of the whole line. */
  column: z.string().nullable(),
  message: z.string().min(1).max(300),
});
export type PartyImportIssue = z.infer<typeof PartyImportIssueSchema>;

/** One data line of the file, 1-based as a spreadsheet counts (the header is line 1, the first record line 2). */
export const PartyImportRowSchema = z.strictObject({
  line: z.number().int().min(2),
  /** The legal name as read, for the preview and the error report. */
  name: z.string().max(500),
  /** The PAN as read (trimmed), or null when the line had none. */
  pan: z.string().max(100).nullable(),
  status: PartyImportRowStatusSchema,
  issues: z.array(PartyImportIssueSchema),
  /** The columns as normalised for commit: present on a valid or created line, absent on a refused one. */
  values: z.record(z.string(), z.string()).optional(),
  /** The customer or vendor the line created. */
  recordId: z.guid().optional(),
});
export type PartyImportRow = z.infer<typeof PartyImportRowSchema>;

export const PartyImportBatchSchema = z.strictObject({
  id: z.guid(),
  kind: PartyImportKindSchema,
  status: PartyImportBatchStatusSchema,
  fileName: z.string(),
  rowCount: z.number().int().min(0),
  /** Lines that will be created when the batch is committed (0 after the commit). */
  validCount: z.number().int().min(0),
  createdCount: z.number().int().min(0),
  duplicateCount: z.number().int().min(0),
  errorCount: z.number().int().min(0),
  createdByUserId: z.guid(),
  createdAt: z.iso.datetime({ offset: true }),
  committedAt: z.iso.datetime({ offset: true }).nullable(),
});
export type PartyImportBatch = z.infer<typeof PartyImportBatchSchema>;

export const PartyImportDetailSchema = PartyImportBatchSchema.extend({
  rows: z.array(PartyImportRowSchema),
});
export type PartyImportDetail = z.infer<typeof PartyImportDetailSchema>;

/** `POST /v1/imports/:kind?filename=` takes the CSV as the raw `text/csv` body; this is its query. */
export const PreviewPartyImportQuerySchema = z.strictObject({
  filename: z
    .string()
    .trim()
    .min(1)
    .max(200)
    // eslint-disable-next-line no-control-regex -- refusing control characters is the point
    .refine((v) => !/[\u0000-\u001F\u007F]/.test(v), 'must not contain control characters')
    .default('import.csv'),
});

export const ListPartyImportsQuerySchema = z.strictObject({
  kind: PartyImportKindSchema.optional(),
});
