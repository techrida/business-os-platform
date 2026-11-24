// Integration tests of the two sourcing reads the workspace screens use (P4 unit P2d): the RFQ list and the
// inbox of a RFQ's received submissions, on a real Postgres (Testcontainers, needs Docker in WSL). Same setup as
// sourcing.more.integration.test.ts (real migrations as bos_owner, queries as bos_app, real SourcingService).
// Run: pnpm --filter @bos/api exec vitest run src/modules/procurement/sourcing/sourcing.reads.integration.test.ts

import { randomUUID } from 'node:crypto';

import {
  DEFAULT_ROLE_PERMISSIONS,
  type Permission,
  type RoleKey,
  type Scope,
} from '@bos/contracts';
import {
  createCostCenter,
  createDepartment,
  createParty,
  createPortalUser,
  createStaffUser,
  createTenantWithEntity,
} from '@bos/db';
import { HttpException } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { AuditService } from '../../../platform/audit/audit.service';
import type { Principal } from '../../../platform/authz/principal';
import type { Db } from '../../../platform/db/db.module';
import { systemActor, withTx, type TxScope } from '../../../platform/db/tx';
import { MoneyService } from '../../../platform/settings/money.service';
import { NumberingService } from '../../../platform/settings/numbering.service';
import { ApprovalsAdminService } from '../../approvals/admin.service';
import { asSecondPerson, SKIP_LIVE_PUBLISHER_CHECK } from '../../../../test/support/second-person';
import { ApprovalsService } from '../../approvals/requests.service';
import { PrCommitmentSubject } from './pr-commitment.subject';
import { PR_COMMITMENT_DOCUMENT_TYPE, PR_COMMITMENT_WORKFLOW_SPEC } from './sourcing.rules';
import { SourcingService, type QuotationLineDto } from './sourcing.service';
import { evidenceFixture, type EvidenceFixture } from '../../evidence/evidence.fixture';
import { createTestDatabase, type TestDatabase } from '@bos/db/testing';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 180_000 });

const now = new Date('2026-11-09T04:00:00Z');

let testDb: TestDatabase;
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
/** Quotation files uploaded through the RFQ's evidence route (round 5 P2). */
let evidence: EvidenceFixture;

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

const exec = (scope: TxScope, q: ReturnType<typeof sql>) =>
  withTx(db, scope, systemActor('test'), (tx) => tx.execute(q));

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
  const adminPublisher = new ApprovalsAdminService(db, audit, asSecondPerson(caller), () => now);
  await admin.createWorkflow({
    key: PR_COMMITMENT_DOCUMENT_TYPE,
    name: 'Purchase commitment',
    spec: PR_COMMITMENT_WORKFLOW_SPEC,
  });
  await adminPublisher.publish(PR_COMMITMENT_DOCUMENT_TYPE, 1, SKIP_LIVE_PUBLISHER_CHECK);

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
async function deptApprovedPr(
  secondLine = false,
): Promise<{ id: string; lineId: string; secondLineId: string }> {
  const secondLineId = randomUUID();
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
  if (secondLine) {
    await exec(
      scopeA,
      sql`INSERT INTO app.purchase_request_lines (id, tenant_id, organization_id, purchase_request_id, line_no,
            description, uom, quantity, estimated_unit_price, estimated_amount)
          VALUES (${secondLineId}, ${scopeA.tenantId}, ${scopeA.organizationId}, ${id}, 2, 'Docking station',
                  'pcs', 1, 100, 100)`,
    );
  }
  await exec(
    scopeA,
    sql`UPDATE app.purchase_requests SET status = 'dept_approved', fx_rate = 1, estimated_total = 100000,
          estimated_total_npr = 100000, number = ${`PR-M-${id.slice(0, 8)}`} WHERE id = ${id}`,
  );
  return { id, lineId, secondLineId };
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
async function openRfq(count: number, secondLine = false) {
  const pr = await deptApprovedPr(secondLine);
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
        documentId: await evidence.upload('rfq', rfq.id),
        currency: 'NPR',
        lines: [{ prLineId: pr.lineId, quantity: '1', unitPrice: net, taxCodeId: vatCode }],
      },
      randomUUID(),
    );
    quoteIds.push(q.id);
  }
  return { rfqId: rfq.id, prId: pr.id, quoteIds };
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

