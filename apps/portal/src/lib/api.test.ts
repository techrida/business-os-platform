import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { ApiError, apiFetch, getMe } from './api';
import { __resetEnvForTests } from './env';
import type { Session } from './session';

// The browser request the BFF is serving. Tests set what Caddy would have passed on.
const incomingHeaders = vi.hoisted(() => vi.fn<() => Promise<Headers>>());
vi.mock('next/headers', () => ({ headers: incomingHeaders }));

/** The shape the pages and route handlers already recognise as "busy, try again". */
const BUSY_BODY = z.object({
  error: z.object({
    code: z.literal('db_busy'),
    message: z.string(),
    correlationId: z.string().min(1),
    details: z.object({ retryAfterSeconds: z.number() }),
  }),
});

// `server-only` throws outside the react-server condition, which Vitest does not use.
vi.mock('server-only', () => ({}));

const TOKEN = 'eyJ.secret-access-token.sig';

const session: Session = {
  id: 'A'.repeat(43),
  sub: 'user-1',
  orgId: '00000000-0000-4000-8000-000000000002',
  orgKind: 'customer',
  partyId: '00000000-0000-4000-8000-0000000000aa',
  roles: [],
  accessToken: TOKEN,
  refreshToken: 'secret-refresh-token',
  accessExp: 2_000_000_000,
  createdAt: 1_700_000_000,
  lastSeenAt: 1_700_000_000,
};

const validMe = {
  userId: '312345678901234567',
  tenantId: '00000000-0000-4000-8000-000000000001',
  organizationId: '00000000-0000-4000-8000-000000000002',
  orgKind: 'staff',
  roles: ['founder'],
  correlationId: 'req-12345678',
};

const fetchMock = vi.fn<typeof fetch>();

function lastCall(): { url: string; init: RequestInit; headers: Headers } {
  const [url, init] = fetchMock.mock.calls.at(-1) ?? [];
  const requestInit = init ?? {};
  const href = url instanceof Request ? url.url : url instanceof URL ? url.href : (url ?? '');
  return { url: href, init: requestInit, headers: new Headers(requestInit.headers) };
}

