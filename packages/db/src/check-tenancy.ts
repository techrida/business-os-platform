// The tenancy rule, as a check that can fail. ADR 0027 decides what the columns mean: tenant_id is the SaaS
// account and organization_id is the legal entity (only that). For every table in schema "app":
//   * an entity-owned table has tenant_id uuid NOT NULL and organization_id uuid NOT NULL;
//   * a tenant-scoped table (TENANT_SCOPED, ADR 0027 §6) has tenant_id uuid NOT NULL and NO organization_id.
// app.tenants, the tenant itself, is on the allowlist.
//
// Counterparty rule (ADR 0027 §5, revising ADR 0017): a table that has customer_party_id or vendor_party_id must
// make it a nullable uuid, with a foreign key to app.parties that also checks the party's kind, and an index that
// leads with tenant_id. Portal reads filter on that column, so a malformed one would leak rows, let a vendor party
// sit in a customer column, or make the read a table scan. The ADR 0017 columns customer_organization_id and
// vendor_organization_id are rejected: a counterparty is a party, never an organization.
//
// Integrity rules (review finding R17, ADR 0027 §8), read from pg_constraint rather than from constraint names.
// For every table in schema "app" that has a tenant_id column:
//   1. tenant_id has a foreign key to app.tenants.                                        (always on)
//   2. If the table has organization_id, it has a foreign key to app.organizations. A composite
//      (tenant_id, organization_id) key also counts. app.organizations itself is exempt (organization_id = id
//      is held by a CHECK and a trigger there).                                           (strict)
//   3. Every other foreign key to a table that also has tenant_id includes tenant_id, paired with the parent's
//      tenant_id, so a child row can never point at another tenant's parent.             (strict)
//   4. Every UNIQUE or PRIMARY KEY constraint (except one on id alone) leads with tenant_id, so a key is unique
//      per tenant and never across them. Global keys are listed in UNIQUE_EXEMPTIONS.    (strict)
//   5. Every foreign key between two entity-owned tables (both have organization_id) includes organization_id,
//      paired with the parent's organization_id, so a row of one entity never points at another entity's row.
//      Foreign keys into app.organizations are rule 2's business. Exemptions: ENTITY_FK_EXEMPTIONS. (strict)
// The strict rules are on by default (ADR 0027 §8). requireCompositeTenancy: false turns them off; no caller in
// the repository passes it, apart from the test that proves the option still works.
//
// It runs in the @bos/db tests (against the migrated schema, and against deliberately broken fixtures) and in
// CI, so a migration that breaks a rule turns the build red:
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

/** Tables ("schema.table") that are exempt from every rule. Keep this list as short as it is today. */
export const DEFAULT_ALLOWLIST: readonly string[] = ['app.tenants'];

/**
 * Tenant-scoped tables ("schema.table", ADR 0027 §6): they belong to the tenant, not to a legal entity, so they
 * have tenant_id (with its foreign key) and must NOT have organization_id. app.tenants is listed because the
 * ADR lists it, but it is also on DEFAULT_ALLOWLIST: it has no tenant_id, being the tenant itself.
 */
export const TENANT_SCOPED: readonly string[] = [
  'app.tenants',
  'app.users',
  'app.user_roles',
  'app.idp_orgs',
  'app.parties',
  'app.role_permissions',
  'app.role_permission_levels',
  'app.access_revisions',
  'app.authz_versions',
  'app.fx_rates',
  // P2 (customers and tax): tenant-level tables that P2's migrations create. Listing a table that does not
  // exist yet is harmless, because the check only looks up tables it finds.
  'app.customers',
  'app.customer_contacts',
  'app.verification_cases',
  'app.verification_review_events',
  'app.tax_codes',
  'app.payment_terms',
  // 0071 (D49): the tenant's list of lead lost reasons.
  'app.lead_lost_reasons',
  // P3 (U0-A, migration 0019): withholding (TDS) codes, effective-dated like tax_codes.
  'app.withholding_codes',
  // P4 (migration 0032): the vendor master and its tenant-level children.
  'app.vendors',
  'app.vendor_contacts',
  'app.vendor_bank_accounts',
  // FX9 (migration 0192): the phone numbers of customer and vendor contacts, tenant-level like their contacts.
  // app.lead_phones is entity-owned, like leads, so it is not listed.
  'app.customer_contact_phones',
  'app.vendor_contact_phones',
];

