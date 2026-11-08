import { LEAD_STAGES, OPPORTUNITY_STAGES } from '@bos/contracts';
import { describe, expect, it } from 'vitest';

import { boardColumns, groupByStage, isSetBySystem, stageLabel, userMoves } from './stages';

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

  it('lets a held lead return to contacted', () => {
    expect(codes('lead', 'on_hold')).toEqual(['contacted']);
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
