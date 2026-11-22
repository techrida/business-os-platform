import { describe, expect, it } from 'vitest';

import { parseAmend, parseReason, toScaled } from './forms';

const A = '22222222-2222-4222-8222-222222222222';
const B = '33333333-3333-4333-8333-333333333333';
const current = [
  { id: A, orderedQuantity: '10.0000', unitPrice: '1000.00' },
  { id: B, orderedQuantity: '5.0000', unitPrice: '250.50' },
];
const same = {
  reason: 'Vendor raised the price',
  paymentTermsDays: '30',
  lines: {
    [A]: { quantity: '10', unitPrice: '1000' },
    [B]: { quantity: '5.0000', unitPrice: '250.5' },
  },
};

describe('toScaled', () => {
  it('compares decimals exactly, whatever the trailing zeros', () => {
    expect(toScaled('10', 4)).toBe(toScaled('10.0000', 4));
    expect(toScaled('0.1', 4)).toBe(1000n);
    expect(toScaled('1.23456', 4)).toBeNull();
    expect(toScaled('-1', 4)).toBeNull();
    expect(toScaled('', 4)).toBeNull();
    expect(toScaled('1e3', 4)).toBeNull();
  });
});

describe('parseAmend', () => {
  it('sends only the lines that changed, and no terms when they did not', () => {
    const r = parseAmend(
      { ...same, lines: { ...same.lines, [B]: { quantity: '6', unitPrice: '250.50' } } },
      current,
      30,
    );
    expect(r).toEqual({
      ok: true,
      body: { reason: 'Vendor raised the price', lines: [{ poLineId: B, quantity: '6' }] },
    });
  });

  it('sends a price change as its own field, and changed terms', () => {
    const r = parseAmend(
      {
        ...same,
        paymentTermsDays: '45',
        lines: { ...same.lines, [A]: { quantity: '10', unitPrice: '1100.00' } },
      },
      current,
      30,
    );
    expect(r).toEqual({
      ok: true,
      body: {
        reason: 'Vendor raised the price',
        paymentTermsDays: 45,
        lines: [{ poLineId: A, unitPrice: '1100' }],
      },
    });
  });

  it('refuses when nothing changed, before any API call', () => {
    const r = parseAmend(same, current, 30);
    expect(r.ok).toBe(false);
    if (!r.ok)
      expect(r.errors['lines']).toMatch(/change a quantity, a price or the payment terms/i);
  });

  it('sends a change of the payment terms alone, with no line (F1-Q40)', () => {
    expect(parseAmend({ ...same, paymentTermsDays: '45' }, current, 30)).toEqual({
      ok: true,
      body: { reason: same.reason, paymentTermsDays: 45, lines: [] },
    });
  });

  it('needs a reason, and refuses a quantity or price that is not a number', () => {
    const r = parseAmend(
      {
        reason: '  ',
        paymentTermsDays: '30',
        lines: {
          [A]: { quantity: '0', unitPrice: '1000' },
          [B]: { quantity: '5', unitPrice: '-1' },
        },
      },
      current,
      30,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors['reason']).toBeDefined();
      expect(r.errors[`${A}.quantity`]).toMatch(/above zero/i);
      expect(r.errors[`${B}.unitPrice`]).toBeDefined();
    }
  });

  it('refuses terms outside 0 to 365 days', () => {
    const r = parseAmend(
      {
        ...same,
        paymentTermsDays: '400',
        lines: { ...same.lines, [A]: { quantity: '11', unitPrice: '1000' } },
      },
      current,
      30,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors['paymentTermsDays']).toBeDefined();
  });

  it('says to remove the space in a quantity, price or terms typed as "10 50"', () => {
    const r = parseAmend(
      {
        ...same,
        paymentTermsDays: '3 0',
        lines: { ...same.lines, [A]: { quantity: '10 50', unitPrice: '1 000' } },
      },
      current,
      30,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors[`${A}.quantity`]).toBe('Remove the space inside the number.');
      expect(r.errors[`${A}.unitPrice`]).toBe('Remove the space inside the number.');
      expect(r.errors['paymentTermsDays']).toBe('Remove the space inside the number.');
    }
  });

  it('sends the same body for grouped or zero-padded text as for the plain number', () => {
    // A form posted before hydration carries the typed text; a hydrated number box posts the plain number.
    const typed = parseAmend(
      {
        ...same,
        lines: {
          [A]: { quantity: '1,500.00', unitPrice: '12,50,000.00' },
          [B]: { quantity: '10.50', unitPrice: '250.50' },
        },
      },
      current,
      30,
    );
    const plain = parseAmend(
      {
        ...same,
        lines: {
          [A]: { quantity: '1500', unitPrice: '1250000' },
          [B]: { quantity: '10.5', unitPrice: '250.5' },
        },
      },
      current,
      30,
    );
    expect(typed).toEqual({
      ok: true,
      body: {
        reason: 'Vendor raised the price',
        lines: [
          { poLineId: A, quantity: '1500', unitPrice: '1250000' },
          { poLineId: B, quantity: '10.5' },
        ],
      },
    });
    expect(typed).toEqual(plain);
  });

  it('still refuses a decimal comma and a space inside the number', () => {
    const r = parseAmend(
      { ...same, lines: { ...same.lines, [A]: { quantity: '1,5', unitPrice: '10 50' } } },
      current,
      30,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors[`${A}.quantity`]).toBe('Use a number with up to 4 decimal places.');
      expect(r.errors[`${A}.unitPrice`]).toBe('Remove the space inside the number.');
    }
  });
});

describe('parseReason', () => {
  it('trims, requires and caps at 500', () => {
    expect(parseReason('  Ordered twice ')).toEqual({ ok: true, data: 'Ordered twice' });
    expect(parseReason('   ').ok).toBe(false);
    expect(parseReason('x'.repeat(501)).ok).toBe(false);
    expect(parseReason('x'.repeat(500)).ok).toBe(true);
  });
});
