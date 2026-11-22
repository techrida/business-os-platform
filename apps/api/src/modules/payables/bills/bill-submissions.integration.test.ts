// Integration tests of converting a vendor's portal bill submission into a vendor bill (P4 unit A1d; Journey 11:
// "the portal invoice is converted, matched, then approved") on a real Postgres (Testcontainers, needs Docker in WSL).
// Real: migrations as bos_owner, queries as bos_app (so every 0035 CHECK on vendor_bill_submissions runs),
// VendorBillsService.convertSubmission, BillSubmissionsService (list, reject), the real ApprovalsService with the
// `vendor_bill` workflow, PurchaseOrdersService (issue), ReceiptsService, SettingsService and AuditService. The inbox
// rows are written with the columns VendorPortalInboxService.submitBill writes (received, the vendor's party, the
// file under owner type vendor_portal_intake, a portal user as submitted_by). Faked: notify, the role directory, the
// request context and authz.assert.
// Covers: one bill per convert and a replay, a file that is not clean (409, nothing written), a second convert
// (409), reject with a reason, the entity wall (404), two converts racing, and the bill then matching and being
// submitted like a staff-entered one.
// Run: pnpm --filter @bos/api exec vitest run src/modules/payables/bills/bill-submissions.integration.test.ts
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
  createDepartment,
  createExpenseAccount,
  createParty,
  createPortalUser,
  createStaffUser,
  createTenantWithEntity,
  vendorBills,
  vendorBillSubmissions,
} from '@bos/db';
import { ForbiddenException, HttpException } from '@nestjs/common';
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
import { PurchaseOrdersService } from '../../procurement/orders/purchase-orders.service';
import { ReceiptsService } from '../../procurement/receipts/receipts.service';
import { quotationLineAmounts } from '../../procurement/sourcing/sourcing.rules';
import {
  MATCH_EXCEPTION_DOCUMENT_TYPE,
  MATCH_EXCEPTION_WORKFLOW_SPEC,
  VENDOR_BILL_DOCUMENT_TYPE,
  VENDOR_BILL_WORKFLOW_SPEC,
} from './vendor-bill.rules';
import { MatchExceptionSubject, VendorBillSubject } from './vendor-bill.subject';
import { BillSubmissionsController } from './bill-submissions.controller';
import { BillSubmissionsService } from './bill-submissions.service';
import { VendorBillsService } from './vendor-bills.service';
import { VendorPortalInboxService } from '../../portal-vendor/inbox/portal-vendor-inbox.service';
import { vendorIntakeOwnerPolicy } from '../../portal-vendor/inbox/vendor-intake.policy';
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
let service: VendorBillsService;
let inbox: BillSubmissionsService;
let controller: BillSubmissionsController;
let orders: PurchaseOrdersService;
let receiptsService: ReceiptsService;
let deptA = '';
let vatCode = '';
/** An active expense account of entity A: bill lines must book to one (round 5, unit P1). */
let expenseAccountId = '';
/** The same for entity B, for the bills these tests key in there. */
let expenseAccountB = '';

const U = {
  req: '',
  proc: '',
  acct: '',
  acct2: '',
  fin: '',
  mgmt: '',
  founder: '',
  wh: '',
  portal: '',
};
const roles: Partial<Record<RoleKey, string[]>> = {};

const grantsOf = (role: RoleKey) =>
  new Map(Object.entries(DEFAULT_ROLE_PERMISSIONS[role])) as Map<Permission, Scope>;
