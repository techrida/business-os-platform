// Unit test of the account rules bills and payment requests are checked against. No database.
// Run: pnpm --filter @bos/api exec vitest run src/modules/company-accounts/company-accounts.rules.test.ts
import { describe, expect, it } from 'vitest';

import {
  bankAccountViolation,
  expenseAccountsViolation,
  idsToCheck,
  isAccountId,
} from './company-accounts.rules';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

describe('idsToCheck', () => {
  it('lowercases, dedupes and drops the unchanged ids whatever their case', () => {
    expect(idsToCheck([A.toUpperCase(), A, B], new Set([B.toUpperCase()]))).toEqual([A]);
  });

  it('checks everything when nothing is unchanged', () => {
    expect(idsToCheck([B, A])).toEqual([B, A]);
  });
});

describe('isAccountId', () => {
  it('accepts a lowercase uuid and refuses anything a uuid column would reject', () => {
    expect(isAccountId(A)).toBe(true);
    expect(isAccountId('not-a-uuid')).toBe(false);
    expect(isAccountId('')).toBe(false);
  });
});

describe('expenseAccountsViolation', () => {
  it('passes when every checked id is found active', () => {
    expect(
      expenseAccountsViolation(
        [A, B],
        [
          { id: A, status: 'active' },
          { id: B.toUpperCase(), status: 'active' },
        ],
      ),
    ).toBeNull();
  });

  it.each([
    ['retired', [{ id: A, status: 'retired' as const }]],
    ['missing', []],
  ])('refuses a %s account with the line message', (_label, found) => {
    expect(expenseAccountsViolation([A], found)).toEqual({
      code: 'EXPENSE_ACCOUNT_INVALID',
      message: 'Choose an active expense account for every line',
    });
  });
});

describe('bankAccountViolation', () => {
  it('passes an active account in the document currency', () => {
    expect(bankAccountViolation({ status: 'active', currency: 'NPR' }, 'NPR')).toBeNull();
  });

  it.each([
    ['missing', undefined],
    ['retired', { status: 'retired' as const, currency: 'NPR' }],
  ])('refuses a %s account', (_label, found) => {
    expect(bankAccountViolation(found, 'NPR')).toEqual({
      code: 'BANK_ACCOUNT_INVALID',
      message: 'Choose an active bank account of this company',
    });
  });

  it('names both currencies on a mismatch', () => {
    const violation = bankAccountViolation({ status: 'active', currency: 'USD' }, 'NPR');
    expect(violation?.code).toBe('BANK_ACCOUNT_CURRENCY_MISMATCH');
    expect(violation?.message).toContain('USD');
    expect(violation?.message).toContain('NPR');
  });

  it('reports a retired account as invalid before any currency mismatch', () => {
    expect(bankAccountViolation({ status: 'retired', currency: 'USD' }, 'NPR')?.code).toBe(
      'BANK_ACCOUNT_INVALID',
    );
  });
});
