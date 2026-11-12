import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from './api';
import {
  actOnApproval,
  createDocument,
  failureOf,
  getApprovalRequest,
  getInbox,
  getMemo,
  getUnreadCount,
  issueDocumentLink,
  listAudit,
  listMemos,
  listNotifications,
  markNotificationRead,
  openSignedFile,
  previewRoute,
  submitMemo,
  uploadDocumentContent,
} from './api-kernel';
import { __resetEnvForTests } from './env';
import type { Session } from './session';

// `server-only` throws outside the react-server condition, which Vitest does not use.
vi.mock('server-only', () => ({}));

const TOKEN = 'eyJ.secret-access-token.sig';
const ID_A = '11111111-1111-4111-8111-111111111111';
const ID_B = '22222222-2222-4222-8222-222222222222';
const WHEN = '2026-11-08T05:45:00.000Z';

const session: Session = {
  id: 'A'.repeat(43),
  sub: 'user-1',
  orgId: ID_A,
  orgKind: 'staff',
  roles: ['finance'],
  accessToken: TOKEN,
  accessExp: 2_000_000_000,
  createdAt: 1_700_000_000,
  lastSeenAt: 1_700_000_000,
};

const step = {
  seq: 1,
  kind: 'role',
  roleKey: 'accountant',
  groupId: null,
  userId: null,
  reason: 'Base route: accountant checks the memo',
  status: 'active',
  activatedAt: WHEN,
  decidedBy: null,
  decidedOnBehalfOf: null,
};

const inboxItem = {
  requestId: ID_A,
  documentType: 'test_memo',
  documentId: ID_B,
  documentNumber: 'MEMO-2082-83-00001',
  title: 'Laptop purchase',
  amountNpr: '125000.00',
  reason: 'Base route: accountant checks the memo',
  activeStep: step,
  submittedAt: WHEN,
  version: 3,
};

const memo = {
  id: ID_A,
  number: 'MEMO-2082-83-00001',
  title: 'Laptop purchase',
  body: 'Two laptops',
  amount: '1000.00',
  currency: 'USD',
  amountNpr: '133000.00',
  fxRate: '133.000000',
  fxSource: 'nrb',
  fxDate: '2026-11-08',
  status: 'draft',
  ownerUserId: ID_B,
  departmentId: null,
  customerPartyId: null,
  editorUserIds: [],
  version: 1,
  createdAt: WHEN,
  updatedAt: WHEN,
};

const version = {
  id: ID_B,
  documentId: ID_A,
  version: 1,
  filename: 'quote.pdf',
  declaredMime: 'application/pdf',
  detectedMime: 'application/pdf',
  sizeBytes: 2048,
  sha256: 'a'.repeat(64),
  status: 'clean',
  scanSignature: null,
  scannedAt: WHEN,
  uploadedBy: ID_B,
  createdAt: WHEN,
};

const fetchMock = vi.fn<typeof fetch>();

const reply = (body: unknown, status = 200): Response =>
  new Response(body === undefined ? null : JSON.stringify(body), { status });

