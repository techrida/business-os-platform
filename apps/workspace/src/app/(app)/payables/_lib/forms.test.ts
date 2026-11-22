import { VendorBillLineBodySchema } from '@bos/contracts';
import { describe, expect, it } from 'vitest';

import {
  EMPTY_ROW,
  EXPENSE_ACCOUNT_REFUSED,
  expenseAccountErrors,
  parseActiveAccountIds,
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

  it('says to remove the space when a quantity or price has one inside, and keeps the other messages', () => {
    // Fails on the old code: "10 50" got the generic format message, which does not say what is wrong.
    const spaced = parseBillLines([row({ quantity: '1 5', unitPrice: '10 50' })]);
    expect(spaced.ok).toBe(false);
    if (spaced.ok) return;
    expect(spaced.errors['0.quantity']).toBe('Remove the space inside the number.');
    expect(spaced.errors['0.unitPrice']).toBe('Remove the space inside the number.');

    const other = parseBillLines([row({ quantity: '1.23456', unitPrice: '12.345' })]);
    expect(other.ok).toBe(false);
    if (other.ok) return;
    expect(other.errors['0.quantity']).toBe('Use a number with up to 4 decimal places.');
    expect(other.errors['0.unitPrice']).toBe(
      'Use an amount such as 1250.50, with up to 2 decimal places.',
    );
  });

  it('accepts the plain amount a grouped price box posts', () => {
    const out = parseBillLines([row({ quantity: '1250000', unitPrice: '1250000.00' })]);
    expect(out.ok && out.lines[0]).toMatchObject({ quantity: '1250000', unitPrice: '1250000.00' });
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

  it('marks only the rows whose account is not among the active ones, whatever its case', () => {
    const retired = '66666666-6666-4666-8666-666666666666';
    const rows = [row({ accountId: ACCOUNT.toUpperCase() }), row({ accountId: retired })];
    // Fails on the old code: it marked the active line too.
    expect(expenseAccountErrors(rows, new Set([ACCOUNT]))).toEqual({
      '1.accountId': EXPENSE_ACCOUNT_REFUSED,
    });
  });

  it('marks every sent row when each one looks active (retired after the page loaded)', () => {
    expect(expenseAccountErrors([row(), row()], new Set([ACCOUNT]))).toEqual({
      '0.accountId': EXPENSE_ACCOUNT_REFUSED,
      '1.accountId': EXPENSE_ACCOUNT_REFUSED,
    });
  });

  it('asks to choose an account when a row has none', () => {
    const out = parseBillLines([row({ accountId: '' })]);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.errors['0.accountId']).toBe('Choose the expense account this line is booked to.');
  });
});

describe('parseActiveAccountIds', () => {
  it('reads the posted ids lowercase, and nothing when the field was not sent', () => {
    expect(parseActiveAccountIds(` ${ACCOUNT.toUpperCase()},${TAX}, `)).toEqual(
      new Set([ACCOUNT, TAX]),
    );
    expect(parseActiveAccountIds('')).toEqual(new Set());
    expect(parseActiveAccountIds(null)).toBeUndefined();
  });
});
