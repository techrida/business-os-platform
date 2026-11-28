import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from './api';
import { getInbox, getInboxPage, getInboxSummary } from './api-kernel';
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

const inboxItem = {
  requestId: ID_A,
  documentType: 'test_memo',
  documentId: ID_B,
  documentNumber: 'MEMO-2082-83-00001',
  title: 'Laptop purchase',
  amountNpr: '125000.00',
  reason: 'Base route: accountant checks the memo',
  activeStep: {
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
  },
  submittedAt: WHEN,
  version: 3,
};

const fetchMock = vi.fn<typeof fetch>();

const reply = (body: unknown, init: ResponseInit = {}): Response =>
  new Response(JSON.stringify(body), { status: 200, ...init });
const withTotal = (total: string): ResponseInit => ({ headers: { 'x-total-count': total } });

function lastUrl(): string {
  const [url] = fetchMock.mock.calls.at(-1) ?? [];
  return url instanceof Request ? url.url : url instanceof URL ? url.href : (url ?? '');
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

it('loads the aggregate counts without fetching inbox items', async () => {
  const summary = [{ documentType: 'test_memo', state: 'pending', age: 'under_week', count: 43 }];
  fetchMock.mockResolvedValue(reply(summary));
  expect(await getInboxSummary(session)).toEqual(summary);
  expect(lastUrl()).toBe('http://api:3001/v1/approvals/inbox/summary');
});

describe('getInboxPage', () => {
  it('sends repeated document types with the window and reads the total from the header', async () => {
    fetchMock.mockResolvedValue(reply([inboxItem], withTotal('41')));
    const page = await getInboxPage(session, {
      q: 'laptop & desk',
      documentType: ['test_memo', 'vendor_bill'],
      limit: 25,
      offset: 50,
    });
    expect(page.total).toBe(41);
    expect(page.items).toHaveLength(1);
    expect(lastUrl()).toBe(
      'http://api:3001/v1/approvals/inbox?q=laptop+%26+desk&documentType=test_memo&documentType=vendor_bill&limit=25&offset=50',
    );
  });

  it('omits empty filters and offset 0', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(reply([], withTotal('0'))));
    await getInboxPage(session, { documentType: [], limit: 10, offset: 0 });
    expect(lastUrl()).toBe('http://api:3001/v1/approvals/inbox?limit=10');
    await getInboxPage(session);
    expect(lastUrl()).toBe('http://api:3001/v1/approvals/inbox');
  });

  it.each([undefined, '', '-1', '4.5', 'many'])(
    'answers 502 when the total header is %j',
    async (header) => {
      fetchMock.mockResolvedValue(reply([], header === undefined ? {} : withTotal(header)));
      const err = await getInboxPage(session, { limit: 5 }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).status).toBe(502);
    },
  );

  it('answers 502 when a row drifts from the contract, without leaking the token', async () => {
    fetchMock.mockResolvedValue(reply([{ ...inboxItem, amountNpr: 125000 }], withTotal('1')));
    const err = await getInboxPage(session, { limit: 5 }).catch((e: unknown) => e);
    expect((err as ApiError).status).toBe(502);
    expect(JSON.stringify(err)).not.toContain(TOKEN);
  });

  it('passes a refusal through with its status so the page can word a 403', async () => {
    fetchMock.mockResolvedValue(
      reply(
        { error: { code: 'forbidden', message: 'Forbidden', correlationId: 'c' } },
        {
          status: 403,
        },
      ),
    );
    await expect(getInboxPage(session, { limit: 5 })).rejects.toMatchObject({ status: 403 });
  });
});

describe('getInbox', () => {
  it('still calls the bare URL, so the dashboard and detail page see everything', async () => {
    fetchMock.mockResolvedValue(reply([inboxItem]));
    await getInbox(session);
    expect(lastUrl()).toBe('http://api:3001/v1/approvals/inbox');
  });
});
