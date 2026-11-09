import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/lib/api';
import type { Session } from '@/lib/session';

import { POST } from './route';

// `server-only` throws outside the react-server condition, which Vitest does not use.
vi.mock('server-only', () => ({}));

const mocks = vi.hoisted(() => ({
  routeSession: vi.fn(),
  isSameOrigin: vi.fn(),
  createBankEvidence: vi.fn(),
  uploadBankEvidenceContent: vi.fn(),
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
vi.mock('@/lib/api-vendors', () => ({
  createBankEvidence: mocks.createBankEvidence,
  uploadBankEvidenceContent: mocks.uploadBankEvidenceContent,
}));

const VENDOR = '11111111-1111-4111-8111-111111111111';
const ACCOUNT = '22222222-2222-4222-8222-222222222222';
const DOC = '33333333-3333-4333-8333-333333333333';
const VERSION = '44444444-4444-4444-8444-444444444444';
const UPLOAD_PATH = `/v1/vendors/${VENDOR}/bank-accounts/${ACCOUNT}/evidence/${DOC}/versions/${VERSION}/content`;
const session = { accessToken: 'secret' } as Session;
const MB = 1024 * 1024;

interface Init {
  length?: string | null;
  body?: string | null;
  name?: string | null;
  type?: string;
}

function upload(ids: { id?: string; accountId?: string } = {}, init: Init = {}): Promise<Response> {
  const body = init.body === undefined ? 'PDFDATA' : init.body;
  const headers: Record<string, string> = {
    'content-type': init.type ?? 'application/pdf',
  };
  const length = init.length === undefined ? String(body?.length ?? 0) : init.length;
  if (length !== null) headers['content-length'] = length;
  if (init.name !== null) headers['x-file-name'] = init.name ?? encodeURIComponent('Call-back.pdf');
  return POST(
    new Request('https://app.test/vendors/x/bank-accounts/y/evidence', {
      method: 'POST',
      headers,
      body,
    }),
    { params: Promise.resolve({ id: ids.id ?? VENDOR, accountId: ids.accountId ?? ACCOUNT }) },
  );
}

beforeEach(() => {
  mocks.routeSession.mockReset().mockResolvedValue(session);
  mocks.isSameOrigin.mockReset().mockReturnValue(true);
  mocks.createBankEvidence
    .mockReset()
    .mockResolvedValue({ documentId: DOC, versionId: VERSION, uploadPath: UPLOAD_PATH });
  mocks.uploadBankEvidenceContent.mockReset().mockResolvedValue({ id: VERSION });
});

describe('POST /vendors/:id/bank-accounts/:accountId/evidence', () => {
  it('declares the file on the vendor evidence route, streams the bytes, and answers 201 with the ids', async () => {
    const res = await upload();
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ documentId: DOC, versionId: VERSION });
    expect(mocks.createBankEvidence).toHaveBeenCalledWith(session, VENDOR, ACCOUNT, {
      filename: 'Call-back.pdf',
      declaredMime: 'application/pdf',
      sizeBytes: 7,
    });
    expect(mocks.uploadBankEvidenceContent).toHaveBeenCalledWith(
      session,
      VENDOR,
      ACCOUNT,
      { documentId: DOC, versionId: VERSION, uploadPath: UPLOAD_PATH },
      expect.objectContaining({ contentLength: 7, contentType: 'application/pdf' }),
    );
  });

  it('refuses another origin before it looks at the session', async () => {
    mocks.isSameOrigin.mockReturnValue(false);
    expect((await upload()).status).toBe(403);
    expect(mocks.routeSession).not.toHaveBeenCalled();
    expect(mocks.createBankEvidence).not.toHaveBeenCalled();
  });

  it('returns the session response as is when nobody is signed in', async () => {
    mocks.routeSession.mockResolvedValue(
      Response.json({ error: { message: 'in' } }, { status: 401 }),
    );
    expect((await upload()).status).toBe(401);
    expect(mocks.createBankEvidence).not.toHaveBeenCalled();
  });

  it.each([
    ['vendor', { id: 'not-a-vendor' }],
    ['account', { accountId: 'not-an-account' }],
  ])('refuses a %s id that is not a GUID without calling the API', async (_label, ids) => {
    expect((await upload(ids)).status).toBe(400);
    expect(mocks.createBankEvidence).not.toHaveBeenCalled();
  });

  it.each([
    ['no announced size', { length: null }, 411],
    ['a size that is not digits', { length: '12abc' }, 411],
    ['an empty file', { body: '', length: '0' }, 400],
    ['a file over 25 MB', { length: String(25 * MB + 1) }, 413],
    ['a name that is malformed', { name: '%E0%A4%A' }, 400],
    ['a type the API does not allow', { type: '' }, 400],
  ] as [string, Init, number][])('stops %s before any API call', async (_label, init, status) => {
    expect((await upload({}, init)).status).toBe(status);
    expect(mocks.createBankEvidence).not.toHaveBeenCalled();
    expect(mocks.uploadBankEvidenceContent).not.toHaveBeenCalled();
  });

  it('accepts a file of exactly 25 MB by its announced size', async () => {
    expect((await upload({}, { length: String(25 * MB) })).status).toBe(201);
  });

  it('passes a client error from the API through and turns a 5xx into 502', async () => {
    mocks.createBankEvidence.mockRejectedValueOnce(new ApiError(409, 'x'));
    expect((await upload()).status).toBe(409);
    mocks.uploadBankEvidenceContent.mockRejectedValueOnce(new ApiError(503, 'x'));
    expect((await upload()).status).toBe(502);
  });
});
