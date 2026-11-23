// Integration test of the vendor portal inbox writes (P4 PV2, PV2b: bill submissions and bank change requests) on a real Postgres (Testcontainers, needs Docker in
// WSL), done check 13: a pending_kyc vendor uploads KYC documents but is refused quotation submissions; every id that
// is not the caller's is the same 404; an upload creates only inbox rows; the scan runs.
// Real: migrations as bos_owner, queries as bos_app, VendorPortalInboxService, DocumentsService (storage on a temp
// dir, the type check, the counterparty hook reading the principal bound in the request store, the real
// AuthzService for the fallback grant check), VerificationService's `verification_case` owner policy with the real
// VendorPartyOwner, the `vendor_portal_intake` policy, and ScanProcessor against the fake clamd over TCP.
// Faked: the caller (a vendor Principal per test) and the scan queue (the test runs the scan itself).
// Run: pnpm --filter @bos/api exec vitest run src/modules/portal-vendor/inbox/portal-vendor-inbox.integration.test.ts
import 'reflect-metadata';

import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { VendorBankAccountDtoSchema, type Permission, type Scope } from '@bos/contracts';
import {
  createCostCenter,
  createDepartment,
  createParty,
  createPortalUser,
  createStaffUser,
  createTenantWithEntity,
} from '@bos/db';
import { HttpException } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { AuditService } from '../../../platform/audit/audit.service';
import { AuthzService } from '../../../platform/authz/authz.service';
import type { Principal } from '../../../platform/authz/principal';
import type { RoleCache } from '../../../platform/authz/role-cache';
import { FieldKeyring } from '../../../platform/config/config';
import { FieldCipher } from '../../../platform/crypto/field-cipher';
import type { Db } from '../../../platform/db/db.module';
import { systemActor, withTx, type TxScope } from '../../../platform/db/tx';
import { ClamdClient } from '../../../platform/documents/clamd.client';
import { DocumentsService } from '../../../platform/documents/documents.service';
import { eicarBytes, startFakeClamd, type FakeClamd } from '../../../platform/documents/fake-clamd';
import { ScanProcessor } from '../../../platform/documents/scan.processor';
import { SignedLinks } from '../../../platform/documents/signed-link';
import { DiskStorageAdapter } from '../../../platform/documents/storage.adapter';
import {
  bindIdentity,
  bindPrincipal,
  runWithRequestStore,
} from '../../../platform/tenancy/request-context';
import type { VendorPortalCaller } from '../../portal/vendor-portal.caller';
import { VendorBankService } from '../../vendors/bank/bank.service';
import { VendorsCaller } from '../../vendors/vendors.caller';
import { VendorPartyOwner } from '../../vendors/vendor-party-owner';
import { VerificationService } from '../../verification/verification.service';
import { VENDOR_DEFAULT_CHECKLIST } from '../../verification/verification.rules';
import type { VerificationCaller } from '../../verification/verification.caller';
import { VendorPortalInboxService, type InboxCaller } from './portal-vendor-inbox.service';
import { vendorIntakeOwnerPolicy } from './vendor-intake.policy';
import { createTestDatabase, type TestDatabase } from '@bos/db/testing';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 180_000 });

const SECRET = 'pv2-it-signed-link-secret-0123456789abcdef';
const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF\n');

let testDb: TestDatabase;
let appPool: Pool;
let ownerPool: Pool;
let db: Db;
let scope: TxScope;
let idpOrgId: string;
let staffId: string;
let approverId: string;
let deptId: string;
let storageRoot: string;
let fakeClamd: FakeClamd;
let processor: ScanProcessor;
let service: VendorPortalInboxService;

const current: { p: Principal | null } = { p: null };
const caller: VendorPortalCaller = {
  current: () => {
    if (current.p === null) throw new Error('no principal');
    return current.p;
  },
};

const exec = (q: ReturnType<typeof sql>) =>
  withTx(db, scope, systemActor('test'), (tx) => tx.execute(q));

