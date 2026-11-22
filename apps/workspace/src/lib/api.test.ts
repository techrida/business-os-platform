import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError, apiFetch, getMe } from './api';
import { __resetEnvForTests } from './env';
import type { Session } from './session';

// `server-only` throws outside the react-server condition, which Vitest does not use.
vi.mock('server-only', () => ({}));

const TOKEN = 'eyJ.secret-access-token.sig';

const session: Session = {
  id: 'A'.repeat(43),
  sub: 'user-1',
  orgId: '00000000-0000-4000-8000-000000000002',
  orgKind: 'staff',
  roles: ['founder'],
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
  partyId: null,
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
    WORKSPACE_PUBLIC_URL: 'https://app.test',
    VALKEY_URL: 'redis://valkey.test:6379',
    SESSION_ENC_KEY: Buffer.alloc(32, 5).toString('base64'),
  })) {
    vi.stubEnv(k, v);
  }
  __resetEnvForTests();
  fetchMock.mockReset();
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

describe('getMe', () => {
  it('returns the parsed /v1/me body', async () => {
    fetchMock.mockResolvedValue(Response.json(validMe));
    await expect(getMe({ accessToken: TOKEN })).resolves.toEqual(validMe);
    const { url, init, headers } = lastCall();
    expect(url).toBe('http://api:3001/v1/me');
    expect(init.method).toBe('GET');
    expect(headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
  });

  it('signs in with a permission or scope it does not know: drops the row and warns', async () => {
    const known = { permission: 'customer.read', scope: 'own' };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    fetchMock.mockResolvedValue(
      Response.json({
        ...validMe,
        permissions: [known, { permission: 'vat.sales.read.v2', scope: 'all' }],
      }),
    );
    const me = await getMe({ accessToken: TOKEN });
    expect(me.permissions).toEqual([known]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('vat.sales.read.v2@all');
    expect(String(warn.mock.calls[0]?.[0])).not.toContain(TOKEN);
    warn.mockRestore();
  });

  it('throws ApiError with the status and body on a non-2xx response', async () => {
    const body = { statusCode: 401, error: 'unauthorized' };
    fetchMock.mockResolvedValue(Response.json(body, { status: 401 }));
    const err = await getMe({ accessToken: TOKEN }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 401, body });
  });

  it('keeps the party id of a portal caller', async () => {
    const portal = {
      ...validMe,
      orgKind: 'customer',
      partyId: '00000000-0000-4000-8000-000000000003',
    };
    fetchMock.mockResolvedValue(Response.json(portal));
    await expect(getMe({ accessToken: TOKEN })).resolves.toMatchObject({
      orgKind: 'customer',
      partyId: portal.partyId,
    });
  });

  it('throws ApiError when the body has no partyId', async () => {
    const { partyId: _omitted, ...withoutParty } = validMe;
    fetchMock.mockResolvedValue(Response.json(withoutParty));
    const err = await getMe({ accessToken: TOKEN }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(502);
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
