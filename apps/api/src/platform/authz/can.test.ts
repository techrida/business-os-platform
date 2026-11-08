// Table tests for `can()`: every scope with a matching and a non-matching record, the deny reasons,
// and the latency budget (P1 plan §7 U1: 100k calls, p99 < 0.05 ms).
import { performance } from 'node:perf_hooks';

import type { OrgKind, Permission, Scope } from '@bos/contracts';
import { describe, expect, it } from 'vitest';

import { can } from './can';
import type { Decision, Principal, ResourceRef } from './principal';

const TENANT = '00000000-0000-4000-8000-000000000001';
const OTHER_TENANT = '00000000-0000-4000-8000-000000000002';
const STAFF_ORG = '10000000-0000-4000-8000-000000000001';
const CUSTOMER_ORG = '20000000-0000-4000-8000-000000000001';
const OTHER_CUSTOMER_ORG = '20000000-0000-4000-8000-000000000002';
const VENDOR_ORG = '30000000-0000-4000-8000-000000000001';
const ME = 'a0000000-0000-4000-8000-000000000001';
const SOMEONE_ELSE = 'a0000000-0000-4000-8000-000000000002';
const MY_DEPT = 'd0000000-0000-4000-8000-000000000001';
const OTHER_DEPT = 'd0000000-0000-4000-8000-000000000002';

const ORG_OF: Record<OrgKind, string> = {
  staff: STAFF_ORG,
  customer: CUSTOMER_ORG,
  vendor: VENDOR_ORG,
};

function principalWith(
  grants: Partial<Record<Permission, Scope>>,
  over: Partial<Principal> = {},
): Principal {
  const orgKind = over.orgKind ?? 'staff';
  return {
    userId: ME,
    zitadelUserId: 'zitadel-sub-1',
    tenantId: TENANT,
    organizationId: ORG_OF[orgKind],
    orgKind,
    roles: [],
    departmentId: MY_DEPT,
    status: 'active',
    grants: new Map(Object.entries(grants) as [Permission, Scope][]),
    ...over,
  };
}

/** A staff-owned record in our tenant; each case overrides what it tests. */
const rec = (over: Partial<ResourceRef> = {}): ResourceRef => ({
  tenantId: TENANT,
  organizationId: STAFF_ORG,
  ...over,
});

const ALLOWED = (scope: Scope): Decision => ({ allowed: true, scope });
const DENIED = (reason: Extract<Decision, { allowed: false }>['reason']): Decision => ({
  allowed: false,
  reason,
});

interface Case {
  name: string;
  scope: Scope;
  orgKind?: OrgKind;
  departmentId?: string | null;
  r: ResourceRef;
  want: Decision;
}

