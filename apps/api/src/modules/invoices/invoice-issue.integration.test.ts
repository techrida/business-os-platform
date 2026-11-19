// Integration tests of invoice approval (submit, decide) and tax-invoice issue on a real Postgres (Testcontainers, needs
// Docker in WSL). Real: migrations as bos_owner, queries as bos_app (every CHECK and trigger of 0019-0021 runs), the
// approvals engine with the seed's tax_invoice workflow published through ApprovalsAdminService, the invoice services,
// NumberingService, LedgerService and AuditService. Faked: the request context, authz.assert (the real pure can() on a
// fake principal), notify, the role directory (role -> real staff users of entity A), MoneyService (NPR at 1; USD is
// stale) and the entity settings. Covers P3 done checks 3 (20 parallel issues), 4 (300 issues without gaps, a forced
// rollback reuses the number, drafts have no number, INV-2083/84-00001) and 10 (SoD, 422, edit after approval), plus
// stale FX 409 and the cross-entity 404.
// Run: pnpm --filter @bos/api exec vitest run src/modules/invoices/invoice-issue.integration.test.ts
import 'reflect-metadata';

import { randomUUID } from 'node:crypto';

import {
  DEFAULT_ROLE_PERMISSIONS,
  IssueInvoiceResultSchema,
  type IssueInvoiceResult,
  type Permission,
  type RoleKey,
  type Scope,
} from '@bos/contracts';
import {
  approvalRequests,
  billingScheduleLines,
  createStaffUser,
  invoices,
  openItems,
  postingEvents,
  runMigrations,
  users,
} from '@bos/db';
import { ConflictException, ForbiddenException, HttpException } from '@nestjs/common';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { AuditService } from '../../platform/audit/audit.service';
import type { AuthzService } from '../../platform/authz/authz.service';
import { can } from '../../platform/authz/can';
import type { Principal } from '../../platform/authz/principal';
import { systemActor, withTx, type TxScope } from '../../platform/db/tx';
import type { MoneyService } from '../../platform/settings/money.service';
import { NumberingService } from '../../platform/settings/numbering.service';
import type { CurrencyEnabledService } from '../../platform/settings/currency-enabled';
import type { SettingsService } from '../../platform/settings/settings.service';
import { ApprovalsAdminService } from '../approvals/admin.service';
import type { ApprovalsNotify } from '../approvals/ports';
import { ApprovalsService } from '../approvals/requests.service';
import { LedgerService } from '../ledger/ledger.service';
import {
  seedQuotationFixture,
  type QuotationFixture,
  type QuotationFixtureDb,
} from '../quotations/drafting/quotation.fixture';
import { InvoiceApprovalService, InvoiceApprovalSubject } from './invoice-approval.service';
import { InvoiceDraftingService } from './invoice-drafting.service';
import { InvoiceIssueService } from './invoice-issue.service';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 180_000 });

const OWNER_PW = 'owner-test-pw';
const APP_PW = 'app-test-pw';
/** 2026-11-09 11:45 in Kathmandu: BS 2083-07-23, fiscal year 2083/84. */
const NOW = new Date('2026-11-09T06:00:00Z');

// Copied word for word from tools/seed-zitadel/src/db-seed.ts (invoiceApprovalSpec('tax_invoice', 'tax invoice')).
// apps/api does not depend on the seed package, so it is not imported; keep the two in step.
const TAX_INVOICE_WORKFLOW_SPEC: unknown = {
  documentType: 'tax_invoice',
  steps: [
    {
      id: 'accountant',
      kind: 'role',
      role: 'accountant',
      reason: 'Base route: accountant checks the tax invoice',
    },
    { id: 'finance', kind: 'role', role: 'finance', reason: 'Base route: finance approves' },
  ],
  rules: [],
  distinctApprovers: true,
  sla: { remindAfterHours: 24, escalateAfterHours: 72, escalateTo: { role: 'founder' } },
};

let container: StartedPostgreSqlContainer;
let ownerPool: Pool;
let appPool: Pool;
let db: QuotationFixtureDb;
let f: QuotationFixture;
let scopeA: TxScope;
let scopeB: TxScope;
let approvals: ApprovalsService;
let drafting: InvoiceDraftingService;
let issuing: InvoiceIssueService;
let submitting: InvoiceApprovalService;
let audit: AuditService;

