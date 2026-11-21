// Integration test of the vendor bank accounts (P4 V2, done check 14) on a real Postgres (Testcontainers, needs
// Docker in WSL). Real parts: every migration as bos_owner, queries as bos_app, VendorBankController,
// VendorBankService, a FieldCipher on a test keyring, DocumentsService on disk storage with the evidence owner
// policy the module registers, AuditService and the pure can(). Most tests move a version to quarantined and then
// clean (or infected) by hand; the evidence-upload tests (V2b) go through VendorBankEvidenceController, the real
// type check and ScanProcessor against the fake clamd over TCP.
// Run: pnpm --filter @bos/api exec vitest run src/modules/vendors/bank/bank.integration.test.ts
// supertest bodies are `any`; the assertions below read them directly, as the HTTP contract is what is under test.
/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument */
import 'reflect-metadata';

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DEFAULT_ROLE_PERMISSIONS,
  VendorBankAccountDtoSchema,
  type OrgKind,
  type Permission,
  type RoleKey,
  type Scope,
} from '@bos/contracts';
import {
  createParty,
  createPortalUser,
  createStaffUser,
  createTenantWithEntity,
  documentVersions,
} from '@bos/db';
import { ConflictException, ForbiddenException, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Queue } from 'bullmq';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool, type PoolClient } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { configureApp } from '../../../app.setup';
import { AuditService } from '../../../platform/audit/audit.service';
import { can } from '../../../platform/authz/can';
import type { AuthzService } from '../../../platform/authz/authz.service';
import type { Principal } from '../../../platform/authz/principal';
import { FieldKeyring } from '../../../platform/config/config';
import { FieldCipher, FieldCipherError } from '../../../platform/crypto/field-cipher';
import type { Db } from '../../../platform/db/db.module';
import { withTx } from '../../../platform/db/tx';
import { ClamdClient } from '../../../platform/documents/clamd.client';
import { DiskStorageAdapter } from '../../../platform/documents/storage.adapter';
import { DocumentsService } from '../../../platform/documents/documents.service';
import { startFakeClamd, type FakeClamd } from '../../../platform/documents/fake-clamd';
import { ScanProcessor } from '../../../platform/documents/scan.processor';
import { SignedLinks } from '../../../platform/documents/signed-link';
import { ErrorBodyFilter } from '../../../platform/tenancy/error-body.filter';
import { VendorBankEvidenceController } from './bank-evidence.controller';
import { bankEvidenceOwnerPolicy } from './bank-evidence.policy';
import { VendorBankEvidenceService } from './bank-evidence.service';
import { VendorBankController } from './bank.controller';
import { bankAccountAad } from './bank.rules';
import { VendorBankService } from './bank.service';
import { createTestDatabase, type TestDatabase } from '@bos/db/testing';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 180_000 });

const SECRET = 'bank-it-signed-link-secret-0123456789abcdef';

let testDb: TestDatabase;
let ownerPool: Pool;
let appPool: Pool;
let db: Db;
let app: INestApplication;
let baseUrl: string;
let storageRoot: string;
let service: VendorBankService;
let documents: DocumentsService;
let evidenceService: VendorBankEvidenceService;
let processor: ScanProcessor;
let fakeClamd: FakeClamd;
let cipher: FieldCipher;
let tenantId: string;
let tenant2Id: string;
let tenant2Org: string;
let orgA: string;
let orgB: string;
let staffIdpOrgId: string;

const U = {} as Record<
  'founder' | 'procurement' | 'finance' | 'finance2' | 'accountant' | 'other',
  string
>;

const grantsOf = (role: RoleKey, extra: Permission[] = []) => {
  const map = new Map(Object.entries(DEFAULT_ROLE_PERMISSIONS[role])) as Map<Permission, Scope>;
  for (const p of extra) map.set(p, 'all');
  return map;
};

