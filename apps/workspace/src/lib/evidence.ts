// Evidence files: uploaded in the dialog that needs them and owned by the record they prove
// something about. Pure (no server-only import), so the upload control, the route, the failure
// words and the tests share these names.
import { ErrorBodySchema } from '@bos/contracts';

/**
 * The document owner type of an evidence file; the owner id is the record's id. One place, so a
 * change in the API's owner naming is a one-line change here.
 */
export const EVIDENCE_OWNER_TYPE = 'evidence';

/**
 * The records that take evidence, as they appear in `/api/evidence/:kind/:ownerId`. A
 * `quotation-version` is the accepted quotation version a sales order is confirmed from: its
 * evidence is uploaded before the order exists.
 */
export const EVIDENCE_KINDS = ['sales-order', 'vendor-bill', 'rfq', 'quotation-version'] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

/** Where the browser uploads evidence for one record, and asks for its scan status. */
export function evidenceEndpoint(kind: EvidenceKind, ownerId: string): string {
  return `/api/evidence/${kind}/${encodeURIComponent(ownerId)}`;
}

/** Shown when a form that needs evidence is sent without a file. */
export const EVIDENCE_REQUIRED = 'Upload the document that shows this step was done.';

/** Shown when the API refuses the file as evidence of this record (422 `invalid_evidence_document`). */
export const INVALID_EVIDENCE =
  'That file is not evidence uploaded to this record. Remove it, upload the evidence here, then try again.';

/**
 * The words for the API's evidence refusals (an ApiError-like `{status, body}`), or undefined for
 * anything else. An infected file is `infectedFileMessage`'s (lib/infected-file.ts).
 */
export function evidenceRefusalMessage(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const { status, body } = err as { status?: unknown; body?: unknown };
  if (status !== 422) return undefined;
  const parsed = ErrorBodySchema.safeParse(body);
  if (!parsed.success) return undefined;
  switch (parsed.data.error.code) {
    case 'invalid_evidence_document':
      return INVALID_EVIDENCE;
    case 'evidence_required':
      return EVIDENCE_REQUIRED;
    default:
      return undefined;
  }
}
