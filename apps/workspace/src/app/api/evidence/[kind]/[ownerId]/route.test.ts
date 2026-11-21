import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/lib/api';
import type { Session } from '@/lib/session';

import { GET, POST } from './route';

// `server-only` throws outside the react-server condition, which Vitest does not use.
vi.mock('server-only', () => ({}));

const mocks = vi.hoisted(() => ({
  routeSession: vi.fn(),
  isSameOrigin: vi.fn(),
  createEvidenceDocument: vi.fn(),
  getEvidenceDocument: vi.fn(),
  uploadEvidenceContent: vi.fn(),
  removeEvidenceDocument: vi.fn(),
  getDocument: vi.fn(),
}));

// The real bff reads the environment and cookies; the route's own order of checks is what is tested.
vi.mock('@/lib/bff', () => ({
  routeSession: mocks.routeSession,
  isSameOrigin: mocks.isSameOrigin,
  forbiddenOrigin: () => Response.json({ error: { message: 'origin' } }, { status: 403 }),
  jsonResponse: (body: unknown, status = 200) => Response.json(body, { status }),
  errorResponse: (err: unknown) =>
    Response.json(
      { error: { message: 'upload failed' } },
      { status: err instanceof ApiError && err.status < 500 ? err.status : 502 },
    ),
}));
vi.mock('@/lib/api-kernel', () => ({
  createEvidenceDocument: mocks.createEvidenceDocument,
  getEvidenceDocument: mocks.getEvidenceDocument,
  uploadEvidenceContent: mocks.uploadEvidenceContent,
  removeEvidenceDocument: mocks.removeEvidenceDocument,
}));
vi.mock('@/components/p2/crm/verification-api', () => ({ getDocument: mocks.getDocument }));

const ORDER = '11111111-1111-4111-8111-111111111111';
const DOC = '33333333-3333-4333-8333-333333333333';
const VERSION = '44444444-4444-4444-8444-444444444444';
const session = { accessToken: 'secret' } as Session;
const MB = 1024 * 1024;

const uploadedVersion = {
  id: VERSION,
  documentId: DOC,
  version: 1,
  filename: 'Signed acceptance.pdf',
  sizeBytes: 7,
  detectedMime: 'application/pdf',
  declaredMime: 'application/pdf',
  status: 'quarantined',
  sha256: null,
  scanSignature: null,
  scannedAt: null,
  uploadedBy: null,
  createdAt: '2026-11-21T12:00:00.000Z',
};
const projection = {
  documentId: DOC,
  versionId: VERSION,
  filename: 'Signed acceptance.pdf',
  sizeBytes: 7,
  mimeType: 'application/pdf',
  status: 'quarantined',
};
const document = {
  id: DOC,
  ownerType: 'evidence',
  ownerId: ORDER,
  currentVersionId: null,
  versions: [uploadedVersion],
};
interface Init {
  length?: string | null;
  body?: string | null;
  name?: string | null;
  type?: string;
  kind?: string;
}

function upload(ownerId: string = ORDER, init: Init = {}): Promise<Response> {
  const body = init.body === undefined ? 'PDFDATA' : init.body;
  const headers: Record<string, string> = {
    'content-type': init.type ?? 'application/pdf',
  };
  const length = init.length === undefined ? String(body?.length ?? 0) : init.length;
  if (length !== null) headers['content-length'] = length;
  if (init.name !== null)
    headers['x-file-name'] = init.name ?? encodeURIComponent('Signed acceptance.pdf');
  return POST(
    new Request('https://app.test/api/evidence/sales-order/x', { method: 'POST', headers, body }),
    { params: Promise.resolve({ kind: init.kind ?? 'sales-order', ownerId }) },
  );
}

beforeEach(() => {
  mocks.routeSession.mockReset().mockResolvedValue(session);
  mocks.isSameOrigin.mockReset().mockReturnValue(true);
  mocks.createEvidenceDocument
    .mockReset()
    .mockResolvedValue({ documentId: DOC, versionId: VERSION, uploadPath: '/x' });
  mocks.uploadEvidenceContent.mockReset().mockResolvedValue(uploadedVersion);
  mocks.removeEvidenceDocument.mockReset().mockResolvedValue(undefined);
  mocks.getEvidenceDocument.mockReset().mockResolvedValue(document);
  mocks.getDocument.mockReset().mockResolvedValue(document);
});

