import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ACCESS_PREVIEW_ERROR_MESSAGE,
  ACCESS_SAVE_ERROR_MESSAGE,
  ACCESS_STALE_ERROR_MESSAGE,
  checkPersonAccess,
  getAccessCatalogue,
  listAccessPeople,
  listActiveDepartmentsForAccess,
  mapAccessPreviewError,
  mapAccessSaveError,
  previewAccessChanges,
  saveAccessChanges,
} from './api-access';
import { ApiError } from './api';
import { __resetEnvForTests } from './env';
import type { Session } from './session';

vi.mock('server-only', () => ({}));

const TOKEN = 'eyJ.secret-access-token.sig';
const USER_A = '00000000-0000-4000-8000-0000000000a1';
const USER_B = '00000000-0000-4000-8000-0000000000b2';
const DEPT_A = '00000000-0000-4000-8000-0000000000d1';
const ORG_ID = '00000000-0000-4000-8000-000000000002';

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

const sampleCatalogue = {
  revision: 'rev-1',
  lastChanged: { at: '2026-11-19T10:00:00.000Z', byName: 'Asha Rai' },
  roles: [
    {
      key: 'founder',
      label: 'Founder',
      description: 'Full access across the company.',
      kind: 'founder',
      locked: true,
      peopleCount: 1,
    },
    {
      key: 'sales',
      label: 'Sales',
      description: 'Works leads, opportunities and quotations.',
      kind: 'staff',
      locked: false,
      peopleCount: 4,
    },
  ],
  areas: [
    {
      key: 'leads',
      label: 'Leads',
      seePermission: 'crm.lead.read',
      actionPermissions: ['crm.lead.write'],
      hasAssignment: true,
      supportsDepartment: true,
    },
  ],
  groups: [
    {
      key: 'leads',
      label: 'Leads',
      permissions: ['crm.lead.read', 'crm.lead.write'],
    },
  ],
  permissions: [
    {
      key: 'crm.lead.read',
      label: 'See leads',
      kind: 'record',
      separationOfDuties: false,
      scopesFor: { staff: ['own', 'department', 'all'], portal: [] },
    },
    {
      key: 'crm.lead.write',
      label: 'Create and edit leads',
      kind: 'record',
      separationOfDuties: false,
      scopesFor: { staff: ['own', 'department', 'all'], portal: [] },
    },
  ],
  grants: [
    {
      role: 'sales',
      permission: 'crm.lead.read',
      scope: 'own',
      defaultScope: 'own',
      isDefault: true,
    },
  ],
  levelRules: [
    {
      area: 'leads',
      managersSeeDepartment: true,
      headsSeeDepartment: true,
      defaults: { managersSeeDepartment: true, headsSeeDepartment: true },
    },
  ],
  assignment: [
    {
      area: 'leads',
      staff: 'self_and_peers',
      managers: 'any_at_or_below',
      handOvers: [],
      defaults: { staff: 'self_and_peers', managers: 'any_at_or_below', handOvers: [] },
    },
  ],
  conflicts: [],
  summaries: { leads: ['Sales see their own leads.'] },
  assignmentSummaries: { leads: 'Staff assign within their team.' },
};

const samplePreview = {
  applied: [
    {
      label: 'Sales · See leads',
      from: 'Their own',
      to: 'Their department',
    },
  ],
  impact: {
    widened: { people: 4, sample: ['Asha Rai', 'Bikash KC'], names: ['Asha Rai', 'Bikash KC'] },
    narrowed: { people: 0, sample: [] },
    unchanged: 6,
  },
  warnings: [
    {
      code: 'W2',
      severity: 'confirm',
      message: 'This widens access for 4 people.',
      people: 4,
    },
  ],
  summaries: { leads: ['Sales see their department leads.'] },
  assignmentSummaries: { leads: 'Staff assign within their team.' },
  report: null,
};

