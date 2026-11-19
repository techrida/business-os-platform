// Unit tests of the vendor bill rules (P4 unit A1): line arithmetic, the match input of a line (check 6), the
// status moves and the approval facts (AD5 bands only off PO).
// Run: pnpm --filter @bos/api exec vitest run src/modules/payables/bills/vendor-bill.rules.test.ts
import { DEFAULT_MATCH_TOLERANCE } from '@bos/money-rules';
import { describe, expect, it } from 'vitest';

import {
  ListBillsQuerySchema,
  afterMatch,
  billFactsOf,
  billTotals,
  lineAmounts,
  matchLine,
  submittable,
  type MatchLineFacts,
} from './vendor-bill.rules';

const facts = (over: Partial<MatchLineFacts> = {}): MatchLineFacts => {
  const base = {
    billedQty: '1',
    billPrice: '10000.00',
    orderedQty: '1',
    receivedQty: '1',
    billedOnLine: '1',
    billedByThisBill: '1',
    poPrice: '10000.00',
    poRateBp: 1300,
    ...over,
  };
  const { net, vat } = lineAmounts(base.billedQty, base.billPrice, 1300);
  return { billNet: net, billVat: vat, ...base, ...over };
};

describe('lineAmounts and billTotals', () => {
  it('rounds net and VAT half up to the paisa', () => {
    expect(lineAmounts('3', '33.335', 1300)).toEqual({ net: '100.01', vat: '13.00' });
    expect(lineAmounts('1', '100000', 1300)).toEqual({ net: '100000.00', vat: '13000.00' });
  });
  it('sums the lines', () => {
    expect(
      billTotals([
        { net: '100.00', vat: '13.00' },
        { net: '0.50', vat: '0.07' },
      ]),
    ).toEqual({ net: '100.50', vat: '13.07', gross: '113.57' });
  });
});

describe('matchLine (check 6, AD6 defaults)', () => {
  it('passes +2% on 10,000 (VAT follows the bill net at the PO rate)', () => {
    expect(
      matchLine(facts({ billPrice: '10200.00' }), DEFAULT_MATCH_TOLERANCE).withinTolerance,
    ).toBe(true);
  });
  it('fails +1% on 1,00,000 (1,000 is past the NPR 500 cap)', () => {
    const r = matchLine(
      facts({ poPrice: '100000.00', billPrice: '101000.00' }),
      DEFAULT_MATCH_TOLERANCE,
    );
    expect(r.priceWithin).toBe(false);
    expect(r.priceVariance.toFixed(2)).toBe('1000.00');
  });
  it('fails 10% over price', () => {
    expect(
      matchLine(facts({ billPrice: '11000.00' }), DEFAULT_MATCH_TOLERANCE).withinTolerance,
    ).toBe(false);
  });
  it('fails a quantity over what arrived', () => {
    const r = matchLine(
      facts({
        orderedQty: '5',
        receivedQty: '3',
        billedQty: '4',
        billedOnLine: '4',
        billedByThisBill: '4',
      }),
      DEFAULT_MATCH_TOLERANCE,
    );
    expect(r.qtyWithin).toBe(false);
  });
  it('counts what other bills already billed on the line', () => {
    const r = matchLine(
      facts({
        orderedQty: '5',
        receivedQty: '5',
        billedQty: '3',
        billedOnLine: '6',
        billedByThisBill: '3',
      }),
      DEFAULT_MATCH_TOLERANCE,
    );
    expect(r.qtyWithin).toBe(false);
  });
  it('fails VAT that is not the PO rate on the bill net', () => {
    const f = facts();
    expect(matchLine({ ...f, billVat: '1300.01' }, DEFAULT_MATCH_TOLERANCE).taxWithin).toBe(false);
    expect(matchLine({ ...f, poRateBp: 0 }, DEFAULT_MATCH_TOLERANCE).taxWithin).toBe(false);
  });
});

describe('status moves', () => {
  it('matches from draft, matching or variance only', () => {
    expect(afterMatch('draft', true)).toEqual({ status: 'matching', matchStatus: 'matched' });
    expect(afterMatch('matching', false)).toEqual({ status: 'variance', matchStatus: 'variance' });
    expect(afterMatch('variance', true)).toEqual({ status: 'matching', matchStatus: 'matched' });
    expect(afterMatch('pending_approval', true)).toBeUndefined();
    expect(afterMatch('exception_pending', true)).toBeUndefined();
  });
  it('submits only matched, exception-approved or non-PO bills', () => {
    expect(submittable('matching', 'matched')).toBe(true);
    expect(submittable('variance', 'variance')).toBe(false);
    expect(submittable('exception_pending', 'variance')).toBe(false);
    expect(submittable('exception_pending', 'exception_approved')).toBe(true);
    expect(submittable('draft', 'not_required')).toBe(true);
    expect(submittable('draft', 'pending')).toBe(false);
    expect(submittable('pending_approval', 'matched')).toBe(false);
  });
});

describe('billFactsOf (AD3, AD4)', () => {
  it('bands on net + VAT in NPR, strict >', () => {
    expect(billFactsOf({ poMatched: false, gross: '100000.00', fxRate: '1' }).band).toBe('none');
    expect(billFactsOf({ poMatched: false, gross: '101700.00', fxRate: '1' })).toEqual({
      poMatched: false,
      band: 'management',
      amountNpr: '101700.00',
    });
    expect(billFactsOf({ poMatched: true, gross: '1000000.01', fxRate: '1' }).band).toBe('founder');
  });
});

describe('ListBillsQuerySchema', () => {
  it('takes a repeated status, a search and a page window, and pages 25 by default', () => {
    expect(ListBillsQuerySchema.parse({})).toEqual({ limit: 25, offset: 0 });
    expect(
      ListBillsQuerySchema.parse({
        status: ['draft', 'variance', 'draft'],
        q: ' acme ',
        limit: '100',
        offset: '50',
      }),
    ).toEqual({ status: ['draft', 'variance'], q: 'acme', limit: 100, offset: 50 });
    expect(ListBillsQuerySchema.parse({ status: 'draft' }).status).toEqual(['draft']);
  });

  it('ignores a one-letter search and refuses an unknown status, a big limit and an unknown key', () => {
    expect(ListBillsQuerySchema.parse({ q: 'a' }).q).toBeUndefined();
    expect(ListBillsQuerySchema.safeParse({ status: ['draft', 'nope'] }).success).toBe(false);
    expect(ListBillsQuerySchema.safeParse({ limit: '101' }).success).toBe(false);
    expect(ListBillsQuerySchema.safeParse({ vendorId: 'x' }).success).toBe(false);
  });
});
