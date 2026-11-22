// Integration tests of changing the vendor of a draft purchase order (F1-Q40 a; R4f Q2a; K3 Q1 b, Q2) on a real
// Postgres (Testcontainers, needs Docker in WSL). P2's SourcingService and PrCommitmentSubject write a real
// commitment draft (header only, linked to its RFQ and recommended quotation, with extra vendors' quotations
// recorded on the same RFQ before recommendation), and PurchaseOrdersService.changeVendor moves it to another
// vendor's own quotation (immediately when the total matches, or via a `po_vendor_change` approval when it differs).
// Drafts inserted directly with no RFQ (`plainDraft`) cover the NO_RFQ refusal and status/ownership/reference checks.
// Real: migrations as bos_owner, queries as bos_app (so the version trigger, the purchase_orders CHECKs and the
// vendor_bank_accounts CHECKs run), PurchaseOrdersService, ApprovalsService, PoVendorChangeSubject, AuditService,
// SourcingService, MoneyService. Faked: notify, the role directory, settings, the request context (a fake principal).
// Run: pnpm --filter @bos/api exec vitest run src/modules/procurement/orders/purchase-orders.change-vendor.integration.test.ts
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
  approvalActions,
  approvalRequests,
  approvalSteps,
  createCostCenter,
  createDepartment,
  createParty,
  createStaffUser,
  createTenantWithEntity,
  purchaseOrderLines,
  purchaseOrders,
} from '@bos/db';
import { createTestDatabase, type TestDatabase } from '@bos/db/testing';
import { HttpException, type ArgumentsHost } from '@nestjs/common';
import { asc, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { asSecondPerson, SKIP_LIVE_PUBLISHER_CHECK } from '../../../../test/support/second-person';
import { AuditService } from '../../../platform/audit/audit.service';
import type { Principal } from '../../../platform/authz/principal';
import type { Db, DbTransaction } from '../../../platform/db/db.module';
import { systemActor, withTx, type TxScope } from '../../../platform/db/tx';
import { MoneyService } from '../../../platform/settings/money.service';
import { NumberingService } from '../../../platform/settings/numbering.service';
import { ErrorBodyFilter } from '../../../platform/tenancy/error-body.filter';
import { ApprovalsAdminService } from '../../approvals/admin.service';
import { ApprovalsService } from '../../approvals/requests.service';
import { evidenceFixture, type EvidenceFixture } from '../../evidence/evidence.fixture';
import { PrCommitmentSubject } from '../sourcing/pr-commitment.subject';
import {
  PR_COMMITMENT_DOCUMENT_TYPE,
  PR_COMMITMENT_WORKFLOW_SPEC,
  quotationLineAmounts,
} from '../sourcing/sourcing.rules';
import { SourcingService, type QuotationDto } from '../sourcing/sourcing.service';
import { PoAmendmentSubject } from './po-amendment.subject';
import { PO_ISSUE_ACTION, PO_READ_ONLY_ACTIONS } from './po-read-access';
import {
  PO_VENDOR_CHANGE_DOCUMENT_TYPE,
  PO_VENDOR_CHANGE_WORKFLOW_SPEC,
} from './po-vendor-change.rules';
import { PoVendorChangeSubject } from './po-vendor-change.subject';
import {
  ChangePurchaseOrderVendorBodySchema,
  IssuePurchaseOrderBodySchema,
  PO_AMENDMENT_DOCUMENT_TYPE,
  PO_AMENDMENT_WORKFLOW_SPEC,
} from './purchase-order.rules';
import { PurchaseOrdersService } from './purchase-orders.service';

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
let deptB = '';
let vatCode = '';
let exemptCode = '';
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
const current: { userId: string; role: RoleKey; grants: Map<Permission, Scope> | null } = {
  userId: '',
  role: 'procurement',
  grants: null,
};
const as = (userId: string, role: RoleKey) => {
  current.userId = userId;
  current.role = role;
};
/** `role`'s default grants without any grant that opens purchase orders. */
const withoutPoGrants = (role: RoleKey) =>
  new Map(
    [...grantsOf(role)].filter(([p]) => p !== PO_ISSUE_ACTION && !PO_READ_ONLY_ACTIONS.includes(p)),
  );
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
  grants: current.grants ?? grantsOf(current.role),
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
  deptB = (await createDepartment(appPool, scopeB)).departmentId;

  const vat = await exec(
    scopeA,
    sql`INSERT INTO app.tax_codes (tenant_id, code, name, kind, rate_bp, creditable, effective_from)
        VALUES (${scopeA.tenantId}, 'VAT13', 'VAT 13%', 'vat', 1300, true, '2020-01-01') RETURNING id`,
  );
  vatCode = (vat.rows[0] as { id: string }).id;
  const exempt = await exec(
    scopeA,
    sql`INSERT INTO app.tax_codes (tenant_id, code, name, kind, rate_bp, creditable, effective_from)
        VALUES (${scopeA.tenantId}, 'EXEMPT', 'VAT Exempt', 'exempt', 0, false, '2020-01-01') RETURNING id`,
  );
  exemptCode = (exempt.rows[0] as { id: string }).id;
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
    key: PO_VENDOR_CHANGE_DOCUMENT_TYPE,
    name: 'Purchase order vendor change',
    spec: PO_VENDOR_CHANGE_WORKFLOW_SPEC,
  });
  await adminPublisher.publish(PO_VENDOR_CHANGE_DOCUMENT_TYPE, 1, SKIP_LIVE_PUBLISHER_CHECK);
  await admin.createWorkflow({
    key: PR_COMMITMENT_DOCUMENT_TYPE,
    name: 'Purchase commitment',
    spec: PR_COMMITMENT_WORKFLOW_SPEC,
  });
  await adminPublisher.publish(PR_COMMITMENT_DOCUMENT_TYPE, 1, SKIP_LIVE_PUBLISHER_CHECK);

  approvals = new ApprovalsService(db, audit, notify, directory, caller, () => now);
  approvals.registerSubject(new PoAmendmentSubject(audit, approvals, () => now));
  approvals.registerSubject(new PoVendorChangeSubject(audit, approvals, () => now));
  service = new PurchaseOrdersService(db, approvals, audit, caller, () => now);
  const numbering = new NumberingService();
  approvals.registerSubject(new PrCommitmentSubject(numbering, () => now));
  const settings = {
    get: (_s: unknown, key: string) =>
      Promise.resolve(
        key === 'currency.enabled'
          ? ['NPR', 'USD', 'INR']
          : key === 'fx.max_rate_age_days'
            ? undefined
            : 1,
      ),
  } as never;
  const money = new MoneyService(db, settings);
  await withTx(db, scopeA, { kind: 'user', id: U.acct, correlationId: 'test-corr' }, (tx) =>
    money.setRate(tx, 'USD', '135.00', '2026-11-09', 'NRB'),
  );
  sourcing = new SourcingService(
    db,
    approvals,
    audit,
    numbering,
    money,
    settings,
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
  current.grants = null;
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
  const req = { method: 'POST', path: '/v1/purchase-orders/x/change-vendor', headers: {} };
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
type CurrencyCode = 'NPR' | 'INR' | 'USD';
let panSeq = 0;
/**
 * A vendor of tenant A in `status` with an active account in each of `accountIn` (entity A by default; on terms
 * `termId` when given), `vatRegistered` (`false` by default, matching the DB column), and a bank account in
 * `bankCurrency` (`'NPR'` by default): `active` (verified by another person with call-back evidence, the default),
 * `proposed` (not verified) or `none`.
 */
async function vendor(
  status: VendorStatus = 'approved',
  opts: {
    accountIn?: TxScope[];
    bank?: 'active' | 'proposed' | 'none';
    bankCurrency?: CurrencyCode;
    termId?: string;
    vatRegistered?: boolean;
  } = {},
): Promise<string> {
  const { partyId } = await createParty(appPool, {
    tenantId: scopeA.tenantId,
    kind: 'vendor',
    organizationId: scopeA.organizationId,
  });
  await exec(
    scopeA,
    sql`INSERT INTO app.vendors (id, tenant_id, legal_name, pan, vat_registered, status, created_by, approved_by)
        VALUES (${partyId}, ${scopeA.tenantId}, ${`Vendor ${partyId.slice(0, 6)}`},
                ${String(400_000_000 + (panSeq += 1))}, ${opts.vatRegistered ?? false}, ${status}, ${U.proc},
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
            account_number_enc, account_fingerprint, last4, currency, status, proposed_by, proposed_via,
            verified_by, callback_evidence_document_id)
          VALUES (${scopeA.tenantId}, ${partyId}, 'Nabil Bank', 'Vendor Pvt Ltd', decode('00', 'hex'),
                  ${`fp-${randomUUID()}`}, '1234', ${opts.bankCurrency ?? 'NPR'}, ${bank}, ${U.proc}, 'staff',
                  ${active ? U.fin : null}, ${doc})`,
    );
  }
  return partyId;
}

