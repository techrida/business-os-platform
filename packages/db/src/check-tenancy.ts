// The tenancy rule, as a check that can fail:
//   every table in schema "app" must have tenant_id uuid NOT NULL and organization_id uuid NOT NULL.
// The one exception is app.tenants, which is the tenant itself.
//
// Second rule (ADR 0017): a table that has customer_organization_id or vendor_organization_id must make it a
// nullable uuid with a foreign key to app.organizations and an index that leads with tenant_id. Portal reads
// filter on that column alone, so a malformed one would leak rows or make the read a table scan.
//
// Third rule set (review finding R17), read from pg_constraint rather than from constraint names. For every
// table in schema "app" that has a tenant_id column:
//   1. tenant_id has a foreign key to app.tenants.                                        (always on)
//   2. If the table has organization_id, it has a foreign key to app.organizations. A composite
//      (tenant_id, organization_id) key also counts.                                      (opt-in)
//   3. Every other foreign key to a table that also has tenant_id includes tenant_id, paired with the parent's
//      tenant_id, so a child row can never point at another tenant's parent.             (opt-in)
//   4. Every UNIQUE or PRIMARY KEY constraint (except one on id alone) leads with tenant_id, so a key is unique
//      per tenant and never across them. Global keys are listed in UNIQUE_EXEMPTIONS.    (opt-in)
// Rules 2, 3 and 4 sit behind the option requireCompositeTenancy (default false) until Kuu decides what
// organization_id means: they would force a key and foreign-key shape on every table before that is settled.
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

/**
 * UNIQUE / PRIMARY KEY constraints ("schema.table.constraint") that rule 4 skips because the value really is
 * global. Name the constraint, not the table, so a later key on the same table is still checked.
 */
export const UNIQUE_EXEMPTIONS: readonly string[] = [
  // Zitadel (the identity provider) issues org and user ids that are unique across every tenant. Login looks
  // them up before it knows the tenant, so these two keys cannot lead with tenant_id.
  'app.organizations.organizations_zitadel_org_id_unique',
  'app.users.users_zitadel_user_id_unique',
];

export interface TenancyOptions {
  /** Schemas to check. Default: only "app" (ops holds bookkeeping, not business data). */
  schemas?: readonly string[];
  allowlist?: readonly string[];
  /** Constraints ("schema.table.constraint") that rule 4 skips. Default: UNIQUE_EXEMPTIONS. */
  uniqueExemptions?: readonly string[];
  /**
   * Also enforce rule 2 (organization_id references app.organizations), rule 3 (every foreign key to a
   * tenant-owned table includes tenant_id, paired with the parent's) and rule 4 (unique keys lead with
   * tenant_id). Default: false, which checks rule 1 only.
   */
  requireCompositeTenancy?: boolean;
}

/**
 * ADR 0017: a table a portal will show says whose record it is with one or both of these columns. They are
 * the only filter a customer or vendor read uses (scoped().forCounterparty), so each must be well-formed.
 */
export const COUNTERPARTY_COLUMNS = ['customer_organization_id', 'vendor_organization_id'] as const;

