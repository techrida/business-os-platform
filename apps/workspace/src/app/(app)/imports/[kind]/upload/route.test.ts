import { PARTY_IMPORT_MAX_BYTES, type PartyImportDetail } from '@bos/contracts';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/lib/api';
import type { Session } from '@/lib/session';

vi.mock('server-only', () => ({}));
const getSession = vi.fn<() => Promise<Session | null>>();
vi.mock('@/lib/session', () => ({ getSession: () => getSession() }));
vi.mock('@/lib/env', () => ({
  getEnv: () => ({ WORKSPACE_PUBLIC_URL: 'https://app.test', API_INTERNAL_URL: 'http://api.test' }),
}));
const previewImport =
  vi.fn<
    (
      s: Session,
      k: string,
      name: string,
      bytes: ArrayBuffer,
    ) => Promise<Pick<PartyImportDetail, 'id'>>
  >();
vi.mock('@/lib/api-imports', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api-imports')>()),
  previewImport: (s: Session, k: string, n: string, b: ArrayBuffer) => previewImport(s, k, n, b),
}));

const { POST } = await import('./route');

const ORIGIN = 'https://app.test';
const BATCH = '33333333-3333-4333-8333-333333333333';
const staff: Session = {
  id: 'A'.repeat(43),
  sub: 'u1',
  orgId: 'o1',
  orgKind: 'staff',
  roles: ['sales'],
  accessToken: 'eyJ.secret.sig',
  accessExp: 2_000_000_000,
  createdAt: 1,
  lastSeenAt: 1,
};
const ctx = (kind = 'customers') => ({ params: Promise.resolve({ kind }) });

async function multipart(
  file: File | null,
  opts: { origin?: string | null; kind?: string } = {},
): Promise<Request> {
  const form = new FormData();
  if (file !== null) form.set('file', file);
  const encoded = new Request(`${ORIGIN}/imports/${opts.kind ?? 'customers'}/upload`, {
    method: 'POST',
    body: form,
  });
  const body = new Uint8Array(await encoded.arrayBuffer());
  const headers: Record<string, string> = {
    'content-type': encoded.headers.get('content-type') ?? '',
    'content-length': String(body.byteLength),
  };
  if (opts.origin !== null) headers.origin = opts.origin ?? ORIGIN;
  return new Request(`${ORIGIN}/imports/${opts.kind ?? 'customers'}/upload`, {
    method: 'POST',
    body,
    headers,
  });
}
const csv = (text = 'legal_name\nAcme\n') => new File([text], 'people.csv', { type: 'text/csv' });
const location = (res: Response) =>
  decodeURIComponent((res.headers.get('location') ?? '').replaceAll('+', ' '));

beforeEach(() => {
  vi.clearAllMocks();
  getSession.mockResolvedValue(staff);
  previewImport.mockResolvedValue({ id: BATCH });
});

describe('POST /imports/:kind/upload', () => {
  it('refuses a request from another origin, or none, before reading the session or the file', async () => {
    for (const origin of ['https://evil.test', null]) {
      const res = await POST(await multipart(csv(), { origin }), ctx());
      expect(res.status).toBe(403);
    }
    expect(getSession).not.toHaveBeenCalled();
    expect(previewImport).not.toHaveBeenCalled();
  });

  it('answers 401 for no session and 403 for a portal session', async () => {
    getSession.mockResolvedValue(null);
    expect((await POST(await multipart(csv()), ctx())).status).toBe(401);
    getSession.mockResolvedValue({ ...staff, orgKind: 'customer' });
    expect((await POST(await multipart(csv()), ctx())).status).toBe(403);
    expect(previewImport).not.toHaveBeenCalled();
  });

  it('is a 404 for a kind that does not exist', async () => {
    expect(
      (await POST(await multipart(csv(), { kind: 'suppliers' }), ctx('suppliers'))).status,
    ).toBe(404);
  });

  it('sends the file bytes to the API for the right kind and redirects to the preview', async () => {
    const res = await POST(await multipart(csv('legal_name\nAcme\n')), ctx('vendors'));
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(`/imports/result/${BATCH}`);
    const [, kind, name, bytes] = previewImport.mock.calls[0]!;
    expect([kind, name, new TextDecoder().decode(bytes)]).toEqual([
      'vendor',
      'people.csv',
      'legal_name\nAcme\n',
    ]);
  });

  it('goes back to the upload page with the reason when there is no file, the file is too large, or the API refuses it', async () => {
    const none = await POST(await multipart(null), ctx());
    expect(none.status).toBe(303);
    expect(location(none)).toMatch(/^\/imports\/customers\?error=Choose a CSV file/);
    const big = new File([new Uint8Array(PARTY_IMPORT_MAX_BYTES + 1)], 'big.csv', {
      type: 'text/csv',
    });
    expect(location(await POST(await multipart(big), ctx()))).toMatch(/larger than 2 MB/);
    previewImport.mockRejectedValue(
      new ApiError(400, 'bad', {
        error: { code: 'bad_request', message: 'The column "x" is missing', correlationId: 'c1' },
      }),
    );
    expect(location(await POST(await multipart(csv()), ctx()))).toMatch(
      /The column "x" is missing/,
    );
  });

  it('does not take a body that is not a multipart upload', async () => {
    const req = new Request(`${ORIGIN}/imports/customers/upload`, {
      method: 'POST',
      body: 'legal_name\nA',
      headers: { origin: ORIGIN, 'content-type': 'text/csv' },
    });
    const res = await POST(req, ctx());
    expect(location(res)).toMatch(/Send the file as a file upload/);
    expect(previewImport).not.toHaveBeenCalled();
  });
});
