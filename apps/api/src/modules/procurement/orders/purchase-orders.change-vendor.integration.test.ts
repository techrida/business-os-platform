// Integration tests of changing the vendor of a draft purchase order (F1-Q40 a; R4f Q2a) on a real Postgres
// (Testcontainers, needs Docker in WSL). Same setup as purchase-orders.from-commitment.integration.test.ts: P2's
// SourcingService and PrCommitmentSubject write a real commitment draft (header only, linked to its RFQ and
// quotation), and PurchaseOrdersService.changeVendor moves it to another vendor before issue. Drafts that only need
// to be refused are inserted directly with one line, as purchase-orders.integration.test.ts does.
// Real: migrations as bos_owner, queries as bos_app (so the version trigger, the purchase_orders CHECKs and the
// vendor_bank_accounts CHECKs run), PurchaseOrdersService, ApprovalsService, AuditService. Faked: notify, the role
// directory, the request context (a fake principal).
// Run: pnpm --filter @bos/api exec vitest run src/modules/procurement/orders/purchase-orders.change-vendor.integration.test.ts
import 'reflect-metadata';

import { randomUUID } from 'node:crypto';

import {
  DEFAULT_ROLE_PERMISSIONS,
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
} from '@bos/db';
import { HttpException } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
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
import { evidenceFixture, type EvidenceFixture } from '../../evidence/evidence.fixture';
import { PrCommitmentSubject } from '../sourcing/pr-commitment.subject';
import {
  PR_COMMITMENT_DOCUMENT_TYPE,
  PR_COMMITMENT_WORKFLOW_SPEC,
  quotationLineAmounts,
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
let scopeB: TxScope;
let approvals: ApprovalsService;
let audit: AuditService;
let service: PurchaseOrdersService;
let sourcing: SourcingService;
let deptA = '';
let vatCode = '';
let net45 = '';
/** Quotation files uploaded through the RFQ's evidence route. */
let evidence: EvidenceFixture;

const U = { req: '', proc: '', acct: '', fin: '', mgmt: '', founder: '' };
const roles: Partial<Record<RoleKey, string[]>> = {};
const resetRoles = () => {
  roles.accountant = [U.acct];
  roles.finance = [U.fin];
  roles.management = [U.mgmt];
  roles.founder = [U.founder];
};

const grantsOf = (role: RoleKey) =>
  new Map(Object.entries(DEFAULT_ROLE_PERMISSIONS[role])) as Map<Permission, Scope>;
const current: { userId: string; role: RoleKey } = { userId: '', role: 'procurement' };
const as = (userId: string, role: RoleKey) => {
  current.userId = userId;
  current.role = role;
};
const principalNow = (): Principal => ({
  userId: current.userId,
  zitadelUserId: `z-${current.userId}`,
  ...scopeA,
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
    scope: scopeA,
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
  resetRoles();
  deptA = (await createDepartment(appPool, scopeA)).departmentId;

  const vat = await exec(
    scopeA,
    sql`INSERT INTO app.tax_codes (tenant_id, code, name, kind, rate_bp, creditable, effective_from)
        VALUES (${scopeA.tenantId}, 'VAT13', 'VAT 13%', 'vat', 1300, true, '2020-01-01') RETURNING id`,
  );
  vatCode = (vat.rows[0] as { id: string }).id;
  const terms = await exec(
    scopeA,
    sql`INSERT INTO app.payment_terms (tenant_id, code, name, net_days)
        VALUES (${scopeA.tenantId}, 'NET45', 'Net 45', 45) RETURNING id`,
  );
  net45 = (terms.rows[0] as { id: string }).id;

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

/** A clean kernel document, the call-back evidence an active bank account needs. */
async function evidenceDoc(): Promise<string> {
  const { rows } = await exec(
    scopeA,
    sql`INSERT INTO app.documents (tenant_id, organization_id, owner_type, owner_id)
        VALUES (${scopeA.tenantId}, ${scopeA.organizationId}, 'vendor_bill_intake', ${randomUUID()})
        RETURNING id`,
  );
  const documentId = (rows[0] as { id: string }).id;
  await exec(
    scopeA,
    sql`INSERT INTO app.document_versions (tenant_id, organization_id, document_id, version, filename,
          declared_mime, size_bytes, storage_key, status)
        VALUES (${scopeA.tenantId}, ${scopeA.organizationId}, ${documentId}, 1, 'callback.pdf',
                'application/pdf', 1024, ${`${scopeA.tenantId}/${randomUUID()}`}, 'clean')`,
  );
  return documentId;
}

type VendorStatus = 'approved' | 'draft' | 'pending_kyc' | 'suspended' | 'blocked';
let panSeq = 0;
/**
 * A vendor of tenant A in `status` with an active account in each of `accountIn` (entity A by default; on terms
 * `termId` when given) and a bank account: `active` (verified by another person with call-back evidence, the
 * default), `proposed` (not verified) or none.
 */
async function vendor(
  status: VendorStatus = 'approved',
  opts: { accountIn?: TxScope[]; bank?: 'active' | 'proposed' | 'none'; termId?: string } = {},
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
                ${String(400_000_000 + (panSeq += 1))}, ${status}, ${U.proc},
                ${status === 'draft' || status === 'pending_kyc' ? null : U.mgmt})`,
  );
  for (const s of opts.accountIn ?? [scopeA]) {
    await exec(
      s,
      sql`INSERT INTO app.vendor_accounts (tenant_id, organization_id, vendor_id, active, payment_term_id)
          VALUES (${s.tenantId}, ${s.organizationId}, ${partyId}, true, ${opts.termId ?? null})`,
    );
  }
  const bank = opts.bank ?? 'active';
  if (bank !== 'none') {
    const active = bank === 'active';
    const doc = active ? await evidenceDoc() : null;
    await exec(
      scopeA,
      sql`INSERT INTO app.vendor_bank_accounts (tenant_id, vendor_id, bank_name, account_name,
            account_number_enc, account_fingerprint, last4, status, proposed_by, proposed_via, verified_by,
            callback_evidence_document_id)
          VALUES (${scopeA.tenantId}, ${partyId}, 'Nabil Bank', 'Vendor Pvt Ltd', decode('00', 'hex'),
                  ${`fp-${randomUUID()}`}, '1234', ${bank}, ${U.proc}, 'staff',
                  ${active ? U.fin : null}, ${doc})`,
    );
  }
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
 * The lineless draft P2 writes for an approved commitment: one request line of 2 laptops quoted at 39,000.00 + 13%
 * VAT by `vendorId` (88,140.00 incl. VAT, band base), linked to its RFQ and quotation.
 */
async function commitmentDraft(vendorId: string) {
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
  return { draft: draft!, quote, rfqId: rfq.id, prLineId };
}

let poSeq = 0;
/** A draft PO inserted directly (number taken, version 0) with one line of 1 x 79,646.02 + 13% VAT. */
async function plainDraft(vendorId: string): Promise<string> {
  const a = quotationLineAmounts('1', '79646.02', 1300);
  const prId = randomUUID();
  await exec(
    scopeA,
    sql`INSERT INTO app.purchase_requests (id, tenant_id, organization_id, request_type, department_id,
          requester_user_id, cost_center_id, justification, required_by, budget_code, currency)
        VALUES (${prId}, ${scopeA.tenantId}, ${scopeA.organizationId}, 'goods', ${deptA}, ${U.req},
                ${(await createCostCenter(appPool, scopeA)).costCenterId}, 'Laptops', '2026-12-01', 'IT-2083', 'NPR')`,
  );
  await exec(
    scopeA,
    sql`UPDATE app.purchase_requests SET status = 'approved', fx_rate = 1, estimated_total = ${a.lineTotal},
          estimated_total_npr = ${a.lineTotal}, number = ${`PR-T-${prId.slice(0, 8)}`} WHERE id = ${prId}`,
  );
  const id = randomUUID();
  poSeq += 1;
  await exec(
    scopeA,
    sql`INSERT INTO app.purchase_orders (id, tenant_id, organization_id, number, number_seq, fiscal_year,
          purchase_request_id, vendor_id, currency, payment_terms_days, approved_total, fx_rate,
          approved_total_npr, approved_band, created_by)
        VALUES (${id}, ${scopeA.tenantId}, ${scopeA.organizationId}, ${`PO-CV-${poSeq}`}, ${900 + poSeq},
                '2082/83', ${prId}, ${vendorId}, 'NPR', 30, ${a.lineTotal}, 1, ${a.lineTotal}, 'base', ${U.proc})`,
  );
  await exec(
    scopeA,
    sql`INSERT INTO app.purchase_order_lines (id, tenant_id, organization_id, purchase_order_id,
          purchase_request_id, line_no, kind, description, uom, ordered_quantity, unit_price, tax_code_id, gross,
          tax_amount, line_total)
        VALUES (${randomUUID()}, ${scopeA.tenantId}, ${scopeA.organizationId}, ${id}, ${prId}, 1, 'goods',
                'Laptop', 'pcs', 1, 79646.02, ${vatCode}, ${a.gross}, ${a.taxAmount}, ${a.lineTotal})`,
  );
  return id;
}

const poRow = async (id: string) =>
  (await read((tx) => tx.select().from(purchaseOrders).where(eq(purchaseOrders.id, id))))[0]!;
const lineCount = async (id: string) =>
  (
    await read((tx) =>
      tx.select().from(purchaseOrderLines).where(eq(purchaseOrderLines.purchaseOrderId, id)),
    )
  ).length;
const auditRows = async (id: string) =>
  (
    await ownerPool.query<{ actor_id: string; before: unknown; after: unknown }>(
      `SELECT actor_id, before, after FROM audit.audit_events
        WHERE tenant_id = $1 AND entity_type = 'purchase_orders' AND entity_id = $2
          AND action = 'procurement.po.vendor_changed'`,
      [scopeA.tenantId, id],
    )
  ).rows;

// ---------------------------------------------------------------------------------------- tests

describe('changeVendor on a commitment draft', () => {
  it('moves the draft to the new vendor, keeps the approved lines and clears the quotation link', async () => {
    const oldVendor = await vendor();
    const { draft, quote, rfqId, prLineId } = await commitmentDraft(oldVendor);
    expect(draft).toMatchObject({ status: 'draft', rfqId, vendorQuotationId: quote.id });
    expect(await lineCount(draft.id)).toBe(0);
    const before = await service.get(draft.id);
    const newVendor = await vendor('approved', { termId: net45 });

    const key = randomUUID();
    const dto = await service.changeVendor(draft.id, { vendorId: newVendor }, key);

    expect(dto).toMatchObject({
      status: 'draft',
      vendorId: newVendor,
      rfqId: null,
      vendorQuotationId: null,
      paymentTermsDays: 45,
      currency: before.currency,
      fxRate: before.fxRate,
      approvedTotal: before.approvedTotal,
      approvedTotalNpr: before.approvedTotalNpr,
      approvedBand: before.approvedBand,
      number: draft.number,
      version: draft.version + 1,
    });
    expect(Number(dto.advancePercent)).toBe(0);
    // The lines the commitment approved are now written on the order, as the draft showed them.
    const strip = ({ id: _id, ...l }: (typeof dto.lines)[number]) => l;
    expect(dto.lines.map(strip)).toEqual(before.proposedLines!.map(strip));
    expect(dto.lines[0]).toMatchObject({
      prLineId,
      orderedQuantity: '2.0000',
      unitPrice: '39000.00',
      lineTotal: '88140.00',
    });
    expect(await lineCount(draft.id)).toBe(1);
    const after = await service.get(draft.id);
    expect(after).not.toHaveProperty('proposedLines');
    expect(after.lines).toHaveLength(1);

    expect(await auditRows(draft.id)).toEqual([
      {
        actor_id: U.proc,
        before: {
          vendorId: oldVendor,
          paymentTermsDays: 0,
          advancePercent: draft.advancePercent,
          rfqId,
          vendorQuotationId: quote.id,
        },
        after: {
          vendorId: newVendor,
          paymentTermsDays: 45,
          advancePercent: '0',
          rfqId: null,
          vendorQuotationId: null,
          cleared: ['rfqId', 'vendorQuotationId'],
          linesCopied: 1,
        },
      },
    ]);

    // A replay with the same key returns the same order and writes nothing more.
    const replay = await service.changeVendor(draft.id, { vendorId: newVendor }, key);
    expect(replay).toEqual(dto);
    expect((await poRow(draft.id)).version).toBe(dto.version);
    expect(await auditRows(draft.id)).toHaveLength(1);
    expect(await lineCount(draft.id)).toBe(1);

    // The changed draft issues to the new vendor with the approved total.
    const issued = await service.issue(draft.id, randomUUID());
    expect(issued).toMatchObject({ status: 'issued', vendorId: newVendor, currentVersion: 1 });
    expect(issued.lines.map(strip)).toEqual(dto.lines.map(strip));
    const [v1] = await service.versions(draft.id);
    expect(v1).toMatchObject({
      version: 1,
      total: quote.total,
      totalNpr: quote.totalNpr,
      band: 'base',
    });
  });

  it('refuses a vendor without a verified bank account and writes nothing, not even the lines', async () => {
    const { draft } = await commitmentDraft(await vendor());
    for (const bank of ['proposed', 'none'] as const) {
      const refused = await httpErrorOf(
        service.changeVendor(
          draft.id,
          { vendorId: await vendor('approved', { bank }) },
          randomUUID(),
        ),
      );
      expect(refused.getStatus()).toBe(409);
      expect(codeOf(refused)).toBe('VENDOR_NO_VERIFIED_BANK_ACCOUNT');
    }
    expect(await poRow(draft.id)).toEqual(draft);
    expect(await lineCount(draft.id)).toBe(0);
    expect(await auditRows(draft.id)).toEqual([]);
  });
});

describe('changeVendor refusals', () => {
  it.each(['issued', 'cancelled'] as const)(
    'refuses a %s order: cancel it and create a new one',
    async (status) => {
      const id = await plainDraft(await vendor());
      await service.issue(id, randomUUID());
      if (status === 'cancelled') {
        await service.cancel(id, { reason: 'Wrong vendor' }, randomUUID());
      }
      const refused = await httpErrorOf(
        service.changeVendor(id, { vendorId: await vendor() }, randomUUID()),
      );
      expect(refused.getStatus()).toBe(409);
      expect(codeOf(refused)).toBe('PO_VENDOR_CHANGE_NOT_DRAFT');
      expect(messageOf(refused)).toBe('Cancel this order and create a new one');
      expect((await poRow(id)).status).toBe(status);
    },
  );

  it('refuses a vendor that is not approved', async () => {
    const id = await plainDraft(await vendor());
    for (const status of ['suspended', 'pending_kyc'] as const) {
      const refused = await httpErrorOf(
        service.changeVendor(id, { vendorId: await vendor(status) }, randomUUID()),
      );
      expect(refused.getStatus()).toBe(409);
      expect(codeOf(refused)).toBe('VENDOR_NOT_APPROVED');
    }
  });

  it('refuses a vendor with no account in the acting entity', async () => {
    const id = await plainDraft(await vendor());
    const refused = await httpErrorOf(
      service.changeVendor(
        id,
        { vendorId: await vendor('approved', { accountIn: [scopeB] }) },
        randomUUID(),
      ),
    );
    expect(refused.getStatus()).toBe(409);
    expect(codeOf(refused)).toBe('VENDOR_NOT_IN_ENTITY');
  });

  it('answers a vendor of another tenant exactly as an unknown vendor', async () => {
    const other = await createTenantWithEntity(appPool);
    const otherScope = { tenantId: other.tenantId, organizationId: other.organizationId };
    const otherUser = async (roleKey: RoleKey) =>
      (
        await createStaffUser(appPool, {
          ...otherScope,
          idpOrgId: other.idpOrgId,
          roleKeys: [roleKey],
        })
      ).userId;
    const [maker, approver] = [await otherUser('procurement'), await otherUser('management')];
    const { partyId: foreign } = await createParty(appPool, { ...otherScope, kind: 'vendor' });
    await exec(
      otherScope,
      sql`INSERT INTO app.vendors (id, tenant_id, legal_name, pan, status, created_by, approved_by)
          VALUES (${foreign}, ${other.tenantId}, 'Foreign Traders', '499999999', 'approved', ${maker}, ${approver})`,
    );
    await exec(
      otherScope,
      sql`INSERT INTO app.vendor_accounts (tenant_id, organization_id, vendor_id, active)
          VALUES (${other.tenantId}, ${other.organizationId}, ${foreign}, true)`,
    );

    const id = await plainDraft(await vendor());
    const before = await poRow(id);
    const foreignErr = await httpErrorOf(
      service.changeVendor(id, { vendorId: foreign }, randomUUID()),
    );
    const unknownErr = await httpErrorOf(
      service.changeVendor(id, { vendorId: randomUUID() }, randomUUID()),
    );
    expect(foreignErr.getStatus()).toBe(unknownErr.getStatus());
    expect(foreignErr.getResponse()).toEqual(unknownErr.getResponse());
    expect(codeOf(foreignErr)).toBe('VENDOR_NOT_APPROVED');
    expect(messageOf(foreignErr)).not.toContain('Foreign Traders');
    expect(await poRow(id)).toEqual(before);
  });

  it('refuses the vendor the draft already has', async () => {
    const current = await vendor();
    const id = await plainDraft(current);
    const refused = await httpErrorOf(
      service.changeVendor(id, { vendorId: current }, randomUUID()),
    );
    expect(refused.getStatus()).toBe(409);
    expect(codeOf(refused)).toBe('PO_VENDOR_UNCHANGED');
    expect(await auditRows(id)).toEqual([]);
  });
});
