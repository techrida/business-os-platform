// Integration tests of posting an approved vendor bill on a real Postgres (Testcontainers, needs Docker in WSL).
// Real: migrations as bos_owner, queries as bos_app (so the 0035 payable, TDS-code and NPR CHECKs and the 0019
// open_items / posting_events unique keys run), VendorBillsService, the real ApprovalsService with the `vendor_bill`
// workflow published through ApprovalsAdminService, the real VendorBillSubject with the real LedgerService,
// PurchaseOrdersService, ReceiptsService, SettingsService and AuditService. Faked: notify, the role directory, the
// request context and authz.assert (the real pure can()).
// Covers done checks 16 (TDS at approval: 100,000 + 13,000 - 1,500 at 150 bp = 111,500; zero TDS 113,000), 9 (one
// payable open item per approved bill with the bill's amount, party, entity and currency) and 11 (a double approve,
// a replayed onDecided and a replayed Idempotency-Key leave one item and one event), and the entity wall.
// Run: pnpm --filter @bos/api exec vitest run src/modules/payables/bills/vendor-bill-posting.integration.test.ts
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
  createExpenseAccount,
  createParty,
  createStaffUser,
  createTenantWithEntity,
  openItems,
  postingEvents,
  vendorBillLines,
  vendorBills,
} from '@bos/db';
import { ConflictException, ForbiddenException, HttpException } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
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
import { SettingsService } from '../../../platform/settings/settings.service';
import { ApprovalsAdminService } from '../../approvals/admin.service';
import { asSecondPerson, SKIP_LIVE_PUBLISHER_CHECK } from '../../../../test/support/second-person';
import { ApprovalsService } from '../../approvals/requests.service';
import { LedgerService } from '../../ledger/ledger.service';
import { PurchaseOrdersService } from '../../procurement/orders/purchase-orders.service';
import { ReceiptsService } from '../../procurement/receipts/receipts.service';
import { quotationLineAmounts } from '../../procurement/sourcing/sourcing.rules';
import { VENDOR_BILL_DOCUMENT_TYPE, VENDOR_BILL_WORKFLOW_SPEC } from './vendor-bill.rules';
import { VendorBillSubject } from './vendor-bill.subject';
import { VendorBillsService } from './vendor-bills.service';
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
let subject: VendorBillSubject;
let service: VendorBillsService;
let orders: PurchaseOrdersService;
let receiptsService: ReceiptsService;
let deptA = '';
let vatCode = '';
/** An active expense account of entity A: bill lines must book to one (round 5, unit P1). */
let expenseAccountId = '';
let tdsCode = '';

const U = { req: '', proc: '', acct: '', acct2: '', fin: '', mgmt: '', founder: '', wh: '' };
const roles: Partial<Record<RoleKey, string[]>> = {};

const grantsOf = (role: RoleKey) =>
  new Map(Object.entries(DEFAULT_ROLE_PERMISSIONS[role])) as Map<Permission, Scope>;
const current: { userId: string; role: RoleKey } = { userId: '', role: 'accountant' };
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
  U.acct2 = await staff('accountant');
  U.fin = await staff('finance');
  U.mgmt = await staff('management');
  U.founder = await staff('founder');
  U.wh = await staff('warehouse');
  roles.accountant = [U.acct, U.acct2];
  roles.finance = [U.fin];
  roles.management = [U.mgmt];
  roles.founder = [U.founder];
  deptA = (await createDepartment(appPool, scopeA)).departmentId;

  const vat = await exec(
    scopeA,
    sql`INSERT INTO app.tax_codes (tenant_id, code, name, kind, rate_bp, creditable, effective_from)
        VALUES (${scopeA.tenantId}, 'VAT13', 'VAT 13%', 'vat', 1300, true, '2020-01-01') RETURNING id`,
  );
  vatCode = (vat.rows[0] as { id: string }).id;
  expenseAccountId = (await createExpenseAccount(appPool, scopeA)).id;
  const tds = await exec(
    scopeA,
    sql`INSERT INTO app.withholding_codes (tenant_id, code, name, applies_to, rate_bp, effective_from)
        VALUES (${scopeA.tenantId}, 'TDS-SVC', 'TDS on services 1.5%', 'payable', 150, '2020-01-01')
        RETURNING id`,
  );
  tdsCode = (tds.rows[0] as { id: string }).id;

  const audit = new AuditService(db);
  as(U.founder, 'founder');
  const admin = new ApprovalsAdminService(db, audit, caller, () => now);
  const adminPublisher = new ApprovalsAdminService(db, audit, asSecondPerson(caller), () => now);
  await admin.createWorkflow({
    key: VENDOR_BILL_DOCUMENT_TYPE,
    name: 'Vendor bill',
    spec: VENDOR_BILL_WORKFLOW_SPEC,
  });
  await adminPublisher.publish(VENDOR_BILL_DOCUMENT_TYPE, 1, SKIP_LIVE_PUBLISHER_CHECK);

  approvals = new ApprovalsService(db, audit, notify, directory, caller, () => now);
  subject = new VendorBillSubject(audit, () => now, new LedgerService());
  approvals.registerSubject(subject);
  service = new VendorBillsService(
    db,
    approvals,
    audit,
    new SettingsService(db),
    caller,
    () => now,
  );
  orders = new PurchaseOrdersService(db, approvals, audit, caller, () => now);
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
  await testDb?.drop();
});

