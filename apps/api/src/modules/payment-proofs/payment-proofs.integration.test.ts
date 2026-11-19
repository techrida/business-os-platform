// Portal and staff payment-proof uploads (P3 U13 part 2) on a real postgres:16-alpine (Testcontainers, needs Docker
// in WSL).
// Run with: pnpm --filter @bos/api exec vitest run src/modules/payment-proofs/payment-proofs.integration.test.ts
//
// Real: every migration as bos_owner, every query as bos_app, the portal controller's handlers called inside a
// request store bound to the customer's principal (as the tenancy interceptor binds it; the route's @Can is checked
// by route-policy.check.test.ts once AppModule imports the module), DocumentsService with the real AuthzService and
// the real `payment_intake` owner policy (with its `payment.record` upload permission; staff principals carry the
// seeded DEFAULT_ROLE_PERMISSIONS of their role), the disk storage on a temp dir, the type check, the ScanProcessor talking
// the clamd protocol to fake-clamd, and PaymentsService.submit's proof check. Fakes: the BullMQ scan queue (the
// test hands the captured job to the processor), notify, and PaymentsService's authz (its route @Can is not tested
// here).
import 'reflect-metadata';

import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import {
  DEFAULT_ROLE_PERMISSIONS,
  type Permission,
  type RoleKey,
  type Scope,
  type SubmitPaymentBody,
} from '@bos/contracts';
import {
  createParty,
  createPortalUser,
  createStaffUser,
  createTenantWithEntity,
  runMigrations,
} from '@bos/db';
import { HttpException } from '@nestjs/common';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { Queue } from 'bullmq';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { Request } from 'express';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { AuditService } from '../../platform/audit/audit.service';
import { AuthzService } from '../../platform/authz/authz.service';
import type { Principal } from '../../platform/authz/principal';
import type { RoleCache } from '../../platform/authz/role-cache';
import type { Db } from '../../platform/db/db.module';
import type { TxScope } from '../../platform/db/tx';
import { ClamdClient } from '../../platform/documents/clamd.client';
import type { ScanJobData } from '../../platform/documents/documents.ports';
import { DocumentsService } from '../../platform/documents/documents.service';
import { startFakeClamd, type FakeClamd } from '../../platform/documents/fake-clamd';
import { ScanProcessor } from '../../platform/documents/scan.processor';
import { SignedLinks, type LinkStore } from '../../platform/documents/signed-link';
import { DiskStorageAdapter } from '../../platform/documents/storage.adapter';
import { MoneyService } from '../../platform/settings/money.service';
import { NumberingService } from '../../platform/settings/numbering.service';
import type { CurrencyEnabledService } from '../../platform/settings/currency-enabled';
import type { SettingsService } from '../../platform/settings/settings.service';
import {
  bindIdentity,
  bindPrincipal,
  runWithRequestStore,
} from '../../platform/tenancy/request-context';
import { LedgerService } from '../ledger/ledger.service';
import {
  drizzleCustomerPartyLoader,
  PAYMENT_INTAKE_OWNER_TYPE,
  PaymentIntakeOwnerPolicy,
} from '../payments/payment-owner.policy';
import { PaymentsService } from '../payments/payments.service';
import { PaymentProofsService } from './payment-proofs.service';
import { PortalPaymentProofsController } from './portal-payment-proofs.controller';
import { StaffPaymentProofsController } from './staff-payment-proofs.controller';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 180_000 });

const OWNER_PW = 'owner-test-pw';
const APP_PW = 'app-test-pw';
const SECRET = 'an-integration-test-secret-of-32-plus-chars';
const NOW = new Date('2026-11-09T06:00:00Z');

const PDF = () => Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF\n');

class MemoryStore implements LinkStore {
  claim(): Promise<boolean> {
    return Promise.resolve(true);
  }
}

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: Db;
let storageRoot: string;
let fakeClamd: FakeClamd;
let processor: ScanProcessor;
let payments: PaymentsService;
let controller: PortalPaymentProofsController;
let staffController: StaffPaymentProofsController;

