// Integration tests of voiding a vendor bill, the purchase VAT register and the parallel-bills match race (P4 unit
// A1c) on a real Postgres (Testcontainers, needs Docker in WSL).
// Real: migrations as bos_owner, queries as bos_app (so every 0019 and 0035 CHECK and trigger runs, the allocation
// cap included), VendorBillsService, LedgerService, PurchaseOrdersService (issue), ReceiptsService (receipts feed
// v_po_line_progress), SettingsService (AD6 defaults) and AuditService. Faked: notify, the role directory, the request
// context and authz.assert (the real pure can()).
// Posting an approved bill is another unit's: these tests set a bill approved by hand and open its payable credit
// item through LedgerService.openItem, the same call the posting unit makes.
// Covers: void (debit note allocated, open amount 0, event recorded, second void 409, a pending or approved payment
// request on the bill 409, entity wall 404), done check 17
// (the register total equals the creditable VAT on approved bills) and two bills entered at once against one receipt
// (one matches, the other shows the quantity variance).
// Run: pnpm --filter @bos/api exec vitest run src/modules/payables/bills/vendor-bills-void.integration.test.ts
import 'reflect-metadata';

import { randomUUID } from 'node:crypto';

import {
  DEFAULT_ROLE_PERMISSIONS,
  type BillStatus,
  type Permission,
  type RoleKey,
  type Scope,
} from '@bos/contracts';
import {
  createCostCenter,
  createDepartment,
  createParty,
  createStaffUser,
  createTenantWithEntity,
  openItemAllocations,
  openItems,
  postingEvents,
  vendorBills,
  vendors,
} from '@bos/db';
import { formatBs } from '@bos/locale';
import { ForbiddenException, HttpException } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
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
import {
  MATCH_EXCEPTION_DOCUMENT_TYPE,
  MATCH_EXCEPTION_WORKFLOW_SPEC,
  VENDOR_BILL_DOCUMENT_TYPE,
  VENDOR_BILL_WORKFLOW_SPEC,
} from './vendor-bill.rules';
import { MatchExceptionSubject, VendorBillSubject } from './vendor-bill.subject';
import { VendorBillsService, type VendorBillDto } from './vendor-bills.service';
import { createTestDatabase, type TestDatabase } from '@bos/db/testing';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 180_000 });

const now = new Date('2026-11-09T04:00:00Z');

let testDb: TestDatabase;
let ownerPool: Pool;
let appPool: Pool;
/** The container's superuser, for the race test's table lock and its pg_locks reads. */
let superPool: Pool;
const ledger = new LedgerService();
let exemptCode = '';
let nonCreditableCode = '';
let db: Db;
let scopeA: TxScope;
let scopeB: TxScope;
let approvals: ApprovalsService;
let service: VendorBillsService;
let orders: PurchaseOrdersService;
let receiptsService: ReceiptsService;
let deptA = '';
let vatCode = '';

const U = { req: '', proc: '', acct: '', acct2: '', fin: '', mgmt: '', founder: '', wh: '' };
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
  superPool = new Pool({ connectionString: testDb.adminUrl, max: 2 });
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

  const { rows } = await exec(
    scopeA,
    sql`INSERT INTO app.tax_codes (tenant_id, code, name, kind, rate_bp, creditable, effective_from)
        VALUES (${scopeA.tenantId}, 'VAT13', 'VAT 13%', 'vat', 1300, true, '2020-01-01') RETURNING id`,
  );
  vatCode = (rows[0] as { id: string }).id;
  const extra = await exec(
    scopeA,
    sql`INSERT INTO app.tax_codes (tenant_id, code, name, kind, rate_bp, creditable, effective_from)
        VALUES (${scopeA.tenantId}, 'EXEMPT', 'Exempt', 'exempt', 0, false, '2020-01-01'),
               (${scopeA.tenantId}, 'VAT13-NC', 'VAT 13% not claimable', 'vat', 1300, false, '2020-01-01')
        RETURNING id, code`,
  );
  for (const row of extra.rows as { id: string; code: string }[]) {
    if (row.code === 'EXEMPT') exemptCode = row.id;
    else nonCreditableCode = row.id;
  }

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
    ledger,
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
  await superPool?.end();
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
  const s = scopeNow();
  const { rows } = await exec(
    s,
    sql`INSERT INTO app.documents (tenant_id, organization_id, owner_type, owner_id)
        VALUES (${s.tenantId}, ${s.organizationId}, 'vendor_bill_intake', ${vendorId}) RETURNING id`,
  );
  return (rows[0] as { id: string }).id;
}

