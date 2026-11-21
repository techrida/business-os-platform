import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  addFxRate,
  addWorkflowVersion,
  createDelegation,
  getApprovalSlaDefaults,
  getSetting,
  inviteUser,
  listApprovalGroups,
  listDelegations,
  listFxRates,
  listNumberSeries,
  listUsers,
  listWorkflows,
  publishWorkflowVersion,
  putSetting,
  revokeDelegation,
  setUserRoles,
} from './api-admin';
import { ApiError } from './api';
import { __resetEnvForTests } from './env';
import type { Session } from './session';

// `server-only` throws outside the react-server condition, which Vitest does not use.
vi.mock('server-only', () => ({}));

const TOKEN = 'eyJ.secret-access-token.sig';
const UUID_A = '00000000-0000-4000-8000-0000000000a1';
const UUID_B = '00000000-0000-4000-8000-0000000000b2';

const session: Session = {
  id: 'A'.repeat(43),
  sub: 'user-1',
  orgId: '00000000-0000-4000-8000-000000000002',
  orgKind: 'staff',
  roles: ['founder'],
  accessToken: TOKEN,
  accessExp: 2_000_000_000,
  createdAt: 1_700_000_000,
  lastSeenAt: 1_700_000_000,
};

const fetchMock = vi.fn<typeof fetch>();

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function lastCall(): { url: URL; method: string; body: unknown; headers: Headers } {
  const [url, init] = fetchMock.mock.calls.at(-1) ?? [];
  const requestInit = init ?? {};
  const href = url instanceof Request ? url.url : url instanceof URL ? url.href : (url ?? '');
  return {
    url: new URL(href),
    method: requestInit.method ?? 'GET',
    body:
      typeof requestInit.body === 'string' ? (JSON.parse(requestInit.body) as unknown) : undefined,
    headers: new Headers(requestInit.headers),
  };
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
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  __resetEnvForTests();
});

describe('users', () => {
  it('lists users with null names, sends the bearer token and passes the cursor', async () => {
    fetchMock.mockResolvedValueOnce(
      json({
        items: [
          {
            id: UUID_A,
            email: null,
            displayName: null,
            status: 'invited',
            idpOrgId: UUID_B,
            roles: [],
            department: null,
            lastActiveAt: null,
            createdAt: '2026-11-19T00:00:00.000Z',
          },
        ],
        nextAfter: UUID_A,
        nextPage: null,
      }),
    );
    const page = await listUsers(session, { limit: 10, after: UUID_B });
    expect(page.items[0]?.email).toBeNull();
    expect(page.items[0]?.idpOrgId).toBe(UUID_B);
    expect(page.nextAfter).toBe(UUID_A);
    const call = lastCall();
    expect(call.url.pathname).toBe('/v1/admin/users');
    expect(call.url.searchParams.get('limit')).toBe('10');
    expect(call.url.searchParams.get('after')).toBe(UUID_B);
    expect(call.headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
  });

  it('reads the total of all matches from X-Total-Count, and leaves it unknown without one', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ items: [], nextAfter: null, nextPage: 3 }), {
        headers: { 'content-type': 'application/json', 'x-total-count': '134' },
      }),
    );
    expect((await listUsers(session, { status: ['active'], page: 2 })).total).toBe(134);
    fetchMock.mockResolvedValueOnce(json({ items: [], nextAfter: null, nextPage: null }));
    expect((await listUsers(session)).total).toBeNull();
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ items: [], nextAfter: null, nextPage: null }), {
        headers: { 'content-type': 'application/json', 'x-total-count': '-1' },
      }),
    );
    expect((await listUsers(session)).total).toBeNull();
  });

  it('sends status and role filters as repeated params', async () => {
    fetchMock.mockResolvedValueOnce(json({ items: [], nextAfter: null, nextPage: null }));
    await listUsers(session, { status: ['active', 'invited'], role: ['sales'], q: 'ab', page: 2 });
    const { searchParams } = lastCall().url;
    expect(searchParams.getAll('status')).toEqual(['active', 'invited']);
    expect(searchParams.getAll('role')).toEqual(['sales']);
    expect(searchParams.get('q')).toBe('ab');
    expect(searchParams.get('page')).toBe('2');
  });

  it('turns a 403 into an ApiError that keeps the status and body but not the token', async () => {
    const body = { error: { code: 'forbidden', message: 'no', correlationId: 'req-12345678' } };
    fetchMock.mockResolvedValueOnce(json(body, 403));
    const error = await listUsers(session).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(403);
    expect((error as ApiError).body).toEqual(body);
    expect((error as ApiError).message).not.toContain(TOKEN);
  });

  it('answers 502 when the body does not match the agreed shape', async () => {
    fetchMock.mockResolvedValueOnce(
      json({ items: [{ id: UUID_A, roles: ['wizard'] }], nextAfter: null }),
    );
    const error = await listUsers(session).catch((e: unknown) => e);
    expect((error as ApiError).status).toBe(502);
  });

  it('invites with exactly the controller body', async () => {
    fetchMock.mockResolvedValueOnce(json({ userId: UUID_A }, 201));
    const out = await inviteUser(session, {
      email: 'a@b.test',
      givenName: 'Asha',
      familyName: 'Rai',
      roles: ['sales'],
    });
    expect(out).toEqual({ userId: UUID_A });
    const call = lastCall();
    expect(call.method).toBe('POST');
    expect(call.url.pathname).toBe('/v1/admin/users/invite');
    expect(call.headers.get('content-type')).toBe('application/json');
    expect(call.body).toEqual({
      email: 'a@b.test',
      givenName: 'Asha',
      familyName: 'Rai',
      roles: ['sales'],
    });
  });

  it('sets roles with PUT and accepts the empty 204 answer', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await expect(setUserRoles(session, UUID_A, ['finance'])).resolves.toBeUndefined();
    const call = lastCall();
    expect(call.method).toBe('PUT');
    expect(call.url.pathname).toBe(`/v1/admin/users/${UUID_A}/roles`);
    expect(call.body).toEqual({ roles: ['finance'] });
  });

  it('never lets a user id add a path segment', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await setUserRoles(session, '../../x?y', []);
    expect(lastCall().url.pathname).toBe('/v1/admin/users/..%2F..%2Fx%3Fy/roles');
  });
});

