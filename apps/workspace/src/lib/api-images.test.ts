import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from './api';
import { ImageError, openImage, removeImage, uploadImage } from './api-images';
import { __resetEnvForTests } from './env';
import type { Session } from './session';

// `server-only` throws outside the react-server condition, which Vitest does not use.
vi.mock('server-only', () => ({}));

const TOKEN = 'eyJ.secret-access-token.sig';
const ORG = '11111111-1111-4111-8111-111111111111';
const DOC = '22222222-2222-4222-8222-222222222222';
const VER = '33333333-3333-4333-8333-333333333333';

const session: Session = {
  id: 'A'.repeat(43),
  sub: 'user-1',
  orgId: ORG,
  orgKind: 'staff',
  roles: ['founder'],
  accessToken: TOKEN,
  accessExp: 2_000_000_000,
  createdAt: 1_700_000_000,
  lastSeenAt: 1_700_000_000,
};

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
const file = { bytes: PNG, name: 'logo.png', mime: 'image/png' };

/** A server error body with internals that must never reach the caller's message. */
const internals = {
  error: { code: 'x', message: 'pg: relation app.documents violates check', correlationId: 'c-1' },
};

const fetchMock = vi.fn<typeof fetch>();

const reply = (body: unknown, status = 200): Response =>
  new Response(body === undefined ? null : JSON.stringify(body), { status });

type Call = { url: string; method: string; headers: Headers; body: unknown };

function calls(): Call[] {
  return fetchMock.mock.calls.map(([url, init]) => {
    const href = url instanceof Request ? url.url : url instanceof URL ? url.href : String(url);
    return {
      url: href,
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
      body: init?.body,
    };
  });
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
});

describe('uploadImage', () => {
  const sentBytes = async (call: Call | undefined): Promise<number[]> =>
    Array.from(new Uint8Array(await new Response(call?.body as BodyInit).arrayBuffer()));

  it('sends the bytes in one POST that creates the document and points the record at it', async () => {
    fetchMock.mockResolvedValueOnce(reply({ documentId: DOC }));

    const out = await uploadImage(session, 'entity_logo', ORG, file);
    expect(out).toEqual({ documentId: DOC });

    const all = calls();
    expect(all).toHaveLength(1);
    const [only] = all;
    expect(only?.method).toBe('POST');
    expect(only?.url).toBe(`http://api:3001/v1/images/entity_logo/${ORG}`);
    expect(only?.headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
    expect(only?.headers.get('content-type')).toBe('image/png');
    expect(only?.headers.get('x-file-name')).toBe('logo.png');
    expect(await sentBytes(only)).toEqual(Array.from(PNG));
  });

  it('encodes the file name so a name outside ASCII is a valid header value', async () => {
    fetchMock.mockResolvedValueOnce(reply({ documentId: DOC }));
    await uploadImage(session, 'customer_logo', ORG, { ...file, name: 'Café logo.png' });
    expect(calls()[0]?.headers.get('x-file-name')).toBe('Caf%C3%A9%20logo.png');
  });

  it('accepts an ArrayBuffer and encodes the owner id as one path segment', async () => {
    fetchMock.mockResolvedValueOnce(reply({ documentId: DOC }));
    await uploadImage(session, 'user_avatar', '../admin', { ...file, bytes: PNG.slice().buffer });
    const [only] = calls();
    expect(only?.url).toBe('http://api:3001/v1/images/user_avatar/..%2Fadmin');
    expect(await sentBytes(only)).toEqual(Array.from(PNG));
  });

  it('sends only the viewed bytes of a Uint8Array that is a slice of a larger buffer', async () => {
    fetchMock.mockResolvedValueOnce(reply({ documentId: DOC }));
    const backing = new Uint8Array([0, 0, ...PNG, 0, 0]);
    await uploadImage(session, 'entity_logo', ORG, { ...file, bytes: backing.subarray(2, 6) });
    expect(await sentBytes(calls()[0])).toEqual(Array.from(PNG));
  });

  it.each([
    [403, /permission/],
    [404, /not found/],
    [409, /changed at the same time/],
    [413, /too large/],
    [415, /PNG, JPEG or WebP/],
  ])(
    'maps %i to a readable ImageError and makes no follow-up call (the API cleans up)',
    async (status, text) => {
      fetchMock.mockResolvedValueOnce(reply(internals, status));
      const err = await uploadImage(session, 'vendor_logo', ORG, file).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ImageError);
      const imageErr = err as ImageError;
      expect(imageErr.status).toBe(status);
      expect(imageErr.message).toMatch(text);
      expect(imageErr.message).not.toContain('pg:');
      expect(JSON.stringify(imageErr)).not.toContain('pg:');
      expect(calls()).toHaveLength(1);
    },
  );

  it('leaves other statuses as ApiError so the usual handling (sign in again, API down) applies', async () => {
    fetchMock.mockResolvedValueOnce(reply(internals, 401));
    const err = await uploadImage(session, 'entity_logo', ORG, file).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).not.toBeInstanceOf(ImageError);
    expect((err as ApiError).status).toBe(401);
    expect((err as ApiError).body).toBeUndefined();
    expect(calls()).toHaveLength(1);
  });

  it.each([
    ['a missing documentId', () => reply({ id: DOC })],
    ['a non-string documentId', () => reply({ documentId: 42 })],
    ['an empty documentId', () => reply({ documentId: '' })],
    ['a JSON null', () => reply(null)],
    ['an empty body', () => reply(undefined)],
    ['a body that is not JSON', () => new Response('<html>pg: oops</html>', { status: 200 })],
  ])('rejects a 200 with %s as a 502 ApiError without keeping the body', async (_, res) => {
    fetchMock.mockResolvedValueOnce(res());
    const err = await uploadImage(session, 'entity_logo', ORG, file).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).not.toBeInstanceOf(ImageError);
    expect((err as ApiError).status).toBe(502);
    expect((err as ApiError).body).toBeUndefined();
    expect((err as ApiError).message).not.toContain('pg:');
    expect(calls()).toHaveLength(1);
  });
});

