import { sql } from 'drizzle-orm';
import {
  char,
  check,
  foreignKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { appSchema, organizations, tenants } from './platform.js';

/** Both lists are retired, never deleted: documents keep naming a retired row by id. */
export const COMPANY_ACCOUNT_STATUSES = ['active', 'retired'] as const;

/**
 * The paying entity's own bank accounts (0143). Only the last four characters of the number are stored; bank,
 * last four and currency are fixed once created (a trigger enforces it), the name may change.
 */
export const companyBankAccounts = appSchema.table(
  'company_bank_accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    organizationId: uuid('organization_id').notNull(),
    name: text('name').notNull(),
    bankName: text('bank_name').notNull(),
    last4: text('last4').notNull(),
    currency: char('currency', { length: 3 }).notNull(),
    status: text('status', { enum: COMPANY_ACCOUNT_STATUSES }).notNull().default('active'),
    retiredAt: timestamp('retired_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('company_bank_accounts_tenant_org_id_unique').on(t.tenantId, t.organizationId, t.id),
    foreignKey({
      name: 'company_bank_accounts_tenant_org_fk',
      columns: [t.tenantId, t.organizationId],
      foreignColumns: [organizations.tenantId, organizations.id],
    }),
    check('company_bank_accounts_name_check', sql`btrim(${t.name}) <> ''`),
    check('company_bank_accounts_bank_name_check', sql`btrim(${t.bankName}) <> ''`),
    check('company_bank_accounts_last4_check', sql`${t.last4} ~ '^[A-Za-z0-9]{4}$'`),
    check('company_bank_accounts_currency_check', sql`${t.currency} in ('NPR', 'INR', 'USD')`),
    check('company_bank_accounts_status_check', sql`${t.status} in ('active', 'retired')`),
    check(
      'company_bank_accounts_retired_at_check',
      sql`(${t.status} = 'retired') = (${t.retiredAt} IS NOT NULL)`,
    ),
  ],
);

/** The accounts an entity books bill lines to (0144). The code is unique per entity, case-insensitively, and fixed. */
export const expenseAccounts = appSchema.table(
  'expense_accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    organizationId: uuid('organization_id').notNull(),
    code: text('code').notNull(),
    name: text('name').notNull(),
    status: text('status', { enum: COMPANY_ACCOUNT_STATUSES }).notNull().default('active'),
    retiredAt: timestamp('retired_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('expense_accounts_tenant_org_id_unique').on(t.tenantId, t.organizationId, t.id),
    uniqueIndex('expense_accounts_tenant_org_code_unique').on(
      t.tenantId,
      t.organizationId,
      sql`lower(${t.code})`,
    ),
    foreignKey({
      name: 'expense_accounts_tenant_org_fk',
      columns: [t.tenantId, t.organizationId],
      foreignColumns: [organizations.tenantId, organizations.id],
    }),
    check('expense_accounts_code_check', sql`btrim(${t.code}) <> ''`),
    check('expense_accounts_name_check', sql`btrim(${t.name}) <> ''`),
    check('expense_accounts_status_check', sql`${t.status} in ('active', 'retired')`),
    check(
      'expense_accounts_retired_at_check',
      sql`(${t.status} = 'retired') = (${t.retiredAt} IS NOT NULL)`,
    ),
  ],
);
