import { VendorBillLineBodySchema } from '@bos/contracts';
import { describe, expect, it } from 'vitest';

import {
  EMPTY_ROW,
  EXPENSE_ACCOUNT_REFUSED,
  expenseAccountErrors,
  parseBillLines,
  type LineRow,
} from './forms';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const TAX = '22222222-2222-4222-8222-222222222222';
const TDS = '33333333-3333-4333-8333-333333333333';
const POLINE = '44444444-4444-4444-8444-444444444444';
const RECEIPT = '55555555-5555-4555-8555-555555555555';

const row = (over: Partial<LineRow> = {}): LineRow => ({
  ...EMPTY_ROW,
  accountId: ACCOUNT,
  quantity: '2',
  unitPrice: '1000.50',
  taxCodeId: TAX,
  ...over,
});

describe('parseBillLines', () => {
  it('builds lines the contract accepts, with the strings exactly as typed (trimmed)', () => {
    const out = parseBillLines([
      row({ quantity: ' 2.5 ', tdsCodeId: TDS, poLineId: POLINE, receiptLineId: RECEIPT }),
    ]);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.lines).toEqual([
      {
        poLineId: POLINE,
        receiptLineId: RECEIPT,
        accountId: ACCOUNT,
        quantity: '2.5',
        unitPrice: '1000.50',
        taxCodeId: TAX,
        tdsCodeId: TDS,
      },
    ]);
    for (const l of out.lines) expect(VendorBillLineBodySchema.safeParse(l).success).toBe(true);
  });

  it('leaves out a line nobody filled in, including a PO line left blank', () => {
    const out = parseBillLines([row(), { ...EMPTY_ROW, poLineId: POLINE }, { ...EMPTY_ROW }]);
    expect(out.ok && out.lines).toHaveLength(1);
  });

  it('asks for at least one line', () => {
    const out = parseBillLines([{ ...EMPTY_ROW }]);
    expect(out.ok).toBe(false);
    expect(!out.ok && out.errors['lines']).toMatch(/at least one/);
  });

  it('words each wrong field against its row', () => {
    const out = parseBillLines([
      row(),
      row({ quantity: '0', unitPrice: '12.345', accountId: 'abc', taxCodeId: '', tdsCodeId: 'x' }),
    ]);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(Object.keys(out.errors).sort()).toEqual([
      '1.accountId',
      '1.quantity',
      '1.taxCodeId',
      '1.tdsCodeId',
      '1.unitPrice',
    ]);
    expect(Object.keys(out.errors).some((k) => k.startsWith('0.'))).toBe(false);
  });

  it('refuses a price with a sign, an exponent or too many digits, and more than 200 lines', () => {
    for (const unitPrice of ['-1', '1e3', '12345678901234567', '']) {
      const out = parseBillLines([row({ unitPrice })]);
      expect(out.ok).toBe(false);
    }
    const many = Array.from({ length: 201 }, () => row());
    const tooMany = parseBillLines(many);
    expect(!tooMany.ok && tooMany.errors['lines']).toMatch(/at most 200/);
  });
});

describe('expenseAccountErrors', () => {
  it('marks the account field of every row that was sent, and skips a blank row', () => {
    expect(expenseAccountErrors([row(), { ...EMPTY_ROW, poLineId: POLINE }, row()])).toEqual({
      '0.accountId': EXPENSE_ACCOUNT_REFUSED,
      '2.accountId': EXPENSE_ACCOUNT_REFUSED,
    });
  });

  it('asks to choose an account when a row has none', () => {
    const out = parseBillLines([row({ accountId: '' })]);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.errors['0.accountId']).toBe('Choose the expense account this line is booked to.');
  });
});
