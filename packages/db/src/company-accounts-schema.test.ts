// 0143_company_bank_accounts and 0144_expense_accounts (round 5, unit P1), with src/schema/company-accounts.ts.
// Run with: pnpm --filter @bos/db exec vitest run src/company-accounts-schema.test.ts
//
// What must hold:
//   * the Drizzle tables describe the SQL (columns, keys, checks, indexes by name), and both tables are audited;
//   * checkTenancy() with its strict defaults and checkAudit() find nothing on the migrated schema;
//   * a row belongs to an entity of its own tenant (composite FK);
//   * a row is retired, never deleted, and status and retired_at agree;
//   * a bank account's bank, last four and currency, and an expense account's code, are fixed once written;
//   * an expense code is unique per entity, case-insensitively, and free in another entity;
//   * inserts and updates reach the audit trail.
// Setup mirrors vendors.test.ts: migrate as bos_owner, write as bos_app with the acting entity set per transaction.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { getTableConfig, type PgTable } from 'drizzle-orm/pg-core';
import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { checkAudit } from './check-audit.js';
import { checkTenancy, describeViolations } from './check-tenancy.js';
import {
  COMPANY_ACCOUNT_STATUSES,
  companyBankAccounts,
  expenseAccounts,
} from './schema/company-accounts.js';
import {
  createCompanyBankAccount,
  createExpenseAccount,
  createTenantWithEntity,
} from './testing/fixtures.js';
import { createTestDatabase, type TestDatabase } from './testing/test-database.js';

const SQL_TEXT = ['0143_company_bank_accounts', '0144_expense_accounts']
  .map((name) => readFileSync(new URL(`../migrations/${name}.sql`, import.meta.url), 'utf8'))
  .join('\n');

const DRIZZLE: Record<string, PgTable> = {
  company_bank_accounts: companyBankAccounts,
  expense_accounts: expenseAccounts,
};

interface Shape {
  columns: string[];
  constraints: string[];
  indexes: string[];
}

/** An index column list as one comparable string; an expression such as lower("code") becomes (sql). */
const indexColumns = (list: string[]) =>
  list.map((c) => (c.includes('(') ? '(sql)' : c.replaceAll('"', '').trim())).join(',');

function parseSql(text: string): Map<string, Shape> {
  const tables = new Map<string, Shape>();
  for (const block of text.matchAll(/CREATE TABLE "app"\."(\w+)" \(\n([\s\S]*?)\n\);/g)) {
    const shape: Shape = { columns: [], constraints: [], indexes: [] };
    for (const line of (block[2] ?? '').split('\n')) {
      const constraint = /^\s*CONSTRAINT "(\w+)" /.exec(line);
      if (constraint) shape.constraints.push(constraint[1] ?? '');
      else {
        const column = /^\s*"(\w+)" /.exec(line);
        if (column) shape.columns.push(column[1] ?? '');
      }
    }
    tables.set(block[1] ?? '', shape);
  }
  for (const m of text.matchAll(
    /CREATE (?:UNIQUE )?INDEX "(\w+)" ON "app"\."(\w+)" USING btree \((.*)\);$/gm,
  )) {
    // Split on top-level commas only, so lower("code") stays one column.
    const parts = (m[3] ?? '').split(/,(?![^(]*\))/);
    tables.get(m[2] ?? '')?.indexes.push(`${m[1] ?? ''} (${indexColumns(parts)})`);
  }
  return tables;
}

function drizzleShape(table: PgTable): Shape {
  const config = getTableConfig(table);
  return {
    columns: config.columns.map((c) => c.name),
    constraints: [
      ...config.foreignKeys.map((fk) => fk.getName()),
      ...config.uniqueConstraints.map((u) => u.getName() ?? '(unnamed)'),
      ...config.checks.map((c) => c.name),
    ],
    indexes: config.indexes.map(
      (i) =>
        `${i.config.name ?? '(unnamed)'} (${i.config.columns
          .map((c) => ('name' in c ? c.name : '(sql)'))
          .join(',')})`,
    ),
  };
}

const sorted = (s: Shape): Shape => ({
  columns: [...s.columns].sort(),
  constraints: [...s.constraints].sort(),
  indexes: [...s.indexes].sort(),
});

