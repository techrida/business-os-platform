// The audit rule, as a check that can fail:
//   every table in schema "app" must carry the trigger "audit_capture", that trigger must call
//   audit.capture_row(), be enabled (O or A, not disabled and not replica-only), and be AFTER ... FOR EACH ROW
//   on INSERT, UPDATE and DELETE. Without this, "every write is audited" is a promise nobody tests; with it, a P1+
//   migration that forgets `SELECT audit.attach('app.<table>')` turns the build red (NFR: auditability).
//
// Four tables are exempt, each for a stated reason:
//   app.tenants         the tenant itself (the same exemption as check-tenancy)
//   app.notifications   derived data: the event that created it is already audited
//   app.outbox          delivery plumbing: the event it carries is already audited
//   app.authz_versions  a cache-version counter bumped by audited role changes
//
//   node packages/db/dist/check-audit.js        (reads DATABASE_MIGRATE_URL; exit code 1 = offenders)
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { z } from 'zod';

import type { Queryable } from './check-tenancy.js';
import { createDb } from './client.js';

/** Tables ("schema.table") that are exempt. Keep this list as short as it is today. */
export const AUDIT_ALLOWLIST: readonly string[] = [
  'app.tenants',
  'app.notifications',
  'app.outbox',
  'app.authz_versions',
];

export interface AuditOptions {
  /** Schemas to check. Default: only "app" (ops holds bookkeeping, not business data). */
  schemas?: readonly string[];
  allowlist?: readonly string[];
}

const RowSchema = z.object({
  schema_name: z.string(),
  table_name: z.string(),
  // null when the table has no audit_capture trigger that calls audit.capture_row().
  trigger_enabled: z.string().nullable(),
  trigger_type: z.number().int().nullable(),
});

// pg_catalog rather than information_schema, for the same reason as check-tenancy: information_schema only
// lists tables the connected role may access, so an unreadable table would be skipped and the check would pass
// without having looked at it.
// relkind r = ordinary table, p = partitioned table.
// NOT tgisinternal: foreign-key constraints are implemented as internal triggers; only a trigger someone
// created on purpose counts. The function is matched by schema and name through pg_proc (not by a regproc
// cast), so a database where audit.capture_row does not exist yet reports every table instead of erroring.
// A trigger name is unique per table, so the LEFT JOIN yields at most one trigger row per table. Whether that
// trigger is switched on and has the right shape is judged in describeProblem(), from tgenabled and tgtype.
const SQL = `
  SELECT n.nspname AS schema_name,
         c.relname AS table_name,
         t.tgenabled::text AS trigger_enabled,
         t.tgtype::int AS trigger_type
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    LEFT JOIN LATERAL (
           SELECT t.tgenabled, t.tgtype
             FROM pg_trigger t
             JOIN pg_proc p ON p.oid = t.tgfoid
             JOIN pg_namespace pn ON pn.oid = p.pronamespace
            WHERE t.tgrelid = c.oid
              AND NOT t.tgisinternal
              AND t.tgname = 'audit_capture'
              AND pn.nspname = 'audit'
              AND p.proname = 'capture_row'
         ) t ON true
   WHERE n.nspname = ANY($1::text[])
     AND c.relkind IN ('r', 'p')
   ORDER BY 1, 2`;

// pg_trigger.tgtype bits (see src/include/catalog/pg_trigger.h).
const TG_ROW = 1;
const TG_BEFORE = 2;
const TG_INSERT = 4;
const TG_DELETE = 8;
const TG_UPDATE = 16;

// tgenabled: O = fires in origin and local sessions (the default), A = always, R = replica sessions only,
// D = disabled. Only O and A fire in a normal session, so only they audit anything.
const ENABLED_MODES = new Set(['O', 'A']);

/** One table that breaks the audit rule, and why (the reason is safe for logs: no row data). */
export interface AuditOffender {
  table: string;
  problem: string;
}

