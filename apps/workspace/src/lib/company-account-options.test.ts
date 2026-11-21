import {
  UNKNOWN_ACCOUNT_LABEL,
  type CompanyBankAccount,
  type ExpenseAccount,
} from '@bos/contracts';
import { describe, expect, it } from 'vitest';

import { matchesQuery } from '@/components/ui/combobox-model';

import { accountLabel, bankAccountOptions, expenseAccountOptions } from './company-account-options';

const guid = (n: number) => `${String(n).repeat(8)}-1111-4111-8111-111111111111`;

const bank = (n: number, extra: Partial<CompanyBankAccount> = {}): CompanyBankAccount => ({
  id: guid(n),
  name: `Account ${n}`,
  bankName: 'Nabil Bank',
  last4: `${n}${n}${n}${n}`,
  currency: 'NPR',
  status: 'active',
  retiredAt: null,
  ...extra,
});
const retired = { status: 'retired', retiredAt: '2026-11-20T09:30:00.000Z' } as const;

const expense = (n: number, extra: Partial<ExpenseAccount> = {}): ExpenseAccount => ({
  id: guid(n),
  code: `51${n}0`,
  name: `Expense ${n}`,
  status: 'active',
  retiredAt: null,
  ...extra,
});

const unknownId = '99999999-9999-4999-8999-999999999999';

describe('bankAccountOptions', () => {
  const accounts = [
    bank(1),
    bank(2, { currency: 'USD', bankName: 'Himalayan Bank' }),
    bank(3, retired),
    bank(4),
  ];

  it('offers only active accounts in the chosen currency, labelled bank, last four and currency', () => {
    const options = bankAccountOptions(accounts, { currency: 'NPR' });
    expect(options.map((o) => [o.id, o.label])).toEqual([
      [guid(1), 'Account 1 · Nabil Bank ····1111 · NPR'],
      [guid(4), 'Account 4 · Nabil Bank ····4444 · NPR'],
    ]);
    expect(bankAccountOptions(accounts, { currency: 'USD' }).map((o) => o.id)).toEqual([guid(2)]);
    expect(bankAccountOptions(accounts, { currency: 'INR' })).toEqual([]);
    expect(bankAccountOptions([], { currency: 'NPR' })).toEqual([]);
  });

  it('adds nothing when the saved value is already on offer, or when there is none', () => {
    const plain = bankAccountOptions(accounts, { currency: 'NPR' });
    expect(bankAccountOptions(accounts, { currency: 'NPR', currentId: guid(1) })).toEqual(plain);
    expect(bankAccountOptions(accounts, { currency: 'NPR', currentId: '' })).toEqual(plain);
    expect(bankAccountOptions(accounts, { currency: 'NPR', currentId: null })).toEqual(plain);
  });

  it('keeps a retired saved account selectable, marked retired', () => {
    const options = bankAccountOptions(accounts, { currency: 'NPR', currentId: guid(3) });
    expect(options).toHaveLength(3);
    expect(options.at(-1)).toMatchObject({
      id: guid(3),
      label: 'Account 3 · Nabil Bank ····3333 · NPR (retired)',
    });
  });

  it('keeps an active saved account in another currency selectable with its plain label', () => {
    const options = bankAccountOptions(accounts, { currency: 'NPR', currentId: guid(2) });
    expect(options.at(-1)).toMatchObject({
      id: guid(2),
      label: 'Account 2 · Himalayan Bank ····2222 · USD',
    });
  });

  it('shows a saved id that matches no account as Unknown account, never the raw id', () => {
    const options = bankAccountOptions(accounts, { currency: 'NPR', currentId: unknownId });
    expect(options.at(-1)).toEqual({ id: unknownId, label: UNKNOWN_ACCOUNT_LABEL });
    expect(options.map((o) => o.label).join(' ')).not.toContain(unknownId);
  });

  it('matches a typed name, bank, last four or currency', () => {
    const [option] = bankAccountOptions([bank(5, { name: 'Payroll' })], { currency: 'NPR' });
    if (option === undefined) throw new Error('expected an option');
    for (const query of ['payroll', 'nabil', '5555', 'npr', 'nabil 5555']) {
      expect(matchesQuery(option, query), query).toBe(true);
    }
    expect(matchesQuery(option, 'usd')).toBe(false);
  });

  it('handles a long name without dropping the bank, last four or currency', () => {
    const name = 'Operating account for the Kathmandu head office and branch payments'.repeat(2);
    const [option] = bankAccountOptions([bank(6, { name })], { currency: 'NPR' });
    expect(option?.label).toBe(`${name} · Nabil Bank ····6666 · NPR`);
  });
});

describe('expenseAccountOptions', () => {
  const accounts = [expense(1), expense(2, retired), expense(3)];

  it('offers only active accounts, labelled code and name', () => {
    expect(expenseAccountOptions(accounts).map((o) => [o.id, o.label])).toEqual([
      [guid(1), '5110 · Expense 1'],
      [guid(3), '5130 · Expense 3'],
    ]);
    expect(expenseAccountOptions([])).toEqual([]);
  });

  it('adds nothing when the saved value is on offer or empty', () => {
    const plain = expenseAccountOptions(accounts);
    expect(expenseAccountOptions(accounts, { currentId: guid(3) })).toEqual(plain);
    expect(expenseAccountOptions(accounts, { currentId: undefined })).toEqual(plain);
  });

  it('keeps a retired saved account selectable, marked retired, and labels an unmatched id Unknown account', () => {
    expect(expenseAccountOptions(accounts, { currentId: guid(2) }).at(-1)).toMatchObject({
      id: guid(2),
      label: '5120 · Expense 2 (retired)',
    });
    expect(expenseAccountOptions(accounts, { currentId: unknownId }).at(-1)).toEqual({
      id: unknownId,
      label: UNKNOWN_ACCOUNT_LABEL,
    });
  });

  it('matches a typed code or name', () => {
    const [option] = expenseAccountOptions([expense(4, { name: 'Office supplies' })]);
    if (option === undefined) throw new Error('expected an option');
    for (const query of ['5140', 'office', 'supplies 5140']) {
      expect(matchesQuery(option, query), query).toBe(true);
    }
  });
});

describe('accountLabel', () => {
  it('labels a bank account, active or retired, and an unmatched id as Unknown account', () => {
    const accounts = [bank(1), bank(2, retired)];
    expect(accountLabel('bank', guid(1), accounts)).toBe('Account 1 · Nabil Bank ····1111 · NPR');
    expect(accountLabel('bank', guid(2), accounts)).toBe('Account 2 · Nabil Bank ····2222 · NPR');
    expect(accountLabel('bank', unknownId, accounts)).toBe(UNKNOWN_ACCOUNT_LABEL);
    expect(accountLabel('bank', guid(1), [])).toBe(UNKNOWN_ACCOUNT_LABEL);
  });

  it('labels an expense account, and an unmatched id as Unknown account', () => {
    const accounts = [expense(1), expense(2, retired)];
    expect(accountLabel('expense', guid(1), accounts)).toBe('5110 · Expense 1');
    expect(accountLabel('expense', guid(2), accounts)).toBe('5120 · Expense 2');
    expect(accountLabel('expense', unknownId, accounts)).toBe(UNKNOWN_ACCOUNT_LABEL);
  });
});