describe('POST /api/evidence/:kind/:ownerId', () => {
  it.each(['sales-order', 'vendor-bill', 'rfq', 'quotation-version'])(
    'reserves evidence through the %s route, streams the bytes, and answers 201',
    async (kind) => {
      const res = await upload(ORDER, { kind });
      expect(res.status).toBe(201);
      expect(await res.json()).toEqual(projection);
      expect(mocks.createEvidenceDocument).toHaveBeenCalledWith(session, kind, ORDER, {
        filename: 'Signed acceptance.pdf',
        declaredMime: 'application/pdf',
        sizeBytes: 7,
      });
      expect(mocks.uploadEvidenceContent).toHaveBeenCalledWith(
        session,
        kind,
        ORDER,
        expect.objectContaining({ documentId: DOC, versionId: VERSION }),
        expect.objectContaining({ contentLength: 7, contentType: 'application/pdf' }),
      );
    },
  );

  it('refuses another origin before it looks at the session', async () => {
    mocks.isSameOrigin.mockReturnValue(false);
    expect((await upload()).status).toBe(403);
    expect(mocks.routeSession).not.toHaveBeenCalled();
    expect(mocks.createEvidenceDocument).not.toHaveBeenCalled();
  });

  it('returns the session response as is when nobody is signed in', async () => {
    mocks.routeSession.mockResolvedValue(
      Response.json({ error: { message: 'in' } }, { status: 401 }),
    );
    expect((await upload()).status).toBe(401);
    expect(mocks.createEvidenceDocument).not.toHaveBeenCalled();
  });

  it('refuses an owner id that is not a GUID, or a record kind it does not know, without calling the API', async () => {
    expect((await upload('not-an-order')).status).toBe(400);
    expect((await upload(ORDER, { kind: 'company_logo' })).status).toBe(400);
    expect(mocks.createEvidenceDocument).not.toHaveBeenCalled();
  });

  it.each([
    ['no announced size', { length: null }, 411],
    ['a size that is not digits', { length: '12abc' }, 411],
    ['an empty file', { body: '', length: '0' }, 400],
    ['a file over 25 MB', { length: String(25 * MB + 1) }, 413],
    ['a name that is malformed', { name: '%E0%A4%A' }, 400],
    ['a type the API does not allow', { type: '' }, 400],
  ] as [string, Init, number][])('stops %s before any API call', async (_label, init, status) => {
    expect((await upload(ORDER, init)).status).toBe(status);
    expect(mocks.createEvidenceDocument).not.toHaveBeenCalled();
    expect(mocks.uploadEvidenceContent).not.toHaveBeenCalled();
  });

  it('passes a client error from the API through and turns a 5xx into 502', async () => {
    mocks.createEvidenceDocument.mockRejectedValueOnce(new ApiError(403, 'x'));
    expect((await upload()).status).toBe(403);
    mocks.uploadEvidenceContent.mockRejectedValueOnce(new ApiError(503, 'x'));
    expect((await upload()).status).toBe(502);
  });

  const refusal = (status: number, code: string) =>
    new ApiError(status, 'x', { error: { code, message: 'm', correlationId: 'c' } });

  it.each([
    ['the create', 'createEvidenceDocument'],
    ['the bytes', 'uploadEvidenceContent'],
  ] as const)(
    'words a 409 on %s for any record, never as a memo, and asks for a reload',
    async (_label, step) => {
      mocks[step].mockRejectedValueOnce(refusal(409, 'conflict'));
      const res = await upload();
      expect(res.status).toBe(409);
      const body = (await res.json()) as { error: { message: string; reload: boolean } };
      expect(body.error.message).toBe(
        'This record no longer takes evidence files. Reload it to see where it stands.',
      );
      expect(body.error.message).not.toMatch(/memo|attachment/i);
      expect(body.error.reload).toBe(true);
    },
  );

  it('words a 422 invalid_evidence_document for any record', async () => {
    mocks.uploadEvidenceContent.mockRejectedValueOnce(refusal(422, 'invalid_evidence_document'));
    const res = await upload();
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toBe(
      'This file could not be kept as evidence for this record. Upload it again.',
    );
  });

  it('removes the reserved file through the record route when its bytes fail, and keeps the failure', async () => {
    mocks.uploadEvidenceContent.mockRejectedValueOnce(new ApiError(415, 'x'));
    expect((await upload(ORDER, { kind: 'vendor-bill' })).status).toBe(415);
    expect(mocks.removeEvidenceDocument).toHaveBeenCalledWith(session, 'vendor-bill', ORDER, DOC);

    // Best effort: a failed removal does not replace the upload's own failure.
    mocks.removeEvidenceDocument.mockClear().mockRejectedValueOnce(new ApiError(503, 'x'));
    mocks.uploadEvidenceContent.mockRejectedValueOnce(refusal(409, 'conflict'));
    expect((await upload()).status).toBe(409);
    expect(mocks.removeEvidenceDocument).toHaveBeenCalledTimes(1);

    // Nothing was reserved when the create itself failed, and a finished upload is kept.
    mocks.removeEvidenceDocument.mockClear();
    mocks.createEvidenceDocument.mockRejectedValueOnce(new ApiError(403, 'x'));
    expect((await upload()).status).toBe(403);
    expect((await upload()).status).toBe(201);
    expect(mocks.removeEvidenceDocument).not.toHaveBeenCalled();
  });
});