/** Real staff users of entity A: two accountants (the drafter and a checker), finance, and the admin. */
const U = { acc: '', acc2: '', fin: '', admin: '' };
const roles: Partial<Record<RoleKey, string[]>> = {};
const resetRoles = () => {
  roles.accountant = [U.acc, U.acc2];
  roles.finance = [U.fin];
  roles.founder = [U.admin];
};

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
} as unknown as AuthzService;
/** NPR at 1; any other currency has only a rate older than 7 days (D09). */
const money = {
  toNprSnapshot: (_tx: unknown, _scope: unknown, m: { amount: string; currency: string }) =>
    m.currency === 'NPR'
      ? Promise.resolve({
          amountNpr: m.amount,
          rate: '1',
          rateSource: 'NPR',
          rateDate: '2026-11-09',
        })
      : Promise.reject(
          new ConflictException({ code: 'fx_rate_stale', message: 'The USD rate is stale' }),
        ),
} as unknown as MoneyService;
const settings = {
  get: (_scope: unknown, key: string) =>
    Promise.resolve(
      key === 'entity.address'
        ? { line1: '1 Durbar Marg', city: 'Kathmandu', country: 'NP' }
        : key === 'entity.pan_vat_no'
          ? '301234567'
          : null,
    ),
} as unknown as SettingsService;
// Every currency passes here; the refusal of a disabled one is unit-tested in invoice-drafting.currency.test.ts.
const currencies = { assertEnabled: () => Promise.resolve() } as unknown as CurrencyEnabledService;
const notify = {
  notifyUser: vi.fn(() => Promise.resolve(undefined)),
  notifyRole: vi.fn(() => Promise.resolve(undefined)),
} as unknown as ApprovalsNotify;
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
const key = () => `key-${randomUUID()}`;
const responseOf = (e: unknown): unknown => (e as HttpException).getResponse();
const statusOf = (e: unknown): number => (e as HttpException).getStatus();

const manualBody = (currency: 'NPR' | 'USD' = 'NPR') => ({
  customerId: f.customerPartyId,
  currency,
  manualReason: 'Consulting delivered without a sales order',
  lines: [
    {
      description: 'Implementation',
      uom: 'lot',
      quantity: '1',
      unitPrice: '1000.00',
      taxCodeId: f.taxCodeVat13Id,
    },
  ],
});

const invoiceRow = async (id: string) =>
  (await db.select().from(invoices).where(eq(invoices.id, id)))[0]!;

/** A manual tax-invoice draft by the accountant U.acc. */
async function draftManual(currency: 'NPR' | 'USD' = 'NPR'): Promise<string> {
  as(U.acc, 'accountant');
  return (await drafting.draftManual(manualBody(currency), key())).invoice.id;
}

/** Moves a draft straight to approved (setup for the issue tests; the approval path has its own tests). */
async function forceApproved(id: string): Promise<number> {
  await withTx(db, scopeA, systemActor('invoice-fixture'), (tx) =>
    tx.execute(
      sql`UPDATE app.invoices SET status = 'approved', version = version + 1 WHERE id = ${id}`,
    ),
  );
  return (await invoiceRow(id)).version;
}

async function issueAs(id: string, version: number, k = key()): Promise<IssueInvoiceResult> {
  as(U.fin, 'finance');
  return IssueInvoiceResultSchema.parse(await issuing.issue(id, { expectedVersion: version }, k));
}

async function submit(id: string, userId = U.acc): Promise<void> {
  as(userId, 'accountant');
  await submitting.submit(id, { expectedVersion: (await invoiceRow(id)).version }, key());
}

const requestOf = async (invoiceId: string) =>
  (
    await db
      .select()
      .from(approvalRequests)
      .where(
        and(
          eq(approvalRequests.documentType, 'tax_invoice'),
          eq(approvalRequests.documentId, invoiceId),
        ),
      )
  )[0];

async function act(
  user: string,
  role: RoleKey,
  requestId: string,
  action: 'approve' | 'return',
): Promise<void> {
  const [r] = await db
    .select({ version: approvalRequests.version })
    .from(approvalRequests)
    .where(eq(approvalRequests.id, requestId));
  as(user, role);
  await approvals.act(
    requestId,
    { action, expectedVersion: r!.version, ...(action === 'return' ? { comment: 'fix it' } : {}) },
    randomUUID(),
  );
}

/** Submit by U.acc, then U.acc2 (accountant step) and U.fin (finance step) approve. */
async function approveFully(id: string): Promise<void> {
  await submit(id);
  const request = await requestOf(id);
  await act(U.acc2, 'accountant', request!.id, 'approve');
  await act(U.fin, 'finance', request!.id, 'approve');
}