const current = {
  userId: '',
  tenantId: '',
  organizationId: '',
  orgKind: 'staff' as OrgKind,
  partyId: null as string | null,
  grants: new Map<Permission, Scope>(),
};
/** `vendor.bank.propose` is granted to no role yet (hand-back), so the proposers get it here. */
const as = (
  key: keyof typeof U,
  role: RoleKey,
  opts: { org?: string; extra?: Permission[]; tenant?: string } = {},
) => {
  current.userId = U[key];
  current.tenantId = opts.tenant ?? tenantId;
  current.organizationId = opts.org ?? orgA;
  current.orgKind = 'staff';
  current.partyId = null;
  current.grants = grantsOf(role, opts.extra);
};
const asProposer = () => as('procurement', 'procurement', { extra: ['vendor.bank.propose'] });
const asVerifier = (key: 'finance' | 'finance2' = 'finance') => as(key, 'finance');

const scopeNow = () => ({ tenantId: current.tenantId, organizationId: current.organizationId });
const principalNow = (): Principal => ({
  userId: current.userId,
  zitadelUserId: `z-${current.userId}`,
  ...scopeNow(),
  orgKind: current.orgKind,
  partyId: current.partyId,
  idpOrgId: staffIdpOrgId,
  roles: [],
  departmentId: null,
  status: 'active',
  grants: current.grants,
});
const caller = {
  current: () => ({
    scope: scopeNow(),
    actor: { kind: 'user' as const, id: current.userId, correlationId: 'test-corr' },
    principal: principalNow(),
  }),
};
const authz = {
  assert: (action: Permission, ref?: Parameters<typeof can>[2]) => {
    const d = can(principalNow(), action, ref);
    if (!d.allowed) {
      throw new ForbiddenException({ code: 'forbidden', message: 'Forbidden', reason: d.reason });
    }
  },
};
const documentsAudit = { record: vi.fn(() => Promise.resolve(undefined)) };

/** A transaction on `pool` with the bos.* settings the audit triggers need. */
async function inTx<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const [k, v] of Object.entries({
      'bos.tenant_id': tenantId,
      'bos.organization_id': orgA,
      'bos.actor_kind': 'system',
      'bos.actor_id': 'system:test',
      'bos.correlation_id': `test:${randomUUID()}`,
      'bos.ip': '',
      'bos.user_agent': '',
    })) {
      await client.query('SELECT set_config($1, $2, true)', [k, v]);
    }
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

beforeAll(async () => {
  testDb = await createTestDatabase();
  const admin0 = new Pool({ connectionString: testDb.adminUrl, max: 1 });
  await admin0.end();
  const bosAdmin = new Pool({ connectionString: testDb.adminUrl, max: 1 });
  await bosAdmin.end();

  ownerPool = new Pool({ connectionString: testDb.ownerUrl, max: 2 });
  appPool = new Pool({ connectionString: testDb.appUrl, max: 8 });
  db = drizzle({ client: appPool });

  const tenant = await createTenantWithEntity(appPool);
  tenantId = tenant.tenantId;
  orgA = tenant.organizationId;
  staffIdpOrgId = tenant.idpOrgId;
  const tenant2 = await createTenantWithEntity(appPool);
  tenant2Id = tenant2.tenantId;
  tenant2Org = tenant2.organizationId;
  orgB = randomUUID();
  await inTx(ownerPool, async (client) => {
    await client.query(
      `INSERT INTO app.organizations (id, tenant_id, organization_id, code, name, legal_name, is_default)
       VALUES ($1, $2, $1, 'ENT-B', 'Entity B', 'Entity B', false)`,
      [orgB, tenantId],
    );
  });
  for (const key of ['founder', 'procurement', 'finance', 'finance2', 'accountant'] as const) {
    U[key] = (
      await createStaffUser(appPool, { tenantId, organizationId: orgA, idpOrgId: tenant.idpOrgId })
    ).userId;
  }
  U.other = (
    await createStaffUser(appPool, {
      tenantId: tenant2Id,
      organizationId: tenant2Org,
      idpOrgId: tenant2.idpOrgId,
    })
  ).userId;
  await inTx(ownerPool, async (client) => {
    await client.query(
      `INSERT INTO app.user_entities (tenant_id, organization_id, user_id, is_default) VALUES ($1, $2, $3, false)`,
      [tenantId, orgB, U.founder],
    );
  });

  // The test keyring (the e2e app uses FIELD_ENC_KEYS: 'k1:' + randomBytes(32).toString('base64')).
  cipher = new FieldCipher(new FieldKeyring('k1', 'k1', new Map([['k1', randomBytes(32)]])));
  storageRoot = await mkdtemp(join(tmpdir(), 'bos-bank-it-'));
  // One storage for upload and scan: the scanner reads the quarantined file the upload wrote.
  const storage = new DiskStorageAdapter(storageRoot);
  documents = new DocumentsService(
    db,
    storage,
    new SignedLinks(SECRET, { claim: () => Promise.resolve(true) }),
    { add: vi.fn().mockResolvedValue({}) } as unknown as Queue,
    authz,
    documentsAudit,
  );
  // What BankEvidenceOwnerRegistrar does when VendorBankModule starts.
  documents.registerOwner(bankEvidenceOwnerPolicy(db));
  service = new VendorBankService(
    db,
    authz as unknown as AuthzService,
    caller,
    cipher,
    documents,
    new AuditService(db),
  );
  evidenceService = new VendorBankEvidenceService(db, caller, documents);
  fakeClamd = await startFakeClamd();
  processor = new ScanProcessor(
    db,
    storage,
    new ClamdClient({ host: fakeClamd.host, port: fakeClamd.port, timeoutMs: 5_000 }),
    documentsAudit,
    { notifyUser: vi.fn(() => Promise.resolve(undefined)) },
  );
  const moduleRef = await Test.createTestingModule({
    controllers: [VendorBankController, VendorBankEvidenceController],
    providers: [
      { provide: VendorBankService, useValue: service },
      { provide: VendorBankEvidenceService, useValue: evidenceService },
    ],
  }).compile();
  app = moduleRef.createNestApplication({ rawBody: true, logger: false });
  configureApp(app);
  app.useGlobalFilters(new ErrorBodyFilter());
  await app.listen(0, '127.0.0.1');
  baseUrl = `http://127.0.0.1:${((app.getHttpServer() as Server).address() as AddressInfo).port}`;
});