/**
 * Why a trigger does not audit, or null when it does. A trigger that exists but is disabled, replica-only,
 * BEFORE, statement-level or missing an event would let the old existence-only check pass while writes go
 * unrecorded. AFTER ... FOR EACH ROW on INSERT, UPDATE and DELETE is what audit.attach() creates.
 */
function describeProblem(enabled: string | null, type: number | null): string | null {
  if (enabled === null || type === null) return 'no audit_capture trigger';
  if (enabled === 'D') return 'audit_capture trigger is disabled';
  if (enabled === 'R')
    return 'audit_capture trigger is replica-only (fires only when session_replication_role = replica)';
  if (!ENABLED_MODES.has(enabled))
    return `audit_capture trigger has unknown enabled state '${enabled}'`;
  if ((type & TG_ROW) === 0) return 'audit_capture trigger is statement-level, not FOR EACH ROW';
  if ((type & TG_BEFORE) !== 0) return 'audit_capture trigger is BEFORE, not AFTER';
  const missing = [
    [TG_INSERT, 'INSERT'],
    [TG_UPDATE, 'UPDATE'],
    [TG_DELETE, 'DELETE'],
  ]
    .filter(([bit]) => (type & (bit as number)) === 0)
    .map(([, name]) => name);
  if (missing.length > 0) {
    return `audit_capture trigger must fire on INSERT, UPDATE and DELETE (missing ${missing.join(', ')})`;
  }
  return null;
}

/** Returns each table that is not properly audited and not allowlisted, with the reason (empty means the rule holds). */
export async function checkAuditDetailed(
  db: Queryable,
  options: AuditOptions = {},
): Promise<AuditOffender[]> {
  const schemas = options.schemas ?? ['app'];
  const allowlist = new Set(options.allowlist ?? AUDIT_ALLOWLIST);
  const { rows } = await db.query(SQL, [[...schemas]]);

  const offenders: AuditOffender[] = [];
  for (const row of z.array(RowSchema).parse(rows)) {
    const table = `${row.schema_name}.${row.table_name}`;
    if (allowlist.has(table)) continue;
    const problem = describeProblem(row.trigger_enabled, row.trigger_type);
    if (problem !== null) offenders.push({ table, problem });
  }
  return offenders;
}

/** Returns the tables ("schema.table") that are not audited and not allowlisted (empty means the rule holds). */
export async function checkAudit(db: Queryable, options: AuditOptions = {}): Promise<string[]> {
  return (await checkAuditDetailed(db, options)).map((offender) => offender.table);
}

const formatOffenders = (offenders: readonly AuditOffender[]): string =>
  offenders.map((offender) => `${offender.table} (${offender.problem})`).join('; ');

/** Like checkAudit, but throws an Error that names every offending table and what is wrong with it. */
export async function assertAudit(db: Queryable, options: AuditOptions = {}): Promise<void> {
  const offenders = await checkAuditDetailed(db, options);
  if (offenders.length > 0) {
    throw new Error(`audit check failed: ${formatOffenders(offenders)}`);
  }
}

async function main(): Promise<void> {
  const env = z.object({ DATABASE_MIGRATE_URL: z.string().min(1) }).safeParse(process.env);
  if (!env.success) {
    console.error('check-audit: DATABASE_MIGRATE_URL is not set');
    process.exitCode = 1;
    return;
  }
  const { pool, close } = createDb(env.data.DATABASE_MIGRATE_URL, { max: 1 });
  try {
    const offenders = await checkAuditDetailed(pool);
    if (offenders.length > 0) {
      // Table names and a fixed reason only: nothing from a row or a connection string can leak into CI logs.
      console.error(`check-audit: FAIL ${formatOffenders(offenders)}`);
      process.exitCode = 1;
    } else {
      console.log('check-audit: ok');
    }
  } catch (error) {
    // Message only: a pg error can echo connection details.
    console.error(
      `check-audit: could not run (${error instanceof Error ? error.message : 'unknown error'})`,
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