const lastInvSeq = async (scope: TxScope): Promise<number> => {
  const rows = await db.execute<{ last: number | null }>(
    sql`SELECT max(seq)::int AS last FROM app.invoices
        WHERE tenant_id = ${scope.tenantId} AND organization_id = ${scope.organizationId} AND kind = 'tax_invoice'`,
  );
  return rows.rows[0]?.last ?? 0;
};

let soSeq = 0;
/** A confirmed NPR order with 30 credit days and one billable 40% schedule line. */
async function seedOrder(): Promise<{ salesOrderId: string; advanceId: string }> {
  soSeq += 1;
  const scope = scopeA;
  return withTx(db, scope, systemActor('invoice-fixture'), async (tx) => {
    const one = async (q: ReturnType<typeof sql>) =>
      (await tx.execute<{ id: string }>(q)).rows[0]!.id;
    const quotationId = await one(
      sql`INSERT INTO app.quotations (tenant_id, organization_id, number, customer_party_id, opportunity_id)
          VALUES (${scope.tenantId}, ${scope.organizationId}, ${`QT-${randomUUID().slice(0, 8)}`},
                  ${f.customerPartyId}, ${f.opportunityId}) RETURNING id`,
    );
    const versionId = await one(
      sql`INSERT INTO app.quotation_versions (tenant_id, organization_id, quotation_id, revision_no, currency, issue_date, valid_until)
          VALUES (${scope.tenantId}, ${scope.organizationId}, ${quotationId}, 1, 'NPR', '2026-11-09', '2026-12-09') RETURNING id`,
    );
    const salesOrderId = await one(
      sql`INSERT INTO app.sales_orders (tenant_id, organization_id, number, seq, fiscal_year, customer_party_id,
            quotation_id, quotation_version_id, status, currency, subtotal, discount_amount, taxable_amount, tax_amount,
            total, fx_rate, amount_npr, credit_days, confirmed_at)
          VALUES (${scope.tenantId}, ${scope.organizationId}, ${`SO-2083/84-${String(soSeq).padStart(5, '0')}`}, ${soSeq},
            '2083/84', ${f.customerPartyId}, ${quotationId}, ${versionId}, 'confirmed', 'NPR', 4465000.00, 0,
            4465000.00, 580450.00, 5045450.00, 1, 5045450.00, 30, now()) RETURNING id`,
    );
    await tx.execute(
      sql`INSERT INTO app.sales_order_tax_summary (tenant_id, organization_id, sales_order_id, tax_code_id, label, rate, base, tax)
          VALUES (${scope.tenantId}, ${scope.organizationId}, ${salesOrderId}, ${f.taxCodeVat13Id}, 'VAT 13%', 13, 4465000.00, 580450.00)`,
    );
    const advanceId = await one(
      sql`INSERT INTO app.billing_schedule_lines (tenant_id, organization_id, sales_order_id, seq, label, "trigger", percent, amount, amount_npr, status)
          VALUES (${scope.tenantId}, ${scope.organizationId}, ${salesOrderId}, 1, 'Advance 40%', 'advance', 40, 2018180.00, 2018180.00, 'billable') RETURNING id`,
    );
    await one(
      sql`INSERT INTO app.billing_schedule_lines (tenant_id, organization_id, sales_order_id, seq, label, "trigger", percent, amount, amount_npr, status)
          VALUES (${scope.tenantId}, ${scope.organizationId}, ${salesOrderId}, 2, 'Final 60%', 'delivery', 60, 3027270.00, 3027270.00, 'planned') RETURNING id`,
    );
    return { salesOrderId, advanceId };
  });
}

