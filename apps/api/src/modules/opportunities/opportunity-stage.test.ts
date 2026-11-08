// Unit tests of the opportunity stage planner: every edge of OPPORTUNITY_TRANSITIONS against every kind of
// caller, so a change to the transition table or to who may use an edge shows up here.
import { OPPORTUNITY_STAGES, OPPORTUNITY_TRANSITIONS, type OpportunityStage } from '@bos/contracts';
import { describe, expect, it } from 'vitest';

import { planStageChange, type StageCaller } from './opportunity-stage';

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
        set: { stage: to, stageReason: 'r', stageNote: 'n' },
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
      set: { stage: 'negotiation', stageReason: null, stageNote: null },
    });
    expect(plan('quotation_sent', 'won', 'system')).toEqual({
      ok: true,
      set: { stage: 'won', stageReason: null, stageNote: null },
    });
  });

  it('refuses the system a user edge', () => {
    expect(plan('qualified', 'requirement_received', 'system')).toMatchObject({
      ok: false,
      kind: 'not_system',
    });
  });
});
