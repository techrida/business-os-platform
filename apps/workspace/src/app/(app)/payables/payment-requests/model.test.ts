import { describe, expect, it } from 'vitest';

import type { PaymentRequestItem } from '@/lib/api-payables';

import { readPaymentRequestForm, requestableItem, reviewPaymentRequest } from './model';

const BILL = '44444444-4444-4444-8444-444444444444';
const item = (over: Partial<PaymentRequestItem> = {}): PaymentRequestItem => ({
  openItemId: '33333333-3333-4333-8333-333333333333',
  vendorPartyId: '11111111-1111-4111-8111-111111111111',
  vendorName: 'Himal Supplies',
  vendorBillId: BILL,
  billNumber: 'BILL-1',
  vendorInvoiceNo: 'INV-1',
  currency: 'NPR',
  openAmount: '100.00',
  claimedAmount: '0.00',
  availableAmount: '100.00',
  ...over,
});

describe('requestableItem', () => {
  it('returns the bill item with a balance still free to claim', () => {
    const free = item();
    expect(requestableItem([free], BILL)).toBe(free);
  });

  it('accepts a bill in a currency the company switched off (D56 U16-Q1)', () => {
    // Payment requests are exempt from the switch-off: the old check against the enabled list hid this one.
    const inr = item({ currency: 'INR' });
    expect(requestableItem([inr], BILL)).toBe(inr);
  });

  it('skips a fully claimed balance and another bill', () => {
    expect(requestableItem([item({ availableAmount: '0.00' })], BILL)).toBeUndefined();
    expect(
      requestableItem([item({ vendorBillId: '55555555-5555-4555-8555-555555555555' })], BILL),
    ).toBeUndefined();
  });
});

describe('readPaymentRequestForm amounts (R5 EF2)', () => {
  const ID = '11111111-1111-4111-8111-111111111111';
  const entry = (amount: string) => {
    const f = new FormData();
    for (const [name, value] of Object.entries({
      vendorPartyId: ID,
      fromBankAccountId: ID,
      currency: 'NPR',
      lineCount: '1',
      'allocation:0:openItemId': ID,
      'allocation:0:amount': amount,
    }))
      f.set(name, value);
    return f;
  };
  const names = {
    vendor: () => 'Himal Supplies',
    bankAccount: () => 'NIC Asia current',
    purchaseOrder: () => undefined,
    bill: () => 'BILL-1',
  };
  const NOW = new Date('2026-11-22T06:00:00Z');

  it.each([
    ['1,500.00', '1500'],
    ['10.50', '10.5'],
    ['12,50,000.00', '1250000'],
  ])(
    'reads grouped or padded %s exactly as the plain %s, for the create action and the review alike',
    (typed, plain) => {
      const grouped = readPaymentRequestForm(entry(typed));
      expect(grouped.allocations).toEqual([{ openItemId: ID, amount: plain }]);
      expect(grouped).toEqual(readPaymentRequestForm(entry(plain)));
      const review = reviewPaymentRequest(entry(typed), names, NOW);
      expect(review?.lines).toEqual([{ reference: 'BILL-1', amount: plain }]);
      expect(review).toEqual(reviewPaymentRequest(entry(plain), names, NOW));
    },
  );

  it.each(['10 50', '1,5'])(
    'keeps %s as typed, so the create action can name it, and the review refuses it',
    (typed) => {
      // The action picks "Remove the space inside the number." from this text; joining "10 50" would hide it.
      expect(readPaymentRequestForm(entry(typed)).allocations).toEqual([
        { openItemId: ID, amount: typed },
      ]);
      expect(reviewPaymentRequest(entry(typed), names, NOW)).toBeNull();
    },
  );
});
