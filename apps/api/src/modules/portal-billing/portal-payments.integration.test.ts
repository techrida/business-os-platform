// Integration test of the portal payments routes (P3 U13 part 3) on a real postgres:16-alpine (Testcontainers, needs
// Docker in WSL).
// Run with: pnpm --filter @bos/api exec vitest run src/modules/portal-billing/portal-payments.integration.test.ts
//
// Real: every migration as bos_owner, every query as bos_app, the controller's handlers called inside a request store
// bound to the caller's principal (as the tenancy interceptor binds it; the routes' @Can is checked by
// route-policy.check.test.ts once AppModule imports the module), PortalPaymentsService, the PaymentsService it calls
// with the real AuthzService (`portal.payment.submit` on the caller's party), DocumentsService with the real
// `payment_intake` owner policy, the portal proof upload route, the ScanProcessor talking the clamd protocol to
// fake-clamd, and the idempotency table. Fakes: the BullMQ scan queue (the test hands the captured job to the
// processor), notify, and a second PaymentsService with a no-op authz that only seeds the staff-recorded payments.
//
// It pins: a submit lands a `submitted` payment on channel `portal` for the caller's party only, and the strict body
// schema refuses a `customerId`; a proof uploaded by customer A and submitted by customer B is a 422 `invalid_proof`;
// the list shows only the caller's payments, newest first, as the eight-field whitelist with no staff field; a staff
// principal and a caller acting in a non-default entity are refused.
import 'reflect-metadata';

import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import {
  PortalPaymentListItemSchema,
  type Permission,
  type PortalSubmitPaymentBody,
  type Scope,
  type SubmitPaymentBody,
} from '@bos/contracts';
import { createParty, createPortalUser, createTenantWithEntity } from '@bos/db';
import { HttpException } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { Request } from 'express';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { AuditService } from '../../platform/audit/audit.service';
import { AuthzService } from '../../platform/authz/authz.service';
import type { Principal } from '../../platform/authz/principal';
import type { RoleCache } from '../../platform/authz/role-cache';
import type { Db } from '../../platform/db/db.module';
import { systemActor, withTx, type TxScope } from '../../platform/db/tx';
import { ClamdClient } from '../../platform/documents/clamd.client';
import type { ScanJobData } from '../../platform/documents/documents.ports';
import { DocumentsService } from '../../platform/documents/documents.service';
import { startFakeClamd, type FakeClamd } from '../../platform/documents/fake-clamd';
import { ScanProcessor } from '../../platform/documents/scan.processor';
import { SignedLinks, type LinkStore } from '../../platform/documents/signed-link';
import { DiskStorageAdapter } from '../../platform/documents/storage.adapter';
import { MoneyService } from '../../platform/settings/money.service';
import { NumberingService } from '../../platform/settings/numbering.service';
import type { SettingsService } from '../../platform/settings/settings.service';
import {
  bindIdentity,
  bindPrincipal,
  runWithRequestStore,
} from '../../platform/tenancy/request-context';
import { PaymentProofsService } from '../payment-proofs/payment-proofs.service';
import { PortalPaymentProofsController } from '../payment-proofs/portal-payment-proofs.controller';
import { LedgerService } from '../ledger/ledger.service';
import {
  drizzleCustomerPartyLoader,
  PaymentIntakeOwnerPolicy,
} from '../payments/payment-owner.policy';
import { PaymentsService } from '../payments/payments.service';
import { PortalCaller, PortalTxActor } from '../portal/portal.caller';
import { PortalPaymentsController } from './portal-payments.controller';
import { PortalPaymentsService } from './portal-payments.service';
import { createTestDatabase, type TestDatabase } from '@bos/db/testing';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 180_000 });

const SECRET = 'an-integration-test-secret-of-32-plus-chars';
const NOW = new Date('2026-11-09T06:00:00Z');

const PDF = () => Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF\n');

/** The eight keys of the portal whitelist, sorted. */
const WHITELIST = [
  'amount',
  'bankReference',
  'currency',
  'id',
  'method',
  'number',
  'receivedOn',
  'status',
];

class MemoryStore implements LinkStore {
  claim(): Promise<boolean> {
    return Promise.resolve(true);
  }
}

