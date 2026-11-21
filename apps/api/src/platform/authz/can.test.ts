// Table tests for `can()`: every scope with a matching and a non-matching record, the deny reasons,
// the read reach of CRM records (D50, D55-3) and the latency budget (P1 plan §7 U1: 100k calls,
// p99 < 0.05 ms).
//
// ADR 0027: every principal's `organizationId` is the acting legal entity, the same value for staff
// and portal callers. A portal caller is told apart by `partyId`, and only the counterparty columns
// (`customerPartyId`, `vendorPartyId`) are compared with it.
import { performance } from 'node:perf_hooks';

import {
  type AccessScope,
  DEFAULT_ROLE_PERMISSIONS,
  type OrgKind,
  type Permission,
  type Scope,
} from '@bos/contracts';
import { describe, expect, it } from 'vitest';

import { can } from './can';
import type { Decision, Principal, ResourceRef } from './principal';

const TENANT = '00000000-0000-4000-8000-000000000001';
const OTHER_TENANT = '00000000-0000-4000-8000-000000000002';
/** The acting legal entity, for staff and portal callers alike. */
const ENTITY = '10000000-0000-4000-8000-000000000001';
const OTHER_ENTITY = '10000000-0000-4000-8000-000000000002';
const CUSTOMER_PARTY = '20000000-0000-4000-8000-000000000001';
const OTHER_CUSTOMER_PARTY = '20000000-0000-4000-8000-000000000002';
const VENDOR_PARTY = '30000000-0000-4000-8000-000000000001';
const ME = 'a0000000-0000-4000-8000-000000000001';
const SOMEONE_ELSE = 'a0000000-0000-4000-8000-000000000002';
const MY_DEPT = 'd0000000-0000-4000-8000-000000000001';
const OTHER_DEPT = 'd0000000-0000-4000-8000-000000000002';

const PARTY_OF: Record<OrgKind, string | null> = {
  staff: null,
  customer: CUSTOMER_PARTY,
  vendor: VENDOR_PARTY,
};

function principalWith(
  grants: Partial<Record<Permission, AccessScope>>,
  over: Partial<Principal> = {},
): Principal {
  const orgKind = over.orgKind ?? 'staff';
  return {
    userId: ME,
    zitadelUserId: 'zitadel-sub-1',
    tenantId: TENANT,
    organizationId: ENTITY,
    orgKind,
    partyId: PARTY_OF[orgKind],
    idpOrgId: 'e0000000-0000-4000-8000-000000000001',
    roles: [],
    departmentId: MY_DEPT,
    status: 'active',
    grants: new Map(Object.entries(grants) as [Permission, AccessScope][]),
    ...over,
  };
}

/** A record of the acting entity in our tenant; each case overrides what it tests. */
const rec = (over: Partial<ResourceRef> = {}): ResourceRef => ({
  tenantId: TENANT,
  organizationId: ENTITY,
  ...over,
});

const ALLOWED = (scope: AccessScope): Decision => ({ allowed: true, scope });
const DENIED = (reason: Extract<Decision, { allowed: false }>['reason']): Decision => ({
  allowed: false,
  reason,
});