async function billFor(
  po: Po,
  quantity: string,
  unitPrice: string,
  vendorInvoiceNo = `INV-${randomUUID().slice(0, 8)}`,
  key = randomUUID(),
) {
  return service.create(
    {
      vendorPartyId: po.vendorId,
      kind: 'bill',
      vendorInvoiceNo,
      invoiceDate: '2026-11-09',
      currency: 'NPR',
      purchaseOrderId: po.id,
      documentId: await doc(po.vendorId),
      lines: [
        { poLineId: po.lineId, accountId: randomUUID(), quantity, unitPrice, taxCodeId: vatCode },
      ],
    },
    key,
  );
}

interface LineSpec {
  quantity: string;
  unitPrice: string;
  taxCodeId: string;
}

/** A bill without a PO, of a fresh vendor, in the caller's entity (draft). */
async function plainBill(lines: LineSpec[], invoiceDate = '2026-11-09'): Promise<VendorBillDto> {
  const vendorId = await vendor();
  return service.create(
    {
      vendorPartyId: vendorId,
      kind: 'bill',
      vendorInvoiceNo: `INV-${randomUUID().slice(0, 8)}`,
      invoiceDate,
      currency: 'NPR',
      documentId: await doc(vendorId),
      lines: lines.map((l) => ({ accountId: randomUUID(), ...l })),
    },
    randomUUID(),
  );
}

/** Moves a bill to `status` by hand (approval and payment are other units'). */
async function setStatus(billId: string, status: BillStatus, scope: TxScope = scopeA) {
  await exec(
    scope,
    status === 'voided'
      ? sql`UPDATE app.vendor_bills SET status = 'voided', voided_by = ${U.acct}, voided_at = now(),
              void_reason = 'Entered twice' WHERE id = ${billId}`
      : sql`UPDATE app.vendor_bills SET status = ${status} WHERE id = ${billId}`,
  );
}

/** What the posting unit does on approval: the bill approved and its payable CREDIT open item opened. */
async function postBill(bill: VendorBillDto, scope: TxScope = scopeA): Promise<string> {
  await setStatus(bill.id, 'approved', scope);
  const { item } = await withTx(db, scope, systemActor('test'), (tx) =>
    ledger.openItem(tx, scope, systemActor('test'), {
      side: 'payable',
      direction: 'credit',
      partyId: bill.vendorPartyId,
      sourceType: 'vendor_bill',
      sourceId: bill.id,
      currency: 'NPR',
      amount: bill.payableTotal,
      amountNpr: bill.payableTotal,
      fxRate: '1',
      documentDate: bill.invoiceDate,
    }),
  );
  return item.id;
}

const billRow = async (id: string) =>
  (await read((tx) => tx.select().from(vendorBills).where(eq(vendorBills.id, id))))[0]!;
const debitNotesOf = (billId: string) =>
  read((tx) =>
    tx
      .select()
      .from(openItems)
      .where(and(eq(openItems.sourceType, 'vendor_debit_note'), eq(openItems.sourceId, billId))),
  );