const queue = { add: vi.fn().mockResolvedValue({}) };
const notify = { notifyUser: vi.fn().mockResolvedValue(undefined) };

const urlFor = (user: string, password: string, database: string) => {
  const url = new URL(container.getConnectionUri());
  url.username = user;
  url.password = password;
  url.pathname = `/${database}`;
  return url.toString();
};

interface World {
  scope: TxScope;
  /** The caller: a portal user of `party`. */
  me: Principal;
  party: string;
  /** Another customer of the same tenant, with its own portal user. */
  stranger: Principal;
  strangerParty: string;
  /** The tenant's staff IdP org, for staff users. */
  staffIdpOrgId: string;
}

function customerPrincipal(
  scope: TxScope,
  userId: string,
  party: string,
  idpOrgId: string,
): Principal {
  return {
    userId,
    zitadelUserId: `zitadel-${userId}`,
    tenantId: scope.tenantId,
    organizationId: scope.organizationId,
    orgKind: 'customer',
    partyId: party,
    idpOrgId,
    roles: ['customer_user'],
    departmentId: null,
    status: 'active',
    grants: new Map<Permission, Scope>([['portal.payment.submit', 'customer_org']]),
  };
}

async function newWorld(): Promise<World> {
  const { tenantId, organizationId, idpOrgId } = await createTenantWithEntity(pool);
  const scope = { tenantId, organizationId };
  const mine = await createParty(pool, { tenantId, kind: 'customer' });
  const theirs = await createParty(pool, { tenantId, kind: 'customer' });
  const meUser = await createPortalUser(pool, { tenantId, idpOrgId: mine.idpOrgId });
  const strangerUser = await createPortalUser(pool, { tenantId, idpOrgId: theirs.idpOrgId });
  return {
    scope,
    me: customerPrincipal(scope, meUser.userId, mine.partyId, mine.idpOrgId),
    party: mine.partyId,
    stranger: customerPrincipal(scope, strangerUser.userId, theirs.partyId, theirs.idpOrgId),
    strangerParty: theirs.partyId,
    staffIdpOrgId: idpOrgId,
  };
}

/** Runs `fn` as the HTTP request of `p`, as the tenancy interceptor binds it. */
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

/** A raw PUT body as Express hands it to the handler: the request stream itself, with its Content-Length. */
function rawRequest(bytes: Buffer): Request {
  return Object.assign(Readable.from(bytes), {
    headers: { 'content-length': String(bytes.length) },
  }) as unknown as Request;
}

const declare = (bytes: Buffer, extra: Record<string, unknown> = {}) => ({
  filename: 'bank-slip.pdf',
  declaredMime: 'application/pdf',
  sizeBytes: bytes.length,
  ...extra,
});

const createAs = (p: Principal, body: unknown) => asCaller(p, () => controller.create(body));

const putAs = (p: Principal, docId: string, verId: string, bytes: Buffer) =>
  asCaller(p, () => controller.upload(docId, verId, rawRequest(bytes)));

/** The status and response body of a refusal, or a marker when the call did not refuse. */
const refusal = (call: Promise<unknown>): Promise<string> =>
  call.then(
    () => 'resolved',
    (e: unknown) =>
      e instanceof HttpException
        ? `${e.getStatus()} ${JSON.stringify(e.getResponse())}`
        : `other: ${e instanceof Error ? e.message : 'not an Error'}`,
  );

async function statusOf(versionId: string): Promise<string | undefined> {
  const { rows } = await pool.query<{ status: string }>(
    'SELECT status FROM app.document_versions WHERE id = $1',
    [versionId],
  );
  return rows[0]?.status;
}

/** The scan job the upload queued, handed to the real processor (which asks fake-clamd). */
async function runQueuedScan(versionId: string): Promise<string> {
  const call = queue.add.mock.calls.find((c) => (c[1] as ScanJobData).versionId === versionId);
  if (call === undefined) throw new Error(`no scan was queued for ${versionId}`);
  return processor.scanVersion(call[1] as ScanJobData, true);
}

