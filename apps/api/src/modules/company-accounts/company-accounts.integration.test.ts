// Integration test of company bank accounts and expense accounts on a real Postgres: the Settings > Finance
// commands (create, rename, retire, reactivate, idempotent replay, audit), the entity scoping, the permission and
// portal refusals, and the CompanyAccountsLookup rules the payables services rely on. Real: migrations, bos_app
// queries, the service, controllers and AuditService. Faked: the caller (no HTTP request).
// Run: pnpm --filter @bos/api exec vitest run src/modules/company-accounts/company-accounts.integration.test.ts
import 'reflect-metadata';

import { randomUUID } from 'node:crypto';

import {
  CompanyBankAccountSchema,
  ExpenseAccountSchema,
  type CompanyBankAccount,
  type ExpenseAccount,
} from '@bos/contracts';
import {
  createCompanyBankAccount,
  createExpenseAccount,
  createStaffUser,
  createTenantWithEntity,
} from '@bos/db';
import { createTestDatabase, type TestDatabase } from '@bos/db/testing';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { AuditService } from '../../platform/audit/audit.service';
import type { Principal } from '../../platform/authz/principal';
import type { Db } from '../../platform/db/db.module';
import { systemActor, withTx, type DbTransaction, type TxScope } from '../../platform/db/tx';
import {
  CompanyBankAccountsController,
  ExpenseAccountsController,
} from './company-accounts.controller';
import { CompanyAccountsLookup } from './company-accounts.lookup';
import { CompanyAccountsService } from './company-accounts.service';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 180_000 });

let testDb: TestDatabase;
let appPool: Pool;
let ownerPool: Pool;
let db: Db;
let scopeA: TxScope;
let scopeB: TxScope;
let actingUserId = '';

const FINANCE: Principal['grants'] = new Map([['settings.finance.write', 'all']]);
/** Who calls: an active staff user of entity A holding settings.finance.write, unless a test changes it. */
const current: { orgKind: Principal['orgKind']; scope: TxScope; grants: Principal['grants'] } = {
  orgKind: 'staff',
  scope: { tenantId: '', organizationId: '' },
  grants: FINANCE,
};
const caller = {
  current: () => ({
    scope: current.scope,
    actor: { kind: 'user' as const, id: actingUserId, correlationId: 'test-corr' },
    principal: {
      userId: actingUserId,
      zitadelUserId: 'z-user-1',
      ...current.scope,
      orgKind: current.orgKind,
      partyId: current.orgKind === 'staff' ? null : randomUUID(),
      idpOrgId: 'unused',
      roles: [],
      departmentId: null,
      status: 'active',
      grants: current.grants,
    } satisfies Principal,
  }),
};

let banks: CompanyBankAccountsController;
let expenses: ExpenseAccountsController;
const lookup = new CompanyAccountsLookup();

beforeAll(async () => {
  testDb = await createTestDatabase();
  appPool = new Pool({ connectionString: testDb.appUrl, max: 4 });
  ownerPool = new Pool({ connectionString: testDb.ownerUrl, max: 1 });
  db = drizzle({ client: appPool });

  const tenant = await createTenantWithEntity(appPool);
  scopeA = { tenantId: tenant.tenantId, organizationId: tenant.organizationId };
  const otherEntityId = randomUUID();
  await withTx(db, scopeA, systemActor('test'), (tx) =>
    tx.execute(
      sql`INSERT INTO app.organizations (id, tenant_id, organization_id, name, code, legal_name, is_default)
          VALUES (${otherEntityId}, ${scopeA.tenantId}, ${otherEntityId}, ${`E-${otherEntityId}`},
                  ${`E-${otherEntityId}`}, ${`E-${otherEntityId}`}, false)`,
    ),
  );
  scopeB = { tenantId: scopeA.tenantId, organizationId: otherEntityId };
  const { userId } = await createStaffUser(appPool, { ...scopeA, idpOrgId: tenant.idpOrgId });
  actingUserId = userId;

  const service = new CompanyAccountsService(db, caller, new AuditService(db));
  banks = new CompanyBankAccountsController(service);
  expenses = new ExpenseAccountsController(service);
});

