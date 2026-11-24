import { beforeEach, describe, expect, it, vi } from 'vitest';

// `server-only` throws outside the react-server condition, which Vitest does not use.
vi.mock('server-only', () => ({}));
const openPublicLogo =
  vi.fn<(tenantId: string, documentId: string, ifNoneMatch?: string) => Promise<Response>>();
vi.mock('@/lib/api-branding', () => ({
  openPublicLogo: (t: string, d: string, e?: string) => openPublicLogo(t, d, e),
}));

const { GET } = await import('./route');

const TENANT = '11111111-1111-4111-8111-111111111111';
const DOC = '22222222-2222-4222-8222-222222222222';
const ETAG = '"33333333-3333-4333-8333-333333333333"';
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

const get = (tenantId = TENANT, documentId = DOC, headers: Record<string, string> = {}) =>
  GET(new Request(`https://app.test/brand/logo/${tenantId}/${documentId}`, { headers }), {
    params: Promise.resolve({ tenantId, documentId }),
  });

beforeEach(() => openPublicLogo.mockReset());

describe('GET /brand/logo/[tenantId]/[documentId] (public, no session)', () => {
  it('serves the logo with its type, a short public cache and the ETag, and reads no session', async () => {
    openPublicLogo.mockResolvedValue(
      new Response(PNG, { headers: { 'content-type': 'image/png', etag: ETAG } }),
    );
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('cache-control')).toBe('public, max-age=300');
    expect(res.headers.get('etag')).toBe(ETAG);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PNG);
    expect(openPublicLogo).toHaveBeenCalledWith(TENANT, DOC, undefined);
  });

  it('passes If-None-Match on and answers a 304 with no body', async () => {
    openPublicLogo.mockResolvedValue(new Response(null, { status: 304, headers: { etag: ETAG } }));
    const res = await get(TENANT, DOC, { 'if-none-match': ETAG });
    expect(openPublicLogo).toHaveBeenCalledWith(TENANT, DOC, ETAG);
    expect(res.status).toBe(304);
    expect(res.headers.get('etag')).toBe(ETAG);
    expect(await res.text()).toBe('');
  });

  it.each([
    ['an id that is not a uuid', 'x', DOC],
    ['a path-like id', TENANT, '..%2F..%2Fv1%2Fme'],
  ])('is 404 for %s, without calling the API', async (_name, tenantId, documentId) => {
    const res = await get(tenantId, documentId);
    expect(res.status).toBe(404);
    expect(openPublicLogo).not.toHaveBeenCalled();
  });

  it.each([
    ['the API refuses it', () => Promise.resolve(Response.json({}, { status: 404 }))],
    [
      'the answer is not an image',
      () => Promise.resolve(new Response('<script>', { headers: { 'content-type': 'text/html' } })),
    ],
    [
      'the answer is an SVG',
      () =>
        Promise.resolve(new Response('<svg/>', { headers: { 'content-type': 'image/svg+xml' } })),
    ],
  ])('is a JSON 404 when %s, never another body', async (_name, answer) => {
    openPublicLogo.mockImplementation(answer);
    const res = await get();
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toContain('application/json');
  });
});
