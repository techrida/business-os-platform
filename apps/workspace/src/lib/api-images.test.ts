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
const WHEN = '2026-11-19T05:45:00.000Z';

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

const created = {
  documentId: DOC,
  versionId: VER,
  uploadPath: `/v1/documents/${DOC}/versions/${VER}/content`,
};

const version = {
  id: VER,
  documentId: DOC,
  version: 1,
  filename: 'logo.png',
  declaredMime: 'image/png',
  detectedMime: null,
  sizeBytes: 4,
  sha256: 'a'.repeat(64),
  status: 'quarantined',
  scanSignature: null,
  scannedAt: null,
  uploadedBy: ORG,
  createdAt: WHEN,
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
  it('reserves the document, streams the bytes, then points the record at it', async () => {
    fetchMock
      .mockResolvedValueOnce(reply(created, 201))
      .mockResolvedValueOnce(reply(version))
      .mockResolvedValueOnce(reply(undefined, 204));

    const out = await uploadImage(session, 'entity_logo', ORG, file);
    expect(out).toEqual({ documentId: DOC });

    const [create, content, pointer] = calls();
    expect(calls()).toHaveLength(3);

    expect(create?.method).toBe('POST');
    expect(create?.url).toBe('http://api:3001/v1/documents');
    expect(JSON.parse(String(create?.body))).toEqual({
      ownerType: 'entity_logo',
      ownerId: ORG,
      filename: 'logo.png',
      declaredMime: 'image/png',
      sizeBytes: 4,
    });

    expect(content?.method).toBe('PUT');
    expect(content?.url).toBe(`http://api:3001${created.uploadPath}`);
    expect(content?.headers.get('content-type')).toBe('image/png');
    expect(content?.headers.get('content-length')).toBe('4');
    const sent = new Uint8Array(await new Response(content?.body as ReadableStream).arrayBuffer());
    expect(Array.from(sent)).toEqual(Array.from(PNG));

    expect(pointer?.method).toBe('PUT');
    expect(pointer?.url).toBe(`http://api:3001/v1/images/entity_logo/${ORG}`);
    expect(pointer?.headers.get('content-type')).toBe('application/json');
    expect(JSON.parse(String(pointer?.body))).toEqual({ documentId: DOC });
    expect(pointer?.headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
  });

  it('accepts an ArrayBuffer and encodes the owner id as one path segment', async () => {
    fetchMock
      .mockResolvedValueOnce(reply(created, 201))
      .mockResolvedValueOnce(reply(version))
      .mockResolvedValueOnce(reply(undefined, 204));

    await uploadImage(session, 'user_avatar', '../admin', { ...file, bytes: PNG.slice().buffer });
    const pointer = calls()[2];
    expect(pointer?.url).toBe('http://api:3001/v1/images/user_avatar/..%2Fadmin');
    expect(JSON.parse(String(calls()[0]?.body)).sizeBytes).toBe(4);
  });

  it('removes the just-uploaded document when the pointer cannot be moved, then rethrows', async () => {
    fetchMock
      .mockResolvedValueOnce(reply(created, 201))
      .mockResolvedValueOnce(reply(version))
      .mockResolvedValueOnce(reply(internals, 409))
      .mockResolvedValueOnce(reply(undefined, 204));

    const err = await uploadImage(session, 'customer_logo', ORG, file).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ImageError);
    expect((err as ImageError).status).toBe(409);

    const all = calls();
    expect(all).toHaveLength(4);
    expect(all[3]?.method).toBe('DELETE');
    expect(all[3]?.url).toBe(`http://api:3001/v1/documents/${DOC}`);
  });

  it('still rethrows the pointer error when the cleanup itself fails', async () => {
    fetchMock
      .mockResolvedValueOnce(reply(created, 201))
      .mockResolvedValueOnce(reply(version))
      .mockResolvedValueOnce(reply(internals, 403))
      .mockRejectedValueOnce(new TypeError('fetch failed'));

    const err = await uploadImage(session, 'vendor_logo', ORG, file).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ImageError);
    expect((err as ImageError).status).toBe(403);
    expect(calls()).toHaveLength(4);
  });

  it('does not touch the pointer or clean up when the API refuses the file at reservation', async () => {
    fetchMock.mockResolvedValueOnce(reply(internals, 415));
    const err = await uploadImage(session, 'entity_logo', ORG, {
      ...file,
      name: 'logo.svg',
      mime: 'image/svg+xml',
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ImageError);
    expect((err as ImageError).status).toBe(415);
    expect(calls()).toHaveLength(1);
  });

  it('maps a refusal of the content (type check) without moving the pointer', async () => {
    fetchMock
      .mockResolvedValueOnce(reply(created, 201))
      .mockResolvedValueOnce(reply(internals, 415));
    const err = await uploadImage(session, 'entity_logo', ORG, file).catch((e: unknown) => e);
    expect((err as ImageError).status).toBe(415);
    expect(calls().map((c) => c.method)).toEqual(['POST', 'PUT']);
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

  it('maps a reservation 413 too', async () => {
    fetchMock.mockResolvedValueOnce(reply(internals, 413));
    const err = await uploadImage(session, 'entity_logo', ORG, file).catch((e: unknown) => e);
    expect((err as ImageError).status).toBe(413);
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