describe('0143/0144 and src/schema/company-accounts.ts', () => {
  const parsed = parseSql(SQL_TEXT);

  it('create the same two tables', () => {
    expect([...parsed.keys()].sort()).toEqual(Object.keys(DRIZZLE).sort());
  });

  it.each(Object.keys(DRIZZLE))('%s: same columns, constraints and indexes', (name) => {
    const table = DRIZZLE[name];
    if (table === undefined) throw new Error(`no Drizzle table for ${name}`);
    expect(getTableConfig(table).schema).toBe('app');
    // The primary key is inline in the SQL column line and not a named constraint on either side.
    const sqlShape = parsed.get(name) ?? { columns: [], constraints: [], indexes: [] };
    expect(sorted(drizzleShape(table))).toEqual(sorted(sqlShape));
  });

  it('audits both tables', () => {
    const attached = [...SQL_TEXT.matchAll(/SELECT audit\.attach\('app\.(\w+)'/g)].map((m) => m[1]);
    expect(attached.sort()).toEqual(Object.keys(DRIZZLE).sort());
  });

  it('keeps the status allow-lists equal to the exported catalogue', () => {
    for (const table of Object.keys(DRIZZLE)) {
      const m = new RegExp(
        String.raw`"${table}_status_check" CHECK \("status" in \(([^)]*)\)\)`,
      ).exec(SQL_TEXT);
      expect(m, table).not.toBeNull();
      const values = (m?.[1] ?? '').split(',').map((v) => v.trim().replaceAll("'", ''));
      expect(values).toEqual([...COMPANY_ACCOUNT_STATUSES]);
    }
  });

  it('gives the legacy GUID columns no foreign key to these tables', () => {
    expect(SQL_TEXT).not.toMatch(/REFERENCES "app"\."(company_bank_accounts|expense_accounts)"/);
  });
});

// ---------------------------------------------------------------------------------------------
// Against a migrated database
// ---------------------------------------------------------------------------------------------

let testDb: TestDatabase;
let owner: Pool;
let app: Pool;

interface Scope {
  tenantId: string;
  organizationId: string;
}

/** Runs fn in one transaction on `pool`, with the actor and acting entity set (like withTx). */
async function inTx<T>(pool: Pool, scope: Scope, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    for (const [key, value] of [
      ['bos.actor_kind', 'system'],
      ['bos.actor_id', 'system:company-accounts-test'],
      ['bos.correlation_id', `company-accounts-test:${randomUUID()}`],
      ['bos.tenant_id', scope.tenantId],
      ['bos.organization_id', scope.organizationId],
    ]) {
      await c.query('SELECT set_config($1, $2, true)', [key, value]);
    }
    const result = await fn(c);
    await c.query('COMMIT');
    return result;
  } catch (error) {
    await c.query('ROLLBACK');
    throw error;
  } finally {
    c.release();
  }
}

/** Like inTx on the owner pool, but always rolls back: for proving a guard by removing it. */
async function ownerRollback(scope: Scope, fn: (c: PoolClient) => Promise<void>): Promise<void> {
  const rollback = new Error('rollback');
  await expect(
    inTx(owner, scope, async (c) => {
      await fn(c);
      throw rollback;
    }),
  ).rejects.toBe(rollback);
}

async function newScope(): Promise<Scope> {
  const { tenantId, organizationId } = await createTenantWithEntity(app);
  return { tenantId, organizationId };
}

/** A second legal entity of `tenantId`. */
async function insertEntity(tenantId: string): Promise<string> {
  const id = randomUUID();
  await app.query(
    `INSERT INTO app.organizations (id, tenant_id, organization_id, name, code, legal_name, is_default)
     VALUES ($1, $2, $1, $3, $3, $3, false)`,
    [id, tenantId, `E-${id}`],
  );
  return id;
}

beforeAll(async () => {
  testDb = await createTestDatabase();
  const bosAdmin = new Pool({ connectionString: testDb.adminUrl, max: 1 });
  // The audit trigger refuses a write with no actor; plain app.query() calls get one from the role.
  for (const [key, value] of [
    ['bos.actor_kind', 'system'],
    ['bos.actor_id', 'system:company-accounts-test'],
    ['bos.correlation_id', 'company-accounts-test-0001'],
  ]) {
    await bosAdmin.query(`ALTER ROLE bos_app IN DATABASE ${testDb.name} SET ${key} = '${value}'`);
  }
  await bosAdmin.end();
  owner = new Pool({ connectionString: testDb.ownerUrl, max: 2 });
  app = new Pool({ connectionString: testDb.appUrl, max: 2 });
});

