// Integration tests of vendor bills on a real Postgres (Testcontainers, needs Docker in WSL).
// Real: migrations as bos_owner, queries as bos_app (so every 0035 CHECK, the generated invoice_no_norm and its
// unique key run), VendorBillsService, the real ApprovalsService with the `vendor_bill` and `match_exception`
// workflows published through ApprovalsAdminService (specs VENDOR_BILL_WORKFLOW_SPEC and
// MATCH_EXCEPTION_WORKFLOW_SPEC, which the seed copies), the real subjects, PurchaseOrdersService (issue),
// ReceiptsService (receipts feed v_po_line_progress), SettingsService (AD6 defaults) and AuditService. Faked: notify,
// the role directory (role -> real staff users), the request context and authz.assert (the real pure can()).
// Covers done checks 6 (match and the submit gate), 8 (duplicate invoice number), the entered_by exclusion (AD5)
// and the entity wall (404).
// Run: pnpm --filter @bos/api exec vitest run src/modules/payables/bills/vendor-bills.integration.test.ts
import 'reflect-metadata';

import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import {
  DEFAULT_ROLE_PERMISSIONS,
  type DocumentVersionStatus,
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
  matchResults,
  runMigrations,
  vendorBills,
} from '@bos/db';
import { ForbiddenException, HttpException } from '@nestjs/common';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { asc, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import type { Queue } from 'bullmq';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { AuditService } from '../../../platform/audit/audit.service';
import type { AuthzService } from '../../../platform/authz/authz.service';
import { can } from '../../../platform/authz/can';
import type { Principal } from '../../../platform/authz/principal';
import type { Db, DbTransaction } from '../../../platform/db/db.module';
import { systemActor, withTx, type TxScope } from '../../../platform/db/tx';
import type { ClamdClient } from '../../../platform/documents/clamd.client';
import { DocumentsService } from '../../../platform/documents/documents.service';
import { ScanProcessor } from '../../../platform/documents/scan.processor';
import { SignedLinks } from '../../../platform/documents/signed-link';
import { DiskStorageAdapter } from '../../../platform/documents/storage.adapter';
import { NumberingService } from '../../../platform/settings/numbering.service';
import { SettingsService } from '../../../platform/settings/settings.service';
import { ApprovalsAdminService } from '../../approvals/admin.service';
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
import { VendorBillsService } from './vendor-bills.service';
import { billDocumentOwnerPolicy, BillDocumentsService } from './bill-documents.service';

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

  const audit = new AuditService(db);
  as(U.founder, 'founder');
  const admin = new ApprovalsAdminService(db, audit, caller, () => now);
  for (const [key, name, spec] of [
    [VENDOR_BILL_DOCUMENT_TYPE, 'Vendor bill', VENDOR_BILL_WORKFLOW_SPEC],
    [MATCH_EXCEPTION_DOCUMENT_TYPE, 'Match exception', MATCH_EXCEPTION_WORKFLOW_SPEC],
  ] as const) {
    await admin.createWorkflow({ key, name, spec });
    await admin.publish(key, 1);
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

const documentVendors = new Map<string, string>();
async function doc(
  versions: readonly DocumentVersionStatus[] = ['clean'],
  vendorId = '',
): Promise<string> {
  vendorId ||= await vendor();
  const { rows } = await exec(
    scopeA,
    sql`INSERT INTO app.documents (tenant_id, organization_id, owner_type, owner_id)
        VALUES (${scopeA.tenantId}, ${scopeA.organizationId}, 'vendor_bill_intake', ${vendorId}) RETURNING id`,
  );
  const documentId = (rows[0] as { id: string }).id;
  documentVendors.set(documentId, vendorId);
  for (const [i, status] of versions.entries()) {
    await exec(
      scopeA,
      sql`INSERT INTO app.document_versions (tenant_id, organization_id, document_id, version, filename,
            declared_mime, size_bytes, storage_key, status)
          VALUES (${scopeA.tenantId}, ${scopeA.organizationId}, ${documentId}, ${i + 1}, 'invoice.pdf',
                  'application/pdf', 1024, ${`${scopeA.tenantId}/${randomUUID()}`}, ${status})`,
    );
  }
  return documentId;
}

async function billWithoutPo(documentId: string, vendorPartyId?: string) {
  return service.create(
    {
      vendorPartyId: vendorPartyId ?? documentVendors.get(documentId)!,
      kind: 'bill',
      vendorInvoiceNo: `INV-${randomUUID().slice(0, 8)}`,
      invoiceDate: '2026-11-09',
      currency: 'NPR',
      documentId,
      lines: [{ accountId: randomUUID(), quantity: '1', unitPrice: '1000.00', taxCodeId: vatCode }],
    },
    randomUUID(),
  );
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
      documentId: await doc(['clean'], po.vendorId),
      lines: [
        { poLineId: po.lineId, accountId: randomUUID(), quantity, unitPrice, taxCodeId: vatCode },
      ],
    },
    key,
  );
}