const scopeCases: Case[] = [
  // own
  { name: 'own: I own it', scope: 'own', r: rec({ ownerUserId: ME }), want: ALLOWED('own') },
  {
    name: 'own: someone else owns it',
    scope: 'own',
    r: rec({ ownerUserId: SOMEONE_ELSE }),
    want: DENIED('out_of_scope'),
  },
  {
    name: 'own: owner is null',
    scope: 'own',
    r: rec({ ownerUserId: null }),
    want: DENIED('out_of_scope'),
  },
  { name: 'own: no owner field', scope: 'own', r: rec(), want: DENIED('out_of_scope') },
  {
    name: 'own: another tenant, even though I own it',
    scope: 'own',
    r: rec({ tenantId: OTHER_TENANT, ownerUserId: ME }),
    want: DENIED('out_of_scope'),
  },

  {
    name: 'own: I own it, but it belongs to another org',
    scope: 'own',
    r: rec({ organizationId: CUSTOMER_ORG, ownerUserId: ME }),
    want: DENIED('out_of_scope'),
  },

  // department
  {
    name: 'department: same department',
    scope: 'department',
    r: rec({ departmentId: MY_DEPT }),
    want: ALLOWED('department'),
  },
  {
    name: 'department: other department',
    scope: 'department',
    r: rec({ departmentId: OTHER_DEPT }),
    want: DENIED('out_of_scope'),
  },
  {
    name: 'department: I have none and the row has none',
    scope: 'department',
    departmentId: null,
    r: rec({ departmentId: null }),
    want: DENIED('out_of_scope'),
  },
  {
    name: 'department: I have none, the row has one',
    scope: 'department',
    departmentId: null,
    r: rec({ departmentId: MY_DEPT }),
    want: DENIED('out_of_scope'),
  },
  {
    name: 'department: row has no department field',
    scope: 'department',
    r: rec(),
    want: DENIED('out_of_scope'),
  },
  {
    name: 'department: another tenant',
    scope: 'department',
    r: rec({ tenantId: OTHER_TENANT, departmentId: MY_DEPT }),
    want: DENIED('out_of_scope'),
  },

  {
    name: 'department: same department id, but another org',
    scope: 'department',
    r: rec({ organizationId: CUSTOMER_ORG, departmentId: MY_DEPT }),
    want: DENIED('out_of_scope'),
  },

  // customer_org
  {
    name: 'customer_org: customer named in the customer column',
    scope: 'customer_org',
    orgKind: 'customer',
    r: rec({ customerOrganizationId: CUSTOMER_ORG }),
    want: ALLOWED('customer_org'),
  },
  {
    name: 'customer_org: another customer named',
    scope: 'customer_org',
    orgKind: 'customer',
    r: rec({ customerOrganizationId: OTHER_CUSTOMER_ORG }),
    want: DENIED('out_of_scope'),
  },
  {
    name: 'customer_org: customer id only in the vendor column',
    scope: 'customer_org',
    orgKind: 'customer',
    r: rec({ vendorOrganizationId: CUSTOMER_ORG }),
    want: DENIED('out_of_scope'),
  },
  {
    name: 'customer_org: customer is the owning org but not the counterparty',
    scope: 'customer_org',
    orgKind: 'customer',
    r: rec({ organizationId: CUSTOMER_ORG }),
    want: DENIED('out_of_scope'),
  },
  {
    name: 'customer_org: vendor named in the vendor column',
    scope: 'customer_org',
    orgKind: 'vendor',
    r: rec({ vendorOrganizationId: VENDOR_ORG }),
    want: ALLOWED('customer_org'),
  },
  {
    name: 'customer_org: vendor id only in the customer column',
    scope: 'customer_org',
    orgKind: 'vendor',
    r: rec({ customerOrganizationId: VENDOR_ORG }),
    want: DENIED('out_of_scope'),
  },
  {
    name: 'customer_org: staff never match the counterparty column',
    scope: 'customer_org',
    orgKind: 'staff',
    r: rec({ customerOrganizationId: STAFF_ORG, vendorOrganizationId: STAFF_ORG }),
    want: DENIED('out_of_scope'),
  },
  {
    name: 'customer_org: another tenant',
    scope: 'customer_org',
    orgKind: 'customer',
    r: rec({ tenantId: OTHER_TENANT, customerOrganizationId: CUSTOMER_ORG }),
    want: DENIED('out_of_scope'),
  },

  // all
  { name: 'all: staff, row owned by the staff org', scope: 'all', r: rec(), want: ALLOWED('all') },
  {
    name: 'all: staff, staff-owned row that names a customer',
    scope: 'all',
    r: rec({ customerOrganizationId: CUSTOMER_ORG, ownerUserId: SOMEONE_ELSE }),
    want: ALLOWED('all'),
  },
  {
    name: 'all: staff, row owned by a customer org',
    scope: 'all',
    r: rec({ organizationId: CUSTOMER_ORG }),
    want: DENIED('out_of_scope'),
  },
  {
    name: 'all: staff, another tenant',
    scope: 'all',
    r: rec({ tenantId: OTHER_TENANT }),
    want: DENIED('out_of_scope'),
  },
  {
    name: 'all: customer, row owned by its own org',
    scope: 'all',
    orgKind: 'customer',
    r: rec({ organizationId: CUSTOMER_ORG }),
    want: ALLOWED('all'),
  },
  {
    name: 'all: customer, staff-owned row that names it',
    scope: 'all',
    orgKind: 'customer',
    r: rec({ customerOrganizationId: CUSTOMER_ORG }),
    want: ALLOWED('all'),
  },
  {
    // The security-critical row: `all` for a customer must not mean "the whole tenant".
    name: 'all: customer, staff-owned row naming another customer',
    scope: 'all',
    orgKind: 'customer',
    r: rec({ customerOrganizationId: OTHER_CUSTOMER_ORG }),
    want: DENIED('out_of_scope'),
  },
  {
    name: 'all: customer, staff-owned row with no counterparty',
    scope: 'all',
    orgKind: 'customer',
    r: rec(),
    want: DENIED('out_of_scope'),
  },
  {
    name: 'all: customer named only in the vendor column',
    scope: 'all',
    orgKind: 'customer',
    r: rec({ vendorOrganizationId: CUSTOMER_ORG }),
    want: DENIED('out_of_scope'),
  },
  {
    name: 'all: vendor, staff-owned row that names it',
    scope: 'all',
    orgKind: 'vendor',
    r: rec({ vendorOrganizationId: VENDOR_ORG }),
    want: ALLOWED('all'),
  },
  {
    name: 'all: customer, another tenant',
    scope: 'all',
    orgKind: 'customer',
    r: rec({ tenantId: OTHER_TENANT, organizationId: CUSTOMER_ORG }),
    want: DENIED('out_of_scope'),
  },
];

