// Integration tests of `PATCH /v1/invoices/:id/due-date` (Kuu, leftovers Q3) on a real Postgres. Real: migrations,
// queries as bos_app, the approvals engine with the Accountant -> Finance tax_invoice route, InvoicesController (body
// parsing and the Idempotency-Key check), the invoice drafting, approval and issue services, NumberingService,
// LedgerService and AuditService. Faked as in invoice-issue.integration.test.ts: the request context, authz.assert
// (the real pure can() on a fake principal), notify, the role directory, MoneyService (NPR at 1) and the entity
// settings. The @Can route guard and the HTTP layer are not exercised here.
// Run: pnpm --filter @bos/api exec vitest run src/modules/invoices/invoice-due-date.integration.test.ts
import 'reflect-metadata';

import { randomUUID } from 'node:crypto';

import {
  DEFAULT_ROLE_PERMISSIONS,
  IssueInvoiceResultSchema,
  type InvoiceDetail,
  type Permission,
  type RoleKey,
  type Scope,
} from '@bos/contracts';
import { approvalRequests, createStaffUser, invoices, users } from '@bos/db';
import { createTestDatabase, type TestDatabase } from '@bos/db/testing';
import { ForbiddenException, HttpException } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { asSecondPerson, SKIP_LIVE_PUBLISHER_CHECK } from '../../../test/support/second-person';
import { AuditService } from '../../platform/audit/audit.service';
import type { AuthzService } from '../../platform/authz/authz.service';
import { can } from '../../platform/authz/can';
import type { Principal } from '../../platform/authz/principal';
import { systemActor, withTx, type TxScope } from '../../platform/db/tx';
import type { CurrencyEnabledService } from '../../platform/settings/currency-enabled';
import type { MoneyService } from '../../platform/settings/money.service';
import { NumberingService } from '../../platform/settings/numbering.service';
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
import { InvoicesController } from './invoices.controller';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 180_000 });

/** 2026-11-09 11:45 in Kathmandu. Tests move `clock.now` forward to let a due date pass. */
const NOW = new Date('2026-11-09T06:00:00Z');
const clock = { now: NOW };
const DAY = 24 * 60 * 60 * 1000;
const at = (days: number) => new Date(NOW.getTime() + days * DAY);

const TAX_INVOICE_WORKFLOW_SPEC: unknown = {
  documentType: 'tax_invoice',
  steps: [
    { id: 'accountant', kind: 'role', role: 'accountant', reason: 'Accountant checks' },
    { id: 'finance', kind: 'role', role: 'finance', reason: 'Finance approves' },
  ],
  rules: [],
  distinctApprovers: true,
  sla: { remindAfterHours: 24, escalateAfterHours: 72, escalateTo: { role: 'founder' } },
};

let testDb: TestDatabase;
let appPool: Pool;
let db: QuotationFixtureDb;
let f: QuotationFixture;
let otherTenant: QuotationFixture;
let scopeA: TxScope;
let approvals: ApprovalsService;
let drafting: InvoiceDraftingService;
let issuing: InvoiceIssueService;
let submitting: InvoiceApprovalService;
let audit: AuditService;
let controller: InvoicesController;

const U = { acc: '', acc2: '', fin: '', admin: '' };
const roles: Partial<Record<RoleKey, string[]>> = {};

const grantsOf = (role: RoleKey) =>
  new Map(Object.entries(DEFAULT_ROLE_PERMISSIONS[role])) as Map<Permission, Scope>;
const current: {
  userId: string;
  role: RoleKey;
  scope: TxScope | null;
  grants?: Map<Permission, Scope>;
} = { userId: '', role: 'accountant', scope: null };
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
} as unknown as AuthzService;
const money = {
  toNprSnapshot: (_tx: unknown, _scope: unknown, m: { amount: string }) =>
    Promise.resolve({ amountNpr: m.amount, rate: '1', rateSource: 'NPR', rateDate: '2026-11-09' }),
} as unknown as MoneyService;
const settings = {
  get: (_scope: unknown, key: string) =>
    Promise.resolve(
      key === 'entity.address'
        ? { line: '1 Durbar Marg', city: 'Kathmandu', country: 'NP' }
        : key === 'entity.pan_vat_no'
          ? '301234567'
          : null,
    ),
} as unknown as SettingsService;
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

