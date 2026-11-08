// The tenancy rule, as a check that can fail:
//   every table in schema "app" must have tenant_id uuid NOT NULL and organization_id uuid NOT NULL.
// The one exception is app.tenants, which is the tenant itself.
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

export interface TenancyViolation {
  table: string;
  column: string;
  problem: 'missing' | 'not uuid' | 'nullable';
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
  return violations;
}

/** One line per violation, for logs and error messages. */
export function describeViolations(violations: readonly TenancyViolation[]): string {
  return violations
    .map((v) => `${v.table}.${v.column}: ${v.problem} (must be uuid NOT NULL)`)
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