describe('can(): scopes on a record', () => {
  it.each(scopeCases)('$name', ({ scope, orgKind, departmentId, r, want }) => {
    const p = principalWith(
      { 'memo.read': scope },
      {
        orgKind: orgKind ?? 'staff',
        ...(departmentId !== undefined ? { departmentId } : {}),
      },
    );
    expect(can(p, 'memo.read', r)).toEqual(want);
  });
});

describe('can(): grants and status', () => {
  it('denies an action the principal has no grant for', () => {
    const p = principalWith({ 'memo.read': 'all' });
    expect(can(p, 'memo.update')).toEqual(DENIED('no_permission'));
    expect(can(p, 'memo.update', rec())).toEqual(DENIED('no_permission'));
  });

  it('denies a principal with no grants at all', () => {
    expect(can(principalWith({}), 'audit.read')).toEqual(DENIED('no_permission'));
  });

  it('decides a route-level check (no record) by the grant alone', () => {
    for (const scope of ['own', 'department', 'customer_org', 'all'] as const) {
      expect(can(principalWith({ 'memo.read': scope }), 'memo.read')).toEqual(ALLOWED(scope));
    }
  });

  it.each(['inactive', 'invited'] as const)(
    'denies an %s user before looking at grants',
    (status) => {
      const p = principalWith({ 'memo.read': 'all' }, { status });
      expect(can(p, 'memo.read')).toEqual(DENIED('inactive_user'));
      expect(can(p, 'memo.read', rec())).toEqual(DENIED('inactive_user'));
      // Even with no grant, the status is the reason given.
      expect(can(p, 'audit.read')).toEqual(DENIED('inactive_user'));
    },
  );

  it('denies a status string it does not know', () => {
    const p = principalWith({ 'memo.read': 'all' }, { status: 'suspended' as Principal['status'] });
    expect(can(p, 'memo.read')).toEqual(DENIED('inactive_user'));
  });

  it.each(['toString', 'constructor', 'everything', ''])(
    'treats an unknown scope value %j as no grant',
    (bad) => {
      const p = principalWith({ 'memo.read': bad as Scope });
      expect(can(p, 'memo.read')).toEqual(DENIED('no_permission'));
      expect(can(p, 'memo.read', rec())).toEqual(DENIED('no_permission'));
    },
  );

  it('does not mistake an empty tenant id for a match', () => {
    const p = principalWith({ 'memo.read': 'all' }, { tenantId: '', organizationId: STAFF_ORG });
    expect(can(p, 'memo.read', rec({ tenantId: '' }))).toEqual(DENIED('out_of_scope'));
  });
});

