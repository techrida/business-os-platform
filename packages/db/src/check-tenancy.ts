// The tenancy rule, as a check that can fail:
//   every table in schema "app" must have tenant_id uuid NOT NULL and organization_id uuid NOT NULL.
// The one exception is app.tenants, which is the tenant itself.
//
// Second rule (ADR 0017): a table that has customer_organization_id or vendor_organization_id must make it a
// nullable uuid with a foreign key to app.organizations and an index that leads with tenant_id. Portal reads
// filter on that column alone, so a malformed one would leak rows or make the read a table scan.
//
// It runs in the @bos/db tests (against the migrated schema, and against deliberately broken fixtures) and in
// CI, so a P1 migration that adds a table without the two columns turns the build red:
//
//   node packages/db/dist/check-tenancy.js        (reads DATABASE_MIGRATE_URL; exit code 1 = violations)
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { z } from 'zod';

import { createDb } from './client.js';

/** Anything with pg's query(): a Pool, a Client, or a PoolClient (useful inside a transaction). */
export interface Queryable {
  query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }>;
}

export const TENANCY_COLUMNS = ['tenant_id', 'organization_id'] as const;

/** Tables ("schema.table") that are exempt. Keep this list as short as it is today. */
export const DEFAULT_ALLOWLIST: readonly string[] = ['app.tenants'];

export interface TenancyOptions {
  /** Schemas to check. Default: only "app" (ops holds bookkeeping, not business data). */
  schemas?: readonly string[];
  allowlist?: readonly string[];
}

/**
 * ADR 0017: a table a portal will show says whose record it is with one or both of these columns. They are
 * the only filter a customer or vendor read uses (scoped().forCounterparty), so each must be well-formed.
 */
export const COUNTERPARTY_COLUMNS = ['customer_organization_id', 'vendor_organization_id'] as const;

export interface TenancyViolation {
  table: string;
  column: string;
  problem:
    | 'missing'
    | 'not uuid'
    | 'nullable'
    // The counterparty-column rule:
    | 'not nullable'
    | 'no foreign key to app.organizations'
    | 'no tenant-leading index';
}

const RowSchema = z.object({
  schema_name: z.string(),
  table_name: z.string(),
  column_name: z.string(),
  present: z.boolean(),
  is_uuid: z.boolean(),
  not_null: z.boolean(),
});

// pg_catalog rather than information_schema on purpose: information_schema.tables only lists tables the
// connected role may access, so a table nobody granted to the checking role would be invisible and the check
// would pass without having looked at it. pg_class lists every table.
// relkind r = ordinary table, p = partitioned table.
const SQL = `
  SELECT n.nspname AS schema_name,
         c.relname AS table_name,
         req.column_name AS column_name,
         a.attname IS NOT NULL AS present,
         COALESCE(a.atttypid = 'uuid'::regtype, false) AS is_uuid,
         COALESCE(a.attnotnull, false) AS not_null
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   CROSS JOIN (VALUES ('tenant_id'), ('organization_id')) AS req(column_name)
    LEFT JOIN pg_attribute a
           ON a.attrelid = c.oid
          AND a.attname = req.column_name
          AND a.attnum > 0
          AND NOT a.attisdropped
   WHERE n.nspname = ANY($1::text[])
     AND c.relkind IN ('r', 'p')
   ORDER BY 1, 2, 3`;

const CounterpartyRowSchema = z.object({
  schema_name: z.string(),
  table_name: z.string(),
  column_name: z.string(),
  is_uuid: z.boolean(),
  not_null: z.boolean(),
  has_fk: z.boolean(),
  has_index: z.boolean(),
});

// One row per counterparty column that actually exists (the rule only applies where the column is present).
//  has_fk:    a single-column foreign key from this column to app.organizations(id).
//  has_index: a valid, non-partial index that leads with tenant_id and also contains this column, so the
//             portal filter `tenant_id = $1 AND <column> = $2` can use it. An index on tenant_id alone would
//             pass a looser reading of the rule but would not serve the query.
const COUNTERPARTY_SQL = `
  SELECT n.nspname AS schema_name,
         c.relname AS table_name,
         a.attname AS column_name,
         a.atttypid = 'uuid'::regtype AS is_uuid,
         a.attnotnull AS not_null,
         EXISTS (
           SELECT 1
             FROM pg_constraint con
             JOIN pg_class oc ON oc.oid = con.confrelid
             JOIN pg_namespace on2 ON on2.oid = oc.relnamespace
            WHERE con.conrelid = c.oid
              AND con.contype = 'f'
              AND con.conkey = ARRAY[a.attnum]
              AND on2.nspname = 'app'
              AND oc.relname = 'organizations'
         ) AS has_fk,
         EXISTS (
           SELECT 1
             FROM pg_index i
             JOIN pg_attribute t
               ON t.attrelid = c.oid AND t.attname = 'tenant_id' AND NOT t.attisdropped
            WHERE i.indrelid = c.oid
              AND i.indisvalid
              AND i.indpred IS NULL
              AND i.indkey[0] = t.attnum
              AND a.attnum IN (SELECT i.indkey[k] FROM generate_series(0, i.indnkeyatts - 1) AS k)
         ) AS has_index
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a
      ON a.attrelid = c.oid
     AND a.attname = ANY($2::text[])
     AND a.attnum > 0
     AND NOT a.attisdropped
   WHERE n.nspname = ANY($1::text[])
     AND c.relkind IN ('r', 'p')
   ORDER BY 1, 2, 3`;

