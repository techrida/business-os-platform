// More integration tests of sourcing on a real Postgres (Testcontainers, needs Docker in WSL): the two concurrency
// cases, the vendor inbox conversion, score upsert and comparison order, the commitment outcomes (returned,
// rejected) and the RFQ recommend transition. Same setup as sourcing.integration.test.ts (real migrations as
// bos_owner, queries as bos_app, real SourcingService, ApprovalsService, PrCommitmentSubject, NumberingService,
// MoneyService (NPR) and AuditService; faked: notify, the role directory, settings (min_quotes 3), request context).
// Every amount stays in the base band (Accountant, Finance) so the tests do not depend on the larger routes.
// Run: pnpm --filter @bos/api exec vitest run src/modules/procurement/sourcing/sourcing.more.integration.test.ts
import 'reflect-metadata';

import { randomUUID } from 'node:crypto';

import {
  DEFAULT_ROLE_PERMISSIONS,
  canTransitionRfq,
  type Permission,
  type RoleKey,
  type Scope,
} from '@bos/contracts';
import {
  createCostCenter,
  approvalRequests,
  createDepartment,
  createParty,
  createPortalUser,
  createStaffUser,
  createTenantWithEntity,
  purchaseOrders,
  purchaseRequests,
  rfqs,
  runMigrations,
  vendorComparisonScores,
  vendorQuotationSubmissions,
  vendorQuotations,
} from '@bos/db';
import { HttpException } from '@nestjs/common';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { and, eq, sql } from 'drizzle-orm';
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
import { ApprovalsService } from '../../approvals/requests.service';
import { PrCommitmentSubject } from './pr-commitment.subject';
import { PR_COMMITMENT_DOCUMENT_TYPE, PR_COMMITMENT_WORKFLOW_SPEC } from './sourcing.rules';
import { SourcingService } from './sourcing.service';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 180_000 });

const OWNER_PW = 'owner-test-pw';
const APP_PW = 'app-test-pw';
const now = new Date('2026-11-09T04:00:00Z');

let container: StartedPostgreSqlContainer;
let ownerPool: Pool;
let appPool: Pool;
let db: Db;
let scopeA: TxScope;
let scopeB: TxScope;
let audit: AuditService;
let numbering: NumberingService;
let approvals: ApprovalsService;
let service: SourcingService;
let deptA = '';
let vatCode = '';

const U = {
  req: '',
  proc: '',
  proc2: '',
  acct: '',
  fin: '',
  mgmt: '',
  founder: '',
  portal: '',
};
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

const urlFor = (user: string, password: string, database: string) => {
  const url = new URL(container.getConnectionUri());
  url.username = user;
  url.password = password;
  url.pathname = `/${database}`;
  return url.toString();
};
const exec = (scope: TxScope, q: ReturnType<typeof sql>) =>
  withTx(db, scope, systemActor('test'), (tx) => tx.execute(q));
const read = <T>(fn: (tx: DbTransaction) => Promise<T>) =>
  withTx(db, scopeA, systemActor('test'), fn);

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  const admin0 = new Pool({ connectionString: container.getConnectionUri(), max: 1 });
  await admin0.query(`CREATE ROLE bos_owner LOGIN PASSWORD '${OWNER_PW}'`);
  await admin0.query(`CREATE ROLE bos_app LOGIN PASSWORD '${APP_PW}'`);
  await admin0.query('CREATE DATABASE bos OWNER bos_owner');
  await admin0.query('GRANT CONNECT ON DATABASE bos TO bos_app');
  await admin0.end();
  const bosAdmin = new Pool({ connectionString: urlFor('test', 'test', 'bos'), max: 1 });
  await bosAdmin.query(
    'ALTER DEFAULT PRIVILEGES FOR ROLE bos_owner GRANT USAGE ON SCHEMAS TO bos_app',
  );
  await bosAdmin.query(
    'ALTER DEFAULT PRIVILEGES FOR ROLE bos_owner GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO bos_app',
  );
  await bosAdmin.end();
  await runMigrations(urlFor('bos_owner', OWNER_PW, 'bos'));

  ownerPool = new Pool({ connectionString: urlFor('bos_owner', OWNER_PW, 'bos'), max: 2 });
  appPool = new Pool({ connectionString: urlFor('bos_app', APP_PW, 'bos'), max: 8 });
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
  U.founder = await staff('founder');
  U.portal = (
    await createPortalUser(appPool, { tenantId: tenant.tenantId, idpOrgId: tenant.idpOrgId })
  ).userId;
  resetRoles();
  deptA = (await createDepartment(appPool, scopeA)).departmentId;

  const { rows } = await exec(
    scopeA,
    sql`INSERT INTO app.tax_codes (tenant_id, code, name, kind, rate_bp, creditable, effective_from)
        VALUES (${scopeA.tenantId}, 'VAT13', 'VAT 13%', 'vat', 1300, true, '2020-01-01') RETURNING id`,
  );
  vatCode = (rows[0] as { id: string }).id;

  audit = new AuditService(db);
  as(U.founder, 'founder');
  const admin = new ApprovalsAdminService(db, audit, caller, () => now);
  await admin.createWorkflow({
    key: PR_COMMITMENT_DOCUMENT_TYPE,
    name: 'Purchase commitment',
    spec: PR_COMMITMENT_WORKFLOW_SPEC,
  });
  await admin.publish(PR_COMMITMENT_DOCUMENT_TYPE, 1);

  numbering = new NumberingService();
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
});

