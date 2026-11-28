// Integration tests of sourcing and the commitment approval on a real Postgres (Testcontainers, needs Docker in WSL).
// Real: migrations as bos_owner, queries as bos_app, SourcingService, the real ApprovalsService with the
// `pr_commitment` workflow published through ApprovalsAdminService (spec PR_COMMITMENT_WORKFLOW_SPEC, which the seed
// copies), the real PrCommitmentSubject (draft PO), NumberingService, MoneyService (NPR) and AuditService. Faked:
// notify, the role directory (role -> real staff users of entity A), settings (min_quotes 3), the request context.
// Run: pnpm --filter @bos/api exec vitest run src/modules/procurement/sourcing/sourcing.integration.test.ts
import 'reflect-metadata';

import { randomUUID } from 'node:crypto';

import {
  DEFAULT_ROLE_PERMISSIONS,
  type Permission,
  type RoleKey,
  type Scope,
} from '@bos/contracts';
import {
  createCostCenter,
  approvalRequests,
  approvalSteps,
  createDepartment,
  createParty,
  createStaffUser,
  createTenantWithEntity,
  purchaseOrders,
  purchaseRequests,
} from '@bos/db';
import { HttpException } from '@nestjs/common';
import { and, asc, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { AuditService } from '../../../platform/audit/audit.service';
import type { Principal } from '../../../platform/authz/principal';
import type { Db, DbTransaction } from '../../../platform/db/db.module';
import { systemActor, withTx, type TxScope } from '../../../platform/db/tx';
import { MoneyService } from '../../../platform/settings/money.service';
import { NumberingService } from '../../../platform/settings/numbering.service';
import { ApprovalsAdminService } from '../../approvals/admin.service';
import { asSecondPerson, SKIP_LIVE_PUBLISHER_CHECK } from '../../../../test/support/second-person';
import { ApprovalsService } from '../../approvals/requests.service';
import { PrCommitmentSubject } from './pr-commitment.subject';
import { PR_COMMITMENT_DOCUMENT_TYPE, PR_COMMITMENT_WORKFLOW_SPEC } from './sourcing.rules';
import { evidenceFixture, type EvidenceFixture } from '../../evidence/evidence.fixture';
import { SourcingService } from './sourcing.service';
import { createTestDatabase, type TestDatabase } from '@bos/db/testing';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 180_000 });

const now = new Date('2026-11-09T04:00:00Z');

let testDb: TestDatabase;
let ownerPool: Pool;
let appPool: Pool;
let db: Db;
let scopeA: TxScope;
let scopeB: TxScope;
let approvals: ApprovalsService;
let service: SourcingService;
let deptA = '';
let deptB = '';
let vatCode = '';
/** Quotation files uploaded through the RFQ's evidence route, DocumentsService and the `evidence` owner policy. */
let evidence: EvidenceFixture;

const U = { req: '', proc: '', proc2: '', acct: '', fin: '', mgmt: '', mgmt2: '', founder: '' };
const roles: Partial<Record<RoleKey, string[]>> = {};
const resetRoles = () => {
  roles.accountant = [U.acct];
  roles.finance = [U.fin];
  roles.management = [U.mgmt];
  roles.founder = [U.founder];
};

const grantsOf = (role: RoleKey) =>
  new Map(Object.entries(DEFAULT_ROLE_PERMISSIONS[role])) as Map<Permission, Scope>;
const current: { userId: string; role: RoleKey; scope: TxScope | null } = {
  userId: '',
  role: 'procurement',
  scope: null,
};
const as = (userId: string, role: RoleKey) => {
  current.userId = userId;
  current.role = role;
};
const scopeNow = (): TxScope => current.scope ?? scopeA;
const principalNow = (): Principal => ({
  userId: current.userId,
  zitadelUserId: `z-${current.userId}`,
  ...scopeNow(),
  orgKind: 'staff',
  partyId: null,
  idpOrgId: 'unused',
  roles: [current.role],
  departmentId: null,
  status: 'active',
  grants: grantsOf(current.role),
});
const caller = {
  current: () => ({
    scope: scopeNow(),
    actor: { kind: 'user' as const, id: current.userId, correlationId: 'test-corr' },
    principal: principalNow(),
  }),
};
const notify = {
  notifyUser: vi.fn(() => Promise.resolve(undefined)),
  notifyRole: vi.fn(() => Promise.resolve(undefined)),
};
const directory = {
  userIdsWithRole: vi.fn((_s: unknown, role: RoleKey) => Promise.resolve(roles[role] ?? [])),
  resolve: vi.fn(),
  emailOf: vi.fn(() => Promise.resolve(null)),
};

const exec = (scope: TxScope, q: ReturnType<typeof sql>) =>
  withTx(db, scope, systemActor('test'), (tx) => tx.execute(q));
