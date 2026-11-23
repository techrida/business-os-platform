// Integration test of the vendor portal reads on a real Postgres (Testcontainers, needs Docker in WSL), done check 13.
// Real: migrations as bos_owner, queries as bos_app, VendorPortalService over the real DrizzleVendorPortalStore (the
// kernel scopeWhereFor through the vendor counterparty view), the real receivedOf, and a real DocumentsService for
// the PDF (listForOwner and issueLinkForOwner on real rows, real SignedLinks). Faked: the caller (a vendor
// Principal per test), the storage adapter and scan queue (never touched by these reads), and the
// `purchase_order_version` owner policy, which P3b registers in the app and this test registers itself.
// Seeds copy purchase-orders.integration.test.ts: draft POs are inserted as P2's commitment route leaves them; an
// issued one gets its issue stamp and version 1 written with the real insertVersion. Bills and rendered PDFs are
// inserted directly (their writers are later units).
// Run: pnpm --filter @bos/api exec vitest run src/modules/portal-vendor/portal-vendor.integration.test.ts
import 'reflect-metadata';

import { randomUUID } from 'node:crypto';

import type { Permission, Scope } from '@bos/contracts';
import {
  createCostCenter,
  createDepartment,
  createParty,
  createStaffUser,
  createTenantWithEntity,
  purchaseOrderLines,
  purchaseOrders,
} from '@bos/db';
import { ForbiddenException, HttpException, NotFoundException } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { and, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { Principal } from '../../platform/authz/principal';
import type { Db } from '../../platform/db/db.module';
import { systemActor, withTx, type TxScope } from '../../platform/db/tx';
import { DocumentsService } from '../../platform/documents/documents.service';
import { SignedLinks, type LinkStore } from '../../platform/documents/signed-link';
import type { StorageAdapter } from '../../platform/documents/storage.adapter';
import type { VendorPortalCaller } from '../portal/vendor-portal.caller';
import { insertVersion } from '../procurement/orders/purchase-order.writes';
import { quotationLineAmounts } from '../procurement/sourcing/sourcing.rules';
import { PO_VERSION_OWNER_TYPE, VendorPortalService } from './portal-vendor.service';
import { DrizzleVendorPortalStore } from './portal-vendor.store';
import { createTestDatabase, type TestDatabase } from '@bos/db/testing';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 180_000 });

const SIGNING_SECRET = 'an-integration-test-secret-of-32-plus-chars';
const NOW = new Date('2026-11-10T06:00:00Z');

class MemoryLinkStore implements LinkStore {
  private readonly keys = new Set<string>();
  claim(key: string): Promise<boolean> {
    if (this.keys.has(key)) return Promise.resolve(false);
    this.keys.add(key);
    return Promise.resolve(true);
  }
}

let testDb: TestDatabase;
let appPool: Pool;
let db: Db;
let scopeA: TxScope;
let scopeB: TxScope;
let idpOrgId: string;
let staffId: string;
/** Approves vendors: never the creator (vendors_approved_by_check). */
let approverId: string;
let deptA: string;
let deptB: string;
let vatCode: string;
let service: VendorPortalService;

const current: { p: Principal | null } = { p: null };
const caller: VendorPortalCaller = {
  current: () => {
    if (current.p === null) throw new Error('no principal');
    return current.p;
  },
};

const exec = (scope: TxScope, q: ReturnType<typeof sql>) =>
  withTx(db, scope, systemActor('test'), (tx) => tx.execute(q));