describe('can(): separation of duties', () => {
  const ACT: Permission = 'approvals.requests.act';

  it('refuses a user who prepared the record', () => {
    const p = principalWith({ [ACT]: 'all' });
    expect(can(p, ACT, rec({ sodUserIds: [SOMEONE_ELSE, ME] }))).toEqual(
      DENIED('separation_of_duties'),
    );
  });

  it('allows a user who did not prepare it', () => {
    const p = principalWith({ [ACT]: 'all' });
    expect(can(p, ACT, rec({ sodUserIds: [SOMEONE_ELSE] }))).toEqual(ALLOWED('all'));
    expect(can(p, ACT, rec({ sodUserIds: [] }))).toEqual(ALLOWED('all'));
    expect(can(p, ACT, rec())).toEqual(ALLOWED('all'));
  });

  it('ignores sodUserIds for permissions outside SOD_PERMISSIONS', () => {
    const p = principalWith({ 'memo.read': 'all' });
    expect(can(p, 'memo.read', rec({ sodUserIds: [ME] }))).toEqual(ALLOWED('all'));
  });

  it('reports out_of_scope before separation of duties', () => {
    const p = principalWith({ [ACT]: 'own' });
    expect(can(p, ACT, rec({ ownerUserId: SOMEONE_ELSE, sodUserIds: [ME] }))).toEqual(
      DENIED('out_of_scope'),
    );
  });

  it('does not apply on a route-level check, which has no record', () => {
    expect(can(principalWith({ [ACT]: 'all' }), ACT)).toEqual(ALLOWED('all'));
  });
});

describe('can(): latency budget', () => {
  // NFR: < 5 ms per decision including the cache hit; the pure part gets 0.05 ms at p99.
  // Timing every single call would mostly measure performance.now() itself, so each sample is
  // the mean of a batch of 1000 calls, and p99 is taken over the 100 batches.
  it('keeps p99 under 0.05 ms per call over 100k calls', () => {
    const BATCH = 1000;
    const BATCHES = 100;
    const ACT: Permission = 'approvals.requests.act';

    // Mixed inputs, so V8 sees every branch and cannot fold the call away.
    const principals = [
      principalWith({ 'memo.read': 'own', [ACT]: 'all' }),
      principalWith({ 'memo.read': 'department' }),
      principalWith({ 'memo.read': 'customer_org' }, { orgKind: 'customer' }),
      principalWith({ 'memo.read': 'all' }, { orgKind: 'vendor' }),
      principalWith({ 'memo.read': 'all' }, { status: 'inactive' }),
    ];
    const records = [
      rec({ ownerUserId: ME }),
      rec({ departmentId: OTHER_DEPT }),
      rec({ customerOrganizationId: CUSTOMER_ORG }),
      rec({ vendorOrganizationId: VENDOR_ORG, sodUserIds: [SOMEONE_ELSE, ME] }),
      rec({ tenantId: OTHER_TENANT }),
      undefined,
    ];
    const actions: Permission[] = ['memo.read', ACT, 'audit.read'];

    let allowed = 0;
    const run = (i: number): void => {
      const p = principals[i % principals.length] as Principal;
      const a = actions[i % actions.length] as Permission;
      if (can(p, a, records[i % records.length]).allowed) allowed += 1;
    };

    for (let i = 0; i < 20_000; i += 1) run(i); // warm-up: let the JIT optimise first

    const perCallMs: number[] = [];
    let n = 0;
    for (let b = 0; b < BATCHES; b += 1) {
      const start = performance.now();
      for (let i = 0; i < BATCH; i += 1) run((n += 1));
      perCallMs.push((performance.now() - start) / BATCH);
    }

    perCallMs.sort((x, y) => x - y);
    const p99 = perCallMs[Math.ceil(perCallMs.length * 0.99) - 1] as number;

    expect(allowed).toBeGreaterThan(0); // the sink: proves the calls ran and returned decisions
    expect(p99).toBeLessThan(0.05);
  });
});
