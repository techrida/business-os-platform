// A portal customer uploads payment proof through the owner policy's allowsCounterparty (P3 U5), against
// Postgres. Real: Postgres 16 (Testcontainers, migrations as bos_owner, queries as bos_app), withTx and the
// bos.* settings, AuthzService.assert reading the principal bound in the request store, the storage on a temp
// dir and the type check. Fakes: audit and the scan queue (BullMQ), as in documents.integration.test.ts.
// The owner is a test table `app.it_payments` whose policy asks Postgres, inside the upload transaction,
// whether the payment names the caller's party.
//
// The generic routes keep @Can('documents.upload'), which a customer fails, so this drives the service the
// way a portal route will: inside the customer's request, through withTx.
// Needs Docker. Run: pnpm --filter @bos/api exec vitest run src/platform/documents/documents.customer-upload.integration.test.ts
import 'reflect-metadata';

import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import type { CreateDocumentBody, Permission, Scope } from '@bos/contracts';
import { createTenantWithEntity } from '@bos/db';
import { ForbiddenException } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { AuthzService } from '../authz/authz.service';
import type { Principal, ResourceRef } from '../authz/can';
import type { RoleCache } from '../authz/role-cache';
import type { Db } from '../db/db.module';
import { withTx, type Actor, type TxScope } from '../db/tx';
import { bindIdentity, bindPrincipal, runWithRequestStore } from '../tenancy/request-context';
import type { DocumentOwnerPolicy } from './documents.ports';
import { DocumentsService } from './documents.service';
import { SignedLinks, type LinkStore } from './signed-link';
import { DiskStorageAdapter } from './storage.adapter';
import { createTestDatabase, type TestDatabase } from '@bos/db/testing';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 180_000 });

const SECRET = 'an-integration-test-secret-of-32-plus-chars';
const OWNER_TYPE = 'it_payment';
const CUSTOMER = randomUUID();
const OTHER_CUSTOMER = randomUUID();
const PARTY = randomUUID();
const OTHER_PARTY = randomUUID();

const PDF = () => Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF\n');
const EXE = () => Buffer.concat([Buffer.from('MZ'), Buffer.alloc(300)]);

class MemoryStore implements LinkStore {
  claim(): Promise<boolean> {
    return Promise.resolve(true);
  }
}

let testDb: TestDatabase;
let pool: Pool;
let db: Db;
let storageRoot: string;
let service: DocumentsService;
let scope: TxScope;

const audit = { record: vi.fn().mockResolvedValue(undefined) };
const queue = { add: vi.fn().mockResolvedValue({}) };

/**
 * The payment owner: a customer may attach to a payment that names their party. Both reads go through
 * Postgres; the hook uses the upload's own transaction, so it sees the bos.* scope that withTx set.
 */
const paymentPolicy: DocumentOwnerPolicy = {
  ownerType: OWNER_TYPE,
  async resource(s: TxScope, ownerId: string): Promise<ResourceRef | null> {
    const { rows } = await pool.query<{ customer_party_id: string }>(
      `SELECT customer_party_id FROM app.it_payments
        WHERE id = $1 AND tenant_id = $2 AND organization_id = $3`,
      [ownerId, s.tenantId, s.organizationId],
    );
    const found = rows[0];
    if (found === undefined) return null;
    return {
      tenantId: s.tenantId,
      organizationId: s.organizationId,
      customerPartyId: found.customer_party_id,
      sodUserIds: [],
    };
  },
  async allowsCounterparty(principal, ownerId, tx) {
    const res = await tx.execute(sql`SELECT 1 AS ok FROM app.it_payments
      WHERE id = ${ownerId}
        AND tenant_id = current_setting('bos.tenant_id')::uuid
        AND organization_id = current_setting('bos.organization_id')::uuid
        AND customer_party_id = ${principal.partyId}::uuid`);
    return res.rows.length === 1;
  },
};