const key = () => `key-${randomUUID()}`;
const caught = async (p: Promise<unknown>): Promise<HttpException> => {
  const e = await p.then(
    () => undefined,
    (err: unknown) => err,
  );
  expect(e).toBeInstanceOf(HttpException);
  return e as HttpException;
};
const invoiceRow = async (id: string) =>
  (await db.select().from(invoices).where(eq(invoices.id, id)))[0]!;

const lines = () => [
  {
    description: 'Implementation',
    uom: 'lot',
    quantity: '1',
    unitPrice: '1000.00',
    taxCodeId: f.taxCodeVat13Id,
  },
];

/** A manual tax-invoice draft by `userId` (U.acc by default), due on `dueDate`. */
async function draftManual(dueDate = '2026-11-30', userId = U.acc): Promise<InvoiceDetail> {
  as(userId, 'accountant');
  return controller.draftManual(key(), {
    customerId: f.customerPartyId,
    currency: 'NPR',
    manualReason: 'Consulting delivered without a sales order',
    dueDate,
    lines: lines(),
  });
}

/** PATCH as the current caller, through the controller. */
const patch = async (id: string, body: unknown, k: string = key()) =>
  controller.editDueDate(id, k, body);
/** PATCH with no Idempotency-Key header. Async so the controller's synchronous 400 becomes a rejection. */
const patchWithoutKey = async (id: string, body: unknown) =>
  controller.editDueDate(id, undefined, body);
/** GET as the current caller, through the controller. */
const get = (id: string) => controller.detail(id);

async function submit(id: string): Promise<void> {
  as(U.acc, 'accountant');
  await controller.submit(id, key(), { expectedVersion: (await invoiceRow(id)).version });
}

/** The invoice's current approval request: a resubmitted or reopened invoice has one per submission. */
const latestRequest = async (invoiceId: string) => {
  const requestId = (await invoiceRow(invoiceId)).approvalRequestId;
  if (requestId === null) throw new Error('the invoice has no approval request');
  return (await db.select().from(approvalRequests).where(eq(approvalRequests.id, requestId)))[0]!;
};

async function act(
  user: string,
  role: RoleKey,
  invoiceId: string,
  action: 'approve' | 'return',
): Promise<void> {
  const request = await latestRequest(invoiceId);
  as(user, role);
  await approvals.act(
    request.id,
    {
      action,
      expectedVersion: request.version,
      ...(action === 'return' ? { comment: 'fix it' } : {}),
    },
    randomUUID(),
  );
}

async function approveFully(id: string): Promise<void> {
  await submit(id);
  await act(U.acc2, 'accountant', id, 'approve');
  await act(U.fin, 'finance', id, 'approve');
}

const dueDateEvents = async (id: string) => {
  const events = await audit.list(scopeA, { entityType: 'invoices', entityId: id, limit: 1000 });
  return events.filter((e) => e.action === 'invoice.due_date_changed');
};

