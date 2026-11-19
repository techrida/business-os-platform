import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/lib/api';
import type { Session } from '@/lib/session';

// `server-only` throws outside the react-server condition, which Vitest does not use.
vi.mock('server-only', () => ({}));
vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT:${url}`);
  },
}));
const getSession = vi.fn<() => Promise<Session | null>>();
vi.mock('@/lib/session', () => ({ getSession: () => getSession() }));
vi.mock('@/lib/env', () => ({
  getEnv: () => ({ WORKSPACE_PUBLIC_URL: 'https://app.test', API_INTERNAL_URL: 'http://api.test' }),
}));

// The real ImageError class stays; only the API call is scripted.
const openImage =
  vi.fn<(session: Session, id: string, ifNoneMatch?: string) => Promise<Response>>();
vi.mock('@/lib/api-images', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api-images')>()),
  openImage: (session: Session, id: string, ifNoneMatch?: string) =>
    openImage(session, id, ifNoneMatch),
}));

const { GET } = await import('./route');
const { ImageError } = await import('@/lib/api-images');

const DOC = '22222222-2222-4222-8222-222222222222';
const ETAG = '"33333333-3333-4333-8333-333333333333"';
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

const staff: Session = {
  id: 'A'.repeat(43),
  sub: 'u1',
  orgId: 'o1',
  orgKind: 'staff',
  roles: ['sales'],
  accessToken: 'eyJ.secret-token.sig',
  accessExp: 2_000_000_000,
  createdAt: 1,
  lastSeenAt: 1,
};

const ctx = (key = DOC) => ({ params: Promise.resolve({ key }) });
const get = (headers: Record<string, string> = {}, key = DOC) =>
  GET(new Request(`https://app.test/api/images/${key}`, { headers }), ctx(key));

const message = async (res: Response) =>
  ((await res.json()) as { error: { message: string } }).error.message;

beforeEach(() => {
  getSession.mockReset();
  getSession.mockResolvedValue(staff);
  openImage.mockReset();
});

describe('GET /api/images/[documentId]', () => {
  it('answers 401 without a session and 403 for a non-staff session, before any API call', async () => {
    getSession.mockResolvedValueOnce(null);
    expect((await get()).status).toBe(401);
    getSession.mockResolvedValueOnce({ ...staff, orgKind: 'customer' });
    expect((await get()).status).toBe(403);
    expect(openImage).not.toHaveBeenCalled();
  });

  it('refuses an id that is not a UUID with 400 JSON and never calls the API', async () => {
    for (const bad of ['../etc/passwd', 'logo.png', `${DOC}x`, '']) {
      const res = await get({}, bad);
      expect(res.status).toBe(400);
      expect(res.headers.get('content-type')).toContain('application/json');
    }
    expect(openImage).not.toHaveBeenCalled();
  });

  it('streams a picture with its type, length, ETag and the caching and safety headers', async () => {
    openImage.mockResolvedValueOnce(
      new Response(PNG, {
        status: 200,
        headers: {
          'content-type': 'image/png',
          'content-length': String(PNG.byteLength),
          etag: ETAG,
          'set-cookie': 'leak=1',
        },
      }),
    );
    const res = await get();
    expect(openImage).toHaveBeenCalledWith(staff, DOC, undefined);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('content-length')).toBe('4');
    expect(res.headers.get('etag')).toBe(ETAG);
    // Stored but revalidated on every use: no max-age or `immutable` that would skip the session and scope checks.
    expect(res.headers.get('cache-control')).toBe('private, no-cache');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-disposition')).toBe('inline');
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PNG);
  });

  it('passes If-None-Match on and a 304 back with the ETag and no body', async () => {
    openImage.mockResolvedValueOnce(new Response(null, { status: 304, headers: { etag: ETAG } }));
    const res = await get({ 'if-none-match': ETAG });
    expect(openImage).toHaveBeenCalledWith(staff, DOC, ETAG);
    expect(res.status).toBe(304);
    expect(res.headers.get('etag')).toBe(ETAG);
    expect(res.headers.get('cache-control')).toBe('private, no-cache');
    expect(res.body).toBeNull();
  });

  it('answers 200 with the bytes when the API did, even though the browser sent If-None-Match', async () => {
    const changed = '"44444444-4444-4444-8444-444444444444"';
    openImage.mockResolvedValueOnce(
      new Response(PNG, { status: 200, headers: { 'content-type': 'image/png', etag: changed } }),
    );
    const res = await get({ 'if-none-match': ETAG });
    expect(openImage).toHaveBeenCalledWith(staff, DOC, ETAG);
    expect(res.status).toBe(200);
    expect(res.headers.get('etag')).toBe(changed);
    expect(res.headers.get('cache-control')).toBe('private, no-cache');
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PNG);
  });

  it('runs the session and scope checks on a revalidation: no session is 401, a refused scope is 404', async () => {
    getSession.mockResolvedValueOnce(null);
    expect((await get({ 'if-none-match': ETAG })).status).toBe(401);
    expect(openImage).not.toHaveBeenCalled();

    openImage.mockRejectedValueOnce(
      new ImageError(404, 'The picture or the record it belongs to was not found.'),
    );
    const res = await get({ 'if-none-match': ETAG });
    expect(openImage).toHaveBeenCalledWith(staff, DOC, ETAG);
    expect(res.status).toBe(404);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('refuses anything that is not PNG, JPEG or WebP with 415 JSON, whatever the API sent', async () => {
    for (const type of ['image/svg+xml', 'text/html', 'application/octet-stream', '']) {
      openImage.mockResolvedValueOnce(
        new Response('<svg onload="alert(1)"/>', {
          status: 200,
          headers: type ? { 'content-type': type } : {},
        }),
      );
      const res = await get();
      expect(res.status).toBe(415);
      expect(res.headers.get('content-type')).toContain('application/json');
      expect(await res.text()).not.toContain('svg');
    }
  });

  it('accepts JPEG and WebP, normalising a parameterised type', async () => {
    for (const [sent, served] of [
      ['image/jpeg', 'image/jpeg'],
      ['IMAGE/WEBP; charset=binary', 'image/webp'],
    ] as const) {
      openImage.mockResolvedValueOnce(
        new Response(PNG, { status: 200, headers: { 'content-type': sent } }),
      );
      const res = await get();
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe(served);
    }
  });

  it('maps a missing or still-scanning picture to 404 JSON so an <img> falls back', async () => {
    openImage.mockRejectedValueOnce(
      new ImageError(404, 'The picture or the record it belongs to was not found.'),
    );
    const res = await get();
    expect(res.status).toBe(404);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await message(res)).toBe('The picture or the record it belongs to was not found.');
  });

  it('passes an expired sign-in through as 401 and turns an API outage into 502', async () => {
    openImage.mockRejectedValueOnce(new ApiError(401, 'GET /v1/images failed with 401'));
    expect((await get()).status).toBe(401);
    openImage.mockRejectedValueOnce(new ApiError(500, 'GET /v1/images failed with 500'));
    expect((await get()).status).toBe(502);
    openImage.mockRejectedValueOnce(new TypeError('fetch failed'));
    expect((await get()).status).toBe(502);
  });
});
