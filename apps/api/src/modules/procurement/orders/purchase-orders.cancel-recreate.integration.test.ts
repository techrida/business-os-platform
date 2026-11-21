// Integration tests of cancel-and-recreate of an issued purchase order on a real Postgres (Testcontainers, needs
// Docker in WSL). Same setup as purchase-orders.change-vendor.integration.test.ts: P2's SourcingService and
// PrCommitmentSubject write a real commitment draft (linked to its RFQ and quotation, so the one-live-PO-per-quotation
// index is in play), PurchaseOrdersService issues it and then cancels it and raises the new draft in one transaction.
// Orders that only need to be refused are inserted directly with one line. A draft receipt comes from the real
// ReceiptsService.
// Real: migrations as bos_owner, queries as bos_app (so the version trigger, the purchase_orders CHECKs and the
// partial unique index run), PurchaseOrdersService, ReceiptsService, ApprovalsService, AuditService, NumberingService.
// Faked: notify, the role directory, the request context (a fake principal) and authz.assert (the real can()).
// Run: pnpm --filter @bos/api exec vitest run src/modules/procurement/orders/purchase-orders.cancel-recreate.integration.test.ts
import 'reflect-metadata';

import { randomUUID } from 'node:crypto';

import {
  DEFAULT_ROLE_PERMISSIONS,
  ErrorBodySchema,
  type Permission,
  type RoleKey,
  type Scope,
} from '@bos/contracts';
import {
  approvalRequests,
  createCostCenter,
  createDepartment,
  createParty,
  createStaffUser,
  createTenantWithEntity,
  purchaseOrderLines,
  purchaseOrders,
  purchaseRequests,
} from '@bos/db';
import { ForbiddenException, HttpException, type ArgumentsHost } from '@nestjs/common';
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
import { MoneyService } from '../../../platform/settings/money.service';
import { NumberingService } from '../../../platform/settings/numbering.service';
import { ErrorBodyFilter } from '../../../platform/tenancy/error-body.filter';
import { ApprovalsAdminService } from '../../approvals/admin.service';
import { asSecondPerson, SKIP_LIVE_PUBLISHER_CHECK } from '../../../../test/support/second-person';
import { ApprovalsService } from '../../approvals/requests.service';
import { evidenceFixture, type EvidenceFixture } from '../../evidence/evidence.fixture';
import { ReceiptsService } from '../receipts/receipts.service';
import { PrCommitmentSubject } from '../sourcing/pr-commitment.subject';
import {
  PR_COMMITMENT_DOCUMENT_TYPE,
  PR_COMMITMENT_WORKFLOW_SPEC,
  quotationLineAmounts,
} from '../sourcing/sourcing.rules';
import { SourcingService } from '../sourcing/sourcing.service';
import { PoAmendmentSubject } from './po-amendment.subject';
import { PO_AMENDMENT_DOCUMENT_TYPE, PO_AMENDMENT_WORKFLOW_SPEC } from './purchase-order.rules';
import { PurchaseOrdersService, type PurchaseOrderLineDto } from './purchase-orders.service';
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
let sourcing: SourcingService;
let receiptsService: ReceiptsService;
let deptA = '';
let deptB = '';
let vatCode = '';
/** Quotation files uploaded through the RFQ's evidence route. */
let evidence: EvidenceFixture;

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

const exec = (scope: TxScope, q: ReturnType<typeof sql>) =>
  withTx(db, scope, systemActor('test'), (tx) => tx.execute(q));
const read = <T>(fn: (tx: DbTransaction) => Promise<T>) =>
  withTx(db, scopeA, systemActor('test'), fn);

