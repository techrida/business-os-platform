// Public API of @bos/db. P1 repositories import everything from here.
export { createDb, type Db, type DbHandle } from './client.js';
// `migrate(url)` is the name the P0 API interface note promises; runMigrations is the same function.
export { MIGRATIONS_FOLDER, runMigrations, runMigrations as migrate } from './migrate.js';
export {
  COUNTERPARTY_COLUMNS,
  DEFAULT_ALLOWLIST,
  ENTITY_FK_EXEMPTIONS,
  TENANCY_COLUMNS,
  TENANT_SCOPED,
  UNIQUE_EXEMPTIONS,
  assertTenancy,
  checkTenancy,
  describeViolations,
  type Queryable,
  type TenancyOptions,
  type TenancyViolation,
} from './check-tenancy.js';
export {
  scoped,
  type CounterpartyKind,
  type CounterpartyTable,
  type Scope,
  type Scoped,
  type ScopedTable,
} from './scoped.js';
// SQL helpers for tests: a tenant with its default entity, parties, staff and portal users (ADR 0027).
export {
  createCompanyBankAccount,
  createCostCenter,
  createDepartment,
  createExpenseAccount,
  createParty,
  createPortalUser,
  createStaffUser,
  createTenantWithEntity,
  type CompanyBankAccountRow,
  type ExpenseAccountRow,
  type FixturePool,
  type Party,
  type TenantWithEntity,
} from './testing/fixtures.js';
export * from './schema/platform.js';
// All tables as one object, e.g. drizzle({ client, schema }) or schema.organizations.
export * as schema from './schema/platform.js';
// Per-unit table files (P1). Placeholders until each unit fills its own file in.
export * from './schema/audit.js';
export * from './schema/identity.js';
export * from './schema/config.js';
export * from './schema/documents.js';
export * from './schema/notify.js';
export * from './schema/approvals.js';
export * from './schema/memo.js';
export * from './schema/idempotency.js';
export * from './schema/crm.js';
export * from './schema/quotations.js';
export * from './schema/ledger.js';
export * from './schema/sales.js';
export * from './schema/invoicing.js';
export * from './schema/payments.js';
export * from './schema/payment-promises.js';
export * from './schema/party-imports.js';
export * from './schema/vendors.js';
export * from './schema/procurement.js';
export * from './schema/procurement-orders.js';
export * from './schema/payables.js';
export * from './schema/cost-centers.js';
export * from './schema/company-accounts.js';
export * from './schema/access-settings.js';

export * from './schema/verification-review.js';