function buildIssuing(ledger: LedgerService): InvoiceIssueService {
  return new InvoiceIssueService(
    db,
    authz,
    audit,
    caller,
    ledger,
    new NumberingService(),
    money,
    settings,
    () => NOW,
  );
}

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
  appPool = new Pool({ connectionString: urlFor('bos_app', APP_PW, 'bos'), max: 10 });
  db = drizzle({ client: appPool });

  f = await seedQuotationFixture(db);
  scopeA = { tenantId: f.tenantId, organizationId: f.entityId };
  scopeB = { tenantId: f.tenantId, organizationId: f.otherEntityId };
  const [owner] = await withTx(db, scopeA, systemActor('test'), (tx) =>
    tx
      .select({ idpOrgId: users.idpOrgId })
      .from(users)
      .where(and(eq(users.tenantId, f.tenantId), eq(users.id, f.ownerUserId))),
  );
  const staff = async (roleKey: RoleKey) =>
    (await createStaffUser(appPool, { ...scopeA, idpOrgId: owner!.idpOrgId, roleKeys: [roleKey] }))
      .userId;
  U.acc = await staff('accountant');
  U.acc2 = await staff('accountant');
  U.fin = await staff('finance');
  U.admin = await staff('founder');
  resetRoles();

  audit = new AuditService(db);
  as(U.admin, 'founder');
  const admin = new ApprovalsAdminService(db, audit, caller, () => NOW);
  await admin.createWorkflow({
    key: 'tax_invoice',
    name: 'Tax invoice',
    spec: TAX_INVOICE_WORKFLOW_SPEC,
  });
  await admin.publish('tax_invoice', 1);

  approvals = new ApprovalsService(db, audit, notify, directory, caller, () => NOW);
  approvals.registerSubject(new InvoiceApprovalSubject('tax_invoice', () => NOW));
  const ledger = new LedgerService();
  drafting = new InvoiceDraftingService(db, authz, audit, caller, ledger, currencies, () => NOW);
  issuing = buildIssuing(ledger);
  submitting = new InvoiceApprovalService(
    db,
    authz,
    audit,
    caller,
    approvals,
    notify,
    money,
    drafting,
    () => NOW,
  );
});

afterAll(async () => {
  await appPool?.end();
  await ownerPool?.end();
  await container?.stop();
});

describe('submit, approve and issue a tax invoice end to end', () => {
  it('a draft has no number; after Accountant -> Finance it issues as INV-2083/84-00001 with its open item and event', async () => {
    const { advanceId } = await seedOrder();
    as(U.acc, 'accountant');
    const draft = (await drafting.draftFromSchedule({ scheduleLineId: advanceId }, key())).invoice;
    const row = await invoiceRow(draft.id);
    expect(row.number).toBeNull();
    expect(row.seq).toBeNull();
    expect(row.status).toBe('draft');

    await submit(draft.id);
    const request = await requestOf(draft.id);
    expect(request!.documentNumber).toBe(`Draft tax_invoice ${draft.id.slice(0, 8)}`);
    expect((await invoiceRow(draft.id)).status).toBe('submitted');
    expect((await invoiceRow(draft.id)).approvalRequestId).toBe(request!.id);
    await act(U.acc2, 'accountant', request!.id, 'approve');
    expect((await invoiceRow(draft.id)).status).toBe('submitted');
    await act(U.fin, 'finance', request!.id, 'approve');
    const approved = await invoiceRow(draft.id);
    expect(approved.status).toBe('approved');
    expect(approved.number).toBeNull();

    const k = key();
    const result = await issueAs(draft.id, approved.version, k);
    expect(result).toEqual({ kind: 'issued', invoiceId: draft.id, number: 'INV-2083/84-00001' });
    const issued = await invoiceRow(draft.id);
    expect(issued).toMatchObject({
      status: 'issued',
      seq: 1,
      fiscalYear: '2083/84',
      issueDate: '2026-11-09',
      issueDateBs: '2083-07-23',
      dueDate: '2026-12-09',
      amountNpr: '2018180.00',
    });
    const items = await db.select().from(openItems).where(eq(openItems.sourceId, draft.id));
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      side: 'receivable',
      direction: 'debit',
      sourceType: 'tax_invoice',
      amount: '2018180.00',
      dueDate: '2026-12-09',
    });
    const events = await db
      .select()
      .from(postingEvents)
      .where(eq(postingEvents.sourceId, draft.id));
    expect(events.map((e) => e.event)).toEqual(['invoice_issued']);
    const [line] = await db
      .select({ status: billingScheduleLines.status })
      .from(billingScheduleLines)
      .where(eq(billingScheduleLines.id, advanceId));
    expect(line!.status).toBe('invoiced');

    // A replay of the same key returns the first answer; a second caller gets already_issued with the number.
    expect(await issueAs(draft.id, approved.version, k)).toEqual(result);
    expect(await issueAs(draft.id, approved.version)).toEqual({
      kind: 'already_issued',
      invoiceId: draft.id,
      number: 'INV-2083/84-00001',
    });
  });

  it('a draft or submitted invoice is not issued (NOT_APPROVED) and keeps no number', async () => {
    const id = await draftManual();
    const err = await issueAs(id, 1).catch((e: unknown) => e);
    expect(statusOf(err)).toBe(409);
    expect(responseOf(err)).toMatchObject({ code: 'NOT_APPROVED' });
    await submit(id);
    const err2 = await issueAs(id, (await invoiceRow(id)).version).catch((e: unknown) => e);
    expect(responseOf(err2)).toMatchObject({ code: 'NOT_APPROVED' });
    expect((await invoiceRow(id)).number).toBeNull();
  });
});

