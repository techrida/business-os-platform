import {
  PARTY_IMPORT_COLUMNS,
  PARTY_IMPORT_EXAMPLE,
  PARTY_IMPORT_MAX_BYTES,
  PARTY_IMPORT_MAX_ROWS,
  PARTY_IMPORT_REQUIRED,
  type PartyImportDetail,
  type PartyImportKind,
  type PartyImportRowStatus,
  type Permission,
} from '@bos/contracts';

import { csvDocument } from '@/lib/csv';

/** The two kinds as the URL spells them (`/imports/customers`), with the words and the grant each one needs. */
export const IMPORT_KINDS = {
  customers: {
    kind: 'customer',
    singular: 'customer',
    plural: 'customers',
    title: 'Import customers from CSV',
    listHref: '/customers',
    grant: 'customer.write',
    help: 'Each row creates one customer (a prospect, owned by you) with its first contact. A row with a PAN or VAT number is matched on that number, a row without one on the company name; a match is skipped, so uploading the same file twice creates nothing the second time.',
    format:
      'Write countries as two-letter ISO codes, such as NP or US. Write each phone as + and the country code, then the number (+977 9812345678), and separate several numbers with semicolons.',
  },
  vendors: {
    kind: 'vendor',
    singular: 'vendor',
    plural: 'vendors',
    title: 'Import vendors from CSV',
    listHref: '/vendors',
    grant: 'vendor.write',
    help: 'Each row creates one vendor, unverified like a vendor you add by hand: it still needs its documents, verification and approval. A row is matched on its PAN, or on the company name when a foreign vendor has none; a match is skipped, so uploading the same file twice creates nothing the second time.',
    format:
      'Write the country as a two-letter ISO code, such as NP or US; leave it empty for a vendor in Nepal. contact_country is optional, also a two-letter code; leave it empty to place the contact in the country of the vendor. Write each phone as + and the country code, then the number (+977 9812345678), and separate several numbers with semicolons. The address is optional, but its line and city go together.',
  },
} as const satisfies Record<
  string,
  {
    kind: PartyImportKind;
    singular: string;
    plural: string;
    title: string;
    listHref: string;
    grant: Permission;
    help: string;
    /** How the country, phone and address cells are written (FX9), shown under the column list. */
    format: string;
  }
>;
export type ImportSlug = keyof typeof IMPORT_KINDS;

export const importSlugOf = (value: string): ImportSlug | null =>
  value === 'customers' || value === 'vendors' ? value : null;

export const slugOfKind = (kind: PartyImportKind): ImportSlug =>
  kind === 'customer' ? 'customers' : 'vendors';

export const LIMITS_TEXT = `Up to ${(PARTY_IMPORT_MAX_BYTES / (1024 * 1024)).toString()} MB and ${PARTY_IMPORT_MAX_ROWS.toLocaleString('en-US')} rows per file, UTF-8 CSV.`;

/** The template people download: the header row and one example row to overwrite. */
export function templateCsv(kind: PartyImportKind): string {
  return csvDocument([PARTY_IMPORT_COLUMNS[kind], PARTY_IMPORT_EXAMPLE[kind]]);
}

export const requiredColumns = (kind: PartyImportKind): readonly string[] =>
  PARTY_IMPORT_REQUIRED[kind];
export const templateColumns = (kind: PartyImportKind): readonly string[] =>
  PARTY_IMPORT_COLUMNS[kind];

export const STATUS_LABEL: Record<PartyImportRowStatus, string> = {
  valid: 'Ready to import',
  created: 'Created',
  duplicate: 'Already exists',
  error: 'Needs fixing',
};

/** The error report: one row per line that is not valid or created, with its problems, for the person to fix and re-upload. */
export function errorReportCsv(detail: PartyImportDetail): string {
  const lines = detail.rows.filter((row) => row.status === 'error' || row.status === 'duplicate');
  return csvDocument([
    ['Line', 'Name', 'PAN', 'Result', 'Problems'],
    ...lines.map((row) => [
      String(row.line),
      row.name,
      row.pan,
      STATUS_LABEL[row.status],
      row.issues
        .map((i) => (i.column === null ? i.message : `${i.column}: ${i.message}`))
        .join('; '),
    ]),
  ]);
}
