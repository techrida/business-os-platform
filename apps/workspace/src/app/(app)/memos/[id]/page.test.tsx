import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { __resetEnvForTests } from '@/lib/env';

import MemoDetailPage from './page';

// `server-only` throws outside the react-server condition, which Vitest does not use.
vi.mock('server-only', () => ({}));

const mocks = vi.hoisted(() => ({
  requireStaffSession: vi.fn(),
  notFound: vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
}));

vi.mock('@/lib/bff', () => ({ requireStaffSession: mocks.requireStaffSession }));
vi.mock('next/navigation', () => ({
  notFound: mocks.notFound,
  redirect: vi.fn(),
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const MEMO = '11111111-1111-4111-8111-111111111111';
const REQUEST = '22222222-2222-4222-8222-222222222222';
const OWNER = '33333333-3333-4333-8333-333333333333';
const TENANT = '44444444-4444-4444-8444-444444444444';
const WHEN = '2026-11-17T05:45:00.000Z';

const memo = {
  template: null,
  id: MEMO,
  number: 'MEMO-0007',
  title: 'Office move',
  body: 'We move on Monday.',
  amount: '0.00',
  currency: 'NPR',
  amountNpr: '0.00',
  fxRate: '1',
  fxSource: 'fixed',
  fxDate: '2026-11-17',
  status: 'approved',
  ownerUserId: OWNER,
  departmentId: null,
  customerPartyId: null,
  editorUserIds: [],
  version: 3,
  createdAt: WHEN,
  updatedAt: WHEN,
  canUpdate: false,
  attachments: [],
  approval: { requestId: REQUEST, status: 'approved' },
};

const event = {
  id: '17',
  tenantId: TENANT,
  organizationId: TENANT,
  chainMonth: '2026-11-01',
  seq: 1,
  occurredAt: WHEN,
  actorKind: 'user',
  actorId: OWNER,
  actorDisplayName: 'Ram Thapa',
  action: 'test_memo.submitted',
  entityType: 'test_memo',
  entityId: MEMO,
  before: null,
  after: null,
  meta: null,
  canonical: { before: null, after: null, meta: null },
  ip: null,
  userAgent: null,
  correlationId: 'c',
  prevHash: '00',
  hash: 'ab',
};

/** The env the API client validates before any fetch; without it no request would reach the stub. */
function stubApiEnv() {
  for (const [k, v] of Object.entries({
    API_INTERNAL_URL: 'http://api:3001',
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
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

// The API's own answers: the memo for anyone who may read it, the audit list only with `audit.read`.
let auditAllowed = false;
// The live grants `GET /v1/me` reports; null answers 403 there, so the page falls back to the role defaults.
let liveGrants: string[] | null = null;
const fetchMock = vi.fn<typeof fetch>((input) => {
  const path = new URL(input as URL | string).pathname;
  if (path === '/v1/me' && liveGrants !== null) {
    return Promise.resolve(
      json(200, {
        userId: OWNER,
        tenantId: '00000000-0000-4000-8000-000000000001',
        organizationId: '00000000-0000-4000-8000-000000000002',
        orgKind: 'staff',
        partyId: null,
        roles: [],
        correlationId: 'req-12345678',
        permissions: liveGrants.map((permission) => ({ permission, scope: 'all' })),
      }),
    );
  }
  if (path === `/v1/test-memos/${MEMO}`) return Promise.resolve(json(200, memo));
  if (path === '/v1/audit' && auditAllowed) return Promise.resolve(json(200, { items: [event] }));
  return Promise.resolve(
    json(403, { error: { code: 'forbidden', message: 'Forbidden', correlationId: 'c' } }),
  );
});

const auditCalls = () =>
  fetchMock.mock.calls.filter(([url]) => new URL(url as URL | string).pathname === '/v1/audit');

async function render(roles: string[]): Promise<string> {
  mocks.requireStaffSession.mockResolvedValue({ accessToken: 'tok', roles, userId: OWNER });
  return renderToStaticMarkup(
    await MemoDetailPage({
      params: Promise.resolve({ id: MEMO }),
      searchParams: Promise.resolve({}),
    }),
  );
}

beforeEach(() => {
  mocks.requireStaffSession.mockReset();
  liveGrants = null;
  fetchMock.mockClear();
  stubApiEnv();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('memo detail page audit timeline', () => {
  it('does not ask for the audit trail when the role has no audit.read, and says it is hidden', async () => {
    auditAllowed = false;
    const html = await render(['sales']);
    expect(auditCalls()).toHaveLength(0);
    expect(html).toContain('Office move');
    expect(html).toContain('only open to roles with audit access');
  });

  it('still loads the audit trail, for the memo and its approval request, for a role with audit.read', async () => {
    auditAllowed = true;
    const html = await render(['finance']);
    const entityIds = auditCalls().map(([url]) =>
      new URL(url as URL | string).searchParams.get('entityId'),
    );
    expect(entityIds.sort()).toEqual([MEMO, REQUEST].sort());
    expect(html).not.toContain('only open to roles with audit access');
    expect(html).toContain('Ram Thapa');
  });

  it('loads the audit trail for a role whose saved grants add audit.read, though its defaults lack it', async () => {
    auditAllowed = true;
    liveGrants = ['audit.read'];
    const html = await render(['sales']);
    expect(auditCalls()).toHaveLength(2);
    expect(html).not.toContain('only open to roles with audit access');
  });

  it('asks nothing of the audit trail when the saved grants removed audit.read, though the defaults hold it', async () => {
    auditAllowed = true;
    liveGrants = ['memo.read'];
    const html = await render(['finance']);
    expect(auditCalls()).toHaveLength(0);
    expect(html).toContain('only open to roles with audit access');
  });
});