describe('separation of duties (done check 10)', () => {
  it('the drafter cannot approve their own invoice', async () => {
    const id = await draftManual();
    await submit(id);
    const request = await requestOf(id);
    const err = await act(U.acc, 'accountant', request!.id, 'approve').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ForbiddenException);
    expect((await invoiceRow(id)).status).toBe('submitted');
  });

  it('422 NO_ELIGIBLE_APPROVER when the only accountant is the drafter; nothing is submitted', async () => {
    const id = await draftManual();
    roles.accountant = [U.acc];
    // The notice goes to the tenant's live admin.roles.write holders, as the engine reads them (here a Founder-made
    // grant for management too), not to a list fixed in code.
    const holders = vi
      .spyOn(approvals, 'blockedNoticeRoles')
      .mockResolvedValue(['founder', 'management']);
    const notifyRole = vi.mocked(notify.notifyRole);
    notifyRole.mockClear();
    try {
      const err = await submit(id).catch((e: unknown) => e);
      expect(statusOf(err)).toBe(422);
      expect(responseOf(err)).toMatchObject({ code: 'NO_ELIGIBLE_APPROVER' });
      expect(holders).toHaveBeenCalledWith(scopeA.tenantId);
      expect(notifyRole.mock.calls.map((c) => c[1])).toEqual(['founder', 'management']);
    } finally {
      holders.mockRestore();
      resetRoles();
    }
    const row = await invoiceRow(id);
    expect(row.status).toBe('draft');
    expect(row.approvalRequestId).toBeNull();
    expect(await requestOf(id)).toBeUndefined();
  });

  it('an edit while submitted cancels the open request and returns the invoice', async () => {
    const id = await draftManual();
    await submit(id);
    const request = await requestOf(id);
    as(U.acc, 'accountant');
    await withTx(db, scopeA, caller.current().actor, (tx) =>
      submitting.reopenForEdit(
        tx,
        scopeA,
        caller.current().actor,
        id,
        'Customer asked for a change',
      ),
    );
    expect((await requestOf(id))!.status).toBe('cancelled');
    expect(request!.id).toBe((await requestOf(id))!.id);
    expect((await invoiceRow(id)).status).toBe('returned');
  });

  it('an edit after approval sends the invoice back to draft, so it cannot be issued without a new approval', async () => {
    const id = await draftManual();
    await approveFully(id);
    expect((await invoiceRow(id)).status).toBe('approved');
    as(U.acc, 'accountant');
    await withTx(db, scopeA, caller.current().actor, (tx) =>
      submitting.reopenForEdit(tx, scopeA, caller.current().actor, id, 'Price corrected'),
    );
    const row = await invoiceRow(id);
    expect(row.status).toBe('draft');
    const err = await issueAs(id, row.version).catch((e: unknown) => e);
    expect(responseOf(err)).toMatchObject({ code: 'NOT_APPROVED' });
  });

  it('an invoice changed after submit is returned, not approved; a return returns it', async () => {
    const changed = await draftManual();
    await submit(changed);
    await withTx(db, scopeA, systemActor('invoice-fixture'), (tx) =>
      tx.execute(sql`UPDATE app.invoices SET due_date = '2027-01-31' WHERE id = ${changed}`),
    );
    const r1 = await requestOf(changed);
    await act(U.acc2, 'accountant', r1!.id, 'approve');
    await act(U.fin, 'finance', r1!.id, 'approve');
    expect((await invoiceRow(changed)).status).toBe('returned');

    const returned = await draftManual();
    await submit(returned);
    await act(U.acc2, 'accountant', (await requestOf(returned))!.id, 'return');
    expect((await invoiceRow(returned)).status).toBe('returned');
  });
});