const current: { userId: string; role: RoleKey; scope: TxScope | null } = {
  userId: '',
  role: 'accountant',
  scope: null,
};
const as = (userId: string, role: RoleKey) => {
  current.userId = userId;
  current.role = role;
};
const scopeNow = (): TxScope => current.scope ?? scopeA;
/** The active expense account of the acting entity. */
const accountHere = () => (scopeNow() === scopeB ? expenseAccountB : expenseAccountId);
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
  U.portal = (await createPortalUser(appPool, tenant)).userId;
  roles.accountant = [U.acct, U.acct2];
  roles.finance = [U.fin];
  roles.management = [U.mgmt];
  roles.founder = [U.founder];
  deptA = (await createDepartment(appPool, scopeA)).departmentId;

  const { rows } = await exec(
    scopeA,
    sql`INSERT INTO app.tax_codes (tenant_id, code, name, kind, rate_bp, creditable, effective_from)
        VALUES (${scopeA.tenantId}, 'VAT13', 'VAT 13%', 'vat', 1300, true, '2020-01-01') RETURNING id`,
  );
  vatCode = (rows[0] as { id: string }).id;
  expenseAccountId = (await createExpenseAccount(appPool, scopeA)).id;
  expenseAccountB = (await createExpenseAccount(appPool, scopeB)).id;

  const audit = new AuditService(db);
  as(U.founder, 'founder');
  const admin = new ApprovalsAdminService(db, audit, caller, () => now);
  const adminPublisher = new ApprovalsAdminService(db, audit, asSecondPerson(caller), () => now);
  for (const [key, name, spec] of [
    [VENDOR_BILL_DOCUMENT_TYPE, 'Vendor bill', VENDOR_BILL_WORKFLOW_SPEC],
    [MATCH_EXCEPTION_DOCUMENT_TYPE, 'Match exception', MATCH_EXCEPTION_WORKFLOW_SPEC],
  ] as const) {
    await admin.createWorkflow({ key, name, spec });
    await adminPublisher.publish(key, 1, SKIP_LIVE_PUBLISHER_CHECK);
  }

  approvals = new ApprovalsService(db, audit, notify, directory, caller, () => now);
  approvals.registerSubject(new VendorBillSubject(audit, () => now));
  approvals.registerSubject(new MatchExceptionSubject(audit, () => now));
  service = new VendorBillsService(
    db,
    approvals,
    audit,
    new SettingsService(db),
    caller,
    () => now,
  );
  inbox = new BillSubmissionsService(db, audit, caller, () => now);
  controller = new BillSubmissionsController(service, inbox);
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
  current.scope = null;
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
                ${String(300_000_000 + (panSeq += 1))}, 'approved', ${U.proc}, ${U.mgmt})`,
  );
  for (const s of [scopeA, scopeB]) {
    await exec(
      s,
      sql`INSERT INTO app.vendor_accounts (tenant_id, organization_id, vendor_id, active)
          VALUES (${s.tenantId}, ${s.organizationId}, ${partyId}, true)`,
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
/** An issued PO in entity A with one line of `quantity` x `unitPrice` + 13% VAT, received `received`. */
async function receivedPo(quantity: string, unitPrice: string, received: string): Promise<Po> {
  const vendorId = await vendor();
  const a = quotationLineAmounts(quantity, unitPrice, 1300);
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
          estimated_total_npr = ${a.lineTotal}, number = ${`PR-B-${prId.slice(0, 8)}`} WHERE id = ${prId}`,
  );
  const id = randomUUID();
  poSeq += 1;
  await exec(
    scopeA,
    sql`INSERT INTO app.purchase_orders (id, tenant_id, organization_id, number, number_seq, fiscal_year,
          purchase_request_id, vendor_id, currency, payment_terms_days, approved_total, fx_rate,
          approved_total_npr, approved_band, created_by)
        VALUES (${id}, ${scopeA.tenantId}, ${scopeA.organizationId}, ${`PO-B-${poSeq}`}, ${poSeq}, '2082/83',
                ${prId}, ${vendorId}, 'NPR', 30, ${a.lineTotal}, 1, ${a.lineTotal}, 'base', ${U.proc})`,
  );
  const lineId = randomUUID();
  await exec(
    scopeA,
    sql`INSERT INTO app.purchase_order_lines (id, tenant_id, organization_id, purchase_order_id,
          purchase_request_id, line_no, kind, description, uom, ordered_quantity, unit_price, tax_code_id, gross,
          tax_amount, line_total)
        VALUES (${lineId}, ${scopeA.tenantId}, ${scopeA.organizationId}, ${id}, ${prId}, 1, 'goods', 'Laptop',
                'pcs', ${quantity}, ${unitPrice}, ${vatCode}, ${a.gross}, ${a.taxAmount}, ${a.lineTotal})`,
  );
  as(U.proc, 'procurement');
  await orders.issue(id, randomUUID());
  as(U.wh, 'warehouse');
  const r = await receiptsService.create(
    {
      purchaseOrderId: id,
      kind: 'goods',
      receivedAt: '2026-11-09',
      lines: [{ poLineId: lineId, quantity: received }],
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
  return (rows[0] as { id: string }).id;
}

// ---------------------------------------------------------------------------------------- helpers of the inbox

type ScanStatus = 'clean' | 'quarantined' | 'infected';

/**
 * An inbox row as VendorPortalInboxService.submitBill writes it; `versions` are the scan statuses of the file's
 * versions, oldest first (the newest decides). `vendorId: null` is a row no vendor can see.
 */
async function submission(o: {
  vendorId: string | null;
  po?: Po;
  invoiceNo?: string;
  versions?: ScanStatus[];
  scope?: TxScope;
}): Promise<{ id: string; documentId: string; invoiceNo: string }> {
  const scope = o.scope ?? scopeA;
  const invoiceNo = o.invoiceNo ?? `PINV-${randomUUID().slice(0, 8)}`;
  const documentId = randomUUID();
  await exec(
    scope,
    sql`INSERT INTO app.documents (id, tenant_id, organization_id, owner_type, owner_id)
        VALUES (${documentId}, ${scope.tenantId}, ${scope.organizationId}, 'vendor_portal_intake',
                ${o.vendorId ?? randomUUID()})`,
  );
  for (const [i, status] of (o.versions ?? ['clean']).entries()) {
    await exec(
      scope,
      sql`INSERT INTO app.document_versions (tenant_id, organization_id, document_id, version, filename,
            declared_mime, size_bytes, storage_key, status)
          VALUES (${scope.tenantId}, ${scope.organizationId}, ${documentId}, ${i + 1}, 'invoice.pdf',
                  'application/pdf', 1024, ${`${scope.tenantId}/${randomUUID()}`}, ${status})`,
    );
  }
  const { rows } = await exec(
    scope,
    sql`INSERT INTO app.vendor_bill_submissions (tenant_id, organization_id, vendor_party_id, purchase_order_id,
          submitted_by, document_id, vendor_invoice_no, invoice_date)
        VALUES (${scope.tenantId}, ${scope.organizationId}, ${o.vendorId}, ${o.po?.id ?? null}, ${U.portal},
                ${documentId}, ${invoiceNo}, '2026-11-05')
        RETURNING id`,
  );
  return { id: (rows[0] as { id: string }).id, documentId, invoiceNo };
}

const rowOf = async (id: string) =>
  (
    await read((tx) =>
      tx.select().from(vendorBillSubmissions).where(eq(vendorBillSubmissions.id, id)),
    )
  )[0]!;
const billsOf = (vendorId: string) =>
  read((tx) =>
    tx.select({ id: vendorBills.id }).from(vendorBills).where(eq(vendorBills.vendorId, vendorId)),
  );
/** Lines of a PO bill: one line of the PO's line. */
const poLines = (po: Po, quantity = '1', unitPrice = '10000.00') => [
  { poLineId: po.lineId, accountId: accountHere(), quantity, unitPrice, taxCodeId: vatCode },
];
const plainLines = () => [
  { accountId: accountHere(), quantity: '2', unitPrice: '500.00', taxCodeId: vatCode },
];

// ---------------------------------------------------------------------------------------- list
describe('list search and paging', () => {
  it('searches by invoice number or vendor name, pages by offset, counts all matches and stays in the entity', async () => {
    const vendorId = await vendor();
    const name = `Vendor ${vendorId.slice(0, 6)}`;
    const a = await submission({ vendorId, invoiceNo: `FIND-${randomUUID().slice(0, 8)}` });
    const b = await submission({ vendorId });
    const orphan = await submission({ vendorId: null });
    const foreign = await submission({ vendorId, scope: scopeB });
    const ids = (page: { rows: { id: string }[] }) => page.rows.map((r) => r.id);

    const byInvoice = await inbox.list({ offset: 0, q: a.invoiceNo });
    expect(ids(byInvoice)).toContain(a.id);
    const byVendor = await inbox.list({ offset: 0, q: name });
    expect(ids(byVendor)).toEqual(expect.arrayContaining([a.id, b.id]));
    expect(ids(byVendor)).not.toContain(foreign.id);

    // No limit: every received row, the vendorless one included (left join).
    const all = await inbox.list();
    expect(ids(all)).toEqual(expect.arrayContaining([a.id, b.id, orphan.id]));
    const one = await inbox.list({ limit: 1, offset: 1 });
    expect(one.total).toBe(all.total);
    expect(one.rows[0]?.id).toBe(all.rows[1]?.id);
  });
});

// ---------------------------------------------------------------------------------------- convert

describe('convert a bill submission', () => {
  it('returns a discarded conversion to the inbox, permits file editing and converts again', async () => {
    const vendorId = await vendor();
    const sub = await submission({ vendorId });
    const bill = await service.convertSubmission(sub.id, { lines: plainLines() }, randomUUID());
    const policy = vendorIntakeOwnerPolicy(db);
    expect(await policy.canAttach!(scopeA, vendorId, undefined, sub.documentId)).toBe(false);
    const key = randomUUID();
    await service.discard(bill.id, key);
    await service.discard(bill.id, key);
    expect(await rowOf(sub.id)).toMatchObject({ status: 'received', convertedBillId: null });
    expect((await inbox.list()).rows.map((row) => row.id)).toContain(sub.id);
    expect(await policy.canAttach!(scopeA, vendorId, undefined, sub.documentId)).toBe(true);
    const replacement = await service.convertSubmission(
      sub.id,
      { lines: plainLines() },
      randomUUID(),
    );
    expect(replacement.id).not.toBe(bill.id);
    expect(await rowOf(sub.id)).toMatchObject({
      status: 'converted',
      convertedBillId: replacement.id,
    });
    // A late retry of the old discard must not reopen the newly converted submission.
    await service.discard(bill.id, randomUUID());
    expect((await rowOf(sub.id)).convertedBillId).toBe(replacement.id);
    const audit = await ownerPool.query<{ count: string }>(
      "SELECT count(*) FROM audit.audit_events WHERE entity_id = $1 AND action = 'payables.bill_submission.reopened'",
      [sub.id],
    );
    expect(Number(audit.rows[0]?.count)).toBe(1);
  });

  it('creates exactly one matched bill, marks the submission converted and replays to the same bill', async () => {
    const po = await receivedPo('1', '10000.00', '1');
    const sub = await submission({ vendorId: po.vendorId, po, invoiceNo: 'INV-PORTAL-1' });
    const key = randomUUID();

    const lines = poLines(po);
    const bill = await service.convertSubmission(sub.id, { lines }, key);
    expect(bill).toMatchObject({
      vendorPartyId: po.vendorId,
      vendorInvoiceNo: 'INV-PORTAL-1',
      invoiceDate: '2026-11-05',
      purchaseOrderId: po.id,
      documentId: sub.documentId,
      status: 'matching',
      matchStatus: 'matched',
      netTotal: '10000.00',
      enteredBy: U.acct,
    });

    const row = await rowOf(sub.id);
    expect(row).toMatchObject({
      status: 'converted',
      convertedBillId: bill.id,
      reviewedBy: U.acct,
      version: 2,
    });
    expect(row.reviewedAt).not.toBeNull();

    const replay = await service.convertSubmission(sub.id, { lines }, key);
    expect(replay.id).toBe(bill.id);
    expect(await billsOf(po.vendorId)).toHaveLength(1);
  });

  it('turns a submission without a PO into a bill that needs no match', async () => {
    const vendorId = await vendor();
    const sub = await submission({ vendorId });
    const bill = await service.convertSubmission(sub.id, { lines: plainLines() }, randomUUID());
    expect(bill).toMatchObject({
      purchaseOrderId: null,
      matchStatus: 'not_required',
      netTotal: '1000.00',
      vatTotal: '130.00',
    });
    expect((await rowOf(sub.id)).convertedBillId).toBe(bill.id);
  });

  it('lists only the received submissions of the acting entity', async () => {
    const vendorId = await vendor();
    const open = await submission({ vendorId });
    const done = await submission({ vendorId });
    const rejected = await submission({ vendorId });
    const other = await submission({ vendorId, scope: scopeB });
    await service.convertSubmission(done.id, { lines: plainLines() }, randomUUID());
    await inbox.reject(rejected.id, { reason: 'Not our invoice' }, randomUUID());

    const { rows } = await inbox.list();
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(open.id);
    expect(ids).not.toContain(done.id);
    expect(ids).not.toContain(rejected.id);
    expect(ids).not.toContain(other.id);
    expect(rows.find((r) => r.id === open.id)).toMatchObject({
      vendorPartyId: vendorId,
      vendorInvoiceNo: open.invoiceNo,
      invoiceDate: '2026-11-05',
      documentId: open.documentId,
      fileStatus: 'clean',
      status: 'received',
    });
  });

  it('refuses a file that is not clean with 409 and writes nothing', async () => {
    const vendorId = await vendor();
    const cases: ScanStatus[][] = [['clean', 'quarantined'], ['infected'], []];
    for (const versions of cases) {
      const sub = await submission({ vendorId, versions });
      const err = await httpErrorOf(
        service.convertSubmission(sub.id, { lines: plainLines() }, randomUUID()),
      );
      expect(err.getStatus()).toBe(409);
      expect(codeOf(err)).toBe('SUBMISSION_FILE_NOT_CLEAN');
      expect(await rowOf(sub.id)).toMatchObject({
        status: 'received',
        convertedBillId: null,
        version: 1,
      });
    }
    expect(await billsOf(vendorId)).toHaveLength(0);
  });

  it('refuses a second convert, a convert after reject and a reject after convert with 409', async () => {
    const vendorId = await vendor();
    const sub = await submission({ vendorId });
    const bill = await service.convertSubmission(sub.id, { lines: plainLines() }, randomUUID());

    const again = await httpErrorOf(
      service.convertSubmission(sub.id, { lines: plainLines() }, randomUUID()),
    );
    expect(again.getStatus()).toBe(409);
    expect(codeOf(again)).toBe('SUBMISSION_NOT_RECEIVED');
    const rejectAfter = await httpErrorOf(
      inbox.reject(sub.id, { reason: 'Too late' }, randomUUID()),
    );
    expect(rejectAfter.getStatus()).toBe(409);
    expect(codeOf(rejectAfter)).toBe('SUBMISSION_NOT_RECEIVED');
    expect(await billsOf(vendorId)).toEqual([{ id: bill.id }]);

    const rej = await submission({ vendorId });
    await inbox.reject(rej.id, { reason: 'Duplicate upload' }, randomUUID());
    const convertRejected = await httpErrorOf(
      service.convertSubmission(rej.id, { lines: plainLines() }, randomUUID()),
    );
    expect(convertRejected.getStatus()).toBe(409);
    expect(await billsOf(vendorId)).toHaveLength(1);
  });

  it('lets only one of two racing converts win', async () => {
    const vendorId = await vendor();
    const sub = await submission({ vendorId });
    const results = await Promise.allSettled([
      service.convertSubmission(sub.id, { lines: plainLines() }, randomUUID()),
      service.convertSubmission(sub.id, { lines: plainLines() }, randomUUID()),
    ]);
    const won = results.filter((r) => r.status === 'fulfilled');
    const lost = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect((lost[0]!.reason as HttpException).getStatus()).toBe(409);
    expect(await billsOf(vendorId)).toHaveLength(1);
  });

  it('writes nothing when the bill cannot be created (duplicate invoice, bad lines, no vendor)', async () => {
    const vendorId = await vendor();
    await service.create(
      {
        vendorPartyId: vendorId,
        kind: 'bill',
        vendorInvoiceNo: 'INV-TAKEN',
        invoiceDate: '2026-11-05',
        currency: 'NPR',
        documentId: await doc(vendorId),
        lines: plainLines(),
      },
      randomUUID(),
    );
    const dup = await submission({ vendorId, invoiceNo: 'inv taken' });
    const dupErr = await httpErrorOf(
      service.convertSubmission(dup.id, { lines: plainLines() }, randomUUID()),
    );
    expect(dupErr.getStatus()).toBe(409);
    expect(codeOf(dupErr)).toBe('DUPLICATE_BILL');
    expect((await rowOf(dup.id)).status).toBe('received');

    const po = await receivedPo('1', '10000.00', '1');
    const poSub = await submission({ vendorId: po.vendorId, po });
    const noLine = await httpErrorOf(
      service.convertSubmission(poSub.id, { lines: plainLines() }, randomUUID()),
    );
    expect(noLine.getStatus()).toBe(422);
    expect(codeOf(noLine)).toBe('PO_LINE_REQUIRED');
    expect((await rowOf(poSub.id)).status).toBe('received');
    expect(await billsOf(po.vendorId)).toHaveLength(0);

    const orphan = await submission({ vendorId: null });
    const noVendor = await httpErrorOf(
      service.convertSubmission(orphan.id, { lines: plainLines() }, randomUUID()),
    );
    expect(noVendor.getStatus()).toBe(422);
    expect(codeOf(noVendor)).toBe('SUBMISSION_HAS_NO_VENDOR');

    const bare = await submission({ vendorId });
    await exec(
      scopeA,
      sql`UPDATE app.vendor_bill_submissions SET vendor_invoice_no = NULL WHERE id = ${bare.id}`,
    );
    const noNumber = await httpErrorOf(
      service.convertSubmission(bare.id, { lines: plainLines() }, randomUUID()),
    );
    expect(noNumber.getStatus()).toBe(422);
    expect(codeOf(noNumber)).toBe('SUBMISSION_INCOMPLETE');
    expect(await billsOf(vendorId)).toHaveLength(1);
  });

  it('refuses a line booked to an expense account that is not usable here with 422 and writes nothing', async () => {
    const vendorId = await vendor();
    const sub = await submission({ vendorId });
    const retired = (await createExpenseAccount(appPool, { ...scopeA, status: 'retired' })).id;
    const foreign = (await createExpenseAccount(appPool, scopeB)).id;
    for (const accountId of [randomUUID(), retired, foreign]) {
      const e = await httpErrorOf(
        controller.convert(sub.id, randomUUID(), {
          lines: [{ ...plainLines()[0]!, accountId }],
        }),
      );
      expect(e.getStatus()).toBe(422);
      expect(codeOf(e)).toBe('EXPENSE_ACCOUNT_INVALID');
    }
    expect(await rowOf(sub.id)).toMatchObject({ status: 'received', convertedBillId: null });
    expect(await billsOf(vendorId)).toHaveLength(0);
    const audit = await ownerPool.query<{ count: string }>(
      "SELECT count(*) FROM audit.audit_events WHERE entity_id = $1 AND action = 'payables.bill_submission.converted'",
      [sub.id],
    );
    expect(Number(audit.rows[0]?.count)).toBe(0);

    // The same submission converts once its lines name an active account of this entity.
    const bill = await controller.convert(sub.id, randomUUID(), { lines: plainLines() });
    expect((await rowOf(sub.id)).convertedBillId).toBe(bill.id);
  });

  it('answers 404 for a submission of another entity and leaves it untouched', async () => {
    const vendorId = await vendor();
    const sub = await submission({ vendorId, scope: scopeB });

    const convert = await httpErrorOf(
      service.convertSubmission(sub.id, { lines: plainLines() }, randomUUID()),
    );
    expect(convert.getStatus()).toBe(404);
    const reject = await httpErrorOf(inbox.reject(sub.id, { reason: 'Not ours' }, randomUUID()));
    expect(reject.getStatus()).toBe(404);
    expect(await rowOf(sub.id)).toMatchObject({ status: 'received', convertedBillId: null });

    current.scope = scopeB;
    expect((await inbox.list()).rows.map((r) => r.id)).toContain(sub.id);
    const bill = await service.convertSubmission(sub.id, { lines: plainLines() }, randomUUID());
    expect(bill.vendorPartyId).toBe(vendorId);
  });

  it('keys a bill from a submission through POST /bills too, when the body is the submission', async () => {
    const vendorId = await vendor();
    const sub = await submission({ vendorId, invoiceNo: 'INV-SRC-1' });
    const body = {
      vendorPartyId: vendorId,
      kind: 'bill' as const,
      vendorInvoiceNo: 'INV-SRC-1',
      invoiceDate: '2026-11-05',
      currency: 'NPR' as const,
      documentId: sub.documentId,
      sourceSubmissionId: sub.id,
      lines: plainLines(),
    };
    const mismatch = await httpErrorOf(
      service.create({ ...body, vendorInvoiceNo: 'INV-OTHER' }, randomUUID()),
    );
    expect(mismatch.getStatus()).toBe(422);
    expect(codeOf(mismatch)).toBe('SUBMISSION_MISMATCH');
    expect((await rowOf(sub.id)).status).toBe('received');

    const bill = await service.create(body, randomUUID());
    expect((await rowOf(sub.id)).convertedBillId).toBe(bill.id);
  });
});

// ---------------------------------------------------------------------------------------- reject

describe('reject a bill submission', () => {
  it('marks it rejected with the reason and the reviewer, and needs a reason', async () => {
    const vendorId = await vendor();
    const sub = await submission({ vendorId });
    const key = randomUUID();
    const done = await inbox.reject(sub.id, { reason: 'Wrong entity on the invoice' }, key);
    expect(done).toMatchObject({ id: sub.id, status: 'rejected' });
    expect(await rowOf(sub.id)).toMatchObject({
      status: 'rejected',
      rejectionReason: 'Wrong entity on the invoice',
      reviewedBy: U.acct,
      version: 2,
    });
    const replay = await inbox.reject(sub.id, { reason: 'Wrong entity on the invoice' }, key);
    expect(replay.id).toBe(sub.id);

    const second = await submission({ vendorId });
    for (const body of [{}, { reason: '' }, { reason: '   ' }, { reason: 'x', extra: 1 }]) {
      const err = await httpErrorOf(
        Promise.resolve().then(() => controller.reject(second.id, randomUUID(), body)),
      );
      expect(err.getStatus()).toBe(400);
    }
    const noKey = await httpErrorOf(
      Promise.resolve().then(() => controller.reject(second.id, undefined, { reason: 'No key' })),
    );
    expect(noKey.getStatus()).toBe(400);
    expect((await rowOf(second.id)).status).toBe('received');
  });
});

// ---------------------------------------------------------------------------------------- journey 11

describe('the converted bill is a staff-entered bill (Journey 11)', () => {
  it('matches within tolerance and goes to approval', async () => {
    const po = await receivedPo('1', '10000.00', '1');
    const sub = await submission({ vendorId: po.vendorId, po });
    const bill = await service.convertSubmission(sub.id, { lines: poLines(po) }, randomUUID());
    expect(bill.matchStatus).toBe('matched');
    const submitted = await service.submit(bill.id, randomUUID());
    expect(submitted.status).toBe('pending_approval');
    expect(submitted.approvalRequestId).not.toBeNull();
  });

  it('shows variance and refuses submit when the lines are 10% over the price', async () => {
    const po = await receivedPo('1', '10000.00', '1');
    const sub = await submission({ vendorId: po.vendorId, po });
    const bill = await service.convertSubmission(
      sub.id,
      { lines: poLines(po, '1', '11000.00') },
      randomUUID(),
    );
    expect(bill.status).toBe('variance');
    const refused = await httpErrorOf(service.submit(bill.id, randomUUID()));
    expect(refused.getStatus()).toBe(409);
    expect(codeOf(refused)).toBe('BILL_NOT_MATCHED');
  });
});

// ---------------------------------------------------------------------------------------- I-33 duplicates

describe('duplicate invoice numbers in the inbox (I-33, a warning, not a block)', () => {
  /** A bill the vendor sends through the real portal producer (VendorPortalInboxService.submitBill). */
  async function portalBill(vendorId: string, invoiceNo: string, claimedTotal: string) {
    const documentId = randomUUID();
    await exec(
      scopeA,
      sql`INSERT INTO app.documents (id, tenant_id, organization_id, owner_type, owner_id)
          VALUES (${documentId}, ${scopeA.tenantId}, ${scopeA.organizationId}, 'vendor_portal_intake', ${vendorId})`,
    );
    await exec(
      scopeA,
      sql`INSERT INTO app.document_versions (tenant_id, organization_id, document_id, version, filename,
            declared_mime, size_bytes, storage_key, status)
          VALUES (${scopeA.tenantId}, ${scopeA.organizationId}, ${documentId}, 1, 'invoice.pdf',
                  'application/pdf', 1024, ${`${scopeA.tenantId}/${randomUUID()}`}, 'clean')`,
    );
    const vendorCaller = {
      current: () => ({
        ...principalNow(),
        userId: U.portal,
        orgKind: 'vendor' as const,
        partyId: vendorId,
        roles: ['vendor_user'],
        grants: new Map<Permission, Scope>([
          ['portal.vendor.read', 'customer_org'],
          ['portal.vendor.submit', 'customer_org'],
        ]),
      }),
    };
    const portal = new VendorPortalInboxService(
      db,
      {} as never,
      new AuditService(db),
      vendorCaller as never,
      {} as never,
    );
    return portal.submitBill(
      { scope: scopeA, actor: { kind: 'user', id: U.portal, correlationId: 'portal-corr' } },
      {
        vendorInvoiceNo: invoiceNo,
        invoiceDate: '2026-11-05',
        currency: 'NPR',
        claimedTotal,
        documentId,
      },
      randomUUID(),
    );
  }
  const rowIn = async (id: string) => (await inbox.list()).rows.find((r) => r.id === id)!;

  it("shows a submission's claimed amount and flags another submission of the same vendor and invoice number", async () => {
    const vendorId = await vendor();
    const first = await portalBill(vendorId, 'INV-0042', '112999.00');
    const second = await portalBill(vendorId, 'inv 0042', '100.00');

    const a = await rowIn(first.id);
    expect(a).toMatchObject({ claimedTotal: '112999.00', currency: 'NPR' });
    expect(a.duplicates).toEqual([
      expect.objectContaining({ kind: 'submission', id: second.id, amount: '100.00' }),
    ]);
    const b = await rowIn(second.id);
    expect(b.duplicates).toEqual([
      expect.objectContaining({
        kind: 'submission',
        id: first.id,
        number: null,
        vendorInvoiceNo: 'INV-0042',
        status: 'received',
        amount: '112999.00',
        currency: 'NPR',
      }),
    ]);
  });

  it('flags a submission whose invoice number is already on a bill of that vendor, by bill and amount', async () => {
    const vendorId = await vendor();
    const first = await portalBill(vendorId, 'INV-77', '1130.00');
    const bill = await service.convertSubmission(first.id, { lines: plainLines() }, randomUUID());
    const again = await portalBill(vendorId, 'INV-77', '1130.00');
    const row = await rowIn(again.id);
    expect(row.duplicates).toEqual([
      expect.objectContaining({
        kind: 'bill',
        id: bill.id,
        vendorInvoiceNo: 'INV-77',
        amount: '1130.00',
        currency: 'NPR',
      }),
    ]);
  });

  it('does not flag the same invoice number from a different vendor', async () => {
    const one = await vendor();
    const two = await vendor();
    await portalBill(one, 'INV-SAME', '10.00');
    const theirs = await portalBill(two, 'INV-SAME', '10.00');
    expect((await rowIn(theirs.id)).duplicates).toEqual([]);
  });

  it('does not flag against an earlier submission that was rejected', async () => {
    const vendorId = await vendor();
    const first = await portalBill(vendorId, 'INV-R1', '10.00');
    await inbox.reject(first.id, { reason: 'Wrong amount' }, randomUUID());
    const second = await portalBill(vendorId, 'INV-R1', '12.00');
    expect((await rowIn(second.id)).duplicates).toEqual([]);
  });
});

describe('invoice date of a portal bill (FX6 #6): today in Kathmandu at the latest', () => {
  /** The vendor's own submission through the real portal producer, on a clock at `at`. */
  async function portalSubmit(vendorId: string, invoiceDate: string, at: Date) {
    const documentId = randomUUID();
    await exec(
      scopeA,
      sql`INSERT INTO app.documents (id, tenant_id, organization_id, owner_type, owner_id)
          VALUES (${documentId}, ${scopeA.tenantId}, ${scopeA.organizationId}, 'vendor_portal_intake', ${vendorId})`,
    );
    await exec(
      scopeA,
      sql`INSERT INTO app.document_versions (tenant_id, organization_id, document_id, version, filename,
            declared_mime, size_bytes, storage_key, status)
          VALUES (${scopeA.tenantId}, ${scopeA.organizationId}, ${documentId}, 1, 'invoice.pdf',
                  'application/pdf', 1024, ${`${scopeA.tenantId}/${randomUUID()}`}, 'clean')`,
    );
    const vendorCaller = {
      current: () => ({
        ...principalNow(),
        userId: U.portal,
        orgKind: 'vendor' as const,
        partyId: vendorId,
        roles: ['vendor_user'],
        grants: new Map<Permission, Scope>([
          ['portal.vendor.read', 'customer_org'],
          ['portal.vendor.submit', 'customer_org'],
        ]),
      }),
    };
    const portal = new VendorPortalInboxService(
      db,
      {} as never,
      new AuditService(db),
      vendorCaller as never,
      {} as never,
      undefined,
      () => at,
    );
    return portal.submitBill(
      { scope: scopeA, actor: { kind: 'user', id: U.portal, correlationId: 'portal-corr' } },
      {
        vendorInvoiceNo: `PINV-${randomUUID().slice(0, 8)}`,
        invoiceDate,
        currency: 'NPR',
        claimedTotal: '1130.00',
        documentId,
      },
      randomUUID(),
    );
  }
  const submissionsOf = (vendorId: string) =>
    read((tx) =>
      tx
        .select({ id: vendorBillSubmissions.id, invoiceDate: vendorBillSubmissions.invoiceDate })
        .from(vendorBillSubmissions)
        .where(eq(vendorBillSubmissions.vendorPartyId, vendorId)),
    );

  it('refuses a vendor submission dated tomorrow with 422 BILL_DATE_IN_FUTURE and takes today', async () => {
    const vendorId = await vendor();
    // 18:14:59 UTC is the last second of 9 November in Kathmandu (UTC+05:45).
    const lastSecondOfNov9 = new Date('2026-11-09T18:14:59Z');

    const refused = await httpErrorOf(portalSubmit(vendorId, '2026-11-10', lastSecondOfNov9));
    expect(refused.getStatus()).toBe(422);
    expect(refused.getResponse()).toMatchObject({
      code: 'BILL_DATE_IN_FUTURE',
      details: { invoiceDate: '2026-11-10', today: '2026-11-09' },
    });
    expect(await submissionsOf(vendorId)).toEqual([]);

    const ok = await portalSubmit(vendorId, '2026-11-09', lastSecondOfNov9);
    expect(await submissionsOf(vendorId)).toEqual([{ id: ok.id, invoiceDate: '2026-11-09' }]);
    // A second later it is 10 November there, and that date is taken.
    await portalSubmit(vendorId, '2026-11-10', new Date('2026-11-09T18:15:00Z'));
    expect(await submissionsOf(vendorId)).toHaveLength(2);
  });

  it('refuses to convert a stored submission dated after today, leaving it in the inbox', async () => {
    const vendorId = await vendor();
    const sub = await submission({ vendorId });
    // A row saved before the rule can carry a later date; the service clock reads 9 November in Kathmandu.
    await exec(
      scopeA,
      sql`UPDATE app.vendor_bill_submissions SET invoice_date = '2026-11-10' WHERE id = ${sub.id}`,
    );

    const refused = await httpErrorOf(
      service.convertSubmission(sub.id, { lines: plainLines() }, randomUUID()),
    );
    expect(refused.getStatus()).toBe(422);
    expect((refused.getResponse() as { code?: string }).code).toBe('BILL_DATE_IN_FUTURE');
    expect(await rowOf(sub.id)).toMatchObject({ status: 'received', convertedBillId: null });
    expect(await billsOf(vendorId)).toEqual([]);
  });
});
