// Unit tests for rule conditions (decimal comparison) and canonical JSON (snapshot hash stability).
import { describe, expect, it } from 'vitest';

import { canonicalJson, canonicalSha256 } from './canonical-json';
import { ConditionError, evaluate } from './conditions';

describe('evaluate', () => {
  const facts = { amountNpr: '100000.01', currency: 'NPR', urgent: true, nested: { n: 5 } };

  it.each([
    [{ field: 'amountNpr', op: 'gt', value: '100000' }, true],
    [{ field: 'amountNpr', op: 'gt', value: '100000.01' }, false],
    [{ field: 'amountNpr', op: 'gte', value: '100000.01' }, true],
    [{ field: 'amountNpr', op: 'lt', value: 100001 }, true],
    [{ field: 'amountNpr', op: 'lte', value: '100000' }, false],
    [{ field: 'amountNpr', op: 'eq', value: '100000.010' }, true],
    [{ field: 'amountNpr', op: 'neq', value: '100000.01' }, false],
    [{ field: 'currency', op: 'eq', value: 'NPR' }, true],
    [{ field: 'urgent', op: 'neq', value: false }, true],
    [{ field: 'currency', op: 'in', value: ['INR', 'NPR'] }, true],
    [{ field: 'currency', op: 'in', value: ['USD'] }, false],
    [{ field: 'nested.n', op: 'gte', value: 5 }, true],
    [
      {
        all: [
          { field: 'urgent', op: 'eq', value: true },
          { field: 'currency', op: 'eq', value: 'USD' },
        ],
      },
      false,
    ],
    [
      {
        any: [
          { field: 'urgent', op: 'eq', value: false },
          { field: 'currency', op: 'eq', value: 'NPR' },
        ],
      },
      true,
    ],
  ] as const)('%j is %s', (condition, expected) => {
    expect(evaluate(condition as never, facts)).toBe(expected);
  });

  it('compares decimals exactly where floats would not', () => {
    expect(evaluate({ field: 'x', op: 'eq', value: '0.3' }, { x: '0.30' })).toBe(true);
    expect(
      evaluate({ field: 'x', op: 'gt', value: '9007199254740993' }, { x: '9007199254740994' }),
    ).toBe(true);
  });

  it.each([
    [{ field: 'missing', op: 'gt', value: '1' }, {}],
    [{ field: '__proto__', op: 'eq', value: 'x' }, {}],
    [{ field: 'amount', op: 'gt', value: '1' }, { amount: '1e5' }],
    [{ field: 'amount', op: 'gt', value: 'abc' }, { amount: '5' }],
    [{ field: 'obj', op: 'in', value: ['a'] }, { obj: { a: 1 } }],
  ] as const)('throws ConditionError for %j on %j', (condition, facts) => {
    expect(() => evaluate(condition as never, facts)).toThrow(ConditionError);
  });
});

describe('canonicalJson', () => {
  it('is the same for the same data in any key order', () => {
    const a = { b: 1, a: { y: [1, { d: 'x', c: null }], x: true } };
    const b = { a: { x: true, y: [1, { c: null, d: 'x' }] }, b: 1 };
    expect(canonicalJson(a)).toBe('{"a":{"x":true,"y":[1,{"c":null,"d":"x"}]},"b":1}');
    expect(canonicalJson(b)).toBe(canonicalJson(a));
    expect(canonicalSha256(a).equals(canonicalSha256(b))).toBe(true);
    expect(canonicalSha256(a)).toHaveLength(32);
  });

  it('changes the hash when a value changes', () => {
    expect(
      canonicalSha256({ amount: '100.00' }).equals(canonicalSha256({ amount: '100.01' })),
    ).toBe(false);
  });

  it('follows JSON for undefined, dates and strings', () => {
    expect(
      canonicalJson({ a: undefined, b: [undefined], c: new Date('2026-01-01T00:00:00Z'), d: 'é"' }),
    ).toBe('{"b":[null],"c":"2026-01-01T00:00:00.000Z","d":"é\\""}');
  });

  it.each([[Number.NaN], [Number.POSITIVE_INFINITY], [10n], [undefined]])('refuses %s', (value) => {
    expect(() => canonicalJson(value)).toThrow(TypeError);
  });
});
