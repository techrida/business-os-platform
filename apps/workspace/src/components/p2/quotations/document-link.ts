// What a quotation version offers in place of its customer PDF. Pure and type-only on purpose: the
// version drawer (a client component) imports it, and a type import adds nothing to the bundle.
// Serves the NFR "a file is offered only after a clean scan": the link needs a clean scan AND a
// document id, and every other case falls to words (deny by default).
import type { DocumentVersionStatus, QuotationStatus } from '@bos/contracts';

export type PdfWords =
  'Being prepared' | 'Being scanned' | 'PDF available after approval' | 'Not available';

/** Statuses a version is in before approval: the PDF is rendered only once it is approved. */
const BEFORE_APPROVAL: readonly QuotationStatus[] = ['draft', 'submitted', 'returned'];

export type PdfLink = { kind: 'link'; href: string } | { kind: 'words'; text: PdfWords };

/** The fields of a version this decision reads. */
export interface PdfVersion {
  id: string;
  status: QuotationStatus;
  renderedDocumentId: string | null;
  renderedScanStatus: DocumentVersionStatus | null;
}

/**
 * Words for a rendered file that is not clean. A full record, so a new contract scan status is a
 * compile error here until someone decides what a person should read. `clean` has no words: it is
 * the one status that becomes a link.
 *   - awaiting_content: the renderer has not finished storing the bytes, so "Being prepared".
 *   - quarantined: stored, waiting for the scanner, so "Being scanned".
 *   - infected, rejected, scan_failed: never offered, and the screen does not say why.
 */
const WORDS: Record<DocumentVersionStatus, PdfWords | null> = {
  awaiting_content: 'Being prepared',
  quarantined: 'Being scanned',
  clean: null,
  infected: 'Not available',
  rejected: 'Not available',
  scan_failed: 'Not available',
};

function wordsWithoutDocument(status: QuotationStatus): PdfWords {
  if (status === 'approved') return 'Being prepared';
  if (BEFORE_APPROVAL.includes(status)) return 'PDF available after approval';
  return 'Not available';
}

/**
 * The PDF of one version: a link, or words. The PDF is rendered by a sweeper after approval, so a
 * version that is Approved and has no document yet is "Being prepared"; a version still before
 * approval (draft, submitted, returned) reads "PDF available after approval"; a version in any
 * other status without a document will never get one and reads "Not available".
 *
 * The link goes to this app's own route, never to the API. That route issues a single-use signed
 * link on every call, so nothing may call it to find out whether the file is clean: this function
 * decides from the version's `renderedScanStatus` alone.
 */
export function pdfLinkFor(quotationId: string, version: PdfVersion): PdfLink {
  if (version.renderedDocumentId === null) {
    return { kind: 'words', text: wordsWithoutDocument(version.status) };
  }
  if (version.renderedScanStatus === null) return { kind: 'words', text: 'Not available' };
  const words = WORDS[version.renderedScanStatus];
  if (words !== null) return { kind: 'words', text: words };
  return {
    kind: 'link',
    href: `/quotations/${encodeURIComponent(quotationId)}/versions/${encodeURIComponent(version.id)}/document`,
  };
}