async function decide(
  user: string,
  role: RoleKey,
  requestId: string,
  action: 'approve' | 'reject' | 'return' = 'approve',
  comment?: string,
) {
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
      {
        action,
        expectedVersion: req!.version,
        ...(action !== 'approve' ? { comment: comment ?? 'Keep original vendor' } : {}),
      },
      randomUUID(),
    );
  } finally {
    as(U.proc, 'procurement');
  }
}

async function approve(user: string, role: RoleKey, requestId: string) {
  await decide(user, role, requestId, 'approve');
}

interface ExtraQuoteSpec {
  vendorId: string;
  /** Quantity quoted; defaults to `'2'`. */
  quantity?: string;
  /** Unit price quoted; defaults to `'39000.00'` (same total as the recommended quote). */
  unitPrice?: string;
  /** Currency quoted; defaults to `'NPR'`. */
  currency?: CurrencyCode;
  /** Tax code id; defaults to `vatCode` (13% VAT). */
  taxCodeId?: string;
}

/**
 * The lineless draft P2 writes for an approved commitment: one request line of 2 laptops quoted at 39,000.00 + 13%
 * VAT by `vendorId` (88,140.00 incl. VAT, band base), linked to its RFQ and quotation. Extra vendors in
 * `extraQuotes` are invited and have their own quotations recorded on the SAME RFQ before recommending `vendorId`;
 * `invitedOnly` vendors are invited without recording a quotation.
 */
async function commitmentDraft(
  vendorId: string,
  opts: {
    extraQuotes?: ExtraQuoteSpec[];
    invitedOnly?: string[];
    unitPrice?: string;
    taxCodeId?: string;
  } = {},
) {
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
  const extraQuotes = opts.extraQuotes ?? [];
  const invitedOnly = opts.invitedOnly ?? [];
  const rfq = await sourcing.createRfq(
    {
      purchaseRequestId: prId,
      deadline: '2026-11-20T10:00:00+05:45',
      vendorIds: [vendorId, ...extraQuotes.map((q) => q.vendorId), ...invitedOnly],
    },
    randomUUID(),
  );
  const documentId = await evidence.upload('rfq', rfq.id);
  const quote = await sourcing.recordQuotation(
    rfq.id,
    {
      vendorId,
      documentId,
      currency: 'NPR',
      lines: [
        {
          prLineId,
          quantity: '2',
          unitPrice: opts.unitPrice ?? '39000.00',
          taxCodeId: opts.taxCodeId ?? vatCode,
        },
      ],
    },
    randomUUID(),
  );
  const quotesByVendor = new Map<string, QuotationDto>([[vendorId, quote]]);
  for (const extra of extraQuotes) {
    const extraDocId = await evidence.upload('rfq', rfq.id);
    const extraQuote = await sourcing.recordQuotation(
      rfq.id,
      {
        vendorId: extra.vendorId,
        documentId: extraDocId,
        currency: extra.currency ?? 'NPR',
        lines: [
          {
            prLineId,
            quantity: extra.quantity ?? '2',
            unitPrice: extra.unitPrice ?? '39000.00',
            taxCodeId: extra.taxCodeId ?? opts.taxCodeId ?? vatCode,
          },
        ],
      },
      randomUUID(),
    );
    quotesByVendor.set(extra.vendorId, extraQuote);
  }
  await sourcing.recommend(
    rfq.id,
    { vendorQuotationId: quote.id, rationale: 'Lowest compliant quote' },
    randomUUID(),
  );
  const committed = await sourcing.submitCommitment(rfq.id, randomUUID());
  await approve(U.acct, 'accountant', committed.commitmentApprovalRequestId!);
  await approve(U.fin, 'finance', committed.commitmentApprovalRequestId!);
  const [draft] = await read((tx) =>
    tx.select().from(purchaseOrders).where(eq(purchaseOrders.vendorQuotationId, quote.id)),
  );
  return { draft: draft!, quote, quotesByVendor, rfqId: rfq.id, prLineId };
}

let poSeq = 0;
/**
 * A draft PO inserted directly with no RFQ link (number taken, version 0) and one line of 1 x 79,646.02 + 13% VAT.
 * Serves the NO_RFQ refusal and status/ownership/reference checks.
 */