const read = <T>(fn: (tx: DbTransaction) => Promise<T>) =>
  withTx(db, scopeA, systemActor('test'), fn);

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
  scopeA = { tenantId: tenant.tenantId, organizationId: tenant.organizationId };
  const otherEntityId = randomUUID();
  await exec(
    scopeA,
    sql`INSERT INTO app.organizations (id, tenant_id, organization_id, name, code, legal_name, is_default)
        VALUES (${otherEntityId}, ${scopeA.tenantId}, ${otherEntityId}, ${`E-${otherEntityId}`},
                ${`E-${otherEntityId}`}, ${`E-${otherEntityId}`}, false)`,
  );
  scopeB = { tenantId: scopeA.tenantId, organizationId: otherEntityId };

  const staff = async (roleKey: RoleKey) =>
    (await createStaffUser(appPool, { ...scopeA, idpOrgId: tenant.idpOrgId, roleKeys: [roleKey] }))
      .userId;
  U.req = await staff('operations_officer');
  U.proc = await staff('procurement');
  U.proc2 = await staff('procurement');
  U.acct = await staff('accountant');
  U.fin = await staff('finance');
  U.mgmt = await staff('management');
  U.mgmt2 = await staff('management');
  U.founder = await staff('founder');
  resetRoles();
  deptA = (await createDepartment(appPool, scopeA)).departmentId;
  deptB = (await createDepartment(appPool, scopeB)).departmentId;

  const { rows } = await exec(
    scopeA,
    sql`INSERT INTO app.tax_codes (tenant_id, code, name, kind, rate_bp, creditable, effective_from)
        VALUES (${scopeA.tenantId}, 'VAT13', 'VAT 13%', 'vat', 1300, true, '2020-01-01') RETURNING id`,
  );
  vatCode = (rows[0] as { id: string }).id;

  const audit = new AuditService(db);
  as(U.founder, 'founder');
  const admin = new ApprovalsAdminService(db, audit, caller, () => now);
  const adminPublisher = new ApprovalsAdminService(db, audit, asSecondPerson(caller), () => now);
  await admin.createWorkflow({
    key: PR_COMMITMENT_DOCUMENT_TYPE,
    name: 'Purchase commitment',
    spec: PR_COMMITMENT_WORKFLOW_SPEC,
  });
  await adminPublisher.publish(PR_COMMITMENT_DOCUMENT_TYPE, 1, SKIP_LIVE_PUBLISHER_CHECK);

  const numbering = new NumberingService();
  approvals = new ApprovalsService(db, audit, notify, directory, caller, () => now);
  approvals.registerSubject(new PrCommitmentSubject(numbering, () => now));
  service = new SourcingService(
    db,
    approvals,
    audit,
    numbering,
    new MoneyService(db, {} as never),
    { get: () => Promise.resolve(3) } as never,
    caller,
    () => now,
  );
  evidence = await evidenceFixture(db, caller.current);
});

afterAll(async () => {
  await evidence?.close();
  await appPool?.end();
  await ownerPool?.end();
  await testDb?.drop();
});

beforeEach(() => {
  vi.clearAllMocks();
  resetRoles();
  current.scope = null;
  as(U.proc, 'procurement');
});

// ---------------------------------------------------------------------------------------- helpers

async function httpErrorOf(promise: Promise<unknown>): Promise<HttpException> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof HttpException) return error;
    throw error;
  }
  throw new Error('expected the call to fail');
}
const codeOf = (e: HttpException) => (e.getResponse() as { code?: string }).code;

let panSeq = 0;
/** A vendor in `status`, with an account in each of `accountIn`. */
async function vendor(
  status: 'approved' | 'draft',
  accountIn: TxScope[] = [scopeA],
): Promise<string> {
  const { partyId } = await createParty(appPool, {
    tenantId: scopeA.tenantId,
    kind: 'vendor',
    organizationId: scopeA.organizationId,
  });
  await exec(
    scopeA,
    sql`INSERT INTO app.vendors (id, tenant_id, legal_name, pan, status, created_by, approved_by)
        VALUES (${partyId}, ${scopeA.tenantId}, ${`Vendor ${partyId.slice(0, 6)}`},
                ${String(100_000_000 + (panSeq += 1))}, ${status}, ${U.proc},
                ${status === 'approved' ? U.mgmt : null})`,
  );
  for (const s of accountIn) {
    await exec(
      s,
      sql`INSERT INTO app.vendor_accounts (tenant_id, organization_id, vendor_id)
          VALUES (${s.tenantId}, ${s.organizationId}, ${partyId})`,
    );
  }
  return partyId;
}

