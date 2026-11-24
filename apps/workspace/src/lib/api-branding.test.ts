import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// `server-only` throws outside the react-server condition, which Vitest does not use.
vi.mock('server-only', () => ({}));
vi.mock('./env', () => ({ getEnv: () => ({ API_INTERNAL_URL: 'http://api.internal:3001' }) }));
vi.mock('./api', () => ({ apiFetch: vi.fn() }));

const { openPublicLogo, PUBLIC_LOGO_TIMEOUT_MS } = await import('./api-branding');

const TENANT = '11111111-1111-4111-8111-111111111111';

describe('openPublicLogo (the anonymous logo fetch)', () => {
  const fetchMock = vi.fn<typeof fetch>();
  beforeEach(() => {
    fetchMock.mockReset().mockResolvedValue(new Response(null, { status: 404 }));
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('asks the API for the tenant logo only, with no credentials and a bounded wait', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    await openPublicLogo(TENANT, '"etag"');
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url as URL)).toBe(`http://api.internal:3001/v1/public/logo/${TENANT}`);
    expect(init?.headers).toEqual({ 'if-none-match': '"etag"' });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(timeout).toHaveBeenCalledWith(PUBLIC_LOGO_TIMEOUT_MS);
    expect(PUBLIC_LOGO_TIMEOUT_MS).toBeLessThanOrEqual(10_000);
    timeout.mockRestore();
  });

  it('cannot leave the logo path: a hostile id is one encoded segment', async () => {
    await openPublicLogo('../../v1/me');
    expect(String(fetchMock.mock.calls[0]?.[0] as URL)).toBe(
      'http://api.internal:3001/v1/public/logo/..%2F..%2Fv1%2Fme',
    );
  });
});
