// The pure rules behind CompanyAccountsLookup and the row-to-DTO mapping of both lists (round 5, unit P1). Kept
// free of Nest and the database so the rules a bill or payment request is checked against are unit-tested alone.
import type { CompanyAccountStatus, CompanyBankAccount, ExpenseAccount } from '@bos/contracts';
import type { companyBankAccounts, expenseAccounts } from '@bos/db';

/** What a refused account choice answers with (422): a stable code and a sentence the form can show. */
export interface AccountRuleViolation {
  code: 'EXPENSE_ACCOUNT_INVALID' | 'BANK_ACCOUNT_INVALID' | 'BANK_ACCOUNT_CURRENCY_MISMATCH';
  message: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Ids are compared as lowercase text: Postgres returns uuids lowercase, a client may send them uppercase. */
export const normalizeAccountId = (id: string): string => id.toLowerCase();

/**
 * True when the id can be sent to a uuid column. Anything else is answered as an unknown account, because a cast
 * error inside the caller's transaction would abort it and surface as a 500.
 */
export const isAccountId = (id: string): boolean => UUID.test(id);

/** The distinct lowercase ids to check, in first-seen order. */
export function idsToCheck(ids: readonly string[]): string[] {
  return [...new Set(ids.map(normalizeAccountId))];
}

/** Null when every checked id is an active expense account of the entity (`found` is already entity-scoped). */
export function expenseAccountsViolation(
  checked: readonly string[],
  found: readonly { id: string; status: CompanyAccountStatus }[],
): AccountRuleViolation | null {
  const active = new Set(
    found.filter((row) => row.status === 'active').map((row) => normalizeAccountId(row.id)),
  );
  return checked.every((id) => active.has(id))
    ? null
    : {
        code: 'EXPENSE_ACCOUNT_INVALID',
        message: 'Choose an active expense account for every line',
      };
}

/** Null when `found` (the entity's row for the id, if any) is active and holds the document's currency. */
export function bankAccountViolation(
  found: { status: CompanyAccountStatus; currency: string } | undefined,
  currency: string,
): AccountRuleViolation | null {
  if (!found || found.status !== 'active')
    return {
      code: 'BANK_ACCOUNT_INVALID',
      message: 'Choose an active bank account of this company',
    };
  if (found.currency !== currency)
    return {
      code: 'BANK_ACCOUNT_CURRENCY_MISMATCH',
      message: `This bank account holds ${found.currency}, but the payment is in ${currency}`,
    };
  return null;
}

/**
 * Null unless `found` (the entity's row for a draft's paying account, if any) is retired. A draft whose id names no
 * row at all predates the account list and is left alone; only a row retired since the draft was made is refused.
 */
export function retiredBankAccountViolation(
  found: { status: CompanyAccountStatus } | undefined,
): AccountRuleViolation | null {
  return found?.status === 'retired'
    ? {
        code: 'BANK_ACCOUNT_INVALID',
        message: 'This bank account was retired. Create a new request from an active account.',
      }
    : null;
}

/** ISO text, not a Date: an idempotent replay returns the stored JSON, so the first answer must match it. */
const iso = (at: Date | null): string | null => (at ? at.toISOString() : null);

export function bankAccountDto(row: typeof companyBankAccounts.$inferSelect): CompanyBankAccount {
  return {
    id: row.id,
    name: row.name,
    bankName: row.bankName,
    last4: row.last4,
    currency: row.currency as CompanyBankAccount['currency'],
    status: row.status,
    retiredAt: iso(row.retiredAt),
  };
}

export function expenseAccountDto(row: typeof expenseAccounts.$inferSelect): ExpenseAccount {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    status: row.status,
    retiredAt: iso(row.retiredAt),
  };
}
