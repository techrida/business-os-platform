import {
  AuditEventDtoSchema,
  type AccessCatalogueResponse,
  type AuditEventDto,
} from '@bos/contracts';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Session } from '@/lib/session';

vi.mock('server-only', () => ({}));
vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT:${url}`);
  },
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
}));
const getSession = vi.fn<() => Promise<Session | null>>();
vi.mock('@/lib/session', () => ({ getSession: () => getSession() }));
// Live grants come from GET /v1/me; the audit list goes through apiFetch. Both are the real seams.
type LiveGrants = { permissions: { permission: string; scope: string }[] };
const kernel = vi.hoisted(() => ({
  getMe: vi.fn<(session: unknown) => Promise<LiveGrants>>(),
  apiFetch: vi.fn<(session: Session, path: string, init?: RequestInit) => Promise<Response>>(),
}));
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  ...kernel,
}));
const access = vi.hoisted(() => ({
  getAccessCatalogue: vi.fn<(session: Session) => Promise<AccessCatalogueResponse>>(),
}));
vi.mock('@/lib/api-access', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api-access')>()),
  ...access,
}));

const { default: AccessHistoryPage } = await import('./page');

const TENANT = '00000000-0000-4000-8000-0000000000e1';
const ORG = '00000000-0000-4000-8000-0000000000e2';
const ASHA = '00000000-0000-4000-8000-0000000000a1';
const FIELD_OPS = '00000000-0000-4000-8000-0000000000d7';

let token = 0;
const session = (): Session =>
  // A fresh token per test: the live-grant read is cached per token.
  ({ accessToken: `t${++token}`, orgKind: 'staff', roles: ['founder'] }) as Session;

const grants = (...permissions: string[]): LiveGrants => ({
  permissions: permissions.map((permission) => ({ permission, scope: 'all' })),
});

type EventInput = Partial<AuditEventDto> & Pick<AuditEventDto, 'action' | 'entityType' | 'seq'>;

function event(over: EventInput): AuditEventDto {
  return AuditEventDtoSchema.parse({
    id: String(over.seq),
    tenantId: TENANT,
    organizationId: ORG,
    chainMonth: '2026-11-01',
    occurredAt: '2026-11-18T09:30:00.000000+00:00',
    actorKind: 'user',
    actorId: ASHA,
    actorDisplayName: 'Asha K.',
    entityId: 'x',
    before: null,
    after: null,
    meta: null,
    canonical: { before: null, after: null, meta: null },
    ip: null,
    userAgent: null,
    correlationId: 'c0rrelation',
    prevHash: 'ab',
    hash: 'cd',
    ...over,
  });
}

// Payloads as access-settings.service.ts and departments.service.ts record them.
const GRANT = event({
  seq: 5,
  action: 'access.grant.changed',
  entityType: 'role_permission',
  entityId: 'sales:crm.lead.write',
  before: { role: 'sales', permission: 'crm.lead.write', scope: 'own', isDefault: true },
  after: { role: 'sales', permission: 'crm.lead.write', scope: 'department', isDefault: false },
});
const LEVEL_RULE = event({
  seq: 3,
  action: 'access.level_rule.changed',
  entityType: 'access_level_rule',
  entityId: 'leads',
  before: { area: 'leads', managersSeeDepartment: false, headsSeeDepartment: true },
  after: { area: 'leads', managersSeeDepartment: true, headsSeeDepartment: true },
});
const DEPARTMENT = event({
  seq: 7,
  action: 'department.created',
  entityType: 'departments',
  entityId: FIELD_OPS,
  actorDisplayName: 'Bibek R.',
  after: { name: 'Field ops', headUserId: null, status: 'active', version: 1 },
});
const ASSIGNMENT = event({
  seq: 2,
  action: 'access.assignment_rule.changed',
  entityType: 'access_assignment_rule',
  entityId: 'leads',
  before: { area: 'leads', staff: 'same_level', managers: 'at_or_below', handOvers: [] },
  after: { area: 'leads', staff: 'self', managers: 'at_or_below', handOvers: [] },
});
const HEAD = event({
  seq: 1,
  action: 'department.head.changed',
  entityType: 'department',
  entityId: FIELD_OPS,
  before: { departmentId: FIELD_OPS, departmentName: 'Field ops', headUserId: null },
  after: { departmentId: FIELD_OPS, departmentName: 'Field ops', headUserId: ASHA },
});
// A row-level audit of the departments table: same entity type, not an access change.
const ROW_AUDIT = event({
  seq: 8,
  action: 'update',
  entityType: 'departments',
  entityId: FIELD_OPS,
  after: { name: 'Hidden row' },
});

const BY_TYPE: Record<string, AuditEventDto[]> = {
  role_permission: [GRANT],
  access_level_rule: [LEVEL_RULE],
  access_assignment_rule: [ASSIGNMENT],
  department: [HEAD],
  departments: [ROW_AUDIT, DEPARTMENT],
};

const CATALOGUE = {
  roles: [{ key: 'sales', label: 'Sales' }],
  areas: [{ key: 'leads', label: 'Leads' }],
  permissions: [{ key: 'crm.lead.write', label: 'Create and edit leads', kind: 'record' }],
} as unknown as AccessCatalogueResponse;

const render = async () => renderToStaticMarkup((await AccessHistoryPage()) as ReactElement);

const auditCalls = () =>
  kernel.apiFetch.mock.calls.filter(([, path]) => path.startsWith('/v1/audit'));

beforeEach(() => {
  getSession.mockReset();
  kernel.getMe.mockReset();
  kernel.apiFetch.mockReset();
  access.getAccessCatalogue.mockReset();
  getSession.mockImplementation(() => Promise.resolve(session()));
  kernel.getMe.mockResolvedValue(grants('admin.roles.read', 'audit.read'));
  kernel.apiFetch.mockImplementation((_session, path) => {
    const type = new URL(path, 'http://api.test').searchParams.get('entityType') ?? '';
    return Promise.resolve(Response.json({ items: BY_TYPE[type] ?? [] }));
  });
  access.getAccessCatalogue.mockResolvedValue(CATALOGUE);
});

describe('Access history', () => {
  it('lists access changes newest first with time, person and a plain sentence', async () => {
    const page = await render();

    const rows = [
      'Department Field ops added.',
      'Sales: Create and edit leads changed from Their own to Their department.',
      'Leads: managers now see their department.',
      'Leads: who can assign changed.',
      'Field ops: department head changed.',
    ];
    const at = rows.map((row) => page.indexOf(row));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(page).toContain('Asha K.');
    expect(page).toContain('Bibek R.');
    expect(page).toContain('<th scope="col">What changed</th>');

    // Only access changes, and no ids or keys on screen.
    expect(page).not.toContain('Hidden row');
    for (const raw of [ASHA, FIELD_OPS, 'crm.lead.write', 'role_permission', 'sales:']) {
      expect(page).not.toContain(raw);
    }

    // One filtered read per access entity type, each with the type in the address.
    const types = auditCalls().map(([, path]) =>
      new URL(path, 'http://api.test').searchParams.get('entityType'),
    );
    expect(types.sort()).toEqual(
      [
        'access_assignment_rule',
        'access_level_rule',
        'department',
        'departments',
        'role_permission',
        'user_entity',
      ].sort(),
    );
  });

  it('shows the newest changes when one type has more than the limit', async () => {
    // 60 departments added, oldest first, the way the API stores them.
    const many = Array.from({ length: 60 }, (_, i) =>
      event({
        seq: 101 + i,
        action: 'department.created',
        entityType: 'departments',
        entityId: FIELD_OPS,
        after: { name: `Team ${i + 1}`, headUserId: null, status: 'active', version: 1 },
      }),
    );
    // Like GET /v1/audit: the oldest `limit` rows unless the read asks for order=desc.
    kernel.apiFetch.mockImplementation((_session, path) => {
      const params = new URL(path, 'http://api.test').searchParams;
      const rows = params.get('entityType') === 'departments' ? many : [];
      const limit = Number(params.get('limit') ?? '50');
      const items =
        params.get('order') === 'desc' ? rows.slice(-limit).reverse() : rows.slice(0, limit);
      return Promise.resolve(Response.json({ items }));
    });

    const page = await render();

    expect(page).toContain('Department Team 60 added.');
    expect(page).toContain('Department Team 11 added.');
    expect(page).not.toContain('Department Team 10 added.');
    expect(page.indexOf('Department Team 60 added.')).toBeLessThan(
      page.indexOf('Department Team 59 added.'),
    );
  });

  it('shows the no-access state and reads nothing without audit.read', async () => {
    kernel.getMe.mockResolvedValue(grants('admin.roles.read'));

    const page = await render();

    expect(page).toContain('permission to view the access history.');
    expect(page).not.toContain('<table');
    expect(auditCalls()).toHaveLength(0);
  });

  it('says so when there are no access changes yet', async () => {
    kernel.apiFetch.mockImplementation(() => Promise.resolve(Response.json({ items: [] })));

    const page = await render();

    expect(page).toContain('No access changes yet');
    expect(page).not.toContain('<table');
  });
});
