import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/lib/api';
import type { Session } from '@/lib/session';
import { SESSION_UNAVAILABLE_MESSAGE, sessionUnavailableResponse } from '@/lib/session-unavailable';

import { fetchSignedLink, signedFileResponse } from './signed-file-route';

// `server-only` throws outside the react-server condition, which Vitest does not use.
vi.mock('server-only', () => ({}));

const mocks = vi.hoisted(() => ({
  routeSession: vi.fn(),
  apiFetch: vi.fn(),
  openSignedFile: vi.fn(),
}));

vi.mock('@/lib/bff', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/bff')>()),
  routeSession: mocks.routeSession,
}));
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  apiFetch: mocks.apiFetch,
}));
vi.mock('@/lib/api-kernel', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api-kernel')>()),
  openSignedFile: mocks.openSignedFile,
}));

const session = { accessToken: 'eyJ.secret-access-token.sig' } as Session;
const LINK = { url: '/v1/files/abc.def', expiresAt: '2026-11-08T05:46:00.000Z' };

const issueLink = vi.fn();

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function pdf(): Response {
  return new Response('%PDF-1.7', {
    headers: {
      'content-type': 'application/pdf',
      'content-disposition': 'attachment; filename="a.pdf"',
      'content-length': '8',
      'content-security-policy': "sandbox; default-src 'none'",
      'set-cookie': 'leak=1',
    },
  });
}

beforeEach(() => {
  mocks.routeSession.mockReset().mockResolvedValue(session);
  mocks.apiFetch.mockReset().mockResolvedValue(json(200, LINK));
  mocks.openSignedFile.mockReset().mockResolvedValue(pdf());
  issueLink.mockReset().mockResolvedValue(LINK);
});

