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
  runMigrations,
} from '@bos/db';
import { ForbiddenException, HttpException } from '@nestjs/common';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { asc, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
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
import { ApprovalsService } from '../../approvals/requests.service';
import { ReceiptsService } from '../receipts/receipts.service';
import { quotationLineAmounts } from '../sourcing/sourcing.rules';
import { PoAmendmentSubject } from './po-amendment.subject';
import { PO_AMENDMENT_DOCUMENT_TYPE, PO_AMENDMENT_WORKFLOW_SPEC } from './purchase-order.rules';
import { PurchaseOrdersService } from './purchase-orders.service';

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
  await admin.createWorkflow({
    key: PO_AMENDMENT_DOCUMENT_TYPE,
    name: 'Purchase order amendment',
    spec: PO_AMENDMENT_WORKFLOW_SPEC,
  });
  await admin.publish(PO_AMENDMENT_DOCUMENT_TYPE, 1);

  approvals = new ApprovalsService(db, audit, notify, directory, caller, () => now);
  approvals.registerSubject(new PoAmendmentSubject(audit, () => now));
  service = new PurchaseOrdersService(db, approvals, audit, caller, () => now);
  receiptsService = new ReceiptsService(
    db,
    authz as unknown as AuthzService,
    audit,
    new NumberingService(),
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
  opts: { vendorId?: string; scope?: TxScope; quantity?: string; unitPrice?: string } = {},
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
                ${scope === scopeA ? deptA : deptB}, ${U.req}, ${(await createCostCenter(appPool, scope)).costCenterId}, 'Laptops', '2026-12-01',
                'IT-2083', 'NPR')`,
  );
  await exec(
    scope,
    sql`UPDATE app.purchase_requests SET status = 'approved', fx_rate = 1, estimated_total = ${a.lineTotal},
          estimated_total_npr = ${a.lineTotal}, number = ${`PR-T-${prId.slice(0, 8)}`} WHERE id = ${prId}`,
  );
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
});

// ---------------------------------------------------------------------------------------- amend (AD7)

describe('amend (done check 2)', () => {
  it('90,000 -> 99,000 issues v2 at once, with no approval and an audit row', async () => {
    const po = await issued();
    const r = await service.amend(
      po.id,
      { reason, lines: [{ poLineId: po.lineId, unitPrice: '87610.62' }] },
      randomUUID(),
    );
    expect(r.outcome).toBe('applied');
    expect(r.approvalRequestId).toBeNull();
    expect(r.purchaseOrder).toMatchObject({
      status: 'issued',
      currentVersion: 2,
      approvedBand: 'base',
    });
    expect(r.purchaseOrder.lines[0]).toMatchObject({ id: po.lineId, lineTotal: '99000.00' });
    const versions = await service.versions(po.id);
    expect(versions.map((v) => [v.version, v.total, v.band, v.approvalRequestId])).toEqual([
      [1, '90000.00', 'base', null],
      [2, '99000.00', 'base', null],
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
});

// ---------------------------------------------------------------------------------------- vendor name

describe('vendor name on reads', () => {
  it('carries the vendor legal name on every list row and on get, in the entity and out of it', async () => {
    const vendorId = await vendor('approved', { accountIn: [scopeA, scopeB] });
    const name = `Vendor ${vendorId.slice(0, 6)}`;
    const inA = await draftPo({ vendorId });
    const inB = await draftPo({ vendorId, scope: scopeB });

    const rowsA = await service.list();
    expect(rowsA.find((p) => p.id === inA.id)).toMatchObject({ vendorId, vendorName: name });
    expect(await service.get(inA.id)).toMatchObject({ vendorId, vendorName: name });
    expect(rowsA.every((p) => typeof p.vendorName === 'string' && p.vendorName !== '')).toBe(true);
    // The status filter keeps the join.
    expect((await service.list('draft')).find((p) => p.id === inA.id)?.vendorName).toBe(name);

    // Vendors are tenant level: entity B sees the same name on its own PO, and never entity A's PO.
    current.scope = scopeB;
    const rowsB = await service.list();
    expect(rowsB.find((p) => p.id === inB.id)?.vendorName).toBe(name);
    expect(rowsB.map((p) => p.id)).not.toContain(inA.id);
    expect((await service.get(inB.id)).vendorName).toBe(name);
  });

  it('keeps the list rows free of lines', async () => {
    const po = await draftPo();
    const row = (await service.list()).find((p) => p.id === po.id);
    expect(row).toBeDefined();
    expect(row).not.toHaveProperty('lines');
    expect(row).toHaveProperty('vendorName');
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
    expect((await service.list()).map((p) => p.id)).not.toContain(po.id);
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
});
