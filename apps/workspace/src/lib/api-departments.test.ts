import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from './api';
import {
  createDepartment,
  DEPARTMENT_ACCESS_STALE_MESSAGE,
  DEPARTMENT_FORBIDDEN_MESSAGE,
  DEPARTMENT_STALE_MESSAGE,
  getDepartment,
  listActiveStaff,
  listDepartments,
  listUnassignedPeople,
  mapDepartmentWriteError,
  renameDepartment,
  retireDepartment,
  saveDepartmentPeople,
} from './api-departments';
import { __resetEnvForTests } from './env';
import type { Session } from './session';

vi.mock('server-only', () => ({}));

const TOKEN = 'eyJ.secret-access-token.sig';
const USER_A = '00000000-0000-4000-8000-0000000000a1';
const USER_B = '00000000-0000-4000-8000-0000000000b2';
const DEPT_A = '00000000-0000-4000-8000-0000000000d1';
const DEPT_B = '00000000-0000-4000-8000-0000000000d2';
const ORG_ID = '00000000-0000-4000-8000-000000000002';
const IDP = '00000000-0000-4000-8000-000000000003';

const session: Session = {
  id: 'A'.repeat(43),
  sub: USER_A,
  orgId: ORG_ID,
  orgKind: 'staff',
  roles: ['founder'],
  accessToken: TOKEN,
  accessExp: 2_000_000_000,
  createdAt: 1_700_000_000,
  lastSeenAt: 1_700_000_000,
};

const item = {
  id: DEPT_A,
  name: 'Sales',
  status: 'active',
  retiredAt: null,
  head: { id: USER_A, name: 'Asha K.' },
  managers: 2,
  members: 9,
  version: 3,
};

const detail = {
  ...item,
  memberCount: 1,
  members: [
    {
      userId: USER_A,
      name: 'Asha K.',
      email: 'asha@example.test',
      jobTitle: 'Sales lead',
      level: 'head',
      roles: ['sales'],
      since: '2026-01-04T00:00:00.000Z',
    },
  ],
  revision: '12',
};

const fetchMock = vi.fn<typeof fetch>();

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function errorBody(code: string, message: string, extra: Record<string, unknown> = {}) {
  return { error: { code, message, correlationId: 'corr-1', ...extra } };
}