const requestOf = async (requestId: string) =>
  (
    await read((tx) =>
      tx
        .select({ version: approvalRequests.version, status: approvalRequests.status })
        .from(approvalRequests)
        .where(eq(approvalRequests.id, requestId)),
    )
  )[0]!;
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

async function decide(user: string, role: RoleKey, requestId: string) {
  const req = await requestOf(requestId);
  as(user, role);
  try {
    return await approvals.act(
      requestId,
      { action: 'approve', expectedVersion: req.version },
      randomUUID(),
    );
  } finally {
    as(U.acct, 'accountant');
  }
}

// ---------------------------------------------------------------------------------------- check 6

describe('discard draft bills', () => {
  it('retains the bill and releases the normalized duplicate key, with one audit on replay', async () => {
    const documentId = await doc();
    const bill = await billWithoutPo(documentId);
    const key = randomUUID();
    const discarded = await service.discard(bill.id, key);
    expect(discarded.status).toBe('discarded');
    expect(await service.discard(bill.id, key)).toEqual(discarded);
    expect(await service.discard(bill.id, randomUUID())).toEqual(discarded);
    const replacement = await service.create(
      {
        vendorPartyId: bill.vendorPartyId,
        kind: 'bill',
        vendorInvoiceNo: bill.vendorInvoiceNo,
        invoiceDate: bill.invoiceDate,
        currency: 'NPR',
        documentId,
        lines: [
          { accountId: randomUUID(), quantity: '1', unitPrice: '1000.00', taxCodeId: vatCode },
        ],
      },
      randomUUID(),
    );
    expect(replacement.id).not.toBe(bill.id);
    expect((await service.get(bill.id)).status).toBe('discarded');
    const events = await new AuditService(db).list(scopeA, { entityId: bill.id, limit: 100 });
    expect(events.filter((e) => e.action === 'payables.bill.discarded')).toHaveLength(1);
  });

  it('returns 404 across entities and refuses a submitted bill', async () => {
    const bill = await billWithoutPo(await doc());
    current.scope = scopeB;
    expect((await httpErrorOf(service.discard(bill.id, randomUUID()))).getStatus()).toBe(404);
    current.scope = null;
    await service.submit(bill.id, randomUUID());
    expect(codeOf(await httpErrorOf(service.discard(bill.id, randomUUID())))).toBe(
      'invalid_transition',
    );
  });

  it('serializes submit against discard so only one transition wins', async () => {
    const bill = await billWithoutPo(await doc());
    const outcomes = await Promise.allSettled([
      service.submit(bill.id, randomUUID()),
      service.discard(bill.id, randomUUID()),
    ]);
    expect(outcomes.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const failure = outcomes.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(['invalid_transition', 'BILL_NOT_MATCHED']).toContain(
      codeOf(failure.reason as HttpException),
    );
  });
});

describe('match (check 6, AD6 defaults from settings)', () => {
  it('returns the vendor name on bill list and detail without requiring vendor.read', async () => {
    const po = await receivedPo('1', '1000.00', '1');
    const bill = await billFor(po, '1', '1000.00');
    const expected = {
      vendorPartyId: po.vendorId,
      vendorName: `Vendor ${po.vendorId.slice(0, 6)}`,
    };
    expect(await service.get(bill.id)).toMatchObject(expected);
    expect((await service.list()).find((row) => row.id === bill.id)).toMatchObject(expected);
  });

  it('names the purchase order on bill list and detail for Finance, who holds no purchase order read', async () => {
    const po = await receivedPo('1', '1000.00', '1');
    const bill = await billFor(po, '1', '1000.00');
    const plain = await billWithoutPo(await doc(['clean']));
    const [stored] = await read((tx) =>
      tx.execute<{ number: string }>(
        sql`SELECT number FROM app.purchase_orders WHERE id = ${po.id}`,
      ),
    ).then((r) => r.rows);
    as(U.fin, 'finance');
    expect(grantsOf('finance').has('procurement.po.issue')).toBe(false);
    expect(grantsOf('finance').has('procurement.pr.read')).toBe(false);
    expect(await service.get(bill.id)).toMatchObject({
      purchaseOrderId: po.id,
      purchaseOrderNumber: stored!.number,
    });
    const listed = await service.list();
    expect(listed.find((row) => row.id === bill.id)?.purchaseOrderNumber).toBe(stored!.number);
    expect(listed.find((row) => row.id === plain.id)?.purchaseOrderNumber).toBeNull();
    expect((await service.get(plain.id)).purchaseOrderNumber).toBeNull();
    as(U.acct, 'accountant');
  });

  it('adds only the order number to a bill: no other purchase order field rides along', async () => {
    const po = await receivedPo('1', '1000.00', '1');
    const bill = await billFor(po, '1', '1000.00');
    as(U.fin, 'finance');
    const { lines: _lines, fileStatus: _file, ...detail } = await service.get(bill.id);
    const row = (await service.list()).find((r) => r.id === bill.id)!;
    as(U.acct, 'accountant');
    const expectedKeys = [
      'approvalRequestId',
      'currency',
      'documentId',
      'enteredBy',
      'fiscalYear',
      'id',
      'invoiceDate',
      'kind',
      'matchStatus',
      'netTotal',
      'number',
      'payableTotal',
      'purchaseOrderId',
      'purchaseOrderNumber',
      'status',
      'tdsTotal',
      'vatTotal',
      'vendorInvoiceNo',
      'vendorName',
      'vendorPartyId',
      'version',
    ];
    expect(Object.keys(detail).sort()).toEqual(expectedKeys);
    expect(Object.keys(row).sort()).toEqual(expectedKeys);
  });

  it('passes +2% on 10,000 and lets the bill through to Accountant -> Finance', async () => {
    const po = await receivedPo('1', '10000.00', '1');
    const bill = await billFor(po, '1', '10200.00');
    expect(bill.status).toBe('matching');
    expect(bill.matchStatus).toBe('matched');
    expect(bill.lines[0]!.match).toMatchObject({
      runNo: 1,
      status: 'matched',
      priceVariance: '200.00',
      taxVariance: '0.00',
    });
    expect(bill).toMatchObject({
      netTotal: '10200.00',
      vatTotal: '1326.00',
      payableTotal: '11526.00',
    });

    const submitted = await service.submit(bill.id, randomUUID());
    expect(submitted.status).toBe('pending_approval');
    expect(await stepRoles(submitted.approvalRequestId!)).toEqual(['accountant', 'finance']);
  });

  it('names the vendor and the order of a submitted bill for its approver, in this entity only (I-31)', async () => {
    const po = await receivedPo('1', '10000.00', '1');
    const bill = await billFor(po, '1', '10000.00');
    const submitted = await service.submit(bill.id, randomUUID());
    const [stored] = await read((tx) =>
      tx.execute<{ number: string }>(
        sql`SELECT number FROM app.purchase_orders WHERE id = ${po.id}`,
      ),
    ).then((r) => r.rows);
    // The approver of the first step is another accountant, who reads the request, not the vendor directory.
    as(U.acct2, 'accountant');
    const request = await approvals.get(submitted.approvalRequestId!);
    expect(request.snapshot).toMatchObject({ vendorPartyId: po.vendorId, purchaseOrderId: po.id });
    expect(request.references).toEqual(
      expect.arrayContaining([
        { id: po.vendorId, name: `Vendor ${po.vendorId.slice(0, 6)}` },
        { id: po.id, name: stored!.number },
      ]),
    );
    expect(request.references).toHaveLength(2);

    // Entity B cannot open entity A's request, so it learns neither name.
    current.scope = scopeB;
    expect((await httpErrorOf(approvals.get(submitted.approvalRequestId!))).getStatus()).toBe(404);
    current.scope = null;
  });

  it('fails +1% on 1,00,000 (past the NPR 500 cap)', async () => {
    const po = await receivedPo('1', '100000.00', '1');
    const bill = await billFor(po, '1', '101000.00');
    expect(bill.status).toBe('variance');
    expect(bill.lines[0]!.match).toMatchObject({ status: 'variance', priceVariance: '1000.00' });
  });

  it('fails a quantity over what was received', async () => {
    const po = await receivedPo('5', '1000.00', '3');
    const bill = await billFor(po, '4', '1000.00');
    expect(bill.status).toBe('variance');
    expect(bill.lines[0]!.match).toMatchObject({
      receivedQuantity: '3.0000',
      quantityVariance: '1.0000',
    });
  });

  it('a bill 10% over price shows variance, submit is 409, an approved exception unblocks it', async () => {
    const po = await receivedPo('1', '10000.00', '1');
    const bill = await billFor(po, '1', '11000.00');
    expect(bill.status).toBe('variance');
    expect(bill.lines[0]!.match!.priceVariance).toBe('1000.00');

    const refused = await httpErrorOf(service.submit(bill.id, randomUUID()));
    expect(refused.getStatus()).toBe(409);
    expect(codeOf(refused)).toBe('BILL_NOT_MATCHED');

    const exception = await service.requestException(
      bill.id,
      { reason: 'Vendor raised the price; agreed by phone' },
      randomUUID(),
    );
    expect(exception.status).toBe('pending');
    expect(await stepRoles(exception.approvalRequestId!)).toEqual(['finance']);
    // Still blocked while Finance has not decided.
    expect((await httpErrorOf(service.submit(bill.id, randomUUID()))).getStatus()).toBe(409);

    await decide(U.fin, 'finance', exception.approvalRequestId!);
    expect((await service.get(bill.id)).matchStatus).toBe('exception_approved');

    const submitted = await service.submit(bill.id, randomUUID());
    expect(submitted.status).toBe('pending_approval');

    // AD5: the accountant who entered the bill is not its Accountant step.
    const selfApproval = await httpErrorOf(
      decide(U.acct, 'accountant', submitted.approvalRequestId!),
    );
    expect(selfApproval).toBeInstanceOf(ForbiddenException);
    expect((await requestOf(submitted.approvalRequestId!)).status).toBe('pending');
  });

  it('writes one match_results row per line per run and re-runs under the next run number', async () => {
    const po = await receivedPo('1', '10000.00', '1');
    const bill = await billFor(po, '1', '10000.00');
    await service.match(bill.id, randomUUID());
    const runs = await read((tx) =>
      tx
        .select({ runNo: matchResults.runNo })
        .from(matchResults)
        .where(eq(matchResults.vendorBillId, bill.id))
        .orderBy(asc(matchResults.runNo)),
    );
    expect(runs.map((r) => r.runNo)).toEqual([1, 2]);
  });
});

describe('invoice documents', () => {
  it('recovers an infected draft invoice by replacing it, scanning clean, and submitting the same bill', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bos-invoice-recovery-'));
    try {
      const audit = new AuditService(db);
      const storage = new DiskStorageAdapter(root);
      const documentsService = new DocumentsService(
        db,
        storage,
        new SignedLinks('bill-recovery-test-signing-key-0000000', {
          claim: () => Promise.resolve(true),
        }),
        { add: vi.fn().mockResolvedValue({}) } as unknown as Queue,
        authz,
        audit,
      );
      documentsService.registerOwner(billDocumentOwnerPolicy(db));
      const uploads = new BillDocumentsService(db, caller, documentsService);
      let verdict: 'infected' | 'clean' = 'infected';
      const scanner = new ScanProcessor(
        db,
        storage,
        {
          scan: async (stream: Readable) => {
            for await (const _chunk of stream) {
              /* consume the file */
            }
            return { verdict, ms: 1 };
          },
          version: () => Promise.resolve('test scanner'),
        } as unknown as ClamdClient,
        audit,
        notify,
      );
      const vendorId = await vendor();
      const bytes = Buffer.from('%PDF-1.7\ninvoice\n');
      const file = {
        filename: 'invoice.pdf',
        declaredMime: 'application/pdf',
        sizeBytes: bytes.length,
      };
      const initial = await uploads.create({ ...file, vendorPartyId: vendorId });
      await uploads.receive(
        initial.documentId,
        initial.versionId,
        Readable.from(bytes),
        bytes.length,
      );
      expect(await scanner.scanVersion({ ...scopeA, versionId: initial.versionId }, true)).toBe(
        'infected',
      );
      const bill = await billWithoutPo(initial.documentId, vendorId);
      expect(codeOf(await httpErrorOf(service.submit(bill.id, randomUUID())))).toBe(
        'BILL_DOCUMENT_NOT_CLEAN',
      );
      const replacement = await uploads.createVersion(initial.documentId, file);
      await uploads.receive(
        replacement.documentId,
        replacement.versionId,
        Readable.from(bytes),
        bytes.length,
      );
      verdict = 'clean';
      expect(await scanner.scanVersion({ ...scopeA, versionId: replacement.versionId }, true)).toBe(
        'clean',
      );
      expect((await service.get(bill.id)).fileStatus).toBe('clean');
      expect((await service.submit(bill.id, randomUUID())).status).toBe('pending_approval');
      await expect(uploads.createVersion(initial.documentId, file)).rejects.toMatchObject({
        status: 409,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it.each<DocumentVersionStatus>(['awaiting_content', 'quarantined', 'infected', 'scan_failed'])(
    'refuses submit when the newest invoice version is %s even after an older clean version',
    async (status) => {
      const bill = await billWithoutPo(await doc(['clean', status]));
      const refused = await httpErrorOf(service.submit(bill.id, randomUUID()));
      expect(refused.getStatus()).toBe(409);
      expect(codeOf(refused)).toBe('BILL_DOCUMENT_NOT_CLEAN');
      expect(await service.get(bill.id)).toMatchObject({
        status: bill.status,
        version: bill.version,
        approvalRequestId: null,
      });
      expect(
        await read((tx) =>
          tx.select().from(approvalRequests).where(eq(approvalRequests.documentId, bill.id)),
        ),
      ).toHaveLength(0);
    },
  );

  it('refuses submit when the invoice document has no version', async () => {
    const bill = await billWithoutPo(await doc([]));
    const refused = await httpErrorOf(service.submit(bill.id, randomUUID()));
    expect(refused.getStatus()).toBe(409);
    expect(codeOf(refused)).toBe('BILL_DOCUMENT_NOT_CLEAN');
    expect((await service.get(bill.id)).approvalRequestId).toBeNull();
  });

  it('uses the newest non-rejected invoice version for submit', async () => {
    const bill = await billWithoutPo(await doc(['clean', 'rejected']));
    expect((await service.submit(bill.id, randomUUID())).status).toBe('pending_approval');
  });

  it('refuses submit when every invoice version was rejected', async () => {
    const bill = await billWithoutPo(await doc(['rejected']));
    expect(codeOf(await httpErrorOf(service.submit(bill.id, randomUUID())))).toBe(
      'BILL_DOCUMENT_NOT_CLEAN',
    );
  });

  it.each([
    'vendor_portal_intake',
    'verification_case',
    'payment_intake',
    'purchase_order_version',
  ])('refuses an unrelated %s invoice document', async (ownerType) => {
    const documentId = await doc();
    const ownerId =
      ownerType === 'vendor_portal_intake' ? await vendor() : documentVendors.get(documentId)!;
    await exec(
      scopeA,
      sql`UPDATE app.documents SET owner_type = ${ownerType}, owner_id = ${ownerId} WHERE id = ${documentId}`,
    );
    const refused = await httpErrorOf(billWithoutPo(documentId));
    expect(refused.getStatus()).toBe(422);
    expect(codeOf(refused)).toBe('DOCUMENT_NOT_FOUND');
  });

  it('refuses submit after the invoice document is removed', async () => {
    const bill = await billWithoutPo(await doc());
    await exec(
      scopeA,
      sql`UPDATE app.documents SET removed_at = now() WHERE id = ${bill.documentId}`,
    );
    const refused = await httpErrorOf(service.submit(bill.id, randomUUID()));
    expect(refused.getStatus()).toBe(422);
    expect(codeOf(refused)).toBe('DOCUMENT_NOT_FOUND');
    expect((await service.get(bill.id)).approvalRequestId).toBeNull();
  });

  it('refuses a removed document when entering a bill', async () => {
    const documentId = await doc();
    await exec(scopeA, sql`UPDATE app.documents SET removed_at = now() WHERE id = ${documentId}`);
    const refused = await httpErrorOf(billWithoutPo(documentId));
    expect(refused.getStatus()).toBe(422);
    expect(codeOf(refused)).toBe('DOCUMENT_NOT_FOUND');
  });

  it('keeps staff intake documents attached to their selected vendor', async () => {
    const documentId = await doc();
    const vendorId = await vendor();
    await exec(
      scopeA,
      sql`UPDATE app.documents SET owner_type = 'vendor_bill_intake', owner_id = ${vendorId}
          WHERE id = ${documentId}`,
    );
    const refused = await httpErrorOf(billWithoutPo(documentId, await vendor()));
    expect(refused.getStatus()).toBe(422);
    expect(codeOf(refused)).toBe('DOCUMENT_NOT_FOUND');
    const bill = await billWithoutPo(documentId, vendorId);
    expect(bill.vendorPartyId).toBe(vendorId);
  });

  it('allows submit once the newest version is clean', async () => {
    const bill = await billWithoutPo(await doc(['quarantined', 'clean']));
    const submitted = await service.submit(bill.id, randomUUID());
    expect(submitted.status).toBe('pending_approval');
    expect(submitted.approvalRequestId).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------------------- check 8, idempotency

describe('duplicates (check 8) and replays', () => {
  const billCounter = async () => {
    const result = await read((tx) =>
      tx.execute<{ next_value: string }>(sql`
        SELECT next_value::text FROM app.number_series
         WHERE tenant_id = ${scopeA.tenantId} AND organization_id = ${scopeA.organizationId}
           AND key = 'BILL'`),
    );
    return Number(result.rows[0]?.next_value ?? '1');
  };

  it('numbers the first submit once and keeps the BILL number on replay and returned resubmit', async () => {
    const bill = await billWithoutPo(await doc());
    expect(bill.number).toBeNull();
    const counterBefore = await billCounter();
    const key = randomUUID();
    const submitted = await service.submit(bill.id, key);
    expect(submitted.number).toMatch(/^BILL-\d{4}\/\d{2}-\d{5}$/);
    expect(await billCounter()).toBe(counterBefore + 1);
    const approvalNumber = async (id: string) =>
      (
        await read((tx) =>
          tx
            .select({ number: approvalRequests.documentNumber })
            .from(approvalRequests)
            .where(eq(approvalRequests.id, id)),
        )
      )[0]?.number;
    expect(await approvalNumber(submitted.approvalRequestId!)).toBe(submitted.number);
    expect(await service.submit(bill.id, key)).toEqual(submitted);
    expect(await billCounter()).toBe(counterBefore + 1);

    const pending = await requestOf(submitted.approvalRequestId!);
    as(U.acct2, 'accountant');
    try {
      await approvals.act(
        submitted.approvalRequestId!,
        {
          action: 'return',
          expectedVersion: pending.version,
          comment: 'Please clarify the invoice',
        },
        randomUUID(),
      );
    } finally {
      as(U.acct, 'accountant');
    }
    expect(await service.get(bill.id)).toMatchObject({ status: 'draft', number: submitted.number });
    const resubmitted = await service.submit(bill.id, randomUUID());
    expect(resubmitted.number).toBe(submitted.number);
    expect(resubmitted.approvalRequestId).not.toBe(submitted.approvalRequestId);
    expect(await approvalNumber(resubmitted.approvalRequestId!)).toBe(submitted.number);
    expect(await billCounter()).toBe(counterBefore + 1);
  });

  it('rolls back BILL numbering when approval has no eligible accountant', async () => {
    const bill = await billWithoutPo(await doc());
    const counterBefore = await billCounter();
    const accountants = roles.accountant!;
    roles.accountant = [U.acct];
    try {
      const blocked = await httpErrorOf(service.submit(bill.id, randomUUID()));
      expect(blocked.getStatus()).toBe(422);
      expect(codeOf(blocked)).toBe('NO_ELIGIBLE_APPROVER');
    } finally {
      roles.accountant = accountants;
    }
    expect(await service.get(bill.id)).toMatchObject({
      status: 'draft',
      number: null,
      approvalRequestId: null,
    });
    expect(await billCounter()).toBe(counterBefore);
    expect(
      await read((tx) =>
        tx
          .select({ id: approvalRequests.id })
          .from(approvalRequests)
          .where(eq(approvalRequests.documentId, bill.id)),
      ),
    ).toHaveLength(0);
  });

  it('INV-001 and inv 001 of one vendor collide: 409 and one row', async () => {
    const po = await receivedPo('2', '1000.00', '2');
    await billFor(po, '1', '1000.00', 'INV-001');
    const dup = await httpErrorOf(billFor(po, '1', '1000.00', 'inv 001'));
    expect(dup.getStatus()).toBe(409);
    expect(codeOf(dup)).toBe('DUPLICATE_BILL');
    const rows = await read((tx) =>
      tx
        .select({ id: vendorBills.id })
        .from(vendorBills)
        .where(eq(vendorBills.vendorId, po.vendorId)),
    );
    expect(rows).toHaveLength(1);
  });

  it('a replayed Idempotency-Key returns the same bill and writes nothing new', async () => {
    const po = await receivedPo('1', '1000.00', '1');
    const key = randomUUID();
    const body = {
      vendorPartyId: po.vendorId,
      kind: 'bill' as const,
      vendorInvoiceNo: 'R-1',
      invoiceDate: '2026-11-09',
      currency: 'NPR' as const,
      purchaseOrderId: po.id,
      documentId: await doc(['clean'], po.vendorId),
      lines: [
        {
          poLineId: po.lineId,
          accountId: randomUUID(),
          quantity: '1',
          unitPrice: '1000.00',
          taxCodeId: vatCode,
        },
      ],
    };
    const first = await service.create(body, key);
    const again = await service.create(body, key);
    expect(again.id).toBe(first.id);
    const rows = await read((tx) =>
      tx
        .select({ id: vendorBills.id })
        .from(vendorBills)
        .where(eq(vendorBills.vendorId, po.vendorId)),
    );
    expect(rows).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------- entity wall

describe('entity wall', () => {
  it('another entity reads a bill as 404 and cannot match or submit it', async () => {
    const po = await receivedPo('1', '1000.00', '1');
    const bill = await billFor(po, '1', '1000.00');
    current.scope = scopeB;
    expect((await httpErrorOf(service.get(bill.id))).getStatus()).toBe(404);
    expect((await httpErrorOf(service.submit(bill.id, randomUUID()))).getStatus()).toBe(404);
    expect((await httpErrorOf(service.match(bill.id, randomUUID()))).getStatus()).toBe(404);
  });

  it('a PO line of another PO is refused before the insert (422)', async () => {
    const po = await receivedPo('1', '1000.00', '1');
    const other = await receivedPo('1', '1000.00', '1');
    const e = await httpErrorOf(
      service.create(
        {
          vendorPartyId: po.vendorId,
          kind: 'bill',
          vendorInvoiceNo: 'X-1',
          invoiceDate: '2026-11-09',
          currency: 'NPR',
          purchaseOrderId: po.id,
          documentId: await doc(['clean'], po.vendorId),
          lines: [
            {
              poLineId: other.lineId,
              accountId: randomUUID(),
              quantity: '1',
              unitPrice: '1000.00',
              taxCodeId: vatCode,
            },
          ],
        },
        randomUUID(),
      ),
    );
    expect(e.getStatus()).toBe(422);
    expect(codeOf(e)).toBe('PO_LINE_NOT_FOUND');
  });
});
