// Settings > Finance > Bank and expense accounts (round 5, unit P1): list, add, rename, retire and reactivate the
// entity's own bank accounts and its expense accounts. Rows are never deleted (a trigger refuses it) and bank,
// last four, currency and code never change (also a trigger), so the only edits are the name and the status.
import type {
  CompanyBankAccount,
  CreateCompanyBankAccountBody,
  CreateExpenseAccountBody,
  ExpenseAccount,
} from '@bos/contracts';
import { companyBankAccounts, expenseAccounts, scoped } from '@bos/db';
import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { asc, eq } from 'drizzle-orm';

import { AuditService } from '../../platform/audit/audit.service';
import { can } from '../../platform/authz/can';
import { DB, type Db } from '../../platform/db/db.module';
import { withIdempotency } from '../../platform/db/idempotency';
import { withTx, type DbTransaction, type TxScope } from '../../platform/db/tx';
import { FINANCE_SETTINGS_EDITORS } from '../../platform/settings/settings-access';
import { CompanyAccountsCaller } from './company-accounts.caller';
import { bankAccountDto, expenseAccountDto } from './company-accounts.rules';

type Status = 'active' | 'retired';

const forbidden = (reason: 'no_permission' | 'inactive_user') =>
  new ForbiddenException({ code: 'forbidden', message: 'Forbidden', reason });

