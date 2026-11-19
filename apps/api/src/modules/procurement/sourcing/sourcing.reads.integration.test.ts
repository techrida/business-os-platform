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
  runMigrations,
} from '@bos/db';
import { HttpException } from '@nestjs/common';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
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

const deadline = '2026-11-20T10:00:00+05:45';

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