async function plainDraft(vendorId: string, opts: { scope?: TxScope } = {}): Promise<string> {
  const scope = opts.scope ?? scopeA;
  const dept = scope === scopeA ? deptA : deptB;
  const a = quotationLineAmounts('1', '79646.02', 1300);
  const prId = randomUUID();
  await exec(
    scope,
    sql`INSERT INTO app.purchase_requests (id, tenant_id, organization_id, request_type, department_id,
          requester_user_id, cost_center_id, justification, required_by, budget_code, currency)
        VALUES (${prId}, ${scope.tenantId}, ${scope.organizationId}, 'goods', ${dept}, ${U.req},
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
        VALUES (${id}, ${scope.tenantId}, ${scope.organizationId}, ${`PO-CV-${poSeq}`}, ${900 + poSeq},
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
const auditRows = async (id: string, action = 'procurement.po.vendor_changed') =>
  (
    await ownerPool.query<{ actor_id: string; before: unknown; after: unknown }>(
      `SELECT actor_id, before, after FROM audit.audit_events
        WHERE tenant_id = $1 AND entity_type = 'purchase_orders' AND entity_id = $2
          AND action = $3`,
      [scopeA.tenantId, id, action],
    )
  ).rows;
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
const vendorChangeRequestsFor = async (poId: string) =>
  read((tx) =>
    tx
      .select()
      .from(approvalRequests)
      .where(
        sql`${approvalRequests.documentType} = ${PO_VENDOR_CHANGE_DOCUMENT_TYPE}
            AND ${approvalRequests.snapshot} -> 'vendorChange' ->> 'purchaseOrderId' = ${poId}`,
      ),
  );

// ---------------------------------------------------------------------------------------- tests

describe('changeVendor on a commitment draft (same total)', () => {
  it('applies at once from the new vendor quotation, keeps the RFQ link, replaces lines, audits and replays', async () => {
    const oldVendor = await vendor('approved', { vatRegistered: true });
    const newVendor = await vendor('approved', { termId: net45, vatRegistered: true });
    // 1 x 78,000.00 + 13% VAT = 88,140.00: same grand total as 2 x 39,000.00 + 13% VAT, with distinct line shape
    // so the assertion proves the draft took the new vendor's quotation lines rather than the old vendor's.
    const { draft, quote, quotesByVendor, rfqId, prLineId } = await commitmentDraft(oldVendor, {
      extraQuotes: [{ vendorId: newVendor, quantity: '1', unitPrice: '78000.00' }],
    });
    const newQuote = quotesByVendor.get(newVendor)!;
    expect(draft).toMatchObject({ status: 'draft', rfqId, vendorQuotationId: quote.id });
    expect(await lineCount(draft.id)).toBe(0);
    const before = await service.get(draft.id);

    const key = randomUUID();
    const dto = await service.changeVendor(draft.id, { vendorId: newVendor }, key);

    expect(dto).toMatchObject({
      status: 'draft',
      vendorId: newVendor,
      rfqId,
      vendorQuotationId: newQuote.id,
      paymentTermsDays: 45,
      currency: before.currency,
      fxRate: newQuote.fxRate,
      approvedTotal: newQuote.total,
      approvedTotalNpr: newQuote.totalNpr,
      approvedBand: 'base',
      number: draft.number,
      version: draft.version + 1,
    });
    expect(Number(dto.advancePercent)).toBe(0);
    expect(dto.pendingVendorChange).toBeUndefined();
    expect(dto.lines).toHaveLength(1);
    expect(dto.lines[0]).toMatchObject({
      prLineId,
      orderedQuantity: '1.0000',
      unitPrice: '78000.00',
      gross: '78000.00',
      taxAmount: '10140.00',
      lineTotal: '88140.00',
    });
    expect(await lineCount(draft.id)).toBe(1);
    const after = await service.get(draft.id);
    expect(after).not.toHaveProperty('proposedLines');
    expect(after.pendingVendorChange).toBeNull();
    expect(after.lines).toHaveLength(1);

    expect(await auditRows(draft.id)).toEqual([
      {
        actor_id: U.proc,
        before: {
          vendorId: oldVendor,
          paymentTermsDays: 0,
          advancePercent: draft.advancePercent,
          vendorQuotationId: quote.id,
          approvedTotal: draft.approvedTotal,
        },
        after: {
          vendorId: newVendor,
          paymentTermsDays: 45,
          advancePercent: '0',
          vendorQuotationId: newQuote.id,
          approvedTotal: newQuote.total,
          fxRate: newQuote.fxRate,
          fxSource: null,
          fxDate: null,
          approvedTotalNpr: newQuote.totalNpr,
          approvedBand: 'base',
          linesWritten: 1,
          approvalRequestId: null,
          vatWarningAcknowledged: false,
        },
      },
    ]);

    // A replay with the same key returns the same order and writes nothing more.
    const replay = await service.changeVendor(draft.id, { vendorId: newVendor }, key);
    expect(replay).toEqual(dto);
    expect((await poRow(draft.id)).version).toBe(dto.version);
    expect(await auditRows(draft.id)).toHaveLength(1);
    expect(await lineCount(draft.id)).toBe(1);

    // The changed draft issues to the new vendor with the new quotation's lines and total.
    const strip = ({ id: _id, ...l }: (typeof dto.lines)[number]) => l;
    const issued = await service.issue(draft.id, randomUUID());
    expect(issued).toMatchObject({ status: 'issued', vendorId: newVendor, currentVersion: 1 });
    expect(issued.lines.map(strip)).toEqual(dto.lines.map(strip));
    const [v1] = await service.versions(draft.id);
    expect(v1).toMatchObject({
      version: 1,
      total: newQuote.total,
      totalNpr: newQuote.totalNpr,
      band: 'base',
    });
  });

  it('refuses to issue from a page opened before another buyer changed the vendor', async () => {
    const oldVendor = await vendor('approved', { vatRegistered: true });
    const newVendor = await vendor('approved', { vatRegistered: true });
    const { draft } = await commitmentDraft(oldVendor, {
      extraQuotes: [{ vendorId: newVendor, unitPrice: '39000.00' }],
    });
    const opened = await service.get(draft.id);
    const changed = await service.changeVendor(draft.id, { vendorId: newVendor }, randomUUID());
    expect(changed.version).toBe(opened.version + 1);

    // The stale page still shows the old vendor: its issue carries the version it read.
    const stale = await httpErrorOf(
      service.issue(draft.id, randomUUID(), { expectedVersion: opened.version }),
    );
    expect(stale.getStatus()).toBe(409);
    expect(codeOf(stale)).toBe('PO_CHANGED');
    expect(wireBody(stale)).toMatchObject({
      status: 409,
      code: 'PO_CHANGED',
      message: 'This purchase order changed since you opened it. Reload and try again.',
    });
    expect(await poRow(draft.id)).toMatchObject({
      status: 'draft',
      vendorId: newVendor,
      version: changed.version,
    });
    expect(await service.versions(draft.id)).toEqual([]);

    // After a reload, the current version issues.
    const issued = await service.issue(draft.id, randomUUID(), {
      expectedVersion: changed.version,
    });
    expect(issued).toMatchObject({ status: 'issued', vendorId: newVendor, currentVersion: 1 });
  });

  it('takes no issue body or an empty one, as before', async () => {
    expect(IssuePurchaseOrderBodySchema.safeParse({}).success).toBe(true);
    expect(IssuePurchaseOrderBodySchema.safeParse({ expectedVersion: 0 }).success).toBe(false);
    expect(IssuePurchaseOrderBodySchema.safeParse({ expectedVersion: 1.5 }).success).toBe(false);
    expect(IssuePurchaseOrderBodySchema.safeParse({ expectedVersion: 2, x: 1 }).success).toBe(
      false,
    );
    const id = await plainDraft(await vendor('approved', { vatRegistered: true }));
    const issued = await service.issue(id, randomUUID(), {});
    expect(issued.status).toBe('issued');
  });
});

describe('changeVendor approval flow (different total)', () => {
  it('submits po_vendor_change approval, leaves PO untouched and blocks issue/second change until approved', async () => {
    const oldVendor = await vendor('approved', { vatRegistered: true });
    const newVendor = await vendor('approved', { termId: net45, vatRegistered: true });
    const thirdVendor = await vendor('approved', { vatRegistered: true });
    // 2 x 42,000.00 + 13% VAT = 94,920.00 (differs from 88,140.00; base band <= 100,000 NPR).
    const { draft, quote, quotesByVendor, rfqId, prLineId } = await commitmentDraft(oldVendor, {
      extraQuotes: [
        { vendorId: newVendor, unitPrice: '42000.00' },
        { vendorId: thirdVendor, unitPrice: '39000.00' },
      ],
    });
    const newQuote = quotesByVendor.get(newVendor)!;

    const key = randomUUID();
    const submitted = await service.changeVendor(draft.id, { vendorId: newVendor }, key);
    const requestId = submitted.pendingVendorChange?.approvalRequestId;
    expect(requestId).toBeDefined();
    expect(submitted).toMatchObject({
      status: 'draft',
      vendorId: oldVendor,
      rfqId,
      vendorQuotationId: quote.id,
      approvedTotal: '88140.00',
      version: draft.version,
      lines: [],
      pendingVendorChange: {
        approvalRequestId: requestId,
        vendorId: newVendor,
        total: '94920.00',
      },
    });
    // The order itself is untouched until the approval is decided.
    expect(await poRow(draft.id)).toEqual(draft);
    expect(await lineCount(draft.id)).toBe(0);
    expect((await service.get(draft.id)).pendingVendorChange).toEqual(
      submitted.pendingVendorChange,
    );

    // Idempotent replay while pending returns the same response without creating a second approval request.
    expect(await service.changeVendor(draft.id, { vendorId: newVendor }, key)).toEqual(submitted);
    const [reqRow] = await read((tx) =>
      tx.select().from(approvalRequests).where(eq(approvalRequests.id, requestId!)),
    );
    expect(reqRow).toMatchObject({
      documentType: PO_VENDOR_CHANGE_DOCUMENT_TYPE,
      status: 'pending',
    });
    expect(await stepRoles(requestId!)).toEqual(['accountant', 'finance']);

    // Issue is refused while the vendor change waits for approval.
    const issueRefused = await httpErrorOf(service.issue(draft.id, randomUUID()));
    expect(issueRefused.getStatus()).toBe(409);
    expect(codeOf(issueRefused)).toBe('PO_VENDOR_CHANGE_PENDING');
    expect(wireBody(issueRefused)).toMatchObject({
      status: 409,
      code: 'PO_VENDOR_CHANGE_PENDING',
    });

    // A second vendor change is also refused while one waits for approval.
    const secondRefused = await httpErrorOf(
      service.changeVendor(draft.id, { vendorId: thirdVendor }, randomUUID()),
    );
    expect(secondRefused.getStatus()).toBe(409);
    expect(codeOf(secondRefused)).toBe('PO_VENDOR_CHANGE_PENDING');
    expect(wireBody(secondRefused)).toMatchObject({
      status: 409,
      code: 'PO_VENDOR_CHANGE_PENDING',
    });

    // A request that went blocked (an approver became ineligible) is still open: the order stays locked.
    await exec(
      scopeA,
      sql`UPDATE app.approval_requests SET status = 'blocked', block_reason = 'test' WHERE id = ${requestId!}`,
    );
    expect(codeOf(await httpErrorOf(service.issue(draft.id, randomUUID())))).toBe(
      'PO_VENDOR_CHANGE_PENDING',
    );
    expect(
      codeOf(
        await httpErrorOf(service.changeVendor(draft.id, { vendorId: thirdVendor }, randomUUID())),
      ),
    ).toBe('PO_VENDOR_CHANGE_PENDING');
    await exec(
      scopeA,
      sql`UPDATE app.approval_requests SET status = 'pending', block_reason = NULL WHERE id = ${requestId!}`,
    );

    // After Accountant approves, Finance still has to decide; the PO stays untouched.
    await approve(U.acct, 'accountant', requestId!);
    expect(await poRow(draft.id)).toEqual(draft);
    expect(await lineCount(draft.id)).toBe(0);

    // Finance approval commits the vendor change in the deciding transaction.
    await approve(U.fin, 'finance', requestId!);
    const after = await service.get(draft.id);
    expect(after).toMatchObject({
      status: 'draft',
      vendorId: newVendor,
      rfqId,
      vendorQuotationId: newQuote.id,
      paymentTermsDays: 45,
      approvedTotal: '94920.00',
      approvedTotalNpr: '94920.00',
      approvedBand: 'base',
      version: draft.version + 1,
      pendingVendorChange: null,
    });
    expect(after.lines).toHaveLength(1);
    expect(after.lines[0]).toMatchObject({
      prLineId,
      orderedQuantity: '2.0000',
      unitPrice: '42000.00',
      gross: '84000.00',
      taxAmount: '10920.00',
      lineTotal: '94920.00',
    });
    expect(await auditRows(draft.id)).toEqual([
      {
        actor_id: U.fin,
        before: {
          vendorId: oldVendor,
          paymentTermsDays: 0,
          advancePercent: draft.advancePercent,
          vendorQuotationId: quote.id,
          approvedTotal: '88140.00',
        },
        after: {
          vendorId: newVendor,
          paymentTermsDays: 45,
          advancePercent: '0',
          vendorQuotationId: newQuote.id,
          approvedTotal: '94920.00',
          fxRate: newQuote.fxRate,
          fxSource: null,
          fxDate: null,
          approvedTotalNpr: '94920.00',
          approvedBand: 'base',
          linesWritten: 1,
          approvalRequestId: requestId,
          vatWarningAcknowledged: false,
        },
      },
    ]);

    // The approved draft now issues to the new vendor with version-1 total equal to the new quotation total.
    const issued = await service.issue(draft.id, randomUUID());
    expect(issued).toMatchObject({ status: 'issued', vendorId: newVendor, currentVersion: 1 });
    const [v1] = await service.versions(draft.id);
    expect(v1).toMatchObject({
      version: 1,
      total: '94920.00',
      totalNpr: '94920.00',
      band: 'base',
    });
  });

  it('adds Management when the changed vendor quotation exceeds NPR 100,000 and updates approvedBand', async () => {
    const oldVendor = await vendor('approved', { vatRegistered: true });
    const newVendor = await vendor('approved', { vatRegistered: true });
    // 2 x 55,000.00 + 13% VAT = 124,300.00 (> 100,000 NPR -> management band).
    const { draft } = await commitmentDraft(oldVendor, {
      extraQuotes: [{ vendorId: newVendor, unitPrice: '55000.00' }],
    });
    const submitted = await service.changeVendor(draft.id, { vendorId: newVendor }, randomUUID());
    const requestId = submitted.pendingVendorChange!.approvalRequestId;
    expect(await stepRoles(requestId)).toEqual(['accountant', 'finance', 'management']);

    await approve(U.acct, 'accountant', requestId);
    await approve(U.fin, 'finance', requestId);
    expect((await poRow(draft.id)).vendorId).toBe(oldVendor);
    await approve(U.mgmt, 'management', requestId);

    const after = await service.get(draft.id);
    expect(after).toMatchObject({
      vendorId: newVendor,
      approvedTotal: '124300.00',
      approvedTotalNpr: '124300.00',
      approvedBand: 'management',
      pendingVendorChange: null,
    });
  });

  it.each(['reject', 'return'] as const)(
    'leaves the order unchanged and issues to the old vendor when the approval is %sed',
    async (action) => {
      const oldVendor = await vendor('approved', { vatRegistered: true });
      const newVendor = await vendor('approved', { vatRegistered: true });
      const { draft } = await commitmentDraft(oldVendor, {
        extraQuotes: [{ vendorId: newVendor, unitPrice: '42000.00' }],
      });
      const submitted = await service.changeVendor(draft.id, { vendorId: newVendor }, randomUUID());
      const requestId = submitted.pendingVendorChange!.approvalRequestId;

      await decide(U.acct, 'accountant', requestId, action, 'Stay with original vendor');

      expect(await poRow(draft.id)).toEqual(draft);
      expect(await lineCount(draft.id)).toBe(0);
      expect((await service.get(draft.id)).pendingVendorChange).toBeNull();
      expect(await auditRows(draft.id)).toEqual([]);
      expect(
        await auditRows(
          draft.id,
          action === 'reject'
            ? 'procurement.po.vendor_change_rejected'
            : 'procurement.po.vendor_change_returned',
        ),
      ).toHaveLength(1);

      const issued = await service.issue(draft.id, randomUUID());
      expect(issued).toMatchObject({ status: 'issued', vendorId: oldVendor, currentVersion: 1 });
      const [v1] = await service.versions(draft.id);
      expect(v1).toMatchObject({ version: 1, total: '88140.00', totalNpr: '88140.00' });
    },
  );

  it('refuses with 422 NO_ELIGIBLE_APPROVER and writes nothing when the finance role directory is empty', async () => {
    const oldVendor = await vendor('approved', { vatRegistered: true });
    const newVendor = await vendor('approved', { vatRegistered: true });
    const { draft } = await commitmentDraft(oldVendor, {
      extraQuotes: [{ vendorId: newVendor, unitPrice: '42000.00' }],
    });
    roles.finance = [];

    const refused = await httpErrorOf(
      service.changeVendor(draft.id, { vendorId: newVendor }, randomUUID()),
    );

    expect(refused.getStatus()).toBe(422);
    expect(codeOf(refused)).toBe('NO_ELIGIBLE_APPROVER');
    expect(wireBody(refused)).toMatchObject({ status: 422, code: 'NO_ELIGIBLE_APPROVER' });
    expect(await poRow(draft.id)).toEqual(draft);
    expect(await lineCount(draft.id)).toBe(0);
    expect(await vendorChangeRequestsFor(draft.id)).toEqual([]);
    expect(await auditRows(draft.id)).toEqual([]);
    expect(await auditRows(draft.id, 'procurement.po.vendor_change_submitted')).toEqual([]);
  });
});

describe('changeVendor currency and VAT rules (K3 Q2)', () => {
  it('refuses 409 VENDOR_CURRENCY_NOT_SUPPORTED when the new vendor has no active bank account in the order currency', async () => {
    const oldVendor = await vendor('approved', { vatRegistered: true });
    const usdBankVendor = await vendor('approved', { bankCurrency: 'USD', vatRegistered: true });
    const inrBankVendor = await vendor('approved', { bankCurrency: 'INR', vatRegistered: true });
    const { draft } = await commitmentDraft(oldVendor, {
      extraQuotes: [
        { vendorId: usdBankVendor, unitPrice: '39000.00' },
        { vendorId: inrBankVendor, unitPrice: '39000.00' },
      ],
    });

    for (const candidate of [usdBankVendor, inrBankVendor]) {
      const refused = await httpErrorOf(
        service.changeVendor(draft.id, { vendorId: candidate }, randomUUID()),
      );
      expect(refused.getStatus()).toBe(409);
      expect(codeOf(refused)).toBe('VENDOR_CURRENCY_NOT_SUPPORTED');
      expect(wireBody(refused)).toMatchObject({
        status: 409,
        code: 'VENDOR_CURRENCY_NOT_SUPPORTED',
      });
    }
    expect(await poRow(draft.id)).toEqual(draft);
    expect(await lineCount(draft.id)).toBe(0);
    expect(await auditRows(draft.id)).toEqual([]);
  });

  it('refuses 409 VENDOR_CURRENCY_NOT_SUPPORTED when the new vendor quotation currency differs from the order currency', async () => {
    const oldVendor = await vendor('approved', { vatRegistered: true });
    // Has an active NPR bank account, so only the quotation currency (USD vs PO's NPR) differs.
    const usdQuoteVendor = await vendor('approved', { bankCurrency: 'NPR', vatRegistered: true });
    const { draft } = await commitmentDraft(oldVendor, {
      extraQuotes: [{ vendorId: usdQuoteVendor, currency: 'USD', unitPrice: '300.00' }],
    });

    const refused = await httpErrorOf(
      service.changeVendor(draft.id, { vendorId: usdQuoteVendor }, randomUUID()),
    );

    expect(refused.getStatus()).toBe(409);
    expect(codeOf(refused)).toBe('VENDOR_CURRENCY_NOT_SUPPORTED');
    expect(wireBody(refused)).toMatchObject({
      status: 409,
      code: 'VENDOR_CURRENCY_NOT_SUPPORTED',
    });
    expect(await poRow(draft.id)).toEqual(draft);
    expect(await lineCount(draft.id)).toBe(0);
    expect(await auditRows(draft.id)).toEqual([]);
  });

  it('warns 409 VENDOR_NOT_VAT_REGISTERED for a taxed quotation on a non-VAT vendor, then passes with acknowledgeVatWarning', async () => {
    const oldVendor = await vendor('approved', { vatRegistered: true });
    const nonVatVendor = await vendor('approved', { vatRegistered: false });
    const { draft, quotesByVendor } = await commitmentDraft(oldVendor, {
      extraQuotes: [{ vendorId: nonVatVendor, unitPrice: '39000.00' }],
    });
    const newQuote = quotesByVendor.get(nonVatVendor)!;

    const warned = await httpErrorOf(
      service.changeVendor(draft.id, { vendorId: nonVatVendor }, randomUUID()),
    );
    expect(warned.getStatus()).toBe(409);
    expect(codeOf(warned)).toBe('VENDOR_NOT_VAT_REGISTERED');
    expect(wireBody(warned)).toMatchObject({ status: 409, code: 'VENDOR_NOT_VAT_REGISTERED' });
    expect(await poRow(draft.id)).toEqual(draft);
    expect(await lineCount(draft.id)).toBe(0);
    expect(await auditRows(draft.id)).toEqual([]);

    const dto = await service.changeVendor(
      draft.id,
      { vendorId: nonVatVendor, acknowledgeVatWarning: true },
      randomUUID(),
    );
    expect(dto).toMatchObject({
      status: 'draft',
      vendorId: nonVatVendor,
      vendorQuotationId: newQuote.id,
    });
    const [ev] = await auditRows(draft.id);
    expect(ev?.after).toMatchObject({ vatWarningAcknowledged: true });
  });

  it('passes silently for a VAT-registered vendor, and for a non-VAT vendor on a tax-free quotation', async () => {
    const oldVatVendor = await vendor('approved', { vatRegistered: true });
    const newVatVendor = await vendor('approved', { vatRegistered: true });
    const taxed = await commitmentDraft(oldVatVendor, {
      extraQuotes: [{ vendorId: newVatVendor, unitPrice: '39000.00' }],
    });
    const taxedDto = await service.changeVendor(
      taxed.draft.id,
      { vendorId: newVatVendor },
      randomUUID(),
    );
    expect(taxedDto.vendorId).toBe(newVatVendor);
    expect((await auditRows(taxed.draft.id))[0]?.after).toMatchObject({
      vatWarningAcknowledged: false,
    });

    const oldExemptVendor = await vendor('approved', { vatRegistered: false });
    const newExemptVendor = await vendor('approved', { vatRegistered: false });
    const exempt = await commitmentDraft(oldExemptVendor, {
      taxCodeId: exemptCode,
      extraQuotes: [{ vendorId: newExemptVendor, unitPrice: '39000.00', taxCodeId: exemptCode }],
    });
    const exemptDto = await service.changeVendor(
      exempt.draft.id,
      { vendorId: newExemptVendor },
      randomUUID(),
    );
    expect(exemptDto.vendorId).toBe(newExemptVendor);
    expect((await auditRows(exempt.draft.id))[0]?.after).toMatchObject({
      vatWarningAcknowledged: false,
    });
  });
});

describe('changeVendor refusals', () => {
  it('refuses a draft with no RFQ link (409 PO_VENDOR_CHANGE_NO_RFQ) and writes nothing', async () => {
    const id = await plainDraft(await vendor('approved', { vatRegistered: true }));
    const before = await poRow(id);

    const refused = await httpErrorOf(
      service.changeVendor(
        id,
        { vendorId: await vendor('approved', { vatRegistered: true }) },
        randomUUID(),
      ),
    );

    expect(refused.getStatus()).toBe(409);
    expect(codeOf(refused)).toBe('PO_VENDOR_CHANGE_NO_RFQ');
    expect(wireBody(refused)).toMatchObject({ status: 409, code: 'PO_VENDOR_CHANGE_NO_RFQ' });
    expect(await poRow(id)).toEqual(before);
    expect(await auditRows(id)).toEqual([]);
  });

  it('refuses a vendor without a quotation on the RFQ (409 PO_VENDOR_NO_QUOTATION) and writes nothing', async () => {
    const oldVendor = await vendor('approved', { vatRegistered: true });
    const invitedNoQuote = await vendor('approved', { vatRegistered: true });
    const uninvitedVendor = await vendor('approved', { vatRegistered: true });
    const { draft } = await commitmentDraft(oldVendor, { invitedOnly: [invitedNoQuote] });

    for (const candidate of [invitedNoQuote, uninvitedVendor]) {
      const refused = await httpErrorOf(
        service.changeVendor(draft.id, { vendorId: candidate }, randomUUID()),
      );
      expect(refused.getStatus()).toBe(409);
      expect(codeOf(refused)).toBe('PO_VENDOR_NO_QUOTATION');
      expect(wireBody(refused)).toMatchObject({ status: 409, code: 'PO_VENDOR_NO_QUOTATION' });
    }
    expect(await poRow(draft.id)).toEqual(draft);
    expect(await lineCount(draft.id)).toBe(0);
    expect(await auditRows(draft.id)).toEqual([]);
  });

  it('refuses a vendor without a verified bank account and writes nothing, not even the lines', async () => {
    const oldVendor = await vendor('approved', { vatRegistered: true });
    const proposedBank = await vendor('approved', { bank: 'proposed', vatRegistered: true });
    const noBank = await vendor('approved', { bank: 'none', vatRegistered: true });
    const { draft } = await commitmentDraft(oldVendor, {
      extraQuotes: [
        { vendorId: proposedBank, unitPrice: '39000.00' },
        { vendorId: noBank, unitPrice: '39000.00' },
      ],
    });
    for (const candidate of [proposedBank, noBank]) {
      const refused = await httpErrorOf(
        service.changeVendor(draft.id, { vendorId: candidate }, randomUUID()),
      );
      expect(refused.getStatus()).toBe(409);
      expect(codeOf(refused)).toBe('VENDOR_NO_VERIFIED_BANK_ACCOUNT');
      // The workspace reads the code the global filter sends, not plain `conflict`.
      expect(wireBody(refused)).toMatchObject({
        status: 409,
        code: 'VENDOR_NO_VERIFIED_BANK_ACCOUNT',
        message: 'The vendor has no verified bank account',
      });
    }
    expect(await poRow(draft.id)).toEqual(draft);
    expect(await lineCount(draft.id)).toBe(0);
    expect(await auditRows(draft.id)).toEqual([]);
  });

  it.each(['issued', 'cancelled'] as const)(
    'refuses a %s order: cancel it and create a new one',
    async (status) => {
      const id = await plainDraft(await vendor('approved', { vatRegistered: true }));
      await service.issue(id, randomUUID());
      if (status === 'cancelled') {
        await service.cancel(id, { reason: 'Wrong vendor' }, randomUUID());
      }
      const refused = await httpErrorOf(
        service.changeVendor(
          id,
          { vendorId: await vendor('approved', { vatRegistered: true }) },
          randomUUID(),
        ),
      );
      expect(refused.getStatus()).toBe(409);
      expect(codeOf(refused)).toBe('PO_VENDOR_CHANGE_NOT_DRAFT');
      expect(messageOf(refused)).toBe('Cancel this order and create a new one');
      expect(wireBody(refused)).toMatchObject({ status: 409, code: 'PO_VENDOR_CHANGE_NOT_DRAFT' });
      expect((await poRow(id)).status).toBe(status);
    },
  );

  it('refuses a vendor that is not approved', async () => {
    const id = await plainDraft(await vendor('approved', { vatRegistered: true }));
    for (const status of ['suspended', 'pending_kyc'] as const) {
      const refused = await httpErrorOf(
        service.changeVendor(id, { vendorId: await vendor(status) }, randomUUID()),
      );
      expect(refused.getStatus()).toBe(409);
      expect(codeOf(refused)).toBe('VENDOR_NOT_APPROVED');
    }
  });

  it('refuses a vendor with no account in the acting entity', async () => {
    const id = await plainDraft(await vendor('approved', { vatRegistered: true }));
    const refused = await httpErrorOf(
      service.changeVendor(
        id,
        { vendorId: await vendor('approved', { accountIn: [scopeB], vatRegistered: true }) },
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

    const id = await plainDraft(await vendor('approved', { vatRegistered: true }));
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

  it('answers 404 for an order belonging to another entity', async () => {
    const otherEntityVendor = await vendor('approved', {
      accountIn: [scopeB],
      vatRegistered: true,
    });
    const otherPoId = await plainDraft(otherEntityVendor, { scope: scopeB });

    const refused = await httpErrorOf(
      service.changeVendor(
        otherPoId,
        { vendorId: await vendor('approved', { vatRegistered: true }) },
        randomUUID(),
      ),
    );

    expect(refused.getStatus()).toBe(404);
    expect(codeOf(refused)).toBe('not_found');
  });

  it('refuses the vendor the draft already has', async () => {
    const existing = await vendor('approved', { vatRegistered: true });
    const id = await plainDraft(existing);
    const refused = await httpErrorOf(
      service.changeVendor(id, { vendorId: existing }, randomUUID()),
    );
    expect(refused.getStatus()).toBe(409);
    expect(codeOf(refused)).toBe('PO_VENDOR_UNCHANGED');
    expect(wireBody(refused)).toMatchObject({ status: 409, code: 'PO_VENDOR_UNCHANGED' });
    expect(await auditRows(id)).toEqual([]);
  });

  it('refuses the vendor the draft already has spelled in upper case, and changes nothing', async () => {
    const existing = await vendor('approved', { vatRegistered: true });
    const { draft } = await commitmentDraft(existing);
    expect(draft.rfqId).not.toBeNull();

    // The rule compares lower-cased, also for a caller that skips the body schema.
    const refused = await httpErrorOf(
      service.changeVendor(draft.id, { vendorId: existing.toUpperCase() }, randomUUID()),
    );

    expect(refused.getStatus()).toBe(409);
    expect(codeOf(refused)).toBe('PO_VENDOR_UNCHANGED');
    expect(await poRow(draft.id)).toEqual(draft);
    expect(await lineCount(draft.id)).toBe(0);
    expect(await auditRows(draft.id)).toEqual([]);
    // The body schema lower-cases the id, so the route never hands the service an upper-case spelling.
    expect(ChangePurchaseOrderVendorBodySchema.parse({ vendorId: existing.toUpperCase() })).toEqual(
      { vendorId: existing },
    );
  });

  it('refuses a draft a payment request already refers to, instead of failing on its foreign key', async () => {
    const existing = await vendor('approved', { vatRegistered: true });
    const id = await plainDraft(existing);
    const { rows } = await exec(
      scopeA,
      sql`SELECT id FROM app.vendor_bank_accounts
          WHERE tenant_id = ${scopeA.tenantId} AND vendor_id = ${existing} AND status = 'active'`,
    );
    const bankAccountId = (rows[0] as { id: string }).id;
    await exec(
      scopeA,
      sql`INSERT INTO app.payment_requests (tenant_id, organization_id, vendor_id, payment_type,
            purchase_order_id, currency, total_amount, from_bank_account_id, vendor_bank_account_id, bank_last4,
            requested_by)
          VALUES (${scopeA.tenantId}, ${scopeA.organizationId}, ${existing}, 'advance', ${id}, 'NPR', 1000,
                  ${randomUUID()}, ${bankAccountId}, '1234', ${U.proc})`,
    );
    const before = await poRow(id);

    const refused = await httpErrorOf(
      service.changeVendor(
        id,
        { vendorId: await vendor('approved', { vatRegistered: true }) },
        randomUUID(),
      ),
    );

    expect(refused.getStatus()).toBe(409);
    expect(codeOf(refused)).toBe('PO_REFERENCED');
    expect(messageOf(refused)).toBe(
      'Payment requests or bills already refer to this order; cancel it and create a new one',
    );
    expect(wireBody(refused)).toMatchObject({ status: 409, code: 'PO_REFERENCED' });
    expect(await poRow(id)).toEqual(before);
    expect(await auditRows(id)).toEqual([]);
  });
});

describe('vendor change approval route by who requested the order (FU9 follow-up, AD8)', () => {
  /** A second Management user in the directory, so two distinct Management steps can both be staffed. */
  async function secondManager(): Promise<string> {
    const [{ idp_org_id: idpOrgId }] = (
      await exec(scopeA, sql`SELECT idp_org_id FROM app.users WHERE id = ${U.mgmt}`)
    ).rows as [{ idp_org_id: string }];
    const id = (await createStaffUser(appPool, { ...scopeA, idpOrgId, roleKeys: ['management'] }))
      .userId;
    roles.management = [U.mgmt, id];
    return id;
  }
  /** A commitment draft whose new vendor quoted 2 x 450,000.00 + 13% VAT = 1,017,000.00 (above NPR 1,000,000). */
  async function aboveMillion(requester: string) {
    const oldVendor = await vendor('approved', { vatRegistered: true });
    const newVendor = await vendor('approved', { vatRegistered: true });
    const { draft } = await commitmentDraft(oldVendor, {
      extraQuotes: [{ vendorId: newVendor, unitPrice: '450000.00' }],
    });
    await exec(
      scopeA,
      sql`UPDATE app.purchase_requests SET requester_user_id = ${requester}
          WHERE id = ${draft.purchaseRequestId}`,
    );
    return { draft, newVendor };
  }

  it('gives a Founder-requested order two distinct Management steps when a non-Founder buyer swaps the vendor', async () => {
    const mgmt2 = await secondManager();
    const { draft, newVendor } = await aboveMillion(U.founder);

    as(U.proc, 'procurement');
    const submitted = await service.changeVendor(draft.id, { vendorId: newVendor }, randomUUID());
    const requestId = submitted.pendingVendorChange!.approvalRequestId;
    expect(submitted.pendingVendorChange!.total).toBe('1017000.00');
    expect(await stepRoles(requestId)).toEqual([
      'accountant',
      'finance',
      'management',
      'management',
    ]);

    await approve(U.acct, 'accountant', requestId);
    await approve(U.fin, 'finance', requestId);
    await approve(U.mgmt, 'management', requestId);
    // The Manager who decided the first Management step may not decide the second one.
    const again = await httpErrorOf(approve(U.mgmt, 'management', requestId));
    expect(again.getStatus()).toBe(403);
    expect(again.getResponse()).toMatchObject({
      code: 'forbidden',
      reason: 'separation_of_duties',
    });
    expect((await poRow(draft.id)).vendorId).toBe(draft.vendorId);

    await approve(mgmt2, 'management', requestId);
    expect(await service.get(draft.id)).toMatchObject({
      vendorId: newVendor,
      approvedTotal: '1017000.00',
      approvedBand: 'founder',
      pendingVendorChange: null,
    });
  });

  it('gives an order requested by anyone else the Founder step instead', async () => {
    await secondManager();
    const { draft, newVendor } = await aboveMillion(U.req);

    as(U.proc, 'procurement');
    const submitted = await service.changeVendor(draft.id, { vendorId: newVendor }, randomUUID());
    expect(await stepRoles(submitted.pendingVendorChange!.approvalRequestId)).toEqual([
      'accountant',
      'finance',
      'management',
      'founder',
    ]);
  });
});

describe('a reference added while the vendor change waits (FU9 follow-up)', () => {
  it('refuses the final approval with 409 PO_REFERENCED and rolls the decision back, leaving the order as it was', async () => {
    const oldVendor = await vendor('approved', { vatRegistered: true });
    const newVendor = await vendor('approved', { vatRegistered: true });
    const { draft } = await commitmentDraft(oldVendor, {
      extraQuotes: [{ vendorId: newVendor, unitPrice: '42000.00' }],
    });
    const submitted = await service.changeVendor(draft.id, { vendorId: newVendor }, randomUUID());
    const requestId = submitted.pendingVendorChange!.approvalRequestId;
    expect(await stepRoles(requestId)).toEqual(['accountant', 'finance']);
    await approve(U.acct, 'accountant', requestId);

    // While Finance has not decided, a payment request names the draft with its current vendor.
    const { rows } = await exec(
      scopeA,
      sql`SELECT id FROM app.vendor_bank_accounts
          WHERE tenant_id = ${scopeA.tenantId} AND vendor_id = ${oldVendor} AND status = 'active'`,
    );
    await exec(
      scopeA,
      sql`INSERT INTO app.payment_requests (tenant_id, organization_id, vendor_id, payment_type,
            purchase_order_id, currency, total_amount, from_bank_account_id, vendor_bank_account_id, bank_last4,
            requested_by)
          VALUES (${scopeA.tenantId}, ${scopeA.organizationId}, ${oldVendor}, 'advance', ${draft.id}, 'NPR', 1000,
                  ${randomUUID()}, ${(rows[0] as { id: string }).id}, '1234', ${U.proc})`,
    );
    const before = await poRow(draft.id);

    const refused = await httpErrorOf(approve(U.fin, 'finance', requestId));
    expect(refused.getStatus()).toBe(409);
    expect(codeOf(refused)).toBe('PO_REFERENCED');
    expect(wireBody(refused)).toMatchObject({ status: 409, code: 'PO_REFERENCED' });

    expect(await poRow(draft.id)).toEqual(before);
    expect(await lineCount(draft.id)).toBe(0);
    expect(await auditRows(draft.id)).toEqual([]);
    const [request] = await read((tx) =>
      tx.select().from(approvalRequests).where(eq(approvalRequests.id, requestId)),
    );
    expect(request!.status).toBe('pending');
    const financeActions = await read((tx) =>
      tx
        .select()
        .from(approvalActions)
        .where(
          sql`${approvalActions.requestId} = ${requestId} AND ${approvalActions.actorUserId} = ${U.fin}`,
        ),
    );
    expect(financeActions).toEqual([]);
    expect((await service.get(draft.id)).pendingVendorChange).toMatchObject({
      approvalRequestId: requestId,
      vendorId: newVendor,
    });
  });
});

describe('an approver of the vendor change opens the order, read-only (FU9 follow-up, R4f Q1 b)', () => {
  const statusOf = async (call: Promise<unknown>) => (await httpErrorOf(call)).getStatus();
  /** Reads as `user` holding `role` without any order grant; only an approval can open the order. */
  const asApprover = (user: string, role: RoleKey) => {
    as(user, role);
    current.grants = withoutPoGrants(role);
  };
  const hrefOf = async (requestId: string) => (await approvals.get(requestId)).context?.href;

  it('opens it to the approver of the active step and keeps it after they decide; not to later steps, others or another order', async () => {
    const oldVendor = await vendor('approved', { vatRegistered: true });
    const newVendor = await vendor('approved', { vatRegistered: true });
    // 2 x 55,000.00 + 13% VAT = 124,300.00: Accountant, Finance and Management.
    const { draft } = await commitmentDraft(oldVendor, {
      extraQuotes: [{ vendorId: newVendor, unitPrice: '55000.00' }],
    });
    const other = await commitmentDraft(await vendor('approved', { vatRegistered: true }));
    const submitted = await service.changeVendor(draft.id, { vendorId: newVendor }, randomUUID());
    const requestId = submitted.pendingVendorChange!.approvalRequestId;
    expect(await stepRoles(requestId)).toEqual(['accountant', 'finance', 'management']);
    const link = `/procurement/orders/${draft.id}`;

    // The Accountant, active, holds no order grant: the context links the order and the link opens its detail.
    asApprover(U.acct, 'accountant');
    expect(await hrefOf(requestId)).toBe(link);
    expect(await service.get(draft.id)).toMatchObject({ id: draft.id, status: 'draft' });
    // Nothing broader: the versions are refused and another order is a 404.
    expect(await statusOf(service.versions(draft.id))).toBe(403);
    expect(await statusOf(service.get(other.draft.id))).toBe(404);
    // Finance and Management are not active yet.
    for (const [user, role] of [
      [U.fin, 'finance'],
      [U.mgmt, 'management'],
    ] as const) {
      asApprover(user, role);
      expect(await hrefOf(requestId)).toBeNull();
      expect(await statusOf(service.get(draft.id))).toBe(404);
    }
    // The order's requester, without an order grant, approves nothing.
    asApprover(U.req, 'operations_officer');
    expect(await statusOf(service.get(draft.id))).toBe(404);

    current.grants = null;
    await approve(U.acct, 'accountant', requestId);
    asApprover(U.acct, 'accountant');
    expect((await service.get(draft.id)).id).toBe(draft.id);
    asApprover(U.fin, 'finance');
    expect(await hrefOf(requestId)).toBe(link);
    expect((await service.get(draft.id)).id).toBe(draft.id);
    asApprover(U.mgmt, 'management');
    expect(await statusOf(service.get(draft.id))).toBe(404);

    current.grants = null;
    await approve(U.fin, 'finance', requestId);
    asApprover(U.mgmt, 'management');
    expect(await hrefOf(requestId)).toBe(link);
    expect((await service.get(draft.id)).id).toBe(draft.id);

    current.grants = null;
    await approve(U.mgmt, 'management', requestId);
    // Once decided, every approver may still look back at the order, now with the new vendor.
    for (const [user, role] of [
      [U.acct, 'accountant'],
      [U.fin, 'finance'],
      [U.mgmt, 'management'],
    ] as const) {
      asApprover(user, role);
      expect(await service.get(draft.id)).toMatchObject({ id: draft.id, vendorId: newVendor });
    }
  });

  it('matches the order id in the snapshot whatever its case', async () => {
    const oldVendor = await vendor('approved', { vatRegistered: true });
    const newVendor = await vendor('approved', { vatRegistered: true });
    const { draft } = await commitmentDraft(oldVendor, {
      extraQuotes: [{ vendorId: newVendor, unitPrice: '42000.00' }],
    });
    const submitted = await service.changeVendor(draft.id, { vendorId: newVendor }, randomUUID());
    await exec(
      scopeA,
      sql`UPDATE app.approval_requests
            SET snapshot = jsonb_set(snapshot, '{vendorChange,purchaseOrderId}', to_jsonb(upper(${draft.id}::text)))
          WHERE id = ${submitted.pendingVendorChange!.approvalRequestId}`,
    );
    asApprover(U.acct, 'accountant');
    expect((await service.get(draft.id)).id).toBe(draft.id);
  });
});
