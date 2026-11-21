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
  createExpenseAccount,
  createParty,
  createStaffUser,
  createTenantWithEntity,
  matchExceptions,
  matchResults,
  vendorBills,
} from '@bos/db';
import { ForbiddenException, HttpException } from '@nestjs/common';
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
import { asSecondPerson, SKIP_LIVE_PUBLISHER_CHECK } from '../../../../test/support/second-person';
import { EvidenceDocumentsService } from '../../evidence/evidence-documents.service';
import { evidenceFixture, type EvidenceFixture } from '../../evidence/evidence.fixture';
import { drizzleEvidenceRecordLoader } from '../../evidence/evidence-owner.policy';
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
import { VendorOrdersService } from './vendor-orders.service';
import { billDocumentOwnerPolicy, BillDocumentsService } from './bill-documents.service';
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
let orders: PurchaseOrdersService;
let receiptsService: ReceiptsService;
let pickers: VendorOrdersService;
let deptA = '';
let vatCode = '';
/** Evidence uploads through the real routes' service, DocumentsService and the `evidence` owner policy. */
let evidence: EvidenceFixture;
/** An active expense account of entity A: bill lines must book to one (round 5, unit P1). */
let expenseAccountId = '';

const U = { req: '', proc: '', acct: '', acct2: '', fin: '', mgmt: '', founder: '', wh: '' };
const roles: Partial<Record<RoleKey, string[]>> = {};

const grantsOf = (role: RoleKey) =>
  new Map(Object.entries(DEFAULT_ROLE_PERMISSIONS[role])) as Map<Permission, Scope>;