const convertBody = (submissionId: string, lineId: string) => ({
  submissionId,
  currency: 'NPR' as const,
  lines: [{ prLineId: lineId, quantity: '1', unitPrice: '1000.00', taxCodeId: vatCode }],
});
const keysOf = (o: object) => Object.keys(o).sort();

// ---------------------------------------------------------------------------------------- the RFQ list

describe('listRfqs', () => {
  it('lists the entity RFQs newest first with request number, status, deadline and both counts', async () => {
    const first = await rfqWithQuotes(['1000.00', '1100.00']);
    const second = await openRfq(3);
    const { rows } = await service.listRfqs({ limit: 200, offset: 0 });
    const ids = rows.map((r) => r.id);
    expect(ids.indexOf(second.rfq.id)).toBeLessThan(ids.indexOf(first.rfqId));

    const a = rows.find((r) => r.id === first.rfqId)!;
    const b = rows.find((r) => r.id === second.rfq.id)!;
    expect(keysOf(a)).toEqual(
      [
        'deadline',
        'id',
        'invitedVendorCount',
        'number',
        'purchaseRequestId',
        'purchaseRequestNumber',
        'quotationCount',
        'status',
      ].sort(),
    );
    expect(a).toMatchObject({
      purchaseRequestId: first.prId,
      purchaseRequestNumber: `PR-M-${first.prId.slice(0, 8)}`,
      status: 'open',
      invitedVendorCount: 2,
      quotationCount: 2,
    });
    expect(a.deadline).toBe(new Date(deadline).toISOString());
    expect(a.number).toMatch(/^RFQ/);
    expect(b).toMatchObject({ invitedVendorCount: 3, quotationCount: 0, status: 'open' });
  });

  it('filters by status and honours the limit', async () => {
    const { rfq } = await openRfq(1);
    await exec(scopeA, sql`UPDATE app.rfqs SET status = 'closed' WHERE id = ${rfq.id}`);
    const closed = (await service.listRfqs({ status: ['closed'], limit: 200, offset: 0 })).rows;
    expect(closed.map((r) => r.id)).toContain(rfq.id);
    expect(closed.every((r) => r.status === 'closed')).toBe(true);
    const cancelled = (await service.listRfqs({ status: ['cancelled'], limit: 200, offset: 0 }))
      .rows;
    expect(cancelled.map((r) => r.id)).not.toContain(rfq.id);
    const one = await service.listRfqs({ limit: 1, offset: 0 });
    expect(one.rows).toHaveLength(1);
    expect(one.total).toBeGreaterThan(1);
  });

  it('takes several statuses, searches by RFQ or request number and pages by offset', async () => {
    const closedRfq = (await openRfq(1)).rfq;
    const openOne = (await openRfq(1)).rfq;
    await exec(scopeA, sql`UPDATE app.rfqs SET status = 'closed' WHERE id = ${closedRfq.id}`);
    const both = await service.listRfqs({ status: ['open', 'closed'], limit: 200, offset: 0 });
    expect(both.rows.map((r) => r.id)).toEqual(expect.arrayContaining([closedRfq.id, openOne.id]));

    const byNumber = await service.listRfqs({ q: openOne.number, limit: 50, offset: 0 });
    expect(byNumber.rows.map((r) => r.id)).toContain(openOne.id);
    expect(byNumber.total).toBe(byNumber.rows.length);

    const all = await service.listRfqs({ limit: 200, offset: 0 });
    const second = await service.listRfqs({ limit: 1, offset: 1 });
    expect(second.total).toBe(all.total);
    expect(second.rows[0]?.id).toBe(all.rows[1]?.id);
  });

  it('another entity sees none of them', async () => {
    await openRfq(1);
    current.scope = scopeB;
    expect(await service.listRfqs({ limit: 200, offset: 0 })).toEqual({ rows: [], total: 0 });
    expect(await service.listRfqs({ q: 'RFQ', status: ['open'], limit: 200, offset: 0 })).toEqual({
      rows: [],
      total: 0,
    });
  });
});

// ---------------------------------------------------------------------------------------- the RFQ inbox