function portalSubmit(w: World, documentId: string) {
  const body: SubmitPaymentBody = {
    customerId: w.party,
    currency: 'NPR',
    amount: '600.00',
    tdsWithheld: '0.00',
    method: 'bank_transfer',
    receivedOn: '2026-11-08',
    proofDocumentIds: [documentId],
  };
  const actor = { kind: 'user' as const, id: w.me.userId, correlationId: `it-${randomUUID()}` };
  return payments.submit(w.scope, actor, body, 'portal', randomUUID());
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  const admin = new Pool({ connectionString: container.getConnectionUri(), max: 1 });
  await admin.query(`CREATE ROLE bos_owner LOGIN PASSWORD '${OWNER_PW}'`);
  await admin.query(`CREATE ROLE bos_app LOGIN PASSWORD '${APP_PW}'`);
  await admin.query('CREATE DATABASE bos OWNER bos_owner');
  await admin.query('REVOKE ALL ON DATABASE bos FROM PUBLIC');
  await admin.query('GRANT CONNECT ON DATABASE bos TO bos_app');
  await admin.end();
  const bosAdmin = new Pool({ connectionString: urlFor('test', 'test', 'bos'), max: 1 });
  await bosAdmin.query(
    'ALTER DEFAULT PRIVILEGES FOR ROLE bos_owner GRANT USAGE ON SCHEMAS TO bos_app',
  );
  await bosAdmin.query(
    'ALTER DEFAULT PRIVILEGES FOR ROLE bos_owner GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO bos_app',
  );
  await bosAdmin.end();
  await runMigrations(urlFor('bos_owner', OWNER_PW, 'bos'));

  pool = new Pool({ connectionString: urlFor('bos_app', APP_PW, 'bos'), max: 12 });
  pool.on('error', () => undefined);
  db = drizzle({ client: pool });
  const audit = new AuditService(db);

  storageRoot = await mkdtemp(join(tmpdir(), 'bos-payment-proofs-it-'));
  const storage = new DiskStorageAdapter(storageRoot);
  const documents = new DocumentsService(
    db,
    storage,
    new SignedLinks(SECRET, new MemoryStore(), () => Date.now()),
    queue as unknown as Queue,
    // The real decision: a customer holds no documents.upload, so only the intake policy's hook lets it upload.
    new AuthzService(db, {} as RoleCache),
    audit,
  );
  documents.registerOwner(new PaymentIntakeOwnerPolicy(drizzleCustomerPartyLoader(db)));
  const proofs = new PaymentProofsService(db, documents);
  controller = new PortalPaymentProofsController(proofs);
  staffController = new StaffPaymentProofsController(proofs);

  fakeClamd = await startFakeClamd();
  processor = new ScanProcessor(
    db,
    storage,
    new ClamdClient({ host: fakeClamd.host, port: fakeClamd.port, timeoutMs: 5_000 }),
    audit,
    notify,
  );

  const settings = { get: () => Promise.resolve(7) } as unknown as SettingsService;
  // Every currency passes here; the refusal of a disabled one is unit-tested in payments.currency.test.ts.
  const currencies = {
    assertEnabled: () => Promise.resolve(),
  } as unknown as CurrencyEnabledService;
  payments = new PaymentsService(
    db,
    { assert: () => undefined } as unknown as AuthzService,
    new MoneyService(db, settings),
    new NumberingService(),
    audit,
    new LedgerService(),
    currencies,
    () => NOW,
  );
}, 180_000);

afterAll(async () => {
  await fakeClamd?.close();
  await pool?.end();
  await container?.stop();
  if (storageRoot) await rm(storageRoot, { recursive: true, force: true });
});

beforeEach(() => {
  queue.add.mockReset().mockResolvedValue({});
});

