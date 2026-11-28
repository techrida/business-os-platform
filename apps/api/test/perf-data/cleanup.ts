import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  assertCompany,
  ensureStorageRoot,
  PerfDataError,
  scope,
  transaction,
  type Pool,
} from './company';

const ident = (s: string) => `"${s.replaceAll('"', '""')}"`;

/** Remove only this disposable tenant, including its independent audit chain. No TRUNCATE or cascading deletes. */
export async function cleanup(pool: Pool, storageRoot: string): Promise<void> {
  await ensureStorageRoot(pool, storageRoot);
  await transaction(pool, async (c) => {
    if (!(await assertCompany(c))) return;
    // Lock all tenant-owned tables before checking cross-tenant foreign keys and deleting. This is an offline
    // maintenance operation: the perf database must not serve traffic during cleanup.
    const { rows: tables } = await c.query<{
      schema: string;
      name: string;
    }>(`SELECT table_schema AS schema,table_name AS name FROM information_schema.columns
      WHERE table_schema IN ('app','audit') AND column_name='tenant_id' AND table_name IN
      (SELECT table_name FROM information_schema.tables WHERE table_schema IN ('app','audit') AND table_type='BASE TABLE') ORDER BY 1,2`);
    const names = tables.map((t) => `${ident(t.schema)}.${ident(t.name)}`);
    await c.query(`LOCK TABLE app.tenants, ${names.join(', ')} IN ACCESS EXCLUSIVE MODE`);
    // Check all inbound FK references, including old single-column foreign keys. Abort rather than leave a dangling
    // reference in another tenant or in an unscoped table. Never rely on disabled constraints for data generation.
    const { rows: fks } = await c.query<{
      child: string;
      parent: string;
      join_expr: string;
      child_scoped: boolean;
      parent_scope: string;
    }>(`
      SELECT format('%I.%I',cn.nspname,ct.relname) child,format('%I.%I',pn.nspname,pt.relname) parent,
       string_agg(format('ch.%I = p.%I',ca.attname,pa.attname),' AND ' ORDER BY k.ord) join_expr,
       EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=ct.oid AND attname='tenant_id' AND NOT attisdropped) child_scoped,
       CASE WHEN pt.relname='tenants' THEN 'id' ELSE 'tenant_id' END parent_scope
       FROM pg_constraint f JOIN pg_class ct ON ct.oid=f.conrelid JOIN pg_namespace cn ON cn.oid=ct.relnamespace
       JOIN pg_class pt ON pt.oid=f.confrelid JOIN pg_namespace pn ON pn.oid=pt.relnamespace
       CROSS JOIN LATERAL unnest(f.conkey,f.confkey) WITH ORDINALITY k(ca,pa,ord)
       JOIN pg_attribute ca ON ca.attrelid=ct.oid AND ca.attnum=k.ca JOIN pg_attribute pa ON pa.attrelid=pt.oid AND pa.attnum=k.pa
       WHERE f.contype='f' AND pn.nspname IN ('app','audit') AND (pt.relname='tenants' OR EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=pt.oid AND attname='tenant_id' AND NOT attisdropped))
       GROUP BY f.oid,cn.nspname,ct.relname,ct.oid,pn.nspname,pt.relname,pt.oid`);
    for (const fk of fks) {
      const cross = await c.query(
        `SELECT 1 FROM ${fk.child} ch JOIN ${fk.parent} p ON ${fk.join_expr} WHERE p.${ident(fk.parent_scope)}=$1 AND ${fk.child_scoped ? 'ch.tenant_id IS DISTINCT FROM $1' : 'true'} LIMIT 1`,
        [scope.tenantId],
      );
      if (cross.rowCount)
        throw new PerfDataError(`Cleanup refused: outside reference from ${fk.child}`);
    }
    // Published and issued rows, and audit events, are intentionally undeletable in the app. In this explicitly
    // disposable database only, suppress guards and FK triggers on THIS connection for teardown of the whole tenant.
    await c.query('SET LOCAL session_replication_role = replica');
    for (const name of names)
      await c.query(`DELETE FROM ${name} WHERE tenant_id=$1`, [scope.tenantId]);
    await c.query('DELETE FROM app.tenants WHERE id=$1', [scope.tenantId]);
    await c.query('SET LOCAL session_replication_role = origin');
  });
  // Storage keys are tenant-prefixed; both directories are exclusively owned by the fixed perf tenant.
  for (const dir of ['clean', 'quarantine'])
    await rm(join(storageRoot, dir, scope.tenantId), { recursive: true, force: true });
}