beforeEach(() => {
  vi.clearAllMocks();
  as(U.acct, 'accountant');
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
/** An approved vendor with an account in both entities; `defaultTds` sets entity A's default withholding code. */
async function vendor(defaultTds: string | null): Promise<string> {
  const { partyId } = await createParty(appPool, {
    tenantId: scopeA.tenantId,
    kind: 'vendor',
    organizationId: scopeA.organizationId,
  });
  await exec(
    scopeA,
    sql`INSERT INTO app.vendors (id, tenant_id, legal_name, pan, status, created_by, approved_by)
        VALUES (${partyId}, ${scopeA.tenantId}, ${`Vendor ${partyId.slice(0, 6)}`},
                ${String(400_000_000 + (panSeq += 1))}, 'approved', ${U.proc}, ${U.mgmt})`,
  );
  for (const s of [scopeA, scopeB]) {
    const code = s === scopeA ? defaultTds : null;
    await exec(
      s,
      sql`INSERT INTO app.vendor_accounts (tenant_id, organization_id, vendor_id, active,
            default_withholding_code_id)
          VALUES (${s.tenantId}, ${s.organizationId}, ${partyId}, true, ${code})`,
    );
  }
  return partyId;
}

let poSeq = 0;
interface Po {
  id: string;
  lineId: string;
  vendorId: string;
}
/** An issued NPR PO in entity A with one line of 1 x 100,000.00 + 13% VAT, fully received. */
async function receivedPo(defaultTds: string | null): Promise<Po> {
  const vendorId = await vendor(defaultTds);
  const a = quotationLineAmounts('1', '100000.00', 1300);
  const prId = randomUUID();
  await exec(
    scopeA,
    sql`INSERT INTO app.purchase_requests (id, tenant_id, organization_id, request_type, department_id,
          requester_user_id, cost_center_id, justification, required_by, budget_code, currency)
        VALUES (${prId}, ${scopeA.tenantId}, ${scopeA.organizationId}, 'goods', ${deptA}, ${U.req},
                ${(await createCostCenter(appPool, scopeA)).costCenterId}, 'Audit fee', '2026-12-01', 'FIN-2083', 'NPR')`,
  );
  await exec(
    scopeA,
    sql`UPDATE app.purchase_requests SET status = 'approved', fx_rate = 1, estimated_total = ${a.lineTotal},
          estimated_total_npr = ${a.lineTotal}, number = ${`PR-P-${prId.slice(0, 8)}`} WHERE id = ${prId}`,
  );
  const id = randomUUID();
  poSeq += 1;
  await exec(
    scopeA,
    sql`INSERT INTO app.purchase_orders (id, tenant_id, organization_id, number, number_seq, fiscal_year,
          purchase_request_id, vendor_id, currency, payment_terms_days, approved_total, fx_rate,
          approved_total_npr, approved_band, created_by)
        VALUES (${id}, ${scopeA.tenantId}, ${scopeA.organizationId}, ${`PO-P-${poSeq}`}, ${poSeq}, '2082/83',
                ${prId}, ${vendorId}, 'NPR', 30, ${a.lineTotal}, 1, ${a.lineTotal}, 'base', ${U.proc})`,
  );
  const lineId = randomUUID();
  await exec(
    scopeA,
    sql`INSERT INTO app.purchase_order_lines (id, tenant_id, organization_id, purchase_order_id,
          purchase_request_id, line_no, kind, description, uom, ordered_quantity, unit_price, tax_code_id, gross,
          tax_amount, line_total)
        VALUES (${lineId}, ${scopeA.tenantId}, ${scopeA.organizationId}, ${id}, ${prId}, 1, 'goods', 'Audit',
                'pcs', '1', '100000.00', ${vatCode}, ${a.gross}, ${a.taxAmount}, ${a.lineTotal})`,
  );
  as(U.proc, 'procurement');
  await orders.issue(id, randomUUID());
  as(U.wh, 'warehouse');
  const r = await receiptsService.create(
    {
      purchaseOrderId: id,
      kind: 'goods',
      receivedAt: '2026-11-09',
      lines: [{ poLineId: lineId, quantity: '1' }],
    },
    randomUUID(),
  );
  await receiptsService.confirm(r.id, randomUUID());
  as(U.acct, 'accountant');
  return { id, lineId, vendorId };
}

async function doc(vendorId: string): Promise<string> {
  const { rows } = await exec(
    scopeA,
    sql`INSERT INTO app.documents (tenant_id, organization_id, owner_type, owner_id)
        VALUES (${scopeA.tenantId}, ${scopeA.organizationId}, 'vendor_bill_intake', ${vendorId}) RETURNING id`,
  );
  const documentId = (rows[0] as { id: string }).id;
  await exec(
    scopeA,
    sql`INSERT INTO app.document_versions (tenant_id, organization_id, document_id, version, filename,
          declared_mime, size_bytes, storage_key, status)
        VALUES (${scopeA.tenantId}, ${scopeA.organizationId}, ${documentId}, 1, 'invoice.pdf',
                'application/pdf', 1024, ${`${scopeA.tenantId}/${randomUUID()}`}, 'clean')`,
  );
  return documentId;
}

/** A matched bill of 1 x 100,000.00 + 13% VAT against `po`, submitted (Accountant -> Finance). */
async function submittedBill(po: Po, lineTds?: string) {
  const bill = await service.create(
    {
      vendorPartyId: po.vendorId,
      kind: 'bill',
      vendorInvoiceNo: `INV-${randomUUID().slice(0, 8)}`,
      invoiceDate: '2026-11-09',
      currency: 'NPR',
      purchaseOrderId: po.id,
      documentId: await doc(po.vendorId),
      lines: [
        {
          poLineId: po.lineId,
          accountId: expenseAccountId,
          quantity: '1',
          unitPrice: '100000.00',
          taxCodeId: vatCode,
          ...(lineTds === undefined ? {} : { tdsCodeId: lineTds }),
        },
      ],
    },
    randomUUID(),
  );
  expect(bill.status).toBe('matching');
  const submitted = await service.submit(bill.id, randomUUID());
  expect(submitted.status).toBe('pending_approval');
  return { billId: bill.id, requestId: submitted.approvalRequestId! };
}

const versionOf = async (requestId: string) =>
  (
    await read((tx) =>
      tx
        .select({ version: approvalRequests.version })
        .from(approvalRequests)
        .where(eq(approvalRequests.id, requestId)),
    )
  )[0]!.version;

async function act(user: string, role: RoleKey, requestId: string, body: unknown, key: string) {
  as(user, role);
  try {
    return await approvals.act(requestId, body as Parameters<typeof approvals.act>[1], key);
  } finally {
    as(U.acct, 'accountant');
  }
}
const approveBody = async (requestId: string) => ({
  action: 'approve' as const,
  expectedVersion: await versionOf(requestId),
});

/** Accountant (not the one who entered it), then Finance: the bill's last decision posts it. */
async function approveFully(requestId: string) {
  await act(U.acct2, 'accountant', requestId, await approveBody(requestId), randomUUID());
  await act(U.fin, 'finance', requestId, await approveBody(requestId), randomUUID());
}

const itemsOf = (billId: string) =>
  read((tx) =>
    tx
      .select()
      .from(openItems)
      .where(eq(openItems.sourceId, billId))
      .then((rows) => rows.filter((r) => r.sourceType === 'vendor_bill')),
  );
const eventsOf = (billId: string) =>
  read((tx) =>
    tx
      .select()
      .from(postingEvents)
      .where(eq(postingEvents.sourceId, billId))
      .then((rows) => rows.filter((r) => r.sourceType === 'vendor_bill')),
  );
const billRow = async (billId: string) =>
  (await read((tx) => tx.select().from(vendorBills).where(eq(vendorBills.id, billId))))[0]!;
const lineRows = (billId: string) =>
  read((tx) => tx.select().from(vendorBillLines).where(eq(vendorBillLines.vendorBillId, billId)));

// ---------------------------------------------------------------------------------------- check 16

describe('TDS at approval (check 16, AD14)', () => {
  it('the vendor default at 150 bp: 100,000 + 13,000 - 1,500 = 111,500 on the bill, item and payload', async () => {
    const po = await receivedPo(tdsCode);
    const { billId, requestId } = await submittedBill(po);
    await approveFully(requestId);

    const bill = await billRow(billId);
    expect(bill).toMatchObject({
      status: 'approved',
      netTotal: '100000.00',
      vatTotal: '13000.00',
      tdsTotal: '1500.00',
      payableTotal: '111500.00',
      payableTotalNpr: '111500.00',
      withholdingCodeId: tdsCode,
    });
    const lines = await lineRows(billId);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ tdsAmount: '1500.00', withholdingCodeId: tdsCode });

    const events = await eventsOf(billId);
    expect(events).toHaveLength(1);
    expect(events[0]!.event).toBe('vendor_bill_posted');
    expect(events[0]!.payload).toMatchObject({
      netTotal: '100000.00',
      vatTotal: '13000.00',
      tdsTotal: '1500.00',
      payableTotal: '111500.00',
    });
    expect((await itemsOf(billId))[0]!.amount).toBe('111500.00');
  });

  it("the line's own withholding code is used when the vendor has no default", async () => {
    const po = await receivedPo(null);
    const { billId, requestId } = await submittedBill(po, tdsCode);
    await approveFully(requestId);

    expect(await billRow(billId)).toMatchObject({
      tdsTotal: '1500.00',
      payableTotal: '111500.00',
      withholdingCodeId: tdsCode,
    });
    expect((await eventsOf(billId))[0]!.payload).toMatchObject({ payableTotal: '111500.00' });
  });

  it('no withholding code: zero TDS and 113,000', async () => {
    const po = await receivedPo(null);
    const { billId, requestId } = await submittedBill(po);
    await approveFully(requestId);

    expect(await billRow(billId)).toMatchObject({
      status: 'approved',
      tdsTotal: '0.00',
      payableTotal: '113000.00',
      payableTotalNpr: '113000.00',
      withholdingCodeId: null,
    });
    expect((await lineRows(billId))[0]!.tdsAmount).toBe('0.00');
    expect((await eventsOf(billId))[0]!.payload).toMatchObject({
      tdsTotal: '0.00',
      payableTotal: '113000.00',
    });
  });
});