describe('settings, number series and FX', () => {
  it('reads a setting whose version is null (built-in default)', async () => {
    fetchMock.mockResolvedValueOnce(json({ key: 'tax.vat_rate', value: '13', version: null }));
    const s = await getSetting(session, 'tax.vat_rate');
    expect(s).toEqual({ key: 'tax.vat_rate', value: '13', version: null });
    expect(lastCall().url.pathname).toBe('/v1/admin/settings/tax.vat_rate');
  });

  it('reads the default approval times from the workflow-editor route, not the admin settings route', async () => {
    const value = {
      remindAfterHours: 8,
      escalateAfterHours: 36,
      escalateTo: { role: 'management' },
    };
    fetchMock.mockResolvedValueOnce(json({ key: 'approvals.sla_defaults', value, version: 3 }));
    const s = await getApprovalSlaDefaults(session);
    expect(s).toEqual({ key: 'approvals.sla_defaults', value, version: 3 });
    expect(lastCall().url.pathname).toBe('/v1/admin/approval-sla-defaults');
  });

  it('writes a setting as { value }', async () => {
    fetchMock.mockResolvedValueOnce(json({ version: 4 }));
    await expect(putSetting(session, 'currency.enabled', ['NPR', 'USD'])).resolves.toEqual({
      version: 4,
    });
    const call = lastCall();
    expect(call.method).toBe('PUT');
    expect(call.body).toEqual({ value: ['NPR', 'USD'] });
  });

  it('unwraps { items } for number series and FX rates, with a nullable source', async () => {
    fetchMock.mockResolvedValueOnce(
      json({
        items: [{ key: 'memo', fiscalYear: '2082/83', prefix: 'MEMO', nextValue: 3, pad: 5 }],
      }),
    );
    expect(await listNumberSeries(session)).toHaveLength(1);

    fetchMock.mockResolvedValueOnce(
      json({
        items: [
          {
            id: UUID_A,
            currency: 'USD',
            rateNpr: '133.500000',
            rateDate: '2026-11-08',
            source: null,
            enteredBy: null,
          },
        ],
      }),
    );
    const rates = await listFxRates(session, { currency: 'USD', limit: 5 });
    expect(rates[0]?.rateNpr).toBe('133.500000');
    expect(lastCall().url.searchParams.get('currency')).toBe('USD');
  });

  it('adds an FX rate with the controller body', async () => {
    fetchMock.mockResolvedValueOnce(json({ id: UUID_A }, 201));
    await addFxRate(session, {
      currency: 'INR',
      rateNpr: '1.6',
      rateDate: '2026-11-08',
      source: 'manual',
    });
    expect(lastCall().body).toEqual({
      currency: 'INR',
      rateNpr: '1.6',
      rateDate: '2026-11-08',
      source: 'manual',
    });
  });
});