beforeAll(async () => {
  testDb = await createTestDatabase();
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

  const vat = await exec(
    scopeA,
    sql`INSERT INTO app.tax_codes (tenant_id, code, name, kind, rate_bp, creditable, effective_from)
        VALUES (${scopeA.tenantId}, 'VAT13', 'VAT 13%', 'vat', 1300, true, '2020-01-01') RETURNING id`,
  );
  vatCode = (vat.rows[0] as { id: string }).id;

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
  receiptsService = new ReceiptsService(
    db,
    authz as unknown as AuthzService,
    audit,
    numbering,
    caller,
    () => now,
    approvals,
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
const messageOf = (e: HttpException) => (e.getResponse() as { message?: string }).message;
/** The error body the global ErrorBodyFilter sends for `e` (fake Express objects, as error-body.filter.test.ts). */
function wireBody(e: HttpException) {
  const out: { status?: number; body?: unknown } = {};
  const req = { method: 'POST', path: '/v1/purchase-orders/x/cancel', headers: {} };
  const res = {
    headersSent: false,
    setHeader: () => undefined,
    status(code: number) {
      out.status = code;
      return this;
    },
    json(body: unknown) {
      out.body = body;
    },
  };
  const host = {
    getType: () => 'http',
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
  } as unknown as ArgumentsHost;
  new ErrorBodyFilter().catch(e, host);
  return { status: out.status, ...ErrorBodySchema.parse(out.body).error };
}

/** A clean kernel document, the call-back evidence an active bank account or vendor bill needs. */
async function evidenceDoc(scope: TxScope = scopeA): Promise<string> {
  const { rows } = await exec(
    scope,
    sql`INSERT INTO app.documents (tenant_id, organization_id, owner_type, owner_id)
        VALUES (${scope.tenantId}, ${scope.organizationId}, 'vendor_bill_intake', ${randomUUID()})
        RETURNING id`,
  );
  const documentId = (rows[0] as { id: string }).id;
  await exec(
    scope,
    sql`INSERT INTO app.document_versions (tenant_id, organization_id, document_id, version, filename,
          declared_mime, size_bytes, storage_key, status)
        VALUES (${scope.tenantId}, ${scope.organizationId}, ${documentId}, 1, 'callback.pdf',
                'application/pdf', 1024, ${`${scope.tenantId}/${randomUUID()}`}, 'clean')`,
  );
  return documentId;
}

let panSeq = 0;
/** An approved vendor of tenant A with an active account in each of `accountIn` (entity A by default) and a verified bank account. */
async function vendor(opts: { accountIn?: TxScope[] } = {}): Promise<string> {
  const { partyId } = await createParty(appPool, {
    tenantId: scopeA.tenantId,
    kind: 'vendor',
    organizationId: scopeA.organizationId,
  });
  await exec(
    scopeA,
    sql`INSERT INTO app.vendors (id, tenant_id, legal_name, pan, status, created_by, approved_by)
        VALUES (${partyId}, ${scopeA.tenantId}, ${`Vendor ${partyId.slice(0, 6)}`},
                ${String(410_000_000 + (panSeq += 1))}, 'approved', ${U.proc}, ${U.mgmt})`,
  );
  for (const s of opts.accountIn ?? [scopeA]) {
    await exec(
      s,
      sql`INSERT INTO app.vendor_accounts (tenant_id, organization_id, vendor_id, active)
          VALUES (${s.tenantId}, ${s.organizationId}, ${partyId}, true)`,
    );
  }
  const doc = await evidenceDoc();
  await exec(
    scopeA,
    sql`INSERT INTO app.vendor_bank_accounts (tenant_id, vendor_id, bank_name, account_name,
          account_number_enc, account_fingerprint, last4, status, proposed_by, proposed_via, verified_by,
          callback_evidence_document_id)
        VALUES (${scopeA.tenantId}, ${partyId}, 'Nabil Bank', 'Vendor Pvt Ltd', decode('00', 'hex'),
                ${`fp-${randomUUID()}`}, '1234', 'active', ${U.proc}, 'staff', ${U.fin}, ${doc})`,
  );
  return partyId;
}

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

/**
 * The draft P2 writes for an approved commitment (2 laptops quoted at 39,000.00 + 13% VAT by `vendorId`, 88,140.00
 * incl. VAT, band base, linked to its RFQ and quotation), issued: the issue copies the quotation's line.
 */
async function issuedCommitmentPo(vendorId: string) {
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
  const rfq = await sourcing.createRfq(
    { purchaseRequestId: prId, deadline: '2026-11-20T10:00:00+05:45', vendorIds: [vendorId] },
    randomUUID(),
  );
  const documentId = await evidence.upload('rfq', rfq.id);
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
  const issued = await service.issue(draft!.id, randomUUID());
  return { po: issued, quote, rfqId: rfq.id, prId, prLineId };
}

let poSeq = 0;
/** A draft PO inserted directly (number taken, version 0) with one line of 1 x 79,646.02 + 13% VAT. */
async function plainDraft(
  vendorId: string,
  scope: TxScope = scopeA,
): Promise<{ id: string; prId: string }> {
  const a = quotationLineAmounts('1', '79646.02', 1300);
  const prId = randomUUID();
  await exec(
    scope,
    sql`INSERT INTO app.purchase_requests (id, tenant_id, organization_id, request_type, department_id,
          requester_user_id, cost_center_id, justification, required_by, budget_code, currency)
        VALUES (${prId}, ${scope.tenantId}, ${scope.organizationId}, 'goods', ${scope === scopeA ? deptA : deptB}, ${U.req},
                ${(await createCostCenter(appPool, scope)).costCenterId}, 'Laptops', '2026-12-01', 'IT-2083', 'NPR')`,
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
        VALUES (${id}, ${scope.tenantId}, ${scope.organizationId}, ${`PO-CR-${poSeq}`}, ${900 + poSeq},
                '2082/83', ${prId}, ${vendorId}, 'NPR', 30, ${a.lineTotal}, 1, ${a.lineTotal}, 'base', ${U.proc})`,
  );
  await exec(
    scope,
    sql`INSERT INTO app.purchase_order_lines (id, tenant_id, organization_id, purchase_order_id,
          purchase_request_id, line_no, kind, description, uom, ordered_quantity, unit_price, tax_code_id, gross,
          tax_amount, line_total)
        VALUES (${randomUUID()}, ${scope.tenantId}, ${scope.organizationId}, ${id}, ${prId}, 1, 'goods',
                'Laptop', 'pcs', 1, 79646.02, ${vatCode}, ${a.gross}, ${a.taxAmount}, ${a.lineTotal})`,
  );
  return { id, prId };
}

const poRow = async (id: string) =>
  (await read((tx) => tx.select().from(purchaseOrders).where(eq(purchaseOrders.id, id))))[0]!;
const posOfRequest = (prId: string) =>
  read((tx) =>
    tx
      .select()
      .from(purchaseOrders)
      .where(eq(purchaseOrders.purchaseRequestId, prId))
      .orderBy(asc(purchaseOrders.createdAt), asc(purchaseOrders.number)),
  );
const linesOfPo = (id: string) =>
  read((tx) =>
    tx
      .select()
      .from(purchaseOrderLines)
      .where(eq(purchaseOrderLines.purchaseOrderId, id))
      .orderBy(asc(purchaseOrderLines.lineNo)),
  );
const requestStatus = async (prId: string) =>
  (
    await read((tx) =>
      tx
        .select({ status: purchaseRequests.status })
        .from(purchaseRequests)
        .where(eq(purchaseRequests.id, prId)),
    )
  )[0]!.status;
const auditRows = async (id: string, action: string) =>
  (
    await ownerPool.query<{ actor_id: string; before: unknown; after: unknown }>(
      `SELECT actor_id, before, after FROM audit.audit_events
        WHERE tenant_id = $1 AND entity_type = 'purchase_orders' AND entity_id = $2 AND action = $3`,
      [scopeA.tenantId, id, action],
    )
  ).rows;

/** A draft receipt of `quantity` on the order's first line, by the warehouse. */
async function draftReceipt(poId: string, quantity: string) {
  const [line] = await linesOfPo(poId);
  as(U.wh, 'warehouse');
  try {
    await receiptsService.create(
      {
        purchaseOrderId: poId,
        kind: 'goods',
        receivedAt: '2026-11-09',
        lines: [{ poLineId: line!.id, quantity }],
      },
      randomUUID(),
    );
  } finally {
    as(U.proc, 'procurement');
  }
}

let billSeq = 0;
/** Inserts a vendor bill directly via SQL against `poId` (of `vendorId` in `scope`). */
async function insertVendorBill(opts: {
  poId: string;
  vendorId: string;
  number?: string | null;
  status?: 'draft' | 'approved' | 'voided';
  scope?: TxScope;
}): Promise<string> {
  const scope = opts.scope ?? scopeA;
  const status = opts.status ?? 'draft';
  const docId = await evidenceDoc(scope);
  const id = randomUUID();
  billSeq += 1;
  const number =
    opts.number === undefined ? `BILL-2082/83-${String(billSeq).padStart(4, '0')}` : opts.number;
  const voidedBy = status === 'voided' ? U.acct : null;
  const voidedAt = status === 'voided' ? now.toISOString() : null;
  const voidReason = status === 'voided' ? 'Voided in test' : null;
  await exec(
    scope,
    sql`INSERT INTO app.vendor_bills (id, tenant_id, organization_id, number, vendor_id, vendor_invoice_no,
          invoice_date, fiscal_year, currency, purchase_order_id, document_id, status,
          net_total, vat_total, tds_total, payable_total, fx_rate, payable_total_npr, entered_by,
          voided_by, voided_at, void_reason)
        VALUES (${id}, ${scope.tenantId}, ${scope.organizationId}, ${number}, ${opts.vendorId},
                ${`INV-CR-${billSeq}`}, '2026-11-09', '2082/83', 'NPR', ${opts.poId}, ${docId}, ${status},
                1000.00, 130.00, 0.00, 1130.00, 1, 1130.00, ${U.acct},
                ${voidedBy}, ${voidedAt}, ${voidReason})`,
  );
  return id;
}

/** Voids a vendor bill with the columns required by `vendor_bills_voided_check`. */
async function voidVendorBill(billId: string, scope: TxScope = scopeA): Promise<void> {
  await exec(
    scope,
    sql`UPDATE app.vendor_bills
        SET status = 'voided',
            voided_by = ${U.acct},
            voided_at = ${now.toISOString()},
            void_reason = 'Entered in error'
        WHERE id = ${billId}`,
  );
}

const strip = ({ id: _id, cancelledQuantity: _c, ...l }: PurchaseOrderLineDto) => l;

// ---------------------------------------------------------------------------------------- tests

describe('cancelAndRecreate', () => {
  it('cancels the issued order and raises a draft clone with a new number, in one transaction', async () => {
    const vendorId = await vendor();
    const { po, quote, rfqId, prId, prLineId } = await issuedCommitmentPo(vendorId);
    expect(po).toMatchObject({ status: 'issued', rfqId, vendorQuotationId: quote.id });
    expect(await requestStatus(prId)).toBe('po_issued');

    const dto = await service.cancelAndRecreate(
      po.id,
      { reason: 'Wrong delivery site' },
      randomUUID(),
    );

    // The old order: cancelled with the reason, every line cancelled in full.
    const old = await poRow(po.id);
    expect(old).toMatchObject({ status: 'cancelled', closedReason: 'Wrong delivery site' });
    const oldLines = await linesOfPo(po.id);
    expect(oldLines.map((l) => l.cancelledQuantity)).toEqual(
      oldLines.map((l) => l.orderedQuantity),
    );

    // The new order: a draft with a new number from the PO series and everything else as the old one.
    expect(dto.id).not.toBe(po.id);
    expect(dto.number).not.toBe(po.number);
    expect(dto.number).toMatch(/^PO-/);
    expect(dto).toMatchObject({
      status: 'draft',
      currentVersion: 0,
      issuedAt: null,
      closedReason: null,
      purchaseRequestId: prId,
      rfqId,
      vendorQuotationId: quote.id,
      vendorId,
      currency: po.currency,
      paymentTermsDays: po.paymentTermsDays,
      advancePercent: po.advancePercent,
      approvedTotal: po.approvedTotal,
      fxRate: po.fxRate,
      approvedTotalNpr: po.approvedTotalNpr,
      approvedBand: po.approvedBand,
    });
    const row = await poRow(dto.id);
    expect(row).toMatchObject({ createdBy: U.proc, fxSource: old.fxSource, fxDate: old.fxDate });
    expect(row.numberSeq).not.toBe(old.numberSeq);
    // Its lines: the same lines in the same order, with the ordered quantity and nothing cancelled.
    expect(dto.lines.map(strip)).toEqual(po.lines.map(strip));
    expect(dto.lines[0]).toMatchObject({
      prLineId,
      orderedQuantity: '2.0000',
      cancelledQuantity: '0.0000',
      unitPrice: '39000.00',
      lineTotal: '88140.00',
    });
    expect(dto.lines.map((l) => l.id)).not.toContain(po.lines[0]!.id);
    expect((await service.get(dto.id)).lines).toEqual(dto.lines);

    // Both audit rows (that they commit or roll back together is the next test).
    const [cancelled] = await auditRows(po.id, 'procurement.po.cancelled');
    const [recreated] = await auditRows(dto.id, 'procurement.po.recreated');
    expect(cancelled).toMatchObject({
      actor_id: U.proc,
      before: { status: 'issued' },
      after: { status: 'cancelled', reason: 'Wrong delivery site' },
    });
    expect(recreated).toMatchObject({
      actor_id: U.proc,
      before: { from: po.id, number: po.number },
      after: { status: 'draft', number: dto.number, lines: 1 },
    });
    // The request stays where the first issue put it.
    expect(await requestStatus(prId)).toBe('po_issued');
  });

  it('rolls back the cancel when the new draft cannot be written', async () => {
    const { id, prId } = await plainDraft(await vendor());
    await service.issue(id, randomUUID());
    const failingNumbering = {
      issue: () => Promise.reject(new Error('numbering unavailable')),
    } as unknown as NumberingService;
    const failing = new PurchaseOrdersService(
      db,
      approvals,
      audit,
      caller,
      () => now,
      undefined,
      undefined,
      failingNumbering,
    );
    await expect(failing.cancelAndRecreate(id, { reason: 'x' }, randomUUID())).rejects.toThrow(
      'numbering unavailable',
    );
    expect((await poRow(id)).status).toBe('issued');
    expect((await linesOfPo(id)).map((l) => Number(l.cancelledQuantity))).toEqual([0]);
    expect(await auditRows(id, 'procurement.po.cancelled')).toEqual([]);
    expect(await posOfRequest(prId)).toHaveLength(1);
  });

  it('refuses an order with a receipt (PO_HAS_RECEIPTS): the original stays issued, no new order', async () => {
    const { id, prId } = await plainDraft(await vendor());
    await service.issue(id, randomUUID());
    await draftReceipt(id, '1');
    const refused = await httpErrorOf(service.cancelAndRecreate(id, { reason: 'x' }, randomUUID()));
    expect(refused.getStatus()).toBe(409);
    expect(codeOf(refused)).toBe('PO_HAS_RECEIPTS');
    expect((await poRow(id)).status).toBe('issued');
    expect(await posOfRequest(prId)).toHaveLength(1);
  });

  it.each(['draft', 'cancelled'] as const)('refuses a %s order with 409', async (status) => {
    const { id, prId } = await plainDraft(await vendor());
    if (status === 'cancelled') {
      await service.issue(id, randomUUID());
      await service.cancel(id, { reason: 'Dropped' }, randomUUID());
    }
    const before = await poRow(id);
    const refused = await httpErrorOf(service.cancelAndRecreate(id, { reason: 'x' }, randomUUID()));
    expect(refused.getStatus()).toBe(409);
    expect(await poRow(id)).toEqual(before);
    expect(await posOfRequest(prId)).toHaveLength(1);
  });

  it('replays with the same key: the same new draft, created once', async () => {
    const { po, prId } = await issuedCommitmentPo(await vendor());
    const key = randomUUID();
    const first = await service.cancelAndRecreate(po.id, { reason: 'Re-raise' }, key);
    const replay = await service.cancelAndRecreate(po.id, { reason: 'Re-raise' }, key);
    expect(replay).toEqual(first);
    const orders = await posOfRequest(prId);
    expect(orders.map((o) => o.status).sort()).toEqual(['cancelled', 'draft']);
    expect(await auditRows(first.id, 'procurement.po.recreated')).toHaveLength(1);
    expect(await auditRows(po.id, 'procurement.po.cancelled')).toHaveLength(1);
  });

  it('issues the clone: version 1 with the old order total, the request stays po_issued', async () => {
    const { po, quote, prId } = await issuedCommitmentPo(await vendor());
    const draft = await service.cancelAndRecreate(po.id, { reason: 'Re-raise' }, randomUUID());
    const issued = await service.issue(draft.id, randomUUID());
    expect(issued).toMatchObject({ status: 'issued', currentVersion: 1, number: draft.number });
    expect(issued.lines.map(strip)).toEqual(draft.lines.map(strip));
    const [v1] = await service.versions(draft.id);
    expect(v1).toMatchObject({
      version: 1,
      total: quote.total,
      totalNpr: quote.totalNpr,
      band: 'base',
    });
    expect(await requestStatus(prId)).toBe('po_issued');
    // The clone is now the live order of the quotation: a second recreate of the cancelled one is refused.
    const again = await httpErrorOf(
      service.cancelAndRecreate(po.id, { reason: 'x' }, randomUUID()),
    );
    expect(again.getStatus()).toBe(409);
  });

  it('lets the clone change vendor while it is a draft', async () => {
    const { po } = await issuedCommitmentPo(await vendor());
    const draft = await service.cancelAndRecreate(po.id, { reason: 'Vendor failed' }, randomUUID());
    const other = await vendor();
    const moved = await service.changeVendor(draft.id, { vendorId: other }, randomUUID());
    expect(moved).toMatchObject({
      status: 'draft',
      vendorId: other,
      rfqId: null,
      vendorQuotationId: null,
      approvedTotal: draft.approvedTotal,
      number: draft.number,
    });
    expect(moved.lines).toEqual(draft.lines);
    const issued = await service.issue(draft.id, randomUUID());
    expect(issued).toMatchObject({ status: 'issued', vendorId: other });
  });
});

describe('live vendor bills block cancel and cancelAndRecreate (K3 Q3)', () => {
  it('refuses service.cancel with 409 PO_HAS_BILLS naming the bill, leaving the PO issued and unaudited', async () => {
    const vendorId = await vendor();
    const { id, prId } = await plainDraft(vendorId);
    await service.issue(id, randomUUID());
    await insertVendorBill({ poId: id, vendorId, number: 'BILL-2082/83-0101', status: 'approved' });

    const refused = await httpErrorOf(
      service.cancel(id, { reason: 'Wrong order' }, randomUUID()),
    );
    expect(refused.getStatus()).toBe(409);
    expect(codeOf(refused)).toBe('PO_HAS_BILLS');
    expect(messageOf(refused)).toContain('BILL-2082/83-0101');
    expect(wireBody(refused)).toMatchObject({
      status: 409,
      code: 'PO_HAS_BILLS',
      message: messageOf(refused),
    });
    expect((await poRow(id)).status).toBe('issued');
    expect((await linesOfPo(id)).map((l) => Number(l.cancelledQuantity))).toEqual([0]);
    expect(await posOfRequest(prId)).toHaveLength(1);
    expect(await auditRows(id, 'procurement.po.cancelled')).toEqual([]);
  });

  it('refuses service.cancelAndRecreate with 409 PO_HAS_BILLS atomically: original untouched, no new draft', async () => {
    const vendorId = await vendor();
    const { id, prId } = await plainDraft(vendorId);
    await service.issue(id, randomUUID());
    const before = await poRow(id);
    await insertVendorBill({ poId: id, vendorId, number: 'BILL-2082/83-0202', status: 'draft' });
    await insertVendorBill({ poId: id, vendorId, number: null, status: 'draft' });

    const refused = await httpErrorOf(
      service.cancelAndRecreate(id, { reason: 'Wrong vendor' }, randomUUID()),
    );
    expect(refused.getStatus()).toBe(409);
    expect(codeOf(refused)).toBe('PO_HAS_BILLS');
    expect(messageOf(refused)).toContain('BILL-2082/83-0202');
    expect(messageOf(refused)).toContain('an unnumbered draft bill');
    expect(await poRow(id)).toEqual(before);
    expect((await linesOfPo(id)).map((l) => Number(l.cancelledQuantity))).toEqual([0]);
    expect(await posOfRequest(prId)).toHaveLength(1);
    expect(await auditRows(id, 'procurement.po.cancelled')).toEqual([]);
  });

  it('allows both cancel and cancelAndRecreate once the referring bill is voided', async () => {
    const vendorId = await vendor();

    const po1 = await plainDraft(vendorId);
    await service.issue(po1.id, randomUUID());
    const bill1 = await insertVendorBill({
      poId: po1.id,
      vendorId,
      number: 'BILL-2082/83-0301',
      status: 'approved',
    });
    expect(
      codeOf(await httpErrorOf(service.cancel(po1.id, { reason: 'Try early' }, randomUUID()))),
    ).toBe('PO_HAS_BILLS');
    await voidVendorBill(bill1);
    const cancelled = await service.cancel(po1.id, { reason: 'Voided first' }, randomUUID());
    expect(cancelled).toMatchObject({ status: 'cancelled', closedReason: 'Voided first' });
    expect(await auditRows(po1.id, 'procurement.po.cancelled')).toHaveLength(1);

    const po2 = await plainDraft(vendorId);
    await service.issue(po2.id, randomUUID());
    const bill2 = await insertVendorBill({
      poId: po2.id,
      vendorId,
      number: 'BILL-2082/83-0302',
      status: 'draft',
    });
    expect(
      codeOf(
        await httpErrorOf(
          service.cancelAndRecreate(po2.id, { reason: 'Try early' }, randomUUID()),
        ),
      ),
    ).toBe('PO_HAS_BILLS');
    await voidVendorBill(bill2);
    const draft = await service.cancelAndRecreate(
      po2.id,
      { reason: 'Re-raise after void' },
      randomUUID(),
    );
    expect(draft.id).not.toBe(po2.id);
    expect(draft.status).toBe('draft');
    expect((await poRow(po2.id)).status).toBe('cancelled');
    expect(await posOfRequest(po2.prId)).toHaveLength(2);
    expect(await auditRows(draft.id, 'procurement.po.recreated')).toHaveLength(1);
  });

  it('does not block cancelling or recreating a PO when another PO of the same vendor has a live bill', async () => {
    const vendorId = await vendor();
    const poBilled = await plainDraft(vendorId);
    const poForCancel = await plainDraft(vendorId);
    const poForRecreate = await plainDraft(vendorId);
    await service.issue(poBilled.id, randomUUID());
    await service.issue(poForCancel.id, randomUUID());
    await service.issue(poForRecreate.id, randomUUID());
    await insertVendorBill({
      poId: poBilled.id,
      vendorId,
      number: 'BILL-2082/83-0401',
      status: 'approved',
    });

    const cancelled = await service.cancel(
      poForCancel.id,
      { reason: 'Other PO has the bill' },
      randomUUID(),
    );
    expect(cancelled.status).toBe('cancelled');

    const draft = await service.cancelAndRecreate(
      poForRecreate.id,
      { reason: 'Re-raise unaffected PO' },
      randomUUID(),
    );
    expect(draft.status).toBe('draft');
    expect((await poRow(poForRecreate.id)).status).toBe('cancelled');

    const blocked = await httpErrorOf(
      service.cancel(poBilled.id, { reason: 'Billed PO still blocked' }, randomUUID()),
    );
    expect(blocked.getStatus()).toBe(409);
    expect(codeOf(blocked)).toBe('PO_HAS_BILLS');
  });

  it('ignores bills on another entity PO and answers 404 for another entity PO', async () => {
    const vendorId = await vendor({ accountIn: [scopeA, scopeB] });
    const poB = await plainDraft(vendorId, scopeB);
    current.scope = scopeB;
    try {
      await service.issue(poB.id, randomUUID());
    } finally {
      current.scope = null;
    }
    await insertVendorBill({
      poId: poB.id,
      vendorId,
      number: 'BILL-2082/83-0501',
      status: 'approved',
      scope: scopeB,
    });

    const poA = await plainDraft(vendorId, scopeA);
    await service.issue(poA.id, randomUUID());

    // Entity A cannot reach entity B's PO (404, never leaks PO_HAS_BILLS).
    expect(
      (await httpErrorOf(service.cancel(poB.id, { reason: 'cross-entity' }, randomUUID()))).getStatus(),
    ).toBe(404);
    expect(
      (
        await httpErrorOf(
          service.cancelAndRecreate(poB.id, { reason: 'cross-entity' }, randomUUID()),
        )
      ).getStatus(),
    ).toBe(404);

    // The live bill in entity B does not block entity A's own PO for the same vendor.
    const cancelledA = await service.cancel(
      poA.id,
      { reason: 'Other entity bill is irrelevant' },
      randomUUID(),
    );
    expect(cancelledA.status).toBe('cancelled');
  });

  it('checks PO_HAS_RECEIPTS before PO_HAS_BILLS when both a receipt and a live bill exist', async () => {
    const vendorId = await vendor();
    const { id, prId } = await plainDraft(vendorId);
    await service.issue(id, randomUUID());
    await draftReceipt(id, '1');
    await insertVendorBill({ poId: id, vendorId, number: 'BILL-2082/83-0601', status: 'draft' });

    const cancelErr = await httpErrorOf(service.cancel(id, { reason: 'x' }, randomUUID()));
    expect(cancelErr.getStatus()).toBe(409);
    expect(codeOf(cancelErr)).toBe('PO_HAS_RECEIPTS');

    const recreateErr = await httpErrorOf(
      service.cancelAndRecreate(id, { reason: 'x' }, randomUUID()),
    );
    expect(recreateErr.getStatus()).toBe(409);
    expect(codeOf(recreateErr)).toBe('PO_HAS_RECEIPTS');
    expect((await poRow(id)).status).toBe('issued');
    expect(await posOfRequest(prId)).toHaveLength(1);
  });
});

