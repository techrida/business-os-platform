// Integration tests of payment requests on a real Postgres (Testcontainers, needs Docker in WSL; P4 unit A2).
// Real: migrations as bos_owner, queries as bos_app (so the 0035 CHECKs and FKs run), PaymentRequestsService and its
// subject, the real ApprovalsService with the `vendor_bill` and `payment_request` workflows published through
// ApprovalsAdminService (PAYMENT_REQUEST_WORKFLOW_SPEC, which the seed copies), VendorBillsService and its subject
// with the real LedgerService (every bill is approved and posted the real way), VendorBankService
// .activeVerifiedAccount, PurchaseOrdersService, ReceiptsService and AuditService. Faked: notify, the role directory,
// the request context and authz.assert (the real pure can()).
// Covers: a line above the open amount is refused; an unverified bank account is 409 (check 14); Finance only for
// PO-matched bills, the bands otherwise (AD5); SoD excludes the requester, the bill enterer and the bill approvers
// (check 4); approved is terminal and posts nothing; two submits on one item serialize; the entity wall (404).
// Run: pnpm --filter @bos/api exec vitest run src/modules/payables/payment-requests/payment-requests.integration.test.ts
import 'reflect-metadata';

import { randomUUID } from 'node:crypto';

import {
  DEFAULT_ROLE_PERMISSIONS,
  type Permission,
  type RequestPaymentBody,
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
  openItems,
  paymentRequests,
  runMigrations,
  vendorBills,
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
import { SettingsService } from '../../../platform/settings/settings.service';
import { ApprovalsAdminService } from '../../approvals/admin.service';
import { ApprovalsService } from '../../approvals/requests.service';
import { LedgerService } from '../../ledger/ledger.service';
import { vendorBillStatus } from '../../portal-vendor/portal-vendor.views';
import { PurchaseOrdersService } from '../../procurement/orders/purchase-orders.service';
import { ReceiptsService } from '../../procurement/receipts/receipts.service';
import { quotationLineAmounts } from '../../procurement/sourcing/sourcing.rules';
import { VendorBankService } from '../../vendors/bank/bank.service';
import { VENDOR_BILL_DOCUMENT_TYPE, VENDOR_BILL_WORKFLOW_SPEC } from '../bills/vendor-bill.rules';
import { VendorBillSubject } from '../bills/vendor-bill.subject';
import { VendorBillsService } from '../bills/vendor-bills.service';
import {
  PAYMENT_REQUEST_DOCUMENT_TYPE,
  PAYMENT_REQUEST_WORKFLOW_SPEC,
} from './payment-request.rules';
import { PaymentRequestSubject } from './payment-request.subject';
import { PaymentRequestsService } from './payment-requests.service';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 180_000 });

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
let bills: VendorBillsService;
let service: PaymentRequestsService;
let orders: PurchaseOrdersService;
let receiptsService: ReceiptsService;
const ledger = new LedgerService();
let deptA = '';
let vatCode = '';

const U = {
  req: '',
  proc: '',
  acct: '',
  acct2: '',
  fin: '',
  fin2: '',
  fin3: '',
  mgmt: '',
  founder: '',
  wh: '',
};
const roles: Partial<Record<RoleKey, string[]>> = {};

const grantsOf = (role: RoleKey) =>
  new Map(Object.entries(DEFAULT_ROLE_PERMISSIONS[role])) as Map<Permission, Scope>;
