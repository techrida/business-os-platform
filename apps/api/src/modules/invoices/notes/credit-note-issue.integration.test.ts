// Integration tests of credit-note issue (P3 unit U12 part C) on a real Postgres (Testcontainers, needs Docker in WSL).
// Real: migrations as bos_owner, queries as bos_app (every CHECK and trigger of 0019-0023 runs: G3 with the one
// credited_in_full_at change, G4 skipping a credited invoice, the allocation cap and the deferred invoices_notes cap),
// the invoice and note services, CreditNoteIssueService, NumberingService, LedgerService, AuditService, PaymentsService
// and AllocationsService for real verified payments, ReceivablesService for the derived settlement and advance, and
// ErrorBodyFilter for the HTTP body. Faked: the request context, authz.assert (the real pure can() on a fake principal
// for the invoice services; pass-through for payments, whose routes carry @Can), MoneyService (NPR at 1) and settings.
// Approvals are forced with a system UPDATE (the approval flow has its own tests).
// Covers done check 7 (cap), 8 (settlement derived from allocations) and the U12 issue rules: release newest first,
// open amounts never below 0, full credit gives the schedule line back, replay safety, cross-entity 404.
// Run: pnpm --filter @bos/api exec vitest run src/modules/invoices/notes/credit-note-issue.integration.test.ts
import 'reflect-metadata';

import { randomUUID } from 'node:crypto';