afterAll(async () => {
  await app?.close();
  await fakeClamd?.close();
  await appPool?.end();
  await ownerPool?.end();
  await testDb?.drop();
  if (storageRoot) await rm(storageRoot, { recursive: true, force: true });
});

beforeEach(() => asProposer());

// ---------------------------------------------------------------------------------------------- helpers

const api = () => request(baseUrl);
const idem = () => ({ 'Idempotency-Key': randomUUID() });
let panCounter = 300_000_000;
let accountCounter = 10_000_000;
/** A fresh account number, typed with spaces the way people do. */
const nextNumber = () => {
  const digits = `0100${String(accountCounter++)}`;
  return { typed: `${digits.slice(0, 4)} ${digits.slice(4, 8)} ${digits.slice(8)}`, digits };
};

/** A vendor party plus its vendors row, written directly (V1's create flow is not under test here). */
async function newVendor(): Promise<string> {
  const { partyId, idpOrgId } = await createParty(appPool, { tenantId, kind: 'vendor' });
  await inTx(ownerPool, async (client) => {
    await client.query(
      `INSERT INTO app.vendors (id, tenant_id, legal_name, kind, pan, created_by)
       VALUES ($1, $2, 'Himal Traders Pvt Ltd', 'company', $3, $4)`,
      [partyId, tenantId, String(panCounter++), U.procurement],
    );
  });
  vendorIdp.set(partyId, idpOrgId);
  return partyId;
}
const vendorIdp = new Map<string, string>();

const propose = (vendorId: string, accountNumber: string, key = randomUUID()) =>
  api()
    .post(`/v1/vendors/${vendorId}/bank-accounts`)
    .set('Idempotency-Key', key)
    .send({ bankName: 'Nabil Bank', accountName: 'Himal Traders', accountNumber });

async function proposed(vendorId: string) {
  const n = nextNumber();
  const res = await propose(vendorId, n.typed);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return { id: res.body.id as string, ...n };
}

