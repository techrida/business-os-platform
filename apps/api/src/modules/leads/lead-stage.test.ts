// Unit tests of the lead stage planner: every edge of LEAD_TRANSITIONS against a user and a manager, so a change
// to the transition table, or to who may use an edge, shows up here.
import {
  DEFAULT_ROLE_PERMISSIONS,
  LEAD_STAGES,
  LEAD_TRANSITIONS,
  type AccessLevel,
  type LeadStage,
  type Permission,
  type RoleKey,
  type Scope,
} from '@bos/contracts';
import { describe, expect, it } from 'vitest';

import type { Principal } from '../../platform/authz/can';
import {
  allowedLeadMoves,
  isStageManager,
  planLeadStageChange,
  type LeadStageCaller,
} from './lead-stage';

const plan = (
  from: LeadStage,
  to: LeadStage,
  by: LeadStageCaller,
  extra: {
    reason?: string;
    note?: string;
    expectedVersion?: number;
    version?: number;
    heldFromStage?: LeadStage | null;
  } = {},
) =>
  planLeadStageChange({
    current: from,
    currentVersion: extra.version ?? 3,
    to,
    by,
    reason: extra.reason,
    note: extra.note,
    expectedVersion: extra.expectedVersion,
    heldFromStage: extra.heldFromStage,
  });

