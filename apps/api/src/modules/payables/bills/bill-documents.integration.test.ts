import 'reflect-metadata';

import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import {
  DEFAULT_ROLE_PERMISSIONS,
  MAX_UPLOAD_BYTES,
  type Permission,
  type RoleKey,
  type Scope,
} from '@bos/contracts';
import { createParty, createStaffUser, createTenantWithEntity, runMigrations } from '@bos/db';
import { ForbiddenException } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';

import { AuditService } from '../../../platform/audit/audit.service';
import { can } from '../../../platform/authz/can';
import type { Principal } from '../../../platform/authz/principal';
import type { Db } from '../../../platform/db/db.module';
import { systemActor, withTx, type TxScope } from '../../../platform/db/tx';
import { DocumentsService } from '../../../platform/documents/documents.service';
import { SignedLinks } from '../../../platform/documents/signed-link';
import { DiskStorageAdapter } from '../../../platform/documents/storage.adapter';
import { billDocumentOwnerPolicy, BillDocumentsService } from './bill-documents.service';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 180_000 });
let container: import('@testcontainers/postgresql').StartedPostgreSqlContainer;
let appPool: Pool;
let db: Db;
let root = '';
let scopeA: TxScope;
let scopeB: TxScope;
let userId = '';
let vendorId = '';
let service: BillDocumentsService;
const scan = { add: vi.fn().mockResolvedValue({}) };
const current = {
  role: 'accountant' as RoleKey,
  scope: null as TxScope | null,
  kind: 'staff' as Principal['orgKind'],
};
const principal = (): Principal => ({
  ...current.scope!,
  userId,
  zitadelUserId: 'test-user',
  idpOrgId: randomUUID(),
  orgKind: current.kind,
  partyId: null,
  roles: [current.role],
  departmentId: null,
  status: 'active',
  grants: new Map(Object.entries(DEFAULT_ROLE_PERMISSIONS[current.role])) as Map<Permission, Scope>,
});
const caller = {
  current: () => ({
    scope: current.scope!,
    actor: { kind: 'user' as const, id: userId, correlationId: 'bill-documents-test' },
    principal: principal(),
  }),
};
const file = { filename: 'invoice.pdf', declaredMime: 'application/pdf', sizeBytes: 20 };

beforeAll(async () => {
  const { PostgreSqlContainer } = await import('@testcontainers/postgresql');
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  const urlFor = (role: string, password: string, database: string) => {
    const url = new URL(container.getConnectionUri());
    url.username = role;
    url.password = password;
    url.pathname = `/${database}`;
    return url.toString();
  };
  const admin = new Pool({ connectionString: container.getConnectionUri(), max: 1 });
  await admin.query("CREATE ROLE bos_owner LOGIN PASSWORD 'owner-test-pw'");
  await admin.query("CREATE ROLE bos_app LOGIN PASSWORD 'app-test-pw'");
  await admin.query('CREATE DATABASE bos OWNER bos_owner');
  await admin.end();
  const grants = new Pool({ connectionString: urlFor('test', 'test', 'bos'), max: 1 });
  await grants.query(
    'ALTER DEFAULT PRIVILEGES FOR ROLE bos_owner GRANT USAGE ON SCHEMAS TO bos_app',
  );
  await grants.query(
    'ALTER DEFAULT PRIVILEGES FOR ROLE bos_owner GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO bos_app',
  );
  await grants.end();
  await runMigrations(urlFor('bos_owner', 'owner-test-pw', 'bos'));
  appPool = new Pool({ connectionString: urlFor('bos_app', 'app-test-pw', 'bos'), max: 4 });
  appPool.on('error', () => {});
  db = drizzle({ client: appPool });
  const tenant = await createTenantWithEntity(appPool);
  scopeA = { tenantId: tenant.tenantId, organizationId: tenant.organizationId };
  scopeB = { tenantId: tenant.tenantId, organizationId: randomUUID() };
  userId = (await createStaffUser(appPool, { ...scopeA, idpOrgId: tenant.idpOrgId })).userId;
  vendorId = (await createParty(appPool, { tenantId: tenant.tenantId, kind: 'vendor' })).partyId;
  await withTx(db, scopeA, systemActor('test'), async (tx) => {
    await tx.execute(
      sql`INSERT INTO app.organizations (id,tenant_id,organization_id,code,name,legal_name,is_default) VALUES (${scopeB.organizationId},${scopeB.tenantId},${scopeB.organizationId},'B','B','B',false)`,
    );
    await tx.execute(
      sql`INSERT INTO app.vendors (id,tenant_id,legal_name,pan,created_by) VALUES (${vendorId},${tenant.tenantId},'Bill vendor','123456789',${userId})`,
    );
    for (const scope of [scopeA, scopeB])
      await tx.execute(
        sql`INSERT INTO app.vendor_accounts (tenant_id,organization_id,vendor_id,active) VALUES (${scope.tenantId},${scope.organizationId},${vendorId},true)`,
      );
  });
  const authz = {
    assert: (action: Permission, ref: Parameters<typeof can>[2]) => {
      const decision = can(principal(), action, ref);
      if (!decision.allowed)
        throw new ForbiddenException({ code: 'forbidden', reason: decision.reason });
    },
  };
  root = await mkdtemp(join(tmpdir(), 'bos-bill-documents-'));
  const documents = new DocumentsService(
    db,
    new DiskStorageAdapter(root),
    new SignedLinks('bill-documents-test-signing-key-000000000', {
      claim: () => Promise.resolve(true),
    }),
    scan as unknown as Queue,
    authz,
    new AuditService(db),
  );
  documents.registerOwner(billDocumentOwnerPolicy(db));
  service = new BillDocumentsService(db, caller, documents);
});