beforeAll(async () => {
  testDb = await createTestDatabase();
  appPool = new Pool({ connectionString: testDb.appUrl, max: 10 });
  db = drizzle({ client: appPool });

  f = await seedQuotationFixture(db);
  otherTenant = await seedQuotationFixture(db);
  expect(otherTenant.tenantId).not.toBe(f.tenantId);
  scopeA = { tenantId: f.tenantId, organizationId: f.entityId };
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
  roles.accountant = [U.acc, U.acc2];
  roles.finance = [U.fin];
  roles.founder = [U.admin];

  const now = () => clock.now;
  audit = new AuditService(db);
  as(U.admin, 'founder');
  const admin = new ApprovalsAdminService(db, audit, caller, now);
  await admin.createWorkflow({
    key: 'tax_invoice',
    name: 'Tax invoice',
    spec: TAX_INVOICE_WORKFLOW_SPEC,
  });
  await new ApprovalsAdminService(db, audit, asSecondPerson(caller), now).publish(
    'tax_invoice',
    1,
    SKIP_LIVE_PUBLISHER_CHECK,
  );

  approvals = new ApprovalsService(db, audit, notify, directory, caller, now);
  approvals.registerSubject(new InvoiceApprovalSubject('tax_invoice', now));
  const ledger = new LedgerService();
  drafting = new InvoiceDraftingService(db, authz, audit, caller, ledger, currencies, now);
  issuing = new InvoiceIssueService(
    db,
    authz,
    audit,
    caller,
    ledger,
    new NumberingService(),
    money,
    settings,
    now,
  );
  submitting = new InvoiceApprovalService(
    db,
    authz,
    audit,
    caller,
    approvals,
    notify,
    money,
    drafting,
    now,
  );
  controller = new InvoicesController(drafting, issuing, submitting, {} as never);
});

beforeEach(() => {
  clock.now = NOW;
  current.scope = null;
  delete current.grants;
  as(U.acc, 'accountant');
});

afterAll(async () => {
  await appPool?.end();
  await testDb?.drop();
});