/** A call-back evidence document on the account, in the acting entity of `org`, in `status`. */
async function evidence(
  accountId: string,
  status: 'quarantined' | 'clean' | 'infected',
  org: string = orgA,
): Promise<string> {
  const actor = { kind: 'user' as const, id: U.founder, correlationId: 'test-corr' };
  return withTx(db, { tenantId, organizationId: org }, actor, async (tx) => {
    const saved = { ...current };
    as('founder', 'founder', { org });
    try {
      const created = await documents.create(tx, {
        ownerType: 'vendor_bank_account',
        ownerId: accountId,
        filename: 'callback-note.pdf',
        declaredMime: 'application/pdf',
        sizeBytes: 10,
      });
      await tx
        .update(documentVersions)
        .set({ status: 'quarantined', updatedAt: new Date() })
        .where(eq(documentVersions.id, created.versionId));
      if (status !== 'quarantined') {
        await tx
          .update(documentVersions)
          .set({
            status,
            sha256: createHash('sha256').update(created.versionId).digest(),
            detectedMime: 'application/pdf',
            updatedAt: new Date(),
          })
          .where(eq(documentVersions.id, created.versionId));
      }
      return created.documentId;
    } finally {
      Object.assign(current, saved);
    }
  });
}

const verify = (vendorId: string, accountId: string, documentId: string, key = randomUUID()) =>
  api()
    .post(`/v1/vendors/${vendorId}/bank-accounts/${accountId}/verify`)
    .set('Idempotency-Key', key)
    .send({ callbackEvidenceDocumentId: documentId });

const rawAccount = async (id: string) =>
  (
    await ownerPool.query<{
      account_number_enc: Buffer;
      account_fingerprint: string;
      last4: string;
      status: string;
      proposed_by: string;
      proposed_via: string;
      verified_by: string | null;
    }>('SELECT * FROM app.vendor_bank_accounts WHERE id = $1', [id])
  ).rows[0]!;

async function conflictCode(promise: Promise<unknown>): Promise<unknown> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ConflictException);
  return ((error as ConflictException).getResponse() as { code?: unknown }).code;
}

// ---------------------------------------------------------------------------------------------- tests

describe('propose: encryption at rest and last4-only DTOs', () => {
  it('stores ciphertext that is not the number, opens only with its own row AAD, and shows last4 only', async () => {
    const vendorId = await newVendor();
    const a = await proposed(vendorId);
    const b = await proposed(vendorId);

    const raw = await rawAccount(a.id);
    expect(raw.account_number_enc.equals(Buffer.from(a.digits, 'utf8'))).toBe(false);
    expect(raw.account_number_enc.toString('utf8')).not.toContain(a.digits);
    expect(raw.account_number_enc.toString('hex')).not.toContain(
      Buffer.from(a.digits).toString('hex'),
    );
    expect(cipher.decrypt(raw.account_number_enc, bankAccountAad(a.id))).toBe(a.digits);
    expect(() => cipher.decrypt(raw.account_number_enc, bankAccountAad(b.id))).toThrow(
      FieldCipherError,
    );
    expect(() => cipher.decrypt(raw.account_number_enc)).toThrow(FieldCipherError);
    expect(raw.account_fingerprint).toBe(cipher.fingerprint(a.digits));
    expect(raw.last4).toBe(a.digits.slice(-4));
    expect(raw).toMatchObject({
      status: 'proposed',
      proposed_by: U.procurement,
      proposed_via: 'staff',
    });

    const list = await api().get(`/v1/vendors/${vendorId}/bank-accounts`);
    const one = await api().get(`/v1/vendors/${vendorId}/bank-accounts/${a.id}`);
    expect(list.status).toBe(200);
    expect(one.status).toBe(200);
    for (const dto of [...list.body, one.body]) VendorBankAccountDtoSchema.parse(dto);
    expect(one.body).toMatchObject({ accountLast4: a.digits.slice(-4), status: 'proposed' });
    for (const body of [list.text, one.text]) {
      expect(body).not.toContain(a.digits);
      expect(body).not.toContain(b.digits);
      expect(body).not.toContain(raw.account_fingerprint);
      expect(body).not.toContain(raw.account_number_enc.toString('utf8'));
    }
    // The audit trail holds neither the number nor the ciphertext.
    const audit = await ownerPool.query<{ t: string }>(
      `SELECT row_to_json(e)::text AS t FROM audit.audit_events e WHERE entity_id = $1`,
      [a.id],
    );
    expect(audit.rows.length).toBeGreaterThan(0);
    for (const r of audit.rows) {
      expect(r.t).not.toContain(a.digits);
      expect(r.t).not.toContain(raw.account_number_enc.toString('utf8'));
    }
  });

  it('replays an Idempotency-Key and refuses a caller without vendor.bank.propose', async () => {
    const vendorId = await newVendor();
    const n = nextNumber();
    const key = randomUUID();
    const first = await propose(vendorId, n.typed, key);
    const again = await propose(vendorId, n.typed, key);
    expect(first.status).toBe(201);
    expect(again.body.id).toBe(first.body.id);
    expect(again.text).not.toContain(n.digits);

    as('accountant', 'accountant');
    const refused = await propose(vendorId, nextNumber().typed);
    expect(refused.status).toBe(403);
  });

  it('is 400 for a number that does not end in four digits', async () => {
    const vendorId = await newVendor();
    expect((await propose(vendorId, '12345678AB')).status).toBe(400);
  });
});