beforeAll(async () => {
  testDb = await createTestDatabase();
  const admin = new Pool({ connectionString: testDb.adminUrl, max: 1 });
  await admin.end();
  const bosAdmin = new Pool({ connectionString: testDb.adminUrl, max: 1 });
  await bosAdmin.end();

  appPool = new Pool({ connectionString: testDb.appUrl, max: 8 });
  ownerPool = new Pool({ connectionString: testDb.ownerUrl, max: 2 });
  db = drizzle({ client: appPool });
  const tenant = await createTenantWithEntity(appPool);
  idpOrgId = tenant.idpOrgId;
  scope = { tenantId: tenant.tenantId, organizationId: tenant.organizationId };
  staffId = (await createStaffUser(appPool, { ...scope, idpOrgId, roleKeys: ['procurement'] }))
    .userId;
  approverId = (await createStaffUser(appPool, { ...scope, idpOrgId, roleKeys: ['management'] }))
    .userId;
  deptId = (await createDepartment(appPool, scope)).departmentId;

  storageRoot = await mkdtemp(join(tmpdir(), 'bos-pv2-it-'));
  // One storage for upload and scan: the scanner reads the quarantined file the upload wrote.
  const storage = new DiskStorageAdapter(storageRoot);
  const documentsAudit = { record: vi.fn(() => Promise.resolve(undefined)) };
  const documents = new DocumentsService(
    db,
    storage,
    new SignedLinks(SECRET, { claim: () => Promise.resolve(true) }),
    { add: vi.fn().mockResolvedValue({}) } as unknown as Queue,
    // The real decision: a vendor holds no documents.upload, so without the hook this throws the real 403.
    new AuthzService(db, {} as RoleCache),
    documentsAudit,
  );
  // What VerificationModule and VendorsModule do when they start: the case policy and the vendor adapter.
  const verification = new VerificationService(
    db,
    documents,
    {} as AuthzService,
    new AuditService(db),
    {} as VerificationCaller,
  );
  verification.registerPartyOwner(new VendorPartyOwner());
  verification.onModuleInit();
  // What VendorPortalInboxModule does when it starts.
  documents.registerOwner(vendorIntakeOwnerPolicy(db));
  // The real bank service (PV2b): its caller reads the request store, the real AuthzService decides the grant.
  const cipher = new FieldCipher(new FieldKeyring('k1', 'k1', new Map([['k1', randomBytes(32)]])));
  const bank = new VendorBankService(
    db,
    new AuthzService(db, {} as RoleCache),
    new VendorsCaller(),
    cipher,
    documents,
    new AuditService(db),
  );
  service = new VendorPortalInboxService(db, documents, new AuditService(db), caller, bank);
  fakeClamd = await startFakeClamd();
  processor = new ScanProcessor(
    db,
    storage,
    new ClamdClient({ host: fakeClamd.host, port: fakeClamd.port, timeoutMs: 5_000 }),
    documentsAudit,
    { notifyUser: vi.fn(() => Promise.resolve(undefined)) },
  );
});