describe('PATCH /v1/invoices/:id/due-date', () => {
  it('changes the due date of a draft, bumps the version, audits once and the drafter reads it back', async () => {
    const draft = await draftManual('2026-11-30');
    expect((await get(draft.invoice.id)).can?.editDueDate).toEqual({ allowed: true });

    const k = key();
    const body = { expectedVersion: draft.invoice.version, dueDate: '2026-12-15' };
    const edited = await patch(draft.invoice.id, body, k);
    expect(edited.invoice.dueDate).toBe('2026-12-15');
    expect(edited.invoice.version).toBe(draft.invoice.version + 1);
    expect((await get(draft.invoice.id)).invoice).toMatchObject({
      dueDate: '2026-12-15',
      status: 'draft',
    });

    // A replay of the same key answers the first result and changes nothing more.
    expect(await patch(draft.invoice.id, body, k)).toEqual(edited);
    expect((await invoiceRow(draft.invoice.id)).version).toBe(draft.invoice.version + 1);
    // The same key with another body is not a replay.
    const reused = await caught(patch(draft.invoice.id, { ...body, dueDate: '2026-12-20' }, k));
    expect(reused.getStatus()).toBe(422);

    const events = await dueDateEvents(draft.invoice.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      actorId: U.acc,
      before: { dueDate: '2026-11-30', version: draft.invoice.version },
      after: { dueDate: '2026-12-15', version: draft.invoice.version + 1 },
    });
  });

  it('accepts today, and refuses a date before today with the issue step code and wording', async () => {
    const draft = await draftManual('2026-11-30');
    const past = await caught(
      patch(draft.invoice.id, { expectedVersion: draft.invoice.version, dueDate: '2026-11-08' }),
    );
    expect(past.getStatus()).toBe(422);
    expect(past.getResponse()).toEqual({
      code: 'DUE_DATE_BEFORE_ISSUE',
      message: 'The due date is before the issue date; correct the due date and issue again',
      details: { dueDate: '2026-11-08', issueDate: '2026-11-09' },
    });
    const today = await patch(draft.invoice.id, {
      expectedVersion: draft.invoice.version,
      dueDate: '2026-11-09',
    });
    expect(today.invoice.dueDate).toBe('2026-11-09');
  });

  it('answers a stale expectedVersion with 409 and keeps the date', async () => {
    const draft = await draftManual('2026-11-30');
    await patch(draft.invoice.id, {
      expectedVersion: draft.invoice.version,
      dueDate: '2026-12-01',
    });
    const stale = await caught(
      patch(draft.invoice.id, { expectedVersion: draft.invoice.version, dueDate: '2026-12-31' }),
    );
    expect(stale.getStatus()).toBe(409);
    expect(stale.getResponse()).toMatchObject({ code: 'conflict' });
    expect((await invoiceRow(draft.invoice.id)).dueDate).toBe('2026-12-01');
  });

  it('refuses a missing Idempotency-Key and a malformed body with 400', async () => {
    const draft = await draftManual();
    const v = draft.invoice.version;
    const noKey = await caught(
      patchWithoutKey(draft.invoice.id, { expectedVersion: v, dueDate: '2026-12-01' }),
    );
    expect(noKey.getStatus()).toBe(400);
    for (const body of [
      { expectedVersion: v, dueDate: '2026-13-01' },
      { expectedVersion: v },
      { expectedVersion: v, dueDate: '2026-12-01', status: 'issued' },
    ]) {
      const e = await caught(patch(draft.invoice.id, body));
      expect(e.getStatus()).toBe(400);
    }
    expect((await invoiceRow(draft.invoice.id)).version).toBe(v);
  });

  it('is allowed in draft and returned only, and the detail flag agrees with the route in every status', async () => {
    const expectRefused = async (id: string, reason: string) => {
      as(U.acc, 'accountant');
      expect((await get(id)).can?.editDueDate).toEqual({ allowed: false, reason });
      const row = await invoiceRow(id);
      const e = await caught(patch(id, { expectedVersion: row.version, dueDate: '2026-12-31' }));
      expect(e.getStatus()).toBe(409);
      expect(e.getResponse()).toMatchObject({ code: 'conflict', message: reason });
      expect((await invoiceRow(id)).version).toBe(row.version);
    };
    const expectAllowed = async (id: string, dueDate: string) => {
      as(U.acc, 'accountant');
      expect((await get(id)).can?.editDueDate).toEqual({ allowed: true });
      const row = await invoiceRow(id);
      expect((await patch(id, { expectedVersion: row.version, dueDate })).invoice.dueDate).toBe(
        dueDate,
      );
    };

    const id = (await draftManual('2026-11-30')).invoice.id;
    await expectAllowed(id, '2026-12-01');

    await submit(id);
    expect((await invoiceRow(id)).status).toBe('submitted');
    await expectRefused(
      id,
      'The invoice is waiting for approval; its due date can be changed once it is returned',
    );

    await act(U.acc2, 'accountant', id, 'return');
    expect((await invoiceRow(id)).status).toBe('returned');
    await expectAllowed(id, '2026-12-02');

    await approveFully(id);
    expect((await invoiceRow(id)).status).toBe('approved');
    await expectRefused(id, 'Take the invoice back to draft to change its due date');

    as(U.fin, 'finance');
    const issued = IssueInvoiceResultSchema.parse(
      await controller.issue(id, key(), { expectedVersion: (await invoiceRow(id)).version }),
    );
    expect(issued.kind).toBe('issued');
    await expectRefused(id, 'An issued invoice cannot be changed');

    const discarded = await draftManual();
    await controller.discard(discarded.invoice.id, key(), {
      expectedVersion: discarded.invoice.version,
      reason: 'Drafted twice',
    });
    await expectRefused(discarded.invoice.id, 'A discarded invoice cannot be changed');
  });

  it('is allowed on a proforma draft, whose drafted due date is the one it issues with', async () => {
    as(U.acc, 'accountant');
    const pi = await controller.draftProforma(key(), {
      customerId: f.customerPartyId,
      currency: 'NPR',
      dueDate: '2026-11-20',
      lines: lines(),
    });
    expect((await get(pi.invoice.id)).can?.editDueDate).toEqual({ allowed: true });
    const edited = await patch(pi.invoice.id, {
      expectedVersion: pi.invoice.version,
      dueDate: '2026-12-20',
    });
    expect(edited.invoice.dueDate).toBe('2026-12-20');
  });

  it("refuses a caller without invoice.draft, and an own grant on another drafter's invoice, with 403", async () => {
    const draft = await draftManual('2026-11-30');
    const body = { expectedVersion: draft.invoice.version, dueDate: '2026-12-15' };
    const reason = 'Only someone who may draft this invoice can change its due date';

    const noDraft = grantsOf('accountant');
    noDraft.delete('invoice.draft');
    current.grants = noDraft;
    expect((await get(draft.invoice.id)).can?.editDueDate).toEqual({ allowed: false, reason });
    expect((await caught(patch(draft.invoice.id, body))).getStatus()).toBe(403);

    // Another accountant whose drafting reach is their own invoices only: readable, not theirs to change.
    as(U.acc2, 'accountant');
    current.grants = new Map([...grantsOf('accountant'), ['invoice.draft', 'own']]);
    expect((await get(draft.invoice.id)).can?.editDueDate).toEqual({ allowed: false, reason });
    expect((await caught(patch(draft.invoice.id, body))).getStatus()).toBe(403);

    // Read narrowed to their own as well: the invoice is not there at all.
    current.grants = new Map([
      ...grantsOf('accountant'),
      ['invoice.read', 'own'],
      ['invoice.draft', 'own'],
    ]);
    expect((await caught(patch(draft.invoice.id, body))).getStatus()).toBe(404);

    delete current.grants;
    expect((await invoiceRow(draft.invoice.id)).dueDate).toBe('2026-11-30');
    expect(await dueDateEvents(draft.invoice.id)).toHaveLength(0);
  });

  it('answers 404 from another legal entity and from another tenant', async () => {
    const draft = await draftManual('2026-11-30');
    const body = { expectedVersion: draft.invoice.version, dueDate: '2026-12-15' };
    current.scope = { tenantId: f.tenantId, organizationId: f.otherEntityId };
    expect((await caught(patch(draft.invoice.id, body))).getStatus()).toBe(404);
    current.scope = { tenantId: otherTenant.tenantId, organizationId: otherTenant.entityId };
    expect((await caught(patch(draft.invoice.id, body))).getStatus()).toBe(404);
    current.scope = null;
    expect((await invoiceRow(draft.invoice.id)).dueDate).toBe('2026-11-30');
  });

  it('gets a past-due approved invoice issued: back to draft, a new due date, submit, approve, issue', async () => {
    const id = (await draftManual('2026-11-10')).invoice.id;
    await approveFully(id);
    expect((await invoiceRow(id)).status).toBe('approved');

    // Two days later the drafted due date has passed: issue refuses it.
    clock.now = at(2);
    as(U.fin, 'finance');
    const late = await caught(
      controller.issue(id, key(), { expectedVersion: (await invoiceRow(id)).version }),
    );
    expect(late.getStatus()).toBe(422);
    expect(late.getResponse()).toMatchObject({ code: 'DUE_DATE_BEFORE_ISSUE' });

    // Back to draft (the existing route), then the due date can be changed.
    await controller.reopen(id, key(), {
      expectedVersion: (await invoiceRow(id)).version,
      reason: 'Due date passed before issue',
    });
    expect((await invoiceRow(id)).status).toBe('draft');
    as(U.acc, 'accountant');
    expect((await get(id)).can?.editDueDate).toEqual({ allowed: true });
    const stillPast = await caught(
      patch(id, { expectedVersion: (await invoiceRow(id)).version, dueDate: '2026-11-10' }),
    );
    expect(stillPast.getStatus()).toBe(422);
    // The same code and wording issue gave a moment ago.
    expect(stillPast.getResponse()).toMatchObject({
      code: 'DUE_DATE_BEFORE_ISSUE',
      message: (late.getResponse() as { message: string }).message,
      details: { dueDate: '2026-11-10', issueDate: '2026-11-11' },
    });
    await patch(id, { expectedVersion: (await invoiceRow(id)).version, dueDate: '2026-12-11' });

    await approveFully(id);
    expect((await invoiceRow(id)).status).toBe('approved');
    as(U.fin, 'finance');
    const result = IssueInvoiceResultSchema.parse(
      await controller.issue(id, key(), { expectedVersion: (await invoiceRow(id)).version }),
    );
    expect(result.kind).toBe('issued');
    expect(await invoiceRow(id)).toMatchObject({
      status: 'issued',
      issueDate: '2026-11-11',
      dueDate: '2026-12-11',
    });
  });
});