beforeEach(() => {
  vi.stubEnv('API_INTERNAL_URL', 'http://api:3001');
  for (const [k, v] of Object.entries({
    OIDC_ISSUER: 'https://auth.test',
    OIDC_CLIENT_ID: 'client-123',
    OIDC_REDIRECT_URI: 'https://app.test/auth/callback',
    OIDC_AUDIENCE: 'proj-42',
    PORTAL_PUBLIC_URL: 'https://app.test',
    VALKEY_URL: 'redis://valkey.test:6379',
    SESSION_ENC_KEY: Buffer.alloc(32, 5).toString('base64'),
  })) {
    vi.stubEnv(k, v);
  }
  __resetEnvForTests();
  fetchMock.mockReset();
  incomingHeaders.mockReset();
  incomingHeaders.mockRejectedValue(new Error('headers was called outside a request scope'));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('apiFetch', () => {
  it('calls API_INTERNAL_URL with the bearer token, a request id and no caching', async () => {
    fetchMock.mockResolvedValue(new Response('{}'));
    await apiFetch(session, '/v1/telemetry/vitals', {
      method: 'POST',
      body: '{"a":1}',
      headers: { 'content-type': 'application/json' },
    });

    const { url, init, headers } = lastCall();
    expect(url).toBe('http://api:3001/v1/telemetry/vitals');
    expect(init.method).toBe('POST');
    expect(init.body).toBe('{"a":1}');
    expect(init.cache).toBe('no-store');
    expect(headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
    expect(headers.get('content-type')).toBe('application/json');
    expect(headers.get('x-request-id')).toMatch(/^[A-Za-z0-9-]{8,64}$/);
  });

  it('uses a different request id per call', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(new Response('{}')));
    await apiFetch(session, '/v1/me');
    const first = lastCall().headers.get('x-request-id');
    await apiFetch(session, '/v1/me');
    expect(lastCall().headers.get('x-request-id')).not.toBe(first);
  });

  it('overrides a caller-supplied Authorization header', async () => {
    fetchMock.mockResolvedValue(new Response('{}'));
    await apiFetch(session, '/v1/me', { headers: { authorization: 'Bearer forged' } });
    expect(lastCall().headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
  });

  it.each([
    ['https://evil.example/v1/me'],
    ['//evil.example/v1/me'],
    ['/\\evil.example/v1/me'],
    ['v1/me'],
  ])('refuses to send the token for path %j', async (path) => {
    await expect(apiFetch(session, path)).rejects.toThrow(ApiError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('apiFetch browser context', () => {
  const REQUEST_ID = '0b6f1c52-3f43-4a52-9a52-5d1f8d3b7c11';

  function incoming(values: Record<string, string>) {
    incomingHeaders.mockResolvedValue(new Headers(values));
  }

  it('forwards the caller address and the browser user agent', async () => {
    incoming({ 'x-forwarded-for': '203.0.113.7', 'user-agent': 'Mozilla/5.0 (test)' });
    fetchMock.mockResolvedValue(new Response('{}'));
    await apiFetch(session, '/v1/me');
    const { headers } = lastCall();
    expect(headers.get('x-forwarded-for')).toBe('203.0.113.7');
    expect(headers.get('user-agent')).toBe('Mozilla/5.0 (test)');
  });

  it('never lets a caller-supplied header stand in for the address or agent', async () => {
    incoming({ 'x-forwarded-for': '203.0.113.7', 'user-agent': 'real-agent' });
    fetchMock.mockResolvedValue(new Response('{}'));
    await apiFetch(session, '/v1/me', {
      headers: { 'x-forwarded-for': '6.6.6.6', 'user-agent': 'forged' },
    });
    expect(lastCall().headers.get('x-forwarded-for')).toBe('203.0.113.7');
    expect(lastCall().headers.get('user-agent')).toBe('real-agent');
  });

  it('sends no address when there is no browser request to describe', async () => {
    fetchMock.mockResolvedValue(new Response('{}'));
    await apiFetch(session, '/v1/me', { headers: { 'x-forwarded-for': '6.6.6.6' } });
    expect(lastCall().headers.has('x-forwarded-for')).toBe(false);
  });

  it('reuses the incoming x-request-id for every API call of that request', async () => {
    incoming({ 'x-request-id': REQUEST_ID });
    fetchMock.mockImplementation(() => Promise.resolve(new Response('{}')));
    await apiFetch(session, '/v1/me');
    expect(lastCall().headers.get('x-request-id')).toBe(REQUEST_ID);
    await apiFetch(session, '/v1/other');
    expect(lastCall().headers.get('x-request-id')).toBe(REQUEST_ID);
  });

  it.each([
    ['too short', 'abc'],
    ['has a space', 'abcd efgh1234'],
    ['too long', 'a'.repeat(65)],
  ])('mints a fresh id instead of an incoming id that is %s', async (_why, bad) => {
    incoming({ 'x-request-id': bad });
    fetchMock.mockResolvedValue(new Response('{}'));
    await apiFetch(session, '/v1/me');
    const id = lastCall().headers.get('x-request-id');
    expect(id).not.toBe(bad);
    expect(id).toMatch(/^[A-Za-z0-9-]{8,64}$/);
  });
});

describe('apiFetch deadline', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** A fetch that never answers and rejects with the signal's reason once it aborts. */
  function hangingFetch() {
    fetchMock.mockImplementation(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason as Error));
        }),
    );
  }

  async function outcomeAfter(call: Promise<unknown>, ms: number): Promise<unknown> {
    const outcome = call.then(
      () => 'resolved' as const,
      (err: unknown) => err,
    );
    let settled = false;
    void outcome.then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(ms - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    return await outcome;
  }

  it('a read gives up after 15 s with the 503 busy refusal the pages already show', async () => {
    hangingFetch();
    const err = await outcomeAfter(apiFetch(session, '/v1/me'), 15_000);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 503 });
    expect(BUSY_BODY.safeParse((err as ApiError).body).success).toBe(true);
    expect((err as ApiError).body).toMatchObject({
      error: { code: 'db_busy', details: { retryAfterSeconds: 1 } },
    });
    expect((err as Error).message).not.toContain(TOKEN);
  });

  it('a write that times out is not called busy: it may have been saved', async () => {
    hangingFetch();
    const err = await outcomeAfter(
      apiFetch(session, '/v1/me', { method: 'POST', body: '{"a":1}' }),
      15_000,
    );
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 504, body: { error: { code: 'api_timeout' } } });
  });

  it('stops the clock once the response headers arrive, so a long body is not cut off', async () => {
    fetchMock.mockResolvedValue(new Response('{}'));
    await apiFetch(session, '/v1/me');
    const signal = lastCall().init.signal;
    expect(signal).toBeInstanceOf(AbortSignal);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(signal?.aborted).toBe(false);
  });

  it.each([
    ['a Blob', () => new Blob(['x'])],
    ['form data', () => new FormData()],
    ['a byte array', () => new Uint8Array(4)],
    ['a stream', () => new ReadableStream()],
  ])(
    'puts no default deadline on a call that sends %s (a file can take longer)',
    async (_n, body) => {
      fetchMock.mockResolvedValue(new Response('{}'));
      await apiFetch(session, '/v1/me', { method: 'PUT', body: body() as BodyInit });
      expect(lastCall().init.signal).toBeUndefined();
    },
  );

  it("uses the caller's own signal and leaves its abort alone", async () => {
    const controller = new AbortController();
    hangingFetch();
    const outcome = apiFetch(session, '/v1/me', { signal: controller.signal }).catch(
      (err: unknown) => err,
    );
    await vi.advanceTimersByTimeAsync(20_000);
    expect(lastCall().init.signal).toBe(controller.signal);
    const reason = new DOMException('caller gave up', 'AbortError');
    controller.abort(reason);
    expect(await outcome).toBe(reason);
  });

  it('does not turn other network failures into the busy refusal', async () => {
    const down = new TypeError('fetch failed');
    fetchMock.mockRejectedValue(down);
    await expect(apiFetch(session, '/v1/me')).rejects.toBe(down);
  });
});

