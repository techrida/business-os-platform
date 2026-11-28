import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTenantWithEntity, createStaffUser, createDb, type DbHandle } from '@bos/db';
import { createTestDatabase, type TestDatabase } from '@bos/db/testing';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { ClamdClient } from './platform/documents/clamd.client';
import { assertTarget, scope, staff, vat } from '../test/perf-data/company';
import { cleanup } from '../test/perf-data/cleanup';
import { generate } from '../test/perf-data/generate';

let db: TestDatabase, handle: DbHandle, pool: DbHandle['pool'], storage: string;
beforeAll(async () => {
  db = await createTestDatabase();
  handle = createDb(db.adminUrl, { max: 5 });
  pool = handle.pool;
  storage = await mkdtemp(join(tmpdir(), 'bos-perf-test-'));
}, 180000);
afterAll(async () => {
  await pool?.end();
  await db?.drop();
  if (storage) await rm(storage, { recursive: true, force: true });
}, 60000);

it('refuses normal and remote databases', () => {
  expect(() => assertTarget('postgres://localhost/bos', 'development')).toThrow();
  expect(() => assertTarget('postgres://remote/bos_perf', 'development')).toThrow();
  expect(() => assertTarget('postgres://localhost/bos_perf', 'production')).toThrow();
  expect(() => assertTarget('postgres://localhost/bos_perf', 'development')).not.toThrow();
});
it('creates valid scoped data, resumes without duplicates and cleans only the perf tenant', async () => {
  const other = await createTenantWithEntity(pool);
  const { userId } = await createStaffUser(pool, { ...other, roleKeys: ['accountant'] });
  const before = (
    await pool.query('SELECT * FROM audit.audit_events WHERE tenant_id=$1 ORDER BY id', [
      other.tenantId,
    ])
  ).rows;
  const clamd = new ClamdClient({ host: 'localhost', port: 3310 });
  // Only the external virus scanner is substituted. Upload bytes, promotion, state transitions and audit are real.
  vi.spyOn(clamd, 'scan').mockResolvedValue({ verdict: 'clean', ms: 1 });
  vi.spyOn(clamd, 'version').mockResolvedValue('test scanner');
  const sizes = {
    waitingPerApprover: 2,
    leads: 3,
    activities: 6,
    customers: 2,
    invoicesPerCustomer: 2,
    payments: 2,
    bills: 2,
    auditEvents: 500,
  };
  vi.mocked(clamd.scan).mockResolvedValueOnce({ verdict: 'error', transient: true, ms: 1 });
  await expect(generate(handle, sizes, storage, clamd)).rejects.toThrow(
    'Perf proof did not scan clean',
  );
  const first = await generate(handle, sizes, storage, clamd);
  expect(first.procurement.evidencePdf).toMatch(/^%PDF-/);
  const departmentHead = await pool.query(
    'SELECT head_user_id FROM app.departments WHERE tenant_id=$1 AND id=$2',
    [scope.tenantId, first.procurement.departmentId],
  );
  expect(departmentHead.rows).toEqual([{ head_user_id: staff.founder }]);
  expect(first.vatId).toBe(vat);
  const quotationWorkflow = await pool.query(
    `SELECT v.status FROM app.workflow_definitions d JOIN app.workflow_versions v ON v.id=d.current_version_id
     WHERE d.tenant_id=$1 AND d.organization_id=$2 AND d.document_type='quotation_version'`,
    [scope.tenantId, scope.organizationId],
  );
  expect(quotationWorkflow.rows).toEqual([{ status: 'published' }]);
  expect(first.ids.test_memos).toHaveLength(6);
  const pending = await pool.query<{ user_id: string; n: number }>(
    `SELECT s.user_id,count(*)::int n FROM app.approval_steps s JOIN app.approval_requests r ON r.id=s.request_id AND r.tenant_id=s.tenant_id WHERE r.tenant_id=$1 AND r.status='pending' AND s.status='active' GROUP BY s.user_id`,
    [scope.tenantId],
  );
  expect(Object.fromEntries(pending.rows.map((r) => [r.user_id, r.n]))).toEqual({
    [staff.accountant]: 2,
    [staff.finance]: 2,
    [staff.founder]: 2,
  });
  expect(
    (
      await pool.query<{ ok: boolean }>(`SELECT ok FROM audit.verify_chain($1,current_date)`, [
        scope.tenantId,
      ])
    ).rows[0]?.ok,
  ).toBe(true);
  expect(first.ids.leads).toHaveLength(3);
  expect(first.ids.activities).toHaveLength(6);
  expect(first.ids.invoices).toHaveLength(4);
  expect(first.ids.payments).toHaveLength(2);
  expect(first.ids.vendor_bills).toHaveLength(2);
  expect(first.ids.audit_events.length).toBeGreaterThanOrEqual(500);
  const visible = await pool.query<{ n: number }>(
    `SELECT customer_party_id,count(*)::int n FROM app.invoices WHERE tenant_id=$1 AND status='issued' AND kind='tax_invoice' GROUP BY customer_party_id`,
    [scope.tenantId],
  );
  expect(visible.rows.map((r) => r.n)).toEqual([2, 2]);
  expect(
    (
      await pool.query<{ n: number }>(
        `SELECT count(*)::int n FROM app.open_items WHERE tenant_id=$1 AND source_type='tax_invoice'`,
        [scope.tenantId],
      )
    ).rows[0]?.n,
  ).toBe(4);
  expect(await generate(handle, sizes, storage, clamd)).toEqual(first);
  await cleanup(pool, storage);
  await cleanup(pool, storage);
  expect(
    (await pool.query('SELECT id FROM app.tenants WHERE id=$1', [scope.tenantId])).rowCount,
  ).toBe(0);
  expect((await pool.query('SELECT id FROM app.users WHERE id=$1', [userId])).rowCount).toBe(1);
  expect(
    (
      await pool.query('SELECT * FROM audit.audit_events WHERE tenant_id=$1 ORDER BY id', [
        other.tenantId,
      ])
    ).rows,
  ).toEqual(before);
}, 180000);
