// Unit tests of the lead stage planner: every edge of LEAD_TRANSITIONS against a user and a manager, so a change
// to the transition table, or to who may use an edge, shows up here.
import { LEAD_STAGES, LEAD_TRANSITIONS, type LeadStage } from '@bos/contracts';
import { describe, expect, it } from 'vitest';

import { planLeadStageChange, type LeadStageCaller } from './lead-stage';

const plan = (
  from: LeadStage,
  to: LeadStage,
  by: LeadStageCaller,
  extra: { reason?: string; note?: string; expectedVersion?: number; version?: number } = {},
) =>
  planLeadStageChange({
    current: from,
    currentVersion: extra.version ?? 3,
    to,
    by,
    reason: extra.reason,
    note: extra.note,
    expectedVersion: extra.expectedVersion,
  });

describe('planLeadStageChange', () => {
  it('lets a user take every user edge except the one into converted', () => {
    for (const t of LEAD_TRANSITIONS.filter((e) => e.by === 'user' && e.to !== 'converted')) {
      const result = plan(t.from, t.to, 'user', { reason: 'r', note: 'n' });
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
        set: { stage: to, stageReason: 'r', stageNote: 'n' },
      });
    }
  });

  it('clears the reason and note when a lead leaves lost or on_hold', () => {
    expect(plan('on_hold', 'contacted', 'user')).toEqual({
      ok: true,
      set: { stage: 'contacted', stageReason: null, stageNote: null },
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
