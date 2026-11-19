import { trimPercent } from '@bos/contracts';
import { describe, expect, it } from 'vitest';

import {
  discountNeedsApproval,
  exceedsDiscountLimit,
  parseApprovalSnapshot,
  routeReasons,
} from './approval-snapshot';

const valid = () => ({
  nprTotal: '2690999.99',
  effectiveDiscountPct: '13.0000',
  marginPct: '22.5000',
  nprDiscountAmount: '400000.00',
  currency: 'USD',
  fxRate: '133.500000',
  customerName: 'Big Kahuna Burger Ltd.',
  quotationNumber: 'QT-2082-0042',
  revisionNo: 2,
  discountApprovalRequired: true,
});

describe('parseApprovalSnapshot', () => {
  it('reads a valid snapshot, even after a JSON round trip', () => {
    const stored = JSON.parse(JSON.stringify(valid())) as unknown;
    expect(parseApprovalSnapshot(stored)).toEqual(valid());
  });

  it('reads an NPR document with an unknown margin', () => {
    const snap = parseApprovalSnapshot({
      ...valid(),
      currency: 'NPR',
      fxRate: '1',
      marginPct: null,
    });
    expect(snap?.marginPct).toBeNull();
    expect(snap?.currency).toBe('NPR');
  });

  it('reads a snapshot without a margin: the API omits it without quotation.cost.read', () => {
    const { marginPct, ...noMargin } = valid();
    expect(marginPct).toBe('22.5000');
    const snap = parseApprovalSnapshot(noMargin);
    expect(snap).not.toBeNull();
    expect(snap?.marginPct).toBeUndefined();
  });

  it('gives null when a key is missing, and for every non-object', () => {
    const { nprTotal, ...rest } = valid();
    expect(nprTotal).toBe('2690999.99');
    expect(parseApprovalSnapshot(rest)).toBeNull();
    const { discountApprovalRequired, ...noFlag } = valid();
    expect(discountApprovalRequired).toBe(true);
    expect(parseApprovalSnapshot(noFlag)).toBeNull();
    for (const bad of [null, undefined, 'text', 42, [], {}]) {
      expect(parseApprovalSnapshot(bad)).toBeNull();
    }
  });

  it('gives null when a value has the wrong type', () => {
    expect(parseApprovalSnapshot({ ...valid(), nprTotal: 2690999.99 })).toBeNull();
    expect(parseApprovalSnapshot({ ...valid(), effectiveDiscountPct: 13 })).toBeNull();
    expect(parseApprovalSnapshot({ ...valid(), revisionNo: '2' })).toBeNull();
    expect(parseApprovalSnapshot({ ...valid(), currency: 'EUR' })).toBeNull();
    expect(parseApprovalSnapshot({ ...valid(), marginPct: 22.5 })).toBeNull();
    expect(parseApprovalSnapshot({ ...valid(), discountApprovalRequired: 'yes' })).toBeNull();
  });

  it('does not read snake_case keys', () => {
    const { nprTotal, ...rest } = valid();
    expect(parseApprovalSnapshot({ ...rest, npr_total: nprTotal })).toBeNull();
  });
});

describe('discountNeedsApproval', () => {
  const snap = (over: Partial<ReturnType<typeof valid>>) => {
    const parsed = parseApprovalSnapshot({ ...valid(), ...over });
    if (!parsed) throw new Error('fixture must parse');
    return parsed;
  };

  it('follows the server flag, not the four-decimal text', () => {
    // 12.00004 rounds to "12.0000" in the text, yet the server compared it unrounded and flagged it.
    expect(
      discountNeedsApproval(
        snap({ effectiveDiscountPct: '12.0000', discountApprovalRequired: true }),
      ),
    ).toBe(true);
    // The flag wins the other way too: a stale text above 12 does not highlight a cleared flag.
    expect(
      discountNeedsApproval(
        snap({ effectiveDiscountPct: '13.0000', discountApprovalRequired: false }),
      ),
    ).toBe(false);
  });
});

describe('exceedsDiscountLimit', () => {
  it('is true only strictly above 12', () => {
    expect(exceedsDiscountLimit('12.0000')).toBe(false);
    expect(exceedsDiscountLimit('11.9999')).toBe(false);
    expect(exceedsDiscountLimit('12.0001')).toBe(true);
    expect(exceedsDiscountLimit('13.0000')).toBe(true);
    expect(exceedsDiscountLimit('100')).toBe(true);
    expect(exceedsDiscountLimit('0.0000')).toBe(false);
  });
});

describe('trimPercent', () => {
  it('drops trailing zeros without rounding anything away', () => {
    expect(trimPercent('13.0000')).toBe('13');
    expect(trimPercent('22.5000')).toBe('22.5');
    expect(trimPercent('12.0001')).toBe('12.0001');
    expect(trimPercent('-3.2500')).toBe('-3.25');
    expect(trimPercent('133.500000')).toBe('133.5');
    expect(trimPercent('1')).toBe('1');
    expect(trimPercent('0.0000')).toBe('0');
  });
});

describe('routeReasons', () => {
  const step = (seq: number, reason: string) => ({ seq, reason });

  it('lists each step reason once, in step order, skipping blanks', () => {
    expect(
      routeReasons([
        step(2, 'Discount above 12%'),
        step(1, 'Every quotation needs a Sales Manager'),
        step(3, '  '),
        step(4, 'Discount above 12%'),
      ]),
    ).toEqual(['Every quotation needs a Sales Manager', 'Discount above 12%']);
  });

  it('is empty when there are no steps', () => {
    expect(routeReasons([])).toEqual([]);
  });
});
