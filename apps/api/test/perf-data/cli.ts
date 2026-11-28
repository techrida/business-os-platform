import { writeFile, rename, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { PDF_PREPARE_WITHIN_MS } from '@bos/contracts';
import { createDb } from '@bos/db';
import { z } from 'zod';
import { ClamdClient } from '../../src/platform/documents/clamd.client';
import {
  assertTarget,
  createCompany,
  ensureStorageRoot,
  PerfDataError,
  scope,
  staff,
  staffOrg,
  transaction,
  assertCompany,
} from './company';
import { seedPlatformPortal } from './platform';
import { cleanup } from './cleanup';
import { generate, fullSizes, manifest } from './generate';

async function main() {
  const config = process.env;
  const url = config['BOS_PERF_DB_URL'];
  const storage = config['BOS_PERF_STORAGE_ROOT'];
  if (!url || !storage) throw new PerfDataError('Set BOS_PERF_DB_URL and BOS_PERF_STORAGE_ROOT');
  assertTarget(url, config['NODE_ENV']);
  const command = process.argv[2];
  if (!['create', 'load', 'cleanup', 'pdf-times', 'procurement-ready'].includes(command ?? ''))
    throw new PerfDataError('Choose create, load, cleanup, pdf-times or procurement-ready');
  const handle = createDb(url, { max: 5 });
  const { pool } = handle;
  const lock = await pool.connect();
  try {
    // One runner at a time, including cleanup, so a retry cannot race another generator.
    const r = await lock.query<{ locked: boolean }>(
      `SELECT pg_try_advisory_lock(hashtext('bos-perf-data')) locked`,
    );
    if (!r.rows[0]?.locked) throw new PerfDataError('Another perf data command is running');
    await ensureStorageRoot(pool, storage);
    if (command === 'procurement-ready') {
      const deadline = Date.now() + PDF_PREPARE_WITHIN_MS;
      do {
        const { rows } = await pool.query<{ issued: number; ready: number }>(
          `
          SELECT count(DISTINCT p.id)::int issued, count(DISTINCT p.id) FILTER (WHERE v.status='clean')::int ready
          FROM app.purchase_order_versions p
          LEFT JOIN app.documents d ON d.owner_type='purchase_order_version' AND d.owner_id=p.id AND d.tenant_id=p.tenant_id AND d.organization_id=p.organization_id AND d.removed_at IS NULL
          LEFT JOIN app.document_versions v ON v.id=d.current_version_id AND v.tenant_id=p.tenant_id AND v.organization_id=p.organization_id
          WHERE p.tenant_id=$1 AND p.organization_id=$2`,
          [scope.tenantId, scope.organizationId],
        );
        const { issued, ready } = rows[0]!;
        if (issued !== 2000)
          throw new PerfDataError(
            'Expected 2,000 seeded purchase order versions before measurement',
          );
        if (issued === ready) {
          console.log('All 2,000 seeded purchase order PDFs are ready');
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 5000));
      } while (Date.now() < deadline);
      throw new PerfDataError('Timed out waiting for the seed purchase order PDFs');
    }
    if (command === 'pdf-times') {
      const since = process.argv[3];
      if (!since || !Number.isFinite(Date.parse(since)))
        throw new PerfDataError('Supply the start time of the sales run');
      // Approval makes a version eligible for rendering. A clean scan makes the resulting file downloadable.
      const { rows } = await pool.query<{ queued: number; completed: number; ms: number[] | null }>(
        `
        SELECT count(*)::int queued, count(v.scanned_at)::int completed,
          percentile_cont(ARRAY[0.5,0.95,0.99]) WITHIN GROUP (ORDER BY extract(epoch FROM (v.scanned_at-q.approved_at))*1000) ms
        FROM app.quotation_versions q
        LEFT JOIN app.documents d ON d.id=q.rendered_document_id AND d.tenant_id=q.tenant_id AND d.organization_id=q.organization_id
        LEFT JOIN app.document_versions v ON v.id=d.current_version_id AND v.tenant_id=q.tenant_id AND v.organization_id=q.organization_id AND v.status='clean'
        WHERE q.tenant_id=$1 AND q.organization_id=$2 AND q.approved_at >= $3::timestamptz`,
        [scope.tenantId, scope.organizationId, since],
      );
      const result = rows[0]!;
      console.log('PDF approval to clean scan (ms), completed/queued, p50, p95, p99');
      console.log(
        [
          result.completed + '/' + result.queued,
          ...(result.ms ?? []).map((ms) => ms.toFixed(1)),
        ].join(', '),
      );
      if (!result.ms || result.completed !== result.queued || result.ms[1]! >= 10000)
        throw new PerfDataError('Missing or slow PDF completion');
      return;
    }
    if (command === 'cleanup') {
      await cleanup(pool, storage);
      return;
    }
    if (command === 'create') await createCompany(pool, fullSizes.customers);
    else {
      const scanner = new ClamdClient({
        host: config['BOS_PERF_CLAMD_HOST'] ?? 'localhost',
        port: Number(config['BOS_PERF_CLAMD_PORT'] ?? 3310),
      });
      if (!(await scanner.ping())) throw new PerfDataError('Local ClamAV scanner unavailable');
      const sizes =
        config['BOS_PERF_SCALE'] === 'small'
          ? {
              waitingPerApprover: 2,
              leads: 5,
              activities: 20,
              customers: 2,
              invoicesPerCustomer: 2,
              payments: 2,
              bills: 2,
              auditEvents: 100,
            }
          : config['BOS_PERF_SCALE'] === 'procurement'
            ? {
                waitingPerApprover: 0,
                leads: 1,
                activities: 0,
                customers: 1,
                invoicesPerCustomer: 0,
                payments: 0,
                bills: fullSizes.bills,
                auditEvents: 0,
              }
            : fullSizes;
      const workloadSizes =
        config['BOS_PERF_WORKLOAD'] === 'money'
          ? { ...sizes, waitingPerApprover: 0, leads: 1, activities: 0, bills: 0, auditEvents: 0 }
          : sizes;
      await generate(handle, workloadSizes, storage, scanner);
    }
    if (config['BOS_PERF_SUBJECTS']) {
      const subject = z.string().regex(/^\d+$/);
      const identity = z.object({
        orgId: subject,
        subjects: z.record(z.string(), subject),
        portalOrgs: z.object({ customer_user: subject, vendor_user: subject }).optional(),
      });
      const parsed = identity.safeParse(
        JSON.parse(await readFile(config['BOS_PERF_SUBJECTS'], 'utf8')),
      );
      if (!parsed.success) throw new PerfDataError('Invalid perf staff identity mapping');
      const mapping = parsed.data;
      const ids = [mapping.orgId, ...Object.keys(staff).map((role) => mapping.subjects[role])];
      if (ids.includes(undefined) || new Set(ids).size !== ids.length)
        throw new PerfDataError('Invalid perf staff identity mapping');
      await transaction(pool, async (c) => {
        if (!(await assertCompany(c))) throw new PerfDataError('Missing perf company');
        await c.query(
          'UPDATE app.idp_orgs SET zitadel_org_id=$1 WHERE id=$2 AND tenant_id=$3 AND zitadel_org_id<>$1',
          [mapping.orgId, staffOrg, scope.tenantId],
        );
        for (const [role, id] of Object.entries(staff)) {
          await c.query(
            'UPDATE app.users SET zitadel_user_id=$1 WHERE id=$2 AND tenant_id=$3 AND idp_org_id=$4 AND zitadel_user_id<>$1',
            [mapping.subjects[role], id, scope.tenantId, staffOrg],
          );
        }
        if (mapping.portalOrgs) await seedPlatformPortal(c, mapping.portalOrgs, mapping.subjects);
      });
    }
    const path = resolve(config['BOS_PERF_MANIFEST'] ?? resolve(storage, 'perf-manifest.json'));
    await writeFile(`${path}.tmp`, JSON.stringify(await manifest(pool), null, 2), { mode: 0o600 });
    await rename(`${path}.tmp`, path);
    console.log(`Perf data manifest written for ${scope.organizationId}`);
  } finally {
    await lock.query(`SELECT pg_advisory_unlock(hashtext('bos-perf-data'))`);
    lock.release();
    await handle.close();
  }
}
main().catch((error: unknown) => {
  // Never print connection URLs or driver detail containing credentials.
  if (error instanceof PerfDataError) console.error('Perf data command failed:', error.message);
  else {
    const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
    console.error(
      'Perf data command failed:',
      error instanceof Error ? error.name : 'unknown error',
      typeof code === 'string' && /^[A-Z0-9_]+$/.test(code) ? code : '',
    );
  }
  process.exitCode = 1;
});