afterAll(async () => {
  await appPool?.end();
  await container?.stop();
  if (root) await rm(root, { recursive: true, force: true });
});
beforeEach(() => {
  current.role = 'accountant';
  current.kind = 'staff';
  current.scope = scopeA;
  scan.add.mockClear();
});

it('lets an accountant without documents.upload create and stream an invoice into quarantine', async () => {
  expect(principal().grants.has('documents.upload')).toBe(false);
  const bytes = Buffer.from('%PDF-1.7\nbill invoice\n');
  const created = await service.create({
    ...file,
    vendorPartyId: vendorId,
    sizeBytes: bytes.length,
  });
  expect(created.uploadPath).toBe(
    `/v1/payables/bill-documents/${created.documentId}/versions/${created.versionId}/content`,
  );
  const result = await service.receive(
    created.documentId,
    created.versionId,
    Readable.from(bytes),
    bytes.length,
  );
  expect(result.status).toBe('quarantined');
  expect(scan.add).toHaveBeenCalledTimes(1);
  const stored = await appPool.query(
    'SELECT owner_type, owner_id FROM app.documents WHERE id = $1',
    [created.documentId],
  );
  expect(stored.rows).toEqual([{ owner_type: 'vendor_bill_intake', owner_id: vendorId }]);
});

it('denies finance and portal callers and refuses a vendor without an account here', async () => {
  current.role = 'finance';
  await expect(service.create({ ...file, vendorPartyId: vendorId })).rejects.toMatchObject({
    status: 403,
  });
  current.role = 'accountant';
  current.kind = 'vendor';
  await expect(service.create({ ...file, vendorPartyId: vendorId })).rejects.toMatchObject({
    status: 403,
  });
  current.kind = 'staff';
  await expect(service.create({ ...file, vendorPartyId: randomUUID() })).rejects.toMatchObject({
    status: 404,
  });
});