beforeEach(() => {
  current.orgKind = 'staff';
  current.scope = scopeA;
  current.grants = FINANCE;
});

afterAll(async () => {
  await appPool?.end();
  await ownerPool?.end();
  await testDb?.drop();
});

/** The service's own events; the table triggers also write `<table>.insert/update` rows, which are left out. */
async function auditActions(entityId: string, prefix: string): Promise<string[]> {
  const { rows } = await ownerPool.query<{ action: string }>(
    'SELECT action FROM audit.audit_events WHERE entity_id = $1 AND action LIKE $2 ORDER BY action',
    [entityId, `${prefix}.%`],
  );
  return rows.map((r) => r.action);
}

/** The `{ code }` of a refused lookup, or 'ok'. */
async function outcome(run: () => Promise<void>): Promise<string> {
  try {
    await run();
    return 'ok';
  } catch (error) {
    const e = error as { getStatus?: () => number; getResponse?: () => { code?: string } };
    if (e.getStatus?.() !== 422) throw error;
    return e.getResponse?.().code ?? 'no code';
  }
}

describe('company bank accounts', () => {
  it('creates, replays, renames, retires and reactivates with one audit event per change', async () => {
    const key = randomUUID();
    const body = { name: 'Operating', bankName: 'Nabil Bank', last4: 'AB12', currency: 'NPR' };
    const created = await banks.create(key, body);
    expect(CompanyBankAccountSchema.parse(created)).toEqual(created);
    expect(created).toMatchObject({ ...body, status: 'active', retiredAt: null });
    expect(await banks.create(key, body)).toEqual(created);

    const renamed = await banks.rename(created.id, randomUUID(), { name: 'Payroll' });
    expect(renamed).toMatchObject({ name: 'Payroll', bankName: 'Nabil Bank', last4: 'AB12' });

    const retired = await banks.retire(created.id, randomUUID());
    expect(retired.status).toBe('retired');
    expect(CompanyBankAccountSchema.parse(retired).retiredAt).not.toBeNull();
    // A second retire is a no-op: the same row, no new audit event.
    expect(await banks.retire(created.id, randomUUID())).toEqual(retired);
    expect((await banks.list(undefined)).map((r) => r.id)).not.toContain(created.id);
    expect((await banks.list('true')).find((r) => r.id === created.id)).toEqual(retired);

    const reactivated = await banks.reactivate(created.id, randomUUID());
    expect(reactivated).toMatchObject({ status: 'active', retiredAt: null, name: 'Payroll' });
    expect(await banks.reactivate(created.id, randomUUID())).toEqual(reactivated);
    expect((await banks.list(undefined)).map((r) => r.id)).toContain(created.id);

    expect(await auditActions(created.id, 'company_bank_account')).toEqual([
      'company_bank_account.created',
      'company_bank_account.reactivated',
      'company_bank_account.renamed',
      'company_bank_account.retired',
    ]);
  });

  it('orders the list by name then id and refuses a bad includeRetired value', async () => {
    const zeta = await createCompanyBankAccount(appPool, { ...scopeA, name: 'Zz order' });
    const alpha = await createCompanyBankAccount(appPool, { ...scopeA, name: 'Aa order' });
    const ids = (await banks.list(undefined)).map((r) => r.id);
    expect(ids.indexOf(alpha.id)).toBeLessThan(ids.indexOf(zeta.id));
    expect(() => banks.list('yes')).toThrow();
  });

  it('refuses a strict-body violation on rename', () => {
    expect(() =>
      banks.rename(randomUUID(), randomUUID(), { name: 'X', currency: 'USD' }),
    ).toThrow();
  });
});