afterAll(async () => {
  await fakeClamd?.close();
  await appPool?.end();
  await ownerPool?.end();
  await testDb?.drop();
  if (storageRoot) await rm(storageRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------------------------- helpers

interface TestVendor {
  partyId: string;
  userId: string;
}

let panSeq = 0;
/** A vendor in `status` with an account in the entity and one active portal user. */
async function vendor(status: 'approved' | 'pending_kyc'): Promise<TestVendor> {
  const party = await createParty(appPool, {
    tenantId: scope.tenantId,
    kind: 'vendor',
    organizationId: scope.organizationId,
  });
  await exec(
    sql`INSERT INTO app.vendors (id, tenant_id, legal_name, pan, status, created_by, approved_by)
        VALUES (${party.partyId}, ${scope.tenantId}, ${`Vendor ${party.partyId.slice(0, 6)}`},
                ${String(400_000_000 + (panSeq += 1))}, ${status}, ${staffId},
                ${status === 'pending_kyc' ? null : approverId})`,
  );
  await exec(
    sql`INSERT INTO app.vendor_accounts (tenant_id, organization_id, vendor_id, active)
        VALUES (${scope.tenantId}, ${scope.organizationId}, ${party.partyId}, true)`,
  );
  const { userId } = await createPortalUser(appPool, {
    tenantId: scope.tenantId,
    idpOrgId: party.idpOrgId,
  });
  return { partyId: party.partyId, userId };
}

/** A draft vendor KYB case for `partyId` with the default vendor checklist. */
async function kybCase(partyId: string): Promise<string> {
  const id = randomUUID();
  await exec(
    sql`INSERT INTO app.verification_cases (id, tenant_id, party_id, party_kind, checklist)
        VALUES (${id}, ${scope.tenantId}, ${partyId}, 'vendor',
                ${JSON.stringify(VENDOR_DEFAULT_CHECKLIST)}::jsonb)`,
  );
  return id;
}

let rfqSeq = 0;
/** An open RFQ on an approved purchase request, with `invited` on its vendor list. */
async function rfq(invited: string[]): Promise<string> {
  const prId = randomUUID();
  await exec(
    sql`INSERT INTO app.purchase_requests (id, tenant_id, organization_id, request_type, department_id,
          requester_user_id, cost_center_id, justification, required_by, budget_code, currency)
        VALUES (${prId}, ${scope.tenantId}, ${scope.organizationId}, 'goods', ${deptId}, ${staffId},
                ${(await createCostCenter(appPool, scope)).costCenterId}, 'Laptops', '2026-12-01', 'IT-2083', 'NPR')`,
  );
  await exec(
    sql`UPDATE app.purchase_requests SET status = 'approved', fx_rate = 1, estimated_total = '100000.00',
          estimated_total_npr = '100000.00', number = ${`PR-Q-${prId.slice(0, 8)}`} WHERE id = ${prId}`,
  );
  const id = randomUUID();
  await exec(
    sql`INSERT INTO app.rfqs (id, tenant_id, organization_id, purchase_request_id, number, deadline, created_by)
        VALUES (${id}, ${scope.tenantId}, ${scope.organizationId}, ${prId}, ${`RFQ-${(rfqSeq += 1)}`},
                '2030-12-15T00:00:00Z', ${staffId})`,
  );
  for (const vendorId of invited) {
    await exec(
      sql`INSERT INTO app.rfq_vendors (tenant_id, organization_id, rfq_id, vendor_id, invited_by)
          VALUES (${scope.tenantId}, ${scope.organizationId}, ${id}, ${vendorId}, ${staffId})`,
    );
  }
  return id;
}

function principalOf(v: TestVendor, overrides: Partial<Principal> = {}): Principal {
  return {
    userId: v.userId,
    zitadelUserId: `z-${v.userId.slice(0, 8)}`,
    tenantId: scope.tenantId,
    organizationId: scope.organizationId,
    orgKind: 'vendor',
    partyId: v.partyId,
    idpOrgId: `idp-${v.partyId.slice(0, 8)}`,
    roles: ['vendor_user'],
    departmentId: null,
    status: 'active',
    grants: new Map<Permission, Scope>([
      ['portal.vendor.read', 'customer_org'],
      ['portal.vendor.submit', 'customer_org'],
    ]),
    ...overrides,
  };
}

/** Runs `fn` as the request of `v`, as the tenancy interceptor binds it, and returns its scope and actor. */
function as<T>(
  v: TestVendor,
  fn: (who: InboxCaller) => Promise<T>,
  overrides: Partial<Principal> = {},
): Promise<T> {
  const p = principalOf(v, overrides);
  current.p = p;
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
    return fn({ scope, actor: { kind: 'user', id: p.userId, correlationId: 'it-correlation' } });
  });
}

/** The status and body of the HttpException `promise` rejects with. */
async function errorOf(promise: Promise<unknown>): Promise<{ status: number; body: unknown }> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof HttpException)
      return { status: error.getStatus(), body: error.getResponse() };
    throw error;
  }
  throw new Error('expected the call to fail');
}

const file = (bytes: Buffer) => ({
  filename: 'upload.pdf',
  declaredMime: 'application/pdf',
  sizeBytes: bytes.length,
});
const scanJob = (versionId: string) => ({ versionId, ...scope });

/** Declares, uploads and scans a KYC file as `v`; returns the ids and the scan verdict. */
async function kycFile(v: TestVendor, bytes = PDF) {
  const created = await as(v, (who) => service.createKycFile(who, file(bytes)));
  expect(created.uploadPath).toBe(
    `/v1/portal/vendor/kyc-documents/files/${created.documentId}/versions/${created.versionId}/content`,
  );
  await as(v, (who) =>
    service.receiveKycFile(
      who,
      created.documentId,
      created.versionId,
      Readable.from(bytes),
      bytes.length,
    ),
  );
  const verdict = await processor.scanVersion(scanJob(created.versionId), true);
  return { ...created, verdict };
}

/** Declares, uploads and scans a quotation file as `v`. */
async function quotationFile(v: TestVendor, bytes = PDF) {
  const created = await as(v, (who) => service.createQuotationFile(who, file(bytes)));
  await as(v, (who) =>
    service.receiveQuotationFile(
      who,
      created.documentId,
      created.versionId,
      Readable.from(bytes),
      bytes.length,
    ),
  );
  const verdict = await processor.scanVersion(scanJob(created.versionId), true);
  return { ...created, verdict };
}

const quotationBody = (rfqId: string, documentId: string) => ({
  rfqId,
  vendorRef: 'Q-2083-17',
  currency: 'NPR',
  total: '98000.00',
  documentId,
});

