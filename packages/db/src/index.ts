// Public API of @bos/db. P1 repositories import everything from here.
export { createDb, type Db, type DbHandle } from './client.js';
// `migrate(url)` is the name the P0 API interface note promises; runMigrations is the same function.
export { MIGRATIONS_FOLDER, runMigrations, runMigrations as migrate } from './migrate.js';
export {
  DEFAULT_ALLOWLIST,
  TENANCY_COLUMNS,
  assertTenancy,
  checkTenancy,
  describeViolations,
  type Queryable,
  type TenancyOptions,
  type TenancyViolation,
} from './check-tenancy.js';
export { scoped, type Scope, type Scoped, type ScopedTable } from './scoped.js';
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