describe('maker-checker', () => {
  it('an unverified account cannot be used for payment (409 no_verified_bank_account)', async () => {
    const vendorId = await newVendor();
    await proposed(vendorId);
    expect(
      await conflictCode(
        service.activeVerifiedAccount({ tenantId, organizationId: orgA }, vendorId),
      ),
    ).toBe('no_verified_bank_account');
  });

  it('the proposer cannot verify (403 separation_of_duties), and the DB CHECK refuses it too', async () => {
    const vendorId = await newVendor();
    // The founder holds both vendor.bank.propose and vendor.bank.verify, so the 403 is the rule, not the grant.
    as('founder', 'founder');
    const a = await proposed(vendorId);
    const doc = await evidence(a.id, 'clean');
    const res = await verify(vendorId, a.id, doc);
    expect(res.status).toBe(403);
    expect(res.body.error.reason).toBe('separation_of_duties');
    expect((await rawAccount(a.id)).status).toBe('proposed');

    await expect(
      inTx(appPool, (c) =>
        c.query(`UPDATE app.vendor_bank_accounts SET verified_by = proposed_by WHERE id = $1`, [
          a.id,
        ]),
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('verify without clean evidence is 409; with a clean document of the account it activates', async () => {
    const vendorId = await newVendor();
    const a = await proposed(vendorId);
    const other = await proposed(vendorId);
    const quarantined = await evidence(a.id, 'quarantined');
    const infected = await evidence(a.id, 'infected');
    const ofOther = await evidence(other.id, 'clean');
    asVerifier();
    for (const doc of [quarantined, infected, ofOther, randomUUID()]) {
      const res = await verify(vendorId, a.id, doc);
      expect(res.status, doc).toBe(409);
    }
    expect(
      await conflictCode(
        service.verify(vendorId, a.id, { callbackEvidenceDocumentId: quarantined }, randomUUID()),
      ),
    ).toBe('callback_evidence_not_clean');

    asProposer();
    const clean = await evidence(a.id, 'clean');
    asVerifier();
    const ok = await verify(vendorId, a.id, clean);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    VendorBankAccountDtoSchema.parse(ok.body);
    expect(ok.body.status).toBe('active');
    expect(ok.text).not.toContain(a.digits);
    const snap = await service.activeVerifiedAccount({ tenantId, organizationId: orgA }, vendorId);
    expect(snap).toMatchObject({
      id: a.id,
      accountLast4: a.digits.slice(-4),
      verifiedBy: U.finance,
      callbackEvidenceDocumentId: clean,
    });
    expect(JSON.stringify(snap)).not.toContain(a.digits);
    // A decided account takes no more evidence and cannot be verified again.
    expect((await verify(vendorId, a.id, clean)).status).toBe(409);
  });

  it('a new active account retires the old one', async () => {
    const vendorId = await newVendor();
    const a = await proposed(vendorId);
    const b = await proposed(vendorId);
    const docA = await evidence(a.id, 'clean');
    const docB = await evidence(b.id, 'clean');
    asVerifier();
    expect((await verify(vendorId, a.id, docA)).status).toBe(200);
    asVerifier('finance2');
    expect((await verify(vendorId, b.id, docB)).status).toBe(200);
    expect((await rawAccount(a.id)).status).toBe('retired');
    expect((await rawAccount(b.id)).status).toBe('active');
    expect(
      (await service.activeVerifiedAccount({ tenantId, organizationId: orgA }, vendorId)).id,
    ).toBe(b.id);
  });

  it('two verifies of one vendor at once leave exactly one active account and no 500', async () => {
    const vendorId = await newVendor();
    const a = await proposed(vendorId);
    const b = await proposed(vendorId);
    const docA = await evidence(a.id, 'clean');
    const docB = await evidence(b.id, 'clean');
    asVerifier();
    const results = await Promise.all([verify(vendorId, a.id, docA), verify(vendorId, b.id, docB)]);
    expect(results.map((r) => r.status)).toEqual([200, 200]);
    const statuses = (
      await ownerPool.query<{ status: string }>(
        `SELECT status FROM app.vendor_bank_accounts WHERE vendor_id = $1 ORDER BY status`,
        [vendorId],
      )
    ).rows.map((r) => r.status);
    expect(statuses).toEqual(['active', 'retired']);
  });

  it('reject keeps the reason in the audit event and closes the account to verification', async () => {
    const vendorId = await newVendor();
    const a = await proposed(vendorId);
    const doc = await evidence(a.id, 'clean');
    asVerifier();
    const res = await api()
      .post(`/v1/vendors/${vendorId}/bank-accounts/${a.id}/reject`)
      .set(idem())
      .send({ reason: 'Call-back number did not answer' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('rejected');
    expect((await verify(vendorId, a.id, doc)).status).toBe(409);
    const events = await ownerPool.query<{ t: string }>(
      `SELECT row_to_json(e)::text AS t FROM audit.audit_events e WHERE entity_id = $1`,
      [a.id],
    );
    expect(events.rows.some((r) => r.t.includes('Call-back number did not answer'))).toBe(true);
  });
});

describe('scope', () => {
  it('another tenant and another vendor path are 404; evidence from another entity does not count', async () => {
    const vendorId = await newVendor();
    const otherVendor = await newVendor();
    const a = await proposed(vendorId);

    as('other', 'founder', { tenant: tenant2Id, org: tenant2Org });
    expect((await api().get(`/v1/vendors/${vendorId}/bank-accounts`)).status).toBe(404);
    expect((await api().get(`/v1/vendors/${vendorId}/bank-accounts/${a.id}`)).status).toBe(404);
    expect((await propose(vendorId, nextNumber().typed)).status).toBe(404);

    asProposer();
    expect((await api().get(`/v1/vendors/${otherVendor}/bank-accounts/${a.id}`)).status).toBe(404);

    // The founder may act for entity B; a document attached there is not visible to entity A.
    const docInB = await evidence(a.id, 'clean', orgB);
    asVerifier();
    expect((await verify(otherVendor, a.id, docInB)).status).toBe(404);
    expect((await verify(vendorId, a.id, docInB)).status).toBe(409);
  });
});

describe('proposeFromPortal (PV2)', () => {
  it('records a portal proposal by the vendor party itself; another party is 404, staff 403', async () => {
    const vendorId = await newVendor();
    const otherVendor = await newVendor();
    const portalUser = (
      await createPortalUser(appPool, { tenantId, idpOrgId: vendorIdp.get(vendorId)! })
    ).userId;
    const scope = { tenantId, organizationId: orgA };
    const n = nextNumber();

    current.userId = portalUser;
    current.orgKind = 'vendor';
    current.partyId = vendorId;
    current.grants = grantsOf('vendor_user');
    const dto = await service.proposeFromPortal(
      scope,
      vendorId,
      { bankName: 'Nabil Bank', accountName: 'Himal Traders', accountNumber: n.digits },
      randomUUID(),
    );
    VendorBankAccountDtoSchema.parse(dto);
    expect(dto).toMatchObject({ proposedVia: 'portal', status: 'proposed' });
    expect(await rawAccount(dto.id)).toMatchObject({
      proposed_by: portalUser,
      proposed_via: 'portal',
    });

    await expect(
      service.proposeFromPortal(scope, otherVendor, {
        bankName: 'X',
        accountName: 'Y',
        accountNumber: nextNumber().digits,
      }),
    ).rejects.toMatchObject({ status: 404 });

    asProposer();
    await expect(
      service.proposeFromPortal(scope, vendorId, {
        bankName: 'X',
        accountName: 'Y',
        accountNumber: nextNumber().digits,
      }),
    ).rejects.toMatchObject({ status: 403 });
  });
});

describe('call-back evidence upload (V2b)', () => {
  const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF\n');
  const evidencePath = (vendorId: string, accountId: string) =>
    `/v1/vendors/${vendorId}/bank-accounts/${accountId}/evidence`;
  const createEvidence = (vendorId: string, accountId: string) =>
    api().post(evidencePath(vendorId, accountId)).send({
      filename: 'callback-note.pdf',
      declaredMime: 'application/pdf',
      sizeBytes: PDF.length,
    });
  const putContent = (uploadPath: string) =>
    api().put(uploadPath).set('Content-Type', 'application/pdf').send(PDF);
  const scanJob = (versionId: string) => ({ versionId, tenantId, organizationId: orgA });
  /** The default procurement role without `documents.upload`: only `vendor.bank.propose` can allow the upload. */
  const asProcurementOnly = () => {
    as('procurement', 'procurement');
    current.grants.delete('documents.upload');
  };
  /** Create, upload and scan one evidence file as procurement; returns the document id. */
  async function uploadedClean(vendorId: string, accountId: string): Promise<string> {
    asProcurementOnly();
    const created = await createEvidence(vendorId, accountId);
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const put = await putContent(created.body.uploadPath);
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    expect(await processor.scanVersion(scanJob(created.body.versionId), true)).toBe('clean');
    return created.body.documentId as string;
  }

  it('procurement without documents.upload uploads evidence, it scans clean, and finance verifies with it', async () => {
    const vendorId = await newVendor();
    const a = await proposed(vendorId);

    asProcurementOnly();
    expect(current.grants.has('documents.upload')).toBe(false);
    expect(current.grants.get('vendor.bank.propose')).toBe('all');
    const created = await createEvidence(vendorId, a.id);
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const { documentId, versionId, uploadPath } = created.body;
    expect(uploadPath).toBe(
      `${evidencePath(vendorId, a.id)}/${documentId}/versions/${versionId}/content`,
    );
    const put = await putContent(uploadPath);
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    expect(put.body.status).toBe('quarantined');
    expect(await processor.scanVersion(scanJob(versionId), true)).toBe('clean');
    const [version] = await db
      .select({ status: documentVersions.status, uploadedBy: documentVersions.uploadedBy })
      .from(documentVersions)
      .where(eq(documentVersions.id, versionId));
    expect(version).toEqual({ status: 'clean', uploadedBy: U.procurement });

    asVerifier();
    const ok = await verify(vendorId, a.id, documentId);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.status).toBe('active');
    expect(
      await service.activeVerifiedAccount({ tenantId, organizationId: orgA }, vendorId),
    ).toMatchObject({ id: a.id, verifiedBy: U.finance, callbackEvidenceDocumentId: documentId });
  });

  it('is 403 without vendor.bank.propose or vendor.bank.verify, even with documents.upload at all', async () => {
    const vendorId = await newVendor();
    const a = await proposed(vendorId);
    asProcurementOnly();
    const created = await createEvidence(vendorId, a.id);
    expect(created.status).toBe(201);

    as('accountant', 'accountant', { extra: ['documents.upload'] });
    expect((await createEvidence(vendorId, a.id)).status).toBe(403);
    expect((await putContent(created.body.uploadPath)).status).toBe(403);
    as('other', 'sales');
    expect((await createEvidence(vendorId, a.id)).status).toBe(403);
    expect((await putContent(created.body.uploadPath)).status).toBe(403);
  });

  it('finance uploads the call-back evidence for an account the vendor proposed and verifies with it', async () => {
    const vendorId = await newVendor();
    const portalUser = (
      await createPortalUser(appPool, { tenantId, idpOrgId: vendorIdp.get(vendorId)! })
    ).userId;
    current.userId = portalUser;
    current.orgKind = 'vendor';
    current.partyId = vendorId;
    current.grants = grantsOf('vendor_user');
    const a = await service.proposeFromPortal(
      { tenantId, organizationId: orgA },
      vendorId,
      { bankName: 'Nabil Bank', accountName: 'Himal Traders', accountNumber: nextNumber().digits },
      randomUUID(),
    );

    // The default finance role: vendor.bank.verify, no vendor.bank.propose and no documents.upload.
    asVerifier();
    expect(current.grants.has('vendor.bank.propose')).toBe(false);
    expect(current.grants.has('documents.upload')).toBe(false);
    const created = await createEvidence(vendorId, a.id);
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const put = await putContent(created.body.uploadPath);
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    expect(await processor.scanVersion(scanJob(created.body.versionId), true)).toBe('clean');

    const ok = await verify(vendorId, a.id, created.body.documentId as string);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.status).toBe('active');
    expect(await rawAccount(a.id)).toMatchObject({ status: 'active', verified_by: U.finance });
  });

  it('evidence attached by the proposer does not let the proposer verify (maker-checker unchanged)', async () => {
    const vendorId = await newVendor();
    // The founder holds both grants: it proposes and attaches, and is still refused at verify.
    as('founder', 'founder');
    const a = await proposed(vendorId);
    const created = await createEvidence(vendorId, a.id);
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect((await putContent(created.body.uploadPath)).status).toBe(200);
    expect(await processor.scanVersion(scanJob(created.body.versionId), true)).toBe('clean');
    const res = await verify(vendorId, a.id, created.body.documentId as string);
    expect(res.status).toBe(403);
    expect(res.body.error.reason).toBe('separation_of_duties');
    expect((await rawAccount(a.id)).status).toBe('proposed');
  });

  it('takes no evidence once the account is active or retired, nor bytes for a file created before verify', async () => {
    const vendorId = await newVendor();
    const a = await proposed(vendorId);
    const b = await proposed(vendorId);
    const doc = await uploadedClean(vendorId, a.id);
    const pending = await createEvidence(vendorId, a.id);
    expect(pending.status).toBe(201);

    asVerifier();
    expect((await verify(vendorId, a.id, doc)).status).toBe(200);
    asProcurementOnly();
    expect((await putContent(pending.body.uploadPath)).status).toBe(409);
    expect((await createEvidence(vendorId, a.id)).status).toBe(409);

    const docB = await uploadedClean(vendorId, b.id);
    asVerifier('finance2');
    expect((await verify(vendorId, b.id, docB)).status).toBe(200);
    expect((await rawAccount(a.id)).status).toBe('retired');
    asProcurementOnly();
    expect((await createEvidence(vendorId, a.id)).status).toBe(409);
  });

  it('another tenant, another vendor or account path, and another entity are 404', async () => {
    const vendorId = await newVendor();
    const otherVendor = await newVendor();
    const a = await proposed(vendorId);
    const b = await proposed(vendorId);
    asProcurementOnly();
    const created = await createEvidence(vendorId, a.id);
    expect(created.status).toBe(201);
    const { documentId, versionId } = created.body;

    as('other', 'founder', { tenant: tenant2Id, org: tenant2Org });
    expect((await createEvidence(vendorId, a.id)).status).toBe(404);
    expect((await putContent(created.body.uploadPath)).status).toBe(404);

    asProcurementOnly();
    expect((await createEvidence(otherVendor, a.id)).status).toBe(404);
    expect((await createEvidence(vendorId, randomUUID())).status).toBe(404);
    for (const path of [
      `${evidencePath(otherVendor, a.id)}/${documentId}/versions/${versionId}/content`,
      `${evidencePath(vendorId, b.id)}/${documentId}/versions/${versionId}/content`,
      `${evidencePath(vendorId, a.id)}/${randomUUID()}/versions/${versionId}/content`,
      `${evidencePath(vendorId, a.id)}/not-a-uuid/versions/${versionId}/content`,
    ]) {
      expect((await putContent(path)).status, path).toBe(404);
    }

    // A file created while acting for entity B is not reachable from entity A.
    as('founder', 'founder', { org: orgB });
    const inB = await createEvidence(vendorId, a.id);
    expect(inB.status).toBe(201);
    asProcurementOnly();
    expect((await putContent(inB.body.uploadPath)).status).toBe(404);
  });
});
