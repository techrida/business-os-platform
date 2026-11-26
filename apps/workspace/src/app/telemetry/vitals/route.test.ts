import { beforeEach, describe, expect, it, vi } from 'vitest';

// Same module ids the route imports, so these mocks replace the real session and API
// client (which need Valkey and a running API).
vi.mock('@/lib/session', () => ({ getSession: vi.fn() }));
vi.mock('@/lib/api', () => ({ apiFetch: vi.fn() }));

import { apiFetch } from '@/lib/api';
import { getSession } from '@/lib/session';
import { SessionUnavailableError } from '@/lib/session-unavailable';

import { POST } from './route';

const session = { id: 's1', accessToken: 'token' };
const good = { name: 'LCP', value: 1234.5, route: '/', id: 'v5-1700000000000-1234567890123' };

const getSessionMock = vi.mocked(getSession);
const apiFetchMock = vi.mocked(apiFetch);

function post(body: BodyInit, headers: Record<string, string> = {}): Request {
  return new Request('https://app.localhost/telemetry/vitals', { method: 'POST', body, headers });
}

beforeEach(() => {
  vi.resetAllMocks();
  getSessionMock.mockResolvedValue(session as never);
  apiFetchMock.mockResolvedValue(new Response(null, { status: 202 }));
});

describe('POST /telemetry/vitals', () => {
  it('reads the session without sliding it: a vitals beacon must not keep a tab signed in', async () => {
    await POST(post(JSON.stringify(good)));
    expect(getSessionMock).toHaveBeenCalledWith({ slide: false });
  });

  it('returns 401 without a session and does not forward', async () => {
    getSessionMock.mockResolvedValue(null);
    const res = await POST(post(JSON.stringify(good)));
    expect(res.status).toBe(401);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it('returns a retryable 503 when the session store cannot answer, and does not forward', async () => {
    getSessionMock.mockRejectedValue(new SessionUnavailableError());
    const res = await POST(post(JSON.stringify(good)));
    expect(res.status).toBe(503);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it('returns 413 when Content-Length says the body is over 2048 bytes', async () => {
    const res = await POST(post(JSON.stringify(good), { 'content-length': '2049' }));
    expect(res.status).toBe(413);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it('returns 413 when the real body is over 2048 bytes and no Content-Length is sent', async () => {
    const req = post('x'.repeat(3000));
    expect(req.headers.get('content-length')).toBeNull();
    const res = await POST(req);
    expect(res.status).toBe(413);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it('returns 413 when Content-Length lies and the real body is too big', async () => {
    const res = await POST(post('x'.repeat(3000), { 'content-length': '10' }));
    expect(res.status).toBe(413);
  });

  it('returns 400 for a body that is not JSON', async () => {
    const res = await POST(post('not json'));
    expect(res.status).toBe(400);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it('returns 400 for JSON that fails VitalsSchema', async () => {
    const res = await POST(post(JSON.stringify({ ...good, name: 'FID' })));
    expect(res.status).toBe(400);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it('returns 202 and forwards only the validated fields to the API', async () => {
    const res = await POST(post(JSON.stringify({ ...good, extra: 'dropped' })));
    expect(res.status).toBe(202);
    expect(apiFetchMock).toHaveBeenCalledTimes(1);
    const [passedSession, path, init] = apiFetchMock.mock.calls[0] ?? [];
    expect(passedSession).toBe(session);
    expect(path).toBe('/v1/telemetry/vitals');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(init?.body as string)).toEqual(good);
  });

  it('returns 502 when the API rejects the sample', async () => {
    apiFetchMock.mockResolvedValue(new Response(null, { status: 500 }));
    const res = await POST(post(JSON.stringify(good)));
    expect(res.status).toBe(502);
  });

  it('returns 502 when the API cannot be reached', async () => {
    apiFetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
    const res = await POST(post(JSON.stringify(good)));
    expect(res.status).toBe(502);
  });
});
