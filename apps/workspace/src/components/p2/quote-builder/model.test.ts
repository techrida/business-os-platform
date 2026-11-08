import { UpdateQuotationDraftBodySchema } from '@bos/contracts';
import { describe, expect, it } from 'vitest';

import {
  defaultDates,
  discountAboveThreshold,
  emptyValues,
  newLine,
  scheduleState,
  submitBlocker,
  toContent,
  valuesFromVersion,
  type BuilderValues,
  type VersionLike,
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

  it('in update mode sends null for every blank optional field, so the save clears it', () => {
    const c = toContent(filled(), 'update');
    expect(c).toMatchObject({
      contactId: null,
      scope: null,
      assumptions: null,
      exclusions: null,
      deliveryTimeline: null,
      paymentTermId: null,
      discount: null,
      paymentSchedule: null,
    });
    expect(UpdateQuotationDraftBodySchema.safeParse({ ...c, expectedVersion: 2 }).success).toBe(
      true,
    );
  });

  it('in update mode still sends what was typed', () => {
    const v = filled();
    v.scope = '  Phase 1  ';
    v.discountMode = 'amount';
    v.discountValue = '500';
    const c = toContent(v, 'update');
    expect(c.scope).toBe('Phase 1');
    expect(c.discount).toEqual({ mode: 'amount', value: '500' });
  });

  it('in create mode never sends null (create refuses it)', () => {
    expect(Object.values(toContent(filled()))).not.toContain(null);
  });
});

describe('hidden line fields (unitCost, catalogItemId)', () => {
  const CAT = '66666666-6666-4666-8666-666666666666';
  const version = (): VersionLike => ({
    contactId: null,
    currency: 'NPR',
    issueDate: '2026-11-08',
    validUntil: '2026-12-08',
    paymentTermId: null,
    scope: null,
    assumptions: null,
    exclusions: null,
    deliveryTimeline: null,
    discount: null,
    lines: [
      {
        description: 'HRMS implementation',
        uom: 'lot',
        quantity: '1',
        unitPrice: '180000.00',
        taxCodeId: TAX,
        unitCost: '120000.00',
        catalogItemId: CAT,
      },
      {
        description: 'Training',
        uom: 'day',
        quantity: '2',
        unitPrice: '5000.00',
        taxCodeId: TAX,
        unitCost: null,
        catalogItemId: null,
      },
    ],
    paymentSchedule: [],
  });

  it('survive valuesFromVersion then toContent, per line, in update mode', () => {
    const c = toContent(valuesFromVersion(version()), 'update');
    expect(c.lines[0]).toMatchObject({ unitCost: '120000.00', catalogItemId: CAT });
    // A line that had none sends none (the API reads a missing key as null).
    expect(c.lines[1]).not.toHaveProperty('unitCost');
    expect(c.lines[1]).not.toHaveProperty('catalogItemId');
    expect(UpdateQuotationDraftBodySchema.safeParse({ ...c, expectedVersion: 2 }).success).toBe(
      true,
    );
  });

  it('survive in create mode too', () => {
    const c = toContent(valuesFromVersion(version()));
    expect(c.lines[0]).toMatchObject({ unitCost: '120000.00', catalogItemId: CAT });
    expect(c.lines[1]).not.toHaveProperty('unitCost');
  });

  it('stay with a line when its visible fields are edited', () => {
    const v = valuesFromVersion(version());
    const edited = v.lines.map((l, i) => (i === 0 ? { ...l, unitPrice: '1,90,000.00' } : l));
    const c = toContent({ ...v, lines: edited }, 'update');
    expect(c.lines[0]).toMatchObject({
      unitPrice: '190000.00',
      unitCost: '120000.00',
      catalogItemId: CAT,
    });
  });

  it('are null on a newly added line, which sends neither', () => {
    expect(newLine('l9')).toMatchObject({ unitCost: null, catalogItemId: null });
    const v = filled();
    v.lines = [...v.lines, newLine('l2')];
    const c = toContent(v, 'update');
    expect(c.lines[1]).not.toHaveProperty('unitCost');
    expect(c.lines[1]).not.toHaveProperty('catalogItemId');
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