describe('signedFileResponse', () => {
  it('issues exactly one link and opens it with the session', async () => {
    const res = await signedFileResponse({ mode: 'download', issueLink });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('%PDF-1.7');
    expect(issueLink).toHaveBeenCalledTimes(1);
    expect(issueLink).toHaveBeenCalledWith(session);
    expect(mocks.openSignedFile).toHaveBeenCalledTimes(1);
    expect(mocks.openSignedFile).toHaveBeenCalledWith(session, LINK);
  });

  it('rejects invalid input before reading the session or issuing a link', async () => {
    const res = await signedFileResponse({ mode: 'download', invalid: 'Bad id.', issueLink });
    expect(res.status).toBe(400);
    expect(res.headers.get('content-type')).toContain('text/plain');
    expect(await res.text()).toBe('Bad id.');
    expect(mocks.routeSession).not.toHaveBeenCalled();
    expect(issueLink).not.toHaveBeenCalled();
  });

  it('treats an empty or null invalid as valid', async () => {
    expect((await signedFileResponse({ mode: 'download', invalid: null, issueLink })).status).toBe(
      200,
    );
  });

  it('never issues a link without a session', async () => {
    mocks.routeSession.mockResolvedValue(json(401, {}));
    await signedFileResponse({ mode: 'download', issueLink });
    mocks.routeSession.mockResolvedValue(json(403, {}));
    await signedFileResponse({ mode: 'download', issueLink });
    expect(issueLink).not.toHaveBeenCalled();
    expect(mocks.openSignedFile).not.toHaveBeenCalled();
  });

  it('asks a signed-out visitor to sign in, using the mode or the given verb', async () => {
    mocks.routeSession.mockResolvedValue(json(401, {}));
    const a = await signedFileResponse({ mode: 'preview', issueLink });
    expect(a.status).toBe(401);
    expect(await a.text()).toBe('Sign in to preview this file.');
    const b = await signedFileResponse({ mode: 'preview', signInVerb: 'view', issueLink });
    expect(await b.text()).toBe('Sign in to view this file.');
  });

  it('answers 403 with "Staff only."', async () => {
    mocks.routeSession.mockResolvedValue(json(403, {}));
    const res = await signedFileResponse({ mode: 'download', issueLink });
    expect(res.status).toBe(403);
    expect(await res.text()).toBe('Staff only.');
  });

  it('answers a session outage with a retryable 503', async () => {
    mocks.routeSession.mockResolvedValue(sessionUnavailableResponse());
    const res = await signedFileResponse({ mode: 'download', issueLink });
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('1');
    expect(res.headers.get('cache-control')).toContain('no-store');
    expect(await res.text()).toBe(SESSION_UNAVAILABLE_MESSAGE);
    expect(issueLink).not.toHaveBeenCalled();
  });

  it.each([
    ['download', 409, 'This PDF is still being prepared.'],
    ['preview', 409, 'This PDF is still being prepared.'],
    ['download', 424, 'The PDF could not be prepared.'],
    ['preview', 424, 'The PDF could not be prepared.'],
    ['download', 404, 'This PDF is not available.'],
    ['preview', 404, 'This PDF is not available.'],
    ['preview', 410, 'This PDF is not available.'],
  ] as const)('says the right plain words to %s on a %i', async (mode, status, message) => {
    issueLink.mockRejectedValue(new ApiError(status, 'nope'));
    const res = await signedFileResponse({ mode, issueLink });
    expect(res.status).toBe(status);
    expect(res.headers.get('content-type')).toContain('text/plain');
    const text = await res.text();
    expect(text).toBe(message);
    expect(text).not.toMatch(/scan/i);
    expect(issueLink).toHaveBeenCalledTimes(1);
    expect(mocks.openSignedFile).not.toHaveBeenCalled();
  });

  it('keeps other 4xx statuses and turns the rest into 502 without the token', async () => {
    issueLink.mockRejectedValueOnce(new ApiError(422, 'bad'));
    expect((await signedFileResponse({ mode: 'download', issueLink })).status).toBe(422);
    issueLink.mockRejectedValueOnce(new ApiError(500, 'boom'));
    const res = await signedFileResponse({ mode: 'download', issueLink });
    expect(res.status).toBe(502);
    expect(await res.text()).not.toContain(session.accessToken);
  });

  it('keeps a 503 db_busy and its wait instead of calling it a gateway fault', async () => {
    issueLink.mockRejectedValueOnce(
      new ApiError(503, 'busy', {
        error: { code: 'db_busy', message: 'Busy', details: { retryAfterSeconds: 2 } },
      }),
    );
    const res = await signedFileResponse({ mode: 'download', issueLink });
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('2');
    expect(res.headers.get('content-type')).toContain('text/plain');
    expect(await res.text()).toBe('Busy, please try again.');
    // Any other 503 is still a gateway fault.
    issueLink.mockRejectedValueOnce(new ApiError(503, 'down', { error: { code: 'other' } }));
    expect((await signedFileResponse({ mode: 'download', issueLink })).status).toBe(502);
  });

  it('passes the safe headers of a download through', async () => {
    const res = await signedFileResponse({ mode: 'download', issueLink });
    expect(res.headers.get('content-type')).toBe('application/pdf');
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="a.pdf"');
    expect(res.headers.get('content-length')).toBe('8');
    expect(res.headers.get('content-security-policy')).toBe("sandbox; default-src 'none'");
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('serves a preview inline with no sandbox policy and no cookie', async () => {
    const res = await signedFileResponse({ mode: 'preview', issueLink });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toBe('inline');
    expect(res.headers.get('content-security-policy')).toBeNull();
    expect(res.headers.get('content-type')).toBe('application/pdf');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(await res.text()).toBe('%PDF-1.7');
  });

  it('refuses to preview a non-PDF with 415 and cancels its body', async () => {
    const cancel = vi.fn().mockResolvedValue(undefined);
    const file = new Response('<script>unexpected()</script>', {
      headers: { 'content-type': 'text/html' },
    });
    vi.spyOn(file.body as ReadableStream, 'cancel').mockImplementation(cancel);
    mocks.openSignedFile.mockResolvedValue(file);
    const res = await signedFileResponse({ mode: 'preview', issueLink });
    expect(res.status).toBe(415);
    expect(await res.text()).toBe('This file cannot be previewed.');
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('still downloads a non-PDF type unchanged', async () => {
    mocks.openSignedFile.mockResolvedValue(
      new Response('x', { headers: { 'content-type': 'image/png' } }),
    );
    const res = await signedFileResponse({ mode: 'download', issueLink });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
  });
});

describe('fetchSignedLink', () => {
  it('GETs the path through apiFetch and parses the link', async () => {
    expect(await fetchSignedLink(session, '/v1/x/document')).toEqual(LINK);
    expect(mocks.apiFetch).toHaveBeenCalledWith(session, '/v1/x/document', { method: 'GET' });
  });

  it('throws the API status for a failed call', async () => {
    mocks.apiFetch.mockResolvedValue(json(409, { error: { code: 'not_clean' } }));
    await expect(fetchSignedLink(session, '/v1/x')).rejects.toMatchObject({ status: 409 });
  });

  it('throws 502 for a body that breaks the contract', async () => {
    mocks.apiFetch.mockResolvedValue(json(200, { url: '' }));
    await expect(fetchSignedLink(session, '/v1/x')).rejects.toMatchObject({ status: 502 });
  });
});
