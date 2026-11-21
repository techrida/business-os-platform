// What the PDF of an invoice or a purchase-order version is right now, from the uploads of its live documents and its
// render-failure row (round 5, S3). One derivation for the staff download routes (InvoiceDocumentService,
// PurchaseOrderDocumentService) and for any screen that only shows a status: P5's portal pending and failed states
// read `renderStateOf`, so the portal and the download never disagree about a PDF.
//
// - clean: a live document has a clean upload; the oldest such document is the original.
// - preparing: the render job is still on it: no document yet, a document storing its bytes (awaiting_content or
//   quarantined), or only refused uploads (`rejected`, which no longer block the next try, see unrefusedUpload).
// - scan_refused: the stored file was refused by the virus scan (infected or scan_failed); it will never be offered.
// - failed: the render was given up (document_render_failures.exhausted_at); staff may Retry.

/** One upload of a live document of the owner: oldest document first, newest upload first within it. */
export interface OwnerUpload {
  documentId: string;
  status: string;
}

export type GeneratedPdfState =
  | { kind: 'clean'; documentId: string }
  | { kind: 'preparing' }
  | { kind: 'scan_refused' }
  | { kind: 'failed' };

/** The state of an owner's PDF. `givenUp`: its render was given up (renderGivenUp). */
export function generatedPdfState(
  uploads: readonly OwnerUpload[],
  givenUp: boolean,
): GeneratedPdfState {
  const held = uploads.filter((u) => u.status !== 'rejected');
  const clean = held.find((u) => u.status === 'clean');
  if (clean !== undefined) return { kind: 'clean', documentId: clean.documentId };
  if (held.some((u) => u.status === 'awaiting_content' || u.status === 'quarantined')) {
    return { kind: 'preparing' };
  }
  if (held.some((u) => u.status === 'infected' || u.status === 'scan_failed')) {
    return { kind: 'scan_refused' };
  }
  return givenUp ? { kind: 'failed' } : { kind: 'preparing' };
}

/** The three states a status-only screen shows: the PDF is ready, still being prepared, or it failed. */
export type RenderState = 'ready' | 'pending' | 'failed';

export function renderStateOf(state: GeneratedPdfState): RenderState {
  if (state.kind === 'clean') return 'ready';
  if (state.kind === 'preparing') return 'pending';
  return 'failed';
}
