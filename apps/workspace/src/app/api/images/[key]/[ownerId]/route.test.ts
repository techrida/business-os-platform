import { IMAGE_MAX_BYTES, type ImageOwnerType } from '@bos/contracts';
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

type Upload = { bytes: Uint8Array | ArrayBuffer; name: string; mime: string };
// The real ImageError class stays; only the API calls are scripted.
const uploadImage =
  vi.fn<
    (s: Session, t: ImageOwnerType, id: string, f: Upload) => Promise<{ documentId: string }>
  >();
const removeImage = vi.fn<(s: Session, t: ImageOwnerType, id: string) => Promise<void>>();
vi.mock('@/lib/api-images', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api-images')>()),
  uploadImage: (s: Session, t: ImageOwnerType, id: string, f: Upload) => uploadImage(s, t, id, f),
  removeImage: (s: Session, t: ImageOwnerType, id: string) => removeImage(s, t, id),
}));

const { POST, DELETE } = await import('./route');
const { ImageError } = await import('@/lib/api-images');

const ORIGIN = 'https://app.test';
const OWNER = '44444444-4444-4444-8444-444444444444';
const DOC = '22222222-2222-4222-8222-222222222222';
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
const TOO_LARGE = 'The picture is too large. Use one up to 512 KB.';
const WRONG_TYPE = 'Only PNG, JPEG or WebP pictures can be used.';

const staff: Session = {
  id: 'A'.repeat(43),
  sub: 'u1',
  orgId: 'o1',
  orgKind: 'staff',
  roles: ['founder'],
  accessToken: 'eyJ.secret-token.sig',
  accessExp: 2_000_000_000,
  createdAt: 1,
  lastSeenAt: 1,
};

const ctx = (key: string = 'customer_logo', ownerId = OWNER) => ({
  params: Promise.resolve({ key, ownerId }),
});
const url = (key = 'customer_logo', ownerId = OWNER) => `${ORIGIN}/api/images/${key}/${ownerId}`;

/** A browser-shaped multipart POST: FormData serialised, with its boundary and an honest Content-Length. */
async function multipart(
  file: File | string | null,
  opts: { origin?: string | null; length?: number } = {},
): Promise<Request> {
  const form = new FormData();
  if (file !== null) form.set('file', file);
  const encoded = new Request(url(), { method: 'POST', body: form });
  const body = new Uint8Array(await encoded.arrayBuffer());
  const headers: Record<string, string> = {
    'content-type': encoded.headers.get('content-type') ?? '',
    'content-length': String(opts.length ?? body.byteLength),
  };
  if (opts.origin !== null) headers.origin = opts.origin ?? ORIGIN;
  return new Request(url(), { method: 'POST', headers, body });
}

const png = (bytes: Uint8Array = PNG, type = 'image/png', name = 'logo.png') =>
  new File([bytes as Uint8Array<ArrayBuffer>], name, { type });

const message = async (res: Response) =>
  ((await res.json()) as { error: { message: string } }).error.message;

beforeEach(() => {
  getSession.mockReset();
  getSession.mockResolvedValue(staff);
  uploadImage.mockReset();
  uploadImage.mockResolvedValue({ documentId: DOC });
  removeImage.mockReset();
  removeImage.mockResolvedValue(undefined);
});

describe('origin and session', () => {
  it('refuses cross-origin and origin-less POST and DELETE before the session or the API', async () => {
    for (const origin of ['https://evil.test', 'http://app.test', null]) {
      const post = await POST(await multipart(png(), { origin }), ctx());
      expect(post.status).toBe(403);
      expect(post.headers.get('cache-control')).toBe('no-store');
      const del = await DELETE(
        new Request(url(), { method: 'DELETE', ...(origin ? { headers: { origin } } : {}) }),
        ctx(),
      );
      expect(del.status).toBe(403);
    }
    expect(getSession).not.toHaveBeenCalled();
    expect(uploadImage).not.toHaveBeenCalled();
    expect(removeImage).not.toHaveBeenCalled();
  });

  it('answers 401 without a session and 403 for a non-staff session', async () => {
    getSession.mockResolvedValueOnce(null);
    expect((await POST(await multipart(png()), ctx())).status).toBe(401);
    getSession.mockResolvedValueOnce({ ...staff, orgKind: 'customer' });
    expect(
      (await DELETE(new Request(url(), { method: 'DELETE', headers: { origin: ORIGIN } }), ctx()))
        .status,
    ).toBe(403);
    expect(uploadImage).not.toHaveBeenCalled();
    expect(removeImage).not.toHaveBeenCalled();
  });
});

describe('path', () => {
  it('answers 404 for an unknown owner type and 400 for an owner id that is not a UUID', async () => {
    for (const key of ['document', 'memo_attachment', 'ENTITY_LOGO', '..']) {
      expect((await POST(await multipart(png()), ctx(key))).status).toBe(404);
      const del = new Request(url(key), { method: 'DELETE', headers: { origin: ORIGIN } });
      expect((await DELETE(del, ctx(key))).status).toBe(404);
    }
    for (const id of ['../x', 'me', `${OWNER}0`]) {
      expect((await POST(await multipart(png()), ctx('user_avatar', id))).status).toBe(400);
    }
    expect(uploadImage).not.toHaveBeenCalled();
    expect(removeImage).not.toHaveBeenCalled();
  });
});

