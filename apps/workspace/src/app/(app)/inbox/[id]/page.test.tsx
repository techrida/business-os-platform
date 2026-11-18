import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { __resetEnvForTests } from '@/lib/env';

import InboxDetailPage from './page';

// `server-only` throws outside the react-server condition, which Vitest does not use.
vi.mock('server-only', () => ({}));

const mocks = vi.hoisted(() => ({
  requireStaffSession: vi.fn(),
  notFound: vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
}));

vi.mock('@/lib/bff', () => ({ requireStaffSession: mocks.requireStaffSession }));
vi.mock('next/navigation', () => ({ notFound: mocks.notFound, redirect: vi.fn() }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const RID = '11111111-1111-4111-8111-111111111111';
const DOC = '22222222-2222-4222-8222-222222222222';
const REQUESTER = '33333333-3333-4333-8333-333333333333';
const NAMED = '44444444-4444-4444-8444-444444444444';
const GROUP = '55555555-5555-4555-8555-555555555555';
const WHEN = '2026-11-17T05:45:00.000Z';

const request = {
  requestId: RID,
  documentType: 'test_memo',
  documentId: DOC,
  documentNumber: 'PR-2082-0007',
  status: 'pending',
  blockReason: null,
  currentSeq: 1,
  version: 1,
  requesterUserId: REQUESTER,
  snapshot: { title: 'Two laptops' },
  steps: [
    {
      seq: 1,
      kind: 'user',
      roleKey: null,
      groupId: null,
      userId: NAMED,
      reason: 'Accountant checks it',
      status: 'active',
      activatedAt: WHEN,
      decidedBy: null,
      decidedOnBehalfOf: null,
    },
    {
      seq: 2,
      kind: 'group',
      roleKey: null,
      groupId: GROUP,
      userId: null,
      reason: 'Treasury approves',
      status: 'waiting',
      activatedAt: null,
      decidedBy: null,
      decidedOnBehalfOf: null,
      groupName: 'Treasury desk',
    },
  ],
  actions: [
    {
      action: 'submit',
      actorUserId: REQUESTER,
      onBehalfOfUserId: null,
      comment: null,
      createdAt: WHEN,
    },
  ],
  submittedAt: WHEN,
  decidedAt: null,
  people: [
    { userId: REQUESTER, name: 'Ram Thapa' },
    { userId: NAMED, name: 'Mina Rai' },
  ],
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

const fetchMock = vi.fn<typeof fetch>((input) => {
  const path = new URL(input as URL | string).pathname;
  if (path === `/v1/approvals/requests/${RID}`) return Promise.resolve(json(200, request));
  if (path === '/v1/approvals/inbox') return Promise.resolve(json(200, []));
  // Everything else, the admin directory included, is refused as the API refuses Sales and Accountants.
  return Promise.resolve(
    json(403, { error: { code: 'forbidden', message: 'Forbidden', correlationId: 'c' } }),
  );
});

beforeEach(() => {
  mocks.requireStaffSession.mockReset().mockResolvedValue({ accessToken: 'tok' });
  fetchMock.mockClear();
  stubApiEnv();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('inbox detail page', () => {
  it('labels people and groups from the request itself and calls no admin endpoint', async () => {
    const html = renderToStaticMarkup(
      await InboxDetailPage({ params: Promise.resolve({ id: RID }) }),
    );
    const paths = fetchMock.mock.calls.map(([url]) => new URL(url as URL | string).pathname);
    expect(paths).toContain(`/v1/approvals/requests/${RID}`);
    expect(paths.sort()).toEqual(['/v1/approvals/inbox', `/v1/approvals/requests/${RID}`]);
    expect(html).toContain('Ram Thapa');
    // The step the author assigned names that person; the group step its group's name.
    expect(html).toContain('Mina Rai');
    expect(html).toContain('Treasury desk');
    expect(html).not.toContain('name unavailable');
  });
});