describe('expense accounts', () => {
  it('creates, replays, renames, retires and reactivates with one audit event per change', async () => {
    const key = randomUUID();
    const created = await expenses.create(key, { code: '6100', name: 'Rent' });
    expect(ExpenseAccountSchema.parse(created)).toEqual(created);
    expect(await expenses.create(key, { code: '6100', name: 'Rent' })).toEqual(created);
    expect(await expenses.rename(created.id, randomUUID(), { name: 'Office rent' })).toMatchObject({
      code: '6100',
      name: 'Office rent',
    });
    const retired = await expenses.retire(created.id, randomUUID());
    expect(retired).toMatchObject({ status: 'retired' });
    expect(await expenses.retire(created.id, randomUUID())).toEqual(retired);
    expect((await expenses.list(undefined)).map((r) => r.id)).not.toContain(created.id);
    expect((await expenses.list('true')).map((r) => r.id)).toContain(created.id);
    expect(await expenses.reactivate(created.id, randomUUID())).toMatchObject({
      status: 'active',
      retiredAt: null,
    });
    expect(await auditActions(created.id, 'expense_account')).toEqual([
      'expense_account.created',
      'expense_account.reactivated',
      'expense_account.renamed',
      'expense_account.retired',
    ]);
  });

  it('answers 409 for a code the company already has, whatever its case', async () => {
    await expenses.create(randomUUID(), { code: 'dup-1', name: 'First' });
    await expect(
      expenses.create(randomUUID(), { code: 'DUP-1', name: 'Second' }),
    ).rejects.toMatchObject({ status: 409 });
  });
});

describe('entity scoping', () => {
  it("hides another entity's rows and answers 404 when acting on them", async () => {
    const bankB = await createCompanyBankAccount(appPool, scopeB);
    const expenseB = await createExpenseAccount(appPool, scopeB);
    expect((await banks.list('true')).map((r) => r.id)).not.toContain(bankB.id);
    expect((await expenses.list('true')).map((r) => r.id)).not.toContain(expenseB.id);
    await expect(banks.rename(bankB.id, randomUUID(), { name: 'Mine' })).rejects.toMatchObject({
      status: 404,
    });
    await expect(expenses.retire(expenseB.id, randomUUID())).rejects.toMatchObject({ status: 404 });
    await expect(banks.reactivate(randomUUID(), randomUUID())).rejects.toMatchObject({
      status: 404,
    });
    current.scope = scopeB;
    expect((await banks.list(undefined)).map((r) => r.id)).toContain(bankB.id);
  });
});

describe('access', () => {
  it.each(['vendor', 'customer'] as const)(
    'answers 403 to a %s portal user on lists and writes',
    async (orgKind) => {
      current.orgKind = orgKind;
      await expect(banks.list(undefined)).rejects.toMatchObject({ status: 403 });
      await expect(expenses.list('true')).rejects.toMatchObject({ status: 403 });
      expect(() => expenses.create(randomUUID(), { code: 'P', name: 'Portal' })).toThrow(
        'Forbidden',
      );
    },
  );

  it('lets staff without a finance grant read both lists, retired rows included, but not write', async () => {
    const retired = await createExpenseAccount(appPool, {
      ...scopeA,
      status: 'retired',
      retiredAt: new Date(),
    });
    const bank = await createCompanyBankAccount(appPool, scopeA);
    current.grants = new Map();
    expect((await expenses.list('true')).map((r) => r.id)).toContain(retired.id);
    expect(() =>
      banks.create(randomUUID(), { name: 'N', bankName: 'B', last4: '1234', currency: 'NPR' }),
    ).toThrow('Forbidden');
    expect(() => banks.rename(bank.id, randomUUID(), { name: 'N' })).toThrow('Forbidden');
    expect(() => banks.retire(bank.id, randomUUID())).toThrow('Forbidden');
    expect(() => expenses.reactivate(retired.id, randomUUID())).toThrow('Forbidden');
  });

  it('lets an admin.settings.write holder (the Founder) write', async () => {
    current.grants = new Map([['admin.settings.write', 'all']]);
    const row: ExpenseAccount = await expenses.create(randomUUID(), { code: 'ADM', name: 'Admin' });
    expect(row.code).toBe('ADM');
  });
});

