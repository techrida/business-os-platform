import { beforeEach, expect, it, vi } from 'vitest';

const session = vi.hoisted(() => ({ roles: ['accountant'] as string[] }));
const api = vi.hoisted(() => ({
  createBillDocument: vi.fn(),
  replaceBillDocument: vi.fn(),
  uploadBillDocumentContent: vi.fn(),
}));
const bff = vi.hoisted(() => ({ isSameOrigin: vi.fn(), routeSession: vi.fn() }));
vi.mock('@/lib/api-payables', () => api);
// GET /v1/me for an unedited role answers the role's default grants; a test sets `live` for an edited one.
const grants = vi.hoisted(() => ({ live: undefined as Map<string, string> | undefined }));
vi.mock('@/lib/grants', async () => {
  const { DEFAULT_ROLE_PERMISSIONS } = await import('@bos/contracts');
  return {
    getGrants: () =>
      Promise.resolve(
        grants.live ??
          new Map(
            session.roles.flatMap((r) =>
              Object.entries(DEFAULT_ROLE_PERMISSIONS[r as keyof typeof DEFAULT_ROLE_PERMISSIONS]),
            ),
          ),
      ),
    hasGrant: (g: Map<string, string>, p: string) => g.has(p),
  };
});
vi.mock('@/lib/bff', () => ({
  ...bff,
  forbiddenOrigin: () => new Response(null, { status: 403 }),
  jsonResponse: (body: unknown, status = 200) => Response.json(body, { status }),
  errorResponse: () => Response.json({ error: { message: 'The upload failed.' } }, { status: 502 }),
}));

const { POST } = await import('./route');
const id = '11111111-1111-4111-8111-111111111111';
const created = {
  documentId: id,
  versionId: id,
  uploadPath: `/v1/payables/bill-documents/${id}/versions/${id}/content`,
};
const req = (headers: Record<string, string> = {}) =>
  new Request('https://workspace.test/payables/bill-documents', {
    method: 'POST',
    headers: {
      origin: 'https://workspace.test',
      'content-type': 'application/pdf',
      'content-length': '4',
      'x-file-name': 'invoice.pdf',
      'x-vendor-id': id,
      ...headers,
    },
    body: 'data',
  });

beforeEach(() => {
  vi.clearAllMocks();
  session.roles = ['accountant'];
  grants.live = undefined;
  bff.isSameOrigin.mockReturnValue(true);
  bff.routeSession.mockResolvedValue(session);
  api.createBillDocument.mockResolvedValue(created);
  api.replaceBillDocument.mockResolvedValue(created);
  api.uploadBillDocumentContent.mockResolvedValue({});
});

it('declares the invoice with its vendor and streams bytes without buffering', async () => {
  const response = await POST(req());
  expect(response.status).toBe(201);
  expect(await response.json()).toEqual({ documentId: id, versionId: id });
  expect(api.createBillDocument).toHaveBeenCalledWith(session, id, {
    filename: 'invoice.pdf',
    declaredMime: 'application/pdf',
    sizeBytes: 4,
  });
  const upload: unknown = api.uploadBillDocumentContent.mock.calls[0]?.[2];
  expect(upload).toMatchObject({ contentType: 'application/pdf', contentLength: 4 });
  expect((upload as { body: unknown }).body).toBeInstanceOf(ReadableStream);
});

it('rejects other origins before reading a session or creating files', async () => {
  bff.isSameOrigin.mockReturnValue(false);
  expect((await POST(req())).status).toBe(403);
  expect(bff.routeSession).not.toHaveBeenCalled();
  expect(api.createBillDocument).not.toHaveBeenCalled();
});

it('preserves a sign-in refusal and denies finance before any upload', async () => {
  bff.routeSession.mockResolvedValueOnce(new Response(null, { status: 401 }));
  expect((await POST(req())).status).toBe(401);
  session.roles = ['finance'];
  expect((await POST(req())).status).toBe(403);
  expect(api.createBillDocument).not.toHaveBeenCalled();
});

it.each([
  [{ 'x-vendor-id': '../wrong' }, 400],
  [{ 'content-length': '0' }, 400],
  [{ 'content-length': 'n/a' }, 411],
  [{ 'content-length': '26214401' }, 413],
  [{ 'x-file-name': encodeURIComponent('../invoice.pdf') }, 400],
])('rejects invalid declarations before the API (%j)', async (headers, status) => {
  expect((await POST(req(headers))).status).toBe(status);
  expect(api.createBillDocument).not.toHaveBeenCalled();
  expect(api.uploadBillDocumentContent).not.toHaveBeenCalled();
});

it('returns the normal upload failure response when the stream fails', async () => {
  api.uploadBillDocumentContent.mockRejectedValue(new Error('network'));
  expect((await POST(req())).status).toBe(502);
});

it('replaces the existing invoice document without creating a second document', async () => {
  const response = await POST(req({ 'x-document-id': id, 'x-vendor-id': '' }));
  expect(response.status).toBe(201);
  expect(api.replaceBillDocument).toHaveBeenCalledWith(session, id, {
    filename: 'invoice.pdf',
    declaredMime: 'application/pdf',
    sizeBytes: 4,
  });
  expect(api.createBillDocument).not.toHaveBeenCalled();
  const upload: unknown = api.uploadBillDocumentContent.mock.calls[0]?.[2];
  expect(upload).toMatchObject({ contentType: 'application/pdf', contentLength: 4 });
  expect((upload as { body: unknown }).body).toBeInstanceOf(ReadableStream);
});

// The new-bill page opens on the live grants; the invoice upload it makes agrees with it.
it('lets Procurement upload once an admin granted payables.bill.enter, and refuses an accountant without it', async () => {
  session.roles = ['procurement'];
  grants.live = new Map([['payables.bill.enter', 'all']]);
  expect((await POST(req())).status).toBe(201);
  expect(api.createBillDocument).toHaveBeenCalledOnce();
  api.createBillDocument.mockClear();
  session.roles = ['accountant'];
  grants.live = new Map([['payables.bill.read', 'all']]);
  expect((await POST(req())).status).toBe(403);
  expect(api.createBillDocument).not.toHaveBeenCalled();
});

it('rejects a malformed replacement id instead of silently creating a new document', async () => {
  expect((await POST(req({ 'x-document-id': '../wrong' }))).status).toBe(400);
  expect(api.replaceBillDocument).not.toHaveBeenCalled();
  expect(api.createBillDocument).not.toHaveBeenCalled();
});