// ---------------------------------------------------------------------------------------- R6Q23

describe('a bill of several lines posts the total derived from its lines (R6Q23)', () => {
  it('rounds VAT and TDS per line, and the payable open item is exactly the derived payable total', async () => {
    const vendorId = await vendor(tdsCode);
    const line = (unitPrice: string) => ({
      accountId: expenseAccountId,
      quantity: '1',
      unitPrice,
      taxCodeId: vatCode,
    });
    const bill = await service.create(
      {
        vendorPartyId: vendorId,
        kind: 'bill',
        vendorInvoiceNo: `INV-${randomUUID().slice(0, 8)}`,
        invoiceDate: '2026-11-09',
        currency: 'NPR',
        documentId: await doc(vendorId),
        // Three half-paisa lines: VAT 0.065 -> 0.07 and TDS 0.0075 -> 0.01 on each, where rounding the summed net
        // (1.50) once would give 0.20 and 0.02.
        lines: [line('1000.00'), line('0.50'), line('0.50'), line('0.50')],
      },
      randomUUID(),
    );
    const submitted = await service.submit(bill.id, randomUUID());
    expect(submitted.status).toBe('pending_approval');
    // Entered: the header is the lines' sum, not a typed figure.
    expect(await billRow(bill.id)).toMatchObject({ netTotal: '1001.50', vatTotal: '130.21' });

    await approveFully(submitted.approvalRequestId!);

    const row = await billRow(bill.id);
    expect(row).toMatchObject({
      status: 'approved',
      netTotal: '1001.50',
      vatTotal: '130.21',
      tdsTotal: '15.03',
      payableTotal: '1116.68',
      payableTotalNpr: '1116.68',
    });
    const lines = await lineRows(bill.id);
    const cents = (v: string) => Math.round(Number(v) * 100);
    expect(lines.reduce((sum, l) => sum + cents(l.netAmount), 0)).toBe(cents(row.netTotal));
    expect(lines.reduce((sum, l) => sum + cents(l.vatAmount), 0)).toBe(cents(row.vatTotal));
    expect(lines.reduce((sum, l) => sum + cents(l.tdsAmount), 0)).toBe(cents(row.tdsTotal));
    const items = await itemsOf(bill.id);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ amount: '1116.68', amountNpr: '1116.68' });
    expect((await eventsOf(bill.id))[0]!.payload).toMatchObject({ payableTotal: '1116.68' });
  });
});

