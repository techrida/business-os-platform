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

  it('asks the API for the tenant logo only, with no credentials', async () => {
    await openPublicLogo(TENANT, '"etag"');
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url as URL)).toBe(`http://api.internal:3001/v1/public/logo/${TENANT}`);
    expect(init?.headers).toEqual({ 'if-none-match': '"etag"' });
    expect(PUBLIC_LOGO_TIMEOUT_MS).toBeLessThanOrEqual(10_000);
  });

  it('aborts an API that has not started answering after the timeout', async () => {
    vi.useFakeTimers();
    try {
      fetchMock.mockImplementation(
        (_url, init) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
              once: true,
            });
          }),
      );
      const pending = openPublicLogo(TENANT);
      const settled = expect(pending).rejects.toThrow('aborted');
      await vi.advanceTimersByTimeAsync(PUBLIC_LOGO_TIMEOUT_MS);
      await settled;
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops the timer once headers arrive, so a slow body download is not cut off', async () => {
    vi.useFakeTimers();
    try {
      let signal: AbortSignal | undefined;
      fetchMock.mockImplementation((_url, init) => {
        signal = init?.signal ?? undefined;
        return Promise.resolve(new Response('body'));
      });
      await openPublicLogo(TENANT);
      await vi.advanceTimersByTimeAsync(PUBLIC_LOGO_TIMEOUT_MS * 3);
      expect(signal?.aborted).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('cannot leave the logo path: a hostile id is one encoded segment', async () => {
    await openPublicLogo('../../v1/me');
    expect(String(fetchMock.mock.calls[0]?.[0] as URL)).toBe(
      'http://api.internal:3001/v1/public/logo/..%2F..%2Fv1%2Fme',
    );
  });
});