describe('listSubmissions', () => {
  it('lists the received uploads that name the RFQ, with vendor name and the latest scan status', async () => {
    const { rfq, pr, vendorIds } = await openRfq(2);
    const [v1, v2] = vendorIds as [string, string];
    const other = await openRfq(1);

    const clean = await submission({ vendorId: v1, rfqId: rfq.id, versions: ['clean'] });
    const rescanned = await submission({
      vendorId: v2,
      rfqId: rfq.id,
      versions: ['clean', 'infected'],
    });
    const noVersion = await submission({ vendorId: v1, rfqId: rfq.id, versions: [] });
    // Not listed: another RFQ's upload, one that names no RFQ, and one already converted.
    await submission({ vendorId: other.vendorIds[0]!, rfqId: other.rfq.id });
    await submission({ vendorId: v1, rfqId: null });
    const converted = await submission({ vendorId: v2, rfqId: rfq.id });
    await service.convertSubmission(rfq.id, convertBody(converted.id, pr.lineId), randomUUID());

    const rows = await service.listSubmissions(rfq.id);
    expect(rows.map((r) => r.id).sort()).toEqual([clean.id, rescanned.id, noVersion.id].sort());
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(keysOf(rows[0]!)).toEqual(
      [
        'documentId',
        'id',
        'scanStatus',
        'submittedAt',
        'vendorId',
        'vendorName',
        'vendorRef',
      ].sort(),
    );
    expect(byId.get(clean.id)).toMatchObject({
      vendorId: v1,
      vendorName: `Vendor ${v1.slice(0, 6)}`,
      documentId: clean.documentId,
      scanStatus: 'clean',
      vendorRef: null,
    });
    expect(byId.get(clean.id)!.submittedAt).toMatch(/^\d{4}-\d\d-\d\dT.*Z$/);
    // The latest version decides: a later infected scan hides the earlier clean one.
    expect(byId.get(rescanned.id)!.scanStatus).toBe('infected');
    expect(byId.get(noVersion.id)!.scanStatus).toBeNull();
  });

  it('is an empty list for an RFQ with no uploads', async () => {
    const { rfq } = await openRfq(1);
    expect(await service.listSubmissions(rfq.id)).toEqual([]);
  });

  it('another entity, and an unknown id, are a 404 and not an empty list', async () => {
    const { rfq, vendorIds } = await openRfq(1);
    await submission({ vendorId: vendorIds[0]!, rfqId: rfq.id });
    current.scope = scopeB;
    expect((await httpErrorOf(service.listSubmissions(rfq.id))).getStatus()).toBe(404);
    current.scope = null;
    expect((await httpErrorOf(service.listSubmissions(randomUUID()))).getStatus()).toBe(404);
  });
});