/** A payment request of the bill's vendor in `status` with one line on the bill's open item (raw SQL fixture). */
async function requestOn(
  bill: VendorBillDto,
  openItemId: string,
  status: 'draft' | 'pending_approval' | 'approved' | 'rejected' | 'cancelled',
): Promise<string> {
  const bankId = randomUUID();
  await exec(
    scopeA,
    sql`INSERT INTO app.vendor_bank_accounts (id, tenant_id, vendor_id, bank_name, account_name,
          account_number_enc, account_fingerprint, last4, status, proposed_by, proposed_via)
        VALUES (${bankId}, ${scopeA.tenantId}, ${bill.vendorPartyId}, 'Nabil Bank', 'Vendor Pvt Ltd',
                decode('00', 'hex'), ${`fp-${randomUUID()}`}, '1234', 'proposed', ${U.proc}, 'staff')`,
  );
  const requestId = randomUUID();
  await exec(
    scopeA,
    sql`INSERT INTO app.payment_requests (id, tenant_id, organization_id, vendor_id, payment_type, currency,
          total_amount, from_bank_account_id, vendor_bank_account_id, bank_last4, status, requested_by,
          cancel_reason)
        VALUES (${requestId}, ${scopeA.tenantId}, ${scopeA.organizationId}, ${bill.vendorPartyId}, 'settlement',
                'NPR', ${bill.payableTotal}, ${randomUUID()}, ${bankId}, '1234', ${status}, ${U.acct},
                ${status === 'cancelled' ? 'Changed our mind' : null})`,
  );
  await exec(
    scopeA,
    sql`INSERT INTO app.payment_request_lines (tenant_id, organization_id, payment_request_id, line_no,
          open_item_id, amount)
        VALUES (${scopeA.tenantId}, ${scopeA.organizationId}, ${requestId}, 1, ${openItemId},
                ${bill.payableTotal})`,
  );
  return requestId;
}

// ---------------------------------------------------------------------------------------- void

