import { describe, expect, it } from 'vitest';

import {
  emptyLine,
  EMPTY_PR_VALUES,
  parsePrValues,
  valuesFromDto,
  valuesFromForm,
  type PrValues,
} from './forms';

const DEPT = '11111111-1111-4111-8111-111111111111';
const COST = '22222222-2222-4222-8222-222222222222';

const valid = (over: Partial<PrValues> = {}): PrValues => ({
  ...EMPTY_PR_VALUES,
  departmentId: DEPT,
  costCenterId: COST,
  justification: 'Chairs for the new office',
  requiredBy: '2026-12-01',
  budgetCode: 'OPS-26',
  lines: [
    {
      description: 'Chair',
      specification: '',
      uom: 'pcs',
      quantity: '10',
      estimatedUnitPrice: '4500.00',
    },
  ],
  ...over,
});

describe('valuesFromForm', () => {
  it('keeps the goods serial requirement through form parsing', () => {
    const input = valid();
    const form = new FormData();
    for (const [name, value] of Object.entries(input)) {
      if (typeof value === 'string') form.set(name, value);
    }
    for (const [name, value] of Object.entries(input.lines[0]!)) {
      if (typeof value === 'string') form.set(`lines.0.${name}`, value);
    }
    form.set('lines.0.requiresSerials', 'on');
    const result = parsePrValues(valuesFromForm(form));
    expect(result.ok && result.data.lines[0]).toMatchObject({ requiresSerials: true });
    form.delete('lines.0.requiresSerials');
    const unchecked = parsePrValues(valuesFromForm(form));
    expect(unchecked.ok && unchecked.data.lines[0]).not.toHaveProperty('requiresSerials');
  });

  it('reads indexed lines in order and the emergency checkbox', () => {
    const f = new FormData();
    f.set('requestType', 'service');
    f.set('isEmergency', 'on');
    f.set('emergencyReason', 'Generator failed');
    f.set('lines.1.description', 'Second');
    f.set('lines.0.description', 'First');
    f.set('lines.0.quantity', '2');
    const v = valuesFromForm(f);
    expect(v.requestType).toBe('service');
    expect(v.isEmergency).toBe(true);
    expect(v.lines.map((l) => l.description)).toEqual(['First', 'Second']);
    expect(v.lines[0]?.quantity).toBe('2');
  });
  it('an unchecked emergency box is false', () => {
    expect(valuesFromForm(new FormData()).isEmergency).toBe(false);
  });
});

describe('parsePrValues', () => {
  it('builds the contract body, dropping optional fields left empty', () => {
    const r = parsePrValues(valid());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data).toMatchObject({
      requestType: 'goods',
      departmentId: DEPT,
      isEmergency: false,
      currency: 'NPR',
    });
    expect(r.data).not.toHaveProperty('projectId');
    expect(r.data).not.toHaveProperty('deliveryLocation');
    expect(r.data).not.toHaveProperty('emergencyReason');
    expect(r.data.lines[0]).not.toHaveProperty('specification');
  });

  it('never sends a reason for a request that is not an emergency', () => {
    const r = parsePrValues(valid({ emergencyReason: 'stale text' }));
    expect(r.ok && r.data).not.toHaveProperty('emergencyReason');
  });

  it('an emergency request must say why, on the reason field', () => {
    const r = parsePrValues(valid({ isEmergency: true }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.emergencyReason).toMatch(/why/i);
  });

  it('an emergency request with a reason is accepted', () => {
    const r = parsePrValues(valid({ isEmergency: true, emergencyReason: 'Generator failed' }));
    expect(r.ok && r.data.emergencyReason).toBe('Generator failed');
  });

  it('department and cost centre must be ids, with words that name the field', () => {
    const r = parsePrValues(valid({ departmentId: 'ops', costCenterId: '' }));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.departmentId).toMatch(/department/i);
      expect(r.errors.costCenterId).toMatch(/cost cent/i);
    }
  });

  it('puts line errors on the line and the field', () => {
    const r = parsePrValues(
      valid({
        lines: [
          {
            description: '',
            specification: '',
            uom: 'pcs',
            quantity: '0',
            estimatedUnitPrice: '-3',
          },
        ],
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors['lines.0.description']).toBeDefined();
      expect(r.errors['lines.0.quantity']).toMatch(/above zero/);
      expect(r.errors['lines.0.estimatedUnitPrice']).toMatch(/0 or more|price/i);
    }
  });

  it('needs at least one line', () => {
    const r = parsePrValues(valid({ lines: [] }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.lines).toMatch(/at least one line/i);
  });

  it('keeps quantities and prices as the text typed (no arithmetic)', () => {
    const r = parsePrValues(valid());
    expect(r.ok && r.data.lines[0]?.quantity).toBe('10');
    expect(r.ok && r.data.lines[0]?.estimatedUnitPrice).toBe('4500.00');
  });

  it('says to remove the space in a quantity or price typed as "10 50"', () => {
    const r = parsePrValues(
      valid({
        lines: [
          {
            description: 'Chair',
            specification: '',
            uom: 'pcs',
            quantity: '10 50',
            estimatedUnitPrice: '4 500.00',
          },
        ],
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors['lines.0.quantity']).toBe('Remove the space inside the number.');
      expect(r.errors['lines.0.estimatedUnitPrice']).toBe('Remove the space inside the number.');
    }
  });
});

describe('valuesFromDto', () => {
  it('round-trips a stored request into form values', () => {
    const v = valuesFromDto({
      requestType: 'mixed',
      departmentId: DEPT,
      costCenterId: COST,
      justification: 'x',
      requiredBy: '2026-12-01',
      deliveryLocation: null,
      budgetCode: 'B',
      projectId: null,
      currency: 'USD',
      isEmergency: true,
      emergencyReason: 'why',
      lines: [
        {
          description: 'd',
          specification: null,
          uom: 'kg',
          quantity: '2.5000',
          estimatedUnitPrice: '10.00',
        },
      ],
    });
    expect(v.deliveryLocation).toBe('');
    expect(v.currency).toBe('USD');
    expect(v.lines[0]).toEqual({
      description: 'd',
      specification: '',
      uom: 'kg',
      quantity: '2.5',
      estimatedUnitPrice: '10.00',
    });
    expect(emptyLine().quantity).toBe('');
  });

  it('starts the editor from a stored value without its extra zeros', () => {
    const v = valuesFromDto({
      requestType: 'goods',
      departmentId: DEPT,
      costCenterId: COST,
      justification: 'x',
      requiredBy: '2026-12-01',
      deliveryLocation: null,
      budgetCode: 'B',
      projectId: null,
      currency: 'NPR',
      isEmergency: false,
      emergencyReason: null,
      lines: [
        {
          description: 'd',
          specification: null,
          uom: 'pcs',
          quantity: '100000.000',
          estimatedUnitPrice: '100000.000',
        },
      ],
    });
    expect(v.lines[0]?.quantity).toBe('100000');
    expect(v.lines[0]?.estimatedUnitPrice).toBe('100000.00');
  });
});
