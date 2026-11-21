// Integration test of issuing a real commitment draft (Testcontainers, needs Docker in WSL): P2's SourcingService
// and PrCommitmentSubject write the draft PO (header only, no lines), and PurchaseOrdersService.issue copies the
// lines from the recommended quotation. Same setup as purchase-orders.integration.test.ts, plus `pr_commitment`.
// Real: migrations as bos_owner, queries as bos_app (so the version trigger, the revoked privileges and every 0034
// CHECK run), PurchaseOrdersService, the real ApprovalsService with the `po_amendment` workflow published through
// ApprovalsAdminService (spec PO_AMENDMENT_WORKFLOW_SPEC, which the seed copies), the real PoAmendmentSubject,
// ReceiptsService (receipts and progress) and AuditService. Faked: notify, the role directory (role -> real staff
// users of entity A), the request context and authz.assert (the real pure can() on a fake principal).
// Draft POs are inserted directly, as P2's commitment route leaves them (number taken, status draft, version 0).
// Run: pnpm --filter @bos/api exec vitest run src/modules/procurement/orders/purchase-orders.from-commitment.integration.test.ts
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
  createDepartment,
  createParty,
  createStaffUser,
  createTenantWithEntity,
  purchaseOrders,
} from '@bos/db';
import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';

import { AuditService } from '../../../platform/audit/audit.service';
import type { Principal } from '../../../platform/authz/principal';
import type { Db, DbTransaction } from '../../../platform/db/db.module';
import { systemActor, withTx, type TxScope } from '../../../platform/db/tx';
import { MoneyService } from '../../../platform/settings/money.service';
import { NumberingService } from '../../../platform/settings/numbering.service';
import { ApprovalsAdminService } from '../../approvals/admin.service';
import { asSecondPerson, SKIP_LIVE_PUBLISHER_CHECK } from '../../../../test/support/second-person';
import { ApprovalsService } from '../../approvals/requests.service';
import { PrCommitmentSubject } from '../sourcing/pr-commitment.subject';
import {
  PR_COMMITMENT_DOCUMENT_TYPE,
  PR_COMMITMENT_WORKFLOW_SPEC,
} from '../sourcing/sourcing.rules';
import { SourcingService } from '../sourcing/sourcing.service';
import { PoAmendmentSubject } from './po-amendment.subject';
import { PO_AMENDMENT_DOCUMENT_TYPE, PO_AMENDMENT_WORKFLOW_SPEC } from './purchase-order.rules';
import { PurchaseOrdersService } from './purchase-orders.service';
import { createTestDatabase, type TestDatabase } from '@bos/db/testing';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 180_000 });

const now = new Date('2026-11-09T04:00:00Z');

let testDb: TestDatabase;
let ownerPool: Pool;
let appPool: Pool;
let db: Db;
let scopeA: TxScope;
let approvals: ApprovalsService;
let audit: AuditService;
let service: PurchaseOrdersService;
let sourcing: SourcingService;
let deptA = '';
let vatCode = '';

const U = { req: '', proc: '', acct: '', fin: '', mgmt: '', founder: '', wh: '' };
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

  const staff = async (roleKey: RoleKey) =>
    (await createStaffUser(appPool, { ...scopeA, idpOrgId: tenant.idpOrgId, roleKeys: [roleKey] }))
      .userId;
  U.req = await staff('operations_officer');
  U.proc = await staff('procurement');
  U.acct = await staff('accountant');
  U.fin = await staff('finance');
  U.mgmt = await staff('management');
  U.founder = await staff('founder');
  U.wh = await staff('warehouse');
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
    key: PO_AMENDMENT_DOCUMENT_TYPE,
    name: 'Purchase order amendment',
    spec: PO_AMENDMENT_WORKFLOW_SPEC,
  });
  await adminPublisher.publish(PO_AMENDMENT_DOCUMENT_TYPE, 1, SKIP_LIVE_PUBLISHER_CHECK);
  await admin.createWorkflow({
    key: PR_COMMITMENT_DOCUMENT_TYPE,
    name: 'Purchase commitment',
    spec: PR_COMMITMENT_WORKFLOW_SPEC,
  });
  await adminPublisher.publish(PR_COMMITMENT_DOCUMENT_TYPE, 1, SKIP_LIVE_PUBLISHER_CHECK);

  approvals = new ApprovalsService(db, audit, notify, directory, caller, () => now);
  approvals.registerSubject(new PoAmendmentSubject(audit, approvals, () => now));
  service = new PurchaseOrdersService(db, approvals, audit, caller, () => now);
  const numbering = new NumberingService();
  approvals.registerSubject(new PrCommitmentSubject(numbering, () => now));
  sourcing = new SourcingService(
    db,
    approvals,
    audit,
    numbering,
    new MoneyService(db, {} as never),
    { get: () => Promise.resolve(1) } as never,
    caller,
    () => now,
  );
});

