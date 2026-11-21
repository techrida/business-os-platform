// The check bills and payment requests run on the accounts they name (round 5, unit P1). It runs inside the
// caller's transaction and takes the scope as an argument, so it has no request-scoped dependency and any module
// that imports CompanyAccountsModule can inject it.
import type { CompanyAccountStatus } from '@bos/contracts';
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
  retiredBankAccountViolation,
  type AccountRuleViolation,
} from './company-accounts.rules';

/** Same body as the payables services send for a 422: `{ code, message }`. */
const unprocessable = (violation: AccountRuleViolation) =>
  new UnprocessableEntityException({ code: violation.code, message: violation.message });

@Injectable()
export class CompanyAccountsLookup {
  /** Returns when every id is an active expense account of the scope's entity; else 422 EXPENSE_ACCOUNT_INVALID. */
  async assertExpenseAccountsUsable(
    tx: DbTransaction,
    scope: TxScope,
    ids: readonly string[],
  ): Promise<void> {
    const checked = idsToCheck(ids);
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
   * Returns when `id` is an active bank account of the scope's entity holding `currency`; else 422
   * BANK_ACCOUNT_INVALID or BANK_ACCOUNT_CURRENCY_MISMATCH.
   */
  async assertBankAccountUsable(
    tx: DbTransaction,
    scope: TxScope,
    id: string,
    currency: string,
  ): Promise<void> {
    const found = await this.bankAccountRow(tx, scope, id);
    const violation = bankAccountViolation(found, currency);
    if (violation) throw unprocessable(violation);
  }

  /**
   * Returns unless `id` names a retired bank account of the scope's entity; then 422 BANK_ACCOUNT_INVALID. For a
   * draft's submit: an id that matches no row (a draft made before the account list) still passes.
   */
  async assertBankAccountNotRetired(tx: DbTransaction, scope: TxScope, id: string): Promise<void> {
    const violation = retiredBankAccountViolation(await this.bankAccountRow(tx, scope, id));
    if (violation) throw unprocessable(violation);
  }

  /** The entity's row for `id`, if any. FOR SHARE so a retire committed before the caller's commit waits. */
  private async bankAccountRow(
    tx: DbTransaction,
    scope: TxScope,
    id: string,
  ): Promise<{ status: CompanyAccountStatus; currency: string } | undefined> {
    const key = normalizeAccountId(id);
    if (!isAccountId(key)) return undefined;
    const [found] = await tx
      .select({ status: companyBankAccounts.status, currency: companyBankAccounts.currency })
      .from(companyBankAccounts)
      .where(
        and(
          eq(companyBankAccounts.tenantId, scope.tenantId),
          eq(companyBankAccounts.organizationId, scope.organizationId),
          eq(companyBankAccounts.id, key),
        ),
      )
      .for('share');
    return found;
  }
}