describe('the lines of a quotation (R6Q23)', () => {
  const record = (
    rfqId: string,
    vendorId: string,
    lines: { prLineId: string; quantity: string; unitPrice: string; description?: string }[],
  ) =>
    evidence.upload('rfq', rfqId).then((documentId) =>
      service.recordQuotation(
        rfqId,
        {
          vendorId,
          documentId,
          currency: 'NPR',
          lines: lines.map((l) => ({ ...l, taxCodeId: vatCode })),
        },
        randomUUID(),
      ),
    );

  it('returns each line with the vendor description, defaulting to the request line wording', async () => {
    as(U.proc, 'procurement');
    const { rfq, pr, vendorIds } = await openRfq(1, true);
    await record(rfq.id, vendorIds[0]!, [
      { prLineId: pr.secondLineId, quantity: '2', unitPrice: '33.33' },
      { prLineId: pr.lineId, quantity: '1', unitPrice: '1000.00', description: 'Laptop 14-inch' },
    ]);
    const [row] = await service.comparison(rfq.id);
    expect(
      row!.lines.map((l) => [l.lineNo, l.description, l.quantity, l.unitPrice, l.taxCode]),
    ).toEqual([
      [1, 'Laptop 14-inch', '1.0000', '1000.00', expect.any(String)],
      [2, 'Docking station', '2.0000', '33.33', expect.any(String)],
    ]);
  });

  it('adds the lines up to the quotation totals, rounding per line as invoices do', async () => {
    as(U.proc, 'procurement');
    const { rfq, pr, vendorIds } = await openRfq(1, true);
    // Half-paisa lines: VAT 0.065 -> 0.07 on each 0.50 line, where rounding the summed net (1.00) once would give
    // 0.13. Rounded per line, then summed, as invoices do.
    await record(rfq.id, vendorIds[0]!, [
      { prLineId: pr.lineId, quantity: '1', unitPrice: '0.50' },
      { prLineId: pr.secondLineId, quantity: '1', unitPrice: '0.50' },
    ]);
    const [row] = await service.comparison(rfq.id);
    const sum = (pick: (l: QuotationLineDto) => string) =>
      (row!.lines.reduce((acc, l) => acc + Math.round(Number(pick(l)) * 100), 0) / 100).toFixed(2);
    expect(sum((l) => l.gross)).toBe(row!.subtotal);
    expect(sum((l) => l.taxAmount)).toBe(row!.taxAmount);
    expect(sum((l) => l.lineTotal)).toBe(row!.total);
    expect(row!.lines.map((l) => l.taxAmount)).toEqual(['0.07', '0.07']);
    expect(row!.taxAmount).toBe('0.14');
  });

  it('keeps what the vendor quoted when it is recorded, with the other vendors lines apart', async () => {
    as(U.proc, 'procurement');
    const { rfq, pr, vendorIds } = await openRfq(2);
    await record(rfq.id, vendorIds[0]!, [
      {
        prLineId: pr.lineId,
        quantity: '1',
        unitPrice: '900.00',
        description: 'Refurbished laptop',
      },
    ]);
    await record(rfq.id, vendorIds[1]!, [
      { prLineId: pr.lineId, quantity: '1', unitPrice: '950.00' },
    ]);
    const rows = await service.comparison(rfq.id);
    expect(rows.map((r) => r.lines.map((l) => l.description))).toEqual([
      ['Refurbished laptop'],
      ['Laptop'],
    ]);
  });
});

describe('invited vendor names (no vendor directory read)', () => {
  it('names each invited vendor on the RFQ and each quoting vendor on the comparison, for sourcing', async () => {
    as(U.proc, 'procurement');
    const { rfqId, quoteIds } = await rfqWithQuotes(['1000.00', '2000.00']);
    const rfq = await service.getRfq(rfqId);
    const legal = (id: string) => `Vendor ${id.slice(0, 6)}`;
    expect(rfq.vendors).toHaveLength(2);
    expect([...rfq.vendors.map((v) => v.id)].sort()).toEqual([...rfq.vendorIds].sort());
    for (const v of rfq.vendors) expect(v.name).toBe(legal(v.id));
    const rows = await service.comparison(rfqId);
    expect(rows.map((r) => r.id).sort()).toEqual([...quoteIds].sort());
    for (const r of rows) expect(r.vendorName).toBe(legal(r.vendorId));
  });

  it('sends the names with the RFQ create response too', async () => {
    as(U.proc, 'procurement');
    const { rfq, vendorIds } = await openRfq(2);
    expect(rfq.vendors.map((v) => v.id).sort()).toEqual([...vendorIds].sort());
    expect(rfq.vendors.every((v) => v.name.startsWith('Vendor '))).toBe(true);
  });

  it('adds only id and name per invited vendor and only vendorName per quotation', async () => {
    as(U.proc, 'procurement');
    const { rfqId } = await rfqWithQuotes(['1000.00']);
    const rfq = await service.getRfq(rfqId);
    for (const v of rfq.vendors) expect(keysOf(v)).toEqual(['id', 'name']);
    const [row] = await service.comparison(rfqId);
    expect(keysOf(row!)).toEqual(
      [
        'averageScore',
        'currency',
        'deliveryDays',
        'documentId',
        'fxRate',
        'id',
        'lines',
        'rfqId',
        'scores',
        'subtotal',
        'taxAmount',
        'total',
        'totalNpr',
        'vendorId',
        'vendorName',
      ].sort(),
    );
  });

  it('another entity cannot read the RFQ, so it learns no vendor name', async () => {
    as(U.proc, 'procurement');
    const { rfq } = await openRfq(1);
    current.scope = scopeB;
    expect((await httpErrorOf(service.getRfq(rfq.id))).getStatus()).toBe(404);
    expect((await httpErrorOf(service.comparison(rfq.id))).getStatus()).toBe(404);
    current.scope = null;
  });
});