describe('POST /v1/portal/payment-proofs', () => {
  it("creates a payment_intake document owned by the caller's party, whatever owner the body names", async () => {
    const w = await newWorld();
    const bytes = PDF();

    const created = await createAs(
      w.me,
      declare(bytes, { ownerType: 'payment', ownerId: w.strangerParty }),
    );

    expect(created.uploadPath).toBe(
      `/v1/portal/payment-proofs/${created.documentId}/versions/${created.versionId}/content`,
    );
    const { rows } = await pool.query<{
      owner_type: string;
      owner_id: string;
      created_by: string;
      status: string;
    }>(
      `SELECT d.owner_type, d.owner_id, d.created_by, v.status FROM app.documents d
         JOIN app.document_versions v ON v.document_id = d.id WHERE v.id = $1`,
      [created.versionId],
    );
    expect(rows).toEqual([
      {
        owner_type: PAYMENT_INTAKE_OWNER_TYPE,
        owner_id: w.party,
        created_by: w.me.userId,
        status: 'awaiting_content',
      },
    ]);
  });

  it('refuses a staff caller holding portal.payment.submit (a founder) with 403 and writes no row', async () => {
    const w = await newWorld();
    const founder: Principal = { ...w.me, orgKind: 'staff', partyId: null, roles: ['founder'] };

    const body = await refusal(createAs(founder, declare(PDF())));

    expect(body).toMatch(/^403 .*"code":"forbidden"/);
    const { rows } = await pool.query('SELECT 1 FROM app.documents WHERE tenant_id = $1', [
      w.scope.tenantId,
    ]);
    expect(rows).toHaveLength(0);
  });

  it('keeps the documents type and size limits', async () => {
    const w = await newWorld();
    await expect(
      createAs(w.me, declare(PDF(), { declaredMime: 'application/x-msdownload' })),
    ).rejects.toMatchObject({ status: 415 });
    await expect(createAs(w.me, declare(PDF(), { sizeBytes: 1024 ** 3 }))).rejects.toMatchObject({
      status: 413,
    });
  });
});

