import { describe, expect, it } from 'vitest';

import {
  defaultDates,
  discountAboveThreshold,
  emptyValues,
  scheduleState,
  submitBlocker,
  toContent,
  type BuilderValues,
} from './model';

const TAX = '33333333-3333-4333-8333-333333333333';

function filled(): BuilderValues {
  const v = emptyValues({ currency: 'NPR', issueDate: '2026-11-08', validUntil: '2026-12-08' });
  v.lines = [
    {
      key: 'l1',
      description: 'HRMS implementation',
      uom: 'lot',
      quantity: '1',
      unitPrice: '1,80,000.00',
      taxCodeId: TAX,
    },
  ];
  return v;
}

const m = (key: string, percent: string) => ({ key, label: key, percent, dueDescription: '' });

describe('scheduleState', () => {
  it('is empty with no milestones (the payment term applies)', () => {
    expect(scheduleState([])).toEqual({ kind: 'empty' });
  });
  it('is ok at exactly 100, using integer hundredths (33.33 + 33.33 + 33.34)', () => {
    expect(scheduleState([m('a', '33.33'), m('b', '33.33'), m('c', '33.34')])).toEqual({
      kind: 'ok',
    });
  });
  it('reports what is missing when short, and what is over when above', () => {
    expect(scheduleState([m('a', '60'), m('b', '30')])).toEqual({ kind: 'short', by: '10.00' });
    expect(scheduleState([m('a', '60'), m('b', '50')])).toEqual({ kind: 'over', by: '10.00' });
  });
  it('is invalid when a percent is not a number', () => {
    expect(scheduleState([m('a', '60'), m('b', 'abc')])).toEqual({ kind: 'invalid' });
  });
});

describe('submitBlocker', () => {
  it('blocks a schedule that does not total 100%', () => {
    const v = filled();
    v.schedule = [m('advance', '60'), m('delivery', '30')];
    expect(submitBlocker(v, { dirty: false })).toMatch(/100%/);
  });
  it('blocks while there are unsaved changes', () => {
    expect(submitBlocker(filled(), { dirty: true })).toMatch(/Save the draft/);
  });
  it('lets a clean, complete draft through', () => {
    const v = filled();
    v.schedule = [m('advance', '60'), m('delivery', '40')];
    expect(submitBlocker(v, { dirty: false })).toBeNull();
  });
});

describe('toContent', () => {
  it('drops thousands separators and empty optional fields, and sends the discount as typed', () => {
    const v = filled();
    v.discountMode = 'pct';
    v.discountValue = '12.5';
    const c = toContent(v);
    expect(c.lines[0]?.unitPrice).toBe('180000.00');
    expect(c.discount).toEqual({ mode: 'pct', value: '12.5' });
    expect(c).not.toHaveProperty('scope');
    expect(c).not.toHaveProperty('paymentSchedule');
  });
  it('omits the discount when mode is none', () => {
    expect(toContent(filled())).not.toHaveProperty('discount');
  });
});

describe('discountAboveThreshold', () => {
  it('is true only above 12, comparing the 4-decimal string exactly', () => {
    expect(discountAboveThreshold('12.0000')).toBe(false);
    expect(discountAboveThreshold('12')).toBe(false);
    expect(discountAboveThreshold('12.0001')).toBe(true);
    expect(discountAboveThreshold('8.0000')).toBe(false);
    expect(discountAboveThreshold('100.0000')).toBe(true);
  });
});

describe('defaultDates', () => {
  it('uses the Kathmandu calendar day and a 30-day validity', () => {
    // 20:00 UTC on 30 Nov is already 1 Dec in Kathmandu (UTC+5:45).
    expect(defaultDates(new Date('2026-11-30T20:00:00Z'))).toEqual({
      issueDate: '2026-12-01',
      validUntil: '2026-12-31',
    });
  });
});