const current: {
  userId: string;
  role: RoleKey;
  scope: TxScope | null;
  /** Live grants an admin edited, instead of the role default (`as` clears it). */
  grants?: Map<Permission, Scope> | undefined;
  /** The caller's membership department (`as` clears it). */
  departmentId?: string | null;
} = {
  userId: '',
  role: 'accountant',
  scope: null,
};
const as = (userId: string, role: RoleKey) => {
  current.userId = userId;
  current.role = role;
  current.grants = undefined;
  current.departmentId = null;
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
  departmentId: current.departmentId ?? null,
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
  expenseAccountId = (await createExpenseAccount(appPool, scopeA)).id;

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
  orders = new PurchaseOrdersService(db, approvals, audit, caller, () => now);
  pickers = new VendorOrdersService(db, caller);
  receiptsService = new ReceiptsService(
    db,
    authz as unknown as AuthzService,
    audit,
    new NumberingService(),
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

/** A page wide enough for every row a test makes. */
const PAGE = { limit: 100, offset: 0 } as const;

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
/**
 * An issued PO in entity A with one line of `quantity` x `unitPrice` + 13% VAT, received `received`, raised from a
 * request of `requester` (U.req unless given).
 */
async function receivedPo(
  quantity: string,
  unitPrice: string,
  received: string,
  requester = U.req,
): Promise<Po> {
  const vendorId = await vendor();
  const a = quotationLineAmounts(quantity, unitPrice, 1300);
  const prId = randomUUID();
  await exec(
    scopeA,
    sql`INSERT INTO app.purchase_requests (id, tenant_id, organization_id, request_type, department_id,
          requester_user_id, cost_center_id, justification, required_by, budget_code, currency)
        VALUES (${prId}, ${scopeA.tenantId}, ${scopeA.organizationId}, 'goods', ${deptA}, ${requester},
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

/**
 * A document row of `ownerType` on `ownerId` with these versions, as an upload and its scan leave it: for evidence
 * in a state an upload alone cannot reach here (infected, removed, another entity) and for files of other owners.
 */
async function ownedDoc(
  ownerType: string,
  ownerId: string,
  versions: readonly DocumentVersionStatus[] = ['clean'],
  scope: TxScope = scopeA,
): Promise<string> {
  const { rows } = await exec(
    scope,
    sql`INSERT INTO app.documents (tenant_id, organization_id, owner_type, owner_id)
        VALUES (${scope.tenantId}, ${scope.organizationId}, ${ownerType}, ${ownerId}) RETURNING id`,
  );
  const documentId = (rows[0] as { id: string }).id;
  for (const [i, status] of versions.entries()) {
    await exec(
      scope,
      sql`INSERT INTO app.document_versions (tenant_id, organization_id, document_id, version, filename,
            declared_mime, size_bytes, storage_key, status)
          VALUES (${scope.tenantId}, ${scope.organizationId}, ${documentId}, ${i + 1}, 'evidence.pdf',
                  'application/pdf', 1024, ${`${scope.tenantId}/${randomUUID()}`}, ${status})`,
    );
  }
  return documentId;
}

/** A further version of an invoice document, as a later replacement or a scan result would leave it. */
async function addVersion(documentId: string, version: number, status: DocumentVersionStatus) {
  await exec(
    scopeA,
    sql`INSERT INTO app.document_versions (tenant_id, organization_id, document_id, version, filename,
          declared_mime, size_bytes, storage_key, status)
        VALUES (${scopeA.tenantId}, ${scopeA.organizationId}, ${documentId}, ${version}, 'invoice.pdf',
                'application/pdf', 1024, ${`${scopeA.tenantId}/${randomUUID()}`}, ${status})`,
  );
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
      lines: [
        { accountId: expenseAccountId, quantity: '1', unitPrice: '1000.00', taxCodeId: vatCode },
      ],
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
        {
          poLineId: po.lineId,
          accountId: expenseAccountId,
          quantity,
          unitPrice,
          taxCodeId: vatCode,
        },
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
          { accountId: expenseAccountId, quantity: '1', unitPrice: '1000.00', taxCodeId: vatCode },
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
    expect((await service.list(PAGE)).rows.find((row) => row.id === bill.id)).toMatchObject(
      expected,
    );
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
    const listed = (await service.list(PAGE)).rows;
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
    const row = (await service.list(PAGE)).rows.find((r) => r.id === bill.id)!;
    as(U.acct, 'accountant');
    const expectedKeys = [
      'approvalRequestId',
      'can',
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

  it('refuses a match exception whose evidence file the scan found infected (TR-Q12e)', async () => {
    const po = await receivedPo('1', '10000.00', '1');
    const bill = await billFor(po, '1', '11000.00');
    expect(bill.status).toBe('variance');
    const infected = await ownedDoc('evidence', bill.id, ['infected']);
    const refused = await httpErrorOf(
      service.requestException(
        bill.id,
        { reason: 'Vendor raised the price', evidenceDocumentId: infected },
        randomUUID(),
      ),
    );
    expect(refused.getStatus()).toBe(409);
    expect(codeOf(refused)).toBe('document_infected');
    expect((await service.get(bill.id)).status).toBe('variance');
    expect(
      await read((tx) =>
        tx.select().from(matchExceptions).where(eq(matchExceptions.vendorBillId, bill.id)),
      ),
    ).toHaveLength(0);
  });

  it('takes evidence uploaded to the bill in place, still scanning, and records it on the exception', async () => {
    const po = await receivedPo('1', '10000.00', '1');
    const bill = await billFor(po, '1', '11000.00');
    expect(bill.status).toBe('variance');
    // The accountant holds no documents.upload: the bill's own route and its payables.bill.enter grant suffice.
    expect(principalNow().grants.has('documents.upload')).toBe(false);
    const uploaded = await evidence.upload('vendor_bill', bill.id);
    const stored = await read((tx) =>
      tx.execute(sql`SELECT d.owner_type, d.owner_id, v.status FROM app.documents d
        JOIN app.document_versions v ON v.document_id = d.id WHERE d.id = ${uploaded}`),
    );
    expect(stored.rows).toEqual([
      { owner_type: 'evidence', owner_id: bill.id, status: 'quarantined' },
    ]);
    const exception = await service.requestException(
      bill.id,
      { reason: 'Vendor raised the price', evidenceDocumentId: uploaded },
      randomUUID(),
    );
    const [row] = await read((tx) =>
      tx.select().from(matchExceptions).where(eq(matchExceptions.id, exception.id)),
    );
    expect(row!.evidenceDocumentId).toBe(uploaded);
    expect((await service.get(bill.id)).status).toBe('exception_pending');
  });

  it.each<[string, (billId: string, vendorId: string) => Promise<string>]>([
    [
      'a removed evidence file',
      async (billId: string) => {
        const documentId = await ownedDoc('evidence', billId);
        await exec(
          scopeA,
          sql`UPDATE app.documents SET removed_at = now() WHERE id = ${documentId}`,
        );
        return documentId;
      },
    ],
    [
      "another entity's file on the same id",
      (billId: string) => ownedDoc('evidence', billId, ['clean'], scopeB),
    ],
    [
      "the bill's own invoice file",
      (_billId: string, vendorId: string) => doc(['clean'], vendorId),
    ],
    ['evidence of another record', () => ownedDoc('evidence', randomUUID())],
    [
      'a picture (a vendor logo)',
      (_billId: string, vendorId: string) => ownedDoc('vendor_logo', vendorId),
    ],
    [
      'a vendor-inbox upload',
      (_billId: string, vendorId: string) => ownedDoc('vendor_portal_intake', vendorId),
    ],
    ['an id that is no document', () => Promise.resolve(randomUUID())],
  ])(
    'refuses a match exception whose evidence is %s with 422 invalid_evidence_document and writes no exception',
    async (_label, evidenceOf) => {
      const po = await receivedPo('1', '10000.00', '1');
      const bill = await billFor(po, '1', '11000.00');
      expect(bill.status).toBe('variance');
      const evidenceId = await evidenceOf(bill.id, po.vendorId);
      const refused = await httpErrorOf(
        service.requestException(
          bill.id,
          { reason: 'Vendor raised the price', evidenceDocumentId: evidenceId },
          randomUUID(),
        ),
      );
      expect(refused.getStatus()).toBe(422);
      expect(codeOf(refused)).toBe('invalid_evidence_document');
      expect((await service.get(bill.id)).status).toBe('variance');
      expect(
        await read((tx) =>
          tx.select().from(matchExceptions).where(eq(matchExceptions.vendorBillId, bill.id)),
        ),
      ).toHaveLength(0);
    },
  );

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
      // Saved while the file is still being scanned (allowed), then the scan finds a virus.
      const bill = await billWithoutPo(initial.documentId, vendorId);
      expect(await scanner.scanVersion({ ...scopeA, versionId: initial.versionId }, true)).toBe(
        'infected',
      );
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
  it('refuses to save a bill on an invoice the scan found infected (TR-Q12e), and saves it once replaced', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bos-invoice-infected-'));
    try {
      const audit = new AuditService(db);
      const storage = new DiskStorageAdapter(root);
      const documentsService = new DocumentsService(
        db,
        storage,
        new SignedLinks('bill-infected-test-signing-key-00000000', {
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
        filename: 'eicar.pdf',
        declaredMime: 'application/pdf',
        sizeBytes: bytes.length,
      };
      const upload = await uploads.create({ ...file, vendorPartyId: vendorId });
      await uploads.receive(
        upload.documentId,
        upload.versionId,
        Readable.from(bytes),
        bytes.length,
      );
      expect(await scanner.scanVersion({ ...scopeA, versionId: upload.versionId }, true)).toBe(
        'infected',
      );
      const before = await read((tx) => tx.select({ id: vendorBills.id }).from(vendorBills));

      const refused = await httpErrorOf(billWithoutPo(upload.documentId, vendorId));
      expect(refused.getStatus()).toBe(409);
      expect(codeOf(refused)).toBe('document_infected');
      expect((refused.getResponse() as { message?: string }).message).not.toContain('eicar.pdf');
      expect(await read((tx) => tx.select({ id: vendorBills.id }).from(vendorBills))).toHaveLength(
        before.length,
      );

      // The way out: a replacement version. While it scans the bill can be saved (submit still needs clean).
      const replacement = await uploads.createVersion(upload.documentId, {
        ...file,
        filename: 'invoice.pdf',
      });
      await uploads.receive(
        replacement.documentId,
        replacement.versionId,
        Readable.from(bytes),
        bytes.length,
      );
      verdict = 'clean';
      const bill = await billWithoutPo(upload.documentId, vendorId);
      expect(bill.status).toBe('draft');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each<DocumentVersionStatus>(['awaiting_content', 'quarantined', 'infected', 'scan_failed'])(
    'refuses submit when the newest invoice version is %s even after an older clean version',
    async (status) => {
      // The bill is saved on the clean version; the newer one arrives (or scans infected) afterwards.
      const documentId = await doc(['clean']);
      const bill = await billWithoutPo(documentId);
      await addVersion(documentId, 2, status);
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

describe('the bill on its approval (U18 #2)', () => {
  it('shows the approver the bill and its own file only, and links the bill only for a bill reader', async () => {
    const vendorId = await vendor();
    const bill = await billWithoutPo(await doc(['clean'], vendorId), vendorId);
    // A second bill of the same vendor: its file has the same owner and must not appear on the first bill's approval.
    const other = await billWithoutPo(await doc(['clean'], vendorId), vendorId);
    const submitted = await service.submit(bill.id, randomUUID());

    // The first step's approver is another accountant, who may read bills.
    as(U.acct2, 'accountant');
    const forAccountant = await approvals.get(submitted.approvalRequestId!);
    expect(forAccountant.context).toMatchObject({
      href: `/payables/bills/${bill.id}`,
      documents: [{ documentId: bill.documentId, filename: 'invoice.pdf' }],
    });
    expect(forAccountant.context!.documents).toHaveLength(1);
    expect(forAccountant.context!.documents.map((d) => d.documentId)).not.toContain(
      other.documentId,
    );
    expect(forAccountant.context!.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: 'vendor', value: `Vendor ${vendorId.slice(0, 6)}` }),
        expect.objectContaining({ key: 'netTotal', kind: 'money', value: '1000.00' }),
        expect.objectContaining({ key: 'status', value: 'pending_approval' }),
      ]),
    );
    // Nothing beyond the bill's facts: not the vendor's PAN.
    const { rows } = await exec(scopeA, sql`SELECT pan FROM app.vendors WHERE id = ${vendorId}`);
    expect(JSON.stringify(forAccountant.context)).not.toContain((rows[0] as { pan: string }).pan);

    // Management decides the larger bands. It reads approval requests and documents but not bills, so it sees the
    // same record and file with no link to a page that would refuse it.
    as(U.mgmt, 'management');
    try {
      expect(grantsOf('management').has('payables.bill.read')).toBe(false);
      const forManagement = await approvals.get(submitted.approvalRequestId!);
      expect(forManagement.context).toMatchObject({
        href: null,
        documents: [{ documentId: bill.documentId }],
      });
    } finally {
      as(U.acct, 'accountant');
    }
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
          accountId: expenseAccountId,
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

describe('list filters, search and paging', () => {
  it('takes several statuses, searches by bill, vendor invoice or vendor, pages by offset and stays in the entity', async () => {
    const po = await receivedPo('1', '1000.00', '1');
    const invoiceNo = `FIND-${randomUUID().slice(0, 8)}`;
    const bill = await billFor(po, '1', '1000.00', invoiceNo);
    const other = await billFor(po, '1', '1000.00');
    const name = `Vendor ${po.vendorId.slice(0, 6)}`;
    const ids = (page: { rows: { id: string }[] }) => page.rows.map((r) => r.id);

    expect(ids(await service.list({ ...PAGE, status: [bill.status, 'rejected'] }))).toContain(
      bill.id,
    );
    expect(ids(await service.list({ ...PAGE, status: ['rejected'] }))).not.toContain(bill.id);

    const byInvoice = await service.list({ ...PAGE, q: invoiceNo });
    expect(ids(byInvoice)).toContain(bill.id);
    expect(byInvoice.total).toBeGreaterThanOrEqual(1);
    const byVendor = await service.list({ ...PAGE, q: name });
    expect(ids(byVendor)).toEqual(expect.arrayContaining([bill.id, other.id]));
    const byNumber = await service.list({ ...PAGE, q: bill.number ?? invoiceNo });
    expect(ids(byNumber)).toContain(bill.id);

    const all = await service.list(PAGE);
    const second = await service.list({ limit: 1, offset: 1 });
    expect(second.total).toBe(all.total);
    expect(second.rows[0]?.id).toBe(all.rows[1]?.id);

    current.scope = scopeB;
    expect(ids(await service.list({ ...PAGE, q: invoiceNo }))).not.toContain(bill.id);
    expect(ids(await service.list({ ...PAGE, status: [bill.status] }))).not.toContain(bill.id);
  });
});

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
              accountId: expenseAccountId,
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

// The payables purchase order pickers (U18 #12, #13): the accountant and Finance hold no purchase order read, so the
// bill and payment request forms list orders through VendorOrdersService, under their own form grant.
describe('purchase order pickers', () => {
  /** A PO of `vendorId` in entity A left in draft: never offered by either picker. */
  async function draftPo(vendorId: string): Promise<string> {
    const prId = randomUUID();
    await exec(
      scopeA,
      sql`INSERT INTO app.purchase_requests (id, tenant_id, organization_id, request_type, department_id,
            requester_user_id, cost_center_id, justification, required_by, budget_code, currency)
          VALUES (${prId}, ${scopeA.tenantId}, ${scopeA.organizationId}, 'goods', ${deptA}, ${U.req},
                  ${(await createCostCenter(appPool, scopeA)).costCenterId}, 'Chairs', '2026-12-01', 'IT-2083', 'NPR')`,
    );
    const id = randomUUID();
    poSeq += 1;
    await exec(
      scopeA,
      sql`INSERT INTO app.purchase_orders (id, tenant_id, organization_id, number, number_seq, fiscal_year,
            purchase_request_id, vendor_id, currency, payment_terms_days, approved_total, fx_rate,
            approved_total_npr, approved_band, created_by)
          VALUES (${id}, ${scopeA.tenantId}, ${scopeA.organizationId}, ${`PO-B-${poSeq}`}, ${poSeq}, '2082/83',
                  ${prId}, ${vendorId}, 'NPR', 30, '100.00', 1, '100.00', 'base', ${U.proc})`,
    );
    return id;
  }
  const ids = (rows: { id: string }[]) => rows.map((r) => r.id);

  it("offers the accountant the chosen vendor's billable orders, without a draft", async () => {
    const part = await receivedPo('2', '100.00', '1');
    const other = await receivedPo('1', '100.00', '1');
    const draft = await draftPo(part.vendorId);
    as(U.acct, 'accountant');

    const mine = await pickers.billable({ vendorId: part.vendorId, limit: 100 });
    expect(mine).toEqual([
      {
        id: part.id,
        number: expect.stringMatching(/^PO-B-\d+$/) as string,
        status: 'partially_received',
        vendorId: part.vendorId,
      },
    ]);
    const all = ids(await pickers.billable({ limit: 200 }));
    expect(all).toEqual(expect.arrayContaining([part.id, other.id]));
    expect(all).not.toContain(draft);
  });

  it('offers Finance the vendor orders a payment request can name, without a draft', async () => {
    const full = await receivedPo('1', '100.00', '1');
    const draft = await draftPo(full.vendorId);
    as(U.fin, 'finance');

    const rows = await pickers.forPaymentRequest({ vendorId: full.vendorId, limit: 100 });
    expect(ids(rows)).toEqual([full.id]);
    expect(rows[0]?.status).toBe('fully_received');
    expect(ids(rows)).not.toContain(draft);
  });

  it('returns only id, number, status and vendor: no amount, request or creator rides along', async () => {
    const po = await receivedPo('1', '100.00', '1');
    as(U.acct, 'accountant');
    const [bill] = await pickers.billable({ vendorId: po.vendorId, limit: 100 });
    as(U.fin, 'finance');
    const [pay] = await pickers.forPaymentRequest({ vendorId: po.vendorId, limit: 100 });
    for (const row of [bill, pay]) {
      expect(Object.keys(row ?? {}).sort()).toEqual(['id', 'number', 'status', 'vendorId']);
    }
  });

  it('offers an accountant with own-scope bill entry only the orders raised from their own requests', async () => {
    const mine = await receivedPo('1', '100.00', '1', U.acct);
    const theirs = await receivedPo('1', '100.00', '1');
    as(U.acct, 'accountant');
    current.grants = new Map([...grantsOf('accountant'), ['payables.bill.enter', 'own']]);

    const offered = await pickers.billable({ limit: 200 });
    expect(ids(offered)).toContain(mine.id);
    expect(ids(offered)).not.toContain(theirs.id);
    // Nothing of the other order rides along, not even under its own vendor filter.
    expect(await pickers.billable({ vendorId: theirs.vendorId, limit: 200 })).toEqual([]);
    for (const row of offered) {
      expect(Object.keys(row).sort()).toEqual(['id', 'number', 'status', 'vendorId']);
    }
    // The picker, the bill form's progress read and the order's Enter bill agree on both orders.
    await expect(receiptsService.progress(mine.id)).resolves.toMatchObject({
      purchaseOrderId: mine.id,
    });
    await expect(receiptsService.progress(theirs.id)).resolves.toMatchObject({
      purchaseOrderId: theirs.id,
    });
    expect((await orders.get(mine.id)).can).toEqual({ enterBill: true, receive: false });
    expect((await orders.get(theirs.id)).can).toEqual({ enterBill: false, receive: false });
  });

  it("never lists another entity's orders", async () => {
    const po = await receivedPo('1', '100.00', '1');
    current.scope = scopeB;
    as(U.acct, 'accountant');
    expect(ids(await pickers.billable({ limit: 200 }))).not.toContain(po.id);
    expect(await pickers.billable({ vendorId: po.vendorId, limit: 200 })).toEqual([]);
    as(U.fin, 'finance');
    expect(await pickers.forPaymentRequest({ vendorId: po.vendorId, limit: 200 })).toEqual([]);
  });
});

describe('saved reach on bills (U20a phase 2)', () => {
  const ids = (rows: readonly { id: string }[]) => rows.map((r) => r.id);
  /** The accountant's role with some grants narrowed, the way Settings > Access saves them. */
  const narrowed = (edits: readonly [Permission, Scope][]) =>
    new Map<Permission, Scope>([...grantsOf('accountant'), ...edits]);
  const enteredBy = async (userId: string) => {
    const { rows } = await exec(
      scopeA,
      sql`SELECT count(*)::int AS n FROM app.vendor_bills
          WHERE tenant_id = ${scopeA.tenantId} AND organization_id = ${scopeA.organizationId}
            AND entered_by = ${userId}`,
    );
    return (rows[0] as { n: number }).n;
  };

  it('own and department read only the bills the caller entered: the list, its total and get agree', async () => {
    as(U.acct, 'accountant');
    const mine = await billWithoutPo(await doc());
    as(U.acct2, 'accountant');
    const theirs = await billWithoutPo(await doc());

    // Bills carry no department, so `department` reaches what `own` reaches, whatever the caller's department.
    for (const reach of ['own', 'department'] as const) {
      as(U.acct, 'accountant');
      current.grants = narrowed([['payables.bill.read', reach]]);
      current.departmentId = deptA;
      const page = await service.list({ ...PAGE });
      expect(ids(page.rows), reach).toContain(mine.id);
      expect(ids(page.rows), reach).not.toContain(theirs.id);
      expect(page.total, reach).toBe(await enteredBy(U.acct));
      expect((await service.get(mine.id)).id).toBe(mine.id);
      expect((await httpErrorOf(service.get(theirs.id))).getStatus(), reach).toBe(404);
    }
  });

  it('a Founder-style `all` reads every bill of the entity', async () => {
    as(U.acct, 'accountant');
    const mine = await billWithoutPo(await doc());
    as(U.acct2, 'accountant');
    const theirs = await billWithoutPo(await doc());
    as(U.founder, 'founder');
    const page = await service.list({ ...PAGE });
    expect(ids(page.rows)).toEqual(expect.arrayContaining([mine.id, theirs.id]));
    expect((await service.get(theirs.id)).id).toBe(theirs.id);
  });

  it('own bill entry creates and changes only the bills the caller entered; a readable bill of another is 403', async () => {
    as(U.acct2, 'accountant');
    const theirs = await billWithoutPo(await doc());
    as(U.acct, 'accountant');
    current.grants = narrowed([['payables.bill.enter', 'own']]);

    // A new bill is the caller's own, so `own` may create it.
    const mine = await billWithoutPo(await doc());
    expect(mine.enteredBy).toBe(U.acct);
    for (const write of [
      () => service.discard(theirs.id, randomUUID()),
      () => service.submit(theirs.id, randomUUID()),
      () => service.match(theirs.id, randomUUID()),
    ]) {
      const e = await httpErrorOf(write());
      expect(e).toBeInstanceOf(ForbiddenException);
    }
    expect((await service.get(theirs.id)).status).toBe('draft');
    expect((await service.discard(mine.id, randomUUID())).status).toBe('discarded');
  });

  it('row can flags follow the enter grant per bill: own offers only own bills, all offers every bill, and the commands agree', async () => {
    as(U.acct, 'accountant');
    const mine = await billWithoutPo(await doc());
    as(U.acct2, 'accountant');
    const theirs = await billWithoutPo(await doc());
    const flagsOf = async (id: string) => ({
      row: (await service.list({ ...PAGE })).rows.find((r) => r.id === id)?.can,
      detail: (await service.get(id)).can,
    });
    const yes = { match: true, submit: true, void: true, discard: true, exception: true };
    const no = { match: false, submit: false, void: false, discard: false, exception: false };

    // A stored grant narrowed to `own`; read stays at the role's reach, so both bills are listed.
    as(U.acct, 'accountant');
    current.grants = narrowed([['payables.bill.enter', 'own']]);
    expect(await flagsOf(mine.id)).toEqual({ row: yes, detail: yes });
    expect(await flagsOf(theirs.id)).toEqual({ row: no, detail: no });
    // The flags never offer what the route refuses: every command on the other bill is 403 and changes nothing.
    for (const write of [
      () => service.match(theirs.id, randomUUID()),
      () => service.submit(theirs.id, randomUUID()),
      () => service.void(theirs.id, { reason: 'Entered twice' }, randomUUID()),
    ]) {
      expect(await httpErrorOf(write())).toBeInstanceOf(ForbiddenException);
    }
    expect((await service.get(theirs.id)).status).toBe('draft');

    // An `all` grant reaches every bill of the entity.
    current.grants = narrowed([['payables.bill.enter', 'all']]);
    expect(await flagsOf(mine.id)).toEqual({ row: yes, detail: yes });
    expect(await flagsOf(theirs.id)).toEqual({ row: yes, detail: yes });

    // A reader without bill entry (Finance) sees the bills with every flag off.
    as(U.fin, 'finance');
    expect(await flagsOf(theirs.id)).toEqual({ row: no, detail: no });
  });

  it('a command on a bill outside the read scope is a 404, as on get', async () => {
    as(U.acct2, 'accountant');
    const theirs = await billWithoutPo(await doc());
    as(U.acct, 'accountant');
    current.grants = narrowed([['payables.bill.read', 'own']]);
    expect((await httpErrorOf(service.discard(theirs.id, randomUUID()))).getStatus()).toBe(404);
    expect((await httpErrorOf(service.submit(theirs.id, randomUUID()))).getStatus()).toBe(404);
    as(U.acct2, 'accountant');
    expect((await service.get(theirs.id)).status).toBe('draft');
  });
});

// Round 5 P2: one `evidence` owner type spans sales orders, bills and RFQs, so the upload grant is the record kind's
// own (payables.bill.enter on a bill). Each refusal writes no document row and has a positive control beside it.
describe('evidence uploads on a bill (round 5 P2)', () => {
  const file = { filename: 'evidence.pdf', declaredMime: 'application/pdf', sizeBytes: 20 };
  const evidenceRows = (billId: string) =>
    read((tx) =>
      tx.execute(
        sql`SELECT id FROM app.documents WHERE owner_type = 'evidence' AND owner_id = ${billId}`,
      ),
    ).then((r) => r.rows.length);
  /** The generic POST /v1/documents, as its controller calls it. */
  const genericCreate = (billId: string) =>
    withTx(db, scopeNow(), caller.current().actor, (tx) =>
      evidence.documents.createFromRequest(tx, {
        ownerType: 'evidence',
        ownerId: billId,
        ...file,
      }),
    );
  async function varianceBill() {
    const po = await receivedPo('1', '10000.00', '1');
    const bill = await billFor(po, '1', '11000.00');
    expect(bill.status).toBe('variance');
    return bill;
  }

  it('(a) a sales-order grant (with documents.upload) never uploads evidence to a bill; the bill grant does', async () => {
    const bill = await varianceBill();
    current.grants = new Map<Permission, Scope>([
      ['documents.upload', 'all'],
      ['sales_order.mark_billable', 'all'],
      ['sales_order.read', 'all'],
    ]);
    expect((await httpErrorOf(genericCreate(bill.id))).getStatus()).toBe(403);
    // The sales-order route resolves the id to a bill, not an order: 404.
    expect(
      (await httpErrorOf(evidence.service.create('sales_order', bill.id, file))).getStatus(),
    ).toBe(404);
    expect(
      (await httpErrorOf(evidence.service.create('vendor_bill', bill.id, file))).getStatus(),
    ).toBe(403);
    expect(await evidenceRows(bill.id)).toBe(0);

    as(U.acct, 'accountant');
    await evidence.service.create('vendor_bill', bill.id, file);
    expect(await evidenceRows(bill.id)).toBe(1);
  });

  it('(b) generic documents.upload alone cannot post evidence to POST v1/documents; with the bill grant it can', async () => {
    const bill = await varianceBill();
    current.grants = new Map<Permission, Scope>([['documents.upload', 'all']]);
    const refused = await httpErrorOf(genericCreate(bill.id));
    expect(refused.getStatus()).toBe(403);
    expect(await evidenceRows(bill.id)).toBe(0);

    current.grants = new Map<Permission, Scope>([
      ['documents.upload', 'all'],
      ['payables.bill.enter', 'all'],
    ]);
    await genericCreate(bill.id);
    expect(await evidenceRows(bill.id)).toBe(1);
  });

  it('an own bill enterer uploads evidence to the bills they entered only', async () => {
    const bill = await varianceBill();
    as(U.acct2, 'accountant');
    current.grants = new Map<Permission, Scope>([
      ['payables.bill.read', 'all'],
      ['payables.bill.enter', 'own'],
    ]);
    expect(
      (await httpErrorOf(evidence.service.create('vendor_bill', bill.id, file))).getStatus(),
    ).toBe(403);
    as(U.acct, 'accountant');
    current.grants = new Map<Permission, Scope>([
      ['payables.bill.read', 'all'],
      ['payables.bill.enter', 'own'],
    ]);
    await evidence.service.create('vendor_bill', bill.id, file);
    expect(await evidenceRows(bill.id)).toBe(1);
  });

  it('(c) a bill of another entity is a 404 on both paths, and a portal caller is refused', async () => {
    const bill = await varianceBill();
    current.scope = scopeB;
    expect(
      (await httpErrorOf(evidence.service.create('vendor_bill', bill.id, file))).getStatus(),
    ).toBe(404);
    current.grants = new Map<Permission, Scope>([
      ['documents.upload', 'all'],
      ['payables.bill.enter', 'all'],
    ]);
    expect((await httpErrorOf(genericCreate(bill.id))).getStatus()).toBe(404);
    current.scope = null;
    expect(await evidenceRows(bill.id)).toBe(0);

    const portal = {
      current: () => ({
        ...caller.current(),
        principal: { ...principalNow(), orgKind: 'vendor' as const },
      }),
    };
    const asPortal = new EvidenceDocumentsService(
      db,
      drizzleEvidenceRecordLoader(db),
      portal,
      evidence.documents,
    );
    expect((await httpErrorOf(asPortal.create('vendor_bill', bill.id, file))).getStatus()).toBe(
      403,
    );
  });

  it('(c) another tenant: its caller gets a 404 on both paths, and its evidence on the same id is refused', async () => {
    const bill = await varianceBill();
    const other = await createTenantWithEntity(appPool);
    const scopeC: TxScope = { tenantId: other.tenantId, organizationId: other.organizationId };

    current.scope = scopeC;
    current.grants = new Map<Permission, Scope>([
      ['documents.upload', 'all'],
      ['payables.bill.enter', 'all'],
    ]);
    expect(
      (await httpErrorOf(evidence.service.create('vendor_bill', bill.id, file))).getStatus(),
    ).toBe(404);
    expect((await httpErrorOf(genericCreate(bill.id))).getStatus()).toBe(404);
    current.scope = null;
    current.grants = undefined;
    expect(await evidenceRows(bill.id)).toBe(0);

    // A file of the other tenant filed as evidence on the same id is not this bill's.
    const foreign = await ownedDoc('evidence', bill.id, ['clean'], scopeC);
    const refused = await httpErrorOf(
      service.requestException(
        bill.id,
        { reason: 'Vendor raised the price', evidenceDocumentId: foreign },
        randomUUID(),
      ),
    );
    expect(refused.getStatus()).toBe(422);
    expect(refused.getResponse()).toMatchObject({ code: 'invalid_evidence_document' });
  });

  it('refuses evidence once the bill is past entry (409) and on a discarded bill', async () => {
    const bill = await billWithoutPo(await doc());
    await service.discard(bill.id, randomUUID());
    const refused = await httpErrorOf(evidence.service.create('vendor_bill', bill.id, file));
    expect(refused.getStatus()).toBe(409);
    expect(await evidenceRows(bill.id)).toBe(0);
  });

  it('refuses evidence reserved on the bill route whose bytes were never sent (422), and requests nothing', async () => {
    const bill = await varianceBill();
    const reserved = await evidence.service.create('vendor_bill', bill.id, file);
    const refused = await httpErrorOf(
      service.requestException(
        bill.id,
        { reason: 'Vendor raised the price', evidenceDocumentId: reserved.documentId },
        randomUUID(),
      ),
    );
    expect(refused.getStatus()).toBe(422);
    expect(refused.getResponse()).toMatchObject({
      code: 'invalid_evidence_document',
      message: expect.stringMatching(/has not finished uploading/) as string,
    });
    expect((await service.get(bill.id)).status).toBe('variance');
  });

  it('refuses evidence whose upload claimed the version but has not recorded its bytes yet (422), and requests nothing', async () => {
    const bill = await varianceBill();
    const reserved = await evidence.service.create('vendor_bill', bill.id, file);
    // The receive's first transaction: claimed (quarantined) before any byte is stored, no sha256 yet.
    await exec(
      scopeA,
      sql`UPDATE app.document_versions SET status = 'quarantined' WHERE document_id = ${reserved.documentId}::uuid`,
    );
    const refused = await httpErrorOf(
      service.requestException(
        bill.id,
        { reason: 'Vendor raised the price', evidenceDocumentId: reserved.documentId },
        randomUUID(),
      ),
    );
    expect(refused.getStatus()).toBe(422);
    expect(refused.getResponse()).toMatchObject({
      code: 'invalid_evidence_document',
      message: expect.stringMatching(/has not finished uploading/) as string,
    });
    expect((await service.get(bill.id)).status).toBe('variance');
  });

  it('freezes the evidence an exception took: no removal or new version while the bill is still open', async () => {
    const bill = await varianceBill();
    const uploaded = await evidence.upload('vendor_bill', bill.id);
    await service.requestException(
      bill.id,
      { reason: 'Vendor raised the price', evidenceDocumentId: uploaded },
      randomUUID(),
    );
    expect((await service.get(bill.id)).status).toBe('exception_pending');
    current.grants = new Map<Permission, Scope>([
      ['documents.upload', 'all'],
      ['payables.bill.enter', 'all'],
    ]);
    const { scope, actor } = caller.current();
    // Its uploader cannot remove it on the bill's own route; the generic routes take no evidence file at all.
    const removed = await httpErrorOf(evidence.service.remove('vendor_bill', bill.id, uploaded));
    expect(removed.getStatus()).toBe(409);
    expect(removed.getResponse()).toMatchObject({
      message: 'This record no longer accepts attachments',
    });
    const versioned = await httpErrorOf(
      withTx(db, scope, actor, (tx) => evidence.documents.createVersion(tx, uploaded, file)),
    );
    expect(versioned.getStatus()).toBe(409);
  });

  it('keeps photos as evidence (a photographed delivery note) and receives the bytes only on its own bill route', async () => {
    const bill = await varianceBill();
    const jpeg = Buffer.concat([
      Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]),
      Buffer.alloc(64),
    ]);
    const created = await evidence.service.create('vendor_bill', bill.id, {
      filename: 'delivery-note.jpg',
      declaredMime: 'image/jpeg',
      sizeBytes: jpeg.length,
    });
    // Another bill's route, or the RFQ route, does not take this file's bytes.
    const other = await varianceBill();
    for (const [kind, id] of [
      ['vendor_bill', other.id],
      ['rfq', bill.id],
    ] as const) {
      const refused = await httpErrorOf(
        evidence.service.receive(
          kind,
          id,
          created.documentId,
          created.versionId,
          Readable.from(jpeg),
          jpeg.length,
        ),
      );
      expect(refused.getStatus()).toBe(404);
    }
    const received = await evidence.service.receive(
      'vendor_bill',
      bill.id,
      created.documentId,
      created.versionId,
      Readable.from(jpeg),
      jpeg.length,
    );
    expect(received.status).toBe('quarantined');
    expect(created.uploadPath).toBe(
      `/v1/payables/bills/${bill.id}/evidence-documents/${created.documentId}/versions/${created.versionId}/content`,
    );
  });
});

// Round 5 P2: the dialog's Remove (and closing it unsaved) deletes the abandoned file through the bill's own
// evidence route, which the Accountant reaches without documents.upload. Only the uploader, holding the bill grant
// on this bill, removes a file of this bill that no exception took, while the bill still takes evidence.
describe('removing evidence from a bill before save (round 5 P2)', () => {
  const removedAt = (documentId: string) =>
    read((tx) =>
      tx.execute(sql`SELECT removed_at FROM app.documents WHERE id = ${documentId}`),
    ).then((r) => (r.rows[0] as { removed_at: string | null } | undefined)?.removed_at);
  async function varianceBill() {
    const po = await receivedPo('1', '10000.00', '1');
    const bill = await billFor(po, '1', '11000.00');
    expect(bill.status).toBe('variance');
    return bill;
  }

  it('lets the Accountant remove their unused upload: the exception then refuses it, and a second removal is the same success', async () => {
    const bill = await varianceBill();
    expect(principalNow().grants.has('documents.upload')).toBe(false);
    const uploaded = await evidence.upload('vendor_bill', bill.id);
    const cleanup = vi.spyOn(evidence.documents, 'cleanupRemoved');
    await evidence.service.remove('vendor_bill', bill.id, uploaded);
    const first = await removedAt(uploaded);
    expect(first).not.toBeNull();
    // The quarantined bytes of the abandoned upload are deleted after the commit.
    expect(cleanup).toHaveBeenCalledWith([
      expect.objectContaining({ documentId: uploaded, status: 'quarantined' }),
    ]);
    cleanup.mockRestore();

    const refused = await httpErrorOf(
      service.requestException(
        bill.id,
        { reason: 'Vendor raised the price', evidenceDocumentId: uploaded },
        randomUUID(),
      ),
    );
    expect(refused.getStatus()).toBe(422);
    expect(refused.getResponse()).toMatchObject({ code: 'invalid_evidence_document' });

    await evidence.service.remove('vendor_bill', bill.id, uploaded);
    expect(await removedAt(uploaded)).toEqual(first);
  });

  it('answers 404 for a file of another bill, through another kind of route and for a file that is not evidence', async () => {
    const bill = await varianceBill();
    const other = await varianceBill();
    const uploaded = await evidence.upload('vendor_bill', bill.id);
    for (const [kind, id] of [
      ['vendor_bill', other.id],
      ['sales_order', bill.id],
      ['rfq', bill.id],
    ] as const) {
      expect((await httpErrorOf(evidence.service.remove(kind, id, uploaded))).getStatus()).toBe(
        404,
      );
    }
    // The bill's own invoice document is the bill's file, but not evidence uploaded to it.
    // Neither is a file of another owner type that names the bill's id.
    const invoiceDoc = bill.documentId;
    const otherType = await ownedDoc('test_evidence', bill.id, ['quarantined']);
    for (const id of [invoiceDoc, otherType]) {
      expect(
        (await httpErrorOf(evidence.service.remove('vendor_bill', bill.id, id))).getStatus(),
      ).toBe(404);
      expect(await removedAt(id)).toBeNull();
    }
    expect(await removedAt(uploaded)).toBeNull();
  });

  it('refuses a file the exception took (409) and an unused file once the bill stopped taking evidence (409)', async () => {
    const bill = await varianceBill();
    const taken = await evidence.upload('vendor_bill', bill.id);
    const unused = await evidence.upload('vendor_bill', bill.id);
    await service.requestException(
      bill.id,
      { reason: 'Vendor raised the price', evidenceDocumentId: taken },
      randomUUID(),
    );
    expect(
      (await httpErrorOf(evidence.service.remove('vendor_bill', bill.id, taken))).getStatus(),
    ).toBe(409);
    expect(await removedAt(taken)).toBeNull();
    // The exception is pending: the bill still takes evidence, so the unused file goes.
    await evidence.service.remove('vendor_bill', bill.id, unused);
    expect(await removedAt(unused)).not.toBeNull();

    const draft = await billWithoutPo(await doc());
    const left = await evidence.upload('vendor_bill', draft.id);
    await service.discard(draft.id, randomUUID());
    expect(
      (await httpErrorOf(evidence.service.remove('vendor_bill', draft.id, left))).getStatus(),
    ).toBe(409);
    expect(await removedAt(left)).toBeNull();
  });

  it('refuses another entity, another tenant (both ways) and a portal caller', async () => {
    const bill = await varianceBill();
    const uploaded = await evidence.upload('vendor_bill', bill.id);

    current.scope = scopeB;
    expect(
      (await httpErrorOf(evidence.service.remove('vendor_bill', bill.id, uploaded))).getStatus(),
    ).toBe(404);

    const other = await createTenantWithEntity(appPool);
    const scopeC: TxScope = { tenantId: other.tenantId, organizationId: other.organizationId };
    current.scope = scopeC;
    current.grants = new Map<Permission, Scope>([['payables.bill.enter', 'all']]);
    expect(
      (await httpErrorOf(evidence.service.remove('vendor_bill', bill.id, uploaded))).getStatus(),
    ).toBe(404);
    current.scope = null;
    current.grants = undefined;
    // A tenant C file filed as evidence on the same id is not this bill's.
    const foreign = await ownedDoc('evidence', bill.id, ['quarantined'], scopeC);
    expect(
      (await httpErrorOf(evidence.service.remove('vendor_bill', bill.id, foreign))).getStatus(),
    ).toBe(404);

    const portal = {
      current: () => ({
        ...caller.current(),
        principal: { ...principalNow(), orgKind: 'vendor' as const },
      }),
    };
    const asPortal = new EvidenceDocumentsService(
      db,
      drizzleEvidenceRecordLoader(db),
      portal,
      evidence.documents,
    );
    expect((await httpErrorOf(asPortal.remove('vendor_bill', bill.id, uploaded))).getStatus()).toBe(
      403,
    );
    expect(await removedAt(uploaded)).toBeNull();
  });

  it('refuses a caller without the bill grant on this bill, and anyone but the uploader', async () => {
    const bill = await varianceBill();
    const uploaded = await evidence.upload('vendor_bill', bill.id);

    // documents.upload alone (the generic grant) does not reach the bill route.
    current.grants = new Map<Permission, Scope>([['documents.upload', 'all']]);
    expect(
      (await httpErrorOf(evidence.service.remove('vendor_bill', bill.id, uploaded))).getStatus(),
    ).toBe(403);
    // Another Accountant with the grant on every bill is not the uploader.
    as(U.acct2, 'accountant');
    expect(
      (await httpErrorOf(evidence.service.remove('vendor_bill', bill.id, uploaded))).getStatus(),
    ).toBe(403);
    expect(await removedAt(uploaded)).toBeNull();

    // An uploader whose grant no longer reaches the bill (own enterer; U.acct entered it) is refused, before and
    // after the file is removed: an already-removed file is no way around the grant.
    const theirs = await evidence.upload('vendor_bill', bill.id);
    const later = await evidence.upload('vendor_bill', bill.id);
    await evidence.service.remove('vendor_bill', bill.id, theirs);
    current.grants = new Map<Permission, Scope>([['payables.bill.enter', 'own']]);
    for (const id of [later, theirs]) {
      expect(
        (await httpErrorOf(evidence.service.remove('vendor_bill', bill.id, id))).getStatus(),
      ).toBe(403);
    }
    expect(await removedAt(later)).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------- expense accounts

describe('bill line expense accounts (round 5, unit P1)', () => {
  const nprBody = (documentId: string, accountIds: readonly string[]) => ({
    vendorPartyId: documentVendors.get(documentId)!,
    kind: 'bill' as const,
    vendorInvoiceNo: `ACC-${randomUUID().slice(0, 8)}`,
    invoiceDate: '2026-11-09',
    currency: 'NPR' as const,
    documentId,
    lines: accountIds.map((accountId) => ({
      accountId,
      quantity: '1',
      unitPrice: '500.00',
      taxCodeId: vatCode,
    })),
  });
  const billCounter = async () => {
    const result = await read((tx) =>
      tx.execute<{ next_value: string }>(sql`
        SELECT next_value::text FROM app.number_series
         WHERE tenant_id = ${scopeA.tenantId} AND organization_id = ${scopeA.organizationId}
           AND key = 'BILL'`),
    );
    return Number(result.rows[0]?.next_value ?? '1');
  };
  const enteredAudits = async () => {
    const result = await ownerPool.query<{ count: string }>(
      "SELECT count(*) FROM audit.audit_events WHERE tenant_id = $1 AND action = 'payables.bill.entered'",
      [scopeA.tenantId],
    );
    return Number(result.rows[0]?.count);
  };

  it.each([
    ['an unknown id', () => Promise.resolve(randomUUID())],
    [
      'a retired account',
      async () => (await createExpenseAccount(appPool, { ...scopeA, status: 'retired' })).id,
    ],
    ["another entity's account", async () => (await createExpenseAccount(appPool, scopeB)).id],
  ])('%s: 422 EXPENSE_ACCOUNT_INVALID and no bill, line, number or audit', async (_label, bad) => {
    const badId = await bad();
    const documentId = await doc();
    const body = nprBody(documentId, [expenseAccountId, badId]);
    const counterBefore = await billCounter();
    const auditsBefore = await enteredAudits();

    const e = await httpErrorOf(service.create(body, randomUUID()));
    expect(e.getStatus()).toBe(422);
    expect(codeOf(e)).toBe('EXPENSE_ACCOUNT_INVALID');

    const rows = await read((tx) =>
      tx
        .select({ id: vendorBills.id })
        .from(vendorBills)
        .where(eq(vendorBills.vendorInvoiceNo, body.vendorInvoiceNo)),
    );
    expect(rows).toHaveLength(0);
    expect(await billCounter()).toBe(counterBefore);
    expect(await enteredAudits()).toBe(auditsBefore);
  });

  it('an active account of this entity is accepted, and two lines may share it', async () => {
    const bill = await service.create(
      nprBody(await doc(), [expenseAccountId, expenseAccountId]),
      randomUUID(),
    );
    expect(bill.status).toBe('draft');
    expect(bill.lines.map((l) => l.accountId)).toEqual([expenseAccountId, expenseAccountId]);
  });

  it('a replayed key returns the stored bill even after its account is retired', async () => {
    const account = await createExpenseAccount(appPool, scopeA);
    const body = nprBody(await doc(), [account.id]);
    const key = randomUUID();
    const first = await service.create(body, key);
    await exec(
      scopeA,
      sql`UPDATE app.expense_accounts SET status = 'retired', retired_at = now() WHERE id = ${account.id}`,
    );
    const again = await service.create(body, key);
    expect(again.id).toBe(first.id);
    // A new key with the now-retired account is refused.
    const e = await httpErrorOf(service.create(body, randomUUID()));
    expect(codeOf(e)).toBe('EXPENSE_ACCOUNT_INVALID');
  });
});