describe('POST upload', () => {
  it('uploads a PNG and answers { documentId }', async () => {
    const res = await POST(await multipart(png()), ctx('vendor_logo'));
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({ documentId: DOC });
    expect(uploadImage).toHaveBeenCalledTimes(1);
    const [session, ownerType, ownerId, file] = uploadImage.mock.calls[0]!;
    expect(session).toBe(staff);
    expect(ownerType).toBe('vendor_logo');
    expect(ownerId).toBe(OWNER);
    expect(file.name).toBe('logo.png');
    expect(file.mime).toBe('image/png');
    expect(new Uint8Array(file.bytes)).toEqual(PNG);
  });

  it('refuses a body that is not multipart', async () => {
    const res = await POST(
      new Request(url(), {
        method: 'POST',
        headers: { origin: ORIGIN, 'content-type': 'image/png', 'content-length': '4' },
        body: PNG,
      }),
      ctx(),
    );
    expect(res.status).toBe(415);
    expect(uploadImage).not.toHaveBeenCalled();
  });

  it('refuses a wrong type before any API call, with the same words as the API refusal', async () => {
    for (const file of [
      png(PNG, 'image/svg+xml', 'logo.svg'),
      png(PNG, 'image/gif', 'logo.gif'),
      png(PNG, '', 'logo.png'),
    ]) {
      const res = await POST(await multipart(file), ctx());
      expect(res.status).toBe(415);
      expect(await message(res)).toBe(WRONG_TYPE);
    }
    expect(uploadImage).not.toHaveBeenCalled();
  });

  it('refuses an oversized picture before any API call: file, announced body and lying body', async () => {
    const over = await POST(await multipart(png(new Uint8Array(IMAGE_MAX_BYTES + 1))), ctx());
    expect(over.status).toBe(413);
    expect(await message(over)).toBe(TOO_LARGE);

    const announced = await POST(
      await multipart(png(), { length: IMAGE_MAX_BYTES + 100_000 }),
      ctx(),
    );
    expect(announced.status).toBe(413);

    const lying = await POST(
      await multipart(png(new Uint8Array(IMAGE_MAX_BYTES + 100_000)), { length: 100 }),
      ctx(),
    );
    expect(lying.status).toBe(413);
    expect(uploadImage).not.toHaveBeenCalled();
  });

  it('accepts a picture of exactly the limit', async () => {
    const res = await POST(await multipart(png(new Uint8Array(IMAGE_MAX_BYTES))), ctx());
    expect(res.status).toBe(200);
  });

  it('refuses a missing, text or empty file field, and a missing length', async () => {
    expect((await POST(await multipart(null), ctx())).status).toBe(400);
    expect((await POST(await multipart('not a file'), ctx())).status).toBe(400);
    expect((await POST(await multipart(png(new Uint8Array())), ctx())).status).toBe(400);

    const unannounced = await multipart(png());
    const headers = new Headers(unannounced.headers);
    headers.delete('content-length');
    const res = await POST(
      new Request(url(), { method: 'POST', headers, body: await unannounced.arrayBuffer() }),
      ctx(),
    );
    expect(res.status).toBe(411);
    expect(uploadImage).not.toHaveBeenCalled();
  });

  it("shows an ImageError's own status and words, and maps other failures like its neighbours", async () => {
    uploadImage.mockRejectedValueOnce(
      new ImageError(403, 'You do not have permission to change this picture.'),
    );
    const denied = await POST(await multipart(png()), ctx());
    expect(denied.status).toBe(403);
    expect(await message(denied)).toBe('You do not have permission to change this picture.');

    uploadImage.mockRejectedValueOnce(new ImageError(413, TOO_LARGE));
    expect((await POST(await multipart(png()), ctx())).status).toBe(413);

    uploadImage.mockRejectedValueOnce(new ApiError(401, 'failed with 401'));
    expect((await POST(await multipart(png()), ctx())).status).toBe(401);
    uploadImage.mockRejectedValueOnce(new ApiError(500, 'pg: internal detail'));
    const down = await POST(await multipart(png()), ctx());
    expect(down.status).toBe(502);
    expect(await down.text()).not.toContain('pg:');
  });
});

describe('DELETE remove', () => {
  const del = (key = 'user_avatar') =>
    DELETE(new Request(url(key), { method: 'DELETE', headers: { origin: ORIGIN } }), ctx(key));

  it('removes the current picture and answers 204 no-store', async () => {
    const res = await del();
    expect(res.status).toBe(204);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(removeImage).toHaveBeenCalledWith(staff, 'user_avatar', OWNER);
  });

  it('maps ImageError and API failures', async () => {
    removeImage.mockRejectedValueOnce(
      new ImageError(
        409,
        'This picture was changed at the same time. Reload the page and try again.',
      ),
    );
    const conflict = await del();
    expect(conflict.status).toBe(409);
    expect(await message(conflict)).toContain('Reload');
    removeImage.mockRejectedValueOnce(new ApiError(503, 'down'));
    expect((await del()).status).toBe(502);
  });
});