describe('void (P3 vendor_debit_note, allocated against the bill)', () => {
  it('opens a debit note for the full amount, allocates it, records the event and voids the bill', async () => {
    const bill = await plainBill([{ quantity: '2', unitPrice: '500.00', taxCodeId: vatCode }]);
    expect(bill.payableTotal).toBe('1130.00');
    const creditId = await postBill(bill);
    const key = randomUUID();

    const voided = await service.void(bill.id, { reason: 'Entered against the wrong vendor' }, key);

    expect(voided.status).toBe('voided');
    const row = await billRow(bill.id);
    expect(row).toMatchObject({
      status: 'voided',
      voidedBy: U.acct,
      voidReason: 'Entered against the wrong vendor',
    });
    expect(row.voidedAt).not.toBeNull();
    const notes = await debitNotesOf(bill.id);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({
      side: 'payable',
      direction: 'debit',
      vendorPartyId: bill.vendorPartyId,
      amount: '1130.00',
    });
    const allocations = await read((tx) =>
      tx.select().from(openItemAllocations).where(eq(openItemAllocations.creditItemId, creditId)),
    );
    expect(allocations).toHaveLength(1);
    expect(allocations[0]).toMatchObject({
      debitItemId: notes[0]!.id,
      amount: '1130.00',
      createdBy: U.acct,
    });
    const open = await read((tx) => ledger.openAmounts(tx, scopeA, [creditId, notes[0]!.id]));
    expect(open.get(creditId)).toBe('0.00');
    expect(open.get(notes[0]!.id)).toBe('0.00');
    const events = await read((tx) =>
      tx
        .select()
        .from(postingEvents)
        .where(
          and(
            eq(postingEvents.sourceId, bill.id),
            eq(postingEvents.event, 'vendor_debit_note_issued'),
          ),
        ),
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.sourceType).toBe('vendor_debit_note');

    // A replay of the same command answers the same, without a second debit note.
    const replay = await service.void(bill.id, { reason: 'Entered against the wrong vendor' }, key);
    expect(replay.status).toBe('voided');
    expect(await debitNotesOf(bill.id)).toHaveLength(1);

    // A second void (new key) is refused.
    const again = await httpErrorOf(service.void(bill.id, { reason: 'Again' }, randomUUID()));
    expect(again.getStatus()).toBe(409);
    expect(codeOf(again)).toBe('invalid_transition');
  });

  it('refuses a bill that is not approved, and an approved bill that was never posted (409)', async () => {
    const draft = await plainBill([{ quantity: '1', unitPrice: '100.00', taxCodeId: vatCode }]);
    const e1 = await httpErrorOf(service.void(draft.id, { reason: 'Wrong' }, randomUUID()));
    expect(e1.getStatus()).toBe(409);
    expect(codeOf(e1)).toBe('invalid_transition');

    await setStatus(draft.id, 'approved');
    const e2 = await httpErrorOf(service.void(draft.id, { reason: 'Wrong' }, randomUUID()));
    expect(e2.getStatus()).toBe(409);
    expect(codeOf(e2)).toBe('BILL_NOT_POSTED');
    expect((await billRow(draft.id)).status).toBe('approved');
    expect(await debitNotesOf(draft.id)).toHaveLength(0);
  });

  it('refuses a bill with a payment allocated against it (409) and leaves it approved', async () => {
    const bill = await plainBill([{ quantity: '1', unitPrice: '1000.00', taxCodeId: vatCode }]);
    const creditId = await postBill(bill);
    await withTx(db, scopeA, systemActor('test'), async (tx) => {
      const { item } = await ledger.openItem(tx, scopeA, systemActor('test'), {
        side: 'payable',
        direction: 'debit',
        partyId: bill.vendorPartyId,
        sourceType: 'vendor_payment',
        sourceId: randomUUID(),
        currency: 'NPR',
        amount: '100.00',
        amountNpr: '100.00',
        fxRate: '1',
        documentDate: '2026-11-09',
      });
      await ledger.allocate(tx, scopeA, systemActor('test'), {
        debitItemId: item.id,
        creditItemId: creditId,
        amount: '100.00',
      });
    });

    const e = await httpErrorOf(service.void(bill.id, { reason: 'Wrong' }, randomUUID()));
    expect(e.getStatus()).toBe(409);
    expect(codeOf(e)).toBe('BILL_HAS_ALLOCATIONS');
    expect((await billRow(bill.id)).status).toBe('approved');
    expect(await debitNotesOf(bill.id)).toHaveLength(0);
  });

  it.each(['pending_approval', 'approved'] as const)(
    'refuses a bill whose payment request is %s (409 BILL_HAS_PAYMENT_REQUEST) and leaves it approved',
    async (status) => {
      const bill = await plainBill([{ quantity: '1', unitPrice: '1000.00', taxCodeId: vatCode }]);
      const creditId = await postBill(bill);
      await requestOn(bill, creditId, status);

      const e = await httpErrorOf(service.void(bill.id, { reason: 'Wrong' }, randomUUID()));

      expect(e.getStatus()).toBe(409);
      expect(codeOf(e)).toBe('BILL_HAS_PAYMENT_REQUEST');
      expect((await billRow(bill.id)).status).toBe('approved');
      expect(await debitNotesOf(bill.id)).toHaveLength(0);
    },
  );

  it.each(['draft', 'rejected', 'cancelled'] as const)(
    'voids a bill whose only payment request is %s (it holds no claim)',
    async (status) => {
      const bill = await plainBill([{ quantity: '1', unitPrice: '1000.00', taxCodeId: vatCode }]);
      const creditId = await postBill(bill);
      await requestOn(bill, creditId, status);

      const voided = await service.void(bill.id, { reason: 'Entered twice' }, randomUUID());

      expect(voided.status).toBe('voided');
      expect(await debitNotesOf(bill.id)).toHaveLength(1);
    },
  );

  it('does not let a payment request on another bill block the void', async () => {
    const bill = await plainBill([{ quantity: '1', unitPrice: '1000.00', taxCodeId: vatCode }]);
    await postBill(bill);
    const other = await plainBill([{ quantity: '1', unitPrice: '500.00', taxCodeId: vatCode }]);
    await requestOn(other, await postBill(other), 'approved');

    const voided = await service.void(bill.id, { reason: 'Entered twice' }, randomUUID());

    expect(voided.status).toBe('voided');
  });

  it('answers 404 for a bill of another entity', async () => {
    current.scope = scopeB;
    const bill = await plainBill([{ quantity: '1', unitPrice: '100.00', taxCodeId: vatCode }]);
    await postBill(bill, scopeB);
    current.scope = null;
    const e = await httpErrorOf(service.void(bill.id, { reason: 'Wrong' }, randomUUID()));
    expect(e.getStatus()).toBe(404);
    current.scope = scopeB;
    expect((await service.get(bill.id)).status).toBe('approved');
  });
});

