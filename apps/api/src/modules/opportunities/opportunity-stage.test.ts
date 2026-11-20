// Unit tests of the opportunity stage planner: every edge of OPPORTUNITY_TRANSITIONS against every kind of
// caller, so a change to the transition table or to who may use an edge shows up here.
import {
  DEFAULT_ROLE_PERMISSIONS,
  OPPORTUNITY_STAGES,
  OPPORTUNITY_TRANSITIONS,
  type AccessLevel,
  type OpportunityStage,
  type Permission,
  type RoleKey,
  type Scope,
} from '@bos/contracts';
import { describe, expect, it } from 'vitest';

import type { Principal } from '../../platform/authz/can';
import {
  allowedOpportunityMoves,
  mayReopenOpportunity,
  planStageChange,
  type StageCaller,
} from './opportunity-stage';

const plan = (
  from: OpportunityStage,
  to: OpportunityStage,
  by: StageCaller,
  extra: { reason?: string; note?: string; expectedVersion?: number; version?: number } = {},
) =>
  planStageChange({
    current: from,
    currentVersion: extra.version ?? 3,
    to,
    by,
    reason: extra.reason,
    note: extra.note,
    expectedVersion: extra.expectedVersion,
  });

describe('planStageChange', () => {
  it('lets a user take every user edge', () => {
    for (const t of OPPORTUNITY_TRANSITIONS.filter((e) => e.by === 'user')) {
      const result = plan(t.from, t.to, 'user', { reason: 'r', note: 'n' });
      expect(result.ok, `${t.from} -> ${t.to}`).toBe(true);
    }
  });

  it('refuses a user every system edge, won and quotation_sent included', () => {
    for (const t of OPPORTUNITY_TRANSITIONS.filter((e) => e.by === 'system')) {
      for (const by of ['user', 'manager'] as const) {
        expect(plan(t.from, t.to, by), `${t.from} -> ${t.to} as ${by}`).toMatchObject({
          ok: false,
          kind: 'system_only',
        });
      }
    }
  });

  it('lets only a manager reopen a lost opportunity', () => {
    expect(plan('lost', 'qualified', 'user')).toMatchObject({ ok: false, kind: 'manager_only' });
    expect(plan('lost', 'qualified', 'manager')).toMatchObject({ ok: true });
  });

  it('refuses a move the table has no edge for, including a move to the same stage', () => {
    const edges = new Set(OPPORTUNITY_TRANSITIONS.map((t) => `${t.from}>${t.to}`));
    for (const from of OPPORTUNITY_STAGES) {
      for (const to of OPPORTUNITY_STAGES) {
        if (edges.has(`${from}>${to}`)) continue;
        expect(plan(from, to, 'manager'), `${from} -> ${to}`).toMatchObject({
          ok: false,
          kind: 'no_edge',
        });
      }
    }
  });

  it('needs both a reason and a note to move to lost or on_hold', () => {
    for (const to of ['lost', 'on_hold'] as const) {
      const from = to === 'lost' ? 'qualified' : 'negotiation';
      expect(plan(from, to, 'user')).toMatchObject({ ok: false, kind: 'reason_required' });
      expect(plan(from, to, 'user', { reason: 'r' })).toMatchObject({
        ok: false,
        kind: 'reason_required',
      });
      expect(plan(from, to, 'user', { note: 'n' })).toMatchObject({
        ok: false,
        kind: 'reason_required',
      });
      expect(plan(from, to, 'user', { reason: 'r', note: 'n' })).toEqual({
        ok: true,
        set: {
          stage: to,
          stageReason: 'r',
          stageNote: 'n',
          heldFromStage: to === 'on_hold' ? from : null,
        },
      });
    }
  });

  it('reports a stale version before it judges the move', () => {
    // qualified -> won is no edge at all, but the caller saw an older version, so they hear "stale" first.
    expect(plan('qualified', 'won', 'user', { expectedVersion: 2, version: 3 })).toMatchObject({
      ok: false,
      kind: 'stale',
    });
    expect(plan('qualified', 'requirement_received', 'user', { expectedVersion: 3 })).toMatchObject(
      { ok: true },
    );
  });

  it('clears the reason and note when the move leaves lost or on_hold, and for a system move', () => {
    expect(plan('on_hold', 'negotiation', 'user')).toEqual({
      ok: true,
      set: { stage: 'negotiation', stageReason: null, stageNote: null, heldFromStage: null },
    });
    expect(plan('quotation_sent', 'won', 'system')).toEqual({
      ok: true,
      set: { stage: 'won', stageReason: null, stageNote: null, heldFromStage: null },
    });
  });

  it('refuses the system a user edge', () => {
    expect(plan('qualified', 'requirement_received', 'system')).toMatchObject({
      ok: false,
      kind: 'not_system',
    });
  });
});