/** A dept_approved request of `requester` in `scope`, with one line; returns its id and line id. */
async function deptApprovedPr(
  opts: { requester?: string; scope?: TxScope; emergency?: boolean } = {},
): Promise<{ id: string; lineId: string }> {
  const scope = opts.scope ?? scopeA;
  const id = randomUUID();
  const lineId = randomUUID();
  await exec(
    scope,
    sql`INSERT INTO app.purchase_requests (id, tenant_id, organization_id, request_type, department_id,
          requester_user_id, cost_center_id, justification, required_by, budget_code, currency, is_emergency,
          emergency_reason)
        VALUES (${id}, ${scope.tenantId}, ${scope.organizationId}, 'goods',
                ${scope === scopeA ? deptA : deptB}, ${opts.requester ?? U.req}, ${(await createCostCenter(appPool, scope)).costCenterId}, 'Laptops',
                '2026-12-01', 'IT-2083', 'NPR', ${opts.emergency ?? false},
                ${opts.emergency ? 'Server room flood' : null})`,
  );
  await exec(
    scope,
    sql`INSERT INTO app.purchase_request_lines (id, tenant_id, organization_id, purchase_request_id, line_no,
          description, uom, quantity, estimated_unit_price, estimated_amount)
        VALUES (${lineId}, ${scope.tenantId}, ${scope.organizationId}, ${id}, 1, 'Laptop', 'pcs', 1, 100000, 100000)`,
  );
  await exec(
    scope,
    sql`UPDATE app.purchase_requests SET status = 'dept_approved', fx_rate = 1, estimated_total = 100000,
          estimated_total_npr = 100000, number = ${`PR-T-${id.slice(0, 8)}`} WHERE id = ${id}`,
  );
  return { id, lineId };
}

/** The vendor's quotation file, uploaded in place on the RFQ by the caller (as the RFQ quote form does). */
const quoteFile = (rfqId: string) => evidence.upload('rfq', rfqId);

/**
 * A document row of `ownerType` on `ownerId`, as an upload leaves it: for states an upload alone cannot reach here
 * (infected, removed) and for files of other owners.
 */
async function doc(ownerType: string, ownerId: string, scope: TxScope = scopeA): Promise<string> {
  const { rows } = await exec(
    scope,
    sql`INSERT INTO app.documents (tenant_id, organization_id, owner_type, owner_id)
        VALUES (${scope.tenantId}, ${scope.organizationId}, ${ownerType}, ${ownerId}) RETURNING id`,
  );
  return (rows[0] as { id: string }).id;
}

/** An RFQ with `n` approved vendors that each quote; quotation i has net `nets[i]` + 13% VAT. */
async function rfqWithQuotes(
  nets: string[],
  pr?: { id: string; lineId: string },
): Promise<{ rfqId: string; prId: string; quoteIds: string[] }> {
  const p = pr ?? (await deptApprovedPr());
  const vendorIds: string[] = [];
  for (const _ of nets) vendorIds.push(await vendor('approved'));
  const rfq = await service.createRfq(
    { purchaseRequestId: p.id, deadline: '2026-11-20T10:00:00+05:45', vendorIds },
    randomUUID(),
  );
  const quoteIds: string[] = [];
  for (const [i, net] of nets.entries()) {
    const q = await service.recordQuotation(
      rfq.id,
      {
        vendorId: vendorIds[i]!,
        documentId: await quoteFile(rfq.id),
        currency: 'NPR',
        lines: [{ prLineId: p.lineId, quantity: '1', unitPrice: net, taxCodeId: vatCode }],
      },
      randomUUID(),
    );
    quoteIds.push(q.id);
  }
  return { rfqId: rfq.id, prId: p.id, quoteIds };
}

/** Recommends quotation `pick` (by U.proc) and submits the commitment (by `submitter`). */
async function committed(nets: string[], pick = 0, pr?: { id: string; lineId: string }) {
  const r = await rfqWithQuotes(nets, pr);
  await service.recommend(
    r.rfqId,
    {
      vendorQuotationId: r.quoteIds[pick]!,
      rationale: 'Cheapest compliant quote',
      ...(nets.length < 3 ? { fewerThanThreeReason: 'Only these vendors stock it' } : {}),
    },
    randomUUID(),
  );
  return { ...r, commit: () => service.submitCommitment(r.rfqId, randomUUID()) };
}

const requestsOf = (rfqId: string) =>
  read((tx) =>
    tx
      .select()
      .from(approvalRequests)
      .where(
        and(
          eq(approvalRequests.documentType, PR_COMMITMENT_DOCUMENT_TYPE),
          eq(approvalRequests.documentId, rfqId),
        ),
      ),
  );
const stepRoles = async (requestId: string) =>
  (
    await read((tx) =>
      tx
        .select({ roleKey: approvalSteps.roleKey })
        .from(approvalSteps)
        .where(eq(approvalSteps.requestId, requestId))
        .orderBy(asc(approvalSteps.seq)),
    )
  ).map((s) => s.roleKey);

async function approve(user: string, role: RoleKey, requestId: string) {
  const [req] = await read((tx) =>
    tx
      .select({ version: approvalRequests.version })
      .from(approvalRequests)
      .where(eq(approvalRequests.id, requestId)),
  );
  as(user, role);
  try {
    return await approvals.act(
      requestId,
      { action: 'approve', expectedVersion: req!.version },
      randomUUID(),
    );
  } finally {
    as(U.proc, 'procurement');
  }
}