describe('getMe', () => {
  it('signs in with a permission it does not know: drops the row and warns', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    fetchMock.mockResolvedValue(
      Response.json({
        ...validMe,
        permissions: [{ permission: 'vat.sales.read.v2', scope: 'all' }],
      }),
    );
    expect((await getMe({ accessToken: TOKEN })).permissions).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('signs in with a known permission at an unknown scope: drops the row and warns', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const known = { permission: 'customer.read', scope: 'own' };
    fetchMock.mockResolvedValue(
      Response.json({
        ...validMe,
        permissions: [known, { permission: 'customer.read', scope: 'galaxy' }],
      }),
    );
    expect((await getMe({ accessToken: TOKEN })).permissions).toEqual([known]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('customer.read@galaxy');
    warn.mockRestore();
  });

  it('throws ApiError 502 for a malformed grant row', async () => {
    fetchMock.mockResolvedValue(Response.json({ ...validMe, permissions: [null] }));
    await expect(getMe({ accessToken: TOKEN })).rejects.toMatchObject({
      name: 'ApiError',
      status: 502,
    });
  });

  it('returns the parsed /v1/me body', async () => {
    fetchMock.mockResolvedValue(Response.json(validMe));
    await expect(getMe({ accessToken: TOKEN })).resolves.toEqual(validMe);
    const { url, init, headers } = lastCall();
    expect(url).toBe('http://api:3001/v1/me');
    expect(init.method).toBe('GET');
    expect(headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
  });

  // The customer gate in /auth/callback reads partyId (ADR 0027). It must survive the parse: the
  // shared MeResponseSchema alone would strip it, and every customer would be turned away.
  it('keeps a GUID partyId', async () => {
    const me = { ...validMe, orgKind: 'customer', partyId: '00000000-0000-4000-8000-0000000000aa' };
    fetchMock.mockResolvedValue(Response.json(me));
    await expect(getMe({ accessToken: TOKEN })).resolves.toEqual(me);
  });

  it('parses a body without partyId, leaving it undefined', async () => {
    fetchMock.mockResolvedValue(Response.json(validMe));
    expect((await getMe({ accessToken: TOKEN })).partyId).toBeUndefined();
  });

  it('throws ApiError 502 for a partyId that is not a GUID', async () => {
    fetchMock.mockResolvedValue(Response.json({ ...validMe, partyId: 'party-1' }));
    await expect(getMe({ accessToken: TOKEN })).rejects.toMatchObject({
      name: 'ApiError',
      status: 502,
    });
  });

  it('throws ApiError with the status and body on a non-2xx response', async () => {
    const body = { statusCode: 401, error: 'unauthorized' };
    fetchMock.mockResolvedValue(Response.json(body, { status: 401 }));
    const err = await getMe({ accessToken: TOKEN }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 401, body });
  });

  it('throws ApiError when the body does not match MeResponseSchema', async () => {
    fetchMock.mockResolvedValue(Response.json({ ...validMe, orgKind: 'admin' }));
    const err = await getMe({ accessToken: TOKEN }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(502);
  });

  it('throws ApiError for a non-JSON body', async () => {
    fetchMock.mockResolvedValue(new Response('<html>oops</html>', { status: 200 }));
    await expect(getMe({ accessToken: TOKEN })).rejects.toBeInstanceOf(ApiError);
  });

  it('never logs or leaks the token in errors', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => undefined),
    );
    fetchMock.mockResolvedValue(Response.json({ nope: true }, { status: 500 }));
    const err = await getMe({ accessToken: TOKEN }).catch((e: unknown) => e);

    expect(JSON.stringify(err)).not.toContain(TOKEN);
    expect(String((err as Error).message)).not.toContain(TOKEN);
    expect(String((err as Error).stack)).not.toContain(TOKEN);
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });
});