let testDb: TestDatabase;
let pool: Pool;
let db: Db;
let storageRoot: string;
let fakeClamd: FakeClamd;
let processor: ScanProcessor;
let staffPayments: PaymentsService;
let payments: PortalPaymentsController;
let proofs: PortalPaymentProofsController;

const queue = { add: vi.fn().mockResolvedValue({}) };
const notify = { notifyUser: vi.fn().mockResolvedValue(undefined) };
const seedActor = systemActor('portal-payments-test-seed');

interface World {
  /** The tenant's default entity. */
  scope: TxScope;
  /** A second, non-default legal entity of the same tenant. */
  entityB: string;
  /** The caller: a portal user of `party`. */
  me: Principal;
  party: string;
  /** Another customer of the same tenant, with its own portal user. */
  stranger: Principal;
  strangerParty: string;
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
    grants: new Map<Permission, Scope>([
      ['portal.invoice.read', 'customer_org'],
      ['portal.payment.submit', 'customer_org'],
    ]),
  };
}

async function newWorld(): Promise<World> {
  const { tenantId, organizationId } = await createTenantWithEntity(pool);
  const scope = { tenantId, organizationId };
  const entityB = randomUUID();
  await withTx(db, scope, seedActor, (tx) =>
    tx.execute(sql`
      INSERT INTO app.organizations (id, tenant_id, organization_id, name, code, legal_name, is_default)
      VALUES (${entityB}, ${tenantId}, ${entityB}, ${`E-${entityB}`}, ${`E-${entityB.slice(0, 8)}`},
              ${`E-${entityB}`}, false)`),
  );
  const mine = await createParty(pool, { tenantId, kind: 'customer' });
  const theirs = await createParty(pool, { tenantId, kind: 'customer' });
  const meUser = await createPortalUser(pool, { tenantId, idpOrgId: mine.idpOrgId });
  const strangerUser = await createPortalUser(pool, { tenantId, idpOrgId: theirs.idpOrgId });
  return {
    scope,
    entityB,
    me: customerPrincipal(scope, meUser.userId, mine.partyId, mine.idpOrgId),
    party: mine.partyId,
    stranger: customerPrincipal(scope, strangerUser.userId, theirs.partyId, theirs.idpOrgId),
    strangerParty: theirs.partyId,
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

/** The status and response body of a refusal, or a marker when the call did not refuse. */
const refusal = (call: Promise<unknown>): Promise<string> =>
  call.then(
    () => 'resolved',
    (e: unknown) =>
      e instanceof HttpException
        ? `${e.getStatus()} ${JSON.stringify(e.getResponse())}`
        : `other: ${e instanceof Error ? e.message : 'not an Error'}`,
  );

/** Uploads a PDF as `p` through the portal proof route and has fake-clamd scan it clean. Returns the document id. */
async function cleanProof(p: Principal): Promise<string> {
  const bytes = PDF();
  const created = await asCaller(p, () =>
    proofs.create({
      filename: 'bank-slip.pdf',
      declaredMime: 'application/pdf',
      sizeBytes: bytes.length,
    }),
  );
  await asCaller(p, () => proofs.upload(created.documentId, created.versionId, rawRequest(bytes)));
  const call = queue.add.mock.calls.find(
    (c) => (c[1] as ScanJobData).versionId === created.versionId,
  );
  if (call === undefined) throw new Error(`no scan was queued for ${created.versionId}`);
  expect(await processor.scanVersion(call[1] as ScanJobData, true)).toBe('clean');
  return created.documentId;
}

const bodyOf = (
  documentId: string,
  extra: Partial<PortalSubmitPaymentBody> = {},
): PortalSubmitPaymentBody => ({
  currency: 'NPR',
  amount: '600.00',
  tdsWithheld: '0.00',
  method: 'bank_transfer',
  receivedOn: '2026-11-08',
  bankReference: 'TXN-1001',
  proofDocumentIds: [documentId],
  ...extra,
});

const submitAs = (p: Principal, body: unknown, key: string = randomUUID()) =>
  // async: a handler that throws before it returns a promise (the 400s) must still reject, as Nest turns it into a response.
  asCaller(p, async () => payments.submit(key, body));

const listAs = (p: Principal) => asCaller(p, async () => payments.list());

/** A payment the staff recorded for `party` (channel staff), seeded through a PaymentsService with a no-op authz. */
async function seedStaffPayment(w: World, party: string, documentId: string, amount: string) {
  const body: SubmitPaymentBody = {
    customerId: party,
    currency: 'NPR',
    amount,
    tdsWithheld: '0.00',
    method: 'cheque',
    receivedOn: '2026-11-07',
    bankReference: 'CHQ-77',
    proofDocumentIds: [documentId],
  };
  const actor = { kind: 'user' as const, id: w.me.userId, correlationId: `it-${randomUUID()}` };
  return staffPayments.submit(w.scope, actor, body, 'staff', randomUUID());
}

async function paymentRows(tenantId: string) {
  const { rows } = await pool.query<{
    id: string;
    customer_party_id: string;
    channel: string;
    status: string;
    submitted_by: string;
    organization_id: string;
  }>(
    `SELECT id, customer_party_id, channel, status, submitted_by, organization_id
       FROM app.payments WHERE tenant_id = $1 ORDER BY created_at`,
    [tenantId],
  );
  return rows;
}

beforeAll(async () => {
  testDb = await createTestDatabase();
  const admin = new Pool({ connectionString: testDb.adminUrl, max: 1 });
  await admin.end();
  const bosAdmin = new Pool({ connectionString: testDb.adminUrl, max: 1 });
  await bosAdmin.end();

  pool = new Pool({ connectionString: testDb.appUrl, max: 12 });
  pool.on('error', () => undefined);
  db = drizzle({ client: pool });
  const audit = new AuditService(db);
  const authz = new AuthzService(db, {} as RoleCache);

  storageRoot = await mkdtemp(join(tmpdir(), 'bos-portal-payments-it-'));
  const storage = new DiskStorageAdapter(storageRoot);
  const documents = new DocumentsService(
    db,
    storage,
    new SignedLinks(SECRET, new MemoryStore(), () => Date.now()),
    queue as unknown as Queue,
    authz,
    audit,
  );
  documents.registerOwner(new PaymentIntakeOwnerPolicy(drizzleCustomerPartyLoader(db)));
  proofs = new PortalPaymentProofsController(new PaymentProofsService(db, documents));

  fakeClamd = await startFakeClamd();
  processor = new ScanProcessor(
    db,
    storage,
    new ClamdClient({ host: fakeClamd.host, port: fakeClamd.port, timeoutMs: 5_000 }),
    audit,
    notify,
  );

  const settings = { get: () => Promise.resolve(7) } as unknown as SettingsService;
  const money = new MoneyService(db, settings);
  const numbering = new NumberingService();
  const ledger = new LedgerService();
  // The real decision for the portal path; the staff service only seeds rows.
  const realPayments = new PaymentsService(db, authz, money, numbering, audit, ledger, () => NOW);
  staffPayments = new PaymentsService(
    db,
    { assert: () => undefined } as unknown as AuthzService,
    money,
    numbering,
    audit,
    ledger,
    () => NOW,
  );
  payments = new PortalPaymentsController(
    new PortalPaymentsService(new PortalCaller(), new PortalTxActor(), db, realPayments),
  );
}, 180_000);

afterAll(async () => {
  await fakeClamd?.close();
  await pool?.end();
  await testDb?.drop();
  if (storageRoot) await rm(storageRoot, { recursive: true, force: true });
});

beforeEach(() => {
  queue.add.mockReset().mockResolvedValue({});
});

describe('POST /v1/portal/payments', () => {
  it('refuses a real vendor portal principal for submit, list and proof upload, and writes nothing', async () => {
    const w = await newWorld();
    const doc = await cleanProof(w.me);
    const vendor = await createParty(pool, { tenantId: w.scope.tenantId, kind: 'vendor' });
    const user = await createPortalUser(pool, {
      tenantId: w.scope.tenantId,
      idpOrgId: vendor.idpOrgId,
    });
    const principal: Principal = {
      ...w.me,
      userId: user.userId,
      idpOrgId: vendor.idpOrgId,
      partyId: vendor.partyId,
      orgKind: 'vendor',
      roles: ['vendor_user'],
    };
    const documentsBefore = await pool.query(
      'SELECT id FROM app.documents WHERE tenant_id = $1 ORDER BY id',
      [w.scope.tenantId],
    );
    expect(await refusal(submitAs(principal, bodyOf(doc)))).toMatch(/^403 .*"code":"forbidden"/);
    expect(await refusal(listAs(principal))).toMatch(/^403 .*"code":"forbidden"/);
    expect(
      await refusal(
        asCaller(principal, () =>
          proofs.create({
            filename: 'vendor-slip.pdf',
            declaredMime: 'application/pdf',
            sizeBytes: PDF().length,
          }),
        ),
      ),
    ).toMatch(/^403 /);
    expect(await paymentRows(w.scope.tenantId)).toHaveLength(0);
    expect(
      (
        await pool.query('SELECT id FROM app.documents WHERE tenant_id = $1 ORDER BY id', [
          w.scope.tenantId,
        ])
      ).rows,
    ).toEqual(documentsBefore.rows);
    expect(queue.add).toHaveBeenCalledTimes(1);
  });

  it("lands a submitted payment on channel portal for the caller's party only", async () => {
    const w = await newWorld();
    const doc = await cleanProof(w.me);

    const created = await submitAs(w.me, bodyOf(doc));

    expect(Object.keys(created).sort()).toEqual(WHITELIST);
    expect(created).toMatchObject({
      status: 'submitted',
      number: null,
      method: 'bank_transfer',
      currency: 'NPR',
      amount: '600.00',
      receivedOn: '2026-11-08',
      bankReference: 'TXN-1001',
    });
    const rows = await paymentRows(w.scope.tenantId);
    expect(rows).toEqual([
      {
        id: created.id,
        customer_party_id: w.party,
        channel: 'portal',
        status: 'submitted',
        submitted_by: w.me.userId,
        organization_id: w.scope.organizationId,
      },
    ]);
    const { rows: links } = await pool.query<{ document_id: string }>(
      'SELECT document_id FROM app.payment_proofs WHERE payment_id = $1',
      [created.id],
    );
    expect(links).toEqual([{ document_id: doc }]);
  });

  it('refuses a body that names a customer with 400, and writes nothing', async () => {
    const w = await newWorld();
    const doc = await cleanProof(w.me);

    const naming = await refusal(submitAs(w.me, { ...bodyOf(doc), customerId: w.strangerParty }));
    const own = await refusal(submitAs(w.me, { ...bodyOf(doc), customerId: w.party }));
    const noProof = await refusal(submitAs(w.me, bodyOf(doc, { proofDocumentIds: [] })));
    const noKey = await refusal(
      asCaller(w.me, async () => payments.submit(undefined, bodyOf(doc))),
    );

    expect(naming).toMatch(/^400 /);
    expect(own).toMatch(/^400 /);
    expect(noProof).toMatch(/^400 /);
    expect(noKey).toMatch(/^400 /);
    expect(await paymentRows(w.scope.tenantId)).toHaveLength(0);
  });

  it('answers 422 invalid_proof for a proof customer A uploaded and customer B submits, and writes nothing', async () => {
    const w = await newWorld();
    const docOfA = await cleanProof(w.me);

    const refused = await refusal(submitAs(w.stranger, bodyOf(docOfA)));
    const unknown = await refusal(submitAs(w.stranger, bodyOf(randomUUID())));

    expect(refused).toMatch(/^422 .*"code":"invalid_proof"/);
    // An unknown id and another customer's id give the same body: nothing says which rule failed.
    expect(unknown).toBe(refused);
    expect(await paymentRows(w.scope.tenantId)).toHaveLength(0);
    // The proof is still A's: A can use it.
    const created = await submitAs(w.me, bodyOf(docOfA));
    expect(created.status).toBe('submitted');
  });

  it('replays the same Idempotency-Key as one payment', async () => {
    const w = await newWorld();
    const doc = await cleanProof(w.me);
    const key = randomUUID();

    const first = await submitAs(w.me, bodyOf(doc), key);
    const second = await submitAs(w.me, bodyOf(doc), key);

    expect(second).toEqual(first);
    expect(await paymentRows(w.scope.tenantId)).toHaveLength(1);
  });

  it('refuses a staff principal that holds the portal permissions (a founder) with 403, and writes nothing', async () => {
    const w = await newWorld();
    const doc = await cleanProof(w.me);
    const founder: Principal = {
      ...w.me,
      orgKind: 'staff',
      partyId: null,
      roles: ['founder'],
      grants: new Map<Permission, Scope>([
        ['portal.invoice.read', 'all'],
        ['portal.payment.submit', 'all'],
      ]),
    };

    const submit = await refusal(submitAs(founder, bodyOf(doc)));
    const list = await refusal(listAs(founder));

    expect(submit).toMatch(/^403 .*"code":"forbidden"/);
    expect(list).toMatch(/^403 .*"code":"forbidden"/);
    expect(await paymentRows(w.scope.tenantId)).toHaveLength(0);
  });

  it('refuses a customer acting in a non-default entity with 403, and writes nothing', async () => {
    const w = await newWorld();
    const doc = await cleanProof(w.me);
    const elsewhere: Principal = { ...w.me, organizationId: w.entityB };

    const refused = await refusal(submitAs(elsewhere, bodyOf(doc)));

    expect(refused).toMatch(/^403 .*"code":"forbidden"/);
    expect(await paymentRows(w.scope.tenantId)).toHaveLength(0);
  });
});

describe('GET /v1/portal/payments', () => {
  it("lists only the caller's payments, newest first, as the eight-field whitelist", async () => {
    const w = await newWorld();
    const mine1 = await submitAs(w.me, bodyOf(await cleanProof(w.me), { amount: '600.00' }));
    const theirs = await submitAs(
      w.stranger,
      bodyOf(await cleanProof(w.stranger), { amount: '999.00' }),
    );
    // A payment staff recorded for the caller, and one of the stranger's.
    const staffMine = await seedStaffPayment(w, w.party, await cleanProof(w.me), '750.00');
    await seedStaffPayment(w, w.strangerParty, await cleanProof(w.stranger), '888.00');
    // Staff-only fields: a rejection with its reason (the portal has no field for it).
    await withTx(db, w.scope, seedActor, (tx) =>
      tx.execute(sql`
        UPDATE app.payments SET status = 'rejected', rejection_reason = 'Blurry slip, resend'
         WHERE id = ${mine1.id}`),
    );

    const mine = await listAs(w.me);
    const others = await listAs(w.stranger);

    expect(mine.map((p) => p.id)).toEqual([staffMine.id, mine1.id]);
    expect(mine.map((p) => p.amount)).toEqual(['750.00', '600.00']);
    expect(mine.map((p) => p.status)).toEqual(['submitted', 'rejected']);
    for (const item of mine) {
      expect(Object.keys(item).sort()).toEqual(WHITELIST);
      expect(PortalPaymentListItemSchema.safeParse(item).success).toBe(true);
    }
    const wire = JSON.stringify(mine);
    expect(wire).not.toContain('Blurry');
    expect(wire).not.toContain(w.me.userId);
    expect(wire).not.toContain('portal');
    expect(mine.some((p) => p.id === theirs.id)).toBe(false);
    expect(others.map((p) => p.amount)).toEqual(['888.00', '999.00']);
  });

  it('is empty for a customer with no payments, and for the owner acting in a non-default entity', async () => {
    const w = await newWorld();
    await submitAs(w.me, bodyOf(await cleanProof(w.me)));
    const elsewhere: Principal = { ...w.me, organizationId: w.entityB };

    expect(await listAs(w.stranger)).toEqual([]);
    expect(await listAs(elsewhere)).toEqual([]);
    expect(await listAs(w.me)).toHaveLength(1);
  });

  it("never shows a payment of another tenant's party", async () => {
    const w = await newWorld();
    const other = await newWorld();
    await submitAs(other.me, bodyOf(await cleanProof(other.me)));
    const sameParty: Principal = { ...w.me, partyId: other.party };

    expect(await listAs(sameParty)).toEqual([]);
  });
});