function lastCall(): { url: URL; method: string; body: unknown } {
  const [url, init] = fetchMock.mock.calls.at(-1) ?? [];
  const requestInit = init ?? {};
  const href = url instanceof Request ? url.url : url instanceof URL ? url.href : (url ?? '');
  return {
    url: new URL(href),
    method: requestInit.method ?? 'GET',
    body:
      typeof requestInit.body === 'string' ? (JSON.parse(requestInit.body) as unknown) : undefined,
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

describe('departments reads', () => {
  it('sends the search and each status as its own param', async () => {
    fetchMock.mockResolvedValueOnce(json({ items: [item], unassigned: 7 }));
    const list = await listDepartments(session, { q: 'sal', status: ['active', 'retired'] });
    expect(list.unassigned).toBe(7);
    expect(list.items[0]?.members).toBe(9);
    const call = lastCall();
    expect(call.url.pathname).toBe('/v1/admin/departments');
    expect(call.url.searchParams.get('q')).toBe('sal');
    expect(call.url.searchParams.getAll('status')).toEqual(['active', 'retired']);
  });

  it('leaves the status out so the API default (active) applies', async () => {
    fetchMock.mockResolvedValueOnce(json({ items: [], unassigned: 0 }));
    await listDepartments(session);
    expect(lastCall().url.search).toBe('');
  });

  it('returns null for an unknown, forbidden or malformed department id', async () => {
    fetchMock.mockResolvedValueOnce(json(errorBody('not_found', 'Department not found'), 404));
    expect(await getDepartment(session, DEPT_B)).toBeNull();
    fetchMock.mockResolvedValueOnce(json(errorBody('forbidden', 'Forbidden'), 403));
    expect(await getDepartment(session, DEPT_B)).toBeNull();
    fetchMock.mockClear();
    expect(await getDepartment(session, 'not-a-guid')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('validates the department detail', async () => {
    fetchMock.mockResolvedValueOnce(json(detail));
    const out = await getDepartment(session, DEPT_A);
    expect(out?.revision).toBe('12');
    expect(out?.members[0]?.level).toBe('head');
    fetchMock.mockResolvedValueOnce(json({ ...detail, revision: '' }));
    const err = await getDepartment(session, DEPT_A).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(502);
  });

  it('lists unassigned people with a search', async () => {
    fetchMock.mockResolvedValueOnce(json({ items: [], total: 0 }));
    await listUnassignedPeople(session, 'bib');
    const call = lastCall();
    expect(call.url.pathname).toBe('/v1/admin/departments/unassigned');
    expect(call.url.searchParams.get('q')).toBe('bib');
  });

  it('pages through active staff and keeps their department', async () => {
    const user = (id: string, name: string, department: { id: string; name: string } | null) => ({
      id,
      idpOrgId: IDP,
      email: `${name.toLowerCase()}@example.test`,
      displayName: name,
      status: 'active',
      roles: ['sales'],
      department,
      createdAt: '2026-11-19T00:00:00.000Z',
      lastActiveAt: null,
    });
    fetchMock
      .mockResolvedValueOnce(
        json({
          items: [user(USER_B, 'Bibek', { id: DEPT_B, name: 'Marketing' })],
          nextAfter: USER_B,
          nextPage: null,
        }),
      )
      .mockResolvedValueOnce(
        json({ items: [user(USER_A, 'Asha', null)], nextAfter: null, nextPage: null }),
      );
    const staff = await listActiveStaff(session);
    expect(staff.map((s) => s.name)).toEqual(['Asha', 'Bibek']);
    expect(staff[1]?.department).toEqual({ id: DEPT_B, name: 'Marketing' });
    expect(lastCall().url.searchParams.getAll('status')).toEqual(['active']);
    expect(lastCall().url.searchParams.get('after')).toBe(USER_B);
  });

  it('returns no staff when the viewer may not list users', async () => {
    fetchMock.mockResolvedValueOnce(json(errorBody('forbidden', 'Forbidden'), 403));
    expect(await listActiveStaff(session)).toEqual([]);
  });
});

describe('departments writes', () => {
  it('creates with an optional head and sends no other keys', async () => {
    fetchMock.mockResolvedValueOnce(json(detail, 201));
    await createDepartment(session, { name: 'Sales', headUserId: USER_A });
    expect(lastCall().body).toEqual({ name: 'Sales', headUserId: USER_A });
    fetchMock.mockResolvedValueOnce(json(detail, 201));
    await createDepartment(session, { name: 'Sales' });
    expect(lastCall().body).toEqual({ name: 'Sales' });
  });

  it('renames with the expected version', async () => {
    fetchMock.mockResolvedValueOnce(json(detail));
    await renameDepartment(session, DEPT_A, { name: 'Sales team', expectedVersion: 3 });
    const call = lastCall();
    expect(call.method).toBe('PATCH');
    expect(call.url.pathname).toBe(`/v1/admin/departments/${DEPT_A}`);
    expect(call.body).toEqual({ name: 'Sales team', expectedVersion: 3 });
  });

  it('keeps the three meanings of the retire destination apart', async () => {
    // A Response body reads once, so each call gets a fresh one.
    fetchMock.mockImplementation(() => Promise.resolve(json(detail)));
    await retireDepartment(session, DEPT_A, { expectedVersion: 3 });
    expect(lastCall().body).toEqual({ expectedVersion: 3 });
    await retireDepartment(session, DEPT_A, { expectedVersion: 3, moveMembersTo: null });
    expect(lastCall().body).toEqual({ expectedVersion: 3, moveMembersTo: null });
    await retireDepartment(session, DEPT_A, { expectedVersion: 3, moveMembersTo: DEPT_B });
    expect(lastCall().body).toEqual({ expectedVersion: 3, moveMembersTo: DEPT_B });
    expect(lastCall().url.pathname).toBe(`/v1/admin/departments/${DEPT_A}/retire`);
  });

  it('saves people changes against the access revision with a boolean acknowledgement', async () => {
    fetchMock.mockResolvedValueOnce(json({ ...detail, revision: '13', applied: [] }));
    const changes = [{ kind: 'head' as const, departmentId: DEPT_A, userId: USER_B }];
    const out = await saveDepartmentPeople(session, DEPT_A, {
      changes,
      expectedRevision: '12',
      note: '  ',
      acknowledged: true,
    });
    expect(out.revision).toBe('13');
    const call = lastCall();
    expect(call.url.pathname).toBe(`/v1/admin/departments/${DEPT_A}/people`);
    expect(call.body).toEqual({ changes, expectedRevision: '12', acknowledged: true });
  });
});

describe('mapDepartmentWriteError', () => {
  it('maps both stale answers to stale', () => {
    const version = new ApiError(409, 'x', errorBody('conflict', 'changed'));
    expect(mapDepartmentWriteError(version)).toEqual({
      kind: 'stale',
      message: DEPARTMENT_STALE_MESSAGE,
    });
    const access = new ApiError(409, 'x', errorBody('stale_access', 'changed'));
    expect(mapDepartmentWriteError(access)).toEqual({
      kind: 'stale',
      message: DEPARTMENT_ACCESS_STALE_MESSAGE,
    });
  });

  it('keeps string field messages from details and drops numbers', () => {
    const message = 'A department named "Sales" already exists.';
    const duplicate = new ApiError(
      422,
      'x',
      errorBody('unprocessable', message, { details: { name: message } }),
    );
    expect(mapDepartmentWriteError(duplicate)).toEqual({
      kind: 'invalid',
      message,
      fieldErrors: { name: message },
    });
    const retire = new ApiError(
      422,
      'x',
      errorBody('unprocessable', 'Cannot retire Sales.', {
        details: { moveMembersTo: 'Required while active members remain.', activeMembers: 9 },
      }),
    );
    expect(mapDepartmentWriteError(retire)).toEqual({
      kind: 'invalid',
      message: 'Cannot retire Sales.',
      fieldErrors: { moveMembersTo: 'Required while active members remain.' },
    });
  });

  it('names a missing department and a refused write plainly', () => {
    expect(mapDepartmentWriteError(new ApiError(404, 'x')).kind).toBe('notFound');
    expect(mapDepartmentWriteError(new ApiError(403, 'x'))).toEqual({
      kind: 'error',
      message: DEPARTMENT_FORBIDDEN_MESSAGE,
    });
    expect(mapDepartmentWriteError(new Error('boom')).kind).toBe('error');
  });
});
