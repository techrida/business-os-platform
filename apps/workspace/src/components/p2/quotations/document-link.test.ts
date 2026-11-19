import { DOCUMENT_VERSION_STATUSES, QUOTATION_STATUSES } from '@bos/contracts';
import { describe, expect, it } from 'vitest';

import { pdfLinkFor, type PdfVersion } from './document-link';

const QUOTATION = '11111111-1111-4111-8111-111111111111';
const VERSION = '22222222-2222-4222-8222-222222222222';
const DOCUMENT = '33333333-3333-4333-8333-333333333333';

function version(over: Partial<PdfVersion> = {}): PdfVersion {
  return {
    id: VERSION,
    status: 'approved',
    renderedDocumentId: DOCUMENT,
    renderedScanStatus: 'clean',
    ...over,
  };
}

describe('pdfLinkFor', () => {
  it('links only a clean rendered file, to this app and never to the API', () => {
    const got = pdfLinkFor(QUOTATION, version());
    expect(got).toEqual({
      kind: 'link',
      href: `/quotations/${QUOTATION}/versions/${VERSION}/document`,
    });
  });

  it('encodes both ids as single path segments', () => {
    const got = pdfLinkFor('../admin', version({ id: 'a/b' }));
    expect(got).toEqual({ kind: 'link', href: '/quotations/..%2Fadmin/versions/a%2Fb/document' });
  });

  it('offers a link for no scan status except clean', () => {
    for (const scan of DOCUMENT_VERSION_STATUSES) {
      const got = pdfLinkFor(QUOTATION, version({ renderedScanStatus: scan }));
      expect(got.kind === 'link', scan).toBe(scan === 'clean');
    }
  });

  it('never links a clean scan that has no document id', () => {
    const got = pdfLinkFor(QUOTATION, version({ renderedDocumentId: null }));
    expect(got.kind).toBe('words');
  });

  it('never links when the scan status is unknown (deny by default)', () => {
    const got = pdfLinkFor(QUOTATION, version({ renderedScanStatus: null }));
    expect(got).toEqual({ kind: 'words', text: 'Not available' });
  });

  it('says "Being scanned" while the file waits for its scan', () => {
    const got = pdfLinkFor(QUOTATION, version({ renderedScanStatus: 'quarantined' }));
    expect(got).toEqual({ kind: 'words', text: 'Being scanned' });
  });

  it('says "Being prepared" while the file is still uploading', () => {
    const got = pdfLinkFor(QUOTATION, version({ renderedScanStatus: 'awaiting_content' }));
    expect(got).toEqual({ kind: 'words', text: 'Being prepared' });
  });

  it('says "Being prepared" for an approved version the renderer has not reached yet', () => {
    const got = pdfLinkFor(
      QUOTATION,
      version({ status: 'approved', renderedDocumentId: null, renderedScanStatus: null }),
    );
    expect(got).toEqual({ kind: 'words', text: 'Being prepared' });
  });

  it('says "Not available" for every file that failed or was refused', () => {
    for (const scan of ['infected', 'rejected', 'scan_failed'] as const) {
      expect(pdfLinkFor(QUOTATION, version({ renderedScanStatus: scan })), scan).toEqual({
        kind: 'words',
        text: 'Not available',
      });
    }
  });

  it('says "PDF available after approval" for a version still before approval', () => {
    for (const status of ['draft', 'submitted', 'returned'] as const) {
      const got = pdfLinkFor(
        QUOTATION,
        version({ status, renderedDocumentId: null, renderedScanStatus: null }),
      );
      expect(got, status).toEqual({ kind: 'words', text: 'PDF available after approval' });
    }
  });

  it('says "Not available" for a version that was never rendered and will not be', () => {
    const before = ['approved', 'draft', 'submitted', 'returned'];
    for (const status of QUOTATION_STATUSES) {
      if (before.includes(status)) continue;
      const got = pdfLinkFor(
        QUOTATION,
        version({ status, renderedDocumentId: null, renderedScanStatus: null }),
      );
      expect(got, status).toEqual({ kind: 'words', text: 'Not available' });
    }
  });

  it('keeps the link and the scan words unchanged for a version before approval', () => {
    expect(pdfLinkFor(QUOTATION, version({ status: 'draft' })).kind).toBe('link');
    expect(
      pdfLinkFor(QUOTATION, version({ status: 'draft', renderedScanStatus: 'infected' })),
    ).toEqual({
      kind: 'words',
      text: 'Not available',
    });
  });
});
