// Evidence files: uploaded in the dialog that needs them and owned by the record they prove
// something about. Pure (no server-only import), so the upload control, the route and the tests
// share these names.

/**
 * The document owner type of an evidence file; the owner id is the record's id. One place, so a
 * change in the API's owner naming is a one-line change here.
 */
export const EVIDENCE_OWNER_TYPE = 'evidence';

/** The records that take evidence, as they appear in `/api/evidence/:kind/:ownerId`. */
export const EVIDENCE_KINDS = ['sales-order', 'vendor-bill', 'rfq'] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

/** Where the browser uploads evidence for one record, and asks for its scan status. */
export function evidenceEndpoint(kind: EvidenceKind, ownerId: string): string {
  return `/api/evidence/${kind}/${encodeURIComponent(ownerId)}`;
}
