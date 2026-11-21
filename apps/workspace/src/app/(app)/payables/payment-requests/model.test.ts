import { describe, expect, it } from 'vitest';

import type { PaymentRequestItem } from '@/lib/api-payables';

import { requestableItem } from './model';

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