/**
 * UNIQUE / PRIMARY KEY constraints ("schema.table.constraint") that rule 4 skips because the value really is
 * global. Name the constraint, not the table, so a later key on the same table is still checked.
 */
export const UNIQUE_EXEMPTIONS: readonly string[] = [
  // Zitadel (the identity provider) issues org and user ids that are unique across every tenant. Login looks
  // them up before it knows the tenant, so these two keys cannot lead with tenant_id (ADR 0027 §8).
  'app.idp_orgs.idp_orgs_zitadel_org_id_unique',
  'app.users.users_zitadel_user_id_unique',
];

/**
 * Foreign keys ("schema.table.constraint") that rule 5 skips: a reference from one legal entity's row to
 * another entity's row. Empty in P1; reserved for inter-company documents (ADR 0027 §8).
 */
export const ENTITY_FK_EXEMPTIONS: readonly string[] = [];

export interface TenancyOptions {
  /** Schemas to check. Default: only "app" (ops holds bookkeeping, not business data). */
  schemas?: readonly string[];
  allowlist?: readonly string[];
  /** Tables ("schema.table") that must not have organization_id. Default: TENANT_SCOPED. */
  tenantScoped?: readonly string[];
  /** Constraints ("schema.table.constraint") that rule 4 skips. Default: UNIQUE_EXEMPTIONS. */
  uniqueExemptions?: readonly string[];
  /** Foreign keys ("schema.table.constraint") that rule 5 skips. Default: ENTITY_FK_EXEMPTIONS. */
  entityFkExemptions?: readonly string[];
  /**
   * Enforce rule 2 (organization_id references app.organizations), rule 3 (every foreign key to a tenant-owned
   * table includes tenant_id, paired with the parent's), rule 4 (unique keys lead with tenant_id) and rule 5
   * (foreign keys between entity-owned tables include organization_id, paired with the parent's).
   * Default: true. Pass false to check the column rules, the counterparty rule and rule 1 only.
   */
  requireCompositeTenancy?: boolean;
}

/**
 * ADR 0027 §5: a table a portal will show says whose record it is with one or both of these columns. With the
 * tenant and the acting entity they are the filter a customer or vendor read uses (scoped().forCounterparty),
 * so each must be well-formed.
 */
export const COUNTERPARTY_COLUMNS = ['customer_party_id', 'vendor_party_id'] as const;

/** The ADR 0017 counterparty columns. ADR 0027 replaced them with COUNTERPARTY_COLUMNS; any left is a violation. */
export const ORGANIZATION_COUNTERPARTY_COLUMNS = [
  'customer_organization_id',
  'vendor_organization_id',
] as const;

export interface TenancyViolation {
  table: string;
  /** The offending column, or the constraint's columns joined with ", ". */
  column: string;
  /** Set when the violation belongs to one constraint (rules 3, 4 and 5, and the counterparty kind check). */
  constraint?: string;
  problem:
    | 'missing'
    | 'not uuid'
    | 'nullable'
    // The tenant-scoped rule:
    | 'present on a tenant-scoped table'
    // The counterparty-column rule:
    | 'not nullable'
    | 'no foreign key to app.parties'
    | 'foreign key to app.parties does not check the kind'
    | 'no tenant-leading index'
    | 'counterparty is an organization column'
    // The tenant-integrity rules (R17, ADR 0027 §8):
    | 'no foreign key to app.tenants'
    | 'no foreign key to app.organizations from organization_id'
    | 'foreign key not scoped by tenant_id'
    | 'unique key does not lead with tenant_id'
    | 'foreign key between entity-owned tables not scoped by organization_id';
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
  has_index: z.boolean(),
});

