import { CreateQuotationBodySchema, UpdateQuotationDraftBodySchema } from '@bos/contracts';
import { describe, expect, it } from 'vitest';

import {
  defaultDates,
  discountAboveThreshold,
  emptyValues,
  milestoneAmount,
  milestoneAmounts,
  milestoneDue,
  newLine,
  reconcileMilestone,
  scheduleProgress,
  scheduleState,
  setMilestoneDueDate,
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
  it('is ok at exactly 100, using integer ten-thousandths', () => {
    const rows = [m('a', '33.3333'), m('b', '33.3333'), m('c', '33.3334')];
    expect(scheduleState(rows)).toEqual({ kind: 'ok' });
    expect(scheduleProgress(rows)).toBe('100');
    expect(scheduleState(rows.slice(0, 2))).toEqual({ kind: 'short', by: '33.3334' });
  });
  it('reports what is missing when short, and what is over when above', () => {
    expect(scheduleState([m('a', '60'), m('b', '30')])).toEqual({ kind: 'short', by: '10' });
    expect(scheduleState([m('a', '60'), m('b', '50')])).toEqual({ kind: 'over', by: '10' });
  });
  it('is invalid when a percent is not a number', () => {
    expect(scheduleState([m('a', '60'), m('b', 'abc')])).toEqual({ kind: 'invalid' });
  });
  it.each(['-0.01', '100.01', '33.33335', '000', '1e2'])(
    'rejects %s at the row boundary before checking the sum',
    (percent) => {
      expect(scheduleState([m('a', percent)])).toEqual({ kind: 'invalid' });
      expect(reconcileMilestone('', { field: 'percent', value: percent }, '100')).toEqual({
        ok: false,
        reason: 'invalid-percent',
      });
    },
  );
});

describe('milestone reconciliation', () => {
  it('puts the rounding remainder on the last milestone in a complete schedule', () => {
    const rows = [m('a', '33.3333'), m('b', '33.3333'), m('c', '33.3334')];
    expect(milestoneAmounts(rows, '100.00')).toEqual(['33.33', '33.33', '33.34']);
    expect(milestoneAmounts(rows, '100.01')).toEqual(['33.34', '33.34', '33.33']);
  });

  it('keeps all shares non-negative when rounding exhausts a tiny total', () => {
    const rows = ['a', 'b', 'c', 'd'].map((key) => m(key, '25'));
    expect(milestoneAmounts(rows, '0.02')).toEqual(['0.01', '0.01', '0.00', '0.00']);
  });

  it('derives an amount with half-up rounding and keeps both endpoints exact', () => {
    expect(reconcileMilestone('', { field: 'percent', value: '.50' }, '101.00')).toEqual({
      ok: true,
      percent: '0.50',
      amount: '0.51',
    });
    expect(milestoneAmount('50', '9999999999999999.99')).toBe('5000000000000000.00');
    expect(milestoneAmount('100', '9999999999999999.99')).toBe('9999999999999999.99');
    expect(milestoneAmount('0', '9999999999999999.99')).toBe('0.00');
  });

  it('rounds an amount edit to four decimal places of a percent and derives the persisted amount', () => {
    const edit = (value: string) => reconcileMilestone('25', { field: 'amount', value }, '200.00');
    expect(edit('0.01')).toEqual({ ok: true, percent: '0.005', amount: '0.01' });
    expect(edit('200.00')).toEqual({ ok: true, percent: '100', amount: '200.00' });
    expect(edit('0')).toEqual({ ok: true, percent: '0', amount: '0.00' });
    expect(edit('200.01')).toEqual({ ok: false, reason: 'above-total' });
  });

  it.each(['', '-0.01', '1.001', '1e2', '10000000000000000.00'])(
    'rejects %j as an amount',
    (value) => {
      expect(reconcileMilestone('25', { field: 'amount', value }, '100')).toEqual({
        ok: false,
        reason: 'invalid-amount',
      });
    },
  );

  it('keeps the allocation at a zero total and permits percent entry before totals load', () => {
    expect(reconcileMilestone('25.04', { field: 'amount', value: '0' }, '0.00')).toEqual({
      ok: true,
      percent: '25.04',
      amount: '0.00',
    });
    expect(reconcileMilestone('', { field: 'amount', value: '0' }, '0.00')).toEqual({
      ok: false,
      reason: 'invalid-percent',
    });
    expect(reconcileMilestone('25', { field: 'amount', value: '0.01' }, '0.00')).toEqual({
      ok: false,
      reason: 'above-total',
    });
    expect(reconcileMilestone('25', { field: 'amount', value: '0' }, null)).toEqual({
      ok: false,
      reason: 'total-unavailable',
    });
    expect(reconcileMilestone('25', { field: 'percent', value: '100' }, null)).toEqual({
      ok: true,
      percent: '100',
      amount: null,
    });
    expect(milestoneAmount('25.04', '0.00')).toBe('0.00');
  });
});