const TENANT = '00000000-0000-4000-8000-000000000001';
const ENTITY = '00000000-0000-4000-8000-000000000002';
const ME = '00000000-0000-4000-8000-000000000003';
const COLLEAGUE = '00000000-0000-4000-8000-000000000004';

function principalOf(
  role: RoleKey,
  over: Partial<Principal> & { level?: AccessLevel } = {},
): Principal {
  return {
    userId: ME,
    zitadelUserId: 'z-me',
    tenantId: TENANT,
    organizationId: ENTITY,
    orgKind: 'staff',
    partyId: null,
    idpOrgId: '00000000-0000-4000-8000-000000000009',
    roles: [role],
    departmentId: null,
    level: 'staff',
    status: 'active',
    grants: new Map(Object.entries(DEFAULT_ROLE_PERMISSIONS[role])) as Map<Permission, Scope>,
    ...over,
  };
}

const oppRow = (stage: OpportunityStage, ownerUserId: string | null = ME) => ({
  tenantId: TENANT,
  organizationId: ENTITY,
  ownerUserId,
  departmentId: null,
  stage,
});

describe('allowedOpportunityMoves', () => {
  it('returns the exact user moves for each stage and excludes system moves (won, quotation_sent)', () => {
    const sales = principalOf('sales');
    expect(allowedOpportunityMoves(sales, oppRow('qualified'))).toEqual([
      'requirement_received',
      'lost',
    ]);
    expect(allowedOpportunityMoves(sales, oppRow('requirement_received'))).toEqual([
      'proposal_sent',
      'lost',
    ]);
    expect(allowedOpportunityMoves(sales, oppRow('proposal_sent'))).toEqual(['lost']);
    expect(allowedOpportunityMoves(sales, oppRow('quotation_sent'))).toEqual([
      'negotiation',
      'lost',
    ]);
    expect(allowedOpportunityMoves(sales, oppRow('negotiation'))).toEqual(['lost', 'on_hold']);
    expect(allowedOpportunityMoves(sales, oppRow('on_hold'))).toEqual(['negotiation']);
    expect(allowedOpportunityMoves(sales, oppRow('won'))).toEqual([]);
    expect(allowedOpportunityMoves(sales, oppRow('lost'))).toEqual([]);
  });

  it('includes reopen on lost only for a manager, head or founder with write scope', () => {
    for (const p of [
      principalOf('sales', { level: 'manager' }),
      principalOf('sales', { level: 'head' }),
      principalOf('founder'),
    ]) {
      expect(allowedOpportunityMoves(p, oppRow('lost'))).toEqual(['qualified']);
    }
    expect(
      allowedOpportunityMoves(principalOf('sales', { level: 'staff' }), oppRow('lost')),
    ).toEqual([]);
  });

  it('returns [] for a read-only caller or a colleague outside own write scope', () => {
    expect(
      allowedOpportunityMoves(principalOf('management', { level: 'head' }), oppRow('qualified')),
    ).toEqual([]);
    expect(
      allowedOpportunityMoves(principalOf('management', { level: 'head' }), oppRow('lost')),
    ).toEqual([]);
    expect(allowedOpportunityMoves(principalOf('sales'), oppRow('qualified', COLLEAGUE))).toEqual(
      [],
    );
  });
});

