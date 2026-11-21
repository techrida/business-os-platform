// Options for the bank-account and expense-account pickers (the shared Combobox), and the label shown for a
// saved id. Pure: no React, no server import, so client forms and server pages share it.
//
// A picker offers active rows only. A value already saved on the document stays selectable even when it is no
// longer on offer: a retired row shows as "<label> (retired)" and an id that matches no row (a GUID typed before
// these lists existed) shows as "Unknown account". The raw id is never shown. For the retired label to appear,
// the caller must pass the list read with `includeRetired`; with active rows only, a retired value reads as
// unknown.
import {
  UNKNOWN_ACCOUNT_LABEL,
  companyBankAccountLabel,
  expenseAccountLabel,
  type CompanyBankAccount,
  type Currency,
  type ExpenseAccount,
} from '@bos/contracts';

import type { ComboboxOption } from '@/components/ui/combobox-model';

export type CompanyAccountKind = 'bank' | 'expense';

const retiredLabel = (label: string): string => `${label} (retired)`;

const bankOption = (account: CompanyBankAccount, label: string): ComboboxOption => ({
  id: account.id,
  label,
  searchText: [account.name, account.bankName, account.last4, account.currency].join(' '),
});

const expenseOption = (account: ExpenseAccount, label: string): ComboboxOption => ({
  id: account.id,
  label,
  searchText: [account.code, account.name].join(' '),
});

const unknownOption = (id: string): ComboboxOption => ({ id, label: UNKNOWN_ACCOUNT_LABEL });

const hasValue = (id: string | null | undefined): id is string =>
  typeof id === 'string' && id !== '';

/**
 * The paying entity's bank accounts a payment request may leave from: active rows in `currency`, plus the
 * saved `currentId` when it is not among them. A saved row that was retired gets "(retired)"; one that is
 * active but in another currency stays selectable with its plain label (the currency in the label shows the
 * mismatch); an id that matches nothing is "Unknown account".
 */
export function bankAccountOptions(
  accounts: readonly CompanyBankAccount[],
  { currency, currentId }: { currency: Currency; currentId?: string | null | undefined },
): ComboboxOption[] {
  const options = accounts
    .filter((account) => account.status === 'active' && account.currency === currency)
    .map((account) => bankOption(account, companyBankAccountLabel(account)));
  if (!hasValue(currentId) || options.some((option) => option.id === currentId)) return options;
  const saved = accounts.find((account) => account.id === currentId);
  if (saved === undefined) return [...options, unknownOption(currentId)];
  const label = companyBankAccountLabel(saved);
  return [...options, bankOption(saved, saved.status === 'retired' ? retiredLabel(label) : label)];
}

/**
 * The expense accounts a bill line may be booked to: active rows, plus the saved `currentId` when it is not
 * among them, labelled "(retired)" or "Unknown account" as for bank accounts.
 */
export function expenseAccountOptions(
  accounts: readonly ExpenseAccount[],
  { currentId }: { currentId?: string | null | undefined } = {},
): ComboboxOption[] {
  const options = accounts
    .filter((account) => account.status === 'active')
    .map((account) => expenseOption(account, expenseAccountLabel(account)));
  if (!hasValue(currentId) || options.some((option) => option.id === currentId)) return options;
  const saved = accounts.find((account) => account.id === currentId);
  if (saved === undefined) return [...options, unknownOption(currentId)];
  const label = expenseAccountLabel(saved);
  return [
    ...options,
    expenseOption(saved, saved.status === 'retired' ? retiredLabel(label) : label),
  ];
}

/**
 * The label for a saved id on a read-only view (a bill, a payment request): the row's label whether active or
 * retired, or "Unknown account" when no row matches. Never the raw id.
 */
export function accountLabel(
  kind: 'bank',
  id: string,
  accounts: readonly CompanyBankAccount[],
): string;
export function accountLabel(
  kind: 'expense',
  id: string,
  accounts: readonly ExpenseAccount[],
): string;
export function accountLabel(
  kind: CompanyAccountKind,
  id: string,
  accounts: readonly CompanyBankAccount[] | readonly ExpenseAccount[],
): string {
  if (kind === 'bank') {
    const found = (accounts as readonly CompanyBankAccount[]).find((account) => account.id === id);
    return found === undefined ? UNKNOWN_ACCOUNT_LABEL : companyBankAccountLabel(found);
  }
  const found = (accounts as readonly ExpenseAccount[]).find((account) => account.id === id);
  return found === undefined ? UNKNOWN_ACCOUNT_LABEL : expenseAccountLabel(found);
}