/** A vendor portal principal for `partyId`, acting in `scope`. */
function asVendor(partyId: string, scope: TxScope = scopeA, overrides: Partial<Principal> = {}) {
  current.p = {
    userId: randomUUID(),
    zitadelUserId: `z-${partyId.slice(0, 8)}`,
    tenantId: scope.tenantId,
    organizationId: scope.organizationId,
    orgKind: 'vendor',
    partyId,
    idpOrgId: `idp-${partyId.slice(0, 8)}`,
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

type VendorStatus = 'approved' | 'pending_kyc' | 'suspended';
let panSeq = 0;
/** A vendor in `status` with an active account in each of `accountIn`. */
async function vendor(status: VendorStatus, accountIn: TxScope[] = [scopeA]): Promise<string> {
  const { partyId } = await createParty(appPool, {
    tenantId: scopeA.tenantId,
    kind: 'vendor',
    organizationId: scopeA.organizationId,
  });
  await exec(
    scopeA,
    sql`INSERT INTO app.vendors (id, tenant_id, legal_name, pan, status, created_by, approved_by)
        VALUES (${partyId}, ${scopeA.tenantId}, ${`Vendor ${partyId.slice(0, 6)}`},
                ${String(300_000_000 + (panSeq += 1))}, ${status}, ${staffId},
                ${status === 'pending_kyc' ? null : approverId})`,
  );
  for (const s of accountIn) {
    await exec(
      s,
      sql`INSERT INTO app.vendor_accounts (tenant_id, organization_id, vendor_id, active)
          VALUES (${s.tenantId}, ${s.organizationId}, ${partyId}, true)`,
    );
  }
  return partyId;
}

let poSeq = 0;
/** A draft PO of `vendorId` in `scope`: one line of 2 x 50,000.00 + 13% VAT = 113,000.00. */
async function draftPo(vendorId: string, scope: TxScope = scopeA): Promise<string> {
  const a = quotationLineAmounts('2', '50000.00', 1300);
  const prId = randomUUID();
  await exec(
    scope,
    sql`INSERT INTO app.purchase_requests (id, tenant_id, organization_id, request_type, department_id,
          requester_user_id, cost_center_id, justification, required_by, budget_code, currency)
        VALUES (${prId}, ${scope.tenantId}, ${scope.organizationId}, 'goods',
                ${scope === scopeA ? deptA : deptB}, ${staffId}, ${(await createCostCenter(appPool, scope)).costCenterId}, 'Laptops', '2026-12-01',
                'IT-2083', 'NPR')`,
  );
  await exec(
    scope,
    sql`UPDATE app.purchase_requests SET status = 'approved', fx_rate = 1, estimated_total = ${a.lineTotal},
          estimated_total_npr = ${a.lineTotal}, number = ${`PR-V-${prId.slice(0, 8)}`} WHERE id = ${prId}`,
  );
  const id = randomUUID();
  poSeq += 1;
  await exec(
    scope,
    sql`INSERT INTO app.purchase_orders (id, tenant_id, organization_id, number, number_seq, fiscal_year,
          purchase_request_id, vendor_id, currency, payment_terms_days, approved_total, fx_rate,
          approved_total_npr, approved_band, created_by)
        VALUES (${id}, ${scope.tenantId}, ${scope.organizationId}, ${`PO-V-${poSeq}`}, ${poSeq}, '2082/83',
                ${prId}, ${vendorId}, 'NPR', 30, ${a.lineTotal}, 1, ${a.lineTotal}, 'base', ${staffId})`,
  );
  await exec(
    scope,
    sql`INSERT INTO app.purchase_order_lines (id, tenant_id, organization_id, purchase_order_id,
          purchase_request_id, line_no, kind, description, uom, ordered_quantity, unit_price, tax_code_id, gross,
          tax_amount, line_total)
        VALUES (${randomUUID()}, ${scope.tenantId}, ${scope.organizationId}, ${id}, ${prId}, 1, 'goods', 'Laptop',
                'pcs', 2, '50000.00', ${vatCode}, ${a.gross}, ${a.taxAmount}, ${a.lineTotal})`,
  );
  return id;
}

/** An issued PO: the issue stamp, version 1, and the version row written by the real insertVersion. */
async function issuedPo(
  vendorId: string,
  scope: TxScope = scopeA,
): Promise<{ id: string; versionId: string }> {
  const id = await draftPo(vendorId, scope);
  return withTx(db, scope, systemActor('test'), async (tx) => {
    const [po] = await tx
      .update(purchaseOrders)
      .set({ status: 'issued', issuedAt: NOW, issuedBy: staffId, currentVersion: 1 })
      .where(eq(purchaseOrders.id, id))
      .returning();
    if (po === undefined) throw new Error('no PO');
    const lines = await tx
      .select()
      .from(purchaseOrderLines)
      .where(
        and(
          eq(purchaseOrderLines.tenantId, scope.tenantId),
          eq(purchaseOrderLines.purchaseOrderId, id),
        ),
      );
    await insertVersion(tx, scope, {
      po,
      lines,
      version: 1,
      reason: null,
      total: po.approvedTotal,
      totalNpr: po.approvedTotalNpr,
      band: 'base',
      approvalRequestId: null,
      createdBy: staffId,
    });
    const { rows } = await tx.execute(
      sql`SELECT id FROM app.purchase_order_versions WHERE purchase_order_id = ${id} AND version = 1`,
    );
    return { id, versionId: (rows[0] as { id: string }).id };
  });
}

/** A document of `ownerType`/`ownerId` in `scope` with one version in `status`. Returns the document id. */
async function documentFor(
  scope: TxScope,
  ownerType: string,
  ownerId: string,
  status: 'clean' | 'quarantined' = 'clean',
): Promise<string> {
  const documentId = randomUUID();
  const versionId = randomUUID();
  await exec(
    scope,
    sql`INSERT INTO app.documents (id, tenant_id, organization_id, owner_type, owner_id)
        VALUES (${documentId}, ${scope.tenantId}, ${scope.organizationId}, ${ownerType}, ${ownerId})`,
  );
  await exec(
    scope,
    sql`INSERT INTO app.document_versions (id, tenant_id, organization_id, document_id, version, filename,
          declared_mime, detected_mime, size_bytes, sha256, storage_key, status, scanned_at)
        VALUES (${versionId}, ${scope.tenantId}, ${scope.organizationId}, ${documentId}, 1, 'po.pdf',
                'application/pdf', 'application/pdf', 1024, decode(repeat('ab', 32), 'hex'),
                ${`${scope.tenantId}/${versionId}`}, ${status}, ${status === 'clean' ? NOW : null})`,
  );
  return documentId;
}

let billSeq = 0;
/** A bill of `vendorId` in `scope` in `status` (numbered unless told otherwise): 100,000 + 13% VAT, no TDS. */
async function bill(
  vendorId: string,
  status: string,
  scope: TxScope = scopeA,
  opts: { number?: string | null } = {},
): Promise<string> {
  const id = randomUUID();
  billSeq += 1;
  const documentId = await documentFor(scope, 'vendor_bill', id);
  const num = opts.number === undefined ? `BILL-V-${billSeq}` : opts.number;
  await exec(
    scope,
    sql`INSERT INTO app.vendor_bills (id, tenant_id, organization_id, number, vendor_id, vendor_invoice_no,
          invoice_date, fiscal_year, currency, document_id, status, net_total, vat_total, payable_total, fx_rate,
          payable_total_npr, entered_by)
        VALUES (${id}, ${scope.tenantId}, ${scope.organizationId}, ${num}, ${vendorId}, ${`INV-${billSeq}`},
                '2026-11-01', '2083/84', 'NPR', ${documentId}, ${status}, '100000.00', '13000.00', '113000.00',
                1, '113000.00', ${staffId})`,
  );
  return id;
}

beforeAll(async () => {
  testDb = await createTestDatabase();
  const admin0 = new Pool({ connectionString: testDb.adminUrl, max: 1 });
  await admin0.end();
  const bosAdmin = new Pool({ connectionString: testDb.adminUrl, max: 1 });
  await bosAdmin.end();

  appPool = new Pool({ connectionString: testDb.appUrl, max: 8 });
  db = drizzle({ client: appPool });

  const tenant = await createTenantWithEntity(appPool);
  idpOrgId = tenant.idpOrgId;
  scopeA = { tenantId: tenant.tenantId, organizationId: tenant.organizationId };
  const otherEntityId = randomUUID();
  await exec(
    scopeA,
    sql`INSERT INTO app.organizations (id, tenant_id, organization_id, name, code, legal_name, is_default)
        VALUES (${otherEntityId}, ${scopeA.tenantId}, ${otherEntityId}, ${`E-${otherEntityId}`},
                ${`E-${otherEntityId}`}, ${`E-${otherEntityId}`}, false)`,
  );
  scopeB = { tenantId: scopeA.tenantId, organizationId: otherEntityId };
  staffId = (await createStaffUser(appPool, { ...scopeA, idpOrgId, roleKeys: ['procurement'] }))
    .userId;
  approverId = (await createStaffUser(appPool, { ...scopeA, idpOrgId, roleKeys: ['management'] }))
    .userId;
  deptA = (await createDepartment(appPool, scopeA)).departmentId;
  deptB = (await createDepartment(appPool, scopeB)).departmentId;
  const { rows } = await exec(
    scopeA,
    sql`INSERT INTO app.tax_codes (tenant_id, code, name, kind, rate_bp, creditable, effective_from)
        VALUES (${scopeA.tenantId}, 'VAT13', 'VAT 13%', 'vat', 1300, true, '2020-01-01') RETURNING id`,
  );
  vatCode = (rows[0] as { id: string }).id;

  const documents = new DocumentsService(
    db,
    {} as StorageAdapter,
    new SignedLinks(SIGNING_SECRET, new MemoryLinkStore(), () => Date.now()),
    { add: vi.fn().mockResolvedValue({}) } as unknown as Queue,
    { assert: vi.fn() },
    { record: vi.fn().mockResolvedValue(undefined) },
  );
  // P3b registers the real policy in the app; the link needs one registered to be issued at all.
  documents.registerOwner({
    ownerType: PO_VERSION_OWNER_TYPE,
    resource: (s) => Promise.resolve({ tenantId: s.tenantId, organizationId: s.organizationId }),
    allowsSystemActor: () => Promise.resolve(true),
  });
  service = new VendorPortalService(caller, new DrizzleVendorPortalStore(db), documents, () => NOW);
});

afterAll(async () => {
  await appPool?.end();
  await testDb?.drop();
});

describe('vendor portal isolation (done check 13)', () => {
  let vendorA: string;
  let vendorB: string;
  let poA: { id: string; versionId: string };
  let poB: { id: string; versionId: string };
  let poAOtherEntity: { id: string; versionId: string };
  let draftA: string;
  let billA: string;
  let billB: string;

  beforeAll(async () => {
    vendorA = await vendor('approved', [scopeA, scopeB]);
    vendorB = await vendor('approved');
    poA = await issuedPo(vendorA);
    poB = await issuedPo(vendorB);
    poAOtherEntity = await issuedPo(vendorA, scopeB);
    draftA = await draftPo(vendorA);
    await documentFor(scopeA, PO_VERSION_OWNER_TYPE, poA.versionId);
    await documentFor(scopeA, PO_VERSION_OWNER_TYPE, poB.versionId);
    billA = await bill(vendorA, 'pending_approval');
    billB = await bill(vendorB, 'approved');
  });

  it('lists only the caller’s own issued orders in the acting entity: no draft, no other vendor, no other entity', async () => {
    asVendor(vendorA);
    const list = await service.listPurchaseOrders();
    expect(list.map((po) => po.id)).toEqual([poA.id]);
    expect(list[0]).toMatchObject({ version: 1, status: 'issued', total: '113000.00' });

    asVendor(vendorB);
    expect((await service.listPurchaseOrders()).map((po) => po.id)).toEqual([poB.id]);
  });

  it('answers one 404 body for another vendor’s order, a draft, another entity’s order and an unknown id', async () => {
    asVendor(vendorB);
    const foreign = await errorOf(service.getPurchaseOrder(poA.id));
    const unknown = await errorOf(service.getPurchaseOrder(randomUUID()));
    asVendor(vendorA);
    const draft = await errorOf(service.getPurchaseOrder(draftA));
    const otherEntity = await errorOf(service.getPurchaseOrder(poAOtherEntity.id));
    expect(foreign.status).toBe(404);
    for (const e of [unknown, draft, otherEntity]) expect(e).toEqual(foreign);
  });

  it('shows the caller its own order at the issued version, with its clean PDF', async () => {
    asVendor(vendorA);
    const view = await service.getPurchaseOrder(poA.id);
    expect(view).toMatchObject({
      id: poA.id,
      version: 1,
      status: 'issued',
      paymentTermsDays: 30,
      lines: [{ lineNo: 1, quantity: '2.0000', unitPrice: '50000.00', receivedQuantity: '0.0000' }],
    });
    expect(view.file).toMatchObject({ filename: 'po.pdf', sha256: 'ab'.repeat(32) });
  });

  it('gives the owner a PDF link and every other caller the same 404', async () => {
    asVendor(vendorA);
    const link = await service.purchaseOrderPdfLink(poA.id);
    expect(link.url).toMatch(/^\/v1\/files\/[A-Za-z0-9._~-]+$/);

    asVendor(vendorB);
    const foreign = await errorOf(service.purchaseOrderPdfLink(poA.id));
    expect(foreign.status).toBe(404);
    expect(await errorOf(service.purchaseOrderPdfLink(randomUUID()))).toEqual(foreign);
    asVendor(vendorA);
    expect(await errorOf(service.purchaseOrderPdfLink(draftA))).toEqual(foreign);
    // An issued order with no rendered PDF yet (P3b not run) answers the same.
    expect(await errorOf(service.purchaseOrderPdfLink(poAOtherEntity.id))).toEqual(foreign);
    asVendor(vendorA, scopeB);
    expect(await errorOf(service.purchaseOrderPdfLink(poAOtherEntity.id))).toEqual(foreign);
  });

  it('serves no PDF whose newest version has not scanned clean', async () => {
    const po = await issuedPo(vendorA);
    await documentFor(scopeA, PO_VERSION_OWNER_TYPE, po.versionId, 'quarantined');
    asVendor(vendorA);
    expect((await errorOf(service.purchaseOrderPdfLink(po.id))).status).toBe(404);
    expect((await service.getPurchaseOrder(po.id)).file).toBeNull();
  });

  it('keeps showing the last issued version while an amendment waits for approval', async () => {
    const po = await issuedPo(vendorA);
    await exec(
      scopeA,
      sql`UPDATE app.purchase_orders SET status = 'amendment_pending' WHERE id = ${po.id}`,
    );
    asVendor(vendorA);
    expect(await service.getPurchaseOrder(po.id)).toMatchObject({ version: 1, status: 'issued' });
    expect((await service.listPurchaseOrders()).map((p) => p.id)).toContain(po.id);
  });

  it('lists only the caller’s bills with the coarse status, and 404s another vendor’s bill', async () => {
    asVendor(vendorA);
    const own = await service.listBills();
    expect(own.map((b) => [b.id, b.status])).toEqual([[billA, 'under_review']]);
    expect(await service.getBill(billA)).toMatchObject({
      id: billA,
      status: 'under_review',
      tdsAmount: '0.00',
    });

    asVendor(vendorB);
    expect((await service.listBills()).map((b) => [b.id, b.status])).toEqual([
      [billB, 'approved_for_payment'],
    ]);
    const foreign = await errorOf(service.getBill(billA));
    expect(foreign.status).toBe(404);
    expect(await errorOf(service.getBill(randomUUID()))).toEqual(foreign);
    // The PO routes and the bill routes answer the same 404 body.
    expect(await errorOf(service.getPurchaseOrder(poA.id))).toEqual(foreign);
  });

  it('hides voided and unnumbered bills', async () => {
    const vendorC = await vendor('approved');
    const voided = await bill(vendorC, 'approved');
    await exec(
      scopeA,
      sql`UPDATE app.vendor_bills SET status = 'voided', voided_by = ${staffId}, voided_at = now(),
            void_reason = 'Duplicate' WHERE id = ${voided}`,
    );
    const unnumbered = await bill(vendorC, 'draft', scopeA, { number: null });
    const shown = await bill(vendorC, 'draft');
    asVendor(vendorC);
    expect((await service.listBills()).map((b) => [b.id, b.status])).toEqual([[shown, 'received']]);
    expect((await errorOf(service.getBill(unnumbered))).status).toBe(404);
    expect((await errorOf(service.getBill(voided))).status).toBe(404);
  });
});

describe('vendor portal capability by vendor status (done check 13)', () => {
  it('lets a pending_kyc vendor reach onboarding but answers 403 on orders and bills', async () => {
    const pending = await vendor('pending_kyc');
    await issuedPo(await vendor('approved'));
    asVendor(pending);

    const onboarding = await service.onboarding();
    expect(onboarding.status).toBe('pending_kyc');
    expect(onboarding.capability).toBe('onboarding_only');
    expect(onboarding.documents.every((d) => d.state === 'missing')).toBe(true);

    for (const call of [
      () => service.listPurchaseOrders(),
      () => service.getPurchaseOrder(randomUUID()),
      () => service.purchaseOrderPdfLink(randomUUID()),
      () => service.listBills(),
      () => service.getBill(randomUUID()),
    ]) {
      const e = await errorOf(call());
      expect(e).toEqual({
        status: 403,
        body: { code: 'forbidden', message: 'Forbidden', reason: 'no_permission' },
      });
    }
  });

  it('shows the KYB checklist state of the caller’s own case', async () => {
    const pending = await vendor('pending_kyc');
    const docId = randomUUID();
    await exec(
      scopeA,
      sql`INSERT INTO app.verification_cases (tenant_id, party_id, party_kind, status, checklist)
          VALUES (${scopeA.tenantId}, ${pending}, 'vendor', 'draft', ${JSON.stringify([
            {
              key: 'pan_certificate',
              required: true,
              status: 'provided',
              documentId: docId,
              expiresOn: null,
            },
            {
              key: 'tax_clearance',
              required: true,
              status: 'accepted',
              documentId: docId,
              expiresOn: '2026-07-15',
            },
          ])}::jsonb)`,
    );
    asVendor(pending);
    const state = Object.fromEntries(
      (await service.onboarding()).documents.map((d) => [d.docType, d.state]),
    );
    expect(state).toMatchObject({
      pan_certificate: 'submitted',
      tax_clearance: 'expired',
      bank_proof: 'missing',
    });
  });

  it('tells the vendor when its details changed and who changed them, and only for its own case (R6AE)', async () => {
    const changed = await vendor('pending_kyc');
    const other = await vendor('pending_kyc');
    await exec(
      scopeA,
      sql`INSERT INTO app.verification_cases (tenant_id, party_id, party_kind, status, checklist,
            identity_reset_at, identity_reset_by_user_id)
          VALUES (${scopeA.tenantId}, ${changed}, 'vendor', 'draft', '[]'::jsonb,
            '2026-11-23T04:00:00Z', ${staffId}),
                 (${scopeA.tenantId}, ${other}, 'vendor', 'draft', '[]'::jsonb, NULL, NULL)`,
    );
    asVendor(changed);
    const view = await service.onboarding();
    expect(view.detailsChanged?.at).toBe('2026-11-23T04:00:00.000Z');
    expect(typeof view.detailsChanged?.by).toBe('string');
    expect(view.detailsChanged?.by).not.toBe('');
    asVendor(other);
    expect((await service.onboarding()).detailsChanged).toBeNull();
    // Once the case is submitted again the note goes.
    await exec(
      scopeA,
      sql`UPDATE app.verification_cases SET status = 'submitted', submitted_by_user_id = ${staffId},
            submitted_at = now() WHERE party_id = ${changed}`,
    );
    asVendor(changed);
    expect((await service.onboarding()).detailsChanged).toBeNull();
  });

  it('refuses a staff or customer principal, and a vendor party with no vendor record, with 403', async () => {
    const vendorParty = await vendor('approved');
    asVendor(vendorParty, scopeA, { orgKind: 'staff' });
    await expect(service.onboarding()).rejects.toBeInstanceOf(ForbiddenException);
    asVendor(vendorParty, scopeA, { orgKind: 'customer' });
    await expect(service.listPurchaseOrders()).rejects.toBeInstanceOf(ForbiddenException);
    asVendor(randomUUID());
    await expect(service.onboarding()).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('lets a suspended vendor read its orders', async () => {
    const suspended = await vendor('suspended');
    const po = await issuedPo(suspended);
    asVendor(suspended);
    expect((await service.listPurchaseOrders()).map((p) => p.id)).toEqual([po.id]);
    await expect(service.getPurchaseOrder(randomUUID())).rejects.toBeInstanceOf(NotFoundException);
  });
});