// One row per counterparty column that actually exists (the rule only applies where the column is present),
// old or new name. The foreign keys are judged in TypeScript from CONSTRAINTS_SQL, which has their column pairs.
//  has_index: a valid, non-partial index that leads with tenant_id and also contains this column, so the
//             portal filter `tenant_id = $1 AND ... AND <column> = $3` can use it. An index on tenant_id alone
//             would pass a looser reading of the rule but would not serve the query.
const COUNTERPARTY_SQL = `
  SELECT n.nspname AS schema_name,
         c.relname AS table_name,
         a.attname AS column_name,
         a.atttypid = 'uuid'::regtype AS is_uuid,
         a.attnotnull AS not_null,
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
  // The next four are only meaningful for foreign keys.
  parent_schema: z.string().nullable(),
  parent_table: z.string().nullable(),
  parent_columns: z.array(z.string()),
  parent_has_tenant_id: z.boolean(),
  parent_has_organization_id: z.boolean(),
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
         ), false) AS parent_has_tenant_id,
         COALESCE(EXISTS (
           SELECT 1 FROM pg_attribute pa
            WHERE pa.attrelid = con.confrelid AND pa.attname = 'organization_id' AND pa.attnum > 0
              AND NOT pa.attisdropped
         ), false) AS parent_has_organization_id
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

const isParent = (row: ConstraintRow, table: string) =>
  row.parent_schema === 'app' && row.parent_table === table;

/** Rule 1's shape: tenant_id -> app.tenants (id), on its own. */
function isTenantKey(row: ConstraintRow): boolean {
  return (
    isParent(row, 'tenants') && row.columns.length === 1 && hasPair(pairsOf(row), 'tenant_id', 'id')
  );
}

/** Rule 2's shape: organization_id -> app.organizations (id), alone or together with tenant_id -> tenant_id. */
function isOrganizationKey(row: ConstraintRow): boolean {
  if (!isParent(row, 'organizations')) return false;
  const pairs = pairsOf(row);
  if (!hasPair(pairs, 'organization_id', 'id')) return false;
  return pairs.length === 1 || (pairs.length === 2 && hasPair(pairs, 'tenant_id', 'tenant_id'));
}

const ORGANIZATION_COUNTERPARTY_SET: ReadonlySet<string> = new Set(
  ORGANIZATION_COUNTERPARTY_COLUMNS,
);

async function checkCounterpartyColumns(
  db: Queryable,
  schemas: readonly string[],
  allowlist: ReadonlySet<string>,
  constraints: readonly ConstraintRow[],
): Promise<TenancyViolation[]> {
  const { rows } = await db.query(COUNTERPARTY_SQL, [
    [...schemas],
    [...COUNTERPARTY_COLUMNS, ...ORGANIZATION_COUNTERPARTY_COLUMNS],
  ]);
  const violations: TenancyViolation[] = [];
  for (const row of z.array(CounterpartyRowSchema).parse(rows)) {
    const table = `${row.schema_name}.${row.table_name}`;
    if (allowlist.has(table)) continue;
    const column = row.column_name;
    if (ORGANIZATION_COUNTERPARTY_SET.has(column)) {
      // One line is enough: the fix is to replace the column, not to repair it.
      violations.push({ table, column, problem: 'counterparty is an organization column' });
      continue;
    }
    // Optional on purpose: a draft row may have no counterparty yet, and staff-only rows never do.
    if (!row.is_uuid) violations.push({ table, column, problem: 'not uuid' });
    if (row.not_null) violations.push({ table, column, problem: 'not nullable' });
    // A foreign key from this column to app.parties (id). Rule 3 checks that tenant_id is in it too; here it
    // must also pair some column with parties.kind, so a vendor party cannot sit in a customer column.
    const toParties = constraints.filter(
      (fk) =>
        fk.kind === 'f' &&
        fk.schema_name === row.schema_name &&
        fk.table_name === row.table_name &&
        isParent(fk, 'parties') &&
        hasPair(pairsOf(fk), column, 'id'),
    );
    const first = toParties[0];
    if (first === undefined) {
      violations.push({ table, column, problem: 'no foreign key to app.parties' });
    } else if (!toParties.some((fk) => pairsOf(fk).some(([, parent]) => parent === 'kind'))) {
      violations.push({
        table,
        column,
        constraint: first.constraint_name,
        problem: 'foreign key to app.parties does not check the kind',
      });
    }
    if (!row.has_index) violations.push({ table, column, problem: 'no tenant-leading index' });
  }
  return violations;
}

function checkTenantIntegrity(
  tables: readonly z.infer<typeof TableRowSchema>[],
  constraints: readonly ConstraintRow[],
  allowlist: ReadonlySet<string>,
  tenantScoped: ReadonlySet<string>,
  uniqueExemptions: ReadonlySet<string>,
  entityFkExemptions: ReadonlySet<string>,
  strict: boolean,
): TenancyViolation[] {
  const violations: TenancyViolation[] = [];

  for (const t of tables) {
    const table = `${t.schema_name}.${t.table_name}`;
    if (allowlist.has(table)) continue;
    // A tenant-scoped table that has organization_id is already reported once; rules 2 and 5 would only
    // repeat it.
    const entityOwned = t.has_organization_id && !tenantScoped.has(table);
    const own = constraints.filter(
      (row) => row.schema_name === t.schema_name && row.table_name === t.table_name,
    );
    const foreignKeys = own.filter((row) => row.kind === 'f');

    // Rule 1.
    if (!foreignKeys.some(isTenantKey)) {
      violations.push({ table, column: 'tenant_id', problem: 'no foreign key to app.tenants' });
    }
    if (!strict) continue;
    // Rule 2. app.organizations is the entity itself: its organization_id equals id by CHECK and trigger.
    if (entityOwned && table !== 'app.organizations' && !foreignKeys.some(isOrganizationKey)) {
      violations.push({
        table,
        column: 'organization_id',
        problem: 'no foreign key to app.organizations from organization_id',
      });
    }
    for (const fk of foreignKeys) {
      // The two keys above are the accepted shapes for their columns.
      if (isTenantKey(fk) || isOrganizationKey(fk)) continue;
      const pairs = pairsOf(fk);
      const constraint = fk.constraint_name;
      const column = fk.columns.join(', ');
      // Rule 3: every other foreign key into a table that has tenant_id has to carry tenant_id, paired with the
      // parent's tenant_id.
      if (fk.parent_has_tenant_id && !hasPair(pairs, 'tenant_id', 'tenant_id')) {
        violations.push({
          table,
          column,
          constraint,
          problem: 'foreign key not scoped by tenant_id',
        });
      }
      // Rule 5: between two entity-owned tables it also has to carry organization_id, paired with the parent's.
      // A foreign key into app.organizations pairs organization_id with id; that is rule 2's shape, not this.
      if (
        entityOwned &&
        fk.parent_has_organization_id &&
        !isParent(fk, 'organizations') &&
        !tenantScoped.has(`${fk.parent_schema}.${fk.parent_table}`) &&
        !entityFkExemptions.has(`${table}.${constraint}`) &&
        !hasPair(pairs, 'organization_id', 'organization_id')
      ) {
        violations.push({
          table,
          column,
          constraint,
          problem: 'foreign key between entity-owned tables not scoped by organization_id',
        });
      }
    }
    // Rule 4. A key on id alone (the primary key, or a UNIQUE(id) that backs a foreign key) is the row
    // identity, not a business key, and a uuid id is unique across tenants anyway.
    for (const key of own) {
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
  const tenantScoped = new Set(options.tenantScoped ?? TENANT_SCOPED);
  const uniqueExemptions = new Set(options.uniqueExemptions ?? UNIQUE_EXEMPTIONS);
  const entityFkExemptions = new Set(options.entityFkExemptions ?? ENTITY_FK_EXEMPTIONS);
  const [columnResult, tableResult, constraintResult] = await Promise.all([
    db.query(SQL, [[...schemas]]),
    db.query(TENANT_TABLES_SQL, [[...schemas]]),
    db.query(CONSTRAINTS_SQL, [[...schemas]]),
  ]);
  const tables = z.array(TableRowSchema).parse(tableResult.rows);
  const constraints = z.array(ConstraintRowSchema).parse(constraintResult.rows);

  const violations: TenancyViolation[] = [];
  for (const row of z.array(RowSchema).parse(columnResult.rows)) {
    const table = `${row.schema_name}.${row.table_name}`;
    if (allowlist.has(table)) continue;
    if (row.column_name === 'organization_id' && tenantScoped.has(table)) {
      if (row.present) {
        violations.push({
          table,
          column: row.column_name,
          problem: 'present on a tenant-scoped table',
        });
      }
      continue;
    }
    if (!row.present) violations.push({ table, column: row.column_name, problem: 'missing' });
    else if (!row.is_uuid) violations.push({ table, column: row.column_name, problem: 'not uuid' });
    else if (!row.not_null)
      violations.push({ table, column: row.column_name, problem: 'nullable' });
  }
  violations.push(...(await checkCounterpartyColumns(db, schemas, allowlist, constraints)));
  violations.push(
    ...checkTenantIntegrity(
      tables,
      constraints,
      allowlist,
      tenantScoped,
      uniqueExemptions,
      entityFkExemptions,
      options.requireCompositeTenancy ?? true,
    ),
  );
  return violations;
}

const COUNTERPARTY_FK_RULE =
  'must be a nullable uuid with a foreign key to app.parties (tenant_id, id, kind), from ' +
  '(tenant_id, <kind>_party_id, <kind>_party_kind), and a tenant-leading index';

// The rule behind each problem that is not a plain column-shape problem, spelled out so a log line is enough to
// fix the migration.
const RULES: Partial<Record<TenancyViolation['problem'], string>> = {
  'present on a tenant-scoped table':
    'a table on the TENANT_SCOPED list belongs to the tenant, not to a legal entity, and must not have organization_id (ADR 0027 §6)',
  'no foreign key to app.parties': COUNTERPARTY_FK_RULE,
  'foreign key to app.parties does not check the kind': COUNTERPARTY_FK_RULE,
  'counterparty is an organization column':
    'a counterparty is a party: use customer_party_id / vendor_party_id with a foreign key to app.parties (ADR 0027 §5)',
  'no foreign key to app.tenants': 'tenant_id must have a foreign key to app.tenants',
  'no foreign key to app.organizations from organization_id':
    'organization_id must have a foreign key to app.organizations, alone or together with tenant_id',
  'foreign key not scoped by tenant_id':
    "a foreign key to a table that has tenant_id must include tenant_id, paired with the parent's tenant_id",
  'unique key does not lead with tenant_id':
    'every UNIQUE and PRIMARY KEY constraint other than the primary key on id must have tenant_id as its first column',
  'foreign key between entity-owned tables not scoped by organization_id':
    "a foreign key between two tables that have organization_id must include organization_id, paired with the parent's organization_id (rule 5)",
};

const COUNTERPARTY_COLUMN_SET: ReadonlySet<string> = new Set(COUNTERPARTY_COLUMNS);

/** One line per violation, for logs and error messages: the table, the constraint (if any) and the rule. */
export function describeViolations(violations: readonly TenancyViolation[]): string {
  return violations
    .map((v) => {
      const where =
        v.constraint === undefined
          ? `${v.table}.${v.column}`
          : `${v.table} constraint ${v.constraint} (${v.column})`;
      const rule =
        RULES[v.problem] ??
        (COUNTERPARTY_COLUMN_SET.has(v.column) ? COUNTERPARTY_FK_RULE : 'must be uuid NOT NULL');
      return `${where}: ${v.problem} (${rule})`;
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