it('refuses a document/version mismatch, another entity, malformed ids and removed documents', async () => {
  const created = await service.create({ ...file, vendorPartyId: vendorId });
  const other = await service.create({ ...file, vendorPartyId: vendorId });
  const send = (docId = created.documentId, versionId = created.versionId) =>
    service.receive(docId, versionId, Readable.from('data'), 4);
  await expect(send(randomUUID())).rejects.toMatchObject({ status: 404 });
  await expect(send(other.documentId)).rejects.toMatchObject({ status: 404 });
  await expect(send(created.documentId, 'invalid')).rejects.toMatchObject({ status: 404 });
  await expect(send('invalid')).rejects.toMatchObject({ status: 404 });
  current.scope = scopeB;
  await expect(send()).rejects.toMatchObject({ status: 404 });
  current.scope = { ...scopeA, tenantId: randomUUID() };
  await expect(send()).rejects.toMatchObject({ status: 404 });
  current.scope = scopeA;
  await withTx(db, scopeA, systemActor('test'), (tx) =>
    tx.execute(
      sql`UPDATE app.documents SET removed_at = now() WHERE id = ${created.documentId} AND tenant_id = ${scopeA.tenantId} AND organization_id = ${scopeA.organizationId}`,
    ),
  );
  await expect(send()).rejects.toMatchObject({ status: 404 });
});

it('rechecks the bill-entry grant and active vendor account before accepting bytes', async () => {
  const created = await service.create({ ...file, vendorPartyId: vendorId });
  const send = () =>
    service.receive(created.documentId, created.versionId, Readable.from('data'), 4);
  current.role = 'finance';
  await expect(send()).rejects.toMatchObject({ status: 403 });
  current.role = 'accountant';
  current.kind = 'vendor';
  await expect(send()).rejects.toMatchObject({ status: 403 });
  current.kind = 'staff';
  await withTx(db, scopeA, systemActor('test'), (tx) =>
    tx.execute(
      sql`UPDATE app.vendor_accounts SET active = false WHERE tenant_id = ${scopeA.tenantId} AND organization_id = ${scopeA.organizationId} AND vendor_id = ${vendorId}`,
    ),
  );
  try {
    await expect(service.create({ ...file, vendorPartyId: vendorId })).rejects.toMatchObject({
      status: 404,
    });
    await expect(send()).rejects.toMatchObject({ status: 404 });
    expect(scan.add).not.toHaveBeenCalled();
  } finally {
    await withTx(db, scopeA, systemActor('test'), (tx) =>
      tx.execute(
        sql`UPDATE app.vendor_accounts SET active = true WHERE tenant_id = ${scopeA.tenantId} AND organization_id = ${scopeA.organizationId} AND vendor_id = ${vendorId}`,
      ),
    );
  }
});

it('refuses a different owner type or a vendor owner without an active account', async () => {
  for (const changeOwner of [sql`owner_type = 'another_owner'`, sql`owner_id = ${randomUUID()}`]) {
    const created = await service.create({ ...file, vendorPartyId: vendorId });
    await withTx(db, scopeA, systemActor('test'), (tx) =>
      tx.execute(sql`UPDATE app.documents SET ${changeOwner} WHERE id = ${created.documentId}`),
    );
    await expect(
      service.receive(created.documentId, created.versionId, Readable.from('data'), 4),
    ).rejects.toMatchObject({ status: 404 });
  }
});

it('preserves kernel type and size limits and queues one scan when two uploads race', async () => {
  await expect(
    service.create({ ...file, vendorPartyId: vendorId, declaredMime: 'application/x-executable' }),
  ).rejects.toMatchObject({ status: 415 });
  await expect(
    service.create({ ...file, vendorPartyId: vendorId, sizeBytes: MAX_UPLOAD_BYTES + 1 }),
  ).rejects.toMatchObject({ status: 413 });
  const bytes = Buffer.from('%PDF-1.7\nbill invoice\n');
  const created = await service.create({
    ...file,
    vendorPartyId: vendorId,
    sizeBytes: bytes.length,
  });
  const results = await Promise.allSettled(
    [1, 2].map(() =>
      service.receive(created.documentId, created.versionId, Readable.from(bytes), bytes.length),
    ),
  );
  expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  expect(results.find((result) => result.status === 'rejected')).toMatchObject({
    reason: { status: 409 },
  });
  expect(scan.add).toHaveBeenCalledTimes(1);
});