afterAll(async () => {
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

// ---------------------------------------------------------------------------------------- test

async function approve(user: string, role: RoleKey, requestId: string) {
  const [req] = await read((tx) =>
    tx
      .select({ version: approvalRequests.version })
      .from(approvalRequests)
      .where(eq(approvalRequests.id, requestId)),
  );
  as(user, role);
  try {
    await approvals.act(
      requestId,
      { action: 'approve', expectedVersion: req!.version },
      randomUUID(),
    );
  } finally {
    as(U.proc, 'procurement');
  }
}

it('issues the lineless draft of an approved commitment with lines copied from the quotation', async () => {
  const { partyId: vendorId } = await createParty(appPool, {
    tenantId: scopeA.tenantId,
    kind: 'vendor',
    organizationId: scopeA.organizationId,
  });
  await exec(
    scopeA,
    sql`INSERT INTO app.vendors (id, tenant_id, legal_name, pan, status, created_by, approved_by)
        VALUES (${vendorId}, ${scopeA.tenantId}, 'Himal Laptops', '300000001', 'approved', ${U.proc}, ${U.mgmt})`,
  );
  await exec(
    scopeA,
    sql`INSERT INTO app.vendor_accounts (tenant_id, organization_id, vendor_id)
        VALUES (${scopeA.tenantId}, ${scopeA.organizationId}, ${vendorId})`,
  );
  const prId = randomUUID();
  const prLineId = randomUUID();
  await exec(
    scopeA,
    sql`INSERT INTO app.purchase_requests (id, tenant_id, organization_id, request_type, department_id,
          requester_user_id, cost_center_id, justification, required_by, budget_code, currency)
        VALUES (${prId}, ${scopeA.tenantId}, ${scopeA.organizationId}, 'goods', ${deptA}, ${U.req},
                ${(await createCostCenter(appPool, scopeA)).costCenterId}, 'Laptops', '2026-12-01', 'IT-2083', 'NPR')`,
  );
  await exec(
    scopeA,
    sql`INSERT INTO app.purchase_request_lines (id, tenant_id, organization_id, purchase_request_id, line_no,
          description, uom, quantity, estimated_unit_price, estimated_amount)
        VALUES (${prLineId}, ${scopeA.tenantId}, ${scopeA.organizationId}, ${prId}, 1, 'Laptop 14 inch', 'pcs',
                2, 40000, 80000)`,
  );
  await exec(
    scopeA,
    sql`UPDATE app.purchase_requests SET status = 'dept_approved', fx_rate = 1, estimated_total = 80000,
          estimated_total_npr = 80000, number = ${`PR-T-${prId.slice(0, 8)}`} WHERE id = ${prId}`,
  );
  const { rows } = await exec(
    scopeA,
    sql`INSERT INTO app.documents (tenant_id, organization_id, owner_type, owner_id)
        VALUES (${scopeA.tenantId}, ${scopeA.organizationId}, 'rfq', ${randomUUID()}) RETURNING id`,
  );
  const documentId = (rows[0] as { id: string }).id;

  const rfq = await sourcing.createRfq(
    { purchaseRequestId: prId, deadline: '2026-11-20T10:00:00+05:45', vendorIds: [vendorId] },
    randomUUID(),
  );
  const quote = await sourcing.recordQuotation(
    rfq.id,
    {
      vendorId,
      documentId,
      currency: 'NPR',
      lines: [{ prLineId, quantity: '2', unitPrice: '39000.00', taxCodeId: vatCode }],
    },
    randomUUID(),
  );
  await sourcing.recommend(
    rfq.id,
    { vendorQuotationId: quote.id, rationale: 'Only compliant quote' },
    randomUUID(),
  );
  const committed = await sourcing.submitCommitment(rfq.id, randomUUID());
  await approve(U.acct, 'accountant', committed.commitmentApprovalRequestId!);
  await approve(U.fin, 'finance', committed.commitmentApprovalRequestId!);

  const [draft] = await read((tx) =>
    tx.select().from(purchaseOrders).where(eq(purchaseOrders.vendorQuotationId, quote.id)),
  );
  expect(draft).toMatchObject({ status: 'draft', currentVersion: 0 });
  // I-32: the draft has no lines yet, but its detail shows the approved quotation's lines it will be issued with.
  const before = await service.get(draft!.id);
  expect(before.lines).toEqual([]);
  expect(before.proposedLines).toHaveLength(1);
  expect(before.proposedLines![0]).toMatchObject({ cancelledQuantity: '0.0000' });

  const dto = await service.issue(draft!.id, randomUUID());
  // What issue wrote is what the draft showed, apart from the new line id.
  const strip = ({ id: _id, ...l }: (typeof dto.lines)[number]) => l;
  expect(dto.lines.map(strip)).toEqual(before.proposedLines!.map(strip));
  const after = await service.get(draft!.id);
  expect(after).not.toHaveProperty('proposedLines');
  expect(dto).toMatchObject({ status: 'issued', currentVersion: 1, number: draft!.number });
  expect(dto.lines).toHaveLength(1);
  expect(dto.lines[0]).toMatchObject({
    lineNo: 1,
    prLineId,
    kind: 'goods',
    description: 'Laptop 14 inch',
    uom: 'pcs',
    orderedQuantity: '2.0000',
    unitPrice: '39000.00',
    taxCodeId: vatCode,
    gross: '78000.00',
    taxAmount: '10140.00',
    lineTotal: '88140.00',
  });
  const [v1] = await service.versions(draft!.id);
  expect(v1).toMatchObject({
    version: 1,
    total: quote.total,
    totalNpr: quote.totalNpr,
    band: 'base',
  });
});