describe('removeImage', () => {
  it('sends a null pointer', async () => {
    fetchMock.mockResolvedValueOnce(reply(undefined, 204));
    await removeImage(session, 'user_avatar', ORG);
    const [only] = calls();
    expect(calls()).toHaveLength(1);
    expect(only?.method).toBe('PUT');
    expect(only?.url).toBe(`http://api:3001/v1/images/user_avatar/${ORG}`);
    expect(JSON.parse(String(only?.body))).toEqual({ documentId: null });
  });
});

describe('error mapping', () => {
  it.each([
    [413, /too large/],
    [415, /PNG, JPEG or WebP/],
    [403, /permission/],
    [404, /not found/],
    [409, /changed at the same time/],
  ])('maps %i to a readable ImageError without server internals', async (status, text) => {
    fetchMock.mockResolvedValueOnce(reply(internals, status));
    const err = await removeImage(session, 'entity_logo', ORG).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ImageError);
    const imageErr = err as ImageError;
    expect(imageErr.status).toBe(status);
    expect(imageErr.message).toMatch(text);
    expect(imageErr.message).not.toContain('pg:');
    expect(JSON.stringify(imageErr)).not.toContain('pg:');
    expect(JSON.stringify(imageErr)).not.toContain(TOKEN);
  });

  it('leaves other statuses as ApiError so the usual handling (sign in again, API down) applies', async () => {
    fetchMock.mockResolvedValueOnce(reply(internals, 401));
    const err = await removeImage(session, 'entity_logo', ORG).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).not.toBeInstanceOf(ImageError);
    expect((err as ApiError).status).toBe(401);
    expect((err as ApiError).body).toBeUndefined();
  });
});

describe('openImage', () => {
  it('returns the raw response unbuffered, with its caching headers', async () => {
    const upstream = new Response(PNG, {
      status: 200,
      headers: {
        'content-type': 'image/png',
        etag: `"${VER}"`,
        'cache-control': 'private, max-age=86400, immutable',
      },
    });
    fetchMock.mockResolvedValueOnce(upstream);

    const res = await openImage(session, DOC);
    expect(res).toBe(upstream);
    expect(res.bodyUsed).toBe(false);
    expect(res.headers.get('etag')).toBe(`"${VER}"`);

    const [only] = calls();
    expect(only?.method).toBe('GET');
    expect(only?.url).toBe(`http://api:3001/v1/images/${DOC}`);
    expect(only?.headers.has('if-none-match')).toBe(false);
  });

  it('passes If-None-Match through and returns a 304 as a valid answer', async () => {
    const notModified = new Response(null, { status: 304, headers: { etag: `"${VER}"` } });
    fetchMock.mockResolvedValueOnce(notModified);

    const res = await openImage(session, DOC, `"${VER}"`);
    expect(res).toBe(notModified);
    expect(res.status).toBe(304);
    expect(calls()[0]?.headers.get('if-none-match')).toBe(`"${VER}"`);
  });

  it('encodes the document id as one path segment', async () => {
    fetchMock.mockResolvedValueOnce(reply(undefined, 404));
    await openImage(session, '../documents').catch(() => undefined);
    expect(calls()[0]?.url).toBe('http://api:3001/v1/images/..%2Fdocuments');
  });

  it('turns a 404 (missing, removed or still scanning) into an ImageError', async () => {
    fetchMock.mockResolvedValueOnce(reply(internals, 404));
    const err = await openImage(session, DOC).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ImageError);
    expect((err as ImageError).status).toBe(404);
    expect((err as ImageError).message).not.toContain('pg:');
  });
});