// Reopening a lost opportunity needs both the code rule (Founder, manager or head) and the live
// crm.opportunity.reopen grant reaching its department. Write is held at `all` so only the reopen grant decides.
describe('mayReopenOpportunity: the crm.opportunity.reopen grant on the deal department', () => {
  const SALES_DEPT = '00000000-0000-4000-8000-0000000000a1';
  const OTHER_DEPT = '00000000-0000-4000-8000-0000000000b2';

  const withReopen = (
    reopen: Scope | undefined,
    over: Partial<Principal> & { level?: AccessLevel } = {},
  ): Principal => {
    const grants = new Map<Permission, Scope>([['crm.opportunity.write', 'all']]);
    if (reopen !== undefined) grants.set('crm.opportunity.reopen', reopen);
    return principalOf('sales', { level: 'manager', departmentId: SALES_DEPT, grants, ...over });
  };
  const lostIn = (departmentId: string | null, ownerUserId: string | null = COLLEAGUE) => ({
    tenantId: TENANT,
    organizationId: ENTITY,
    ownerUserId,
    departmentId,
    stage: 'lost' as const,
  });

  it('lets a department manager reopen a colleague deal in the same department', () => {
    const manager = withReopen('department');
    expect(mayReopenOpportunity(manager, lostIn(SALES_DEPT))).toBe(true);
    expect(allowedOpportunityMoves(manager, lostIn(SALES_DEPT))).toEqual(['qualified']);
    expect(
      mayReopenOpportunity(withReopen('department', { level: 'head' }), lostIn(SALES_DEPT)),
    ).toBe(true);
  });

  it('refuses a department manager on another department deal, though write reaches it', () => {
    const manager = withReopen('department');
    expect(mayReopenOpportunity(manager, lostIn(OTHER_DEPT))).toBe(false);
    expect(allowedOpportunityMoves(manager, lostIn(OTHER_DEPT))).toEqual([]);
    expect(
      allowedOpportunityMoves(manager, { ...lostIn(OTHER_DEPT), stage: 'negotiation' }),
    ).toEqual(['lost', 'on_hold']);
  });

  it('refuses staff even with the reopen grant at all', () => {
    const staff = withReopen('all', { level: 'staff' });
    expect(mayReopenOpportunity(staff, lostIn(SALES_DEPT))).toBe(false);
    expect(allowedOpportunityMoves(staff, lostIn(SALES_DEPT))).toEqual([]);
  });

  it('reaches every department of the entity when the Founder widens the grant to all', () => {
    const manager = withReopen('all');
    expect(mayReopenOpportunity(manager, lostIn(OTHER_DEPT))).toBe(true);
    expect(allowedOpportunityMoves(manager, lostIn(OTHER_DEPT))).toEqual(['qualified']);
    expect(mayReopenOpportunity(manager, lostIn(null, null))).toBe(true);
    expect(mayReopenOpportunity(withReopen('department'), lostIn(null, null))).toBe(false);
    expect(mayReopenOpportunity(manager, { ...lostIn(OTHER_DEPT), tenantId: COLLEAGUE })).toBe(
      false,
    );
  });

  it('refuses everyone, the Founder included, when the grant is removed', () => {
    expect(mayReopenOpportunity(withReopen(undefined), lostIn(SALES_DEPT, ME))).toBe(false);
    expect(allowedOpportunityMoves(withReopen(undefined), lostIn(SALES_DEPT, ME))).toEqual([]);
    const founder = withReopen(undefined, { roles: ['founder'], level: 'staff' });
    expect(mayReopenOpportunity(founder, lostIn(SALES_DEPT, ME))).toBe(false);
  });

  it('honours a narrowed Founder grant like any other role', () => {
    const founder = withReopen('department', { roles: ['founder'], level: 'staff' });
    expect(mayReopenOpportunity(founder, lostIn(SALES_DEPT))).toBe(true);
    expect(mayReopenOpportunity(founder, lostIn(OTHER_DEPT))).toBe(false);
  });
});