export interface TenancyViolation {
  table: string;
  /** The offending column, or the constraint's columns joined with ", ". */
  column: string;
  /** Set when the violation belongs to one constraint (rules 3 and 4). */
  constraint?: string;
  problem:
    | 'missing'
    | 'not uuid'
    | 'nullable'
    // The counterparty-column rule:
    | 'not nullable'
    | 'no foreign key to app.organizations'
    | 'no tenant-leading index'
    // The tenant-integrity rules (R17):
    | 'no foreign key to app.tenants'
    | 'no foreign key to app.organizations from organization_id'
    | 'foreign key not scoped by tenant_id'
    | 'unique key does not lead with tenant_id';
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
//  has_fk:    a foreign key from this column to app.organizations: single-column, or composite with tenant_id
//             (the shape rule 3 requires). Rule 3 checks the pairing; this only checks that the key exists.
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
              AND con.conkey @> ARRAY[a.attnum]
              AND cardinality(con.conkey) <= 2
              AND (
                cardinality(con.conkey) = 1
                OR con.conkey @> ARRAY(
                  SELECT t.attnum FROM pg_attribute t
                   WHERE t.attrelid = c.oid AND t.attname = 'tenant_id' AND NOT t.attisdropped
                )
              )
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

const TableRowSchema = z.object({
  schema_name: z.string(),
  table_name: z.string(),
  has_organization_id: z.boolean(),
});

// Tables that have a tenant_id column; the integrity rules apply to exactly these.
const TENANT_TABLES_SQL = `
  SELECT n.nspname AS schema_name,
         c.relname AS table_name,
         EXISTS (
           SELECT 1 FROM pg_attribute o
            WHERE o.attrelid = c.oid AND o.attname = 'organization_id' AND o.attnum > 0 AND NOT o.attisdropped
         ) AS has_organization_id
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = ANY($1::text[])
     AND c.relkind IN ('r', 'p')
     AND EXISTS (
           SELECT 1 FROM pg_attribute t
            WHERE t.attrelid = c.oid AND t.attname = 'tenant_id' AND t.attnum > 0 AND NOT t.attisdropped
         )
   ORDER BY 1, 2`;

const ConstraintRowSchema = z.object({
  schema_name: z.string(),
  table_name: z.string(),
  constraint_name: z.string(),
  kind: z.enum(['f', 'u', 'p']),
  columns: z.array(z.string()),
  // The next three are only meaningful for foreign keys.
  parent_schema: z.string().nullable(),
  parent_table: z.string().nullable(),
  parent_columns: z.array(z.string()),
  parent_has_tenant_id: z.boolean(),
});

// Foreign keys (f), unique constraints (u) and primary keys (p) of tenant tables, with their columns in key
// order (conkey/confkey are positional, so columns[i] references parent_columns[i]).
const CONSTRAINTS_SQL = `
  SELECT n.nspname AS schema_name,
         c.relname AS table_name,
         con.conname AS constraint_name,
         con.contype::text AS kind,
         ARRAY(
           SELECT a.attname::text
             FROM unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord)
             JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum
            ORDER BY k.ord
         ) AS columns,
         pn.nspname AS parent_schema,
         pc.relname AS parent_table,
         ARRAY(
           SELECT a.attname::text
             FROM unnest(con.confkey) WITH ORDINALITY AS k(attnum, ord)
             JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.attnum
            ORDER BY k.ord
         ) AS parent_columns,
         COALESCE(EXISTS (
           SELECT 1 FROM pg_attribute pa
            WHERE pa.attrelid = con.confrelid AND pa.attname = 'tenant_id' AND pa.attnum > 0 AND NOT pa.attisdropped
         ), false) AS parent_has_tenant_id
    FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    LEFT JOIN pg_class pc ON pc.oid = con.confrelid
    LEFT JOIN pg_namespace pn ON pn.oid = pc.relnamespace
   WHERE n.nspname = ANY($1::text[])
     AND c.relkind IN ('r', 'p')
     AND con.contype IN ('f', 'u', 'p')
     AND EXISTS (
           SELECT 1 FROM pg_attribute t
            WHERE t.attrelid = c.oid AND t.attname = 'tenant_id' AND t.attnum > 0 AND NOT t.attisdropped
         )
   ORDER BY 1, 2, 3`;

type ConstraintRow = z.infer<typeof ConstraintRowSchema>;
type ColumnPair = [column: string, parentColumn: string | undefined];

/** The (column, parent column) pairs of a foreign key. */
function pairsOf(row: ConstraintRow): ColumnPair[] {
  return row.columns.map((column, i) => [column, row.parent_columns[i]]);
}

const hasPair = (pairs: ColumnPair[], column: string, parent: string) =>
  pairs.some(([c, p]) => c === column && p === parent);

/** Rule 1's shape: tenant_id -> app.tenants (id), on its own. */
function isTenantKey(row: ConstraintRow): boolean {
  return (
    row.parent_schema === 'app' &&
    row.parent_table === 'tenants' &&
    row.columns.length === 1 &&
    hasPair(pairsOf(row), 'tenant_id', 'id')
  );
}

/** Rule 2's shape: organization_id -> app.organizations (id), alone or together with tenant_id -> tenant_id. */
function isOrganizationKey(row: ConstraintRow): boolean {
  if (row.parent_schema !== 'app' || row.parent_table !== 'organizations') return false;
  const pairs = pairsOf(row);
  if (!hasPair(pairs, 'organization_id', 'id')) return false;
  return pairs.length === 1 || (pairs.length === 2 && hasPair(pairs, 'tenant_id', 'tenant_id'));
}

async function checkTenantIntegrity(
  db: Queryable,
  schemas: readonly string[],
  allowlist: ReadonlySet<string>,
  uniqueExemptions: ReadonlySet<string>,
  requireCompositeTenancy: boolean,
): Promise<TenancyViolation[]> {
  const [tableResult, constraintResult] = await Promise.all([
    db.query(TENANT_TABLES_SQL, [[...schemas]]),
    db.query(CONSTRAINTS_SQL, [[...schemas]]),
  ]);
  const tables = z.array(TableRowSchema).parse(tableResult.rows);
  const constraints = z.array(ConstraintRowSchema).parse(constraintResult.rows);
  const violations: TenancyViolation[] = [];

  for (const t of tables) {
    const table = `${t.schema_name}.${t.table_name}`;
    if (allowlist.has(table)) continue;
    const own = constraints.filter(
      (row) => row.schema_name === t.schema_name && row.table_name === t.table_name,
    );
    const foreignKeys = own.filter((row) => row.kind === 'f');

    // Rule 1.
    if (!foreignKeys.some(isTenantKey)) {
      violations.push({ table, column: 'tenant_id', problem: 'no foreign key to app.tenants' });
    }
    // Rule 2 (opt-in).
    if (requireCompositeTenancy && t.has_organization_id && !foreignKeys.some(isOrganizationKey)) {
      violations.push({
        table,
        column: 'organization_id',
        problem: 'no foreign key to app.organizations from organization_id',
      });
    }
    // Rule 3 (opt-in): the two keys above are the accepted shapes for their columns. Every other foreign key
    // into a table that has tenant_id has to carry tenant_id, paired with the parent's tenant_id.
    for (const fk of requireCompositeTenancy ? foreignKeys : []) {
      if (isTenantKey(fk) || isOrganizationKey(fk) || !fk.parent_has_tenant_id) continue;
      if (hasPair(pairsOf(fk), 'tenant_id', 'tenant_id')) continue;
      violations.push({
        table,
        column: fk.columns.join(', '),
        constraint: fk.constraint_name,
        problem: 'foreign key not scoped by tenant_id',
      });
    }
    // Rule 4 (opt-in). A key on id alone (the primary key, or a UNIQUE(id) that backs a foreign key) is the row
    // identity, not a business key, and a uuid id is unique across tenants anyway.
    for (const key of requireCompositeTenancy ? own : []) {
      if (key.kind === 'f') continue;
      if (key.columns.length === 1 && key.columns[0] === 'id') continue;
      if (uniqueExemptions.has(`${table}.${key.constraint_name}`)) continue;
      if (key.columns[0] === 'tenant_id') continue;
      violations.push({
        table,
        column: key.columns.join(', '),
        constraint: key.constraint_name,
        problem: 'unique key does not lead with tenant_id',
      });
    }
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
  const uniqueExemptions = new Set(options.uniqueExemptions ?? UNIQUE_EXEMPTIONS);
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
  violations.push(
    ...(await checkTenantIntegrity(
      db,
      schemas,
      allowlist,
      uniqueExemptions,
      options.requireCompositeTenancy ?? false,
    )),
  );
  return violations;
}

const COUNTERPARTY_COLUMN_SET: ReadonlySet<string> = new Set(COUNTERPARTY_COLUMNS);

// The rule behind each tenant-integrity problem, spelled out so a log line is enough to fix the migration.
const INTEGRITY_RULES: Partial<Record<TenancyViolation['problem'], string>> = {
  'no foreign key to app.tenants': 'tenant_id must have a foreign key to app.tenants',
  'no foreign key to app.organizations from organization_id':
    'organization_id must have a foreign key to app.organizations, alone or together with tenant_id',
  'foreign key not scoped by tenant_id':
    "a foreign key to a table that has tenant_id must include tenant_id, paired with the parent's tenant_id",
  'unique key does not lead with tenant_id':
    'every UNIQUE and PRIMARY KEY constraint other than the primary key on id must have tenant_id as its first column',
};

/** One line per violation, for logs and error messages. */
export function describeViolations(violations: readonly TenancyViolation[]): string {
  return violations
    .map((v) => {
      const integrityRule = INTEGRITY_RULES[v.problem];
      if (integrityRule !== undefined) {
        const where =
          v.constraint === undefined
            ? `${v.table}.${v.column}`
            : `${v.table} constraint ${v.constraint} (${v.column})`;
        return `${where}: ${v.problem} (${integrityRule})`;
      }
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