// ---------------------------------------------------------------------------------------- check 17

describe('purchase VAT register (check 17)', () => {
  it('lists approved bills of the period with PAN, invoice number, BS date, taxable and creditable VAT', async () => {
    const vat = (quantity: string, unitPrice: string): LineSpec => ({
      quantity,
      unitPrice,
      taxCodeId: vatCode,
    });
    // In: approved with an exempt line, partially paid with a VAT line that cannot be claimed, paid on the last day.
    const a = await plainBill(
      [vat('1', '1000.00'), { quantity: '1', unitPrice: '500.00', taxCodeId: exemptCode }],
      '2026-03-05',
    );
    const b = await plainBill(
      [vat('2', '250.00'), { quantity: '1', unitPrice: '2000.00', taxCodeId: nonCreditableCode }],
      '2026-03-10',
    );
    const c = await plainBill([vat('1', '100.00')], '2026-03-31');
    await setStatus(a.id, 'approved');
    await setStatus(b.id, 'partially_paid');
    await setStatus(c.id, 'paid');
    // Out: voided, draft, pending approval, outside the period, another entity.
    const voided = await plainBill([vat('1', '10000.00')], '2026-03-12');
    await setStatus(voided.id, 'voided');
    await plainBill([vat('1', '7000.00')], '2026-03-15');
    const pending = await plainBill([vat('1', '6000.00')], '2026-03-16');
    await setStatus(pending.id, 'pending_approval');
    for (const date of ['2026-02-28', '2026-04-01']) {
      await setStatus((await plainBill([vat('1', '5000.00')], date)).id, 'approved');
    }
    current.scope = scopeB;
    const other = await plainBill([vat('1', '4000.00')], '2026-03-05');
    await setStatus(other.id, 'approved', scopeB);
    current.scope = null;

    const register = await service.vatRegister('2026-03-01', '2026-03-31');

    expect(register.rows.map((r) => r.vendorBillId)).toEqual([a.id, b.id, c.id]);
    const pans = await read((tx) => tx.select({ id: vendors.id, pan: vendors.pan }).from(vendors));
    const panOf = new Map(pans.map((p) => [p.id, p.pan]));
    expect(register.rows[0]).toMatchObject({
      vendorPan: panOf.get(a.vendorPartyId),
      vendorInvoiceNo: a.vendorInvoiceNo,
      invoiceDate: '2026-03-05',
      invoiceDateBs: formatBs(new Date('2026-03-05T00:00:00+05:45'), 'YYYY-MM-DD'),
      taxableAmount: '1000.00',
      vatAmount: '130.00',
    });
    expect(register.rows[1]).toMatchObject({ taxableAmount: '500.00', vatAmount: '65.00' });
    expect(register.rows[2]).toMatchObject({ taxableAmount: '100.00', vatAmount: '13.00' });
    expect(register.total).toEqual({ taxableAmount: '1600.00', vatAmount: '208.00' });

    // The total equals the creditable VAT on approved bills of the period, summed straight from the tables.
    const { rows } = await exec(
      scopeA,
      sql`SELECT COALESCE(sum(bl.vat_amount), 0)::numeric(18, 2)::text AS vat
          FROM app.vendor_bill_lines bl
          JOIN app.vendor_bills vb ON vb.id = bl.vendor_bill_id
          JOIN app.tax_codes tc ON tc.id = bl.tax_code_id
          WHERE vb.tenant_id = ${scopeA.tenantId} AND vb.organization_id = ${scopeA.organizationId}
            AND vb.status IN ('approved', 'partially_paid', 'paid') AND tc.creditable
            AND vb.invoice_date BETWEEN '2026-03-01' AND '2026-03-31'`,
    );
    expect(register.total.vatAmount).toBe((rows[0] as { vat: string }).vat);
  });
});