async function checkCounterpartyColumns(
  db: Queryable,
  schemas: readonly string[],
  allowlist: ReadonlySet<string>,
): Promise<TenancyViolation[]> {
  const { rows } = await db.query(COUNTERPARTY_SQL, [[...schemas], [...COUNTERPARTY_COLUMNS]]);
  const violations: TenancyViolation[] = [];
  for (const row of z.array(CounterpartyRowSchema).parse(rows)) {
    const table = `${row.schema_name}.${row.table_name}`;
    if (allowlist.has(table)) continue;
    const column = row.column_name;
    // Optional on purpose: a draft row may have no counterparty yet, and staff-only rows never do.
    if (!row.is_uuid) violations.push({ table, column, problem: 'not uuid' });
    if (row.not_null) violations.push({ table, column, problem: 'not nullable' });
    if (!row.has_fk) {
      violations.push({ table, column, problem: 'no foreign key to app.organizations' });
    }
    if (!row.has_index) violations.push({ table, column, problem: 'no tenant-leading index' });
  }
  return violations;
}

/** Returns every violation found (an empty array means the rule holds). */
export async function checkTenancy(
  db: Queryable,
  options: TenancyOptions = {},
): Promise<TenancyViolation[]> {
  const schemas = options.schemas ?? ['app'];
  const allowlist = new Set(options.allowlist ?? DEFAULT_ALLOWLIST);
  const { rows } = await db.query(SQL, [[...schemas]]);

  const violations: TenancyViolation[] = [];
  for (const row of z.array(RowSchema).parse(rows)) {
    const table = `${row.schema_name}.${row.table_name}`;
    if (allowlist.has(table)) continue;
    if (!row.present) violations.push({ table, column: row.column_name, problem: 'missing' });
    else if (!row.is_uuid) violations.push({ table, column: row.column_name, problem: 'not uuid' });
    else if (!row.not_null)
      violations.push({ table, column: row.column_name, problem: 'nullable' });
  }
  violations.push(...(await checkCounterpartyColumns(db, schemas, allowlist)));
  return violations;
}

const COUNTERPARTY_COLUMN_SET: ReadonlySet<string> = new Set(COUNTERPARTY_COLUMNS);

/** One line per violation, for logs and error messages. */
export function describeViolations(violations: readonly TenancyViolation[]): string {
  return violations
    .map((v) => {
      const rule = COUNTERPARTY_COLUMN_SET.has(v.column)
        ? 'must be a nullable uuid with a foreign key to app.organizations and a tenant-leading index'
        : 'must be uuid NOT NULL';
      return `${v.table}.${v.column}: ${v.problem} (${rule})`;
    })
    .join('; ');
}

/** Like checkTenancy, but throws an Error that names every offending table and column. */
export async function assertTenancy(db: Queryable, options: TenancyOptions = {}): Promise<void> {
  const violations = await checkTenancy(db, options);
  if (violations.length > 0) {
    throw new Error(`tenancy check failed: ${describeViolations(violations)}`);
  }
}

async function main(): Promise<void> {
  const env = z.object({ DATABASE_MIGRATE_URL: z.string().min(1) }).safeParse(process.env);
  if (!env.success) {
    console.error('check-tenancy: DATABASE_MIGRATE_URL is not set');
    process.exitCode = 1;
    return;
  }
  const { pool, close } = createDb(env.data.DATABASE_MIGRATE_URL, { max: 1 });
  try {
    const violations = await checkTenancy(pool);
    if (violations.length > 0) {
      console.error(`check-tenancy: FAIL ${describeViolations(violations)}`);
      process.exitCode = 1;
    } else {
      console.log('check-tenancy: ok');
    }
  } catch (error) {
    // Message only: a pg error can echo connection details.
    console.error(
      `check-tenancy: could not run (${error instanceof Error ? error.message : 'unknown error'})`,
    );
    process.exitCode = 1;
  } finally {
    await close();
  }
}

function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  void main();
}
