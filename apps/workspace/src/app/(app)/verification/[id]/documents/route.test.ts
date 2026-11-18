import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/lib/api';
import type { Session } from '@/lib/session';

import { GET, POST } from './route';

// `server-only` throws outside the react-server condition, which Vitest does not use.
vi.mock('server-only', () => ({}));

const mocks = vi.hoisted(() => ({
  routeSession: vi.fn(),
  isSameOrigin: vi.fn(),
  createDocument: vi.fn(),
  uploadDocumentContent: vi.fn(),
  getVerificationCase: vi.fn(),
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
  createDocument: mocks.createDocument,
  uploadDocumentContent: mocks.uploadDocumentContent,
}));

vi.mock('@/components/p2/crm/verification-api', () => ({ getDocument: mocks.getDocument }));
vi.mock('@/components/p2/customers/api', () => ({
  getVerificationCase: mocks.getVerificationCase,
}));

const CASE = '11111111-1111-4111-8111-111111111111';
const DOC = '33333333-3333-4333-8333-333333333333';
const VERSION = '44444444-4444-4444-8444-444444444444';
const session = { accessToken: 'secret' } as Session;
const MB = 1024 * 1024;

const uploadedVersion = {
  id: VERSION,
  documentId: DOC,
  version: 1,
  filename: 'PAN certificate.pdf',
  sizeBytes: 7,
  detectedMime: 'application/pdf',
  declaredMime: 'application/pdf',
  status: 'quarantined',
  sha256: null,
  scanSignature: null,
  scannedAt: null,
  uploadedBy: null,
  createdAt: '2026-11-18T12:00:00.000Z',
};
const projection = {
  documentId: DOC,
  versionId: VERSION,
  filename: 'PAN certificate.pdf',
  sizeBytes: 7,
  mimeType: 'application/pdf',
  status: 'quarantined',
};
const document = {
  id: DOC,
  ownerType: 'verification_case',
  ownerId: CASE,
  currentVersionId: null,
  versions: [uploadedVersion],
};
interface Init {
  length?: string | null;
  body?: string | null;
  name?: string | null;
  type?: string;
}

function upload(id: string = CASE, init: Init = {}): Promise<Response> {
  const body = init.body === undefined ? 'PDFDATA' : init.body;
  const headers: Record<string, string> = {
    'content-type': init.type ?? 'application/pdf',
  };
  const length = init.length === undefined ? String(body?.length ?? 0) : init.length;
  if (length !== null) headers['content-length'] = length;
  if (init.name !== null)
    headers['x-file-name'] = init.name ?? encodeURIComponent('PAN certificate.pdf');
  return POST(
    new Request('https://app.test/verification/x/documents', { method: 'POST', headers, body }),
    {
      params: Promise.resolve({ id }),
    },
  );
}

beforeEach(() => {
  mocks.routeSession.mockReset().mockResolvedValue(session);
  mocks.isSameOrigin.mockReset().mockReturnValue(true);
  mocks.createDocument
    .mockReset()
    .mockResolvedValue({ documentId: DOC, versionId: VERSION, uploadPath: '/x' });
  mocks.uploadDocumentContent.mockReset().mockResolvedValue(uploadedVersion);
  mocks.getDocument.mockReset().mockResolvedValue(document);
  mocks.getVerificationCase.mockReset().mockResolvedValue({ id: CASE });
});

describe('POST /verification/:id/documents', () => {
  it('reserves a document owned by the case, streams the bytes, and answers 201 with the ids', async () => {
    const res = await upload();
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual(projection);
    expect(mocks.createDocument).toHaveBeenCalledWith(session, {
      ownerType: 'verification_case',
      ownerId: CASE,
      filename: 'PAN certificate.pdf',
      declaredMime: 'application/pdf',
      sizeBytes: 7,
    });
    expect(mocks.uploadDocumentContent).toHaveBeenCalledWith(
      session,
      expect.objectContaining({ documentId: DOC, versionId: VERSION }),
      expect.objectContaining({ contentLength: 7, contentType: 'application/pdf' }),
    );
  });

  it('refuses another origin before it looks at the session', async () => {
    mocks.isSameOrigin.mockReturnValue(false);
    expect((await upload()).status).toBe(403);
    expect(mocks.routeSession).not.toHaveBeenCalled();
    expect(mocks.createDocument).not.toHaveBeenCalled();
  });

  it('returns the session response as is when nobody is signed in', async () => {
    mocks.routeSession.mockResolvedValue(
      Response.json({ error: { message: 'in' } }, { status: 401 }),
    );
    expect((await upload()).status).toBe(401);
    expect(mocks.createDocument).not.toHaveBeenCalled();
  });

  it('refuses an id that is not a GUID without calling the API', async () => {
    expect((await upload('not-a-case')).status).toBe(400);
    expect(mocks.createDocument).not.toHaveBeenCalled();
  });

  it.each([
    ['no announced size', { length: null }, 411],
    ['a size that is not digits', { length: '12abc' }, 411],
    ['an empty file', { body: '', length: '0' }, 400],
    ['a file over 25 MB', { length: String(25 * MB + 1) }, 413],
    ['a name that is malformed', { name: '%E0%A4%A' }, 400],
    ['a type the API does not allow', { type: '' }, 400],
  ] as [string, Init, number][])('stops %s before any API call', async (_label, init, status) => {
    expect((await upload(CASE, init)).status).toBe(status);
    expect(mocks.createDocument).not.toHaveBeenCalled();
    expect(mocks.uploadDocumentContent).not.toHaveBeenCalled();
  });

  it('accepts a file of exactly 25 MB by its announced size', async () => {
    expect((await upload(CASE, { length: String(25 * MB) })).status).toBe(201);
  });

  it('passes a client error from the API through and turns a 5xx into 502', async () => {
    mocks.createDocument.mockRejectedValueOnce(new ApiError(403, 'x'));
    expect((await upload()).status).toBe(403);
    mocks.uploadDocumentContent.mockRejectedValueOnce(new ApiError(503, 'x'));
    expect((await upload()).status).toBe(502);
  });
});

function status(documentId: string, versionId: string): Promise<Response> {
  return GET(
    new Request(
      `https://app.test/verification/${CASE}/documents?documentId=${documentId}&versionId=${versionId}`,
    ),
    { params: Promise.resolve({ id: CASE }) },
  );
}

describe('GET /verification/:id/documents', () => {
  it('projects the fresh status of the exact version returned by the upload', async () => {
    const response = await upload();
    const { documentId, versionId } = (await response.json()) as typeof projection;
    expect(await (await status(documentId, versionId)).json()).toEqual(projection);
    mocks.getDocument.mockResolvedValueOnce({
      ...document,
      versions: [{ ...uploadedVersion, status: 'clean' }],
    });
    expect(await (await status(documentId, versionId)).json()).toEqual({
      ...projection,
      status: 'clean',
    });
    expect(mocks.getVerificationCase).toHaveBeenCalledWith(session, CASE);
  });

  it('refuses a document from another case, a different version, or a no-longer-readable case', async () => {
    mocks.getDocument.mockResolvedValueOnce({ ...document, ownerId: VERSION });
    expect((await status(DOC, VERSION)).status).toBe(404);
    expect((await status(DOC, CASE)).status).toBe(404);
    mocks.getVerificationCase.mockRejectedValueOnce(new ApiError(403, 'forbidden'));
    expect((await status(DOC, VERSION)).status).toBe(403);
    expect(mocks.getDocument).toHaveBeenCalledTimes(2);
  });
});
