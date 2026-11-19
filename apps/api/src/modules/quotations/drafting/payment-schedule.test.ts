// Unit tests of paymentScheduleAmounts (D36, money precision D22). No database.
// Run: pnpm --filter @bos/api exec vitest run src/modules/quotations/drafting/payment-schedule.test.ts
import { PaymentMilestoneDtoSchema } from '@bos/contracts';
import { describe, expect, it } from 'vitest';

import { paymentScheduleAmounts } from './payment-schedule';

const row = (percent: string, label = 'Part') => ({ label, percent });

describe('paymentScheduleAmounts', () => {
  it('puts the rounding remainder on the last row: 1,000.00 over 3 x 33.3333%', () => {
    const rows = paymentScheduleAmounts('1000.00', [
      row('33.3333'),
      row('33.3333'),
      row('33.3334'),
    ]);
    expect(rows.map((r) => r.amount)).toEqual(['333.33', '333.33', '333.34']);
  });

  it('gives a single 100% row the whole total', () => {
    expect(paymentScheduleAmounts('2690999.99', [row('100')])).toEqual([
      { label: 'Part', percent: '100', amount: '2690999.99' },
    ]);
  });

  it('splits an odd paisa total 50/50: the first row rounds half up, the last takes the rest', () => {
    // 100.01 * 50% = 50.005 -> 50.01, so the last row is 50.00.
    const rows = paymentScheduleAmounts('100.01', [row('50'), row('50')]);
    expect(rows.map((r) => r.amount)).toEqual(['50.01', '50.00']);
    expect(Number(rows[0]!.amount) + Number(rows[1]!.amount)).toBeCloseTo(100.01, 2);
  });

  it('keeps the label, percent and due text, and adds nothing but the amount', () => {
    const rows = paymentScheduleAmounts('500.00', [
      { label: 'Advance', percent: '60', dueDescription: 'On order' },
      { label: 'Go-live', percent: '40' },
    ]);
    expect(rows).toEqual([
      { label: 'Advance', percent: '60', dueDescription: 'On order', amount: '300.00' },
      { label: 'Go-live', percent: '40', amount: '200.00' },
    ]);
    for (const r of rows) expect(PaymentMilestoneDtoSchema.safeParse(r).success).toBe(true);
  });

  it('answers an empty schedule with an empty list', () => {
    expect(paymentScheduleAmounts('100.00', [])).toEqual([]);
  });

  it('shows two decimals even for a whole share', () => {
    expect(paymentScheduleAmounts('100.00', [row('25'), row('75')]).map((r) => r.amount)).toEqual([
      '25.00',
      '75.00',
    ]);
  });
});