const current: {
  userId: string;
  role: RoleKey;
  inB: boolean;
  grants?: Map<Permission, Scope> | undefined;
} = {
  userId: '',
  role: 'accountant',
  inB: false,
};
const scopeNow = () => (current.inB ? scopeB : scopeA);
const as = (userId: string, role: RoleKey) => {
  current.userId = userId;
  current.role = role;
};
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
  U.acct2 = await staff('accountant');
  U.fin = await staff('finance');
  U.fin2 = await staff('finance');
  U.fin3 = await staff('finance');
  U.mgmt = await staff('management');
  U.founder = await staff('founder');
  U.wh = await staff('warehouse');
  deptA = (await createDepartment(appPool, scopeA)).departmentId;

  const vat = await exec(
    scopeA,
    sql`INSERT INTO app.tax_codes (tenant_id, code, name, kind, rate_bp, creditable, effective_from)
        VALUES (${scopeA.tenantId}, 'VAT13', 'VAT 13%', 'vat', 1300, true, '2020-01-01') RETURNING id`,
  );
  vatCode = (vat.rows[0] as { id: string }).id;

  const audit = new AuditService(db);
  as(U.founder, 'founder');
  const admin = new ApprovalsAdminService(db, audit, caller, () => now);
  for (const [key, name, spec] of [
    [VENDOR_BILL_DOCUMENT_TYPE, 'Vendor bill', VENDOR_BILL_WORKFLOW_SPEC],
    [PAYMENT_REQUEST_DOCUMENT_TYPE, 'Payment request', PAYMENT_REQUEST_WORKFLOW_SPEC],
  ] as const) {
    await admin.createWorkflow({ key, name, spec });
    await admin.publish(key, 1);
  }

  approvals = new ApprovalsService(db, audit, notify, directory, caller, () => now);
  approvals.registerSubject(new VendorBillSubject(audit, () => now, ledger));
  approvals.registerSubject(new PaymentRequestSubject(audit, () => now));
  bills = new VendorBillsService(db, approvals, audit, new SettingsService(db), caller, () => now);
  // activeVerifiedAccount reads only the db; the other collaborators are never reached.
  const bank = new VendorBankService(
    db,
    authz as unknown as AuthzService,
    caller,
    {} as never,
    {} as never,
    audit,
  );
  service = new PaymentRequestsService(db, approvals, audit, bank, caller, () => now, ledger);
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
  await container?.stop();
});