interface Case {
  name: string;
  scope: Scope;
  orgKind?: OrgKind;
  departmentId?: string | null;
  partyId?: string | null;
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
    name: 'own: I own it, but it belongs to another entity',
    scope: 'own',
    r: rec({ organizationId: OTHER_ENTITY, ownerUserId: ME }),
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
    name: 'department: same department id, but another entity',
    scope: 'department',
    r: rec({ organizationId: OTHER_ENTITY, departmentId: MY_DEPT }),
    want: DENIED('out_of_scope'),
  },

  // customer_org: rows of the acting entity that name the caller's party (ADR 0027 §5)
  {
    name: 'customer_org: my party named in the customer column',
    scope: 'customer_org',
    orgKind: 'customer',
    r: rec({ customerPartyId: CUSTOMER_PARTY }),
    want: ALLOWED('customer_org'),
  },
  {
    name: 'customer_org: another customer party named',
    scope: 'customer_org',
    orgKind: 'customer',
    r: rec({ customerPartyId: OTHER_CUSTOMER_PARTY }),
    want: DENIED('out_of_scope'),
  },
  {
    name: 'customer_org: my party named, but in another entity',
    scope: 'customer_org',
    orgKind: 'customer',
    r: rec({ organizationId: OTHER_ENTITY, customerPartyId: CUSTOMER_PARTY }),
    want: DENIED('out_of_scope'),
  },
  {
    // The silent-break regression: the old code compared the column with `organizationId`, which
    // is now the acting entity. A party id equal to an entity id must grant nothing.
    name: 'customer_org: the customer column holds the acting entity id',
    scope: 'customer_org',
    orgKind: 'customer',
    r: rec({ customerPartyId: ENTITY }),
    want: DENIED('out_of_scope'),
  },
  {
    name: 'customer_org: my party id only in the vendor column',
    scope: 'customer_org',
    orgKind: 'customer',
    r: rec({ vendorPartyId: CUSTOMER_PARTY }),
    want: DENIED('out_of_scope'),
  },
  {
    name: 'customer_org: a customer with no party matches nothing, not even a null column',
    scope: 'customer_org',
    orgKind: 'customer',
    partyId: null,
    r: rec({ customerPartyId: null }),
    want: DENIED('out_of_scope'),
  },
  {
    name: 'customer_org: vendor party named in the vendor column',
    scope: 'customer_org',
    orgKind: 'vendor',
    r: rec({ vendorPartyId: VENDOR_PARTY }),
    want: ALLOWED('customer_org'),
  },
  {
    name: 'customer_org: vendor party id only in the customer column',
    scope: 'customer_org',
    orgKind: 'vendor',
    r: rec({ customerPartyId: VENDOR_PARTY }),
    want: DENIED('out_of_scope'),
  },
  {
    name: 'customer_org: staff never match the counterparty column',
    scope: 'customer_org',
    orgKind: 'staff',
    r: rec({ customerPartyId: ENTITY, vendorPartyId: ENTITY }),
    want: DENIED('out_of_scope'),
  },
  {
    name: 'customer_org: another tenant',
    scope: 'customer_org',
    orgKind: 'customer',
    r: rec({ tenantId: OTHER_TENANT, customerPartyId: CUSTOMER_PARTY }),
    want: DENIED('out_of_scope'),
  },

  // all
  { name: 'all: staff, row of the acting entity', scope: 'all', r: rec(), want: ALLOWED('all') },
  {
    name: 'all: staff, row of the acting entity that names a customer',
    scope: 'all',
    r: rec({ customerPartyId: CUSTOMER_PARTY, ownerUserId: SOMEONE_ELSE }),
    want: ALLOWED('all'),
  },
  {
    name: 'all: staff, row of another entity',
    scope: 'all',
    r: rec({ organizationId: OTHER_ENTITY }),
    want: DENIED('out_of_scope'),
  },
  {
    name: 'all: staff, another tenant',
    scope: 'all',
    r: rec({ tenantId: OTHER_TENANT }),
    want: DENIED('out_of_scope'),
  },
  {
    name: 'all: customer, row of the acting entity that names it',
    scope: 'all',
    orgKind: 'customer',
    r: rec({ customerPartyId: CUSTOMER_PARTY }),
    want: ALLOWED('all'),
  },
  {
    // The security-critical row: `all` for a customer must not mean "the whole entity", even
    // though its `organizationId` is the entity that owns the row.
    name: 'all: customer, row of the acting entity with no counterparty',
    scope: 'all',
    orgKind: 'customer',
    r: rec(),
    want: DENIED('out_of_scope'),
  },
  {
    name: 'all: customer, row naming another customer',
    scope: 'all',
    orgKind: 'customer',
    r: rec({ customerPartyId: OTHER_CUSTOMER_PARTY }),
    want: DENIED('out_of_scope'),
  },
  {
    name: 'all: customer, the customer column holds the acting entity id',
    scope: 'all',
    orgKind: 'customer',
    r: rec({ customerPartyId: ENTITY }),
    want: DENIED('out_of_scope'),
  },
  {
    name: 'all: customer named only in the vendor column',
    scope: 'all',
    orgKind: 'customer',
    r: rec({ vendorPartyId: CUSTOMER_PARTY }),
    want: DENIED('out_of_scope'),
  },
  {
    name: 'all: customer named, but in another entity',
    scope: 'all',
    orgKind: 'customer',
    r: rec({ organizationId: OTHER_ENTITY, customerPartyId: CUSTOMER_PARTY }),
    want: DENIED('out_of_scope'),
  },
  {
    name: 'all: vendor, row of the acting entity that names it',
    scope: 'all',
    orgKind: 'vendor',
    r: rec({ vendorPartyId: VENDOR_PARTY }),
    want: ALLOWED('all'),
  },
  {
    name: 'all: customer, another tenant',
    scope: 'all',
    orgKind: 'customer',
    r: rec({ tenantId: OTHER_TENANT, customerPartyId: CUSTOMER_PARTY }),
    want: DENIED('out_of_scope'),
  },
];