// ---------------------------------------------------------------------------------------- race

/**
 * Polls pg_locks until `n` sessions wait on a lock (true), or `stop()` says the commands already finished without
 * waiting (false), or 20 s pass (false).
 */
async function waitForWaiters(n: number, stop: () => boolean): Promise<boolean> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const { rows } = await superPool.query<{ n: number }>(
      'SELECT count(DISTINCT l.pid)::int AS n FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid WHERE NOT l.granted AND a.datname = current_database()',
    );
    if ((rows[0]?.n ?? 0) >= n) return true;
    if (stop() || Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe('two bills entered at once against one receipt', () => {
  it('locks the PO lines it matches against, so a match waits for another writer of those lines', async () => {
    const po = await receivedPo('5', '100.00', '5');
    const bill = await billFor(po, '5', '100.00');
    const blocker = await superPool.connect();
    try {
      await blocker.query('BEGIN');
      // NO KEY UPDATE, so the FOR KEY SHARE of the match_results FK check does not wait on it; only a PO line lock
      // taken by the match itself does.
      await blocker.query(
        'SELECT id FROM app.purchase_order_lines WHERE id = $1 FOR NO KEY UPDATE',
        [po.lineId],
      );
      let finished = false;
      const run = service.match(bill.id, randomUUID()).finally(() => {
        finished = true;
      });
      run.catch(() => undefined);
      expect(await waitForWaiters(1, () => finished)).toBe(true);
      await blocker.query('COMMIT');
      expect((await run).lines[0]!.match).toMatchObject({ runNo: 2, status: 'matched' });
    } finally {
      await blocker.query('ROLLBACK').catch(() => undefined);
      blocker.release();
    }
  });

  it('lets one match and shows the quantity variance on the other', async () => {
    const po = await receivedPo('10', '100.00', '10');
    // Hold the match_results inserts while both bills are in flight, then release once both commands wait. Today the
    // audit chain lock (one per tenant) already orders the two creates; the PO line lock keeps the order when it
    // does not.
    const blocker = await superPool.connect();
    let bills: VendorBillDto[] = [];
    try {
      await blocker.query('BEGIN');
      await blocker.query('LOCK TABLE app.match_results IN EXCLUSIVE MODE');
      const pending = Promise.allSettled([
        billFor(po, '10', '100.00'),
        billFor(po, '10', '100.00'),
      ]);
      expect(await waitForWaiters(2, () => false)).toBe(true);
      await blocker.query('COMMIT');
      const settled = await pending;
      bills = settled.map((s) => {
        if (s.status === 'rejected') throw s.reason;
        return s.value;
      });
    } finally {
      await blocker.query('ROLLBACK').catch(() => undefined);
      blocker.release();
    }

    expect(bills.map((b) => b.matchStatus).sort()).toEqual(['matched', 'variance']);
    const loser = bills.find((b) => b.matchStatus === 'variance')!;
    expect(loser.status).toBe('variance');
    expect(loser.lines[0]!.match).toMatchObject({ status: 'variance', billedQuantity: '10.0000' });
    expect(loser.lines[0]!.match!.quantityVariance).not.toBe('0.0000');
  });
});