import {
  DEFAULT_ROLE_PERMISSIONS,
  ErrorBodySchema,
  IssueInvoiceResultSchema,
  type IssueInvoiceResult,
  type Permission,
  type RoleKey,
  type Scope,
} from '@bos/contracts';
import {
  billingScheduleLines,
  createStaffUser,
  documents,
  documentVersions,
  invoiceLines,
  invoices,
  openItemAllocations,
  openItemBalances,
  openItems,
  postingEvents,
  users,
} from '@bos/db';
import { type ArgumentsHost, ForbiddenException, HttpException } from '@nestjs/common';
import { and, asc, eq, inArray, lt, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { AuditService } from '../../../platform/audit/audit.service';
import type { AuthzService } from '../../../platform/authz/authz.service';
import { can } from '../../../platform/authz/can';
import type { Principal } from '../../../platform/authz/principal';
import { systemActor, withTx, type Actor, type TxScope } from '../../../platform/db/tx';
import { MoneyService } from '../../../platform/settings/money.service';
import { NumberingService } from '../../../platform/settings/numbering.service';
import type { CurrencyEnabledService } from '../../../platform/settings/currency-enabled';
import type { SettingsService } from '../../../platform/settings/settings.service';
import { ErrorBodyFilter } from '../../../platform/tenancy/error-body.filter';
import { LedgerService } from '../../ledger/ledger.service';
import { PAYMENT_INTAKE_OWNER_TYPE } from '../../payments/payment-owner.policy';
import { PaymentsService } from '../../payments/payments.service';
import {
  seedQuotationFixture,
  type QuotationFixture,
  type QuotationFixtureDb,
} from '../../quotations/drafting/quotation.fixture';
import { AllocationsService } from '../../receivables/allocations.service';
import { ReceivablesService } from '../../receivables/receivables.service';
import { InvoiceDraftingService } from '../invoice-drafting.service';
import { InvoiceIssueService } from '../invoice-issue.service';
import { NoteDraftingService } from './note-drafting.service';
import { createTestDatabase, type TestDatabase } from '@bos/db/testing';

vi.setConfig({ testTimeout: 90_000, hookTimeout: 180_000 });

/** 2026-11-09 11:45 in Kathmandu: BS 2083-07-23, fiscal year 2083/84. */
const NOW = new Date('2026-11-09T06:00:00Z');
const CN_NUMBER = /^CN-2083\/84-\d{5}$/;

let testDb: TestDatabase;
let ownerPool: Pool;
let appPool: Pool;
let db: QuotationFixtureDb;
let f: QuotationFixture;
let scopeA: TxScope;
let scopeB: TxScope;
let drafting: InvoiceDraftingService;
let issuing: InvoiceIssueService;
let notes: NoteDraftingService;
let payments: PaymentsService;
let allocations: AllocationsService;
let receivables: ReceivablesService;
let soSeq = 0;

/** Real staff users of entity A: an accountant (drafts invoices), two finance users (issue; record and verify). */
const U = { acc: '', fin: '', fin2: '' };

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
const passAuthz = { assert: () => undefined } as unknown as AuthzService;
const money = {
  toNprSnapshot: (_tx: unknown, _scope: unknown, m: { amount: string }) =>
    Promise.resolve({ amountNpr: m.amount, rate: '1', rateSource: 'NPR', rateDate: '2026-11-09' }),
} as unknown as MoneyService;
const settings = {
  get: (_scope: unknown, k: string) =>
    Promise.resolve(
      k === 'entity.address'
        ? { line: '1 Durbar Marg', city: 'Kathmandu', country: 'NP' }
        : k === 'entity.pan_vat_no'
          ? '301234567'
          : null,
    ),
} as unknown as SettingsService;
// Every currency passes here; the refusal of a disabled one is unit-tested in invoice-drafting.currency.test.ts.
const currencies = { assertEnabled: () => Promise.resolve() } as unknown as CurrencyEnabledService;

const key = () => `key-${randomUUID()}`;
const userActor = (id: string): Actor => ({ kind: 'user', id, correlationId: `t-${randomUUID()}` });
const statusOf = (e: unknown): number => (e as HttpException).getStatus();
const invoiceRow = async (id: string) =>
  (await db.select().from(invoices).where(eq(invoices.id, id)))[0]!;

/** Moves a draft to approved the way a finished Accountant -> Finance route leaves it. */
async function forceApproved(id: string): Promise<number> {
  await withTx(db, scopeA, systemActor('cn-fixture'), (tx) =>
    tx.execute(
      sql`UPDATE app.invoices SET status = 'approved', version = version + 1 WHERE id = ${id}`,
    ),
  );
  return (await invoiceRow(id)).version;
}

async function issueAs(id: string, userId = U.fin2): Promise<IssueInvoiceResult> {
  as(userId, 'finance');
  return IssueInvoiceResultSchema.parse(
    await issuing.issue(id, { expectedVersion: (await invoiceRow(id)).version }, key()),
  );
}

/** An issued NPR manual tax invoice: 4 x 250.00 at VAT 13% = 1,130.00. */
async function issuedInvoice(): Promise<string> {
  as(U.acc, 'accountant');
  const draft = await drafting.draftManual(
    {
      customerId: f.customerPartyId,
      currency: 'NPR',
      manualReason: 'Consulting delivered without a sales order',
      lines: [
        {
          description: 'Implementation',
          uom: 'day',
          quantity: '4',
          unitPrice: '250.00',
          taxCodeId: f.taxCodeVat13Id,
        },
      ],
    },
    key(),
  );
  await forceApproved(draft.invoice.id);
  await issueAs(draft.invoice.id);
  return draft.invoice.id;
}

/** An issued NPR manual tax invoice of two equal lines: 2 x 500.00 + 2 x 500.00 at VAT 13% = 2,260.00. */
async function issuedTwoLineInvoice(): Promise<string> {
  as(U.acc, 'accountant');
  const line = (description: string) => ({
    description,
    uom: 'day',
    quantity: '2',
    unitPrice: '500.00',
    taxCodeId: f.taxCodeVat13Id,
  });
  const draft = await drafting.draftManual(
    {
      customerId: f.customerPartyId,
      currency: 'NPR',
      manualReason: 'Two equal lines',
      lines: [line('Design'), line('Build')],
    },
    key(),
  );
  await forceApproved(draft.invoice.id);
  await issueAs(draft.invoice.id);
  return draft.invoice.id;
}

/** An approved credit note on `original` for `quantity` of each listed original line (default: line 1). */
async function approvedCredit(
  original: string,
  lines: { originalLineNo: number; quantity: string }[],
): Promise<string> {
  as(U.fin, 'finance');
  const drafted = await notes.draftCreditNote(
    { originalInvoiceId: original, reason: 'Not delivered', lines },
    key(),
  );
  await forceApproved(drafted.invoice.id);
  return drafted.invoice.id;
}

/** A confirmed NPR order (30 credit days) whose billable 40% advance line is 2,018,180.00. */
async function seedOrder(): Promise<{ salesOrderId: string; advanceId: string }> {
  soSeq += 1;
  const scope = scopeA;
  return withTx(db, scope, systemActor('cn-fixture'), async (tx) => {
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

/** A verified NPR payment of `amount` from the fixture customer (recorded by U.fin, verified by U.fin2). */
async function verifiedPayment(amount: string): Promise<string> {
  const recorder = userActor(U.fin);
  const documentId = randomUUID();
  const versionId = randomUUID();
  await withTx(db, scopeA, recorder, async (tx) => {
    await tx.insert(documents).values({
      id: documentId,
      tenantId: scopeA.tenantId,
      organizationId: scopeA.organizationId,
      ownerType: PAYMENT_INTAKE_OWNER_TYPE,
      ownerId: f.customerPartyId,
      createdBy: U.fin,
    });
    await tx.insert(documentVersions).values({
      id: versionId,
      tenantId: scopeA.tenantId,
      organizationId: scopeA.organizationId,
      documentId,
      version: 1,
      filename: 'slip.pdf',
      declaredMime: 'application/pdf',
      sizeBytes: 1000,
      storageKey: `${scopeA.tenantId}/${versionId}`,
      status: 'clean',
      uploadedBy: U.fin,
    });
  });
  const p = await payments.submit(
    scopeA,
    recorder,
    {
      customerId: f.customerPartyId,
      currency: 'NPR',
      amount,
      tdsWithheld: '0.00',
      method: 'bank_transfer',
      receivedOn: '2026-11-08',
      proofDocumentIds: [documentId],
    },
    'staff',
    randomUUID(),
  );
  await payments.verify(scopeA, userActor(U.fin2), p.id, { expectedVersion: 1 }, randomUUID());
  return p.id;
}

/** Allocates `amount` of `paymentId` to `invoiceId` in its own command (so allocations get distinct created_at). */
async function allocate(paymentId: string, invoiceId: string, amount: string): Promise<void> {
  await allocations.allocate(
    scopeA,
    userActor(U.fin2),
    paymentId,
    { lines: [{ invoiceId, amount }] },
    randomUUID(),
  );
}

async function settlementOf(invoiceId: string) {
  const rows = await receivables.statement(scopeA, f.customerPartyId, {});
  const row = rows.find((r) => r.invoiceId === invoiceId);
  if (row === undefined) throw new Error(`invoice ${invoiceId} is not on the statement`);
  return row;
}

/** The customer's NPR advance (unallocated verified payment credit). */
async function advanceNpr(): Promise<string> {
  const rows = await receivables.advance(scopeA, f.customerPartyId);
  return rows.find((r) => r.currency === 'NPR')?.amount ?? '0.00';
}

const itemOf = async (sourceId: string) =>
  db.select().from(openItems).where(eq(openItems.sourceId, sourceId));

async function paymentItemId(paymentId: string): Promise<string> {
  const [item] = await itemOf(paymentId);
  return item!.id;
}

/** Reversal rows of the allocations from `creditItemId` (the payment) on any item. */
const reversalsFrom = async (creditItemId: string) =>
  db
    .select()
    .from(openItemAllocations)
    .where(
      and(eq(openItemAllocations.creditItemId, creditItemId), lt(openItemAllocations.amount, '0')),
    );

/** No open item of entity A has gone below 0. */
async function expectNoNegativeOpenAmount(): Promise<void> {
  const negative = await db
    .select({ id: openItemBalances.openItemId })
    .from(openItemBalances)
    .where(
      and(
        eq(openItemBalances.organizationId, scopeA.organizationId),
        lt(openItemBalances.openAmount, '0'),
      ),
    );
  expect(negative).toEqual([]);
}

/** Runs the real ErrorBodyFilter on `exception` with fake Express objects; returns the status and body sent. */
function httpOf(exception: unknown): { status?: number; body?: unknown } {
  const out: { status?: number; body?: unknown } = {};
  const req = { method: 'POST', path: '/v1/credit-notes', headers: {}, correlationId: undefined };
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
  new ErrorBodyFilter().catch(exception, host);
  return out;
}

beforeAll(async () => {
  testDb = await createTestDatabase();
  const admin0 = new Pool({ connectionString: testDb.adminUrl, max: 1 });
  await admin0.end();
  const bosAdmin = new Pool({ connectionString: testDb.adminUrl, max: 1 });
  await bosAdmin.end();

  ownerPool = new Pool({ connectionString: testDb.ownerUrl, max: 2 });
  appPool = new Pool({ connectionString: testDb.appUrl, max: 12 });
  appPool.on('error', () => undefined);
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
  U.fin = await staff('finance');
  U.fin2 = await staff('finance');

  const audit = new AuditService(db);
  const ledger = new LedgerService();
  drafting = new InvoiceDraftingService(db, authz, audit, caller, ledger, currencies, () => NOW);
  issuing = new InvoiceIssueService(
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
  notes = new NoteDraftingService(db, authz, audit, caller, ledger, drafting, () => NOW);
  const fxSettings = { get: () => Promise.resolve(7) } as unknown as SettingsService;
  payments = new PaymentsService(
    db,
    passAuthz,
    new MoneyService(db, fxSettings),
    new NumberingService(),
    audit,
    ledger,
    () => NOW,
  );
  allocations = new AllocationsService(db, passAuthz, audit, ledger);
  receivables = new ReceivablesService(db, passAuthz, () => NOW);
});

afterAll(async () => {
  await appPool?.end();
  await ownerPool?.end();
  await testDb?.drop();
});

describe('credit-note issue: settlement and release (done checks 7 and 8)', () => {
  it('a partial credit lowers the open amount; the credit that completes it releases the payment as advance and reads credited', async () => {
    const original = await issuedInvoice();
    const payment = await verifiedPayment('500.00');
    await allocate(payment, original, '500.00');
    expect(await settlementOf(original)).toMatchObject({
      openAmount: '630.00',
      settlement: 'partly_paid',
    });
    const advanceBefore = Number(await advanceNpr());

    // 1 day of 4: 282.50. 630.00 is open, so nothing is released.
    const first = await approvedCredit(original, [{ originalLineNo: 1, quantity: '1' }]);
    const issued = await issueAs(first);
    expect(issued).toMatchObject({ kind: 'issued', invoiceId: first });
    expect(issued.number).toMatch(CN_NUMBER);
    const note = await invoiceRow(first);
    expect(note).toMatchObject({ status: 'issued', fxRate: '1.000000', amountNpr: '282.50' });
    expect(await settlementOf(original)).toMatchObject({
      openAmount: '347.50',
      allocatedAmount: '500.00',
      settlement: 'partly_paid',
    });
    const [credit] = await itemOf(first);
    expect(credit).toMatchObject({
      side: 'receivable',
      direction: 'credit',
      sourceType: 'credit_note',
      amount: '282.50',
    });
    expect((await reversalsFrom(await paymentItemId(payment))).length).toBe(0);
    expect((await invoiceRow(original)).creditedInFullAt).toBeNull();

    // The other 3 days: 847.50, but only 347.50 is open, so the 500.00 payment allocation is released.
    const second = await approvedCredit(original, [{ originalLineNo: 1, quantity: '3' }]);
    const done = await issueAs(second);
    const reversals = await reversalsFrom(await paymentItemId(payment));
    expect(reversals).toHaveLength(1);
    expect(reversals[0]).toMatchObject({ amount: '-500.00', reason: `credit note ${done.number}` });
    expect(await settlementOf(original)).toMatchObject({
      openAmount: '0.00',
      allocatedAmount: '0.00',
      settlement: 'credited',
    });
    expect(Number(await advanceNpr())).toBeCloseTo(advanceBefore + 500, 2);
    expect((await invoiceRow(original)).creditedInFullAt).not.toBeNull();
    await expectNoNegativeOpenAmount();
  });

  it('a partial credit that covers what is left open flips partly_paid to paid and releases nothing', async () => {
    const original = await issuedInvoice();
    const payment = await verifiedPayment('847.50');
    await allocate(payment, original, '847.50');
    expect(await settlementOf(original)).toMatchObject({
      openAmount: '282.50',
      settlement: 'partly_paid',
    });
    const note = await approvedCredit(original, [{ originalLineNo: 1, quantity: '1' }]);
    await issueAs(note);
    expect(await settlementOf(original)).toMatchObject({ openAmount: '0.00', settlement: 'paid' });
    expect(await reversalsFrom(await paymentItemId(payment))).toHaveLength(0);
    await expectNoNegativeOpenAmount();
  });

  it('a partial credit on a fully paid invoice releases the newest payment only, re-allocates what it did not need and stays paid', async () => {
    const original = await issuedInvoice();
    const older = await verifiedPayment('600.00');
    const newer = await verifiedPayment('530.00');
    await allocate(older, original, '600.00');
    await allocate(newer, original, '530.00');
    expect(await settlementOf(original)).toMatchObject({ openAmount: '0.00', settlement: 'paid' });
    const advanceBefore = Number(await advanceNpr());

    const note = await approvedCredit(original, [{ originalLineNo: 1, quantity: '1' }]);
    await issueAs(note);

    expect(await reversalsFrom(await paymentItemId(older))).toHaveLength(0);
    expect(await reversalsFrom(await paymentItemId(newer))).toHaveLength(1);
    expect(await settlementOf(original)).toMatchObject({
      openAmount: '0.00',
      allocatedAmount: '847.50',
      settlement: 'paid',
    });
    // Only the credited 282.50 came back as advance: 530.00 released, 247.50 allocated back.
    expect(Number(await advanceNpr())).toBeCloseTo(advanceBefore + 282.5, 2);
    const newerOpen = await db
      .select({ open: openItemBalances.openAmount })
      .from(openItemBalances)
      .where(eq(openItemBalances.openItemId, await paymentItemId(newer)));
    expect(newerOpen[0]!.open).toBe('282.50');
    await expectNoNegativeOpenAmount();
  });

  it('a full credit after two payments releases both, gives the schedule line back and a new tax invoice drafts on it (no G4)', async () => {
    const { advanceId } = await seedOrder();
    as(U.acc, 'accountant');
    const draft = (await drafting.draftFromSchedule({ scheduleLineId: advanceId }, key())).invoice;
    await forceApproved(draft.id);
    await issueAs(draft.id);
    const original = draft.id;
    expect((await invoiceRow(original)).total).toBe('2018180.00');
    const p1 = await verifiedPayment('1000000.00');
    const p2 = await verifiedPayment('500000.00');
    await allocate(p1, original, '1000000.00');
    await allocate(p2, original, '500000.00');
    const advanceBefore = Number(await advanceNpr());

    const lines = await db
      .select({ lineNo: invoiceLines.lineNo, quantity: invoiceLines.quantity })
      .from(invoiceLines)
      .where(eq(invoiceLines.invoiceId, original))
      .orderBy(asc(invoiceLines.lineNo));
    const note = await approvedCredit(
      original,
      lines.map((l) => ({ originalLineNo: l.lineNo, quantity: l.quantity })),
    );
    expect((await invoiceRow(note)).total).toBe('2018180.00');
    const done = await issueAs(note);

    for (const p of [p1, p2]) {
      const reversals = await reversalsFrom(await paymentItemId(p));
      expect(reversals).toHaveLength(1);
      expect(reversals[0]!.reason).toBe(`credit note ${done.number}`);
    }
    expect(Number(await advanceNpr())).toBeCloseTo(advanceBefore + 1_500_000, 2);
    expect(await settlementOf(original)).toMatchObject({
      openAmount: '0.00',
      settlement: 'credited',
    });
    const marked = await invoiceRow(original);
    expect(marked.status).toBe('issued');
    expect(marked.creditedInFullAt).not.toBeNull();
    const [line] = await db
      .select()
      .from(billingScheduleLines)
      .where(eq(billingScheduleLines.id, advanceId));
    expect(line).toMatchObject({ status: 'billable', invoiceId: null });

    as(U.acc, 'accountant');
    const again = (await drafting.draftFromSchedule({ scheduleLineId: advanceId }, key())).invoice;
    expect(again.id).not.toBe(original);
    expect((await invoiceRow(again.id)).status).toBe('draft');
    await expectNoNegativeOpenAmount();
  });
});

describe('credit-note issue: credited in full means every line (U12D)', () => {
  it('a full credit split over one note per line marks the original only when the second, completing note issues', async () => {
    const original = await issuedTwoLineInvoice();
    const first = await approvedCredit(original, [{ originalLineNo: 1, quantity: '2' }]);
    await issueAs(first);
    expect((await invoiceRow(original)).creditedInFullAt).toBeNull();

    const second = await approvedCredit(original, [{ originalLineNo: 2, quantity: '2' }]);
    await issueAs(second);
    expect((await invoiceRow(original)).creditedInFullAt).not.toBeNull();
    expect(await settlementOf(original)).toMatchObject({
      openAmount: '0.00',
      settlement: 'credited',
    });
    await expectNoNegativeOpenAmount();
  });

  it('issue rechecks the line cap: a note that reached line 1 past the draft check is refused, and the original is not marked though the totals match', async () => {
    const original = await issuedTwoLineInvoice();
    const [firstLine] = await db
      .select({ id: invoiceLines.id })
      .from(invoiceLines)
      .where(and(eq(invoiceLines.invoiceId, original), eq(invoiceLines.lineNo, 1)));
    await issueAs(await approvedCredit(original, [{ originalLineNo: 1, quantity: '2' }]));

    // A second note drafted on line 2, then (while still a draft, as a writer that skipped the service would) pointed
    // at line 1. Its total equals what is left of the original's total, so only the per-line recheck at issue sees it.
    as(U.fin, 'finance');
    const drafted = await notes.draftCreditNote(
      {
        originalInvoiceId: original,
        reason: 'Not delivered',
        lines: [{ originalLineNo: 2, quantity: '2' }],
      },
      key(),
    );
    const rogue = drafted.invoice.id;
    await withTx(db, scopeA, systemActor('cn-fixture'), (tx) =>
      tx.execute(
        sql`UPDATE app.invoice_lines SET original_line_id = ${firstLine!.id} WHERE invoice_id = ${rogue}`,
      ),
    );
    await forceApproved(rogue);

    const err = await issueAs(rogue).catch((e: unknown) => e);
    expect((err as HttpException).getStatus()).toBe(409);
    expect((err as HttpException).getResponse()).toMatchObject({
      code: 'CREDIT_EXCEEDS_INVOICE',
      details: { originalLineNo: 1 },
    });
    expect((await invoiceRow(rogue)).status).toBe('approved');
    expect((await invoiceRow(original)).creditedInFullAt).toBeNull();
    expect(await itemOf(rogue)).toHaveLength(0);
  });
});

describe('credit-note issue: replay, entity and HTTP', () => {
  it('five parallel issues of one note: one CN number, one credit item, one credit_note_issued event', async () => {
    const original = await issuedInvoice();
    const note = await approvedCredit(original, [{ originalLineNo: 1, quantity: '2' }]);
    const version = (await invoiceRow(note)).version;
    as(U.fin2, 'finance');
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        issuing
          .issue(note, { expectedVersion: version }, key())
          .then((r) => IssueInvoiceResultSchema.parse(r)),
      ),
    );
    expect(results.filter((r) => r.kind === 'issued')).toHaveLength(1);
    expect(results.filter((r) => r.kind === 'already_issued')).toHaveLength(4);
    expect(new Set(results.map((r) => r.number)).size).toBe(1);
    expect(results[0]!.number).toMatch(CN_NUMBER);
    expect(await itemOf(note)).toHaveLength(1);
    const events = await db
      .select({ event: postingEvents.event })
      .from(postingEvents)
      .where(eq(postingEvents.sourceId, note));
    expect(events.map((e) => e.event)).toEqual(['credit_note_issued']);
    const [credit] = await itemOf(note);
    const allocated = await db
      .select()
      .from(openItemAllocations)
      .where(inArray(openItemAllocations.creditItemId, [credit!.id]));
    expect(allocated).toHaveLength(1);
    expect(allocated[0]!.amount).toBe('565.00');
    // A later call with another key answers already_issued with the same number.
    expect(await issueAs(note)).toEqual({
      kind: 'already_issued',
      invoiceId: note,
      number: results[0]!.number,
    });
    expect(await settlementOf(original)).toMatchObject({ openAmount: '565.00' });
  });

  it('a credit note of another entity is a 404 and nothing is issued', async () => {
    const original = await issuedInvoice();
    const note = await approvedCredit(original, [{ originalLineNo: 1, quantity: '1' }]);
    current.scope = scopeB;
    try {
      as(U.fin2, 'finance');
      const err = await issuing
        .issue(note, { expectedVersion: (await invoiceRow(note)).version }, key())
        .catch((e: unknown) => e);
      expect(statusOf(err)).toBe(404);
    } finally {
      current.scope = null;
    }
    expect((await invoiceRow(note)).status).toBe('approved');
    expect(await itemOf(note)).toHaveLength(0);
  });

  it('409 CREDIT_EXCEEDS_INVOICE reaches the HTTP body with its code', async () => {
    const original = await issuedInvoice();
    const note = await approvedCredit(original, [{ originalLineNo: 1, quantity: '3' }]);
    await issueAs(note);
    as(U.fin, 'finance');
    const err = await notes
      .draftCreditNote(
        {
          originalInvoiceId: original,
          reason: 'Too much',
          lines: [{ originalLineNo: 1, quantity: '2' }],
        },
        key(),
      )
      .catch((e: unknown) => e);
    const http = httpOf(err);
    expect(http.status).toBe(409);
    expect(ErrorBodySchema.parse(http.body).error.code).toBe('CREDIT_EXCEEDS_INVOICE');
  });
});
