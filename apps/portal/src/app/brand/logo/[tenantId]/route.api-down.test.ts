import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The route with the REAL openPublicLogo: only what is outside the app is faked (the environment and the network), so
// this proves what a reader gets when the API is down, not what a mocked helper returns. `route.test.ts` mocks the helper.
vi.mock('server-only', () => ({}));
vi.mock('@/lib/env', () => ({ getEnv: () => ({ API_INTERNAL_URL: 'http://api.internal:3001' }) }));
vi.mock('@/lib/api', () => ({ apiFetch: vi.fn() }));

const { GET } = await import('./route');
const { PUBLIC_LOGO_TIMEOUT_MS } = await import('@/lib/api-branding');

const TENANT = '11111111-1111-4111-8111-111111111111';
const get = () =>
  GET(new Request(`https://app.test/brand/logo/${TENANT}`), {
    params: Promise.resolve({ tenantId: TENANT }),
  });

describe('GET /brand/logo/[tenantId] when the API cannot answer', () => {
  const fetchMock = vi.fn<typeof fetch>();
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it.each([
    ['refuses the connection', () => Promise.reject(new TypeError('fetch failed'))],
    [
      'times out',
      () => Promise.reject(new DOMException('The operation timed out.', 'TimeoutError')),
    ],
    ['answers 502', () => Promise.resolve(new Response('bad gateway', { status: 502 }))],
    ['answers 503', () => Promise.resolve(new Response('busy', { status: 503 }))],
  ])('answers a JSON 404 at once, without throwing, when the API %s', async (_name, answer) => {
    fetchMock.mockImplementation(answer);
    const res = await get();
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(res.headers.get('cache-control') ?? '').not.toContain('public');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('gives up on an API that never starts answering and answers a 404 once the timeout passes', async () => {
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
      const pending = get();
      await vi.advanceTimersByTimeAsync(PUBLIC_LOGO_TIMEOUT_MS);
      const res = await pending;
      expect(res.status).toBe(404);
    } finally {
      vi.useRealTimers();
    }
  });
});
