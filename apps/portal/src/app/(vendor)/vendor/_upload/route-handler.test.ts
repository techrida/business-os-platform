import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SESSION_UNAVAILABLE_MESSAGE, SessionUnavailableError } from '@/lib/session-unavailable';
import type { Session } from '@/lib/session';

import { callOf, DOC, json, stubPortalEnv, VER, vendorSession } from './test-kit';

vi.mock('server-only', () => ({}));
const getSession = vi.fn<() => Promise<Session | null>>();
vi.mock('@/lib/session', () => ({ getSession: () => getSession() }));

const { POST: postKyc } = await import('../onboarding/upload/file/route');
const { POST: postBill } = await import('../bills/new/file/route');
const { UPLOAD_MIME, fileProblem } = await import('./rules');

const fetchMock = vi.fn<typeof fetch>();
const ORIGIN = 'https://app.test';

const pathFor = (kind: string) => `/v1/portal/vendor/${kind}/files/${DOC}/versions/${VER}/content`;

function upload(
  over: { origin?: string | null; headers?: Record<string, string>; body?: string | null } = {},
): Request {
  const headers: Record<string, string> = {
    'content-type': 'application/pdf',
    'content-length': '8',
    'x-file-name': encodeURIComponent('PAN certificate.pdf'),
    ...(over.origin === null ? {} : { origin: over.origin ?? ORIGIN }),
    ...over.headers,
  };
  return new Request('https://app.test/vendor/upload/file', {
    method: 'POST',
    headers,
    body: over.body === null ? null : (over.body ?? '%PDF-1.7'),
  });
}

beforeEach(() => {
  stubPortalEnv();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  getSession.mockReset();
  getSession.mockResolvedValue(vendorSession());
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const started = (kind: string, over: Record<string, string> = {}) =>
  json({ documentId: DOC, versionId: VER, uploadPath: pathFor(kind), ...over }, 201);

describe.each([
  ['KYC', postKyc, 'kyc-documents'],
  ['bill', postBill, 'bill-submissions'],
] as const)('%s upload route', (_name, post, kind) => {
  it('streams the file to this kind and answers only the document id and the name', async () => {
    fetchMock.mockResolvedValueOnce(started(kind)).mockResolvedValueOnce(json({}, 200));
    const res = await post(upload());
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const answer = (await res.json()) as Record<string, unknown>;
    expect(answer).toEqual({ documentId: DOC, filename: 'PAN certificate.pdf' });
    expect(JSON.stringify(answer)).not.toContain(VER);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const declare = callOf(fetchMock, 0);
    expect(declare.url).toBe(`http://api:3001/v1/portal/vendor/${kind}/files`);
    expect(declare.body).toEqual({
      filename: 'PAN certificate.pdf',
      declaredMime: 'application/pdf',
      sizeBytes: 8,
    });
    const put = callOf(fetchMock, 1);
    expect(put.url).toBe(`http://api:3001${pathFor(kind)}`);
    // The bytes go on as the request stream, not as a buffered copy.
    expect(put.init.body).toBeInstanceOf(ReadableStream);
    expect((put.init as { duplex?: string }).duplex).toBe('half');
    expect(put.headers.get('authorization')).toBe('Bearer eyJ.secret-access-token.sig');
  });

  it('refuses a missing or foreign Origin before reading the session or calling the API', async () => {
    for (const origin of [null, 'https://evil.test', 'null']) {
      const res = await post(upload({ origin }));
      expect(res.status).toBe(403);
    }
    expect(getSession).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns a retryable session outage before accessing the API', async () => {
    getSession.mockRejectedValue(new SessionUnavailableError());
    const res = await post(upload());
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('1');
    expect(res.headers.get('cache-control')).toContain('no-store');
    expect(await res.json()).toEqual({ error: SESSION_UNAVAILABLE_MESSAGE });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('answers 401 without a session and calls nothing', async () => {
    getSession.mockResolvedValue(null);
    expect((await post(upload())).status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // The layout's vendor check does not run for a route handler, so the handler checks for itself.
  it.each(['customer', 'staff'] as const)(
    'answers 403 to a %s session without any API call',
    async (kindOfOrg) => {
      getSession.mockResolvedValue(vendorSession(kindOfOrg as Session['orgKind']));
      expect((await post(upload())).status).toBe(403);
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it('refuses a bad name, a missing size, a wrong type, an empty or oversized file before the API', async () => {
    const cases: [Request, number][] = [
      [upload({ headers: { 'x-file-name': '%E0%A4%A' } }), 400],
      [upload({ headers: { 'content-length': '' } }), 411],
      [upload({ headers: { 'content-type': 'text/html' } }), 422],
      [upload({ headers: { 'content-length': '0' } }), 422],
      [upload({ headers: { 'content-length': String(26_214_401) } }), 422],
      [upload({ headers: { 'x-file-name': encodeURIComponent('../etc/passwd') } }), 422],
      [upload({ body: null, headers: { 'content-length': '5' } }), 422],
    ];
    for (const [req, status] of cases) expect((await post(req)).status).toBe(status);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses an upload path the API should not have sent, and never sends the bytes', async () => {
    fetchMock.mockResolvedValueOnce(started(kind, { uploadPath: 'https://evil.test/x' }));
    const res = await post(upload());
    expect(res.status).toBe(502);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('answers in its own words, whatever the API said', async () => {
    const cases: [number, number][] = [
      [403, 403],
      [413, 413],
      [415, 415],
      [422, 422],
      [500, 502],
    ];
    for (const [apiStatus, ours] of cases) {
      fetchMock.mockReset();
      fetchMock.mockResolvedValueOnce(
        json({ error: { code: 'x', message: 'internal-detail 00000000' } }, apiStatus),
      );
      const res = await post(upload());
      expect(res.status).toBe(ours);
      expect(await res.text()).not.toContain('internal-detail');
    }
  });
});

describe('file rules', () => {
  it('accept a PDF and the pictures, and nothing else', () => {
    expect([...UPLOAD_MIME].sort()).toEqual(
      ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'].sort(),
    );
    expect(fileProblem({ name: 'a.pdf', type: 'application/pdf', size: 1 })).toBeNull();
    expect(fileProblem({ name: 'a.csv', type: 'text/csv', size: 1 })).toMatch(/not a PDF/);
  });
});
