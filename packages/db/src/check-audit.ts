// The audit rule, as a check that can fail:
//   every table in schema "app" must carry the trigger "audit_capture", and that trigger must call
//   audit.capture_row(). Without this, "every write is audited" is a promise nobody tests; with it, a P1+
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
  audited: z.boolean(),
});

// pg_catalog rather than information_schema, for the same reason as check-tenancy: information_schema only
// lists tables the connected role may access, so an unreadable table would be skipped and the check would pass
// without having looked at it.
// relkind r = ordinary table, p = partitioned table.
// NOT tgisinternal: foreign-key constraints are implemented as internal triggers; only a trigger someone
// created on purpose counts. The function is matched by schema and name through pg_proc (not by a regproc
// cast), so a database where audit.capture_row does not exist yet reports every table instead of erroring.
const SQL = `
  SELECT n.nspname AS schema_name,
         c.relname AS table_name,
         EXISTS (
           SELECT 1
             FROM pg_trigger t
             JOIN pg_proc p ON p.oid = t.tgfoid
             JOIN pg_namespace pn ON pn.oid = p.pronamespace
            WHERE t.tgrelid = c.oid
              AND NOT t.tgisinternal
              AND t.tgname = 'audit_capture'
              -- A trigger switched off with ALTER TABLE ... DISABLE TRIGGER audits nothing.
              AND t.tgenabled <> 'D'
              AND pn.nspname = 'audit'
              AND p.proname = 'capture_row'
         ) AS audited
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = ANY($1::text[])
     AND c.relkind IN ('r', 'p')
   ORDER BY 1, 2`;

/** Returns the tables ("schema.table") that are not audited and not allowlisted (empty means the rule holds). */
export async function checkAudit(db: Queryable, options: AuditOptions = {}): Promise<string[]> {
  const schemas = options.schemas ?? ['app'];
  const allowlist = new Set(options.allowlist ?? AUDIT_ALLOWLIST);
  const { rows } = await db.query(SQL, [[...schemas]]);

  const offenders: string[] = [];
  for (const row of z.array(RowSchema).parse(rows)) {
    const table = `${row.schema_name}.${row.table_name}`;
    if (!row.audited && !allowlist.has(table)) offenders.push(table);
  }
  return offenders;
}

/** Like checkAudit, but throws an Error that names every offending table. */
export async function assertAudit(db: Queryable, options: AuditOptions = {}): Promise<void> {
  const offenders = await checkAudit(db, options);
  if (offenders.length > 0) {
    throw new Error(`audit check failed, no audit_capture trigger on: ${offenders.join(', ')}`);
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
    const offenders = await checkAudit(pool);
    if (offenders.length > 0) {
      // Table names only: nothing from a row or a connection string can leak into CI logs.
      console.error(`check-audit: FAIL no audit_capture trigger on: ${offenders.join(', ')}`);
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