afterAll(async () => {
  await appPool?.end();
  await ownerPool?.end();
  await container?.stop();
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
const messageOf = (e: HttpException) => (e.getResponse() as { message?: string }).message ?? '';

/** The outcome of two calls started together: how many succeeded and the HTTP status of each failure. */
async function settle<T>(calls: Promise<T>[]) {
  const results = await Promise.allSettled(calls);
  const failures = results.flatMap((r) =>
    r.status === 'rejected'
      ? [r.reason instanceof HttpException ? r.reason.getStatus() : String(r.reason)]
      : [],
  );
  return { ok: results.filter((r) => r.status === 'fulfilled').length, failures };
}

let panSeq = 0;
/** An approved vendor with an account in scope A. */
async function vendor(): Promise<string> {
  const { partyId } = await createParty(appPool, {
    tenantId: scopeA.tenantId,
    kind: 'vendor',
    organizationId: scopeA.organizationId,
  });
  await exec(
    scopeA,
    sql`INSERT INTO app.vendors (id, tenant_id, legal_name, pan, status, created_by, approved_by)
        VALUES (${partyId}, ${scopeA.tenantId}, ${`Vendor ${partyId.slice(0, 6)}`},
                ${String(200_000_000 + (panSeq += 1))}, 'approved', ${U.proc}, ${U.mgmt})`,
  );
  await exec(
    scopeA,
    sql`INSERT INTO app.vendor_accounts (tenant_id, organization_id, vendor_id)
        VALUES (${scopeA.tenantId}, ${scopeA.organizationId}, ${partyId})`,
  );
  return partyId;
}

/** A dept_approved request of U.req in scope A with one line; returns its id and line id. */
async function deptApprovedPr(): Promise<{ id: string; lineId: string }> {
  const id = randomUUID();
  const lineId = randomUUID();
  await exec(
    scopeA,
    sql`INSERT INTO app.purchase_requests (id, tenant_id, organization_id, request_type, department_id,
          requester_user_id, cost_center_id, justification, required_by, budget_code, currency, is_emergency)
        VALUES (${id}, ${scopeA.tenantId}, ${scopeA.organizationId}, 'goods', ${deptA}, ${U.req},
                ${(await createCostCenter(appPool, scopeA)).costCenterId}, 'Laptops', '2026-12-01', 'IT-2083', 'NPR', false)`,
  );
  await exec(
    scopeA,
    sql`INSERT INTO app.purchase_request_lines (id, tenant_id, organization_id, purchase_request_id, line_no,
          description, uom, quantity, estimated_unit_price, estimated_amount)
        VALUES (${lineId}, ${scopeA.tenantId}, ${scopeA.organizationId}, ${id}, 1, 'Laptop', 'pcs', 1, 100000, 100000)`,
  );
  await exec(
    scopeA,
    sql`UPDATE app.purchase_requests SET status = 'dept_approved', fx_rate = 1, estimated_total = 100000,
          estimated_total_npr = 100000, number = ${`PR-M-${id.slice(0, 8)}`} WHERE id = ${id}`,
  );
  return { id, lineId };
}

async function doc(): Promise<string> {
  const { rows } = await exec(
    scopeA,
    sql`INSERT INTO app.documents (tenant_id, organization_id, owner_type, owner_id)
        VALUES (${scopeA.tenantId}, ${scopeA.organizationId}, 'rfq', ${randomUUID()}) RETURNING id`,
  );
  return (rows[0] as { id: string }).id;
}

// Far ahead: an inbox submission is received at the database's own time, which must stay before the deadline
// (F1-Q47 refuses a later one).
const deadline = '2030-11-20T10:00:00+05:45';

/** An open RFQ inviting `count` approved vendors; nobody has quoted yet. */
async function openRfq(count: number) {
  const pr = await deptApprovedPr();
  const vendorIds: string[] = [];
  for (let i = 0; i < count; i += 1) vendorIds.push(await vendor());
  const rfq = await service.createRfq(
    { purchaseRequestId: pr.id, deadline, vendorIds },
    randomUUID(),
  );
  return { rfq, pr, vendorIds };
}

/** An RFQ with one vendor per entry of `nets` that each quote (net + 13% VAT, in that order). */
async function rfqWithQuotes(nets: string[]) {
  const { rfq, pr, vendorIds } = await openRfq(nets.length);
  const quoteIds: string[] = [];
  for (const [i, net] of nets.entries()) {
    const q = await service.recordQuotation(
      rfq.id,
      {
        vendorId: vendorIds[i]!,
        documentId: await doc(),
        currency: 'NPR',
        lines: [{ prLineId: pr.lineId, quantity: '1', unitPrice: net, taxCodeId: vatCode }],
      },
      randomUUID(),
    );
    quoteIds.push(q.id);
  }
  return { rfqId: rfq.id, prId: pr.id, quoteIds };
}

const recommend = (rfqId: string, quoteId: string) =>
  service.recommend(rfqId, { vendorQuotationId: quoteId, rationale: 'Best value' }, randomUUID());

/** Three quotes (base band), the first recommended and the commitment submitted by U.proc. */
async function submitted() {
  const r = await rfqWithQuotes(['1000.00', '1100.00', '1200.00']);
  await recommend(r.rfqId, r.quoteIds[0]!);
  const dto = await service.submitCommitment(r.rfqId, randomUUID());
  const [request] = await requestsOf(r.rfqId);
  return { ...r, dto, requestId: request!.id };
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
const rfqRow = async (id: string) =>
  (await read((tx) => tx.select().from(rfqs).where(eq(rfqs.id, id))))[0]!;
const prRow = async (id: string) =>
  (await read((tx) => tx.select().from(purchaseRequests).where(eq(purchaseRequests.id, id))))[0]!;
const quotesOf = (rfqId: string) =>
  read((tx) => tx.select().from(vendorQuotations).where(eq(vendorQuotations.rfqId, rfqId)));
const posOf = (prId: string) =>
  read((tx) => tx.select().from(purchaseOrders).where(eq(purchaseOrders.purchaseRequestId, prId)));
const rfqActions = async (rfqId: string) =>
  (await audit.list(scopeA, { entityType: 'rfqs', entityId: rfqId, limit: 1000 })).map(
    (e) => e.action,
  );

async function decide(
  user: string,
  role: RoleKey,
  requestId: string,
  action: 'approve' | 'return' | 'reject',
  comment?: string,
) {
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
      { action, expectedVersion: req!.version, ...(comment === undefined ? {} : { comment }) },
      randomUUID(),
    );
  } finally {
    as(U.proc, 'procurement');
  }
}

/** A vendor-uploaded inbox row; `versions` are the scan statuses of its document versions, oldest first. */
async function submission(o: {
  vendorId: string;
  rfqId: string | null;
  versions?: ('clean' | 'quarantined' | 'infected')[];
}): Promise<{ id: string; documentId: string }> {
  const documentId = await doc();
  for (const [i, status] of (o.versions ?? ['clean']).entries()) {
    await exec(
      scopeA,
      sql`INSERT INTO app.document_versions (tenant_id, organization_id, document_id, version, filename,
            declared_mime, size_bytes, storage_key, status)
          VALUES (${scopeA.tenantId}, ${scopeA.organizationId}, ${documentId}, ${i + 1}, 'quote.pdf',
                  'application/pdf', 1024, ${`${scopeA.tenantId}/${randomUUID()}`}, ${status})`,
    );
  }
  const { rows } = await exec(
    scopeA,
    sql`INSERT INTO app.vendor_quotation_submissions (tenant_id, organization_id, vendor_id, rfq_id,
          submitted_by, document_id)
        VALUES (${scopeA.tenantId}, ${scopeA.organizationId}, ${o.vendorId}, ${o.rfqId}, ${U.portal},
                ${documentId})
        RETURNING id`,
  );
  return { id: (rows[0] as { id: string }).id, documentId };
}
const submissionRow = async (id: string) =>
  (
    await read((tx) =>
      tx.select().from(vendorQuotationSubmissions).where(eq(vendorQuotationSubmissions.id, id)),
    )
  )[0]!;
const convertBody = (submissionId: string, lineId: string) => ({
  submissionId,
  currency: 'NPR' as const,
  lines: [{ prLineId: lineId, quantity: '1', unitPrice: '1000.00', taxCodeId: vatCode }],
});

// ---------------------------------------------------------------------------------------- concurrency

describe('concurrency', () => {
  it('two parallel createRfq on one request: one 201, one 409, one RFQ row', async () => {
    const pr = await deptApprovedPr();
    const [v1, v2] = [await vendor(), await vendor()];
    const { ok, failures } = await settle([
      service.createRfq({ purchaseRequestId: pr.id, deadline, vendorIds: [v1] }, randomUUID()),
      service.createRfq({ purchaseRequestId: pr.id, deadline, vendorIds: [v2] }, randomUUID()),
    ]);
    expect(ok).toBe(1);
    expect(failures).toEqual([409]);
    const rows = await read((tx) =>
      tx.select().from(rfqs).where(eq(rfqs.purchaseRequestId, pr.id)),
    );
    expect(rows).toHaveLength(1);
    expect((await prRow(pr.id)).status).toBe('sourcing');
  });

  it('two parallel submitCommitment: exactly one approval request, one 409', async () => {
    const r = await rfqWithQuotes(['1000.00', '1100.00', '1200.00']);
    await recommend(r.rfqId, r.quoteIds[0]!);
    const { ok, failures } = await settle([
      service.submitCommitment(r.rfqId, randomUUID()),
      service.submitCommitment(r.rfqId, randomUUID()),
    ]);
    expect(ok).toBe(1);
    expect(failures).toEqual([409]);
    expect(await requestsOf(r.rfqId)).toHaveLength(1);
    expect((await prRow(r.prId)).status).toBe('commitment_pending');
  });

  it('two parallel conversions of one submission: one quotation, one 409', async () => {
    const { rfq, pr, vendorIds } = await openRfq(1);
    const sub = await submission({ vendorId: vendorIds[0]!, rfqId: rfq.id });
    const { ok, failures } = await settle([
      service.convertSubmission(rfq.id, convertBody(sub.id, pr.lineId), randomUUID()),
      service.convertSubmission(rfq.id, convertBody(sub.id, pr.lineId), randomUUID()),
    ]);
    expect(ok).toBe(1);
    expect(failures).toEqual([409]);
    expect(await quotesOf(rfq.id)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------- inbox conversion

describe('inbox conversion', () => {
  it('turns a clean submission into the same vendor and document quotation and marks it converted', async () => {
    const { rfq, pr, vendorIds } = await openRfq(1);
    const sub = await submission({ vendorId: vendorIds[0]!, rfqId: rfq.id });
    const quote = await service.convertSubmission(
      rfq.id,
      convertBody(sub.id, pr.lineId),
      randomUUID(),
    );
    expect(quote).toMatchObject({
      rfqId: rfq.id,
      vendorId: vendorIds[0],
      documentId: sub.documentId,
      currency: 'NPR',
      total: '1130.00',
      totalNpr: '1130.00',
    });
    expect(await submissionRow(sub.id)).toMatchObject({
      status: 'converted',
      convertedQuotationId: quote.id,
      reviewedBy: U.proc,
      version: 2,
    });
  });

  it('converts a submission that names no RFQ when its vendor is invited', async () => {
    const { rfq, pr, vendorIds } = await openRfq(1);
    const sub = await submission({ vendorId: vendorIds[0]!, rfqId: null });
    const quote = await service.convertSubmission(
      rfq.id,
      convertBody(sub.id, pr.lineId),
      randomUUID(),
    );
    expect(quote.rfqId).toBe(rfq.id);
    expect((await submissionRow(sub.id)).status).toBe('converted');
  });

  it.each([
    ['quarantined', ['quarantined']],
    ['infected', ['infected']],
    ['a newer version that is not clean', ['clean', 'quarantined']],
  ] as const)(
    'refuses a submission whose file is %s with 409 and writes nothing',
    async (_n, versions) => {
      const { rfq, pr, vendorIds } = await openRfq(1);
      const sub = await submission({
        vendorId: vendorIds[0]!,
        rfqId: rfq.id,
        versions: [...versions],
      });
      const e = await httpErrorOf(
        service.convertSubmission(rfq.id, convertBody(sub.id, pr.lineId), randomUUID()),
      );
      expect(e.getStatus()).toBe(409);
      expect(messageOf(e)).toMatch(/scanned clean/);
      expect((await submissionRow(sub.id)).status).toBe('received');
      expect(await quotesOf(rfq.id)).toHaveLength(0);
    },
  );

  it('refuses a submission that names another RFQ with 409', async () => {
    const a = await openRfq(1);
    const b = await openRfq(1);
    const sub = await submission({ vendorId: a.vendorIds[0]!, rfqId: a.rfq.id });
    const e = await httpErrorOf(
      service.convertSubmission(b.rfq.id, convertBody(sub.id, b.pr.lineId), randomUUID()),
    );
    expect(e.getStatus()).toBe(409);
    expect(messageOf(e)).toMatch(/another RFQ/);
    expect((await submissionRow(sub.id)).status).toBe('received');
  });

  it('refuses a vendor that was not invited to the RFQ with 409', async () => {
    const a = await openRfq(1);
    const b = await openRfq(1);
    const sub = await submission({ vendorId: a.vendorIds[0]!, rfqId: null });
    const e = await httpErrorOf(
      service.convertSubmission(b.rfq.id, convertBody(sub.id, b.pr.lineId), randomUUID()),
    );
    expect(e.getStatus()).toBe(409);
    expect(messageOf(e)).toMatch(/not invited/);
  });

  it('is a 404 for an unknown RFQ, an unknown submission and another entity', async () => {
    const { rfq, pr, vendorIds } = await openRfq(1);
    const sub = await submission({ vendorId: vendorIds[0]!, rfqId: null });
    const unknownRfq = await httpErrorOf(
      service.convertSubmission(randomUUID(), convertBody(sub.id, pr.lineId), randomUUID()),
    );
    expect(unknownRfq.getStatus()).toBe(404);
    const unknownSub = await httpErrorOf(
      service.convertSubmission(rfq.id, convertBody(randomUUID(), pr.lineId), randomUUID()),
    );
    expect(unknownSub.getStatus()).toBe(404);
    current.scope = scopeB;
    const otherEntity = await httpErrorOf(
      service.convertSubmission(rfq.id, convertBody(sub.id, pr.lineId), randomUUID()),
    );
    expect(otherEntity.getStatus()).toBe(404);
    expect((await submissionRow(sub.id)).status).toBe('received');
  });

  it('refuses an already converted submission with 409', async () => {
    const { rfq, pr, vendorIds } = await openRfq(1);
    const sub = await submission({ vendorId: vendorIds[0]!, rfqId: rfq.id });
    await service.convertSubmission(rfq.id, convertBody(sub.id, pr.lineId), randomUUID());
    const e = await httpErrorOf(
      service.convertSubmission(rfq.id, convertBody(sub.id, pr.lineId), randomUUID()),
    );
    expect(e.getStatus()).toBe(409);
    expect(messageOf(e)).toMatch(/is converted/);
    expect(await quotesOf(rfq.id)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------- quotation deadline

describe('the quotation deadline (F1-Q47)', () => {
  const recordOne = (rfqId: string, vendorId: string, lineId: string) =>
    doc().then((documentId) =>
      service.recordQuotation(
        rfqId,
        {
          vendorId,
          documentId,
          currency: 'NPR',
          lines: [{ prLineId: lineId, quantity: '1', unitPrice: '1000.00', taxCodeId: vatCode }],
        },
        randomUUID(),
      ),
    );
  const passDeadline = (rfqId: string) =>
    exec(scopeA, sql`UPDATE app.rfqs SET deadline = '2026-11-08T00:00:00Z' WHERE id = ${rfqId}`);

  it('refuses a quotation typed in after the deadline with 409 rfq_deadline_passed', async () => {
    const { rfq, pr, vendorIds } = await openRfq(1);
    await passDeadline(rfq.id);
    const e = await httpErrorOf(recordOne(rfq.id, vendorIds[0]!, pr.lineId));
    expect(e.getStatus()).toBe(409);
    expect((e.getResponse() as { code?: string }).code).toBe('rfq_deadline_passed');
    expect(await quotesOf(rfq.id)).toHaveLength(0);
  });

  it('refuses to convert an upload received after the deadline and leaves it received', async () => {
    const { rfq, pr, vendorIds } = await openRfq(1);
    const sub = await submission({ vendorId: vendorIds[0]!, rfqId: rfq.id });
    await exec(
      scopeA,
      sql`UPDATE app.vendor_quotation_submissions
             SET received_at = (SELECT deadline + interval '1 second' FROM app.rfqs WHERE id = ${rfq.id})
           WHERE id = ${sub.id}`,
    );
    const e = await httpErrorOf(
      service.convertSubmission(rfq.id, convertBody(sub.id, pr.lineId), randomUUID()),
    );
    expect(e.getStatus()).toBe(409);
    expect((e.getResponse() as { code?: string }).code).toBe('rfq_deadline_passed');
    expect((await submissionRow(sub.id)).status).toBe('received');
    expect(await quotesOf(rfq.id)).toHaveLength(0);
  });

  it('extends a passed deadline, audited, and then takes quotations again', async () => {
    const { rfq, pr, vendorIds } = await openRfq(1);
    await passDeadline(rfq.id);
    const before = await rfqRow(rfq.id);
    const dto = await service.extendDeadline(
      rfq.id,
      { deadline: '2026-11-12T10:00:00+05:45' },
      randomUUID(),
    );
    expect(dto.deadline).toBe('2026-11-12T04:15:00.000Z');
    expect(dto.version).toBe(before.version + 1);
    expect((await rfqRow(rfq.id)).deadline.toISOString()).toBe('2026-11-12T04:15:00.000Z');
    expect(await rfqActions(rfq.id)).toContain('procurement.rfq.deadline_extended');
    await recordOne(rfq.id, vendorIds[0]!, pr.lineId);
    expect(await quotesOf(rfq.id)).toHaveLength(1);
  });

  it('refuses an extension to the past, to before the current deadline, or of a closed RFQ', async () => {
    const { rfq } = await openRfq(1);
    const past = await httpErrorOf(
      service.extendDeadline(rfq.id, { deadline: '2026-11-01T10:00:00+05:45' }, randomUUID()),
    );
    expect(past.getStatus()).toBe(400);
    expect((past.getResponse() as { reason?: string }).reason).toBe('deadline_in_past');
    const earlier = await httpErrorOf(
      service.extendDeadline(rfq.id, { deadline: '2030-11-19T10:00:00+05:45' }, randomUUID()),
    );
    expect(earlier.getStatus()).toBe(400);
    await exec(scopeA, sql`UPDATE app.rfqs SET status = 'closed' WHERE id = ${rfq.id}`);
    const closed = await httpErrorOf(
      service.extendDeadline(rfq.id, { deadline: '2031-01-01T10:00:00+05:45' }, randomUUID()),
    );
    expect(closed.getStatus()).toBe(409);
    expect((await rfqRow(rfq.id)).deadline.toISOString()).toBe(
      new Date(deadline).toISOString(),
    );
    expect(await rfqActions(rfq.id)).not.toContain('procurement.rfq.deadline_extended');
  });

  it('is a 404 for another entity\'s RFQ', async () => {
    const { rfq } = await openRfq(1);
    current.scope = scopeB;
    const e = await httpErrorOf(
      service.extendDeadline(rfq.id, { deadline: '2031-01-01T10:00:00+05:45' }, randomUUID()),
    );
    expect(e.getStatus()).toBe(404);
  });
});

// ---------------------------------------------------------------------------------------- scores and comparison

describe('scores and comparison', () => {
  it('sorts the comparison by NPR total as a number, cheapest first, with no scores yet', async () => {
    // Totals incl. 13% VAT: 11300.00, 1017.00, 2260.00. Sorted as text, 11300.00 would come before 2260.00.
    const r = await rfqWithQuotes(['10000.00', '900.00', '2000.00']);
    const rows = await service.comparison(r.rfqId);
    expect(rows.map((x) => x.id)).toEqual([r.quoteIds[1], r.quoteIds[2], r.quoteIds[0]]);
    expect(rows.map((x) => x.totalNpr)).toEqual(['1017.00', '2260.00', '11300.00']);
    expect(rows.every((x) => x.averageScore === null && x.scores.length === 0)).toBe(true);
  });

  it('replaces the score of a criterion instead of adding a row, and averages the scores', async () => {
    const r = await rfqWithQuotes(['1000.00', '1100.00', '1200.00']);
    const target = r.quoteIds[2]!;
    const first = await service.scoreQuotation(
      r.rfqId,
      target,
      {
        scores: [
          { criterion: 'quality', score: 80 },
          { criterion: 'price', score: 85 },
        ],
      },
      randomUUID(),
    );
    const scored = first.find((x) => x.id === target)!;
    expect(scored.scores.map((s) => [s.criterion, s.score])).toEqual([
      ['price', '85.00'],
      ['quality', '80.00'],
    ]);
    expect(scored.averageScore).toBe('82.50');

    as(U.proc2, 'procurement');
    const second = await service.scoreQuotation(
      r.rfqId,
      target,
      { scores: [{ criterion: 'quality', score: 60, comment: 'Late delivery' }] },
      randomUUID(),
    );
    const rescored = second.find((x) => x.id === target)!;
    expect(rescored.scores).toEqual([
      { criterion: 'price', score: '85.00', comment: null },
      { criterion: 'quality', score: '60.00', comment: 'Late delivery' },
    ]);
    expect(rescored.averageScore).toBe('72.50');
    expect(second.filter((x) => x.id !== target).every((x) => x.averageScore === null)).toBe(true);
    const rows = await read((tx) =>
      tx
        .select()
        .from(vendorComparisonScores)
        .where(eq(vendorComparisonScores.vendorQuotationId, target)),
    );
    expect(rows).toHaveLength(2);
    expect(rows.find((x) => x.criterion === 'quality')!.scoredBy).toBe(U.proc2);
    expect(rows.find((x) => x.criterion === 'price')!.scoredBy).toBe(U.proc);
  });

  it('is a 404 for a quotation of another RFQ and for an unknown RFQ', async () => {
    const a = await rfqWithQuotes(['1000.00']);
    const b = await rfqWithQuotes(['1000.00']);
    const body = { scores: [{ criterion: 'price', score: 50 }] };
    const wrongRfq = await httpErrorOf(
      service.scoreQuotation(b.rfqId, a.quoteIds[0]!, body, randomUUID()),
    );
    expect(wrongRfq.getStatus()).toBe(404);
    const unknown = await httpErrorOf(
      service.scoreQuotation(randomUUID(), a.quoteIds[0]!, body, randomUUID()),
    );
    expect(unknown.getStatus()).toBe(404);
  });
});

// ---------------------------------------------------------------------------------------- recommend transition

describe('recommend and the RFQ transitions', () => {
  it('the contract does not let an open RFQ go straight to recommended', () => {
    expect(canTransitionRfq('open', 'recommended')).toBe(false);
    expect(canTransitionRfq('open', 'closed')).toBe(true);
    expect(canTransitionRfq('closed', 'recommended')).toBe(true);
  });

  it('closes an open RFQ first (open → closed → recommended) in the same transaction', async () => {
    const r = await rfqWithQuotes(['1000.00', '1100.00', '1200.00']);
    expect((await rfqRow(r.rfqId)).version).toBe(1);
    const dto = await recommend(r.rfqId, r.quoteIds[0]!);
    expect(dto.status).toBe('recommended');
    // One version bump for the close and one for the recommendation.
    expect(dto.version).toBe(3);
    const actions = await rfqActions(r.rfqId);
    expect(actions).toContain('procurement.rfq.closed');
    expect(actions).toContain('procurement.rfq.recommended');
  });

  it('recommends a closed RFQ with a single step, and refuses a recommended or cancelled one', async () => {
    const r = await rfqWithQuotes(['1000.00', '1100.00', '1200.00']);
    await exec(
      scopeA,
      sql`UPDATE app.rfqs SET status = 'closed', version = version + 1 WHERE id = ${r.rfqId}`,
    );
    const dto = await recommend(r.rfqId, r.quoteIds[0]!);
    expect(dto).toMatchObject({ status: 'recommended', version: 3 });
    expect(await rfqActions(r.rfqId)).not.toContain('procurement.rfq.closed');
    const again = await httpErrorOf(recommend(r.rfqId, r.quoteIds[1]!));
    expect(again.getStatus()).toBe(409);

    const c = await rfqWithQuotes(['1000.00', '1100.00', '1200.00']);
    await exec(scopeA, sql`UPDATE app.rfqs SET status = 'cancelled' WHERE id = ${c.rfqId}`);
    const cancelled = await httpErrorOf(recommend(c.rfqId, c.quoteIds[0]!));
    expect(cancelled.getStatus()).toBe(409);
    expect(messageOf(cancelled)).toMatch(/cancelled RFQ cannot take a recommendation/);
  });

  it('refuses a quotation of another RFQ with 400 and leaves the RFQ open', async () => {
    const a = await rfqWithQuotes(['1000.00', '1100.00', '1200.00']);
    const b = await rfqWithQuotes(['1000.00', '1100.00', '1200.00']);
    const e = await httpErrorOf(recommend(a.rfqId, b.quoteIds[0]!));
    expect(e.getStatus()).toBe(400);
    expect(await rfqRow(a.rfqId)).toMatchObject({ status: 'open', version: 1 });
  });
});

// ---------------------------------------------------------------------------------------- commitment outcomes

describe('a decided commitment (PrCommitmentSubject.onDecided)', () => {
  it('returned: the RFQ reopens and the request goes back to sourcing, and it can be resubmitted', async () => {
    const s = await submitted();
    expect((await prRow(s.prId)).status).toBe('commitment_pending');
    await decide(U.acct, 'accountant', s.requestId, 'return', 'Quote is out of date');

    expect(await rfqRow(s.rfqId)).toMatchObject({ status: 'open', recommendedQuotationId: null });
    expect((await prRow(s.prId)).status).toBe('sourcing');
    expect(await posOf(s.prId)).toHaveLength(0);

    // Re-source: recommend another quote (the open RFQ is closed first), submit again, approve to a draft PO.
    const second = await recommend(s.rfqId, s.quoteIds[1]!);
    expect(second.status).toBe('recommended');
    const dto = await service.submitCommitment(s.rfqId, randomUUID());
    const requests = await requestsOf(s.rfqId);
    expect(requests.map((x) => x.status).sort()).toEqual(['pending', 'returned']);
    const fresh = requests.find((x) => x.status === 'pending')!;
    expect(dto.commitmentApprovalRequestId).toBe(fresh.id);
    expect((await prRow(s.prId)).status).toBe('commitment_pending');

    await decide(U.acct, 'accountant', fresh.id, 'approve');
    await decide(U.fin, 'finance', fresh.id, 'approve');
    const pos = await posOf(s.prId);
    expect(pos).toHaveLength(1);
    expect(pos[0]).toMatchObject({
      status: 'draft',
      vendorQuotationId: s.quoteIds[1],
      approvedTotal: '1243.00',
      approvedBand: 'base',
    });
    expect((await prRow(s.prId)).status).toBe('approved');
  });

  it('rejected: the request is rejected, the RFQ cancelled and no PO is written', async () => {
    const s = await submitted();
    await decide(U.acct, 'accountant', s.requestId, 'reject', 'Over budget');
    expect((await prRow(s.prId)).status).toBe('rejected');
    expect(await rfqRow(s.rfqId)).toMatchObject({
      status: 'cancelled',
      recommendedQuotationId: s.quoteIds[0],
    });
    expect(await posOf(s.prId)).toHaveLength(0);
    expect((await requestsOf(s.rfqId))[0]!.status).toBe('rejected');
  });

  it('refuses a decision for an RFQ that is not waiting for one (409) and writes no PO', async () => {
    const { rfq, pr } = await openRfq(1);
    const subject = new PrCommitmentSubject(numbering, () => now);
    const e = await httpErrorOf(
      withTx(db, scopeA, systemActor('test'), (tx) => subject.onDecided(tx, rfq.id, 'approved')),
    );
    expect(e.getStatus()).toBe(409);
    expect(await posOf(pr.id)).toHaveLength(0);
    expect((await prRow(pr.id)).status).toBe('sourcing');
  });
});
