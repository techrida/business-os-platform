// Contracts for document upload and download. Serves the NFR "no unscanned file is ever served":
// a version is only downloadable once its status is `clean`, and links are short-lived.
import { z } from 'zod';

const isoDateTime = z.iso.datetime({ offset: true });

/** The only types the upload route accepts. Checked against the detected type, not just the declared one. */
export const ALLOWED_MIME = [
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/webp',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'text/csv',
] as const;
export const AllowedMimeSchema = z.enum(ALLOWED_MIME);
export type AllowedMime = z.infer<typeof AllowedMimeSchema>;

/** 25 MiB. Same number as the size_bytes CHECK in migration 0004. */
export const MAX_UPLOAD_BYTES = 26_214_400;

export const DOCUMENT_VERSION_STATUSES = [
  'awaiting_content',
  'quarantined',
  'clean',
  'infected',
  'rejected',
  'scan_failed',
] as const;
export const DocumentVersionStatusSchema = z.enum(DOCUMENT_VERSION_STATUSES);
export type DocumentVersionStatus = z.infer<typeof DocumentVersionStatusSchema>;

/**
 * Body of `POST /v1/documents`. `declaredMime` and the size limit are NOT checked here on purpose:
 * the service answers an unsupported type with 415 and an oversized file with 413, which a schema
 * failure (400) would hide.
 */
export const CreateDocumentBodySchema = z.object({
  ownerType: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
  ownerId: z.guid(),
  /** A bare file name: no path separators or control characters (it ends up in a download header). */
  filename: z
    .string()
    .min(1)
    .max(255)
    // eslint-disable-next-line no-control-regex -- rejecting control characters is the point
    .regex(/^[^/\\\u0000-\u001f\u007f]+$/, 'must be a file name without path separators'),
  declaredMime: z.string().min(1).max(127),
  sizeBytes: z.number().int().positive(),
});
export type CreateDocumentBody = z.infer<typeof CreateDocumentBodySchema>;

// Fields follow app.document_versions in section 4.
export const DocumentVersionDtoSchema = z.object({
  id: z.guid(),
  documentId: z.guid(),
  version: z.number().int().min(1),
  filename: z.string(),
  declaredMime: z.string(),
  detectedMime: z.string().nullable(),
  sizeBytes: z.number().int().nonnegative(),
  /** Hex of the SHA-256 of the content; null until the content has been received. */
  sha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .nullable(),
  status: DocumentVersionStatusSchema,
  scanSignature: z.string().nullable(),
  scannedAt: isoDateTime.nullable(),
  uploadedBy: z.guid().nullable(),
  createdAt: isoDateTime,
});
export type DocumentVersionDto = z.infer<typeof DocumentVersionDtoSchema>;

/**
 * How long a screen waits on a generated PDF that is "being prepared" before it stops checking by itself (round 4,
 * R4c2: TR-Q4). Every render sweeper (quotation, invoice, purchase order) either stores the PDF or gives up within this
 * time, so a screen that polls this long sees the outcome; the API's retry policy (render-retry.ts) is tested against
 * it. 15 minutes.
 */
export const PDF_PREPARE_WITHIN_MS = 15 * 60_000;

export const SignedLinkDtoSchema = z.object({
  url: z.string().min(1),
  expiresAt: isoDateTime,
});
export type SignedLinkDto = z.infer<typeof SignedLinkDtoSchema>;