function status(documentId: string, versionId: string, kind = 'sales-order'): Promise<Response> {
  return GET(
    new Request(
      `https://app.test/api/evidence/${kind}/${ORDER}?documentId=${documentId}&versionId=${versionId}`,
    ),
    { params: Promise.resolve({ kind, ownerId: ORDER }) },
  );
}

describe('GET /api/evidence/:kind/:ownerId', () => {
  it.each(['sales-order', 'vendor-bill', 'rfq', 'quotation-version'])(
    'reads %s scan status through the record route, not GET /v1/documents/:id',
    async (kind) => {
      const response = await upload(ORDER, { kind });
      const { documentId, versionId } = (await response.json()) as typeof projection;
      expect(await (await status(documentId, versionId, kind)).json()).toEqual(projection);
      mocks.getEvidenceDocument.mockResolvedValueOnce({
        ...document,
        versions: [{ ...uploadedVersion, status: 'infected' }],
      });
      expect(await (await status(documentId, versionId, kind)).json()).toEqual({
        ...projection,
        status: 'infected',
      });
      expect(mocks.getEvidenceDocument).toHaveBeenCalledWith(session, kind, ORDER, DOC);
      expect(mocks.getDocument).not.toHaveBeenCalled();
    },
  );

  it('refuses a file of another record, of another owner type, or another version', async () => {
    mocks.getEvidenceDocument.mockResolvedValueOnce({ ...document, ownerId: VERSION });
    expect((await status(DOC, VERSION)).status).toBe(404);
    mocks.getEvidenceDocument.mockResolvedValueOnce({ ...document, ownerType: 'company_logo' });
    expect((await status(DOC, VERSION)).status).toBe(404);
    expect((await status(DOC, ORDER)).status).toBe(404);
    expect(mocks.getDocument).not.toHaveBeenCalled();
  });

  it('refuses malformed ids and an unknown kind before the API, and passes a refusal through', async () => {
    expect((await status('x', VERSION)).status).toBe(400);
    expect((await status(DOC, VERSION, 'verification_case')).status).toBe(400);
    expect(mocks.getEvidenceDocument).not.toHaveBeenCalled();
    mocks.getEvidenceDocument.mockRejectedValueOnce(new ApiError(403, 'forbidden'));
    expect((await status(DOC, VERSION)).status).toBe(403);
    expect(mocks.getDocument).not.toHaveBeenCalled();
  });
});
