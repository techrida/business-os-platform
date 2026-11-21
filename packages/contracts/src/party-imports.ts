// Contracts of the customer and vendor CSV import (round 5, K1; Kuu decision K-M3). Serves the NFR "inputs are validated
// at the edge" and "no double effects": the upload is parsed and checked into a stored preview (one row per CSV line,
// with its errors), and only the valid rows of that preview are committed, in one transaction. The file itself is never
// stored; the batch record holds what was read from it.
import { z } from 'zod';

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
  'address_line1',
  'address_city',
  'address_country',
  'contact_name',
  'contact_email',
  'contact_phone',
] as const;
export const VENDOR_IMPORT_COLUMNS = [
  'legal_name',
  'kind',
  'pan',
  'vat_registered',
  'country',
  'contact_name',
  'contact_email',
  'contact_phone',
] as const;
export const PARTY_IMPORT_COLUMNS = {
  customer: CUSTOMER_IMPORT_COLUMNS,
  vendor: VENDOR_IMPORT_COLUMNS,
} as const satisfies Record<PartyImportKind, readonly string[]>;

/** Columns a row must fill. Everything else is optional or has a default (see the template's example row). */
export const PARTY_IMPORT_REQUIRED = {
  customer: ['legal_name', 'address_line1', 'address_city', 'contact_email'],
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
    '+9779812345678',
  ],
  vendor: [
    'Everest Supplies Pvt. Ltd.',
    'company',
    '987654321',
    'yes',
    'NP',
    'Ram Karki',
    'sales@example.com',
    '+9779801234567',
  ],
} as const satisfies Record<PartyImportKind, readonly string[]>;

export const PARTY_IMPORT_ROW_STATUSES = ['valid', 'duplicate', 'error', 'created'] as const;
export const PartyImportRowStatusSchema = z.enum(PARTY_IMPORT_ROW_STATUSES);
export type PartyImportRowStatus = z.infer<typeof PartyImportRowStatusSchema>;

export const PARTY_IMPORT_BATCH_STATUSES = ['previewed', 'committed'] as const;
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
  filename: z.string().trim().min(1).max(200).default('import.csv'),
});

export const ListPartyImportsQuerySchema = z.strictObject({
  kind: PartyImportKindSchema.optional(),
});