@Injectable()
export class CompanyAccountsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly caller: CompanyAccountsCaller,
    private readonly audit: AuditService,
  ) {}

  /**
   * 403 unless the caller is active staff holding settings.finance.write (Finance, Accountant) or
   * admin.settings.write (the Founder): the same people the workspace shows Settings > Finance to.
   */
  assertEditor(): { scope: TxScope; actor: ReturnType<CompanyAccountsCaller['current']>['actor'] } {
    const { principal, scope, actor } = this.caller.current();
    if (principal.orgKind !== 'staff') throw forbidden('no_permission');
    if (principal.status !== 'active') throw forbidden('inactive_user');
    if (!FINANCE_SETTINGS_EDITORS.some((action) => can(principal, action).allowed))
      throw forbidden('no_permission');
    return { scope, actor };
  }

  // -------------------------------------------------------------------------------------------
  // Bank accounts
  // -------------------------------------------------------------------------------------------

  /** Active rows of the acting entity by name then id; `includeRetired` adds retired ones for document labels. */
  async listBankAccounts(includeRetired: boolean): Promise<CompanyBankAccount[]> {
    const scope = this.readerScope();
    const t = companyBankAccounts;
    const rows = await this.db
      .select()
      .from(t)
      .where(
        includeRetired ? scoped(scope).where(t) : scoped(scope).where(t, eq(t.status, 'active')),
      )
      .orderBy(asc(t.name), asc(t.id));
    return rows.map(bankAccountDto);
  }

  createBankAccount(body: CreateCompanyBankAccountBody, key: string): Promise<CompanyBankAccount> {
    return this.command('company_bank_account.create', key, null, body, 201, async (tx, scope) => {
      const [row] = await tx
        .insert(companyBankAccounts)
        .values({ ...scope, ...body })
        .returning();
      const result = bankAccountDto(row!);
      await this.audit.record(tx, {
        action: 'company_bank_account.created',
        entityType: 'company_bank_accounts',
        entityId: row!.id,
        after: result,
      });
      return result;
    });
  }

  renameBankAccount(id: string, name: string, key: string): Promise<CompanyBankAccount> {
    return this.command(
      'company_bank_account.rename',
      key,
      id,
      { name },
      200,
      async (tx, scope) => {
        const t = companyBankAccounts;
        const where = scoped(scope).where(t, eq(t.id, id));
        const before = await this.lockBank(tx, where);
        const [row] = await tx
          .update(t)
          .set({ name, updatedAt: new Date() })
          .where(where)
          .returning();
        const result = bankAccountDto(row!);
        await this.audit.record(tx, {
          action: 'company_bank_account.renamed',
          entityType: 'company_bank_accounts',
          entityId: id,
          before: bankAccountDto(before),
          after: result,
        });
        return result;
      },
    );
  }

  setBankAccountStatus(id: string, status: Status, key: string): Promise<CompanyBankAccount> {
    const verb = status === 'retired' ? 'retire' : 'reactivate';
    return this.command(`company_bank_account.${verb}`, key, id, {}, 200, async (tx, scope) => {
      const t = companyBankAccounts;
      const where = scoped(scope).where(t, eq(t.id, id));
      const before = await this.lockBank(tx, where);
      // Already there: answer the row unchanged and write no audit event, so a second click is harmless.
      if (before.status === status) return bankAccountDto(before);
      const [row] = await tx.update(t).set(statusChange(status)).where(where).returning();
      const result = bankAccountDto(row!);
      await this.audit.record(tx, {
        action: `company_bank_account.${status === 'retired' ? 'retired' : 'reactivated'}`,
        entityType: 'company_bank_accounts',
        entityId: id,
        before: bankAccountDto(before),
        after: result,
      });
      return result;
    });
  }

  // -------------------------------------------------------------------------------------------
  // Expense accounts
  // -------------------------------------------------------------------------------------------

  async listExpenseAccounts(includeRetired: boolean): Promise<ExpenseAccount[]> {
    const scope = this.readerScope();
    const t = expenseAccounts;
    const rows = await this.db
      .select()
      .from(t)
      .where(
        includeRetired ? scoped(scope).where(t) : scoped(scope).where(t, eq(t.status, 'active')),
      )
      .orderBy(asc(t.name), asc(t.id));
    return rows.map(expenseAccountDto);
  }

  async createExpenseAccount(body: CreateExpenseAccountBody, key: string): Promise<ExpenseAccount> {
    try {
      return await this.command(
        'expense_account.create',
        key,
        null,
        body,
        201,
        async (tx, scope) => {
          const [row] = await tx
            .insert(expenseAccounts)
            .values({ ...scope, ...body })
            .returning();
          const result = expenseAccountDto(row!);
          await this.audit.record(tx, {
            action: 'expense_account.created',
            entityType: 'expense_accounts',
            entityId: row!.id,
            after: result,
          });
          return result;
        },
      );
    } catch (error) {
      const pg = (error as { cause?: { code?: string; constraint?: string } }).cause;
      if (pg?.code === '23505' && pg.constraint === 'expense_accounts_tenant_org_code_unique')
        throw new ConflictException({
          code: 'conflict',
          message: 'This expense account code already exists in this company',
        });
      throw error;
    }
  }

  renameExpenseAccount(id: string, name: string, key: string): Promise<ExpenseAccount> {
    return this.command('expense_account.rename', key, id, { name }, 200, async (tx, scope) => {
      const t = expenseAccounts;
      const where = scoped(scope).where(t, eq(t.id, id));
      const before = await this.lockExpense(tx, where);
      const [row] = await tx
        .update(t)
        .set({ name, updatedAt: new Date() })
        .where(where)
        .returning();
      const result = expenseAccountDto(row!);
      await this.audit.record(tx, {
        action: 'expense_account.renamed',
        entityType: 'expense_accounts',
        entityId: id,
        before: expenseAccountDto(before),
        after: result,
      });
      return result;
    });
  }

  setExpenseAccountStatus(id: string, status: Status, key: string): Promise<ExpenseAccount> {
    const verb = status === 'retired' ? 'retire' : 'reactivate';
    return this.command(`expense_account.${verb}`, key, id, {}, 200, async (tx, scope) => {
      const t = expenseAccounts;
      const where = scoped(scope).where(t, eq(t.id, id));
      const before = await this.lockExpense(tx, where);
      if (before.status === status) return expenseAccountDto(before);
      const [row] = await tx.update(t).set(statusChange(status)).where(where).returning();
      const result = expenseAccountDto(row!);
      await this.audit.record(tx, {
        action: `expense_account.${status === 'retired' ? 'retired' : 'reactivated'}`,
        entityType: 'expense_accounts',
        entityId: id,
        before: expenseAccountDto(before),
        after: result,
      });
      return result;
    });
  }

  // -------------------------------------------------------------------------------------------

  /**
   * Any active staff user may read both lists, retired rows included: bills and payment requests they can open
   * name these accounts and must show a retired account's label. Portal users get 403, like cost centres.
   */
  private readerScope(): TxScope {
    const { principal, scope } = this.caller.current();
    if (principal.orgKind !== 'staff' || principal.status !== 'active')
      throw forbidden(principal.status === 'active' ? 'no_permission' : 'inactive_user');
    return scope;
  }

  /** One write: editor check, transaction, and the Idempotency-Key replay keyed to the entity and the row. */
  private command<T>(
    command: string,
    key: string,
    id: string | null,
    body: unknown,
    status: number,
    work: (tx: DbTransaction, scope: TxScope) => Promise<T>,
  ): Promise<T> {
    const { scope, actor } = this.assertEditor();
    return withTx(this.db, scope, actor, async (tx) => {
      const done = await withIdempotency(
        tx,
        { command, key, body: { id, body, organizationId: scope.organizationId } },
        async () => ({ status, response: await work(tx, scope) }),
      );
      return done.response;
    });
  }

  private async lockBank(tx: DbTransaction, where: ReturnType<ReturnType<typeof scoped>['where']>) {
    const [row] = await tx.select().from(companyBankAccounts).where(where).for('update');
    if (!row) throw new NotFoundException({ code: 'not_found', message: 'Bank account not found' });
    return row;
  }

  private async lockExpense(
    tx: DbTransaction,
    where: ReturnType<ReturnType<typeof scoped>['where']>,
  ) {
    const [row] = await tx.select().from(expenseAccounts).where(where).for('update');
    if (!row)
      throw new NotFoundException({ code: 'not_found', message: 'Expense account not found' });
    return row;
  }
}

/** Status and retired_at move together (a check constraint ties them); updated_at has no trigger, so set it here. */
function statusChange(status: Status) {
  const now = new Date();
  return { status, retiredAt: status === 'retired' ? now : null, updatedAt: now };
}