const count = async (table: string, where = 'true'): Promise<number> => {
  const res = await appPool.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM app.${table} WHERE ${where}`,
  );
  return Number(res.rows[0]?.n ?? 0);
};

// ---------------------------------------------------------------------------------------------- tests

describe('a pending_kyc vendor (done check 13)', () => {
  it('uploads a KYC document onto its own case: scanned clean, the checklist item provided', async () => {
    const v = await vendor('pending_kyc');
    const caseId = await kybCase(v.partyId);

    const f = await kycFile(v);
    expect(f.verdict).toBe('clean');
    expect(fakeClamd.scans.length).toBeGreaterThan(0);
    const receipt = await as(v, (who) =>
      service.submitKycDocument(
        who,
        { docType: 'pan_certificate', documentId: f.documentId },
        randomUUID(),
      ),
    );

    expect(receipt).toEqual({
      docType: 'pan_certificate',
      documentId: f.documentId,
      validUntil: null,
      state: 'submitted',
    });
    const res = await appPool.query<{
      checklist: { key: string; status: string; documentId: string }[];
    }>('SELECT checklist FROM app.verification_cases WHERE id = $1', [caseId]);
    expect(res.rows[0]?.checklist.find((i) => i.key === 'pan_certificate')).toMatchObject({
      status: 'provided',
      documentId: f.documentId,
    });
  });

  it('gets 403 on every quotation route, before any id is looked at', async () => {
    const v = await vendor('pending_kyc');
    const junk = randomUUID();

    const results = await Promise.all([
      errorOf(as(v, (who) => service.createQuotationFile(who, file(PDF)))),
      errorOf(
        as(v, (who) =>
          service.receiveQuotationFile(who, junk, junk, Readable.from(PDF), PDF.length),
        ),
      ),
      errorOf(
        as(v, (who) => service.submitQuotation(who, quotationBody(junk, junk), randomUUID())),
      ),
    ]);

    expect(results.map((r) => r.status)).toEqual([403, 403, 403]);
  });
});

describe("isolation: anything not the caller's is the same 404", () => {
  it("refuses vendor A on vendor B's KYC file and case", async () => {
    const a = await vendor('approved');
    const b = await vendor('pending_kyc');
    await kybCase(a.partyId);
    await kybCase(b.partyId);
    const bFile = await kycFile(b);

    const put = await errorOf(
      as(a, (who) =>
        service.receiveKycFile(
          who,
          bFile.documentId,
          bFile.versionId,
          Readable.from(PDF),
          PDF.length,
        ),
      ),
    );
    const attach = await errorOf(
      as(a, (who) =>
        service.submitKycDocument(
          who,
          { docType: 'pan_certificate', documentId: bFile.documentId },
          randomUUID(),
        ),
      ),
    );
    const unknown = await errorOf(
      as(a, (who) =>
        service.receiveKycFile(who, randomUUID(), randomUUID(), Readable.from(PDF), PDF.length),
      ),
    );

    expect(put).toEqual(unknown);
    expect(attach.status).toBe(404);
    expect(put.status).toBe(404);
  });

  it('answers 404 to a vendor that has no case', async () => {
    const v = await vendor('pending_kyc');

    expect((await errorOf(as(v, (who) => service.createKycFile(who, file(PDF))))).status).toBe(404);
  });

  it('refuses a staff principal with 403 before any query', async () => {
    const v = await vendor('approved');

    const res = await errorOf(
      as(v, (who) => service.createKycFile(who, file(PDF)), { orgKind: 'staff', partyId: null }),
    );
    expect(res.status).toBe(403);
  });
});

describe('quotation submissions', () => {
  it('records a received inbox row for an invited RFQ, once per Idempotency-Key, and nothing else', async () => {
    const a = await vendor('approved');
    const rfqId = await rfq([a.partyId]);
    const f = await quotationFile(a);
    expect(f.verdict).toBe('clean');
    const before = {
      quotations: await count('vendor_quotations'),
      bills: await count('vendor_bills'),
      activeAccounts: await count('vendor_bank_accounts', "status = 'active'"),
    };
    const key = randomUUID();

    const first = await as(a, (who) =>
      service.submitQuotation(who, quotationBody(rfqId, f.documentId), key),
    );
    const replay = await as(a, (who) =>
      service.submitQuotation(who, quotationBody(rfqId, f.documentId), key),
    );

    expect(first).toMatchObject({ documentId: f.documentId, status: 'received' });
    expect(replay.id).toBe(first.id);
    const rows = await appPool.query<{
      status: string;
      vendor_id: string;
      rfq_id: string;
      submitted_by: string;
    }>(
      'SELECT status, vendor_id, rfq_id, submitted_by FROM app.vendor_quotation_submissions WHERE rfq_id = $1',
      [rfqId],
    );
    expect(rows.rows).toEqual([
      { status: 'received', vendor_id: a.partyId, rfq_id: rfqId, submitted_by: a.userId },
    ]);
    // Inbox only: no quotation, no bill and no active bank account came out of it.
    expect(await count('vendor_quotations')).toBe(before.quotations);
    expect(await count('vendor_quotations')).toBe(0);
    expect(await count('vendor_bills')).toBe(0);
    expect(await count('vendor_bank_accounts', "status = 'active'")).toBe(before.activeAccounts);
    expect(await count('vendor_bank_accounts', "status = 'active'")).toBe(0);
  });

  it('answers the same 404 for an RFQ the vendor is not invited to, an unknown RFQ and a foreign file', async () => {
    const a = await vendor('approved');
    const b = await vendor('approved');
    const rfqA = await rfq([a.partyId]);
    const rfqB = await rfq([b.partyId]);
    const aFile = await quotationFile(a);
    const bFile = await quotationFile(b);

    const notInvited = await errorOf(
      as(a, (who) =>
        service.submitQuotation(who, quotationBody(rfqB, aFile.documentId), randomUUID()),
      ),
    );
    const unknownRfq = await errorOf(
      as(a, (who) =>
        service.submitQuotation(who, quotationBody(randomUUID(), aFile.documentId), randomUUID()),
      ),
    );
    const foreignFile = await errorOf(
      as(a, (who) =>
        service.submitQuotation(who, quotationBody(rfqA, bFile.documentId), randomUUID()),
      ),
    );
    const foreignPut = await errorOf(
      as(a, (who) =>
        service.receiveQuotationFile(
          who,
          bFile.documentId,
          bFile.versionId,
          Readable.from(PDF),
          PDF.length,
        ),
      ),
    );

    expect(notInvited.status).toBe(404);
    expect(unknownRfq).toEqual(notInvited);
    expect(foreignFile).toEqual(notInvited);
    expect(foreignPut).toEqual(notInvited);
    expect(await count('vendor_quotation_submissions', `vendor_id = '${a.partyId}'`)).toBe(0);
  });

  it('refuses a file the scan found infected with 409 and writes no row', async () => {
    const a = await vendor('approved');
    const rfqId = await rfq([a.partyId]);
    const f = await quotationFile(a, Buffer.concat([PDF, eicarBytes()]));
    expect(f.verdict).toBe('infected');

    const res = await errorOf(
      as(a, (who) =>
        service.submitQuotation(who, quotationBody(rfqId, f.documentId), randomUUID()),
      ),
    );

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'document_infected' });
    expect(await count('vendor_quotation_submissions', `rfq_id = '${rfqId}'`)).toBe(0);
  });

  it('refuses a file whose write failed (quarantined, no sha256) with 409, and takes it once the bytes are recorded (EF3)', async () => {
    const a = await vendor('approved');
    const rfqId = await rfq([a.partyId]);
    // createQuotationFile makes the document and its awaiting_content version; a failed write leaves the version
    // quarantined without the sha256 that receiving the bytes records.
    const created = await as(a, (who) => service.createQuotationFile(who, file(PDF)));
    await exec(
      sql`UPDATE app.document_versions SET status = 'quarantined', sha256 = NULL WHERE id = ${created.versionId}`,
    );

    const res = await errorOf(
      as(a, (who) =>
        service.submitQuotation(who, quotationBody(rfqId, created.documentId), randomUUID()),
      ),
    );
    expect(res.status).toBe(409);
    expect(await count('vendor_quotation_submissions', `rfq_id = '${rfqId}'`)).toBe(0);

    // The same version with its sha256 is a received file, scan pending: the submission is taken.
    await exec(
      sql`UPDATE app.document_versions SET sha256 = decode(repeat('ab', 32), 'hex') WHERE id = ${created.versionId}`,
    );
    await as(a, (who) =>
      service.submitQuotation(who, quotationBody(rfqId, created.documentId), randomUUID()),
    );
    expect(await count('vendor_quotation_submissions', `rfq_id = '${rfqId}'`)).toBe(1);
  });

  it('refuses a quotation after the RFQ deadline with 409 rfq_deadline_passed, and takes it once extended (F1-Q47)', async () => {
    const a = await vendor('approved');
    const rfqId = await rfq([a.partyId]);
    const f = await quotationFile(a);
    await exec(sql`UPDATE app.rfqs SET deadline = now() - interval '1 minute' WHERE id = ${rfqId}`);

    const res = await errorOf(
      as(a, (who) =>
        service.submitQuotation(who, quotationBody(rfqId, f.documentId), randomUUID()),
      ),
    );
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'rfq_deadline_passed' });
    expect(await count('vendor_quotation_submissions', `rfq_id = '${rfqId}'`)).toBe(0);

    await exec(sql`UPDATE app.rfqs SET deadline = now() + interval '1 day' WHERE id = ${rfqId}`);
    await as(a, (who) =>
      service.submitQuotation(who, quotationBody(rfqId, f.documentId), randomUUID()),
    );
    expect(await count('vendor_quotation_submissions', `rfq_id = '${rfqId}'`)).toBe(1);
  });
});

// ------------------------------------------------------------------------------------------------ PV2b

/** Declares, uploads and scans a bill file as `v`. */
async function billFile(v: TestVendor, bytes = PDF) {
  const created = await as(v, (who) => service.createBillFile(who, file(bytes)));
  expect(created.uploadPath).toBe(
    `/v1/portal/vendor/bill-submissions/files/${created.documentId}/versions/${created.versionId}/content`,
  );
  await as(v, (who) =>
    service.receiveBillFile(
      who,
      created.documentId,
      created.versionId,
      Readable.from(bytes),
      bytes.length,
    ),
  );
  const verdict = await processor.scanVersion(scanJob(created.versionId), true);
  return { ...created, verdict };
}

const billBody = (documentId: string, purchaseOrderId?: string) => ({
  ...(purchaseOrderId === undefined ? {} : { purchaseOrderId }),
  vendorInvoiceNo: 'INV-2083-0042',
  invoiceDate: '2026-11-02',
  currency: 'NPR',
  claimedTotal: '113000.00',
  documentId,
});

let poSeq = 0;
/** A purchase order of `vendorId` (no lines are needed here) in `status`. */
async function purchaseOrder(
  vendorId: string,
  status: 'draft' | 'issued' | 'closed',
): Promise<string> {
  const prId = randomUUID();
  await exec(
    sql`INSERT INTO app.purchase_requests (id, tenant_id, organization_id, request_type, department_id,
          requester_user_id, cost_center_id, justification, required_by, budget_code, currency)
        VALUES (${prId}, ${scope.tenantId}, ${scope.organizationId}, 'goods', ${deptId}, ${staffId},
                ${(await createCostCenter(appPool, scope)).costCenterId}, 'Laptops', '2026-12-01', 'IT-2083', 'NPR')`,
  );
  await exec(
    sql`UPDATE app.purchase_requests SET status = 'approved', fx_rate = 1, estimated_total = '113000.00',
          estimated_total_npr = '113000.00', number = ${`PR-B-${prId.slice(0, 8)}`} WHERE id = ${prId}`,
  );
  const id = randomUUID();
  poSeq += 1;
  await exec(
    sql`INSERT INTO app.purchase_orders (id, tenant_id, organization_id, number, number_seq, fiscal_year,
          purchase_request_id, vendor_id, currency, payment_terms_days, approved_total, fx_rate,
          approved_total_npr, approved_band, created_by)
        VALUES (${id}, ${scope.tenantId}, ${scope.organizationId}, ${`PO-B-${poSeq}`}, ${poSeq}, '2082/83',
                ${prId}, ${vendorId}, 'NPR', 30, '113000.00', 1, '113000.00', 'base', ${staffId})`,
  );
  if (status !== 'draft') {
    await exec(
      sql`UPDATE app.purchase_orders SET status = ${status}, issued_at = now(), issued_by = ${staffId},
            current_version = 1 WHERE id = ${id}`,
    );
  }
  return id;
}

/** The audit events of one entity as text, read as the owner. */
async function auditText(entityId: string): Promise<string[]> {
  const res = await ownerPool.query<{ t: string }>(
    'SELECT row_to_json(e)::text AS t FROM audit.audit_events e WHERE entity_id = $1',
    [entityId],
  );
  return res.rows.map((r) => r.t);
}

describe('bill submissions and bank change requests (PV2b)', () => {
  it('gets 403 on every bill route and on a bank change request while pending_kyc', async () => {
    const v = await vendor('pending_kyc');
    const junk = randomUUID();

    const results = await Promise.all([
      errorOf(as(v, (who) => service.createBillFile(who, file(PDF)))),
      errorOf(
        as(v, (who) => service.receiveBillFile(who, junk, junk, Readable.from(PDF), PDF.length)),
      ),
      errorOf(as(v, (who) => service.submitBill(who, billBody(junk), randomUUID()))),
      errorOf(
        as(v, (who) =>
          service.requestBankChange(
            who,
            { bankName: 'Nabil Bank', accountName: 'Himal Traders', accountNumber: '4455667788' },
            randomUUID(),
          ),
        ),
      ),
    ]);

    expect(results.map((r) => r.status)).toEqual([403, 403, 403, 403]);
    expect(await count('vendor_bank_accounts', `vendor_id = '${v.partyId}'`)).toBe(0);
  });

  it('writes one received row for an issued PO, once per Idempotency-Key, and no vendor_bills row', async () => {
    const a = await vendor('approved');
    const poId = await purchaseOrder(a.partyId, 'issued');
    const f = await billFile(a);
    expect(f.verdict).toBe('clean');
    const key = randomUUID();

    const first = await as(a, (who) => service.submitBill(who, billBody(f.documentId, poId), key));
    const replay = await as(a, (who) => service.submitBill(who, billBody(f.documentId, poId), key));

    expect(first).toMatchObject({ documentId: f.documentId, status: 'received' });
    expect(replay.id).toBe(first.id);
    const rows = await appPool.query<Record<string, string | null>>(
      `SELECT status, vendor_party_id, purchase_order_id, submitted_by, document_id, vendor_invoice_no,
              invoice_date::text AS invoice_date, converted_bill_id
         FROM app.vendor_bill_submissions WHERE vendor_party_id = $1`,
      [a.partyId],
    );
    expect(rows.rows).toEqual([
      {
        status: 'received',
        vendor_party_id: a.partyId,
        purchase_order_id: poId,
        submitted_by: a.userId,
        document_id: f.documentId,
        vendor_invoice_no: 'INV-2083-0042',
        invoice_date: '2026-11-02',
        converted_bill_id: null,
      },
    ]);
    // Inbox only: staff key the real bill later.
    expect(await count('vendor_bills')).toBe(0);
    // currency and claimedTotal have no column: they live in the audit event only.
    const audit = (await auditText(first.id)).join('\n');
    expect(audit).toContain('portal.vendor.bill_submitted');
    expect(audit).toContain('claimedTotal');
    expect(audit).toContain('113000.00');
  });

  it('accepts a bill with no purchase order and a PO in another vendor-visible status', async () => {
    const a = await vendor('approved');
    const closed = await purchaseOrder(a.partyId, 'closed');
    const f1 = await billFile(a);
    const f2 = await billFile(a);

    const noPo = await as(a, (who) =>
      service.submitBill(who, billBody(f1.documentId), randomUUID()),
    );
    const onClosed = await as(a, (who) =>
      service.submitBill(who, billBody(f2.documentId, closed), randomUUID()),
    );

    expect(noPo.status).toBe('received');
    expect(onClosed.status).toBe('received');
    const res = await appPool.query<{ id: string; purchase_order_id: string | null }>(
      'SELECT id, purchase_order_id FROM app.vendor_bill_submissions WHERE vendor_party_id = $1',
      [a.partyId],
    );
    expect(new Map(res.rows.map((r) => [r.id, r.purchase_order_id]))).toEqual(
      new Map([
        [noPo.id, null],
        [onClosed.id, closed],
      ]),
    );
  });

  it('answers the identical 404 for a foreign PO, a draft PO, an unknown PO and a foreign file', async () => {
    const a = await vendor('approved');
    const b = await vendor('approved');
    const aFile = await billFile(a);
    const bFile = await billFile(b);
    const aIssued = await purchaseOrder(a.partyId, 'issued');
    const bIssued = await purchaseOrder(b.partyId, 'issued');
    const aDraft = await purchaseOrder(a.partyId, 'draft');
    const submit = (documentId: string, poId?: string) =>
      errorOf(as(a, (who) => service.submitBill(who, billBody(documentId, poId), randomUUID())));

    const foreignPo = await submit(aFile.documentId, bIssued);
    const draftPo = await submit(aFile.documentId, aDraft);
    const unknownPo = await submit(aFile.documentId, randomUUID());
    const foreignFile = await submit(bFile.documentId, aIssued);
    const foreignFileNoPo = await submit(bFile.documentId);
    const foreignPut = await errorOf(
      as(a, (who) =>
        service.receiveBillFile(
          who,
          bFile.documentId,
          bFile.versionId,
          Readable.from(PDF),
          PDF.length,
        ),
      ),
    );

    expect(foreignPo.status).toBe(404);
    for (const other of [draftPo, unknownPo, foreignFile, foreignFileNoPo, foreignPut]) {
      expect(other).toEqual(foreignPo);
    }
    expect(await count('vendor_bill_submissions', `vendor_party_id = '${a.partyId}'`)).toBe(0);
  });

  it('refuses a file the scan found infected with 409 and writes no row', async () => {
    const a = await vendor('approved');
    const f = await billFile(a, Buffer.concat([PDF, eicarBytes()]));
    expect(f.verdict).toBe('infected');

    const res = await errorOf(
      as(a, (who) => service.submitBill(who, billBody(f.documentId), randomUUID())),
    );

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'document_infected' });
    expect(await count('vendor_bill_submissions', `vendor_party_id = '${a.partyId}'`)).toBe(0);
  });

  describe('bank change requests', () => {
    const typed = '1234 5678 9012 3456';
    const digits = '1234567890123456';
    const bankBody = (extra: Record<string, unknown> = {}) => ({
      bankName: 'Nabil Bank',
      accountName: 'Himal Traders',
      accountNumber: typed,
      ...extra,
    });

    it('creates a proposed account, once per Idempotency-Key, with the last four digits only', async () => {
      const a = await vendor('approved');
      const key = randomUUID();

      const first = await as(a, (who) => service.requestBankChange(who, bankBody(), key));
      const replay = await as(a, (who) => service.requestBankChange(who, bankBody(), key));

      VendorBankAccountDtoSchema.parse(first);
      expect(first).toMatchObject({
        vendorPartyId: a.partyId,
        accountLast4: '3456',
        status: 'proposed',
        proposedVia: 'portal',
      });
      expect(replay.id).toBe(first.id);
      expect(JSON.stringify(first)).not.toContain(digits);
      const rows = await appPool.query<{
        status: string;
        proposed_via: string;
        proposed_by: string;
        last4: string;
      }>(
        'SELECT status, proposed_via, proposed_by, last4 FROM app.vendor_bank_accounts WHERE vendor_id = $1',
        [a.partyId],
      );
      // One row, proposed by the portal user, never active.
      expect(rows.rows).toEqual([
        { status: 'proposed', proposed_via: 'portal', proposed_by: a.userId, last4: '3456' },
      ]);
      const audit = await auditText(first.id);
      expect(audit.length).toBeGreaterThan(0);
      for (const t of audit) expect(t).not.toContain(digits);
      expect(audit.join('\n')).toContain('3456');
    });

    it('refuses a supportingDocumentId with 422 supporting_document_unsupported and writes nothing', async () => {
      const a = await vendor('approved');

      const res = await errorOf(
        as(a, (who) =>
          service.requestBankChange(
            who,
            bankBody({ supportingDocumentId: randomUUID() }),
            randomUUID(),
          ),
        ),
      );

      expect(res.status).toBe(422);
      expect(res.body).toMatchObject({ code: 'supporting_document_unsupported' });
      expect(await count('vendor_bank_accounts', `vendor_id = '${a.partyId}'`)).toBe(0);
    });

    it('refuses an invalid body with 400 naming fields only, and a staff principal with 403', async () => {
      const a = await vendor('approved');

      const bad = await errorOf(
        as(a, (who) =>
          service.requestBankChange(
            who,
            bankBody({ accountNumber: 'not-a-number!!' }),
            randomUUID(),
          ),
        ),
      );
      const staff = await errorOf(
        as(a, (who) => service.requestBankChange(who, bankBody(), randomUUID()), {
          orgKind: 'staff',
          partyId: null,
        }),
      );

      expect(bad.status).toBe(400);
      expect(JSON.stringify(bad.body)).not.toContain('not-a-number');
      expect(staff.status).toBe(403);
      expect(await count('vendor_bank_accounts', `vendor_id = '${a.partyId}'`)).toBe(0);
    });

    it('proposes for the caller only: another vendor gets its own row and the first is untouched', async () => {
      const a = await vendor('approved');
      const b = await vendor('approved');

      const forA = await as(a, (who) => service.requestBankChange(who, bankBody(), randomUUID()));
      const forB = await as(b, (who) =>
        service.requestBankChange(who, bankBody({ accountNumber: '998877665544' }), randomUUID()),
      );

      expect(forA.vendorPartyId).toBe(a.partyId);
      expect(forB.vendorPartyId).toBe(b.partyId);
      expect(forB.id).not.toBe(forA.id);
      expect(await count('vendor_bank_accounts', `vendor_id = '${a.partyId}'`)).toBe(1);
      expect(await count('vendor_bank_accounts', `vendor_id = '${b.partyId}'`)).toBe(1);
      expect(await count('vendor_bank_accounts', "status = 'active'")).toBe(0);
    });
  });
});