const sampleReport = {
  person: {
    id: USER_B,
    name: 'Bikash KC',
    email: 'bikash@example.com',
    status: 'active',
    roles: [{ key: 'sales', label: 'Sales' }],
    department: { id: DEPT_A, name: 'Sales' },
    level: 'staff',
  },
  areas: [
    {
      area: 'leads',
      label: 'Leads',
      scope: 'own',
      scopeLabel: 'Their own',
      visibleCount: 5,
      totalCount: 12,
      actions: [{ permission: 'crm.lead.write', label: 'Create and edit leads', scope: 'own' }],
      assignableCount: 3,
      assignablePeople: [
        { userId: USER_B, name: 'Bikash KC', departmentName: 'Sales', level: 'staff' },
      ],
      why: ['Sales role (Their own)'],
    },
  ],
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

describe('api-access endpoints', () => {
  it('loads and validates the access catalogue', async () => {
    fetchMock.mockResolvedValueOnce(json(sampleCatalogue));
    const result = await getAccessCatalogue(session);
    expect(result.revision).toBe('rev-1');
    expect(result.roles).toHaveLength(2);
    const call = lastCall();
    expect(call.method).toBe('GET');
    expect(call.url.pathname).toBe('/v1/admin/access');
    expect(call.headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
  });

  it('throws 502 when the catalogue shape does not match the contract', async () => {
    fetchMock.mockResolvedValueOnce(json({ revision: '' }));
    const err = await getAccessCatalogue(session).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(502);
  });

  it('posts preview changes with optional person id', async () => {
    fetchMock.mockResolvedValueOnce(json(samplePreview));
    const out = await previewAccessChanges(session, {
      changes: [{ kind: 'grant', role: 'sales', permission: 'crm.lead.read', scope: 'department' }],
      person: USER_B,
    });
    expect(out.impact.widened.people).toBe(4);
    const call = lastCall();
    expect(call.method).toBe('POST');
    expect(call.url.pathname).toBe('/v1/admin/access/preview');
    expect(call.body).toEqual({
      changes: [{ kind: 'grant', role: 'sales', permission: 'crm.lead.read', scope: 'department' }],
      person: USER_B,
    });
  });

  it('posts save changes with revision, acknowledged codes, and note', async () => {
    fetchMock.mockResolvedValueOnce(json({ ...sampleCatalogue, revision: 'rev-2' }));
    const out = await saveAccessChanges(session, {
      changes: [{ kind: 'grant', role: 'sales', permission: 'crm.lead.read', scope: 'department' }],
      expectedRevision: 'rev-1',
      acknowledged: ['W2'],
      note: 'Sales team covers each other on leave',
    });
    expect(out.revision).toBe('rev-2');
    const call = lastCall();
    expect(call.method).toBe('POST');
    expect(call.url.pathname).toBe('/v1/admin/access');
    expect(call.body).toEqual({
      changes: [{ kind: 'grant', role: 'sales', permission: 'crm.lead.read', scope: 'department' }],
      expectedRevision: 'rev-1',
      acknowledged: ['W2'],
      note: 'Sales team covers each other on leave',
    });
  });

  it('loads Check a person with encoded query parameter', async () => {
    fetchMock.mockResolvedValueOnce(json(sampleReport));
    const report = await checkPersonAccess(session, USER_B);
    expect(report.person.name).toBe('Bikash KC');
    expect(report.areas[0]?.visibleCount).toBe(5);
    const call = lastCall();
    expect(call.url.pathname).toBe('/v1/admin/access/check');
    expect(call.url.searchParams.get('person')).toBe(USER_B);
  });

  it('lists active departments for hand-over pickers', async () => {
    fetchMock.mockResolvedValueOnce(
      json({
        items: [
          {
            id: DEPT_A,
            name: 'Sales',
            status: 'active',
            retiredAt: null,
            head: null,
            managers: 1,
            members: 4,
            version: 1,
          },
        ],
        unassigned: 0,
      }),
    );
    const depts = await listActiveDepartmentsForAccess(session);
    expect(depts.items[0]?.name).toBe('Sales');
    expect(lastCall().url.pathname).toBe('/v1/admin/departments');
    expect(lastCall().url.searchParams.get('status')).toBe('active');
  });

  it('lists people sorted by name and falls back to empty list on 403', async () => {
    fetchMock.mockResolvedValueOnce(
      json({
        items: [
          {
            id: USER_B,
            idpOrgId: ORG_ID,
            email: 'z@example.com',
            displayName: 'Zara Thapa',
            status: 'active',
            roles: ['sales'],
            department: { id: DEPT_A, name: 'Sales' },
            createdAt: '2026-11-01T00:00:00.000Z',
            lastActiveAt: null,
          },
          {
            id: USER_A,
            idpOrgId: ORG_ID,
            email: 'a@example.com',
            displayName: 'Asha Rai',
            status: 'active',
            roles: ['founder'],
            department: null,
            createdAt: '2026-11-01T00:00:00.000Z',
            lastActiveAt: null,
          },
        ],
        nextAfter: null,
        nextPage: null,
      }),
    );
    const people = await listAccessPeople(session);
    expect(people.map((p) => p.name)).toEqual(['Asha Rai', 'Zara Thapa']);

    fetchMock.mockResolvedValueOnce(
      json({ error: { code: 'forbidden', message: 'Forbidden' } }, 403),
    );
    expect(await listAccessPeople(session)).toEqual([]);
  });
});

describe('mapAccessSaveError and mapAccessPreviewError', () => {
  it('maps 409 stale_access envelope to stale failure', () => {
    const err = new ApiError(409, 'conflict', {
      error: { code: 'stale_access', message: 'Stale revision', correlationId: 'c1' },
    });
    expect(mapAccessSaveError(err)).toEqual({
      kind: 'stale',
      message: ACCESS_STALE_ERROR_MESSAGE,
    });
  });

  it('maps 409 confirmation_required with warnings', () => {
    const warning = {
      code: 'W2' as const,
      severity: 'confirm' as const,
      message: 'Widens access for 3 people.',
      people: 3,
    };
    const err = new ApiError(409, 'confirmation', {
      error: {
        code: 'confirmation_required',
        message: 'Confirm warnings first.',
        warnings: [warning],
      },
    });
    expect(mapAccessSaveError(err)).toEqual({
      kind: 'confirmation',
      message: 'Confirm warnings first.',
      warnings: [warning],
    });
  });

  it('maps 422 unprocessable with fieldErrors and blocked warnings', () => {
    const warning = {
      code: 'W1' as const,
      severity: 'blocked' as const,
      message: 'Founder permissions cannot be changed.',
    };
    const err = new ApiError(422, 'unprocessable', {
      code: 'unprocessable',
      message: 'Cannot save these changes.',
      fieldErrors: { 'changes.0': 'Invalid reach' },
      warnings: [warning],
    });
    expect(mapAccessSaveError(err)).toEqual({
      kind: 'invalid',
      message: 'Cannot save these changes.',
      fieldErrors: { 'changes.0': 'Invalid reach' },
      warnings: [warning],
    });
  });

  it('maps 403 and unexpected errors safely', () => {
    expect(mapAccessSaveError(new ApiError(403, 'forbidden'))).toEqual({
      kind: 'error',
      message: 'You do not have permission to change access settings.',
    });
    expect(mapAccessSaveError(new Error('ECONNREFUSED'))).toEqual({
      kind: 'error',
      message: ACCESS_SAVE_ERROR_MESSAGE,
    });
    expect(mapAccessPreviewError(new ApiError(403, 'forbidden'))).toBe(
      'You do not have permission to preview access changes.',
    );
    expect(mapAccessPreviewError(new Error('network'))).toBe(ACCESS_PREVIEW_ERROR_MESSAGE);
  });
});