describe('planLeadStageChange', () => {
  it('lets a user take every user edge except the one into converted', () => {
    for (const t of LEAD_TRANSITIONS.filter((e) => e.by === 'user' && e.to !== 'converted')) {
      // A resume edge is taken by a lead held at its target (F1-Q53).
      const heldFromStage = t.from === 'on_hold' ? t.to : null;
      const result = plan(t.from, t.to, 'user', { reason: 'r', note: 'n', heldFromStage });
      expect(result.ok, `${t.from} -> ${t.to}`).toBe(true);
    }
  });

  it('never sets converted, whoever asks: conversion is its own action', () => {
    for (const by of ['user', 'manager'] as const) {
      expect(plan('qualified', 'converted', by)).toMatchObject({ ok: false, kind: 'use_convert' });
    }
  });

  it('lets only a manager reopen a lost lead', () => {
    expect(plan('lost', 'contacted', 'user')).toMatchObject({ ok: false, kind: 'manager_only' });
    expect(plan('lost', 'contacted', 'manager')).toMatchObject({ ok: true });
  });

  it('refuses a move the table has no edge for, including a move to the same stage', () => {
    const edges = new Set(LEAD_TRANSITIONS.map((t) => `${t.from}>${t.to}`));
    for (const from of LEAD_STAGES) {
      for (const to of LEAD_STAGES) {
        if (edges.has(`${from}>${to}`) || to === 'converted') continue;
        expect(plan(from, to, 'manager'), `${from} -> ${to}`).toMatchObject({
          ok: false,
          kind: 'no_edge',
        });
      }
    }
  });

  it('needs a reason and a note for lost and on_hold, and carries both into the row', () => {
    for (const to of ['lost', 'on_hold'] as const) {
      expect(plan('new', to, 'user')).toMatchObject({ ok: false, kind: 'reason_required' });
      expect(plan('new', to, 'user', { reason: 'r' })).toMatchObject({
        ok: false,
        kind: 'reason_required',
      });
      expect(plan('new', to, 'user', { reason: 'r', note: 'n' })).toEqual({
        ok: true,
        set: {
          stage: to,
          stageReason: 'r',
          stageNote: 'n',
          heldFromStage: to === 'on_hold' ? 'new' : null,
        },
      });
    }
  });

  it('clears the reason and note when a lead leaves lost or on_hold', () => {
    expect(plan('on_hold', 'contacted', 'user')).toEqual({
      ok: true,
      set: { stage: 'contacted', stageReason: null, stageNote: null, heldFromStage: null },
    });
  });

  it('remembers the stage a lead is held at, and resumes it there only (F1-Q53)', () => {
    for (const at of ['new', 'contacted', 'qualified'] as const) {
      expect(plan(at, 'on_hold', 'user', { reason: 'r', note: 'n' })).toMatchObject({
        ok: true,
        set: { stage: 'on_hold', heldFromStage: at },
      });
      for (const to of ['new', 'contacted', 'qualified'] as const) {
        const result = plan('on_hold', to, 'manager', { heldFromStage: at });
        if (to === at) {
          expect(result, `${at} -> ${to}`).toEqual({
            ok: true,
            set: { stage: to, stageReason: null, stageNote: null, heldFromStage: null },
          });
        } else {
          expect(result, `${at} -> ${to}`).toMatchObject({ ok: false, kind: 'no_edge' });
        }
      }
    }
    // A hold recorded before F1-Q53 resumes to contacted, as it always did.
    expect(plan('on_hold', 'contacted', 'user', { heldFromStage: null })).toMatchObject({
      ok: true,
    });
    expect(plan('on_hold', 'qualified', 'user', { heldFromStage: null })).toMatchObject({
      ok: false,
      kind: 'no_edge',
    });
  });

  it('tells a stale reader before judging the move', () => {
    expect(plan('new', 'qualified', 'user', { expectedVersion: 2 })).toMatchObject({
      ok: false,
      kind: 'stale',
    });
    expect(plan('new', 'contacted', 'user', { expectedVersion: 3 })).toMatchObject({ ok: true });
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

const leadRow = (
  stage: LeadStage,
  ownerUserId: string | null = ME,
  heldFromStage: LeadStage | null = null,
) => ({
  tenantId: TENANT,
  organizationId: ENTITY,
  ownerUserId,
  departmentId: null,
  stage,
  heldFromStage,
});

describe('isStageManager and allowedLeadMoves', () => {
  it('recognises founder, manager and head as stage managers, and staff as not', () => {
    expect(isStageManager(principalOf('founder'))).toBe(true);
    expect(isStageManager(principalOf('sales', { level: 'manager' }))).toBe(true);
    expect(isStageManager(principalOf('sales', { level: 'head' }))).toBe(true);
    expect(isStageManager(principalOf('sales', { level: 'staff' }))).toBe(false);
    const { level: _omitted, ...noLevel } = principalOf('sales');
    expect(isStageManager(noLevel)).toBe(false);
  });

  it('returns the exact outgoing user moves for each stage and never includes converted', () => {
    const sales = principalOf('sales');
    expect(allowedLeadMoves(sales, leadRow('new'))).toEqual(['contacted', 'lost', 'on_hold']);
    expect(allowedLeadMoves(sales, leadRow('contacted'))).toEqual(['qualified', 'lost', 'on_hold']);
    expect(allowedLeadMoves(sales, leadRow('qualified'))).toEqual(['lost', 'on_hold']);
    expect(allowedLeadMoves(sales, leadRow('on_hold'))).toEqual(['contacted']);
    expect(allowedLeadMoves(sales, leadRow('on_hold', ME, 'new'))).toEqual(['new']);
    expect(allowedLeadMoves(sales, leadRow('on_hold', ME, 'qualified'))).toEqual(['qualified']);
    expect(allowedLeadMoves(sales, leadRow('converted'))).toEqual([]);
    expect(allowedLeadMoves(sales, leadRow('lost'))).toEqual([]);
  });

  it('includes reopen on lost only for a manager, head or founder with write scope', () => {
    for (const p of [
      principalOf('sales', { level: 'manager' }),
      principalOf('sales', { level: 'head' }),
      principalOf('founder'),
    ]) {
      expect(allowedLeadMoves(p, leadRow('lost'))).toEqual(['contacted']);
    }
    expect(allowedLeadMoves(principalOf('sales', { level: 'staff' }), leadRow('lost'))).toEqual([]);
  });

  it('returns [] for a read-only caller or a colleague outside own write scope', () => {
    expect(allowedLeadMoves(principalOf('management', { level: 'head' }), leadRow('new'))).toEqual(
      [],
    );
    expect(allowedLeadMoves(principalOf('management', { level: 'head' }), leadRow('lost'))).toEqual(
      [],
    );
    expect(allowedLeadMoves(principalOf('sales'), leadRow('new', COLLEAGUE))).toEqual([]);
  });
});