const spec = {
  documentType: 'test_memo',
  steps: [{ id: 's1', kind: 'role', role: 'accountant', reason: 'Check' }],
  rules: [],
  distinctApprovers: true,
  sla: { remindAfterHours: 24, escalateAfterHours: 72, escalateTo: { role: 'founder' } },
};

describe('workflows, groups and delegations', () => {
  it('lists workflows (a bare array) with null publishedAt and currentVersionId', async () => {
    fetchMock.mockResolvedValueOnce(
      json([
        {
          id: UUID_A,
          key: 'test_memo',
          name: 'Test memo',
          documentType: 'test_memo',
          currentVersionId: null,
          versions: [{ id: UUID_B, version: 1, status: 'draft', spec, publishedAt: null }],
        },
      ]),
    );
    const out = await listWorkflows(session);
    expect(out[0]?.versions[0]?.status).toBe('draft');
    expect(out[0]?.currentVersionId).toBeNull();
  });

  it('posts a new version as exactly { spec } and publishes by version number', async () => {
    fetchMock.mockResolvedValueOnce(
      json({ id: UUID_B, version: 2, status: 'draft', spec, publishedAt: null }, 201),
    );
    await addWorkflowVersion(session, 'test_memo', spec);
    expect(lastCall().url.pathname).toBe('/v1/admin/workflows/test_memo/versions');
    expect(lastCall().body).toEqual({ spec });

    fetchMock.mockResolvedValueOnce(
      json({
        id: UUID_B,
        version: 2,
        status: 'published',
        spec,
        publishedAt: '2026-11-08T00:00:00.000Z',
      }),
    );
    const published = await publishWorkflowVersion(session, 'test_memo', 2);
    expect(published.status).toBe('published');
    const call = lastCall();
    expect(call.method).toBe('POST');
    expect(call.url.pathname).toBe('/v1/admin/workflows/test_memo/versions/2/publish');
    expect(call.body).toBeUndefined();
  });

  it('reads publishSoleEligible and publishes the sole eligible draft with exactly { reason }', async () => {
    fetchMock.mockResolvedValueOnce(
      json([
        {
          id: UUID_A,
          key: 'test_memo',
          name: 'Test memo',
          documentType: 'test_memo',
          currentVersionId: null,
          versions: [
            {
              id: UUID_B,
              version: 2,
              status: 'draft',
              spec,
              publishedAt: null,
              savedByCaller: true,
              publishSoleEligible: true,
            },
          ],
        },
      ]),
    );
    const [workflow] = await listWorkflows(session);
    expect(workflow?.versions[0]?.publishSoleEligible).toBe(true);

    fetchMock.mockResolvedValueOnce(
      json({ id: UUID_B, version: 2, status: 'published', spec, publishedAt: null }),
    );
    await publishWorkflowVersion(session, 'test_memo', 2, 'Only founder on the team');
    expect(lastCall().url.pathname).toBe('/v1/admin/workflows/test_memo/versions/2/publish');
    expect(lastCall().body).toEqual({ reason: 'Only founder on the team' });
  });

  it('lists groups and delegations as bare arrays', async () => {
    fetchMock.mockResolvedValueOnce(
      json([{ id: UUID_A, key: 'ops', name: 'Ops', memberUserIds: [UUID_B] }]),
    );
    expect((await listApprovalGroups(session))[0]?.memberUserIds).toEqual([UUID_B]);

    fetchMock.mockResolvedValueOnce(
      json([
        {
          id: UUID_A,
          fromUserId: UUID_A,
          toUserId: UUID_B,
          startsAt: '2026-11-08T00:00:00.000Z',
          endsAt: '2026-11-09T00:00:00.000Z',
          documentType: null,
        },
      ]),
    );
    expect((await listDelegations(session))[0]?.documentType).toBeNull();
  });

  it('creates and revokes a delegation', async () => {
    fetchMock.mockResolvedValueOnce(json({ id: UUID_A }, 201));
    const b = {
      fromUserId: UUID_A,
      toUserId: UUID_B,
      startsAt: '2026-11-08T09:00:00+05:45',
      endsAt: '2026-11-09T09:00:00+05:45',
      documentType: null,
    };
    await createDelegation(session, b);
    expect(lastCall().body).toEqual(b);

    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await revokeDelegation(session, UUID_A);
    expect(lastCall().method).toBe('DELETE');
    expect(lastCall().url.pathname).toBe(`/v1/admin/delegations/${UUID_A}`);
  });
});