// A tax invoice cut from a sales order takes its due date from the order's credit days at issue, so an edit would be
// thrown away: refused with the reason, on a draft made by the real from-schedule path.
describe('a tax invoice from a sales order', () => {
  it('refuses the edit with 409 and says why on the detail', async () => {
    const scheduleLineId = await withTx(db, scopeA, systemActor('test'), async (tx) => {
      const one = async (q: ReturnType<typeof sql>) =>
        (await tx.execute<{ id: string }>(q)).rows[0]!.id;
      const quotationId = await one(
        sql`INSERT INTO app.quotations (tenant_id, organization_id, number, customer_party_id, opportunity_id)
            VALUES (${scopeA.tenantId}, ${scopeA.organizationId}, ${`QT-${randomUUID().slice(0, 8)}`},
                    ${f.customerPartyId}, ${f.opportunityId}) RETURNING id`,
      );
      const versionId = await one(
        sql`INSERT INTO app.quotation_versions (tenant_id, organization_id, quotation_id, revision_no, currency, issue_date, valid_until)
            VALUES (${scopeA.tenantId}, ${scopeA.organizationId}, ${quotationId}, 1, 'NPR', '2026-11-09', '2026-12-09') RETURNING id`,
      );
      const salesOrderId = await one(
        sql`INSERT INTO app.sales_orders (tenant_id, organization_id, number, seq, fiscal_year, customer_party_id,
              quotation_id, quotation_version_id, status, currency, subtotal, discount_amount, taxable_amount, tax_amount,
              total, fx_rate, amount_npr, credit_days, confirmed_at)
            VALUES (${scopeA.tenantId}, ${scopeA.organizationId}, 'SO-2083/84-00001', 1, '2083/84', ${f.customerPartyId},
              ${quotationId}, ${versionId}, 'confirmed', 'NPR', 4465000.00, 0, 4465000.00, 580450.00, 5045450.00, 1,
              5045450.00, 30, now()) RETURNING id`,
      );
      await tx.execute(
        sql`INSERT INTO app.sales_order_tax_summary (tenant_id, organization_id, sales_order_id, tax_code_id, label, rate, base, tax)
            VALUES (${scopeA.tenantId}, ${scopeA.organizationId}, ${salesOrderId}, ${f.taxCodeVat13Id}, 'VAT 13%', 13, 4465000.00, 580450.00)`,
      );
      const advanceId = await one(
        sql`INSERT INTO app.billing_schedule_lines (tenant_id, organization_id, sales_order_id, seq, label, "trigger", percent, amount, amount_npr, status)
            VALUES (${scopeA.tenantId}, ${scopeA.organizationId}, ${salesOrderId}, 1, 'Advance 40%', 'advance', 40, 2018180.00, 2018180.00, 'billable') RETURNING id`,
      );
      // The schedule must add up to the order (billing_schedule_check_sum at commit).
      await one(
        sql`INSERT INTO app.billing_schedule_lines (tenant_id, organization_id, sales_order_id, seq, label, "trigger", percent, amount, amount_npr, status)
            VALUES (${scopeA.tenantId}, ${scopeA.organizationId}, ${salesOrderId}, 2, 'Final 60%', 'delivery', 60, 3027270.00, 3027270.00, 'planned') RETURNING id`,
      );
      return advanceId;
    });
    as(U.acc, 'accountant');
    const draft = await controller.draftFromSchedule(key(), { scheduleLineId });
    const reason =
      "This invoice's due date is set when it is issued, from the sales order's credit days";
    expect((await get(draft.invoice.id)).can?.editDueDate).toEqual({ allowed: false, reason });
    const e = await caught(
      patch(draft.invoice.id, { expectedVersion: draft.invoice.version, dueDate: '2026-12-31' }),
    );
    expect(e.getStatus()).toBe(409);
    expect(e.getResponse()).toMatchObject({ code: 'conflict', message: reason });
  });
});