function lastCall(): { url: string; init: RequestInit & { duplex?: string }; headers: Headers } {
  const [url, init] = fetchMock.mock.calls.at(-1) ?? [];
  const requestInit = (init ?? {}) as RequestInit & { duplex?: string };
  const href = url instanceof Request ? url.url : url instanceof URL ? url.href : (url ?? '');
  return { url: href, init: requestInit, headers: new Headers(requestInit.headers) };
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

describe('approvals', () => {
  it('reads the inbox as a bare array with the bearer token', async () => {
    fetchMock.mockResolvedValue(reply([inboxItem]));
    const items = await getInbox(session);
    expect(items).toHaveLength(1);
    expect(items[0]?.documentNumber).toBe('MEMO-2082-83-00001');
    const { url, headers } = lastCall();
    expect(url).toBe('http://api:3001/v1/approvals/inbox');
    expect(headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
  });

  it('answers 502 when the API drifts from the contract, and never leaks the token', async () => {
    fetchMock.mockResolvedValue(reply([{ ...inboxItem, amountNpr: 125000 }]));
    const err = await getInbox(session).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(502);
    expect(JSON.stringify(err)).not.toContain(TOKEN);
  });

  it('sends Idempotency-Key and the action body', async () => {
    fetchMock.mockResolvedValue(
      reply({
        requestId: ID_A,
        documentType: 'test_memo',
        documentId: ID_B,
        documentNumber: 'MEMO-1',
        status: 'pending',
        blockReason: null,
        currentSeq: 2,
        version: 4,
        requesterUserId: ID_B,
        snapshot: { title: 'x' },
        steps: [step],
        actions: [],
        submittedAt: WHEN,
        decidedAt: null,
      }),
    );
    const out = await actOnApproval(
      session,
      ID_A,
      { action: 'return', comment: 'Add the quote', expectedVersion: 3 },
      'key-0001-abcd',
    );
    expect(out.version).toBe(4);
    const { url, init, headers } = lastCall();
    expect(url).toBe(`http://api:3001/v1/approvals/requests/${ID_A}/actions`);
    expect(init.method).toBe('POST');
    expect(headers.get('idempotency-key')).toBe('key-0001-abcd');
    expect(headers.get('content-type')).toBe('application/json');
    expect(JSON.parse(init.body as string)).toEqual({
      action: 'return',
      comment: 'Add the quote',
      expectedVersion: 3,
    });
  });

  it('encodes an id so it cannot climb out of the route', async () => {
    fetchMock.mockResolvedValue(reply({}, 404));
    await getApprovalRequest(session, '../admin/users').catch(() => undefined);
    expect(lastCall().url).toBe('http://api:3001/v1/approvals/requests/..%2Fadmin%2Fusers');
  });

  it('previews a route', async () => {
    fetchMock.mockResolvedValue(
      reply({
        steps: [
          {
            seq: 1,
            kind: 'role',
            roleKey: 'accountant',
            reason: 'Base route',
            eligibleUserIds: [ID_A],
            blocked: false,
          },
        ],
        blocked: false,
      }),
    );
    const plan = await previewRoute(session, {
      documentType: 'test_memo',
      facts: { amountNpr: '1000.00' },
      sodUserIds: [ID_B],
    });
    expect(plan.steps[0]?.reason).toBe('Base route');
    expect(JSON.parse(lastCall().init.body as string)).toEqual({
      documentType: 'test_memo',
      facts: { amountNpr: '1000.00' },
      sodUserIds: [ID_B],
    });
  });
});

describe('failureOf', () => {
  it('words a separation-of-duties 403 from the error body reason', async () => {
    fetchMock.mockResolvedValue(
      reply(
        {
          error: {
            code: 'forbidden',
            message: 'no',
            correlationId: 'req-12345678',
            reason: 'separation_of_duties',
          },
        },
        403,
      ),
    );
    const err = await getApprovalRequest(session, ID_A).catch((e: unknown) => e);
    const f = failureOf(err, 'approval');
    expect(f.status).toBe(403);
    expect(f.message).toBe("You prepared this document, so you can't approve it.");
    expect(f.reload).toBe(false);
    expect(f.definite).toBe(true);
  });

  it('says the request changed on a 409 for an approval and offers a reload', async () => {
    fetchMock.mockResolvedValue(
      reply({ error: { code: 'conflict', message: 'stale', correlationId: 'req-12345678' } }, 409),
    );
    const err = await getApprovalRequest(session, ID_A).catch((e: unknown) => e);
    const f = failureOf(err, 'approval');
    expect(f.message).toBe('This request changed since you opened it.');
    expect(f.reload).toBe(true);
  });

  it('words a 409 on submit as a scan problem, not a stale page', () => {
    const f = failureOf(new ApiError(409, 'x', { error: { code: 'conflict' } }), 'submit');
    expect(f.message).toMatch(/virus scan/);
    expect(f.reload).toBe(false);
  });

  it('treats a failed fetch as not definite so the same key is sent again', () => {
    const f = failureOf(new TypeError('fetch failed'));
    expect(f.status).toBe(0);
    expect(f.definite).toBe(false);
  });

  it('treats a 500 as not definite', () => {
    expect(failureOf(new ApiError(500, 'boom')).definite).toBe(false);
  });
});

describe('memos', () => {
  it('parses the memo with attachments and approval summary', async () => {
    fetchMock.mockResolvedValue(
      reply({
        ...memo,
        attachments: [version],
        approval: { requestId: ID_A, status: 'pending' },
      }),
    );
    const detail = await getMemo(session, ID_A);
    expect(detail.attachments[0]?.filename).toBe('quote.pdf');
    expect(detail.approval?.status).toBe('pending');
    expect(lastCall().url).toBe(`http://api:3001/v1/test-memos/${ID_A}`);
  });

  it('lists one page of memos and forwards only limit, cursor and status', async () => {
    fetchMock.mockResolvedValue(
      reply({
        items: [
          {
            id: ID_A,
            number: memo.number,
            title: memo.title,
            status: 'draft',
            amount: memo.amount,
            currency: 'USD',
            ownerUserId: ID_B,
            ownerName: 'Sushil Shrestha',
            departmentName: null,
            createdAt: WHEN,
            updatedAt: WHEN,
          },
        ],
        nextCursor: 'abc_-123',
      }),
    );
    const page = await listMemos(session, { limit: 20, cursor: 'prev', status: 'draft' });
    expect(page.items[0]?.ownerName).toBe('Sushil Shrestha');
    expect(page.nextCursor).toBe('abc_-123');
    expect(lastCall().url).toBe('http://api:3001/v1/test-memos?limit=20&cursor=prev&status=draft');
    fetchMock.mockResolvedValue(reply({ items: [], nextCursor: null }));
    await listMemos(session);
    expect(lastCall().url).toBe('http://api:3001/v1/test-memos');
  });

  it('refuses a list body that breaks the contract instead of rendering undefined', async () => {
    fetchMock.mockResolvedValue(reply({ items: [{ id: 'not-a-guid' }], nextCursor: null }));
    await expect(listMemos(session)).rejects.toMatchObject({ status: 502 });
  });

  it('submits and returns the request id', async () => {
    fetchMock.mockResolvedValue(reply({ requestId: ID_B, status: 'blocked' }));
    const out = await submitMemo(session, ID_A);
    expect(out).toEqual({ requestId: ID_B, status: 'blocked' });
    expect(lastCall().init.method).toBe('POST');
  });
});

describe('documents', () => {
  it('creates the document, then streams the content with Content-Length and duplex half', async () => {
    fetchMock.mockResolvedValueOnce(
      reply({
        documentId: ID_A,
        versionId: ID_B,
        uploadPath: `/v1/documents/${ID_A}/versions/${ID_B}/content`,
      }),
    );
    const created = await createDocument(session, {
      ownerType: 'test_memo',
      ownerId: ID_A,
      filename: 'quote.pdf',
      declaredMime: 'application/pdf',
      sizeBytes: 2048,
    });
    expect(lastCall().url).toBe('http://api:3001/v1/documents');

    fetchMock.mockResolvedValueOnce(reply({ ...version, status: 'quarantined' }));
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new Uint8Array(2048));
        c.close();
      },
    });
    const out = await uploadDocumentContent(session, created, {
      body,
      contentLength: 2048,
      contentType: 'application/pdf',
    });
    expect(out.status).toBe('quarantined');
    const { url, init, headers } = lastCall();
    expect(url).toBe(`http://api:3001/v1/documents/${ID_A}/versions/${ID_B}/content`);
    expect(init.method).toBe('PUT');
    expect(init.duplex).toBe('half');
    expect(init.body).toBe(body);
    expect(headers.get('content-length')).toBe('2048');
    expect(headers.get('content-type')).toBe('application/pdf');
  });

  it('refuses an upload path that is not the one for this document and version', async () => {
    const body = new ReadableStream<Uint8Array>();
    await expect(
      uploadDocumentContent(
        session,
        { documentId: ID_A, versionId: ID_B, uploadPath: '/v1/admin/users' },
        { body, contentLength: 1, contentType: 'application/pdf' },
      ),
    ).rejects.toMatchObject({ status: 502 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('issues a link and fetches the signed file over the internal URL', async () => {
    fetchMock.mockResolvedValueOnce(reply({ url: '/v1/files/abc.def_ghi', expiresAt: WHEN }));
    const link = await issueDocumentLink(session, ID_A, ID_B);
    expect(lastCall().url).toBe(`http://api:3001/v1/documents/${ID_A}/versions/${ID_B}/link`);

    fetchMock.mockResolvedValueOnce(new Response('bytes', { status: 200 }));
    const res = await openSignedFile(session, link);
    expect(await res.text()).toBe('bytes');
    expect(lastCall().url).toBe('http://api:3001/v1/files/abc.def_ghi');
  });

  it.each(['https://evil.test/v1/files/x', '/v1/files/../me', '//evil.test/v1/files/x', '/other'])(
    'refuses the link form %s',
    async (url) => {
      await expect(openSignedFile(session, { url, expiresAt: WHEN })).rejects.toMatchObject({
        status: 502,
      });
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it('surfaces a failed download as an ApiError with the status', async () => {
    fetchMock.mockResolvedValue(
      reply({ error: { code: 'not_found', message: 'gone', correlationId: 'req-12345678' } }, 404),
    );
    await expect(
      openSignedFile(session, { url: '/v1/files/tok', expiresAt: WHEN }),
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe('notifications', () => {
  const note = {
    id: ID_A,
    title: 'Approval needed',
    body: 'MEMO-1 is waiting',
    link: `/inbox/${ID_B}`,
    readAt: null,
    createdAt: WHEN,
  };

  it('lists with limit and before', async () => {
    fetchMock.mockResolvedValue(reply([note]));
    const out = await listNotifications(session, { limit: 20, before: ID_B });
    expect(out[0]?.title).toBe('Approval needed');
    expect(lastCall().url).toBe(`http://api:3001/v1/notifications?limit=20&before=${ID_B}`);
  });

  it('reads the unread count', async () => {
    fetchMock.mockResolvedValue(reply({ count: 3 }));
    expect(await getUnreadCount(session)).toEqual({ count: 3 });
  });

  it('marks read without parsing the empty 204 body', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    await expect(markNotificationRead(session, ID_A)).resolves.toBeUndefined();
    expect(lastCall().url).toBe(`http://api:3001/v1/notifications/${ID_A}/read`);
    expect(lastCall().init.method).toBe('POST');
  });

  it('throws on a failed mark-read', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 404 }));
    await expect(markNotificationRead(session, ID_A)).rejects.toMatchObject({ status: 404 });
  });
});

describe('audit', () => {
  it('unwraps { items } and filters by entity', async () => {
    fetchMock.mockResolvedValue(
      reply({
        items: [
          {
            id: '42',
            tenantId: ID_A,
            organizationId: ID_B,
            chainMonth: '2026-11-01',
            seq: 1,
            occurredAt: WHEN,
            actorKind: 'user',
            actorId: ID_B,
            action: 'test_memos.update',
            entityType: 'test_memos',
            entityId: ID_A,
            before: null,
            after: { title: 'x' },
            meta: null,
            canonical: { before: null, after: '{"title": "x"}', meta: null },
            ip: null,
            userAgent: null,
            correlationId: 'req-12345678',
            prevHash: '00',
            hash: 'ab',
          },
        ],
      }),
    );
    const events = await listAudit(session, { entityId: ID_A, limit: 50 });
    expect(events).toHaveLength(1);
    expect(events[0]?.action).toBe('test_memos.update');
    expect(lastCall().url).toBe(`http://api:3001/v1/audit?entityId=${ID_A}&limit=50`);
  });
});
