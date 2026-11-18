import { describe, expect, it } from 'vitest';

import { DocumentSchema, downloadHref, fileOf, previewHref } from './verification-file';

const DOC = '11111111-1111-4111-8111-111111111111';
const V1 = '22222222-2222-4222-8222-222222222222';
const V2 = '33333333-3333-4333-8333-333333333333';

const version = (id: string, n: number, status: string, filename = `cert-${n}.pdf`) => ({
  id,
  documentId: DOC,
  version: n,
  filename,
  declaredMime: 'application/pdf',
  detectedMime: 'application/pdf',
  sizeBytes: 2048,
  sha256: null,
  status,
  scanSignature: null,
  scannedAt: null,
  uploadedBy: null,
  createdAt: '2026-11-01T08:00:00.000Z',
});

const parse = (body: object) =>
  DocumentSchema.parse({
    ownerType: 'verification_case',
    ownerId: V1,
    ...body,
  });

describe('fileOf', () => {
  it('projects the newest eligible version of the document as the API answers it', () => {
    const doc = parse({
      id: DOC,
      ownerType: 'verification_case',
      ownerId: V1,
      currentVersionId: V2,
      createdAt: '2026-11-01T08:00:00.000Z',
      versions: [version(V1, 1, 'infected'), version(V2, 2, 'clean')],
    });
    expect(fileOf(doc)).toEqual({
      documentId: DOC,
      versionId: V2,
      filename: 'cert-2.pdf',
      sizeBytes: 2048,
      mimeType: 'application/pdf',
      status: 'clean',
    });
  });

  it('falls back to the newest version that was not rejected when no current one is named', () => {
    const doc = parse({
      id: DOC,
      currentVersionId: null,
      versions: [version(V1, 1, 'clean'), version(V2, 2, 'rejected')],
    });
    expect(fileOf(doc)?.versionId).toBe(V1);
  });

  it('shows the newest candidate while the current clean version is older', () => {
    const doc = parse({
      id: DOC,
      currentVersionId: V1,
      versions: [version(V1, 1, 'clean'), version(V2, 2, 'quarantined')],
    });
    expect(fileOf(doc)).toMatchObject({ versionId: V2, status: 'quarantined' });
  });

  it('is null for a document with no usable version', () => {
    expect(fileOf(parse({ id: DOC, currentVersionId: null, versions: [] }))).toBeNull();
  });

  it('keeps the scan status, so the page can hold the link back until the scan passed', () => {
    const doc = parse({
      id: DOC,
      currentVersionId: V1,
      versions: [version(V1, 1, 'quarantined')],
    });
    expect(fileOf(doc)?.status).toBe('quarantined');
  });
});

describe('DocumentSchema', () => {
  it('refuses an answer without versions, so drift fails instead of rendering undefined', () => {
    expect(DocumentSchema.safeParse({ id: DOC, currentVersionId: null }).success).toBe(false);
  });
});

describe('downloadHref', () => {
  it('points at the existing signed-link download route', () => {
    expect(downloadHref({ documentId: DOC, versionId: V2 })).toBe(
      `/api/documents/${DOC}/versions/${V2}/download`,
    );
  });
});

it('uses the same-origin P1 preview route for the selected version', () => {
  expect(previewHref({ documentId: DOC, versionId: V2 })).toBe(
    `/api/documents/${DOC}/versions/${V2}/preview`,
  );
});