// ---------------------------------------------------------------------------------------- RFQ

describe('RFQ', () => {
  it.each([
    ['a past deadline', '2020-01-01T17:00:00+05:45'],
    ['a deadline of exactly now', now.toISOString()],
  ])('refuses %s with 400 deadline_in_past and opens nothing (I-28)', async (_label, deadline) => {
    const pr = await deptApprovedPr();
    const v = await vendor('approved');
    const e = await httpErrorOf(
      service.createRfq({ purchaseRequestId: pr.id, deadline, vendorIds: [v] }, randomUUID()),
    );
    expect(e.getStatus()).toBe(400);
    expect(e.getResponse()).toMatchObject({
      code: 'bad_request',
      reason: 'deadline_in_past',
      message: 'The quotation deadline has passed. Choose a date and time in the future.',
    });
    const rfqRows = await exec(
      scopeA,
      sql`SELECT id FROM app.rfqs WHERE purchase_request_id = ${pr.id}`,
    );
    expect(rfqRows.rows).toEqual([]);
    const [row] = await read((tx) =>
      tx.select().from(purchaseRequests).where(eq(purchaseRequests.id, pr.id)),
    );
    expect(row!.status).toBe('dept_approved');
  });

  it('opens an RFQ whose deadline is a minute after now (I-28)', async () => {
    const pr = await deptApprovedPr();
    const v = await vendor('approved');
    const rfq = await service.createRfq(
      {
        purchaseRequestId: pr.id,
        deadline: new Date(now.getTime() + 60_000).toISOString(),
        vendorIds: [v],
      },
      randomUUID(),
    );
    expect(rfq.status).toBe('open');
  });

  it('refuses an unapproved vendor with 409 VENDOR_NOT_APPROVED', async () => {
    const pr = await deptApprovedPr();
    const v = await vendor('draft');
    const e = await httpErrorOf(
      service.createRfq(
        { purchaseRequestId: pr.id, deadline: '2026-11-20T10:00:00Z', vendorIds: [v] },
        randomUUID(),
      ),
    );
    expect(e.getStatus()).toBe(409);
    expect(codeOf(e)).toBe('VENDOR_NOT_APPROVED');
  });

  it('refuses an approved vendor with no account in the entity with 409 VENDOR_NOT_IN_ENTITY', async () => {
    const pr = await deptApprovedPr();
    const v = await vendor('approved', [scopeB]);
    const e = await httpErrorOf(
      service.createRfq(
        { purchaseRequestId: pr.id, deadline: '2026-11-20T10:00:00Z', vendorIds: [v] },
        randomUUID(),
      ),
    );
    expect(e.getStatus()).toBe(409);
    expect(codeOf(e)).toBe('VENDOR_NOT_IN_ENTITY');
  });

  it('needs a dept_approved request and moves it to sourcing', async () => {
    const { prId } = await rfqWithQuotes(['1000.00']);
    const [pr] = await read((tx) =>
      tx.select().from(purchaseRequests).where(eq(purchaseRequests.id, prId)),
    );
    expect(pr!.status).toBe('sourcing');
    const v = await vendor('approved');
    const e = await httpErrorOf(
      service.createRfq(
        { purchaseRequestId: prId, deadline: '2026-11-20T10:00:00Z', vendorIds: [v] },
        randomUUID(),
      ),
    );
    expect(e.getStatus()).toBe(409);
  });

  it("is a 404 for another entity's request and another entity's RFQ", async () => {
    const prB = await deptApprovedPr({ scope: scopeB });
    const v = await vendor('approved');
    const e = await httpErrorOf(
      service.createRfq(
        { purchaseRequestId: prB.id, deadline: '2026-11-20T10:00:00Z', vendorIds: [v] },
        randomUUID(),
      ),
    );
    expect(e.getStatus()).toBe(404);
    const { rfqId } = await rfqWithQuotes(['1000.00']);
    current.scope = scopeB;
    expect((await httpErrorOf(service.getRfq(rfqId))).getStatus()).toBe(404);
  });

  it('refuses to record a quotation on a file the scan found infected, and writes no quotation (TR-Q12e)', async () => {
    const p = await deptApprovedPr();
    const v = await vendor('approved');
    const rfq = await service.createRfq(
      { purchaseRequestId: p.id, deadline: '2026-11-20T10:00:00+05:45', vendorIds: [v] },
      randomUUID(),
    );
    const documentId = await doc('evidence', rfq.id);
    await exec(
      scopeA,
      sql`INSERT INTO app.document_versions (tenant_id, organization_id, document_id, version, filename,
            declared_mime, size_bytes, storage_key, status)
          VALUES (${scopeA.tenantId}, ${scopeA.organizationId}, ${documentId}, 1, 'quote.pdf',
                  'application/pdf', 1024, ${`${scopeA.tenantId}/${randomUUID()}`}, 'infected')`,
    );
    const e = await httpErrorOf(
      service.recordQuotation(
        rfq.id,
        {
          vendorId: v,
          documentId,
          currency: 'NPR',
          lines: [{ prLineId: p.lineId, quantity: '1', unitPrice: '1000.00', taxCodeId: vatCode }],
        },
        randomUUID(),
      ),
    );
    expect(e.getStatus()).toBe(409);
    expect(e.getResponse()).toMatchObject({ code: 'document_infected' });
    const { rows } = await exec(
      scopeA,
      sql`SELECT count(*)::int AS n FROM app.vendor_quotations WHERE rfq_id = ${rfq.id}`,
    );
    expect(rows[0]).toEqual({ n: 0 });
  });

  it('refuses to record a quotation on a removed file with 422 invalid_evidence_document, and writes no quotation', async () => {
    const p = await deptApprovedPr();
    const v = await vendor('approved');
    const rfq = await service.createRfq(
      { purchaseRequestId: p.id, deadline: '2026-11-20T10:00:00+05:45', vendorIds: [v] },
      randomUUID(),
    );
    const documentId = await quoteFile(rfq.id);
    await exec(scopeA, sql`UPDATE app.documents SET removed_at = now() WHERE id = ${documentId}`);
    const e = await httpErrorOf(
      service.recordQuotation(
        rfq.id,
        {
          vendorId: v,
          documentId,
          currency: 'NPR',
          lines: [{ prLineId: p.lineId, quantity: '1', unitPrice: '1000.00', taxCodeId: vatCode }],
        },
        randomUUID(),
      ),
    );
    expect(e.getStatus()).toBe(422);
    expect(e.getResponse()).toMatchObject({ code: 'invalid_evidence_document' });
    const { rows } = await exec(
      scopeA,
      sql`SELECT count(*)::int AS n FROM app.vendor_quotations WHERE rfq_id = ${rfq.id}`,
    );
    expect(rows[0]).toEqual({ n: 0 });
  });

  // Round 5 P2: the staff path takes only a file uploaded to this RFQ; the inbox conversion keeps the vendor's file.
  it.each<[string, (rfqId: string, vendorId: string) => Promise<string>]>([
    ['any live document of the entity (another record)', () => doc('rfq', randomUUID())],
    ['a vendor-inbox upload', (_rfqId, vendorId) => doc('vendor_portal_intake', vendorId)],
    ['a picture (the vendor logo)', (_rfqId, vendorId) => doc('vendor_logo', vendorId)],
    [
      'evidence of another RFQ',
      async () => {
        const other = await rfqWithQuotes(['1000.00']);
        return doc('evidence', other.rfqId);
      },
    ],
    ["another entity's evidence on the same id", (rfqId) => doc('evidence', rfqId, scopeB)],
  ])(
    'refuses to record a quotation on %s with 422 invalid_evidence_document',
    async (_label, fileOf) => {
      const p = await deptApprovedPr();
      const v = await vendor('approved');
      const rfq = await service.createRfq(
        { purchaseRequestId: p.id, deadline: '2026-11-20T10:00:00+05:45', vendorIds: [v] },
        randomUUID(),
      );
      const e = await httpErrorOf(
        service.recordQuotation(
          rfq.id,
          {
            vendorId: v,
            documentId: await fileOf(rfq.id, v),
            currency: 'NPR',
            lines: [
              { prLineId: p.lineId, quantity: '1', unitPrice: '1000.00', taxCodeId: vatCode },
            ],
          },
          randomUUID(),
        ),
      );
      expect(e.getStatus()).toBe(422);
      expect(e.getResponse()).toMatchObject({ code: 'invalid_evidence_document' });
      const { rows } = await exec(
        scopeA,
        sql`SELECT count(*)::int AS n FROM app.vendor_quotations WHERE rfq_id = ${rfq.id}`,
      );
      expect(rows[0]).toEqual({ n: 0 });
    },
  );

  it('refuses to record a quotation on a file reserved on the RFQ route whose bytes were never sent (422)', async () => {
    const p = await deptApprovedPr();
    const v = await vendor('approved');
    const rfq = await service.createRfq(
      { purchaseRequestId: p.id, deadline: '2026-11-20T10:00:00+05:45', vendorIds: [v] },
      randomUUID(),
    );
    const reserved = await evidence.service.create('rfq', rfq.id, {
      filename: 'quote.pdf',
      declaredMime: 'application/pdf',
      sizeBytes: 1024,
    });
    const e = await httpErrorOf(
      service.recordQuotation(
        rfq.id,
        {
          vendorId: v,
          documentId: reserved.documentId,
          currency: 'NPR',
          lines: [{ prLineId: p.lineId, quantity: '1', unitPrice: '1000.00', taxCodeId: vatCode }],
        },
        randomUUID(),
      ),
    );
    expect(e.getStatus()).toBe(422);
    expect(e.getResponse()).toMatchObject({
      code: 'invalid_evidence_document',
      message: expect.stringMatching(/has not finished uploading/) as string,
    });
    const { rows } = await exec(
      scopeA,
      sql`SELECT count(*)::int AS n FROM app.vendor_quotations WHERE rfq_id = ${rfq.id}`,
    );
    expect(rows[0]).toEqual({ n: 0 });
  });

  it('freezes a recorded quotation file: no removal or new version while the RFQ is open; an unused file goes', async () => {
    const { rfqId } = await rfqWithQuotes(['1000.00']);
    const [quote] = await read((tx) =>
      tx.execute(sql`SELECT document_id FROM app.vendor_quotations WHERE rfq_id = ${rfqId}`),
    ).then((r) => r.rows as { document_id: string }[]);
    const { scope, actor } = caller.current();
    // Procurement holds documents.upload (own) and procurement.sourcing: the generic routes' grants.
    expect(principalNow().grants.has('documents.upload')).toBe(true);
    // Its uploader cannot remove it on the RFQ's own route; the generic routes take no evidence file at all.
    const removed = await httpErrorOf(evidence.service.remove('rfq', rfqId, quote!.document_id));
    expect(removed.getStatus()).toBe(409);
    expect(removed.getResponse()).toMatchObject({
      message: 'This record no longer accepts attachments',
    });
    const versioned = await httpErrorOf(
      withTx(db, scope, actor, (tx) =>
        evidence.documents.createVersion(tx, quote!.document_id, {
          filename: 'swap.pdf',
          declaredMime: 'application/pdf',
          sizeBytes: 10,
        }),
      ),
    );
    expect(versioned.getStatus()).toBe(409);
    const unused = await quoteFile(rfqId);
    await evidence.service.remove('rfq', rfqId, unused);
    const { rows } = await exec(
      scopeA,
      sql`SELECT (removed_at IS NOT NULL) AS removed FROM app.documents WHERE id IN (${quote!.document_id}, ${unused})
          ORDER BY removed`,
    );
    expect(rows).toEqual([{ removed: false }, { removed: true }]);
  });

  it('lets only a sourcing holder upload a quotation file, to an open RFQ of the entity', async () => {
    const { rfqId } = await rfqWithQuotes(['1000.00']);
    const file = { filename: 'quote.pdf', declaredMime: 'application/pdf', sizeBytes: 10 };
    const created = await evidence.service.create('rfq', rfqId, file);
    expect(created.uploadPath).toBe(
      `/v1/procurement/rfqs/${rfqId}/evidence-documents/${created.documentId}/versions/${created.versionId}/content`,
    );
    // An accountant marks lines and enters bills; no sourcing grant, so no RFQ evidence.
    as(U.acct, 'accountant');
    expect((await httpErrorOf(evidence.service.create('rfq', rfqId, file))).getStatus()).toBe(403);
    // Neither the bill nor the order route resolves an RFQ id.
    as(U.founder, 'founder');
    for (const kind of ['vendor_bill', 'sales_order'] as const) {
      expect((await httpErrorOf(evidence.service.create(kind, rfqId, file))).getStatus()).toBe(404);
    }
    current.scope = scopeB;
    expect((await httpErrorOf(evidence.service.create('rfq', rfqId, file))).getStatus()).toBe(404);
    current.scope = null;
    as(U.proc, 'procurement');
    await exec(scopeA, sql`UPDATE app.rfqs SET status = 'closed' WHERE id = ${rfqId}`);
    expect((await httpErrorOf(evidence.service.create('rfq', rfqId, file))).getStatus()).toBe(409);
  });

  it('lets the uploader remove an unused quotation file on the RFQ route; refuses a colleague, a recorded file and a closed RFQ', async () => {
    const { rfqId } = await rfqWithQuotes(['1000.00']);
    const [recorded] = await read((tx) =>
      tx.execute(sql`SELECT document_id FROM app.vendor_quotations WHERE rfq_id = ${rfqId}`),
    ).then((r) => r.rows as { document_id: string }[]);
    const removedOf = (id: string) =>
      read((tx) =>
        tx.execute(
          sql`SELECT (removed_at IS NOT NULL) AS removed FROM app.documents WHERE id = ${id}`,
        ),
      ).then((r) => (r.rows[0] as { removed: boolean }).removed);
    const unused = await quoteFile(rfqId);

    // A colleague holds procurement.sourcing on every RFQ but did not upload the file.
    as(U.proc2, 'procurement');
    expect((await httpErrorOf(evidence.service.remove('rfq', rfqId, unused))).getStatus()).toBe(
      403,
    );
    as(U.proc, 'procurement');
    expect(
      (await httpErrorOf(evidence.service.remove('rfq', rfqId, recorded!.document_id))).getStatus(),
    ).toBe(409);
    expect(
      (await httpErrorOf(evidence.service.remove('vendor_bill', rfqId, unused))).getStatus(),
    ).toBe(404);
    await evidence.service.remove('rfq', rfqId, unused);
    await evidence.service.remove('rfq', rfqId, unused);
    expect([await removedOf(recorded!.document_id), await removedOf(unused)]).toEqual([
      false,
      true,
    ]);

    const left = await quoteFile(rfqId);
    await exec(scopeA, sql`UPDATE app.rfqs SET status = 'closed' WHERE id = ${rfqId}`);
    expect((await httpErrorOf(evidence.service.remove('rfq', rfqId, left))).getStatus()).toBe(409);
    expect(await removedOf(left)).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------- recommendation (AD13)

describe('recommendation', () => {
  it('fewer than 3 quotes without a reason is 409; with a reason it is recommended', async () => {
    const r = await rfqWithQuotes(['1000.00', '1100.00']);
    const e = await httpErrorOf(
      service.recommend(
        r.rfqId,
        { vendorQuotationId: r.quoteIds[0]!, rationale: 'Cheapest' },
        randomUUID(),
      ),
    );
    expect(e.getStatus()).toBe(409);
    expect(codeOf(e)).toBe('FEWER_THAN_MIN_QUOTES');
    const ok = await service.recommend(
      r.rfqId,
      {
        vendorQuotationId: r.quoteIds[0]!,
        rationale: 'Cheapest',
        fewerThanThreeReason: 'Sole distributors',
      },
      randomUUID(),
    );
    expect(ok.status).toBe('recommended');
    expect(ok.fewerThanThreeReason).toBe('Sole distributors');
  });

  it('an emergency request goes below 3 quotes on its emergency reason', async () => {
    const pr = await deptApprovedPr({ emergency: true });
    const r = await rfqWithQuotes(['1000.00'], pr);
    const ok = await service.recommend(
      r.rfqId,
      { vendorQuotationId: r.quoteIds[0]!, rationale: 'Only one in stock' },
      randomUUID(),
    );
    expect(ok.fewerThanThreeReason).toBe('Emergency purchase: Server room flood');
  });
});

// ---------------------------------------------------------------------------------------- commitment

describe('commitment bands (done check 2)', () => {
  // Nets whose total incl. 13% VAT lands on the band edges: 88495.58 * 1.13 = 99999.99 (rounded half up)...
  it.each([
    // [net, total incl. VAT, roles]
    ['88495.57', '99999.99', ['accountant', 'finance']],
    ['90000.00', '101700.00', ['accountant', 'finance', 'management']],
    ['884955.76', '1000000.01', ['accountant', 'finance', 'management', 'founder']],
  ])('net %s (total %s) routes %j', async (net, total, expected) => {
    const c = await committed([net, '999999.00', '999999.00']);
    await c.commit();
    const [request] = await requestsOf(c.rfqId);
    expect((request!.facts as { amountNpr: string }).amountNpr).toBe(total);
    expect(await stepRoles(request!.id)).toEqual(expected);
  });

  it('a total of exactly 100,000.00 routes Accountant and Finance only; 100,000.01 adds Management', async () => {
    // 0% VAT code so the total is the net exactly.
    const { rows } = await exec(
      scopeA,
      sql`INSERT INTO app.tax_codes (tenant_id, code, name, kind, rate_bp, creditable, effective_from)
          VALUES (${scopeA.tenantId}, ${`Z${randomUUID().slice(0, 6)}`}, 'Zero', 'zero', 0, false, '2020-01-01')
          RETURNING id`,
    );
    const zero = (rows[0] as { id: string }).id;
    for (const [net, expected] of [
      ['100000.00', ['accountant', 'finance']],
      ['100000.01', ['accountant', 'finance', 'management']],
    ] as const) {
      const pr = await deptApprovedPr();
      const v = await vendor('approved');
      const rfq = await service.createRfq(
        { purchaseRequestId: pr.id, deadline: '2026-11-20T10:00:00Z', vendorIds: [v] },
        randomUUID(),
      );
      const q = await service.recordQuotation(
        rfq.id,
        {
          vendorId: v,
          documentId: await quoteFile(rfq.id),
          currency: 'NPR',
          lines: [{ prLineId: pr.lineId, quantity: '1', unitPrice: net, taxCodeId: zero }],
        },
        randomUUID(),
      );
      await service.recommend(
        rfq.id,
        { vendorQuotationId: q.id, rationale: 'Only one', fewerThanThreeReason: 'Sole vendor' },
        randomUUID(),
      );
      await service.submitCommitment(rfq.id, randomUUID());
      const [request] = await requestsOf(rfq.id);
      expect(await stepRoles(request!.id)).toEqual(expected);
    }
  });
});

describe('separation of duties (done check 4)', () => {
  it('the recommender is excluded from the commitment route', async () => {
    // The recommender (U.proc2) is also the only Accountant: the route has nobody for step 1.
    roles.accountant = [U.proc2];
    const r = await rfqWithQuotes(['1000.00', '1000.00', '1000.00']);
    // A long RFQ history must still exclude the recommender beyond the audit reader's page size.
    await withTx(db, scopeA, systemActor('test'), async (tx) => {
      await tx.execute(sql`SELECT audit.record('test.noise', 'rfqs', ${r.rfqId}, NULL, NULL, NULL)
        FROM generate_series(1, 501)`);
    });
    as(U.proc2, 'procurement');
    await service.recommend(
      r.rfqId,
      { vendorQuotationId: r.quoteIds[0]!, rationale: 'Cheapest' },
      randomUUID(),
    );
    as(U.proc, 'procurement');
    const e = await httpErrorOf(service.submitCommitment(r.rfqId, randomUUID()));
    expect(e.getStatus()).toBe(422);
    expect(codeOf(e)).toBe('NO_ELIGIBLE_APPROVER');
    expect(await requestsOf(r.rfqId)).toHaveLength(0);
    // With a second Accountant it routes, and the recommender is on the SoD list.
    roles.accountant = [U.proc2, U.acct];
    await service.submitCommitment(r.rfqId, randomUUID());
    const [request] = await requestsOf(r.rfqId);
    expect(request!.sodUserIds).toEqual(expect.arrayContaining([U.req, U.proc2, U.proc]));
  });
});

describe('Founder as requester (AD8, done check 5)', () => {
  const big = '1327433.63'; // * 1.13 = 1,500,000.00

  it('with one Management user: 422 NO_ELIGIBLE_APPROVER and no request row', async () => {
    const pr = await deptApprovedPr({ requester: U.founder });
    const c = await committed([big, '1400000.00', '1400000.00'], 0, pr);
    const e = await httpErrorOf(c.commit());
    expect(e.getStatus()).toBe(422);
    expect(codeOf(e)).toBe('NO_ELIGIBLE_APPROVER');
    expect(await requestsOf(c.rfqId)).toHaveLength(0);
    const [row] = await read((tx) =>
      tx.select().from(purchaseRequests).where(eq(purchaseRequests.id, pr.id)),
    );
    expect(row!.status).toBe('sourcing');
  });

  it('with two Management users: two distinct Management steps, no Founder step', async () => {
    roles.management = [U.mgmt, U.mgmt2];
    const pr = await deptApprovedPr({ requester: U.founder });
    const c = await committed([big, '1400000.00', '1400000.00'], 0, pr);
    await c.commit();
    const [request] = await requestsOf(c.rfqId);
    expect((request!.facts as { amountNpr: string }).amountNpr).toBe('1500000.00');
    expect(await stepRoles(request!.id)).toEqual([
      'accountant',
      'finance',
      'management',
      'management',
    ]);
  });
});

describe('approval creates the draft PO', () => {
  it('names the recommended vendor of the commitment for its approver (I-31)', async () => {
    const c = await committed(['90000.00', '95000.00', '99000.00']);
    await c.commit();
    const [request] = await requestsOf(c.rfqId);
    const { rows } = await exec(
      scopeA,
      sql`SELECT v.id, v.legal_name FROM app.vendor_quotations q
            JOIN app.vendors v ON v.tenant_id = q.tenant_id AND v.id = q.vendor_id
           WHERE q.id = ${c.quoteIds[0]!}`,
    );
    const v = rows[0] as { id: string; legal_name: string };
    as(U.acct, 'accountant');
    const dto = await approvals.get(request!.id);
    expect(dto.snapshot).toMatchObject({ commitment: { vendorId: v.id } });
    expect(dto.references).toEqual([{ id: v.id, name: v.legal_name }]);
  });

  it('writes a draft PO with the approved total, its NPR snapshot and the band', async () => {
    const c = await committed(['90000.00', '95000.00', '99000.00']);
    await c.commit();
    const [request] = await requestsOf(c.rfqId);
    await approve(U.acct, 'accountant', request!.id);
    await approve(U.fin, 'finance', request!.id);
    await approve(U.mgmt, 'management', request!.id);
    const pos = await read((tx) =>
      tx.select().from(purchaseOrders).where(eq(purchaseOrders.purchaseRequestId, c.prId)),
    );
    expect(pos).toHaveLength(1);
    expect(pos[0]).toMatchObject({
      status: 'draft',
      approvedTotal: '101700.00',
      approvedTotalNpr: '101700.00',
      approvedBand: 'management',
      vendorQuotationId: c.quoteIds[0],
      rfqId: c.rfqId,
    });
    const [pr] = await read((tx) =>
      tx.select().from(purchaseRequests).where(eq(purchaseRequests.id, c.prId)),
    );
    expect(pr!.status).toBe('approved');
  });
});