beforeAll(async () => {
  testDb = await createTestDatabase();
  const admin = new Pool({ connectionString: testDb.adminUrl, max: 1 });
  await admin.end();
  const bosAdmin = new Pool({ connectionString: testDb.adminUrl, max: 1 });
  // The test owner table: created by the superuser, readable by the app role, like any owner module's table.
  await bosAdmin.query(`CREATE TABLE app.it_payments (
    id uuid PRIMARY KEY,
    tenant_id uuid NOT NULL,
    organization_id uuid NOT NULL,
    customer_party_id uuid NOT NULL)`);
  await bosAdmin.query('GRANT SELECT, INSERT ON app.it_payments TO bos_app');
  await bosAdmin.end();

  pool = new Pool({ connectionString: testDb.appUrl, max: 8 });
  db = drizzle({ client: pool });
  const { tenantId, organizationId } = await createTenantWithEntity(pool);
  scope = { tenantId, organizationId };

  storageRoot = await mkdtemp(join(tmpdir(), 'bos-docs-cust-it-'));
  service = new DocumentsService(
    db,
    new DiskStorageAdapter(storageRoot),
    new SignedLinks(SECRET, new MemoryStore(), () => Date.now()),
    queue as unknown as Queue,
    // The real decision: a customer holds no documents.upload, so without the hook this throws the real 403.
    new AuthzService(db, {} as RoleCache),
    audit,
  );
  service.registerOwner(paymentPolicy);
});

afterAll(async () => {
  await pool?.end();
  await testDb?.drop();
  if (storageRoot) await rm(storageRoot, { recursive: true, force: true });
});

beforeEach(() => {
  audit.record.mockClear();
  queue.add.mockReset().mockResolvedValue({});
});

// ---------------------------------------------------------------------------------------- helpers

function customer(userId: string, partyId: string): Principal {
  return {
    userId,
    zitadelUserId: `zitadel-${userId}`,
    tenantId: scope.tenantId,
    organizationId: scope.organizationId,
    orgKind: 'customer',
    partyId,
    idpOrgId: randomUUID(),
    roles: ['customer_user'],
    departmentId: null,
    status: 'active',
    grants: new Map<Permission, Scope>(),
  };
}

const staffWithoutGrant = (): Principal => ({
  ...customer(randomUUID(), PARTY),
  orgKind: 'staff',
  partyId: null,
  roles: ['sales'],
});

const actorOf = (p: Principal): Actor => ({
  kind: 'user',
  id: p.userId,
  correlationId: 'it-correlation',
});

/** Runs `fn` as the request of `p`, as the tenancy interceptor binds it. */
function asCaller<T>(p: Principal, fn: () => Promise<T>): Promise<T> {
  return runWithRequestStore('it-correlation', () => {
    bindIdentity({
      tenantId: p.tenantId,
      organizationId: p.organizationId,
      orgKind: p.orgKind,
      partyId: p.partyId,
      idpOrgId: p.idpOrgId,
      userId: p.zitadelUserId,
      roles: p.roles,
      departmentId: p.departmentId,
      tokenExp: Math.floor(Date.now() / 1000) + 300,
    });
    bindPrincipal(p);
    return fn();
  });
}