beforeEach(() => {
  vi.clearAllMocks();
  current.inB = false;
  current.grants = undefined;
  roles.accountant = [U.acct, U.acct2];
  roles.finance = [U.fin];
  roles.management = [U.mgmt];
  roles.founder = [U.founder];
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

async function doc(
  ownerType = 'vendor_bill_intake',
  ownerId: string = randomUUID(),
): Promise<string> {
  const { rows } = await exec(
    scopeA,
    sql`INSERT INTO app.documents (tenant_id, organization_id, owner_type, owner_id)
        VALUES (${scopeA.tenantId}, ${scopeA.organizationId}, ${ownerType}, ${ownerId}) RETURNING id`,
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

let panSeq = 0;
/**
 * An approved vendor with an account in both entities and a bank account: `active` (verified by another person
 * with call-back evidence), `proposed` (not verified) or none.
 */
async function vendor(bank: 'active' | 'proposed' | 'none' = 'active'): Promise<string> {
  const { partyId } = await createParty(appPool, {
    tenantId: scopeA.tenantId,
    kind: 'vendor',
    organizationId: scopeA.organizationId,
  });
  await exec(
    scopeA,
    sql`INSERT INTO app.vendors (id, tenant_id, legal_name, pan, status, created_by, approved_by)
        VALUES (${partyId}, ${scopeA.tenantId}, ${`Vendor ${partyId.slice(0, 6)}`},
                ${String(500_000_000 + (panSeq += 1))}, 'approved', ${U.proc}, ${U.mgmt})`,
  );
  for (const s of [scopeA, scopeB]) {
    await exec(
      s,
      sql`INSERT INTO app.vendor_accounts (tenant_id, organization_id, vendor_id, active)
          VALUES (${s.tenantId}, ${s.organizationId}, ${partyId}, true)`,
    );
  }
  if (bank !== 'none') {
    const active = bank === 'active';
    const evidence = active ? await doc() : null;
    await exec(
      scopeA,
      sql`INSERT INTO app.vendor_bank_accounts (tenant_id, vendor_id, bank_name, account_name,
            account_number_enc, account_fingerprint, last4, status, proposed_by, proposed_via, verified_by,
            callback_evidence_document_id)
          VALUES (${scopeA.tenantId}, ${partyId}, 'Nabil Bank', 'Vendor Pvt Ltd', decode('00', 'hex'),
                  ${`fp-${randomUUID()}`}, '1234', ${bank}, ${U.proc}, 'staff',
                  ${active ? U.fin2 : null}, ${evidence})`,
    );
  }
  return partyId;
}

let poSeq = 0;
interface Po {
  id: string;
  lineId: string;
}
/** An issued NPR PO of `vendorId` in entity A with one line of 1 x 100,000.00 + 13% VAT, fully received. */
async function receivedPo(vendorId: string): Promise<Po> {
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
          estimated_total_npr = ${a.lineTotal}, number = ${`PR-Q-${prId.slice(0, 8)}`} WHERE id = ${prId}`,
  );
  const id = randomUUID();
  poSeq += 1;
  await exec(
    scopeA,
    sql`INSERT INTO app.purchase_orders (id, tenant_id, organization_id, number, number_seq, fiscal_year,
          purchase_request_id, vendor_id, currency, payment_terms_days, approved_total, fx_rate,
          approved_total_npr, approved_band, created_by)
        VALUES (${id}, ${scopeA.tenantId}, ${scopeA.organizationId}, ${`PO-Q-${poSeq}`}, ${poSeq}, '2082/83',
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
  return { id, lineId };
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

async function approve(user: string, role: RoleKey, requestId: string) {
  const saved = { ...current };
  as(user, role);
  try {
    return await approvals.act(
      requestId,
      { action: 'approve', expectedVersion: await versionOf(requestId) },
      randomUUID(),
    );
  } finally {
    as(saved.userId, saved.role);
  }
}

interface ApprovedBill {
  billId: string;
  openItemId: string;
  payable: string;
}

/**
 * A bill entered by U.acct, approved by U.acct2 (Accountant) and U.fin (Finance), posted the real way. With `po` it
 * is matched against the PO (1 x 100,000.00 + VAT = 113,000.00); without, a non-PO bill of 1 x `unitPrice` + VAT.
 */
async function approvedBill(
  vendorId: string,
  po?: Po,
  unitPrice = po === undefined ? '50000.00' : '100000.00',
): Promise<ApprovedBill> {
  as(U.acct, 'accountant');
  const bill = await bills.create(
    {
      vendorPartyId: vendorId,
      kind: 'bill',
      vendorInvoiceNo: `INV-${randomUUID().slice(0, 8)}`,
      invoiceDate: '2026-11-09',
      currency: 'NPR',
      ...(po === undefined ? {} : { purchaseOrderId: po.id }),
      documentId: await doc('vendor_bill_intake', vendorId),
      lines: [
        {
          ...(po === undefined ? {} : { poLineId: po.lineId }),
          accountId: randomUUID(),
          quantity: '1',
          unitPrice,
          taxCodeId: vatCode,
        },
      ],
    },
    randomUUID(),
  );
  const submitted = await bills.submit(bill.id, randomUUID());
  const requestId = submitted.approvalRequestId!;
  await approve(U.acct2, 'accountant', requestId);
  await approve(U.fin, 'finance', requestId);
  const [item] = await read((tx) =>
    tx.select().from(openItems).where(eq(openItems.sourceId, bill.id)),
  );
  expect(item).toBeDefined();
  return { billId: bill.id, openItemId: item!.id, payable: item!.amount };
}

const body = (
  vendorPartyId: string,
  allocations: { openItemId: string; amount: string }[],
): RequestPaymentBody => ({
  vendorPartyId,
  paymentType: 'settlement',
  currency: 'NPR',
  fromBankAccountId: randomUUID(),
  allocations,
});

/** Creates a draft as U.fin2 (Finance holds payables.payment.request). */
async function draft(vendorId: string, allocations: { openItemId: string; amount: string }[]) {
  as(U.fin2, 'finance');
  return service.create(body(vendorId, allocations), randomUUID());
}

const stepRoles = async (approvalRequestId: string) =>
  (
    await read((tx) =>
      tx
        .select({ roleKey: approvalSteps.roleKey })
        .from(approvalSteps)
        .where(eq(approvalSteps.requestId, approvalRequestId))
        .orderBy(asc(approvalSteps.seq)),
    )
  ).map((s) => s.roleKey);

const requestRow = async (id: string) =>
  (await read((tx) => tx.select().from(paymentRequests).where(eq(paymentRequests.id, id))))[0]!;

// ---------------------------------------------------------------------------------------- lines and bank

describe('lines and the bank snapshot', () => {
  it('refuses a line above the derived open amount and accepts exactly the open amount', async () => {
    const v = await vendor();
    const bill = await approvedBill(v, await receivedPo(v));
    expect(bill.payable).toBe('113000.00');

    const over = await httpErrorOf(
      draft(v, [{ openItemId: bill.openItemId, amount: '113000.01' }]),
    );
    expect(over.getStatus()).toBe(409);
    expect(codeOf(over)).toBe('OVER_ALLOCATION');

    // An uppercase id names the same item (ids are folded before they are compared).
    const ok = await draft(v, [{ openItemId: bill.openItemId.toUpperCase(), amount: '113000.00' }]);
    expect(ok).toMatchObject({
      status: 'draft',
      totalAmount: '113000.00',
      bankLast4: '1234',
      requestedBy: U.fin2,
    });
    expect(ok.lines).toEqual([
      expect.objectContaining({ lineNo: 1, openItemId: bill.openItemId, amount: '113000.00' }),
    ]);
  });

  it('answers 409 no_verified_bank_account for a vendor whose only account is unverified (check 14)', async () => {
    const v = await vendor('proposed');
    const bill = await approvedBill(v);
    const refused = await httpErrorOf(
      draft(v, [{ openItemId: bill.openItemId, amount: '100.00' }]),
    );
    expect(refused.getStatus()).toBe(409);
    expect(codeOf(refused)).toBe('no_verified_bank_account');
    const rows = await read((tx) =>
      tx.select().from(paymentRequests).where(eq(paymentRequests.vendorId, v)),
    );
    expect(rows).toHaveLength(0);
  });

  it('answers 409 at submit when the verified account was retired after the draft', async () => {
    const v = await vendor();
    const bill = await approvedBill(v);
    const d = await draft(v, [{ openItemId: bill.openItemId, amount: '100.00' }]);
    await exec(
      scopeA,
      sql`UPDATE app.vendor_bank_accounts SET status = 'retired' WHERE vendor_id = ${v}`,
    );
    const refused = await httpErrorOf(service.submit(d.id, randomUUID()));
    expect(refused.getStatus()).toBe(409);
    expect(codeOf(refused)).toBe('no_verified_bank_account');
    expect((await requestRow(d.id)).status).toBe('draft');
  });

  it('cancels a draft with its reason', async () => {
    const v = await vendor();
    const bill = await approvedBill(v);
    const d = await draft(v, [{ openItemId: bill.openItemId, amount: '100.00' }]);
    const cancelled = await service.cancel(d.id, { reason: 'Wrong amount' }, randomUUID());
    expect(cancelled).toMatchObject({ status: 'cancelled', cancelReason: 'Wrong amount' });
  });
});

// ---------------------------------------------------------------------------------------- routing (AD5)

describe('routing (AD5, AD4)', () => {
  it('routes Finance only when every bill is PO-matched, even above NPR 100,000', async () => {
    const v = await vendor();
    const bill = await approvedBill(v, await receivedPo(v));
    const d = await draft(v, [{ openItemId: bill.openItemId, amount: '113000.00' }]);
    roles.finance = [U.fin, U.fin2, U.fin3];
    const submitted = await service.submit(d.id, randomUUID());
    expect(submitted.status).toBe('pending_approval');
    expect(await stepRoles(submitted.approvalRequestId!)).toEqual(['finance']);
  });

  it('adds Management for non-PO bills above NPR 100,000', async () => {
    const v = await vendor();
    const b1 = await approvedBill(v);
    const b2 = await approvedBill(v);
    expect([b1.payable, b2.payable]).toEqual(['56500.00', '56500.00']);
    const d = await draft(v, [
      { openItemId: b1.openItemId, amount: '56500.00' },
      { openItemId: b2.openItemId, amount: '56500.00' },
    ]);
    roles.finance = [U.fin, U.fin2, U.fin3];
    const submitted = await service.submit(d.id, randomUUID());
    expect(await stepRoles(submitted.approvalRequestId!)).toEqual(['finance', 'management']);
  });
});

// ---------------------------------------------------------------------------------------- SoD (check 4)

describe('separation of duties (check 4) and the terminal approval', () => {
  it('excludes the requester, the bill enterer and the bill approvers; approved is terminal and posts nothing', async () => {
    const v = await vendor();
    const bill = await approvedBill(v);
    const d = await draft(v, [{ openItemId: bill.openItemId, amount: '56500.00' }]);

    // Everyone who could take the Finance step is the requester (fin2), the bill's enterer (acct) or one of its
    // approvers (acct2, fin): nobody is left.
    roles.finance = [U.fin2, U.acct, U.acct2, U.fin];
    const blocked = await httpErrorOf(service.submit(d.id, randomUUID()));
    expect(blocked.getStatus()).toBe(422);
    expect(codeOf(blocked)).toBe('NO_ELIGIBLE_APPROVER');
    expect((await requestRow(d.id)).status).toBe('draft');

    // One more Finance user, and the step routes to them.
    roles.finance = [U.fin2, U.acct, U.acct2, U.fin, U.fin3];
    const submitted = await service.submit(d.id, randomUUID());
    const requestId = submitted.approvalRequestId!;
    const [request] = await read((tx) =>
      tx.select().from(approvalRequests).where(eq(approvalRequests.id, requestId)),
    );
    expect(new Set(request!.sodUserIds)).toEqual(new Set([U.fin2, U.acct, U.acct2, U.fin]));

    for (const [user, role] of [
      [U.fin, 'finance'],
      [U.fin2, 'finance'],
    ] as const) {
      expect((await httpErrorOf(approve(user, role, requestId))).getStatus()).toBe(403);
    }
    await approve(U.fin3, 'finance', requestId);
    expect((await requestRow(d.id)).status).toBe('approved');

    // Terminal: no cancel, no second submit.
    as(U.fin2, 'finance');
    const cancel = await httpErrorOf(service.cancel(d.id, { reason: 'late' }, randomUUID()));
    expect(cancel.getStatus()).toBe(409);
    expect((await httpErrorOf(service.submit(d.id, randomUUID()))).getStatus()).toBe(409);

    // No payout: nothing allocated, the bill is still approved and the portal shows approved_for_payment.
    const open = await read((tx) => ledger.openAmounts(tx, scopeA, [bill.openItemId]));
    expect(open.get(bill.openItemId)).toBe('56500.00');
    const [billRow] = await read((tx) =>
      tx.select().from(vendorBills).where(eq(vendorBills.id, bill.billId)),
    );
    expect(billRow!.status).toBe('approved');
    expect(vendorBillStatus(billRow!.status)).toBe('approved_for_payment');

    // The approved request still claims the balance, so a second request for it is refused.
    const again = await draft(v, [{ openItemId: bill.openItemId, amount: '0.01' }]).catch(
      (e: unknown) => e,
    );
    expect(again).toBeInstanceOf(HttpException);
    expect(codeOf(again as HttpException)).toBe('OVER_ALLOCATION');
  });
});

// ---------------------------------------------------------------------------------------- concurrency

describe('concurrency', () => {
  it('two drafts for the whole balance of one item: one submit wins, the other is OVER_ALLOCATION', async () => {
    const v = await vendor();
    const bill = await approvedBill(v);
    const d1 = await draft(v, [{ openItemId: bill.openItemId, amount: '56500.00' }]);
    const d2 = await draft(v, [{ openItemId: bill.openItemId, amount: '56500.00' }]);
    roles.finance = [U.fin, U.fin2, U.fin3];
    as(U.fin2, 'finance');
    const results = await Promise.allSettled([
      service.submit(d1.id, randomUUID()),
      service.submit(d2.id, randomUUID()),
    ]);
    const won = results.filter((r) => r.status === 'fulfilled');
    const lost = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect(codeOf(lost[0]!.reason as HttpException)).toBe('OVER_ALLOCATION');
  });
});

// ---------------------------------------------------------------------------------------- entity wall

describe('entity wall', () => {
  it('a request or an open item of another entity is a 404', async () => {
    const v = await vendor();
    const bill = await approvedBill(v);
    const d = await draft(v, [{ openItemId: bill.openItemId, amount: '100.00' }]);
    current.inB = true;
    as(U.fin2, 'finance');
    expect((await httpErrorOf(service.get(d.id))).getStatus()).toBe(404);
    expect((await httpErrorOf(service.submit(d.id, randomUUID()))).getStatus()).toBe(404);
    expect(
      (await httpErrorOf(service.cancel(d.id, { reason: 'x' }, randomUUID()))).getStatus(),
    ).toBe(404);
    const foreign = await httpErrorOf(
      service.create(body(v, [{ openItemId: bill.openItemId, amount: '100.00' }]), randomUUID()),
    );
    expect(foreign.getStatus()).toBe(404);
    expect(await service.list()).toEqual([]);
  });
});

describe('names on the approval (U18 #1)', () => {
  it('shows Management the vendor, the bills, the items and the bank account by name, and nothing else of them', async () => {
    const v = await vendor();
    const b1 = await approvedBill(v);
    const b2 = await approvedBill(v);
    const d = await draft(v, [
      { openItemId: b1.openItemId, amount: '56500.00' },
      { openItemId: b2.openItemId, amount: '56500.00' },
    ]);
    roles.finance = [U.fin, U.fin2, U.fin3];
    const submitted = await service.submit(d.id, randomUUID());
    const stored = await read((tx) =>
      tx
        .select({
          id: vendorBills.id,
          number: vendorBills.number,
          inv: vendorBills.vendorInvoiceNo,
        })
        .from(vendorBills)
        .where(eq(vendorBills.vendorId, v)),
    );
    const billName = (id: string) => {
      const row = stored.find((b) => b.id === id)!;
      return row.number ?? row.inv;
    };
    const vendorName = `Vendor ${v.slice(0, 6)}`;

    // Management decides the second step; it holds no vendor.read and no payables grant.
    as(U.mgmt, 'management');
    expect(grantsOf('management').has('vendor.read')).toBe(false);
    const request = await approvals.get(submitted.approvalRequestId!);
    expect(request.snapshot).toMatchObject({
      vendorName,
      lines: [
        { vendorBillId: b1.billId, billNumber: stored.find((b) => b.id === b1.billId)!.number },
        { vendorBillId: b2.billId, billNumber: stored.find((b) => b.id === b2.billId)!.number },
      ],
    });
    const { vendorBankAccountId } = request.snapshot as { vendorBankAccountId: string };
    expect(request.references).toEqual(
      expect.arrayContaining([
        { id: v, name: vendorName },
        { id: b1.billId, name: billName(b1.billId) },
        { id: b2.billId, name: billName(b2.billId) },
        { id: b1.openItemId, name: billName(b1.billId) },
        { id: b2.openItemId, name: billName(b2.billId) },
        { id: vendorBankAccountId, name: 'Account ending 1234' },
      ]),
    );
    // Only the records the snapshot names, by name: no PAN, no other vendor's or bill's row.
    expect(request.references).toHaveLength(6);
    const { rows } = await exec(scopeA, sql`SELECT pan FROM app.vendors WHERE id = ${v}`);
    expect(JSON.stringify(request)).not.toContain((rows[0] as { pan: string }).pan);
  });
});

describe('the request on its approval (U18 #2)', () => {
  it("shows Management the request and the files of the bills it pays, no other bill's file, and no link", async () => {
    const v = await vendor();
    const b1 = await approvedBill(v);
    const b2 = await approvedBill(v);
    // A bill of the same vendor that this request does not pay: its file has the same owner and must stay hidden.
    const unpaid = await approvedBill(v);
    const d = await draft(v, [
      { openItemId: b1.openItemId, amount: '56500.00' },
      { openItemId: b2.openItemId, amount: '56500.00' },
    ]);
    roles.finance = [U.fin, U.fin2, U.fin3];
    const submitted = await service.submit(d.id, randomUUID());
    const files = await read((tx) =>
      tx
        .select({ id: vendorBills.id, documentId: vendorBills.documentId })
        .from(vendorBills)
        .where(eq(vendorBills.vendorId, v)),
    );
    const fileOf = (billId: string) => files.find((f) => f.id === billId)!.documentId;

    as(U.mgmt, 'management');
    expect(grantsOf('management').has('payables.payment.request')).toBe(false);
    const { context } = await approvals.get(submitted.approvalRequestId!);
    expect(context).toMatchObject({ href: null });
    expect(context!.documents.map((f) => f.documentId)).toEqual([
      fileOf(b1.billId),
      fileOf(b2.billId),
    ]);
    expect(context!.documents.map((f) => f.documentId)).not.toContain(fileOf(unpaid.billId));
    expect(context!.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: 'vendor', value: `Vendor ${v.slice(0, 6)}` }),
        expect.objectContaining({ key: 'totalAmount', kind: 'money', value: '113000.00' }),
        expect.objectContaining({ key: 'status', value: 'pending_approval' }),
      ]),
    );
    const { rows } = await exec(scopeA, sql`SELECT pan FROM app.vendors WHERE id = ${v}`);
    expect(JSON.stringify(context)).not.toContain((rows[0] as { pan: string }).pan);
  });
});

describe('the vendor on the request page (U18 #15)', () => {
  it('names the vendor for Finance and lets them open it; without vendor.read only the name, no link', async () => {
    const v = await vendor();
    const bill = await approvedBill(v);
    const d = await draft(v, [{ openItemId: bill.openItemId, amount: '100.00' }]);

    as(U.fin2, 'finance');
    const finance = await service.get(d.id);
    expect(finance).toMatchObject({
      vendorName: `Vendor ${v.slice(0, 6)}`,
      can: { readVendor: true },
    });

    // A role an admin gave payables.payment.request but not vendor.read: the vendor page would refuse them.
    const withoutVendorRead = grantsOf('finance');
    withoutVendorRead.delete('vendor.read');
    current.grants = withoutVendorRead;
    const narrow = await service.get(d.id);
    expect(narrow).toMatchObject({
      vendorName: `Vendor ${v.slice(0, 6)}`,
      can: { readVendor: false },
    });
    // The name is the only vendor field the request carries: no PAN, status or contact details.
    expect(
      Object.keys(narrow)
        .filter((key) => /vendor/i.test(key))
        .sort(),
    ).toEqual(['vendorBankAccountId', 'vendorName', 'vendorPartyId']);
    const { rows } = await exec(scopeA, sql`SELECT pan FROM app.vendors WHERE id = ${v}`);
    const { pan } = rows[0] as { pan: string };
    expect(JSON.stringify(narrow)).not.toContain(pan);
  });
});

describe('available bill items', () => {
  it('excludes vendors without an active entity account or an active verified bank account', async () => {
    const inactiveVendor = await vendor();
    const inactiveBill = await approvedBill(inactiveVendor);
    await exec(
      scopeA,
      sql`UPDATE app.vendor_accounts SET active = false
          WHERE tenant_id = ${scopeA.tenantId} AND organization_id = ${scopeA.organizationId}
            AND vendor_id = ${inactiveVendor}`,
    );
    const hidden = [inactiveBill.openItemId];
    for (const bank of ['none', 'proposed'] as const) {
      const vendorId = await vendor(bank);
      hidden.push((await approvedBill(vendorId)).openItemId);
    }
    const retiredVendor = await vendor();
    hidden.push((await approvedBill(retiredVendor)).openItemId);
    await exec(
      scopeA,
      sql`UPDATE app.vendor_bank_accounts SET status = 'retired'
          WHERE tenant_id = ${scopeA.tenantId} AND vendor_id = ${retiredVendor}`,
    );
    const eligibleVendor = await vendor();
    const eligibleBill = await approvedBill(eligibleVendor);
    const available = await service.listItems();
    expect(available.filter((item) => hidden.includes(item.openItemId))).toEqual([]);
    expect(available.some((item) => item.openItemId === eligibleBill.openItemId)).toBe(true);
  });

  it('returns vendor and invoice labels with ledger-derived balances less pending and approved claims', async () => {
    const v = await vendor();
    const bill = await approvedBill(v);
    const invoice = await bills.get(bill.billId);
    await read(async (tx) => {
      const { item } = await ledger.openItem(tx, scopeA, systemActor('test'), {
        side: 'payable',
        direction: 'debit',
        partyId: v,
        sourceType: 'vendor_debit_note',
        sourceId: randomUUID(),
        currency: 'NPR',
        amount: '100.25',
        amountNpr: '100.25',
        fxRate: '1',
        documentDate: '2026-11-09',
      });
      await ledger.allocate(tx, scopeA, systemActor('test'), {
        debitItemId: item.id,
        creditItemId: bill.openItemId,
        amount: '100.25',
      });
    });
    await exec(
      scopeA,
      sql`UPDATE app.vendor_bills SET status = 'partially_paid' WHERE id = ${bill.billId}`,
    );
    const request = await draft(v, [{ openItemId: bill.openItemId, amount: '200.10' }]);
    const itemForBill = async () =>
      (await service.listItems()).find((item) => item.openItemId === bill.openItemId);
    expect(await itemForBill()).toEqual({
      openItemId: bill.openItemId,
      vendorPartyId: v,
      vendorName: `Vendor ${v.slice(0, 6)}`,
      vendorBillId: bill.billId,
      billNumber: invoice.number,
      vendorInvoiceNo: invoice.vendorInvoiceNo,
      currency: 'NPR',
      openAmount: '56399.75',
      claimedAmount: '0.00',
      availableAmount: '56399.75',
    });
    roles.finance = [U.fin3];
    const pending = await service.submit(request.id, randomUUID());
    expect(await itemForBill()).toMatchObject({
      openAmount: '56399.75',
      claimedAmount: '200.10',
      availableAmount: '56199.65',
    });
    await approve(U.fin3, 'finance', pending.approvalRequestId!);
    expect(await itemForBill()).toMatchObject({
      claimedAmount: '200.10',
      availableAmount: '56199.65',
    });
  });

  it('excludes unapproved, voided, paid and fully claimed items', async () => {
    const v = await vendor();
    const hidden: string[] = [];
    for (const status of ['draft', 'voided', 'paid'] as const) {
      const bill = await approvedBill(v);
      hidden.push(bill.openItemId);
      // Leave the posted credit open to make the status filter independently observable.
      await exec(
        scopeA,
        sql`UPDATE app.vendor_bills SET status = ${status},
        voided_by = ${status === 'voided' ? U.fin : null},
        voided_at = ${status === 'voided' ? now : null},
        void_reason = ${status === 'voided' ? 'Voided test fixture' : null}
        WHERE id = ${bill.billId}`,
      );
    }
    const claimed = await approvedBill(v);
    hidden.push(claimed.openItemId);
    const request = await draft(v, [{ openItemId: claimed.openItemId, amount: claimed.payable }]);
    roles.finance = [U.fin3];
    await service.submit(request.id, randomUUID());
    roles.finance = [U.fin];
    const settled = await approvedBill(v);
    hidden.push(settled.openItemId);
    await read(async (tx) => {
      const { item } = await ledger.openItem(tx, scopeA, systemActor('test'), {
        side: 'payable',
        direction: 'debit',
        partyId: v,
        sourceType: 'vendor_debit_note',
        sourceId: randomUUID(),
        currency: 'NPR',
        amount: settled.payable,
        amountNpr: settled.payable,
        fxRate: '1',
        documentDate: '2026-11-09',
      });
      await ledger.allocate(tx, scopeA, systemActor('test'), {
        debitItemId: item.id,
        creditItemId: settled.openItemId,
        amount: settled.payable,
      });
    });
    as(U.fin2, 'finance');
    const available = await service.listItems();
    expect(available.filter((item) => hidden.includes(item.openItemId))).toEqual([]);
  });

  it("does not reveal another entity's approved items", async () => {
    const v = await vendor();
    const bill = await approvedBill(v);
    as(U.fin2, 'finance');
    expect((await service.listItems()).some((item) => item.openItemId === bill.openItemId)).toBe(
      true,
    );
    current.inB = true;
    expect(await service.listItems()).toEqual([]);
  });
});