describe('can(): scopes on a record', () => {
  it.each(scopeCases)('$name', ({ scope, orgKind, departmentId, partyId, r, want }) => {
    const p = principalWith(
      { 'memo.read': scope },
      {
        orgKind: orgKind ?? 'staff',
        ...(departmentId !== undefined ? { departmentId } : {}),
        ...(partyId !== undefined ? { partyId } : {}),
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
    const p = principalWith({ 'memo.read': 'all' }, { tenantId: '', organizationId: ENTITY });
    expect(can(p, 'memo.read', rec({ tenantId: '' }))).toEqual(DENIED('out_of_scope'));
  });
});

describe('can(): cumulative scopes', () => {
  it('lets department reach my own records in another department or with none', () => {
    const p = principalWith({ 'memo.read': 'department' });
    expect(can(p, 'memo.read', rec({ ownerUserId: ME, departmentId: OTHER_DEPT }))).toEqual(
      ALLOWED('department'),
    );
    expect(can(p, 'memo.read', rec({ ownerUserId: ME }))).toEqual(ALLOWED('department'));
    expect(
      can(p, 'memo.read', rec({ ownerUserId: SOMEONE_ELSE, departmentId: OTHER_DEPT })),
    ).toEqual(DENIED('out_of_scope'));
  });

  it('makes department behave as own for a user with no department', () => {
    const p = principalWith({ 'memo.read': 'department' }, { departmentId: null });
    expect(can(p, 'memo.read', rec({ ownerUserId: ME, departmentId: null }))).toEqual(
      ALLOWED('department'),
    );
    expect(can(p, 'memo.read', rec({ ownerUserId: SOMEONE_ELSE, departmentId: null }))).toEqual(
      DENIED('out_of_scope'),
    );
  });
});

// D50 and D55-3: `own` on a CRM read also covers the leads a person entered and the records they hold a live
// follow-up on. Writes stay with the owner, and a permission outside record-reach.ts ignores both lists.
describe('can(): read reach on CRM records', () => {
  const LEAD_READ: Permission = 'crm.lead.read';
  const LEAD_WRITE: Permission = 'crm.lead.write';
  const OPPORTUNITY_READ: Permission = 'crm.opportunity.read';
  /** A record someone else owns, in another department, so only the reach can match. */
  const theirs = { ownerUserId: SOMEONE_ELSE, departmentId: OTHER_DEPT } as const;

  it.each(['own', 'department'] as const)(
    '%s on a lead read reaches a lead I entered or hold a follow-up on',
    (scope) => {
      const p = principalWith({ [LEAD_READ]: scope });
      expect(can(p, LEAD_READ, rec({ ...theirs, creatorUserId: ME }))).toEqual(ALLOWED(scope));
      expect(can(p, LEAD_READ, rec({ ...theirs, assigneeUserIds: [SOMEONE_ELSE, ME] }))).toEqual(
        ALLOWED(scope),
      );
      expect(
        can(
          p,
          LEAD_READ,
          rec({ ...theirs, creatorUserId: SOMEONE_ELSE, assigneeUserIds: [SOMEONE_ELSE] }),
        ),
      ).toEqual(DENIED('out_of_scope'));
      // The reach stays inside the acting entity, like the list query's `scoped()`.
      expect(
        can(p, LEAD_READ, rec({ ...theirs, organizationId: OTHER_ENTITY, creatorUserId: ME })),
      ).toEqual(DENIED('out_of_scope'));
    },
  );

  it.each(['own', 'department'] as const)(
    'never lets %s on a write reach a record through its creator or assignees',
    (scope) => {
      const p = principalWith({ [LEAD_WRITE]: scope });
      expect(
        can(p, LEAD_WRITE, rec({ ...theirs, creatorUserId: ME, assigneeUserIds: [ME] })),
      ).toEqual(DENIED('out_of_scope'));
      expect(can(p, LEAD_WRITE, rec({ ownerUserId: ME }))).toEqual(ALLOWED(scope));
    },
  );

  it('honours the lead creator and the assignees on opportunities too (FX-Q1)', () => {
    const p = principalWith({ [OPPORTUNITY_READ]: 'own' });
    expect(can(p, OPPORTUNITY_READ, rec({ ...theirs, creatorUserId: ME }))).toEqual(ALLOWED('own'));
    expect(can(p, OPPORTUNITY_READ, rec({ ...theirs, assigneeUserIds: [ME] }))).toEqual(
      ALLOWED('own'),
    );
  });

  it('ignores creator and assignees on a permission without read reach', () => {
    const p = principalWith({ 'memo.read': 'own' });
    expect(
      can(p, 'memo.read', rec({ ...theirs, creatorUserId: ME, assigneeUserIds: [ME] })),
    ).toEqual(DENIED('out_of_scope'));
  });

  it('lets assigned read only what I hold a follow-up on', () => {
    const p = principalWith({ [LEAD_READ]: 'assigned' });
    expect(can(p, LEAD_READ)).toEqual(ALLOWED('assigned'));
    expect(can(p, LEAD_READ, rec({ ...theirs, assigneeUserIds: [ME] }))).toEqual(
      ALLOWED('assigned'),
    );
    // Owning or entering a record is not an assignment.
    expect(can(p, LEAD_READ, rec({ ownerUserId: ME }))).toEqual(DENIED('out_of_scope'));
    expect(can(p, LEAD_READ, rec({ ...theirs, creatorUserId: ME }))).toEqual(
      DENIED('out_of_scope'),
    );
    expect(can(p, LEAD_READ, rec({ ...theirs, assigneeUserIds: [] }))).toEqual(
      DENIED('out_of_scope'),
    );
    expect(
      can(p, LEAD_READ, rec({ ...theirs, organizationId: OTHER_ENTITY, assigneeUserIds: [ME] })),
    ).toEqual(DENIED('out_of_scope'));
  });

  it('treats assigned on a write or a permission without assignments as no grant, even at route level', () => {
    const p = principalWith({ [LEAD_WRITE]: 'assigned', 'memo.read': 'assigned' });
    expect(can(p, LEAD_WRITE)).toEqual(DENIED('no_permission'));
    expect(can(p, LEAD_WRITE, rec({ ownerUserId: ME, assigneeUserIds: [ME] }))).toEqual(
      DENIED('no_permission'),
    );
    expect(can(p, 'memo.read')).toEqual(DENIED('no_permission'));
    expect(can(p, 'memo.read', rec({ assigneeUserIds: [ME] }))).toEqual(DENIED('no_permission'));
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
  });

  // R14: a caller that forgets to load who prepared the record must not skip the check.
  it('refuses a record check whose sodUserIds were not supplied (fails closed)', () => {
    const p = principalWith({ [ACT]: 'all' });
    expect(can(p, ACT, rec())).toEqual(DENIED('separation_of_duties'));
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
      rec({ customerPartyId: CUSTOMER_PARTY }),
      rec({ vendorPartyId: VENDOR_PARTY, sodUserIds: [SOMEONE_ELSE, ME] }),
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

describe('default Sales order permissions', () => {
  it('grants only read access to quotations owned in the acting entity', () => {
    const salesperson = principalWith(DEFAULT_ROLE_PERMISSIONS.sales);
    expect(can(salesperson, 'sales_order.read', rec({ ownerUserId: ME }))).toEqual(ALLOWED('own'));
    for (const resource of [
      rec({ ownerUserId: SOMEONE_ELSE }),
      rec({ ownerUserId: null }),
      rec({ ownerUserId: ME, organizationId: OTHER_ENTITY }),
      rec({ ownerUserId: ME, tenantId: OTHER_TENANT }),
    ]) {
      expect(can(salesperson, 'sales_order.read', resource)).toEqual(DENIED('out_of_scope'));
    }
    expect(can(salesperson, 'sales_order.confirm')).toEqual(DENIED('no_permission'));
    expect(can(salesperson, 'sales_order.mark_billable')).toEqual(DENIED('no_permission'));
  });
});

describe('default delivery-hold release permission (F1-Q32)', () => {
  it('lets Finance, Management and the Founder ask to release, at every order', () => {
    for (const role of ['finance', 'management', 'founder'] as const) {
      const principal = principalWith(DEFAULT_ROLE_PERMISSIONS[role]);
      expect(can(principal, 'sales_order.delivery_release'), role).toEqual(ALLOWED('all'));
    }
  });

  it('denies every other role, including the Accountant who confirms orders', () => {
    for (const role of ['accountant', 'sales', 'marketing', 'pmo', 'operations_head'] as const) {
      const principal = principalWith(DEFAULT_ROLE_PERMISSIONS[role]);
      expect(can(principal, 'sales_order.delivery_release'), role).toEqual(DENIED('no_permission'));
    }
  });
});

describe('default Accountant record acceptance (S4-Q2)', () => {
  // The record check RecordOutcomeService runs for the evidence confirmation, the outcome record and the
  // `can.confirm` flag of the evidence read: `quotation.record_acceptance` on quotationRef(), whose sodUserIds is [].
  const colleaguesQuotation: ResourceRef = {
    tenantId: TENANT,
    organizationId: ENTITY,
    ownerUserId: SOMEONE_ELSE,
    departmentId: OTHER_DEPT,
    customerPartyId: CUSTOMER_PARTY,
    sodUserIds: [],
  };

  it('lets the Accountant confirm evidence on a quotation someone else owns, in the acting entity only', () => {
    const accountant = principalWith(DEFAULT_ROLE_PERMISSIONS.accountant);
    expect(can(accountant, 'quotation.record_acceptance', colleaguesQuotation)).toEqual(
      ALLOWED('all'),
    );
    expect(
      can(accountant, 'quotation.record_acceptance', {
        ...colleaguesQuotation,
        organizationId: OTHER_ENTITY,
      }),
    ).toEqual(DENIED('out_of_scope'));
    expect(
      can(accountant, 'quotation.record_acceptance', {
        ...colleaguesQuotation,
        tenantId: OTHER_TENANT,
      }),
    ).toEqual(DENIED('out_of_scope'));
  });

  it('still keeps the Accountant from sending, revising or drafting on that quotation', () => {
    const accountant = principalWith(DEFAULT_ROLE_PERMISSIONS.accountant);
    expect(can(accountant, 'quotation.send', colleaguesQuotation)).toEqual(DENIED('no_permission'));
    expect(can(accountant, 'quotation.revise', colleaguesQuotation)).toEqual(
      DENIED('no_permission'),
    );
    // The Accountant drafts only its own quotations, so a colleague's is out of scope.
    expect(can(accountant, 'quotation.draft', colleaguesQuotation)).toEqual(DENIED('out_of_scope'));
  });

  it('is held by default only by the Founder, Sales (own) and the Accountant', () => {
    const holders = Object.entries(DEFAULT_ROLE_PERMISSIONS)
      .filter(([, grants]) => grants['quotation.record_acceptance'] !== undefined)
      .map(([role, grants]) => `${role} ${String(grants['quotation.record_acceptance'])}`)
      .sort();
    expect(holders).toEqual(['accountant all', 'founder all', 'sales own']);
  });
});