// ---------------------------------------------------------------------------------------- check 9

describe('one payable open item per approved bill (check 9)', () => {
  it('opens exactly one credit item on the payable side for the vendor, entity, currency and payable', async () => {
    const po = await receivedPo(tdsCode);
    const { billId, requestId } = await submittedBill(po);
    expect(await itemsOf(billId)).toHaveLength(0);
    await approveFully(requestId);

    const bill = await billRow(billId);
    const items = await itemsOf(billId);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      side: 'payable',
      direction: 'credit',
      vendorPartyId: po.vendorId,
      customerPartyId: null,
      tenantId: scopeA.tenantId,
      organizationId: scopeA.organizationId,
      currency: bill.currency,
      amount: bill.payableTotal,
      amountNpr: bill.payableTotalNpr,
      documentDate: bill.invoiceDate,
    });
  });

  it('a bill that is returned or still pending has no open item', async () => {
    const po = await receivedPo(null);
    const { billId, requestId } = await submittedBill(po);
    await act(U.acct2, 'accountant', requestId, await approveBody(requestId), randomUUID());
    expect(await itemsOf(billId)).toHaveLength(0);
    expect(await eventsOf(billId)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------------- check 11

describe('idempotent posting (check 11)', () => {
  it('two concurrent final approvals: one wins, one item and one event', async () => {
    const po = await receivedPo(tdsCode);
    const { billId, requestId } = await submittedBill(po);
    await act(U.acct2, 'accountant', requestId, await approveBody(requestId), randomUUID());
    const body = await approveBody(requestId);

    const results = await Promise.allSettled([
      act(U.fin, 'finance', requestId, body, randomUUID()),
      act(U.fin, 'finance', requestId, body, randomUUID()),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const loser = results.find((r) => r.status === 'rejected');
    expect((loser as PromiseRejectedResult).reason).toBeInstanceOf(HttpException);

    expect(await itemsOf(billId)).toHaveLength(1);
    expect(await eventsOf(billId)).toHaveLength(1);
  });

  it('a replayed onDecided on an approved bill re-posts from the stored totals and adds nothing', async () => {
    const po = await receivedPo(tdsCode);
    const { billId, requestId } = await submittedBill(po);
    await approveFully(requestId);
    const before = await billRow(billId);

    await withTx(db, scopeA, systemActor('test'), (tx) =>
      subject.onDecided(tx, billId, 'approved'),
    );

    const after = await billRow(billId);
    expect(after.version).toBe(before.version);
    expect(after.payableTotal).toBe('111500.00');
    expect(await itemsOf(billId)).toHaveLength(1);
    expect(await eventsOf(billId)).toHaveLength(1);
  });

  it('a replayed Idempotency-Key on the final approval returns the stored answer and adds nothing', async () => {
    const po = await receivedPo(null);
    const { billId, requestId } = await submittedBill(po);
    await act(U.acct2, 'accountant', requestId, await approveBody(requestId), randomUUID());
    const body = await approveBody(requestId);
    const key = randomUUID();

    const first = await act(U.fin, 'finance', requestId, body, key);
    const replay = await act(U.fin, 'finance', requestId, body, key);
    expect(JSON.parse(JSON.stringify(replay))).toEqual(JSON.parse(JSON.stringify(first)));

    expect(await itemsOf(billId)).toHaveLength(1);
    expect(await eventsOf(billId)).toHaveLength(1);
    expect((await eventsOf(billId))[0]!.payload).toMatchObject({ payableTotal: '113000.00' });
  });

  it('a returned or rejected outcome on an approved bill is refused (409)', async () => {
    const po = await receivedPo(null);
    const { billId, requestId } = await submittedBill(po);
    await approveFully(requestId);
    const refused = await httpErrorOf(
      withTx(db, scopeA, systemActor('test'), (tx) => subject.onDecided(tx, billId, 'rejected')),
    );
    expect(refused).toBeInstanceOf(ConflictException);
    expect(codeOf(refused)).toBe('invalid_transition');
    expect((await billRow(billId)).status).toBe('approved');
  });
});

// ---------------------------------------------------------------------------------------- entity wall

describe('entity wall', () => {
  it('another entity cannot post a bill of this entity and opens no item', async () => {
    const po = await receivedPo(tdsCode);
    const { billId, requestId } = await submittedBill(po);
    await act(U.acct2, 'accountant', requestId, await approveBody(requestId), randomUUID());

    const refused = await httpErrorOf(
      withTx(db, scopeB, systemActor('test'), (tx) => subject.onDecided(tx, billId, 'approved')),
    );
    expect(codeOf(refused)).toBe('not_found');
    expect((await billRow(billId)).status).toBe('pending_approval');
    expect(await itemsOf(billId)).toHaveLength(0);
  });
});
