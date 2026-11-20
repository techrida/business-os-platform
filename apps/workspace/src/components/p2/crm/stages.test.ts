import { LEAD_STAGES, OPPORTUNITY_STAGES } from '@bos/contracts';
import { describe, expect, it } from 'vitest';

import {
  boardColumns,
  boardMoves,
  groupByStage,
  isSetBySystem,
  resolvedMoves,
  resumeMove,
  stageLabel,
  userMoves,
} from './stages';

const codes = (kind: 'lead' | 'opportunity', from: string) =>
  userMoves(kind, from as never).map((m) => m.stage);

describe('userMoves', () => {
  it('offers a new lead the user edges only, and flags the ones that need a reason', () => {
    expect(userMoves('lead', 'new')).toEqual([
      { stage: 'contacted', label: 'Contacted', needsReason: false },
      { stage: 'lost', label: 'Lost', needsReason: true },
      { stage: 'on_hold', label: 'On Hold', needsReason: true },
    ]);
  });

  it('never offers converted: conversion is its own action', () => {
    for (const from of LEAD_STAGES) expect(codes('lead', from)).not.toContain('converted');
    expect(codes('lead', 'qualified')).toEqual(['lost', 'on_hold']);
  });

  it('leaves out manager reopen edges (deny by default)', () => {
    expect(codes('lead', 'lost')).toEqual([]);
    expect(codes('opportunity', 'lost')).toEqual([]);
  });

  it('resumes a held record only to the stage it was held at (F1-Q53)', () => {
    const held = (kind: 'lead' | 'opportunity', at: string | null) =>
      userMoves(kind, 'on_hold', at).map((m) => m.stage);
    expect(held('lead', 'new')).toEqual(['new']);
    expect(held('lead', 'contacted')).toEqual(['contacted']);
    expect(held('lead', 'qualified')).toEqual(['qualified']);
    expect(held('opportunity', 'negotiation')).toEqual(['negotiation']);
  });

  it('resumes a hold older than heldFromStage to the old fixed stage', () => {
    expect(codes('lead', 'on_hold')).toEqual(['contacted']);
    expect(userMoves('lead', 'on_hold', null).map((m) => m.stage)).toEqual(['contacted']);
    expect(codes('opportunity', 'on_hold')).toEqual(['negotiation']);
  });

  it('never offers won or quotation_sent to a user, from any stage', () => {
    for (const from of OPPORTUNITY_STAGES) {
      expect(codes('opportunity', from)).not.toContain('won');
      expect(codes('opportunity', from)).not.toContain('quotation_sent');
    }
    expect(codes('opportunity', 'qualified')).toEqual(['requirement_received', 'lost']);
    expect(codes('opportunity', 'quotation_sent')).toEqual(['negotiation', 'lost']);
    expect(codes('opportunity', 'negotiation')).toEqual(['lost', 'on_hold']);
  });

  it('offers nothing from a terminal stage', () => {
    expect(codes('lead', 'converted')).toEqual([]);
    expect(codes('opportunity', 'won')).toEqual([]);
  });
});

describe('resolvedMoves', () => {
  it('maps server allowedMoves into Move objects, preserving manager reopen edges', () => {
    expect(resolvedMoves('lead', 'lost', ['contacted'])).toEqual([
      { stage: 'contacted', label: 'Contacted', needsReason: false },
    ]);
    expect(resolvedMoves('opportunity', 'lost', ['qualified'])).toEqual([
      { stage: 'qualified', label: 'Qualified', needsReason: false },
    ]);
    expect(resolvedMoves('lead', 'new', ['contacted', 'on_hold', 'lost'])).toEqual([
      { stage: 'contacted', label: 'Contacted', needsReason: false },
      { stage: 'on_hold', label: 'On Hold', needsReason: true },
      { stage: 'lost', label: 'Lost', needsReason: true },
    ]);
  });

  it('filters out system-only stages even if present in allowedMoves', () => {
    expect(resolvedMoves('lead', 'qualified', ['converted', 'on_hold'])).toEqual([
      { stage: 'on_hold', label: 'On Hold', needsReason: true },
    ]);
    expect(
      resolvedMoves('opportunity', 'negotiation', ['won', 'quotation_sent', 'on_hold', 'lost']),
    ).toEqual([
      { stage: 'on_hold', label: 'On Hold', needsReason: true },
      { stage: 'lost', label: 'Lost', needsReason: true },
    ]);
  });

  it('returns an empty list when the server explicitly sends []', () => {
    expect(resolvedMoves('lead', 'new', [])).toEqual([]);
    expect(resolvedMoves('opportunity', 'qualified', [])).toEqual([]);
  });

  it('falls back to userMoves when allowedMoves is undefined', () => {
    expect(resolvedMoves('lead', 'new', undefined)).toEqual(userMoves('lead', 'new'));
    expect(resolvedMoves('opportunity', 'qualified', undefined)).toEqual(
      userMoves('opportunity', 'qualified'),
    );
    expect(resolvedMoves('lead', 'lost')).toEqual([]);
    expect(resolvedMoves('lead', 'on_hold', undefined, 'qualified').map((m) => m.stage)).toEqual([
      'qualified',
    ]);
  });

  it("takes a held lead's one resume target from allowedMoves, whatever the stage", () => {
    expect(resolvedMoves('lead', 'on_hold', ['new'])).toEqual([
      { stage: 'new', label: 'New', needsReason: false },
    ]);
  });
});