describe('issue guards', () => {
  it('a stale FX rate answers 409 fx_rate_stale and consumes no number', async () => {
    const id = await draftManual('USD');
    const version = await forceApproved(id);
    const before = await lastInvSeq(scopeA);
    const err = await issueAs(id, version).catch((e: unknown) => e);
    expect(statusOf(err)).toBe(409);
    expect(responseOf(err)).toMatchObject({ code: 'fx_rate_stale' });
    expect((await invoiceRow(id)).status).toBe('approved');
    expect(await lastInvSeq(scopeA)).toBe(before);
  });

  it('another entity cannot submit or issue the invoice (404)', async () => {
    const id = await draftManual();
    current.scope = scopeB;
    try {
      const e1 = await submit(id).catch((e: unknown) => e);
      expect(statusOf(e1)).toBe(404);
      const e2 = await issueAs(id, 1).catch((e: unknown) => e);
      expect(statusOf(e2)).toBe(404);
    } finally {
      current.scope = null;
    }
    expect((await invoiceRow(id)).status).toBe('draft');
  });

  it('20 parallel issues give 1 number, 1 open item, 1 event and 19 already_issued (done check 3)', async () => {
    const id = await draftManual();
    const version = await forceApproved(id);
    const results = await Promise.all(Array.from({ length: 20 }, () => issueAs(id, version)));
    const issued = results.filter((r) => r.kind === 'issued');
    const again = results.filter((r) => r.kind === 'already_issued');
    expect(issued).toHaveLength(1);
    expect(again).toHaveLength(19);
    expect(new Set(results.map((r) => r.number)).size).toBe(1);
    expect(await db.select().from(openItems).where(eq(openItems.sourceId, id))).toHaveLength(1);
    expect(
      await db.select().from(postingEvents).where(eq(postingEvents.sourceId, id)),
    ).toHaveLength(1);
  });

  it('a forced rollback after numbering gives the number back to the next issue (done check 4)', async () => {
    const id = await draftManual();
    const version = await forceApproved(id);
    const before = await lastInvSeq(scopeA);
    const failing = new LedgerService();
    vi.spyOn(failing, 'recordEvent').mockRejectedValueOnce(new Error('forced failure'));
    as(U.fin, 'finance');
    await expect(
      buildIssuing(failing).issue(id, { expectedVersion: version }, key()),
    ).rejects.toThrow('forced failure');
    const row = await invoiceRow(id);
    expect(row.status).toBe('approved');
    expect(row.number).toBeNull();
    expect(await db.select().from(openItems).where(eq(openItems.sourceId, id))).toHaveLength(0);

    await issueAs(id, version);
    expect((await invoiceRow(id)).seq).toBe(before + 1);
  });

  it('300 parallel issues take consecutive numbers with no gap (done check 4)', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 300; i++) ids.push(await draftManual());
    for (const id of ids) await forceApproved(id);
    const before = await lastInvSeq(scopeA);
    const results = await Promise.all(ids.map((id) => issueAs(id, 2)));
    expect(results.every((r) => r.kind === 'issued')).toBe(true);
    const rows = await db
      .select({ seq: invoices.seq, number: invoices.number })
      .from(invoices)
      .where(inArray(invoices.id, ids));
    const seqs = rows.map((r) => r.seq!).sort((a, b) => a - b);
    expect(seqs).toEqual(Array.from({ length: 300 }, (_, i) => before + 1 + i));
    for (const r of rows) {
      expect(r.number).toBe(`INV-2083/84-${String(r.seq).padStart(5, '0')}`);
    }
  }, 300_000);
});

describe('list by derived settlement', () => {
  it('an issued invoice with no payment is unpaid, then overdue after its due date; a draft is neither', async () => {
    const id = await draftManual();
    const version = await forceApproved(id);
    const issued = await issueAs(id, version);
    expect(issued.kind).toBe('issued');
    const draft = await draftManual();

    const idsOf = async (
      settlement: ('unpaid' | 'overdue' | 'paid' | 'partly_paid' | 'credited')[],
    ) => (await drafting.list({ settlement })).rows.map((r) => r.id);
    expect(await idsOf(['unpaid'])).toContain(id);
    expect(await idsOf(['unpaid', 'overdue'])).not.toContain(draft);
    expect(await idsOf(['paid', 'partly_paid', 'credited', 'overdue'])).not.toContain(id);

    // Same rows, a clock past the due date: unpaid turns overdue.
    const later = new InvoiceDraftingService(
      db,
      authz,
      audit,
      caller,
      new LedgerService(),
      currencies,
      () => new Date('2027-03-01T06:00:00Z'),
    );
    const overdue = (await later.list({ settlement: ['overdue'] })).rows.map((r) => r.id);
    expect(overdue).toContain(id);
    expect((await later.list({ settlement: ['unpaid'] })).rows.map((r) => r.id)).not.toContain(id);
  });
});