describe('PUT /v1/portal/payment-proofs/:docId/versions/:verId/content', () => {
  it('quarantines the bytes and queues the scan', async () => {
    const w = await newWorld();
    const bytes = PDF();
    const created = await createAs(w.me, declare(bytes));

    const version = await putAs(w.me, created.documentId, created.versionId, bytes);

    expect(version.status).toBe('quarantined');
    expect(queue.add).toHaveBeenCalledTimes(1);
    expect(queue.add.mock.calls[0]?.[2]).toMatchObject({ jobId: created.versionId });
  });

  it("answers another party's document with the same 404 as an id that does not exist, and leaves it untouched", async () => {
    const w = await newWorld();
    const bytes = PDF();
    const created = await createAs(w.me, declare(bytes));

    const foreign = await refusal(putAs(w.stranger, created.documentId, created.versionId, bytes));
    const missing = await refusal(putAs(w.stranger, randomUUID(), randomUUID(), bytes));
    const mismatched = await refusal(putAs(w.me, randomUUID(), created.versionId, bytes));
    const malformed = await refusal(putAs(w.stranger, 'not-a-uuid', created.versionId, bytes));

    expect(foreign).toMatch(/^404 /);
    expect(missing).toBe(foreign);
    expect(mismatched).toBe(foreign);
    expect(malformed).toBe(foreign);
    expect(await statusOf(created.versionId)).toBe('awaiting_content');
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('answers the same 404 to the owner acting in another entity of the tenant', async () => {
    const w = await newWorld();
    const bytes = PDF();
    const created = await createAs(w.me, declare(bytes));
    const foreign = await refusal(putAs(w.stranger, created.documentId, created.versionId, bytes));
    // No fixture adds a second entity to a tenant; any other organization id exercises the entity filter.
    const elsewhere: Principal = { ...w.me, organizationId: randomUUID() };

    const crossEntity = await refusal(
      putAs(elsewhere, created.documentId, created.versionId, bytes),
    );

    expect(crossEntity).toBe(foreign);
    expect(await statusOf(created.versionId)).toBe('awaiting_content');
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('refuses a second PUT of the same version with 409 and queues one scan', async () => {
    const w = await newWorld();
    const bytes = PDF();
    const created = await createAs(w.me, declare(bytes));

    const results = await Promise.allSettled([
      putAs(w.me, created.documentId, created.versionId, bytes),
      putAs(w.me, created.documentId, created.versionId, bytes),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const [lost] = results.filter((r) => r.status === 'rejected');
    expect(lost?.reason).toMatchObject({ status: 409 });
    expect(queue.add).toHaveBeenCalledTimes(1);
  });
});

describe('the scan gate', () => {
  it('refuses the proof at submit until fake-clamd has scanned it clean, then accepts it', async () => {
    const w = await newWorld();
    const bytes = PDF();
    const created = await createAs(w.me, declare(bytes));
    await putAs(w.me, created.documentId, created.versionId, bytes);

    // Quarantined: the payment cannot use it yet.
    await expect(portalSubmit(w, created.documentId)).rejects.toMatchObject({
      response: { code: 'invalid_proof' },
    });

    const scansBefore = fakeClamd.scans.length;
    expect(await runQueuedScan(created.versionId)).toBe('clean');
    expect(fakeClamd.scans.length).toBe(scansBefore + 1);
    expect(fakeClamd.scans.at(-1)?.bytes).toBe(bytes.length);
    expect(await statusOf(created.versionId)).toBe('clean');

    const payment = await portalSubmit(w, created.documentId);
    expect(payment).toMatchObject({
      status: 'submitted',
      proofDocumentIds: [created.documentId],
    });
  });
});

// ------------------------------------------------------------------------------------------------ staff routes

interface StaffWorld extends World {
  /** An Accountant: holds payment.record, and no documents.upload at all. */
  accountant: Principal;
  /** A salesperson: documents.upload (own), no payment.record. */
  sales: Principal;
  vendorParty: string;
}

async function staffPrincipal(w: World, role: RoleKey): Promise<Principal> {
  const { userId } = await createStaffUser(pool, {
    ...w.scope,
    idpOrgId: w.staffIdpOrgId,
    roleKeys: [role],
  });
  return {
    userId,
    zitadelUserId: `zitadel-${userId}`,
    tenantId: w.scope.tenantId,
    organizationId: w.scope.organizationId,
    orgKind: 'staff',
    partyId: null,
    idpOrgId: w.staffIdpOrgId,
    roles: [role],
    departmentId: null,
    status: 'active',
    grants: new Map(Object.entries(DEFAULT_ROLE_PERMISSIONS[role])) as Map<Permission, Scope>,
  };
}

async function newStaffWorld(): Promise<StaffWorld> {
  const w = await newWorld();
  const vendor = await createParty(pool, { tenantId: w.scope.tenantId, kind: 'vendor' });
  return {
    ...w,
    accountant: await staffPrincipal(w, 'accountant'),
    sales: await staffPrincipal(w, 'sales'),
    vendorParty: vendor.partyId,
  };
}

const staffCreateAs = (p: Principal, body: unknown) =>
  asCaller(p, () => staffController.create(body));

const staffPutAs = (p: Principal, docId: string, verId: string, bytes: Buffer) =>
  asCaller(p, () => staffController.upload(docId, verId, rawRequest(bytes)));

async function documentCount(tenantId: string): Promise<number> {
  const { rows } = await pool.query('SELECT 1 FROM app.documents WHERE tenant_id = $1', [tenantId]);
  return rows.length;
}

describe('POST and PUT /v1/payment-proofs (staff)', () => {
  it('lets an Accountant (payment.record, no documents.upload) upload for a customer, and submit with it once clean', async () => {
    const w = await newStaffWorld();
    expect(w.accountant.grants.has('documents.upload')).toBe(false);
    expect(w.accountant.grants.get('payment.record')).toBe('all');
    const bytes = PDF();

    const created = await staffCreateAs(w.accountant, declare(bytes, { customerId: w.party }));
    expect(created.uploadPath).toBe(
      `/v1/payment-proofs/${created.documentId}/versions/${created.versionId}/content`,
    );
    const { rows } = await pool.query<{ owner_type: string; owner_id: string; created_by: string }>(
      'SELECT owner_type, owner_id, created_by FROM app.documents WHERE id = $1',
      [created.documentId],
    );
    expect(rows).toEqual([
      { owner_type: PAYMENT_INTAKE_OWNER_TYPE, owner_id: w.party, created_by: w.accountant.userId },
    ]);

    const version = await staffPutAs(w.accountant, created.documentId, created.versionId, bytes);
    expect(version.status).toBe('quarantined');
    expect(await runQueuedScan(created.versionId)).toBe('clean');

    const body: SubmitPaymentBody = {
      customerId: w.party,
      currency: 'NPR',
      amount: '600.00',
      tdsWithheld: '0.00',
      method: 'bank_transfer',
      receivedOn: '2026-11-08',
      proofDocumentIds: [created.documentId],
    };
    const actor = {
      kind: 'user' as const,
      id: w.accountant.userId,
      correlationId: `it-${randomUUID()}`,
    };
    const payment = await payments.submit(w.scope, actor, body, 'staff', randomUUID());
    expect(payment).toMatchObject({ status: 'submitted', proofDocumentIds: [created.documentId] });
  });

  it('refuses a user without payment.record (sales) with 403 on POST and on PUT, and writes nothing', async () => {
    const w = await newStaffWorld();
    expect(w.sales.grants.has('payment.record')).toBe(false);
    const bytes = PDF();
    const created = await staffCreateAs(w.accountant, declare(bytes, { customerId: w.party }));
    const before = await documentCount(w.scope.tenantId);

    const post = await refusal(staffCreateAs(w.sales, declare(bytes, { customerId: w.party })));
    const put = await refusal(staffPutAs(w.sales, created.documentId, created.versionId, bytes));

    expect(post).toMatch(/^403 .*"code":"forbidden"/);
    expect(put).toMatch(/^403 .*"code":"forbidden"/);
    expect(await documentCount(w.scope.tenantId)).toBe(before);
    expect(await statusOf(created.versionId)).toBe('awaiting_content');
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('refuses a portal customer on the staff route with 403, even for its own party', async () => {
    const w = await newStaffWorld();

    const body = await refusal(staffCreateAs(w.me, declare(PDF(), { customerId: w.party })));

    expect(body).toMatch(/^403 .*"code":"forbidden"/);
    expect(await documentCount(w.scope.tenantId)).toBe(0);
  });

  it('answers a customerId that is not a customer party of the tenant with one 404 and writes nothing', async () => {
    const w = await newStaffWorld();
    const other = await newWorld();
    const as = (customerId: string) =>
      refusal(staffCreateAs(w.accountant, declare(PDF(), { customerId })));

    const vendor = await as(w.vendorParty);
    const missing = await as(randomUUID());
    const otherTenant = await as(other.party);
    const malformed = await as('not-a-uuid');

    expect(vendor).toMatch(/^404 /);
    expect(missing).toBe(vendor);
    expect(otherTenant).toBe(vendor);
    expect(malformed).toBe(vendor);
    expect(await documentCount(w.scope.tenantId)).toBe(0);
  });

  it('answers the same 404 to a PUT from another entity of the tenant, and to ids that are not proofs', async () => {
    const w = await newStaffWorld();
    const bytes = PDF();
    const created = await staffCreateAs(w.accountant, declare(bytes, { customerId: w.party }));
    const missing = await refusal(staffPutAs(w.accountant, randomUUID(), randomUUID(), bytes));
    // No fixture adds a second entity to a tenant; any other organization id exercises the entity filter.
    const elsewhere: Principal = { ...w.accountant, organizationId: randomUUID() };

    const crossEntity = await refusal(
      staffPutAs(elsewhere, created.documentId, created.versionId, bytes),
    );
    const malformed = await refusal(
      staffPutAs(w.accountant, 'not-a-uuid', created.versionId, bytes),
    );

    expect(missing).toMatch(/^404 /);
    expect(crossEntity).toBe(missing);
    expect(malformed).toBe(missing);
    expect(await statusOf(created.versionId)).toBe('awaiting_content');
    expect(queue.add).not.toHaveBeenCalled();
  });
});