describe('resumeMove', () => {
  it('is the one move out of On Hold, and nothing for any other stage', () => {
    expect(resumeMove('on_hold', resolvedMoves('lead', 'on_hold', ['qualified']))?.label).toBe(
      'Qualified',
    );
    expect(resumeMove('on_hold', resolvedMoves('lead', 'on_hold', ['new']))?.stage).toBe('new');
    // A viewer the server gives no moves gets no Resume.
    expect(resumeMove('on_hold', resolvedMoves('lead', 'on_hold', []))).toBeNull();
    expect(resumeMove('contacted', resolvedMoves('lead', 'contacted', ['on_hold']))).toBeNull();
  });
});

describe('boardMoves', () => {
  it('excludes lost from every lead and opportunity stage while keeping the other user moves', () => {
    const stagesOf = (kind: 'lead' | 'opportunity', record: Parameters<typeof boardMoves>[1]) =>
      boardMoves(kind, record).map((m) => m.stage);
    for (const stage of LEAD_STAGES) expect(stagesOf('lead', { stage })).not.toContain('lost');
    for (const stage of OPPORTUNITY_STAGES) {
      expect(stagesOf('opportunity', { stage })).not.toContain('lost');
    }
    expect(stagesOf('lead', { stage: 'new' })).toEqual(['contacted', 'on_hold']);
    expect(stagesOf('lead', { stage: 'qualified' })).toEqual(['on_hold']);
    expect(stagesOf('opportunity', { stage: 'qualified' })).toEqual(['requirement_received']);
    expect(stagesOf('opportunity', { stage: 'negotiation' })).toEqual(['on_hold']);
  });

  it("uses the record's own allowedMoves: none for a read-only viewer, lost dropped", () => {
    expect(boardMoves('lead', { stage: 'new', allowedMoves: [] })).toEqual([]);
    expect(
      boardMoves('lead', { stage: 'new', allowedMoves: ['contacted', 'lost'] }).map((m) => m.stage),
    ).toEqual(['contacted']);
  });

  it('offers a held card only the stage it was held at (F1-Q53, FR-6 stage order)', () => {
    // From the server: one target.
    expect(
      boardMoves('lead', { stage: 'on_hold', allowedMoves: ['new'] }).map((m) => m.stage),
    ).toEqual(['new']);
    // An older payload without moves: the held stage decides, so New never jumps to Contacted.
    expect(
      boardMoves('lead', { stage: 'on_hold', heldFromStage: 'new' }).map((m) => m.stage),
    ).toEqual(['new']);
  });
});

describe('isSetBySystem', () => {
  it('marks the stages only the system can set', () => {
    expect(isSetBySystem('opportunity', 'won')).toBe(true);
    expect(isSetBySystem('opportunity', 'quotation_sent')).toBe(true);
    expect(isSetBySystem('lead', 'converted')).toBe(true);
    expect(isSetBySystem('opportunity', 'negotiation')).toBe(false);
    expect(isSetBySystem('lead', 'contacted')).toBe(false);
  });
});

describe('boardColumns and groupByStage', () => {
  it('has one column per stage in pipeline order, with Won marked system-only', () => {
    const cols = boardColumns('opportunity');
    expect(cols.map((c) => c.stage)).toEqual([...OPPORTUNITY_STAGES]);
    expect(cols.find((c) => c.stage === 'won')?.note).toBe('Set by the system');
    expect(cols.find((c) => c.stage === 'negotiation')?.note).toBeUndefined();
    expect(boardColumns('lead').find((c) => c.stage === 'converted')?.note).toBe('Set by Convert');
  });

  it('notes that Lost must be marked on the record page for leads and opportunities', () => {
    expect(boardColumns('lead').find((c) => c.stage === 'lost')?.note).toBe(
      'Mark lost on the record page',
    );
    expect(boardColumns('opportunity').find((c) => c.stage === 'lost')?.note).toBe(
      'Mark lost on the record page',
    );
  });

  it('groups records by stage and keeps every column, even when empty', () => {
    const groups = groupByStage('lead', [
      { id: 'a', stage: 'new' },
      { id: 'b', stage: 'new' },
      { id: 'c', stage: 'lost' },
    ]);
    expect(groups.get('new')?.map((r) => r.id)).toEqual(['a', 'b']);
    expect(groups.get('qualified')).toEqual([]);
    expect(groups.size).toBe(LEAD_STAGES.length);
  });

  it('labels stages from the catalogue', () => {
    expect(stageLabel('opportunity', 'requirement_received')).toBe('Requirement Received');
  });
});