describe('milestone due date', () => {
  it('accepts a Gregorian leap day and can clear a stored date', () => {
    expect(setMilestoneDueDate('', '2028-02-29')).toEqual({
      ok: true,
      dueDescription: '2028-02-29',
    });
    expect(setMilestoneDueDate('2028-02-29', '')).toEqual({ ok: true, dueDescription: '' });
    expect(setMilestoneDueDate('', '2026-02-29')).toEqual({ ok: false, reason: 'invalid-date' });
    expect(setMilestoneDueDate('', '2026-03-01T00:00:00Z')).toEqual({
      ok: false,
      reason: 'invalid-date',
    });
  });

  it.each(['On order', 'On or before 2026-02-28', '2026-02-30'])(
    'preserves the existing text %j when opening or editing a date',
    (description) => {
      expect(milestoneDue(description)).toEqual({ kind: 'legacy', description });
      expect(setMilestoneDueDate(description, '2026-02-28')).toEqual({
        ok: false,
        reason: 'legacy-description',
      });
      expect(setMilestoneDueDate(description, '')).toEqual({
        ok: false,
        reason: 'legacy-description',
      });
    },
  );
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
  it('does not read a decimal comma as grouping ("1,5" is not 15)', () => {
    const v = filled();
    v.lines[0]!.unitPrice = '10,50';
    v.lines[0]!.quantity = '1,5';
    v.discountMode = 'amount';
    v.discountValue = '1,25';
    const c = toContent(v);
    expect(c.lines[0]?.unitPrice).toBe('10,50');
    expect(c.lines[0]?.quantity).toBe('1,5');
    expect(c.discount).toEqual({ mode: 'amount', value: '1,25' });
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
      termsAndConditions: null,
      deliveryTimeline: null,
      paymentTermId: null,
      discount: null,
      paymentSchedule: null,
    });
    expect(UpdateQuotationDraftBodySchema.safeParse({ ...c, expectedVersion: 2 }).success).toBe(
      true,
    );
  });

  it("sends the rich text editors' HTML as it is (trimmed), and nothing for an empty editor", () => {
    const html = '<p>Net <strong>30</strong></p><ul><li>One</li></ul>';
    const v = filled();
    v.scope = `  ${html}\n`;
    v.termsAndConditions = '<ol><li>First</li><li><em>Second</em></li></ol>';
    v.deliveryTimeline = ''; // what the editor reports for a document without words
    const create = toContent(v);
    expect(create.scope).toBe(html);
    expect(create.termsAndConditions).toBe('<ol><li>First</li><li><em>Second</em></li></ol>');
    expect(create).not.toHaveProperty('deliveryTimeline');
    const update = toContent(v, 'update');
    expect(update.scope).toBe(html);
    expect(update.deliveryTimeline).toBeNull();
    expect(
      UpdateQuotationDraftBodySchema.safeParse({ ...update, expectedVersion: 2 }).success,
    ).toBe(true);
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

describe('editing a saved quotation', () => {
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
    termsAndConditions: null,
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

  it('are absent for a viewer without quotation.cost.read: no cost is held and none is sent (D29)', () => {
    // The API leaves `unitCost` out of every line for such a viewer and keeps the stored costs itself.
    const noCost = version();
    const lines = noCost.lines.map(({ unitCost: _unitCost, ...line }) => line);
    const v = valuesFromVersion({ ...noCost, lines });
    expect(v.lines.map((l) => l.unitCost)).toEqual([null, null]);
    const c = toContent(v, 'update');
    expect(c.lines[0]).not.toHaveProperty('unitCost');
    expect(c.lines[1]).not.toHaveProperty('unitCost');
    // The catalog link still travels, and the body is still valid.
    expect(c.lines[0]).toMatchObject({ catalogItemId: CAT });
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

  it('round-trips a linked amount edit, a new date and an existing description through the contract', () => {
    const v = valuesFromVersion({
      ...version(),
      paymentSchedule: [
        { label: 'Advance', percent: '30', dueDescription: 'On order' },
        { label: 'Delivery', percent: '70' },
      ],
    });
    const amount = reconcileMilestone('30', { field: 'amount', value: '333.34' }, '1000.00');
    const percent = reconcileMilestone('70', { field: 'percent', value: '66.666' }, '1000.00');
    const date = setMilestoneDueDate('', '2028-02-29');
    if (!amount.ok || !percent.ok || !date.ok) throw new Error('Expected valid milestone edits');
    v.schedule = v.schedule.map((milestone, index) =>
      index === 0
        ? { ...milestone, percent: amount.percent }
        : { ...milestone, percent: percent.percent, dueDescription: date.dueDescription },
    );
    expect(scheduleState(v.schedule)).toEqual({ kind: 'ok' });

    const saved = UpdateQuotationDraftBodySchema.parse({
      ...toContent(v, 'update'),
      expectedVersion: 2,
    });
    expect(saved.paymentSchedule).toEqual([
      { label: 'Advance', percent: '33.334', dueDescription: 'On order' },
      { label: 'Delivery', percent: '66.666', dueDescription: '2028-02-29' },
    ]);
    const reopened = valuesFromVersion({
      ...version(),
      paymentSchedule: saved.paymentSchedule ?? [],
    });
    expect(reopened.schedule.map((row) => milestoneDue(row.dueDescription))).toEqual([
      { kind: 'legacy', description: 'On order' },
      { kind: 'date', date: '2028-02-29' },
    ]);
    expect(amount.amount).toBe('333.34');
    expect(reopened.schedule.map((row) => milestoneAmount(row.percent, '1000.00'))).toEqual([
      '333.34',
      '666.66',
    ]);
    expect(reopened.schedule.map((row) => milestoneAmount(row.percent, '2000.00'))).toEqual([
      '666.68',
      '1333.32',
    ]);
  });
});

describe('terms and conditions', () => {
  const OPP = '77777777-7777-4777-8777-777777777777';
  const TERMS = 'Payment within 30 days of invoice.\nGoverned by the laws of Nepal.';

  it('starts empty on a new quotation and is left out of a create when blank', () => {
    expect(emptyValues().termsAndConditions).toBe('');
    const c = toContent(filled());
    expect(c).not.toHaveProperty('termsAndConditions');
    expect(CreateQuotationBodySchema.safeParse({ ...c, opportunityId: OPP }).success).toBe(true);
  });

  it('is sent trimmed in a create and an update, and both bodies pass the contract', () => {
    const v = { ...filled(), termsAndConditions: `  ${TERMS}  ` };
    const create = toContent(v);
    expect(create.termsAndConditions).toBe(TERMS);
    expect(
      CreateQuotationBodySchema.parse({ ...create, opportunityId: OPP }).termsAndConditions,
    ).toBe(TERMS);
    const update = toContent(v, 'update');
    expect(update.termsAndConditions).toBe(TERMS);
    expect(
      UpdateQuotationDraftBodySchema.parse({ ...update, expectedVersion: 2 }).termsAndConditions,
    ).toBe(TERMS);
  });

  it('sends null on an update when cleared (or only spaces), so the saved text is removed', () => {
    for (const blank of ['', '   \n ']) {
      const c = toContent({ ...filled(), termsAndConditions: blank }, 'update');
      expect(c.termsAndConditions).toBeNull();
      expect(
        UpdateQuotationDraftBodySchema.parse({ ...c, expectedVersion: 2 }).termsAndConditions,
      ).toBeNull();
    }
  });

  it('round-trips a saved version: fills the form and is sent back unchanged', () => {
    const saved = { ...versionWith(TERMS) };
    const values = valuesFromVersion(saved);
    expect(values.termsAndConditions).toBe(TERMS);
    expect(toContent(values, 'update').termsAndConditions).toBe(TERMS);
    // A version without terms opens as an empty box, not "null".
    expect(valuesFromVersion(versionWith(null)).termsAndConditions).toBe('');
  });

  it('refuses text over 10000 characters at the contract, so the box caps it', () => {
    const c = toContent({ ...filled(), termsAndConditions: 'x'.repeat(10001) }, 'update');
    expect(UpdateQuotationDraftBodySchema.safeParse({ ...c, expectedVersion: 2 }).success).toBe(
      false,
    );
  });
});

function versionWith(termsAndConditions: string | null): VersionLike {
  return {
    contactId: null,
    currency: 'NPR',
    issueDate: '2026-11-08',
    validUntil: '2026-12-08',
    paymentTermId: null,
    scope: null,
    assumptions: null,
    exclusions: null,
    termsAndConditions,
    deliveryTimeline: null,
    discount: null,
    lines: [
      {
        description: 'HRMS implementation',
        uom: 'lot',
        quantity: '1',
        unitPrice: '180000.00',
        taxCodeId: TAX,
      },
    ],
    paymentSchedule: [],
  };
}

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