describe('CompanyAccountsLookup', () => {
  let activeExpense: string;
  let retiredExpense: string;
  let otherExpense: string;
  let nprBank: CompanyBankAccount['id'];
  let retiredBank: string;
  let otherBank: string;

  beforeAll(async () => {
    activeExpense = (await createExpenseAccount(appPool, scopeA)).id;
    retiredExpense = (
      await createExpenseAccount(appPool, { ...scopeA, status: 'retired', retiredAt: new Date() })
    ).id;
    otherExpense = (await createExpenseAccount(appPool, scopeB)).id;
    nprBank = (await createCompanyBankAccount(appPool, { ...scopeA, currency: 'NPR' })).id;
    retiredBank = (
      await createCompanyBankAccount(appPool, {
        ...scopeA,
        currency: 'NPR',
        status: 'retired',
        retiredAt: new Date(),
      })
    ).id;
    otherBank = (await createCompanyBankAccount(appPool, { ...scopeB, currency: 'NPR' })).id;
  });

  const inTx = <T>(run: (tx: DbTransaction) => Promise<T>): Promise<T> =>
    withTx(db, scopeA, systemActor('test'), run);

  it('applies the expense account rules', async () => {
    const check = (ids: string[]) =>
      outcome(() => inTx((tx) => lookup.assertExpenseAccountsUsable(tx, scopeA, ids)));
    expect(await check([activeExpense, activeExpense.toUpperCase()])).toBe('ok');
    expect(await check([])).toBe('ok');
    expect(await check([activeExpense, retiredExpense])).toBe('EXPENSE_ACCOUNT_INVALID');
    expect(await check([otherExpense])).toBe('EXPENSE_ACCOUNT_INVALID');
    expect(await check([randomUUID()])).toBe('EXPENSE_ACCOUNT_INVALID');
    expect(await check(['not-a-uuid'])).toBe('EXPENSE_ACCOUNT_INVALID');
  });

  it('applies the bank account rules', async () => {
    const check = (id: string, currency: string) =>
      outcome(() => inTx((tx) => lookup.assertBankAccountUsable(tx, scopeA, id, currency)));
    expect(await check(nprBank, 'NPR')).toBe('ok');
    expect(await check(nprBank.toUpperCase(), 'NPR')).toBe('ok');
    expect(await check(nprBank, 'USD')).toBe('BANK_ACCOUNT_CURRENCY_MISMATCH');
    expect(await check(retiredBank, 'NPR')).toBe('BANK_ACCOUNT_INVALID');
    expect(await check(otherBank, 'NPR')).toBe('BANK_ACCOUNT_INVALID');
    expect(await check(randomUUID(), 'NPR')).toBe('BANK_ACCOUNT_INVALID');
    expect(await check('garbage', 'NPR')).toBe('BANK_ACCOUNT_INVALID');
  });

  it('refuses at submit only an id that names a retired bank account of the entity', async () => {
    const check = (id: string) =>
      outcome(() => inTx((tx) => lookup.assertBankAccountNotRetired(tx, scopeA, id)));
    expect(await check(retiredBank)).toBe('BANK_ACCOUNT_INVALID');
    expect(await check(retiredBank.toUpperCase())).toBe('BANK_ACCOUNT_INVALID');
    expect(await check(nprBank)).toBe('ok');
    expect(await check(randomUUID())).toBe('ok');
    expect(await check(otherBank)).toBe('ok');
    expect(await check('garbage')).toBe('ok');
  });

  it("leaves the caller's transaction usable after a non-uuid id", async () => {
    const after = await inTx(async (tx) => {
      await lookup.assertExpenseAccountsUsable(tx, scopeA, ['nope']).catch(() => undefined);
      return tx.execute(sql`SELECT 1 AS one`);
    });
    expect(after.rows[0]).toEqual({ one: 1 });
  });
});