afterAll(async () => {
  await app?.end();
  await owner?.end();
  await testDb?.drop();
});

describe('company accounts on a migrated database', () => {
  it('passes checkTenancy() with the strict defaults', async () => {
    const violations = await checkTenancy(owner);
    expect(violations, describeViolations(violations)).toEqual([]);
  });

  it('passes checkAudit()', async () => {
    await expect(checkAudit(owner)).resolves.toEqual([]);
  });

  it('creates both through the fixtures, with the defaults the API relies on', async () => {
    const scope = await newScope();
    const bank = await createCompanyBankAccount(app, { ...scope, last4: 'AB12' });
    expect(bank).toMatchObject({
      ...scope,
      last4: 'AB12',
      currency: 'NPR',
      status: 'active',
      retiredAt: null,
    });
    const expense = await createExpenseAccount(app, { ...scope, code: '6100', name: 'Rent' });
    expect(expense).toMatchObject({ ...scope, code: '6100', status: 'active', retiredAt: null });
  });

  it("rejects a row that points at another tenant's entity", async () => {
    const scope = await newScope();
    const other = await newScope();
    await expect(
      createCompanyBankAccount(app, {
        tenantId: scope.tenantId,
        organizationId: other.organizationId,
      }),
    ).rejects.toMatchObject({ constraint: 'company_bank_accounts_tenant_org_fk' });
    await expect(
      createExpenseAccount(app, { tenantId: scope.tenantId, organizationId: other.organizationId }),
    ).rejects.toMatchObject({ constraint: 'expense_accounts_tenant_org_fk' });
  });

  it('rejects a last4 that is not four letters or digits', async () => {
    const scope = await newScope();
    for (const last4 of ['123', '12345', '12-4']) {
      await expect(createCompanyBankAccount(app, { ...scope, last4 })).rejects.toMatchObject({
        constraint: 'company_bank_accounts_last4_check',
      });
    }
  });

  it('keeps status and retired_at in step', async () => {
    const scope = await newScope();
    const bank = await createCompanyBankAccount(app, scope);
    await expect(
      inTx(app, scope, (c) =>
        c.query(`UPDATE app.company_bank_accounts SET status = 'retired' WHERE id = $1`, [bank.id]),
      ),
    ).rejects.toMatchObject({ constraint: 'company_bank_accounts_retired_at_check' });
    const expense = await createExpenseAccount(app, scope);
    await expect(
      inTx(app, scope, (c) =>
        c.query(`UPDATE app.expense_accounts SET retired_at = now() WHERE id = $1`, [expense.id]),
      ),
    ).rejects.toMatchObject({ constraint: 'expense_accounts_retired_at_check' });
    // Retiring sets both, and a renamed or retired row stays readable.
    await inTx(app, scope, (c) =>
      c.query(
        `UPDATE app.company_bank_accounts SET status = 'retired', retired_at = now(), name = 'Old account'
          WHERE id = $1`,
        [bank.id],
      ),
    );
    const retired = await createExpenseAccount(app, { ...scope, status: 'retired' });
    expect(retired.retiredAt).toBeInstanceOf(Date);
  });

  it('refuses DELETE on both tables: retire, never delete', async () => {
    const scope = await newScope();
    const bank = await createCompanyBankAccount(app, scope);
    const expense = await createExpenseAccount(app, scope);
    await expect(
      inTx(app, scope, (c) =>
        c.query('DELETE FROM app.company_bank_accounts WHERE id = $1', [bank.id]),
      ),
    ).rejects.toMatchObject({ constraint: 'company_bank_accounts_no_delete' });
    await expect(
      inTx(app, scope, (c) =>
        c.query('DELETE FROM app.expense_accounts WHERE id = $1', [expense.id]),
      ),
    ).rejects.toMatchObject({ constraint: 'expense_accounts_no_delete' });
  });

  it('lets the DELETE through once the guard is dropped (so the guard is what refuses it)', async () => {
    const scope = await newScope();
    const bank = await createCompanyBankAccount(app, scope);
    await ownerRollback(scope, async (c) => {
      await c.query('DROP TRIGGER company_bank_accounts_guard ON app.company_bank_accounts');
      const { rowCount } = await c.query('DELETE FROM app.company_bank_accounts WHERE id = $1', [
        bank.id,
      ]);
      expect(rowCount).toBe(1);
    });
  });

  it.each([
    ['bank_name', `'Other Bank'`],
    ['last4', `'9999'`],
    ['currency', `'USD'`],
  ])('refuses a change to company_bank_accounts.%s after insert', async (column, value) => {
    const scope = await newScope();
    const bank = await createCompanyBankAccount(app, scope);
    await expect(
      inTx(app, scope, (c) =>
        c.query(`UPDATE app.company_bank_accounts SET ${column} = ${value} WHERE id = $1`, [
          bank.id,
        ]),
      ),
    ).rejects.toMatchObject({ constraint: 'company_bank_accounts_frozen' });
  });

  it('refuses a change to expense_accounts.code, but allows a rename', async () => {
    const scope = await newScope();
    const expense = await createExpenseAccount(app, { ...scope, code: '6200' });
    await expect(
      inTx(app, scope, (c) =>
        c.query(`UPDATE app.expense_accounts SET code = '6201' WHERE id = $1`, [expense.id]),
      ),
    ).rejects.toMatchObject({ constraint: 'expense_accounts_frozen' });
    await inTx(app, scope, (c) =>
      c.query(`UPDATE app.expense_accounts SET name = 'Office rent' WHERE id = $1`, [expense.id]),
    );
  });

  it('keeps an expense code unique per entity, ignoring case, and free in another entity', async () => {
    const scope = await newScope();
    await createExpenseAccount(app, { ...scope, code: 'Rent' });
    await expect(createExpenseAccount(app, { ...scope, code: 'RENT' })).rejects.toMatchObject({
      constraint: 'expense_accounts_tenant_org_code_unique',
    });
    const second = await insertEntity(scope.tenantId);
    await expect(
      createExpenseAccount(app, { tenantId: scope.tenantId, organizationId: second, code: 'RENT' }),
    ).resolves.toMatchObject({ code: 'RENT' });
  });

  it('accepts the case-insensitive duplicate once the unique index is dropped (so the index is what refuses it)', async () => {
    const scope = await newScope();
    await createExpenseAccount(app, { ...scope, code: 'Fuel' });
    await ownerRollback(scope, async (c) => {
      await c.query('DROP INDEX app.expense_accounts_tenant_org_code_unique');
      await c.query(
        `INSERT INTO app.expense_accounts (tenant_id, organization_id, code, name) VALUES ($1, $2, 'FUEL', 'Fuel')`,
        [scope.tenantId, scope.organizationId],
      );
    });
  });

  it('writes audit rows for inserts and updates', async () => {
    const scope = await newScope();
    const bank = await createCompanyBankAccount(app, scope);
    const expense = await createExpenseAccount(app, scope);
    await inTx(app, scope, async (c) => {
      await c.query(`UPDATE app.company_bank_accounts SET name = 'Payroll' WHERE id = $1`, [
        bank.id,
      ]);
      await c.query(`UPDATE app.expense_accounts SET name = 'Travel' WHERE id = $1`, [expense.id]);
    });
    const actions = async (table: string, id: string) => {
      const { rows } = await owner.query<{ action: string; organization_id: string }>(
        `SELECT action, organization_id FROM audit.audit_events
          WHERE tenant_id = $1 AND entity_type = $2 AND entity_id = $3 ORDER BY occurred_at, id`,
        [scope.tenantId, table, id],
      );
      expect(rows.every((r) => r.organization_id === scope.organizationId)).toBe(true);
      return rows.map((r) => r.action).sort();
    };
    expect(await actions('company_bank_accounts', bank.id)).toEqual([
      'company_bank_accounts.insert',
      'company_bank_accounts.update',
    ]);
    expect(await actions('expense_accounts', expense.id)).toEqual([
      'expense_accounts.insert',
      'expense_accounts.update',
    ]);
  });
});
