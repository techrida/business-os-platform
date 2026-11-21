// The check bills and payment requests run on the accounts they name (round 5, unit P1). It runs inside the
// caller's transaction and takes the scope as an argument, so it has no request-scoped dependency and any module
// that imports CompanyAccountsModule can inject it.
import { companyBankAccounts, expenseAccounts } from '@bos/db';
import { Injectable, UnprocessableEntityException } from '@nestjs/common';
import { and, eq, inArray } from 'drizzle-orm';

import type { DbTransaction, TxScope } from '../../platform/db/tx';
import {
  bankAccountViolation,
  expenseAccountsViolation,
  idsToCheck,
  isAccountId,
  normalizeAccountId,
  type AccountRuleViolation,
} from './company-accounts.rules';

/** Same body as the payables services send for a 422: `{ code, message }`. */
const unprocessable = (violation: AccountRuleViolation) =>
  new UnprocessableEntityException({ code: violation.code, message: violation.message });

@Injectable()
export class CompanyAccountsLookup {
  /**
   * Returns when every id not in `unchanged` is an active expense account of the scope's entity; else 422
   * EXPENSE_ACCOUNT_INVALID. `unchanged` lets an edit keep a line whose account has been retired since it was saved.
   */
  async assertExpenseAccountsUsable(
    tx: DbTransaction,
    scope: TxScope,
    ids: readonly string[],
    unchanged?: ReadonlySet<string>,
  ): Promise<void> {
    const checked = idsToCheck(ids, unchanged);
    if (checked.length === 0) return;
    const queryable = checked.filter(isAccountId);
    // FOR SHARE so a retire committed between this check and the caller's commit waits instead of slipping past.
    const found =
      queryable.length === 0
        ? []
        : await tx
            .select({ id: expenseAccounts.id, status: expenseAccounts.status })
            .from(expenseAccounts)
            .where(
              and(
                eq(expenseAccounts.tenantId, scope.tenantId),
                eq(expenseAccounts.organizationId, scope.organizationId),
                inArray(expenseAccounts.id, queryable),
              ),
            )
            .for('share');
    const violation = expenseAccountsViolation(checked, found);
    if (violation) throw unprocessable(violation);
  }

  /**
   * Returns when `unchanged` is true, or when `id` is an active bank account of the scope's entity holding
   * `currency`; else 422 BANK_ACCOUNT_INVALID or BANK_ACCOUNT_CURRENCY_MISMATCH.
   */
  async assertBankAccountUsable(
    tx: DbTransaction,
    scope: TxScope,
    id: string,
    currency: string,
    unchanged?: boolean,
  ): Promise<void> {
    if (unchanged) return;
    const key = normalizeAccountId(id);
    const [found] = isAccountId(key)
      ? await tx
          .select({ status: companyBankAccounts.status, currency: companyBankAccounts.currency })
          .from(companyBankAccounts)
          .where(
            and(
              eq(companyBankAccounts.tenantId, scope.tenantId),
              eq(companyBankAccounts.organizationId, scope.organizationId),
              eq(companyBankAccounts.id, key),
            ),
          )
          .for('share')
      : [];
    const violation = bankAccountViolation(found, currency);
    if (violation) throw unprocessable(violation);
  }
}
