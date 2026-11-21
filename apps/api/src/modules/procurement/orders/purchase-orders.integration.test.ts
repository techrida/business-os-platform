// Integration tests of purchase orders on a real Postgres (Testcontainers, needs Docker in WSL).
// Real: migrations as bos_owner, queries as bos_app (so the version trigger, the revoked privileges and every 0034
// CHECK run), PurchaseOrdersService, the real ApprovalsService with the `po_amendment` workflow published through
// ApprovalsAdminService (spec PO_AMENDMENT_WORKFLOW_SPEC, which the seed copies), the real PoAmendmentSubject,
// ReceiptsService (receipts and progress) and AuditService. Faked: notify, the role directory (role -> real staff
// users of entity A), the request context and authz.assert (the real pure can() on a fake principal).
// Draft POs are inserted directly, as P2's commitment route leaves them (number taken, status draft, version 0).
// Run: pnpm --filter @bos/api exec vitest run src/modules/procurement/orders/purchase-orders.integration.test.ts
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
  purchaseRequests,
} from '@bos/db';
import { ForbiddenException, HttpException } from '@nestjs/common';
import { asc, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { Queue } from 'bullmq';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { AuditService } from '../../../platform/audit/audit.service';
import type { AuthzService } from '../../../platform/authz/authz.service';
import { can } from '../../../platform/authz/can';
import type { Principal } from '../../../platform/authz/principal';
import type { Db, DbTransaction } from '../../../platform/db/db.module';
import { systemActor, withTx, type TxScope } from '../../../platform/db/tx';
import { NumberingService } from '../../../platform/settings/numbering.service';
import { ApprovalsAdminService } from '../../approvals/admin.service';
import { asSecondPerson, SKIP_LIVE_PUBLISHER_CHECK } from '../../../../test/support/second-person';
import { ApprovalsService } from '../../approvals/requests.service';
import {
  EMERGENCY_REVIEW_DOCUMENT_TYPE,
  EMERGENCY_REVIEW_WORKFLOW_SPEC,
  EmergencyReviewSubject,
} from '../receipts/emergency-review';
import { ReceiptsService } from '../receipts/receipts.service';
import { quotationLineAmounts } from '../sourcing/sourcing.rules';
import { PoAmendmentSubject } from './po-amendment.subject';
import { PO_ISSUE_ACTION, PO_READ_ONLY_ACTIONS } from './po-read-access';
import { PO_AMENDMENT_DOCUMENT_TYPE, PO_AMENDMENT_WORKFLOW_SPEC } from './purchase-order.rules';
import { PurchaseOrdersService } from './purchase-orders.service';
import { PurchaseOrderRenderNudge } from './render/purchase-order-render.nudge';
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
let audit: AuditService;
let service: PurchaseOrdersService;
let receiptsService: ReceiptsService;
let deptA = '';
let deptB = '';
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
const current: {
  userId: string;
  role: RoleKey;
  scope: TxScope | null;
  /** Replaces the role's default grants, as an admin's edit of the live grants would. */
  grants: Map<Permission, Scope> | null;
} = {
  userId: '',
  role: 'procurement',
  scope: null,
  grants: null,
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
  grants: current.grants ?? grantsOf(current.role),
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
  U.acct = await staff('accountant');
  U.fin = await staff('finance');
  U.mgmt = await staff('management');
  U.founder = await staff('founder');
  U.wh = await staff('warehouse');
  resetRoles();
  deptA = (await createDepartment(appPool, scopeA)).departmentId;
  deptB = (await createDepartment(appPool, scopeB)).departmentId;

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
    key: EMERGENCY_REVIEW_DOCUMENT_TYPE,
    name: 'Emergency purchase review',
    spec: EMERGENCY_REVIEW_WORKFLOW_SPEC,
  });
  await adminPublisher.publish(EMERGENCY_REVIEW_DOCUMENT_TYPE, 1, SKIP_LIVE_PUBLISHER_CHECK);

  approvals = new ApprovalsService(db, audit, notify, directory, caller, () => now);
  const renderNudge = new PurchaseOrderRenderNudge(renderQueue as unknown as Queue);
  approvals.registerSubject(new PoAmendmentSubject(audit, approvals, () => now, renderNudge));
  approvals.registerSubject(new EmergencyReviewSubject(audit, approvals));
  service = new PurchaseOrdersService(
    db,
    approvals,
    audit,
    caller,
    () => now,
    undefined,
    renderNudge,
  );
  receiptsService = new ReceiptsService(
    db,
    authz as unknown as AuthzService,
    audit,
    new NumberingService(),
    caller,
    () => now,
    approvals,
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
  current.grants = null;
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

type VendorStatus = 'approved' | 'draft' | 'pending_kyc' | 'suspended' | 'blocked';
let panSeq = 0;
/** A vendor in `status` with an account (active unless told otherwise) in each of `accountIn`. */
async function vendor(
  status: VendorStatus,
  opts: { accountIn?: TxScope[]; active?: boolean } = {},
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
                ${String(200_000_000 + (panSeq += 1))}, ${status}, ${U.proc},
                ${status === 'draft' || status === 'pending_kyc' ? null : U.mgmt})`,
  );
  for (const s of opts.accountIn ?? [scopeA]) {
    await exec(
      s,
      sql`INSERT INTO app.vendor_accounts (tenant_id, organization_id, vendor_id, active)
          VALUES (${s.tenantId}, ${s.organizationId}, ${partyId}, ${opts.active ?? true})`,
    );
  }
  return partyId;
}

let poSeq = 0;
/**
 * An approved request and its draft PO in `scope` (P2's shape: number taken, version 0) with one line of
 * `quantity` x `unitPrice` + 13% VAT. Default 1 x 79,646.02 = 90,000.00 incl. VAT, band base.
 */
async function draftPo(
  opts: {
    vendorId?: string;
    scope?: TxScope;
    quantity?: string;
    unitPrice?: string;
    emergency?: boolean;
    /** Who raised the purchase request; the requester by default. */
    requester?: string;
  } = {},
): Promise<{ id: string; prId: string; lineId: string }> {
  const scope = opts.scope ?? scopeA;
  const vendorId = opts.vendorId ?? (await vendor('approved', { accountIn: [scopeA, scopeB] }));
  const quantity = opts.quantity ?? '1';
  const unitPrice = opts.unitPrice ?? '79646.02';
  const a = quotationLineAmounts(quantity, unitPrice, 1300);
  const prId = randomUUID();
  await exec(
    scope,
    sql`INSERT INTO app.purchase_requests (id, tenant_id, organization_id, request_type, department_id,
          requester_user_id, cost_center_id, justification, required_by, budget_code, currency)
        VALUES (${prId}, ${scope.tenantId}, ${scope.organizationId}, 'goods',
                ${scope === scopeA ? deptA : deptB}, ${opts.requester ?? U.req}, ${(await createCostCenter(appPool, scope)).costCenterId}, 'Laptops', '2026-12-01',
                'IT-2083', 'NPR')`,
  );
  await exec(
    scope,
    sql`UPDATE app.purchase_requests SET status = 'approved', fx_rate = 1, estimated_total = ${a.lineTotal},
          estimated_total_npr = ${a.lineTotal}, number = ${`PR-T-${prId.slice(0, 8)}`} WHERE id = ${prId}`,
  );
  if (opts.emergency === true) {
    await exec(
      scope,
      sql`UPDATE app.purchase_requests SET is_emergency = true, emergency_reason = 'The server room is flooding'
          WHERE id = ${prId}`,
    );
  }
  const id = randomUUID();
  poSeq += 1;
  await exec(
    scope,
    sql`INSERT INTO app.purchase_orders (id, tenant_id, organization_id, number, number_seq, fiscal_year,
          purchase_request_id, vendor_id, currency, payment_terms_days, approved_total, fx_rate,
          approved_total_npr, approved_band, created_by)
        VALUES (${id}, ${scope.tenantId}, ${scope.organizationId}, ${`PO-T-${poSeq}`}, ${poSeq}, '2082/83',
                ${prId}, ${vendorId}, 'NPR', 30, ${a.lineTotal}, 1, ${a.lineTotal}, 'base', ${U.proc})`,
  );
  const lineId = randomUUID();
  await exec(
    scope,
    sql`INSERT INTO app.purchase_order_lines (id, tenant_id, organization_id, purchase_order_id,
          purchase_request_id, line_no, kind, description, uom, ordered_quantity, unit_price, tax_code_id, gross,
          tax_amount, line_total)
        VALUES (${lineId}, ${scope.tenantId}, ${scope.organizationId}, ${id}, ${prId}, 1, 'goods', 'Laptop',
                'pcs', ${quantity}, ${unitPrice}, ${vatCode}, ${a.gross}, ${a.taxAmount}, ${a.lineTotal})`,
  );
  return { id, prId, lineId };
}

async function issued(opts: Parameters<typeof draftPo>[0] = {}) {
  const po = await draftPo(opts);
  await service.issue(po.id, randomUUID());
  return po;
}

/** A goods receipt of `quantity` on the PO's line by the warehouse; confirmed unless `draft`. */
async function receive(po: { id: string; lineId: string }, quantity: string, draft = false) {
  as(U.wh, 'warehouse');
  try {
    const r = await receiptsService.create(
      {
        purchaseOrderId: po.id,
        kind: 'goods',
        receivedAt: '2026-11-09',
        lines: [{ poLineId: po.lineId, quantity }],
      },
      randomUUID(),
    );
    if (!draft) await receiptsService.confirm(r.id, randomUUID());
  } finally {
    as(U.proc, 'procurement');
  }
}

const amendmentRequests = (amendmentRequestId: string) =>
  read((tx) =>
    tx
      .select({ status: approvalRequests.status, version: approvalRequests.version })
      .from(approvalRequests)
      .where(eq(approvalRequests.id, amendmentRequestId)),
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

async function decide(
  user: string,
  role: RoleKey,
  requestId: string,
  action: 'approve' | 'reject' = 'approve',
) {
  const [req] = await amendmentRequests(requestId);
  as(user, role);
  try {
    return await approvals.act(
      requestId,
      {
        action,
        expectedVersion: req!.version,
        ...(action === 'reject' ? { comment: 'Too much' } : {}),
      },
      randomUUID(),
    );
  } finally {
    as(U.proc, 'procurement');
  }
}

const reason = 'Vendor revised the price';

/** The render queue the nudge enqueues on (render on commit, S3); each test reads what was enqueued. */
const renderQueue = { add: vi.fn((..._args: unknown[]) => Promise.resolve({})) };
/** The job ids enqueued so far, in order. */
const renderJobIds = () => renderQueue.add.mock.calls.map((c) => (c[2] as { jobId: string }).jobId);

// ---------------------------------------------------------------------------------------- issue

describe('issue', () => {
  it('writes version 1, issues the PO and moves the request to po_issued', async () => {
    const po = await draftPo();
    const dto = await service.issue(po.id, randomUUID());
    expect(dto).toMatchObject({ status: 'issued', currentVersion: 1 });
    expect(dto.number).toMatch(/^PO-T-/);
    expect(dto.issuedAt).toBe(now.toISOString());
    const versions = await service.versions(po.id);
    expect(versions.map((v) => [v.version, v.total, v.totalNpr, v.band])).toEqual([
      [1, '90000.00', '90000.00', 'base'],
    ]);
    const [pr] = await read((tx) =>
      tx.select().from(purchaseRequests).where(eq(purchaseRequests.id, po.prId)),
    );
    expect(pr!.status).toBe('po_issued');
  });

  it.each(['draft', 'pending_kyc', 'suspended', 'blocked'] as const)(
    'refuses a %s vendor with 409 VENDOR_NOT_APPROVED (done check 15)',
    async (status) => {
      const po = await draftPo({ vendorId: await vendor(status) });
      const e = await httpErrorOf(service.issue(po.id, randomUUID()));
      expect(e.getStatus()).toBe(409);
      expect(codeOf(e)).toBe('VENDOR_NOT_APPROVED');
      expect((await service.get(po.id)).status).toBe('draft');
      expect(await service.versions(po.id)).toEqual([]);
    },
  );

  it('refuses a vendor whose account in the entity is inactive with 409 VENDOR_NOT_IN_ENTITY', async () => {
    const po = await draftPo({ vendorId: await vendor('approved', { active: false }) });
    const e = await httpErrorOf(service.issue(po.id, randomUUID()));
    expect(e.getStatus()).toBe(409);
    expect(codeOf(e)).toBe('VENDOR_NOT_IN_ENTITY');
  });

  it('replays the same Idempotency-Key and refuses a second issue', async () => {
    const po = await draftPo();
    const key = randomUUID();
    const first = await service.issue(po.id, key);
    expect(await service.issue(po.id, key)).toEqual(first);
    expect((await httpErrorOf(service.issue(po.id, randomUUID()))).getStatus()).toBe(409);
    expect(await service.versions(po.id)).toHaveLength(1);
  });

  it('serialises two concurrent issues: one 200, one 409, one version', async () => {
    const po = await draftPo();
    const results = await Promise.allSettled([
      service.issue(po.id, randomUUID()),
      service.issue(po.id, randomUUID()),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const failed = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect((failed.reason as HttpException).getStatus()).toBe(409);
    expect(await service.versions(po.id)).toHaveLength(1);
  });

  it('tells the requester in the app that their order was issued, once, with no email', async () => {
    const notifying = new PurchaseOrdersService(db, approvals, audit, caller, () => now, notify);
    const po = await draftPo();
    notify.notifyUser.mockClear();
    const key = randomUUID();
    const dto = await notifying.issue(po.id, key);
    await notifying.issue(po.id, key);
    expect(notify.notifyUser.mock.calls.map((c) => (c as unknown[])[1])).toEqual([
      {
        userId: U.req,
        title: `Purchase order ${dto.number} issued`,
        body: `Purchase order ${dto.number} was issued for PR-T-${po.prId.slice(0, 8)}.`,
        link: `/procurement/requests/${po.prId}`,
        dedupeKey: `purchase_order:${po.id}:issued`,
      },
    ]);
  });
});

// ---------------------------------------------------------------------------------------- amend (AD7)

describe('amend (done check 2, F1-Q40)', () => {
  it('90,000 -> 81,000 issues v2 at once, with no approval and an audit row', async () => {
    const po = await issued();
    const r = await service.amend(
      po.id,
      { reason, lines: [{ poLineId: po.lineId, unitPrice: '71681.42' }] },
      randomUUID(),
    );
    expect(r.outcome).toBe('applied');
    expect(r.approvalRequestId).toBeNull();
    expect(r.purchaseOrder).toMatchObject({
      status: 'issued',
      currentVersion: 2,
      approvedBand: 'base',
    });
    expect(r.purchaseOrder.lines[0]).toMatchObject({ id: po.lineId, lineTotal: '81000.00' });
    const versions = await service.versions(po.id);
    expect(versions.map((v) => [v.version, v.total, v.band, v.approvalRequestId])).toEqual([
      [1, '90000.00', 'base', null],
      [2, '81000.00', 'base', null],
    ]);
    const requests = await read((tx) =>
      tx
        .select()
        .from(approvalRequests)
        .where(eq(approvalRequests.documentType, PO_AMENDMENT_DOCUMENT_TYPE)),
    );
    expect(
      requests.filter(
        (q) =>
          (q.snapshot as { amendment: { purchaseOrderId: string } }).amendment.purchaseOrderId ===
          po.id,
      ),
    ).toEqual([]);
    const events = await audit.list(scopeA, {
      entityType: 'purchase_orders',
      entityId: po.id,
      limit: 100,
    });
    expect(events.map((e) => e.action)).toContain('procurement.po.amended');
  });

  it('90,000 -> 99,000 rises inside the base band and waits for Accountant and Finance (F1-Q40)', async () => {
    const po = await issued();
    const r = await service.amend(
      po.id,
      { reason, lines: [{ poLineId: po.lineId, unitPrice: '87610.62' }] },
      randomUUID(),
    );
    expect(r.outcome).toBe('pending_approval');
    expect(r.purchaseOrder).toMatchObject({ status: 'amendment_pending', currentVersion: 1 });
    expect(await stepRoles(r.approvalRequestId!)).toEqual(['accountant', 'finance']);
    const request = await approvals.get(r.approvalRequestId!);
    expect(request.snapshot).toMatchObject({ approvalReasons: ['value_rises'] });

    await decide(U.acct, 'accountant', r.approvalRequestId!);
    await decide(U.fin, 'finance', r.approvalRequestId!);
    expect(await service.get(po.id)).toMatchObject({
      status: 'issued',
      currentVersion: 2,
      approvedTotal: '99000.00',
      approvedBand: 'base',
    });
  });

  it('sends a change of payment terms alone for approval, and refuses an amendment of nothing (F1-Q40)', async () => {
    const po = await issued();
    const nothing = await httpErrorOf(
      service.amend(po.id, { reason, paymentTermsDays: 30, lines: [] }, randomUUID()),
    );
    expect(nothing.getStatus()).toBe(422);
    expect(codeOf(nothing)).toBe('PO_AMENDMENT_INVALID');

    const r = await service.amend(po.id, { reason, paymentTermsDays: 45, lines: [] }, randomUUID());
    expect(r.outcome).toBe('pending_approval');
    expect((await approvals.get(r.approvalRequestId!)).snapshot).toMatchObject({
      approvalReasons: ['terms_change'],
    });
    await decide(U.acct, 'accountant', r.approvalRequestId!);
    await decide(U.fin, 'finance', r.approvalRequestId!);
    expect(await service.get(po.id)).toMatchObject({
      status: 'issued',
      currentVersion: 2,
      paymentTermsDays: 45,
      approvedTotal: '90000.00',
    });
  });

  it('90,000 -> 1,50,000 routes to Management and writes v2 only on approval', async () => {
    const po = await issued();
    const r = await service.amend(
      po.id,
      { reason, lines: [{ poLineId: po.lineId, unitPrice: '132743.36' }] },
      randomUUID(),
    );
    expect(r.outcome).toBe('pending_approval');
    expect(r.purchaseOrder).toMatchObject({ status: 'amendment_pending', currentVersion: 1 });
    const requestId = r.approvalRequestId!;
    expect(await stepRoles(requestId)).toEqual(['accountant', 'finance', 'management']);
    expect(await service.versions(po.id)).toHaveLength(1);
    // A second amendment while one waits is refused.
    const again = await httpErrorOf(
      service.amend(
        po.id,
        { reason, lines: [{ poLineId: po.lineId, quantity: '2' }] },
        randomUUID(),
      ),
    );
    expect(again.getStatus()).toBe(409);

    await decide(U.acct, 'accountant', requestId);
    await decide(U.fin, 'finance', requestId);
    expect((await service.get(po.id)).status).toBe('amendment_pending');
    await decide(U.mgmt, 'management', requestId);

    const after = await service.get(po.id);
    expect(after).toMatchObject({
      status: 'issued',
      currentVersion: 2,
      approvedBand: 'management',
      approvedTotal: '150000.00',
      approvedTotalNpr: '150000.00',
    });
    const versions = await service.versions(po.id);
    expect(versions[1]).toMatchObject({
      version: 2,
      total: '150000.00',
      band: 'management',
      approvalRequestId: requestId,
    });
  });

  it('a rejected amendment leaves the PO at its version, back to issued', async () => {
    const po = await issued();
    const r = await service.amend(
      po.id,
      { reason, lines: [{ poLineId: po.lineId, unitPrice: '132743.36' }] },
      randomUUID(),
    );
    await decide(U.acct, 'accountant', r.approvalRequestId!, 'reject');
    expect(await service.get(po.id)).toMatchObject({
      status: 'issued',
      currentVersion: 1,
      approvedBand: 'base',
    });
    expect(await service.versions(po.id)).toHaveLength(1);
  });

  it('refuses a quantity below what is received (422) and a draft PO (409)', async () => {
    const po = await issued({ quantity: '5', unitPrice: '100.00' });
    await receive(po, '3');
    const e = await httpErrorOf(
      service.amend(
        po.id,
        { reason, lines: [{ poLineId: po.lineId, quantity: '2' }] },
        randomUUID(),
      ),
    );
    expect(e.getStatus()).toBe(422);
    expect(codeOf(e)).toBe('PO_AMENDMENT_INVALID');
    const draft = await draftPo();
    const d = await httpErrorOf(
      service.amend(
        draft.id,
        { reason, lines: [{ poLineId: draft.lineId, quantity: '2' }] },
        randomUUID(),
      ),
    );
    expect(d.getStatus()).toBe(409);
  });
});

describe('receiving more than ordered (F1-Q39)', () => {
  it('refuses the extra unit, then takes it once Procurement amended the order up', async () => {
    const po = await issued({ quantity: '5', unitPrice: '100.00' });
    await receive(po, '5');
    expect((await service.get(po.id)).status).toBe('fully_received');

    // The warehouse is told to ask for an amendment, and nothing is written.
    as(U.wh, 'warehouse');
    const refused = await httpErrorOf(
      receiptsService.create(
        {
          purchaseOrderId: po.id,
          kind: 'goods',
          receivedAt: '2026-11-09',
          lines: [{ poLineId: po.lineId, quantity: '1' }],
        },
        randomUUID(),
      ),
    );
    as(U.proc, 'procurement');
    expect(refused.getStatus()).toBe(409);
    expect((refused.getResponse() as { message?: string }).message).toBe(
      'Everything ordered on this purchase order has been received. To receive more, ask Procurement to amend the purchase order first.',
    );
    expect(await receiptsService.list(po.id)).toHaveLength(1);

    // Procurement amends the fully received order from 5 to 6.
    const amended = await service.amend(
      po.id,
      { reason: 'One more arrived', lines: [{ poLineId: po.lineId, quantity: '6' }] },
      randomUUID(),
    );
    // The total rises, so the amendment is approved first (F1-Q40).
    expect(amended.outcome).toBe('pending_approval');
    await decide(U.acct, 'accountant', amended.approvalRequestId!);
    await decide(U.fin, 'finance', amended.approvalRequestId!);
    const after = await service.get(po.id);
    expect(after).toMatchObject({ status: 'partially_received', currentVersion: 2 });
    expect(after.lines[0]).toMatchObject({ orderedQuantity: '6.0000' });

    // The same warehouse user now receives the sixth unit.
    await receive(po, '1');
    expect((await service.get(po.id)).status).toBe('fully_received');
    const progress = await receiptsService.progress(po.id);
    expect(progress.lines[0]).toMatchObject({ receivedQuantity: '6.0000', openQuantity: '0.0000' });
  });

  it('answers a partly received order with the amend-first sentence', async () => {
    const po = await issued({ quantity: '5', unitPrice: '100.00' });
    await receive(po, '3');
    const e = await httpErrorOf(receive(po, '3'));
    expect(e.getStatus()).toBe(422);
    expect(codeOf(e)).toBe('over_receipt');
    expect((e.getResponse() as { message?: string }).message).toBe(
      'Line 1 has only 2 still open on the purchase order. To receive more, ask Procurement to amend the purchase order first.',
    );
  });
});

describe('review of an emergency purchase after receipt (F1-Q41)', () => {
  const reviewsOf = (poId: string) =>
    read((tx) =>
      tx
        .select()
        .from(approvalRequests)
        .where(
          sql`${approvalRequests.documentType} = ${EMERGENCY_REVIEW_DOCUMENT_TYPE}
              AND ${approvalRequests.documentId} = ${poId}`,
        ),
    );

  it('asks Management once, when the order first has everything, and audits the decision', async () => {
    const po = await issued({ quantity: '5', unitPrice: '100.00', emergency: true });
    await receive(po, '3');
    expect(await reviewsOf(po.id)).toEqual([]);
    await receive(po, '2');

    const [review] = await reviewsOf(po.id);
    expect(review).toMatchObject({ status: 'pending', requesterUserId: U.req });
    expect(review!.sodUserIds).toEqual(expect.arrayContaining([U.req, U.wh]));
    expect(await stepRoles(review!.id)).toEqual(['management']);
    expect(review!.snapshot).toMatchObject({
      purchaseOrderId: po.id,
      emergencyReason: 'The server room is flooding',
    });

    // A reversal and a second full receipt do not ask again.
    as(U.wh, 'warehouse');
    const [last] = await receiptsService.list(po.id);
    await receiptsService.reverse(last!.id, { reason: 'Wrong box' }, randomUUID());
    as(U.proc, 'procurement');
    await receive(po, '2');
    expect(await reviewsOf(po.id)).toHaveLength(1);

    await decide(U.mgmt, 'management', review!.id);
    const events = await audit.list(scopeA, {
      entityType: 'purchase_orders',
      entityId: po.id,
      limit: 100,
    });
    expect(events.map((e) => e.action)).toEqual(
      expect.arrayContaining([
        'procurement.emergency_review.requested',
        'procurement.emergency_review.approved',
      ]),
    );
  });

  it('asks nothing for an ordinary purchase', async () => {
    const po = await issued({ quantity: '2', unitPrice: '100.00' });
    await receive(po, '2');
    expect((await service.get(po.id)).status).toBe('fully_received');
    expect(await reviewsOf(po.id)).toEqual([]);
  });

  it('asks Management once when the rest of an emergency order is short-closed', async () => {
    const po = await issued({ quantity: '5', unitPrice: '100.00', emergency: true });
    await receive(po, '2');
    expect(await reviewsOf(po.id)).toEqual([]);

    const dto = await service.shortClose(po.id, { reason: 'Vendor out of stock' }, randomUUID());
    expect(dto.status).toBe('short_closed');
    const reviews = await reviewsOf(po.id);
    expect(reviews).toHaveLength(1);
    expect(reviews[0]).toMatchObject({ status: 'pending', requesterUserId: U.req });
    // Who short-closed the order does not review it.
    expect(reviews[0]!.sodUserIds).toEqual(expect.arrayContaining([U.req, U.proc]));
    expect(await stepRoles(reviews[0]!.id)).toEqual(['management']);
  });

  it('asks nothing when an ordinary order is short-closed', async () => {
    const po = await issued({ quantity: '5', unitPrice: '100.00' });
    await receive(po, '2');
    await service.shortClose(po.id, { reason: 'Vendor out of stock' }, randomUUID());
    expect(await reviewsOf(po.id)).toEqual([]);
  });

  it('asks Management once when an amendment applied at once lowers the order to what arrived', async () => {
    const po = await issued({ quantity: '5', unitPrice: '100.00', emergency: true });
    await receive(po, '3');

    // The total falls, so the amendment applies at once (F1-Q40).
    const r = await service.amend(
      po.id,
      { reason: 'Only three will come', lines: [{ poLineId: po.lineId, quantity: '3' }] },
      randomUUID(),
    );
    expect(r.outcome).toBe('applied');
    expect(r.purchaseOrder.status).toBe('fully_received');
    const reviews = await reviewsOf(po.id);
    expect(reviews).toHaveLength(1);
    expect(reviews[0]).toMatchObject({ status: 'pending', requesterUserId: U.req });
    expect(reviews[0]!.sodUserIds).toEqual(expect.arrayContaining([U.req, U.proc]));
  });

  it('asks Management once an approved amendment leaves the order fully received, not while it waits', async () => {
    const po = await issued({ quantity: '5', unitPrice: '100.00', emergency: true });
    await receive(po, '3');

    // Three at a higher price: the total rises from 565.00 to 678.00, so the amendment is approved first.
    const r = await service.amend(
      po.id,
      {
        reason: 'Only three will come, at a higher price',
        lines: [{ poLineId: po.lineId, quantity: '3', unitPrice: '200.00' }],
      },
      randomUUID(),
    );
    expect(r.outcome).toBe('pending_approval');
    expect(await reviewsOf(po.id)).toEqual([]);

    await decide(U.acct, 'accountant', r.approvalRequestId!);
    await decide(U.fin, 'finance', r.approvalRequestId!);
    expect((await service.get(po.id)).status).toBe('fully_received');
    const reviews = await reviewsOf(po.id);
    expect(reviews).toHaveLength(1);
    // Whoever proposed the amendment does not review it; the approver of the amendment is not excluded.
    expect(reviews[0]!.sodUserIds).toEqual(expect.arrayContaining([U.req, U.proc]));
    expect(reviews[0]!.sodUserIds).not.toContain(U.fin);
    expect(await stepRoles(reviews[0]!.id)).toEqual(['management']);
  });

  it('asks nothing when an ordinary order is amended down to what arrived', async () => {
    const po = await issued({ quantity: '5', unitPrice: '100.00' });
    await receive(po, '3');
    const r = await service.amend(
      po.id,
      { reason: 'Only three will come', lines: [{ poLineId: po.lineId, quantity: '3' }] },
      randomUUID(),
    );
    expect(r.purchaseOrder.status).toBe('fully_received');
    expect(await reviewsOf(po.id)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------- versions

describe('versions are immutable', () => {
  it('refuses UPDATE and DELETE of a version row', async () => {
    const po = await issued();
    await expect(
      exec(
        scopeA,
        sql`UPDATE app.purchase_order_versions SET reason = 'x' WHERE purchase_order_id = ${po.id}`,
      ),
    ).rejects.toThrow();
    await expect(
      exec(scopeA, sql`DELETE FROM app.purchase_order_versions WHERE purchase_order_id = ${po.id}`),
    ).rejects.toThrow();
    expect(await service.versions(po.id)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------- short-close, cancel

describe('short-close and cancel', () => {
  it('cancels an issued PO after its draft receipt is discarded', async () => {
    const po = await issued({ quantity: '5', unitPrice: '100.00' });
    await receive(po, '1', true);
    const [draft] = await receiptsService.list(po.id);
    as(U.wh, 'warehouse');
    await receiptsService.discard(draft!.id, randomUUID());
    as(U.proc, 'procurement');
    expect(
      (await service.cancel(po.id, { reason: 'No delivery needed' }, randomUUID())).status,
    ).toBe('cancelled');
  });
  it('short-close cancels the open remainder and the progress shows nothing open', async () => {
    const po = await issued({ quantity: '5', unitPrice: '100.00' });
    await receive(po, '2');
    expect((await service.get(po.id)).status).toBe('partially_received');
    const dto = await service.shortClose(po.id, { reason: 'Vendor out of stock' }, randomUUID());
    expect(dto).toMatchObject({ status: 'short_closed', closedReason: 'Vendor out of stock' });
    expect(dto.lines[0]!.cancelledQuantity).toBe('3.0000');
    const progress = await receiptsService.progress(po.id);
    expect(progress.status).toBe('short_closed');
    expect(progress.lines[0]).toMatchObject({
      cancelledQuantity: '3.0000',
      receivedQuantity: '2.0000',
      openQuantity: '0.0000',
    });
  });

  it('short-close of an issued PO with nothing received is 409', async () => {
    const po = await issued();
    const e = await httpErrorOf(service.shortClose(po.id, { reason: 'x' }, randomUUID()));
    expect(e.getStatus()).toBe(409);
  });

  it('cancels an issued PO with nothing received: every line cancelled in full', async () => {
    const po = await issued({ quantity: '4', unitPrice: '10.00' });
    const dto = await service.cancel(po.id, { reason: 'Project dropped' }, randomUUID());
    expect(dto.status).toBe('cancelled');
    expect(dto.lines[0]!.cancelledQuantity).toBe('4.0000');
  });

  it('refuses cancel after a receipt: 409 (confirmed) and 409 PO_HAS_RECEIPTS (draft)', async () => {
    const confirmed = await issued({ quantity: '5', unitPrice: '100.00' });
    await receive(confirmed, '1');
    const e1 = await httpErrorOf(service.cancel(confirmed.id, { reason: 'x' }, randomUUID()));
    expect(e1.getStatus()).toBe(409);
    const drafted = await issued({ quantity: '5', unitPrice: '100.00' });
    await receive(drafted, '1', true);
    const e2 = await httpErrorOf(service.cancel(drafted.id, { reason: 'x' }, randomUUID()));
    expect(e2.getStatus()).toBe(409);
    expect(codeOf(e2)).toBe('PO_HAS_RECEIPTS');
    expect((await service.get(drafted.id)).status).toBe('issued');
  });

  it('refuses cancel while a non-voided vendor bill names the PO (409 PO_HAS_BILLS) and allows it once voided', async () => {
    const vendorId = await vendor('approved', { accountIn: [scopeA] });
    const po = await issued({ vendorId });
    const docId = (
      await exec(
        scopeA,
        sql`INSERT INTO app.documents (tenant_id, organization_id, owner_type, owner_id)
            VALUES (${scopeA.tenantId}, ${scopeA.organizationId}, 'vendor_bill_intake', ${randomUUID()})
            RETURNING id`,
      )
    ).rows[0] as { id: string };
    const billId = randomUUID();
    await exec(
      scopeA,
      sql`INSERT INTO app.vendor_bills (id, tenant_id, organization_id, number, vendor_id, vendor_invoice_no,
            invoice_date, fiscal_year, currency, purchase_order_id, document_id, status,
            net_total, vat_total, tds_total, payable_total, fx_rate, payable_total_npr, entered_by)
          VALUES (${billId}, ${scopeA.tenantId}, ${scopeA.organizationId}, 'BILL-2082/83-9001', ${vendorId},
                  'INV-PO-9001', '2026-11-09', '2082/83', 'NPR', ${po.id}, ${docId.id}, 'draft',
                  1000.00, 130.00, 0.00, 1130.00, 1, 1130.00, ${U.acct})`,
    );

    const refused = await httpErrorOf(service.cancel(po.id, { reason: 'x' }, randomUUID()));
    expect(refused.getStatus()).toBe(409);
    expect(codeOf(refused)).toBe('PO_HAS_BILLS');
    expect((refused.getResponse() as { message?: string }).message).toContain('BILL-2082/83-9001');
    expect((await service.get(po.id)).status).toBe('issued');

    await exec(
      scopeA,
      sql`UPDATE app.vendor_bills
          SET status = 'voided', voided_by = ${U.acct}, voided_at = ${now.toISOString()}, void_reason = 'Duplicate'
          WHERE id = ${billId}`,
    );
    expect((await service.cancel(po.id, { reason: 'Bill voided' }, randomUUID())).status).toBe(
      'cancelled',
    );
  });
});

// ---------------------------------------------------------------------------------------- vendor name

const PAGE = { limit: 100, offset: 0 };

describe('vendor name on reads', () => {
  it('carries the vendor legal name on every list row and on get, in the entity and out of it', async () => {
    const vendorId = await vendor('approved', { accountIn: [scopeA, scopeB] });
    const name = `Vendor ${vendorId.slice(0, 6)}`;
    const inA = await draftPo({ vendorId });
    const inB = await draftPo({ vendorId, scope: scopeB });

    const rowsA = (await service.list(PAGE)).rows;
    expect(rowsA.find((p) => p.id === inA.id)).toMatchObject({ vendorId, vendorName: name });
    expect(await service.get(inA.id)).toMatchObject({ vendorId, vendorName: name });
    expect(rowsA.every((p) => typeof p.vendorName === 'string' && p.vendorName !== '')).toBe(true);
    // The status filter keeps the join.
    expect(
      (await service.list({ ...PAGE, status: ['draft'] })).rows.find((p) => p.id === inA.id)
        ?.vendorName,
    ).toBe(name);

    // Vendors are tenant level: entity B sees the same name on its own PO, and never entity A's PO.
    current.scope = scopeB;
    const rowsB = (await service.list(PAGE)).rows;
    expect(rowsB.find((p) => p.id === inB.id)?.vendorName).toBe(name);
    expect(rowsB.map((p) => p.id)).not.toContain(inA.id);
    expect((await service.get(inB.id)).vendorName).toBe(name);
  });

  it('keeps the list rows free of lines', async () => {
    const po = await draftPo();
    const row = (await service.list(PAGE)).rows.find((p) => p.id === po.id);
    expect(row).toBeDefined();
    expect(row).not.toHaveProperty('lines');
    expect(row).toHaveProperty('vendorName');
  });
});

describe('list filters, search and paging', () => {
  it('takes several statuses, searches by number or vendor, pages by offset and stays in the entity', async () => {
    const vendorId = await vendor('approved', { accountIn: [scopeA, scopeB] });
    const name = `Vendor ${vendorId.slice(0, 6)}`;
    const inA = await draftPo({ vendorId });
    const inB = await draftPo({ vendorId, scope: scopeB });

    const byStatus = await service.list({ ...PAGE, status: ['draft', 'issued'] });
    expect(byStatus.rows.map((p) => p.id)).toContain(inA.id);
    const none = await service.list({ ...PAGE, status: ['cancelled'] });
    expect(none.rows.map((p) => p.id)).not.toContain(inA.id);

    const byVendor = await service.list({ ...PAGE, q: name });
    expect(byVendor.rows.map((p) => p.id)).toContain(inA.id);
    expect(byVendor.total).toBe(byVendor.rows.length);
    const numberA = (await service.get(inA.id)).number;
    const byNumber = await service.list({ ...PAGE, q: numberA });
    expect(byNumber.rows.map((p) => p.id)).toContain(inA.id);

    const all = await service.list(PAGE);
    const second = await service.list({ limit: 1, offset: 1 });
    expect(second.total).toBe(all.total);
    expect(second.rows[0]?.id).toBe(all.rows[1]?.id);

    current.scope = scopeB;
    const inOther = await service.list({ ...PAGE, q: name });
    expect(inOther.rows[0]?.id).toBe(inB.id);
    expect(inOther.rows.map((p) => p.id)).not.toContain(inA.id);
  });
});

// ---------------------------------------------------------------------------------------- read-only readers

describe('a read-only purchase order view for accountant, finance and warehouse (F1-Q52)', () => {
  it('lets each of them open the list, the detail, its versions and its progress, and offers only their own action', async () => {
    const po = await issued();
    const readers: Array<[string, RoleKey]> = [
      [U.acct, 'accountant'],
      [U.fin, 'finance'],
      [U.wh, 'warehouse'],
    ];
    for (const [userId, role] of readers) {
      as(userId, role);
      expect(grantsOf(role).has('procurement.po.issue')).toBe(false);
      const page = await service.list(PAGE);
      expect(page.rows.map((p) => p.id)).toContain(po.id);
      expect(page.total).toBeGreaterThanOrEqual(page.rows.length);
      expect(await service.get(po.id)).toMatchObject({
        id: po.id,
        status: 'issued',
        // Enter bill for whoever enters bills, Receive goods for the warehouse; nobody else gets either.
        can: { enterBill: role === 'accountant', receive: role === 'warehouse' },
      });
      expect(await service.versions(po.id)).toHaveLength(1);
      await expect(receiptsService.progress(po.id)).resolves.toMatchObject({
        purchaseOrderId: po.id,
      });
    }
  });

  it('still refuses roles that hold none of those grants: management and a requester', async () => {
    const po = await issued();
    const refused: Array<[string, RoleKey]> = [
      [U.mgmt, 'management'],
      [U.req, 'operations_officer'],
    ];
    for (const [userId, role] of refused) {
      as(userId, role);
      expect((await httpErrorOf(service.list(PAGE))).getStatus()).toBe(403);
      // The detail is a 404 for staff with no way in (R4f Q1 b): it never says whether the order exists.
      expect((await httpErrorOf(service.get(po.id))).getStatus()).toBe(404);
      expect((await httpErrorOf(service.versions(po.id))).getStatus()).toBe(403);
    }
  });

  it('follows a narrower grant: the list and the detail agree on which orders it reaches', async () => {
    const mine = await issued({ requester: U.acct });
    const theirs = await issued();
    as(U.acct, 'accountant');
    current.grants = new Map([
      ...grantsOf('accountant'),
      ['payables.bill.enter', 'own'],
      ['payables.bill.read', 'own'],
    ]);

    const page = await service.list(PAGE);
    expect(page.rows.map((p) => p.id)).toContain(mine.id);
    expect(page.rows.map((p) => p.id)).not.toContain(theirs.id);
    expect(page.total).toBe(page.rows.length);
    expect((await service.get(mine.id)).id).toBe(mine.id);
    expect((await httpErrorOf(service.get(theirs.id))).getStatus()).toBe(404);
    expect((await httpErrorOf(service.versions(theirs.id))).getStatus()).toBe(404);
  });

  it("links an amendment's approval to the order for an accountant approver, and still not for management (TR-Q2)", async () => {
    const po = await issued();
    const r = await service.amend(
      po.id,
      { reason, lines: [{ poLineId: po.lineId, unitPrice: '132743.36' }] },
      randomUUID(),
    );
    expect(r.outcome).toBe('pending_approval');
    as(U.acct, 'accountant');
    expect((await approvals.get(r.approvalRequestId!)).context?.href).toBe(
      `/procurement/orders/${po.id}`,
    );
    as(U.mgmt, 'management');
    expect((await approvals.get(r.approvalRequestId!)).context?.href).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------- approver read

describe('an approver opens the order they approve, read-only, the detail only (R4f Q1 b)', () => {
  /** `role`'s default grants without any grant that opens purchase orders. */
  const withoutPoGrants = (role: RoleKey) =>
    new Map(
      [...grantsOf(role)].filter(
        ([p]) => p !== PO_ISSUE_ACTION && !PO_READ_ONLY_ACTIONS.includes(p),
      ),
    );
  const statusOf = async (call: Promise<unknown>) => (await httpErrorOf(call)).getStatus();
  const reviewOf = async (poId: string) => {
    const [review] = await read((tx) =>
      tx
        .select({ id: approvalRequests.id })
        .from(approvalRequests)
        .where(
          sql`${approvalRequests.documentType} = ${EMERGENCY_REVIEW_DOCUMENT_TYPE}
              AND ${approvalRequests.documentId} = ${poId}`,
        ),
    );
    return review!.id;
  };
  /** An emergency order received in full, so its review waits for Management. */
  const reviewedPo = async () => {
    const po = await issued({ quantity: '5', unitPrice: '100.00', emergency: true });
    await receive(po, '5');
    return { po, reviewId: await reviewOf(po.id) };
  };

  it('opens an emergency review to Management while pending and once decided; nothing else opens', async () => {
    const { po, reviewId } = await reviewedPo();
    const other = await issued();
    as(U.mgmt, 'management');
    expect(grantsOf('management').has(PO_ISSUE_ACTION)).toBe(false);
    // Pending, in Management's inbox: the detail, with no action of the order's own.
    expect(await service.get(po.id)).toMatchObject({
      id: po.id,
      status: 'fully_received',
      can: { enterBill: false, receive: false },
    });
    // No broader procurement access: the list and the versions are still refused, another order is a 404.
    expect(await statusOf(service.list(PAGE))).toBe(403);
    expect(await statusOf(service.versions(po.id))).toBe(403);
    expect(await statusOf(service.get(other.id))).toBe(404);
    // Whoever submitted the review (the warehouse, here without its order grants) approves nothing: 404.
    as(U.wh, 'warehouse');
    current.grants = withoutPoGrants('warehouse');
    expect(await statusOf(service.get(po.id))).toBe(404);
    current.grants = null;

    await decide(U.mgmt, 'management', reviewId);
    as(U.mgmt, 'management');
    expect((await service.get(po.id)).id).toBe(po.id);
    expect(await statusOf(service.list(PAGE))).toBe(403);
    // The same order from another entity of the tenant, or from another tenant, is a 404.
    current.scope = scopeB;
    expect(await statusOf(service.get(po.id))).toBe(404);
    const otherTenant = await createTenantWithEntity(appPool);
    current.scope = { tenantId: otherTenant.tenantId, organizationId: otherTenant.organizationId };
    expect(await statusOf(service.get(po.id))).toBe(404);
  });

  it('opens an amendment to the approver of its active step, keeps it after a rejection, and not to later steps', async () => {
    const po = await issued();
    as(U.acct, 'accountant');
    current.grants = withoutPoGrants('accountant');
    expect(await statusOf(service.get(po.id))).toBe(404);

    as(U.proc, 'procurement');
    const r = await service.amend(
      po.id,
      { reason, lines: [{ poLineId: po.lineId, unitPrice: '132743.36' }] },
      randomUUID(),
    );
    expect(r.outcome).toBe('pending_approval');
    expect(await stepRoles(r.approvalRequestId!)).toEqual(['accountant', 'finance', 'management']);

    as(U.acct, 'accountant');
    current.grants = withoutPoGrants('accountant');
    expect(await service.get(po.id)).toMatchObject({
      id: po.id,
      status: 'amendment_pending',
      can: { enterBill: false, receive: false },
    });
    expect(await statusOf(service.list(PAGE))).toBe(403);
    // A bill grant that does not reach the order (own, and the requester is someone else) opens the detail through
    // the approval, and still not the list or the versions.
    current.grants = new Map([
      ...grantsOf('accountant'),
      ['payables.bill.enter', 'own'],
      ['payables.bill.read', 'own'],
    ]);
    expect(await service.get(po.id)).toMatchObject({
      id: po.id,
      can: { enterBill: false, receive: false },
    });
    const page = await service.list(PAGE);
    expect(page.rows.map((p) => p.id)).not.toContain(po.id);
    expect(page.total).toBe(page.rows.length);
    expect(await statusOf(service.versions(po.id))).toBe(404);
    // An amendment whose snapshot carries the order id in capitals opens the same way.
    await exec(
      scopeA,
      sql`UPDATE app.approval_requests
            SET snapshot = jsonb_set(snapshot, '{amendment,purchaseOrderId}', to_jsonb(upper(${po.id}::text)))
          WHERE id = ${r.approvalRequestId!}`,
    );
    expect(await service.get(po.id)).toMatchObject({ id: po.id });
    // Finance's step is not active yet: nothing opens.
    as(U.fin, 'finance');
    current.grants = withoutPoGrants('finance');
    expect(await statusOf(service.get(po.id))).toBe(404);

    current.grants = null;
    await decide(U.acct, 'accountant', r.approvalRequestId!, 'reject');
    as(U.acct, 'accountant');
    current.grants = withoutPoGrants('accountant');
    expect(await service.get(po.id)).toMatchObject({ id: po.id, status: 'issued' });
    // Management's step never became active.
    as(U.mgmt, 'management');
    current.grants = null;
    expect(await statusOf(service.get(po.id))).toBe(404);
  });

  it('opens it to a delegate acting for Management, and to Management once the delegate decided', async () => {
    const { po, reviewId } = await reviewedPo();
    const [{ idp_org_id: idpOrgId }] = (
      await exec(scopeA, sql`SELECT idp_org_id FROM app.users WHERE id = ${U.mgmt}`)
    ).rows as [{ idp_org_id: string }];
    const deputy = (
      await createStaffUser(appPool, { ...scopeA, idpOrgId, roleKeys: ['management'] })
    ).userId;
    as(U.founder, 'founder');
    await new ApprovalsAdminService(db, audit, caller, () => now).createDelegation({
      fromUserId: U.mgmt,
      toUserId: deputy,
      startsAt: new Date(now.getTime() - 3_600_000),
      endsAt: new Date(now.getTime() + 3_600_000),
      documentType: null,
    });

    // The deputy holds no role in the directory: only the delegation puts the review in their inbox.
    const link = `/procurement/orders/${po.id}`;
    as(deputy, 'management');
    expect((await service.get(po.id)).id).toBe(po.id);
    expect((await approvals.get(reviewId)).context?.href).toBe(link);
    await decide(deputy, 'management', reviewId);
    as(deputy, 'management');
    expect((await service.get(po.id)).id).toBe(po.id);
    expect((await approvals.get(reviewId)).context?.href).toBe(link);
    as(U.mgmt, 'management');
    expect((await service.get(po.id)).id).toBe(po.id);
    expect((await approvals.get(reviewId)).context?.href).toBe(link);
  });

  it("links the approval to the order for its approver with no order grant; not for its submitter, another approver or another order's approver", async () => {
    const hrefOf = async (requestId: string) => (await approvals.get(requestId)).context?.href;
    const { po, reviewId } = await reviewedPo();
    const link = `/procurement/orders/${po.id}`;
    const other = await issued();
    const amendment = (
      await service.amend(
        other.id,
        { reason, lines: [{ poLineId: other.lineId, unitPrice: '132743.36' }] },
        randomUUID(),
      )
    ).approvalRequestId!;
    const otherLink = `/procurement/orders/${other.id}`;

    // Management, the review's pending approver, holds no order grant: linked, and the link opens the detail.
    as(U.mgmt, 'management');
    expect(await hrefOf(reviewId)).toBe(link);
    expect((await service.get(po.id)).id).toBe(po.id);
    // The order's versions and receipt progress stay closed to it (the page hides them on these answers).
    expect(await statusOf(service.versions(po.id))).toBe(403);
    expect(await statusOf(receiptsService.progress(po.id))).toBe(403);
    // Its step on the amendment is not active yet: no link there, and that order is a 404.
    expect(await hrefOf(amendment)).toBeNull();
    expect(await statusOf(service.get(other.id))).toBe(404);

    // The accountant, active on the amendment with no order grant: linked to that order only.
    as(U.acct, 'accountant');
    current.grants = withoutPoGrants('accountant');
    expect(await hrefOf(amendment)).toBe(otherLink);
    expect((await service.get(other.id)).id).toBe(other.id);
    expect(await hrefOf(reviewId)).toBeNull();
    expect(await statusOf(service.get(po.id))).toBe(404);

    // Finance reads every request but holds no active step on either: no link, and both orders are a 404.
    as(U.fin, 'finance');
    current.grants = withoutPoGrants('finance');
    expect(await hrefOf(reviewId)).toBeNull();
    expect(await hrefOf(amendment)).toBeNull();
    expect(await statusOf(service.get(po.id))).toBe(404);
    expect(await statusOf(service.get(other.id))).toBe(404);

    // Whoever submitted the review (the warehouse, without its order grants) reads it, and gets no link.
    as(U.wh, 'warehouse');
    current.grants = withoutPoGrants('warehouse');
    expect(await hrefOf(reviewId)).toBeNull();
    expect(await statusOf(service.get(po.id))).toBe(404);

    // A decided step keeps the link: the accountant after rejecting the amendment, Management after its review.
    current.grants = null;
    await decide(U.acct, 'accountant', amendment, 'reject');
    as(U.acct, 'accountant');
    current.grants = withoutPoGrants('accountant');
    expect(await hrefOf(amendment)).toBe(otherLink);
    expect((await service.get(other.id)).id).toBe(other.id);
    current.grants = null;
    await decide(U.mgmt, 'management', reviewId);
    as(U.mgmt, 'management');
    expect(await hrefOf(reviewId)).toBe(link);
    expect((await service.get(po.id)).id).toBe(po.id);
  });
});

// ---------------------------------------------------------------------------------------- entity

describe('one legal entity at a time', () => {
  it("another entity's PO is a 404 for every route", async () => {
    const po = await draftPo({ scope: scopeB });
    expect((await httpErrorOf(service.get(po.id))).getStatus()).toBe(404);
    expect((await httpErrorOf(service.versions(po.id))).getStatus()).toBe(404);
    expect((await httpErrorOf(service.issue(po.id, randomUUID()))).getStatus()).toBe(404);
    expect(
      (
        await httpErrorOf(
          service.amend(
            po.id,
            { reason, lines: [{ poLineId: po.lineId, quantity: '2' }] },
            randomUUID(),
          ),
        )
      ).getStatus(),
    ).toBe(404);
    expect(
      (await httpErrorOf(service.cancel(po.id, { reason: 'x' }, randomUUID()))).getStatus(),
    ).toBe(404);
    expect((await service.list(PAGE)).rows.map((p) => p.id)).not.toContain(po.id);
  });
});

// ---------------------------------------------------------------------------------------- approval names

describe("names on an amendment's approval (U18 #3)", () => {
  it('shows Management the order number, the vendor and the amended line by name, and nothing else', async () => {
    const vendorId = await vendor('approved', { accountIn: [scopeA, scopeB] });
    const po = await issued({ vendorId });
    const r = await service.amend(
      po.id,
      { reason, lines: [{ poLineId: po.lineId, unitPrice: '132743.36' }] },
      randomUUID(),
    );
    const [stored] = await read((tx) =>
      tx.execute<{ number: string }>(
        sql`SELECT number FROM app.purchase_orders WHERE id = ${po.id}`,
      ),
    ).then((q) => q.rows);
    const vendorName = `Vendor ${vendorId.slice(0, 6)}`;

    // Management decides the last step; it holds no vendor.read and no procurement read.
    as(U.mgmt, 'management');
    expect(grantsOf('management').has('vendor.read')).toBe(false);
    const request = await approvals.get(r.approvalRequestId!);
    expect(request.snapshot).toMatchObject({
      purchaseOrderNumber: stored!.number,
      vendorPartyId: vendorId,
      vendorName,
    });
    expect(request.references).toEqual(
      expect.arrayContaining([
        { id: po.id, name: stored!.number },
        { id: vendorId, name: vendorName },
        { id: po.lineId, name: 'Line 1: Laptop' },
      ]),
    );
    expect(request.references).toHaveLength(3);
  });

  it("shows Management the order as it stands with its current PDF, no other order's PDF, and no link (U18 #2)", async () => {
    const vendorId = await vendor('approved', { accountIn: [scopeA, scopeB] });
    const po = await issued({ vendorId });
    // Another order of the same vendor: its PDF names the same vendor and must not appear on this approval.
    const other = await issued({ vendorId });
    const pdfOf = async (purchaseOrderId: string) => {
      const { rows } = await exec(
        scopeA,
        sql`WITH v AS (SELECT id FROM app.purchase_order_versions WHERE purchase_order_id = ${purchaseOrderId}
                       ORDER BY version DESC LIMIT 1),
                 d AS (INSERT INTO app.documents (tenant_id, organization_id, owner_type, owner_id)
                       SELECT ${scopeA.tenantId}, ${scopeA.organizationId}, 'purchase_order_version', v.id FROM v
                       RETURNING id)
            INSERT INTO app.document_versions (tenant_id, organization_id, document_id, version, filename,
              declared_mime, size_bytes, storage_key, status)
            SELECT ${scopeA.tenantId}, ${scopeA.organizationId}, d.id, 1, 'purchase-order.pdf', 'application/pdf',
                   2048, ${`${scopeA.tenantId}/${randomUUID()}`}, 'clean' FROM d
            RETURNING document_id`,
      );
      return (rows[0] as { document_id: string }).document_id;
    };
    const pdf = await pdfOf(po.id);
    const otherPdf = await pdfOf(other.id);
    const r = await service.amend(
      po.id,
      { reason, lines: [{ poLineId: po.lineId, unitPrice: '132743.36' }] },
      randomUUID(),
    );

    // Management decides the last step; it cannot open purchase orders, so the record is shown without a link.
    as(U.mgmt, 'management');
    expect(grantsOf('management').has('procurement.po.issue')).toBe(false);
    const { context } = await approvals.get(r.approvalRequestId!);
    expect(context).toMatchObject({
      href: null,
      documents: [{ documentId: pdf, filename: 'purchase-order.pdf' }],
    });
    expect(context!.documents).toHaveLength(1);
    expect(context!.documents.map((d) => d.documentId)).not.toContain(otherPdf);
    expect(context!.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: 'vendor', value: `Vendor ${vendorId.slice(0, 6)}` }),
        expect.objectContaining({ key: 'status', value: 'amendment_pending' }),
      ]),
    );
  });
});

// ---------------------------------------------------------------------------------------- render on commit (S3)

describe('render on commit (S3): each new version enqueues its render once it commits', () => {
  it('issue enqueues one purchase-order.render.one job for version 1, keyed by the order and version', async () => {
    const po = await draftPo();
    renderQueue.add.mockClear();
    await service.issue(po.id, randomUUID());
    expect(renderQueue.add).toHaveBeenCalledTimes(1);
    expect(renderQueue.add).toHaveBeenCalledWith(
      'purchase-order.render.one',
      { ...scopeA, id: po.id },
      {
        jobId: `purchase-order.render.one-${po.id}-v1`,
        removeOnComplete: true,
        removeOnFail: true,
      },
    );
  });

  it('an amendment applied at once enqueues version 2', async () => {
    const po = await issued();
    renderQueue.add.mockClear();
    await service.amend(
      po.id,
      { reason, lines: [{ poLineId: po.lineId, unitPrice: '71681.42' }] },
      randomUUID(),
    );
    expect(renderJobIds()).toEqual([`purchase-order.render.one-${po.id}-v2`]);
  });

  it('an amendment waiting for approval enqueues nothing until the last approval commits', async () => {
    const po = await issued();
    renderQueue.add.mockClear();
    const r = await service.amend(
      po.id,
      { reason, lines: [{ poLineId: po.lineId, unitPrice: '132743.36' }] },
      randomUUID(),
    );
    const requestId = r.approvalRequestId!;
    await decide(U.acct, 'accountant', requestId);
    await decide(U.fin, 'finance', requestId);
    expect(renderJobIds()).toEqual([]);
    await decide(U.mgmt, 'management', requestId);
    expect(renderJobIds()).toEqual([`purchase-order.render.one-${po.id}-v2`]);
  });

  it('a rejected amendment enqueues nothing', async () => {
    const po = await issued();
    renderQueue.add.mockClear();
    const r = await service.amend(
      po.id,
      { reason, lines: [{ poLineId: po.lineId, unitPrice: '132743.36' }] },
      randomUUID(),
    );
    expect(r.outcome).toBe('pending_approval');
    await decide(U.acct, 'accountant', r.approvalRequestId!, 'reject');
    expect(renderJobIds()).toEqual([]);
  });
});