async function newPayment(partyId: string): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO app.it_payments (id, tenant_id, organization_id, customer_party_id)
     VALUES ($1, $2, $3, $4)`,
    [id, scope.tenantId, scope.organizationId, partyId],
  );
  return id;
}

const proofBody = (ownerId: string, bytes: Buffer): CreateDocumentBody => ({
  ownerType: OWNER_TYPE,
  ownerId,
  filename: 'transfer-receipt.pdf',
  declaredMime: 'application/pdf',
  sizeBytes: bytes.length,
});

const createAs = (p: Principal, b: CreateDocumentBody) =>
  asCaller(p, () => withTx(db, scope, actorOf(p), (tx) => service.create(tx, b)));

const receiveAs = (p: Principal, versionId: string, documentId: string, bytes: Buffer) =>
  asCaller(p, () =>
    service.receiveContent(versionId, Readable.from(bytes), bytes.length, {
      documentId,
      who: { scope, actor: actorOf(p) },
    }),
  );

async function documentsOf(ownerId: string): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(
    'SELECT count(*) AS n FROM app.documents WHERE owner_type = $1 AND owner_id = $2',
    [OWNER_TYPE, ownerId],
  );
  return Number(rows[0]?.n ?? 0);
}

async function statusOf(versionId: string): Promise<string | undefined> {
  const { rows } = await pool.query<{ status: string }>(
    'SELECT status FROM app.document_versions WHERE id = $1',
    [versionId],
  );
  return rows[0]?.status;
}

/** The 403 body, or a marker when the call did not refuse with a 403. */
const forbiddenBody = (call: Promise<unknown>): Promise<string> =>
  call.then(
    () => 'resolved',
    (e: unknown) =>
      e instanceof ForbiddenException
        ? JSON.stringify(e.getResponse())
        : `other: ${e instanceof Error ? e.message : 'not an Error'}`,
  );

// -------------------------------------------------------------------------------------------- tests

describe('a customer uploading proof to their own payment', () => {
  it('creates the document as the customer and quarantines the bytes for the scan', async () => {
    const me = customer(CUSTOMER, PARTY);
    const paymentId = await newPayment(PARTY);
    const bytes = PDF();

    const created = await createAs(me, proofBody(paymentId, bytes));
    const { rows } = await pool.query<{ created_by: string | null; uploaded_by: string | null }>(
      `SELECT d.created_by, v.uploaded_by FROM app.documents d
         JOIN app.document_versions v ON v.document_id = d.id WHERE v.id = $1`,
      [created.versionId],
    );
    expect(rows).toEqual([{ created_by: CUSTOMER, uploaded_by: CUSTOMER }]);
    expect(await statusOf(created.versionId)).toBe('awaiting_content');

    const version = await receiveAs(me, created.versionId, created.documentId, bytes);

    // Not downloadable yet: the scan gate is unchanged, the file waits in quarantine for docs.scan.
    expect(version.status).toBe('quarantined');
    expect(await statusOf(created.versionId)).toBe('quarantined');
    expect(queue.add).toHaveBeenCalledTimes(1);
    expect(queue.add.mock.calls[0]?.[2]).toMatchObject({ jobId: created.versionId });
  });

  it('still rejects content that does not match the declared type', async () => {
    const me = customer(CUSTOMER, PARTY);
    const paymentId = await newPayment(PARTY);
    const exe = EXE();

    const created = await createAs(me, proofBody(paymentId, exe));
    await expect(receiveAs(me, created.versionId, created.documentId, exe)).rejects.toMatchObject({
      status: 415,
    });
    expect(await statusOf(created.versionId)).toBe('rejected');
    expect(queue.add).not.toHaveBeenCalled();
  });
});

describe('a customer and a payment that is not theirs', () => {
  it('refuses the create with the same 403 body staff without the grant get, and writes no row', async () => {
    const paymentId = await newPayment(PARTY);
    const bytes = PDF();

    const stranger = await forbiddenBody(
      createAs(customer(OTHER_CUSTOMER, OTHER_PARTY), proofBody(paymentId, bytes)),
    );
    const staff = await forbiddenBody(createAs(staffWithoutGrant(), proofBody(paymentId, bytes)));

    expect(stranger).toContain('"code":"forbidden"');
    expect(stranger).toBe(staff);
    expect(await documentsOf(paymentId)).toBe(0);
  });

  it('refuses another customer sending the bytes of a version the payer created, and leaves it untouched', async () => {
    const paymentId = await newPayment(PARTY);
    const bytes = PDF();
    const created = await createAs(customer(CUSTOMER, PARTY), proofBody(paymentId, bytes));

    const body = await forbiddenBody(
      receiveAs(
        customer(OTHER_CUSTOMER, OTHER_PARTY),
        created.versionId,
        created.documentId,
        bytes,
      ),
    );

    expect(body).toContain('"code":"forbidden"');
    expect(await statusOf(created.versionId)).toBe('awaiting_content');
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('answers 404 for a payment that does not exist in the entity', async () => {
    await expect(
      createAs(customer(CUSTOMER, PARTY), proofBody(randomUUID(), PDF())),
    ).rejects.toMatchObject({ status: 404 });
  });
});
