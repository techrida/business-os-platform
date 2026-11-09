// Integration test of the vendor portal inbox writes (P4 PV2) on a real Postgres (Testcontainers, needs Docker in
// WSL), done check 13: a pending_kyc vendor uploads KYC documents but is refused quotation submissions; every id that
// is not the caller's is the same 404; an upload creates only inbox rows; the scan runs.
// Real: migrations as bos_owner, queries as bos_app, VendorPortalInboxService, DocumentsService (storage on a temp
// dir, the type check, the counterparty hook reading the principal bound in the request store, the real
// AuthzService for the fallback grant check), VerificationService's `verification_case` owner policy with the real
// VendorPartyOwner, the `vendor_portal_intake` policy, and ScanProcessor against the fake clamd over TCP.
// Faked: the caller (a vendor Principal per test) and the scan queue (the test runs the scan itself).
// Run: pnpm --filter @bos/api exec vitest run src/modules/portal-vendor/inbox/portal-vendor-inbox.integration.test.ts
import 'reflect-metadata';

import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import type { Permission, Scope } from '@bos/contracts';
import {
  createDepartment,
  createParty,
  createPortalUser,
  createStaffUser,
  createTenantWithEntity,
  runMigrations,
} from '@bos/db';
import { HttpException } from '@nestjs/common';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { Queue } from 'bullmq';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { AuditService } from '../../../platform/audit/audit.service';
import { AuthzService } from '../../../platform/authz/authz.service';
import type { Principal } from '../../../platform/authz/principal';
import type { RoleCache } from '../../../platform/authz/role-cache';
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
import { VendorPartyOwner } from '../../vendors/vendor-party-owner';
import { VerificationService } from '../../verification/verification.service';
import { VENDOR_DEFAULT_CHECKLIST } from '../../verification/verification.rules';
import type { VerificationCaller } from '../../verification/verification.caller';
import { VendorPortalInboxService, type InboxCaller } from './portal-vendor-inbox.service';
import { vendorIntakeOwnerPolicy } from './vendor-intake.policy';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 180_000 });

const OWNER_PW = 'owner-test-pw';
const APP_PW = 'app-test-pw';
const SECRET = 'pv2-it-signed-link-secret-0123456789abcdef';
const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF\n');

let container: StartedPostgreSqlContainer;
let appPool: Pool;
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

const urlFor = (user: string, password: string, database: string) => {
  const url = new URL(container.getConnectionUri());
  url.username = user;
  url.password = password;
  url.pathname = `/${database}`;
  return url.toString();
};
const exec = (q: ReturnType<typeof sql>) =>
  withTx(db, scope, systemActor('test'), (tx) => tx.execute(q));

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

  appPool = new Pool({ connectionString: urlFor('bos_app', APP_PW, 'bos'), max: 8 });
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
  service = new VendorPortalInboxService(db, documents, new AuditService(db), caller);
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
  await container?.stop();
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
                ${randomUUID()}, 'Laptops', '2026-12-01', 'IT-2083', 'NPR')`,
  );
  await exec(
    sql`UPDATE app.purchase_requests SET status = 'approved', fx_rate = 1, estimated_total = '100000.00',
          estimated_total_npr = '100000.00', number = ${`PR-Q-${prId.slice(0, 8)}`} WHERE id = ${prId}`,
  );
  const id = randomUUID();
  await exec(
    sql`INSERT INTO app.rfqs (id, tenant_id, organization_id, purchase_request_id, number, deadline, created_by)
        VALUES (${id}, ${scope.tenantId}, ${scope.organizationId}, ${prId}, ${`RFQ-${(rfqSeq += 1)}`},
                '2026-12-15T00:00:00Z', ${staffId})`,
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
    expect(await count('vendor_quotation_submissions', `rfq_id = '${rfqId}'`)).toBe(0);
  });
});
