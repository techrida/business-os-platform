// Integration tests of credit-note and debit-note drafting (P3 unit U12 part B) on a real Postgres (Testcontainers, needs
// Docker in WSL). Real: migrations as bos_owner, queries as bos_app (every CHECK and the deferred invoices_notes trigger
// of 0021 run), the approvals engine with the seed's tax_invoice, credit_note and debit_note workflows, the invoice and
// note services, NumberingService, LedgerService and AuditService. Faked: the request context, authz.assert (the real
// pure can() on a fake principal), notify, the role directory, MoneyService (NPR at 1) and the entity settings.
// Covers done check 7 (credit cap in the service, two concurrent credits, and the trigger's 23514 at commit mapped), the
// cross-entity 404, self-approval refused on a note (U6 subject) and a debit note issued end to end.
// Run: pnpm --filter @bos/api exec vitest run src/modules/invoices/notes/notes.integration.test.ts
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
import {
  approvalRequests,
  createStaffUser,
  invoiceLines,
  invoices,
  invoiceTaxSummary,
  openItems,
  postingEvents,
  users,
} from '@bos/db';
import { ForbiddenException, HttpException } from '@nestjs/common';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { AuditService } from '../../../platform/audit/audit.service';
import type { AuthzService } from '../../../platform/authz/authz.service';
import { can } from '../../../platform/authz/can';
import type { Principal } from '../../../platform/authz/principal';
import { systemActor, withTx, type TxScope } from '../../../platform/db/tx';
import type { MoneyService } from '../../../platform/settings/money.service';
import { NumberingService } from '../../../platform/settings/numbering.service';
import type { CurrencyEnabledService } from '../../../platform/settings/currency-enabled';
import type { SettingsService } from '../../../platform/settings/settings.service';
import { ApprovalsAdminService } from '../../approvals/admin.service';
import { asSecondPerson, SKIP_LIVE_PUBLISHER_CHECK } from '../../../../test/support/second-person';
import type { ApprovalsNotify } from '../../approvals/ports';
import { ApprovalsService } from '../../approvals/requests.service';
import { LedgerService } from '../../ledger/ledger.service';
import {
  seedQuotationFixture,
  type QuotationFixture,
  type QuotationFixtureDb,
} from '../../quotations/drafting/quotation.fixture';
import { InvoiceApprovalService, InvoiceApprovalSubject } from '../invoice-approval.service';
import { InvoiceDraftingService } from '../invoice-drafting.service';
import { InvoiceIssueService } from '../invoice-issue.service';
import { NoteDraftingService } from './note-drafting.service';
import { createTestDatabase, type TestDatabase } from '@bos/db/testing';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 180_000 });

/** 2026-11-09 11:45 in Kathmandu: BS 2083-07-23, fiscal year 2083/84. */
const NOW = new Date('2026-11-09T06:00:00Z');

// The seed's invoiceApprovalSpec (tools/seed-zitadel/src/db-seed.ts), one per approvable type; keep the two in step.
// The seed's tax_invoice route now depends on the source (F1-Q30); these tests never submit a tax invoice.
const approvalSpec = (documentType: string, what: string): unknown => ({
  documentType,
  steps: [
    {
      id: 'accountant',
      kind: 'role',
      role: 'accountant',
      reason: `Base route: accountant checks the ${what}`,
    },
    { id: 'finance', kind: 'role', role: 'finance', reason: 'Base route: finance approves' },
  ],
  rules: [],
  distinctApprovers: true,
  sla: { remindAfterHours: 24, escalateAfterHours: 72, escalateTo: { role: 'founder' } },
});
const WORKFLOWS = [
  ['tax_invoice', 'Tax invoice', 'tax invoice'],
  ['credit_note', 'Credit note', 'credit note'],
  ['debit_note', 'Debit note', 'debit note'],
] as const;

let testDb: TestDatabase;
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
let notes: NoteDraftingService;
let audit: AuditService;

/** Real staff users of entity A: two accountants, two finance users (a note drafter and a checker), and the admin. */
const U = { acc: '', acc2: '', fin: '', fin2: '', admin: '' };
const roles: Partial<Record<RoleKey, string[]>> = {};

const grantsOf = (role: RoleKey) =>
  new Map(Object.entries(DEFAULT_ROLE_PERMISSIONS[role])) as Map<Permission, Scope>;
const current: {
  userId: string;
  role: RoleKey;
  scope: TxScope | null;
  /** Live grants an admin edited, instead of the role default (`as` clears it). */
  grants?: Map<Permission, Scope> | undefined;
} = {
  userId: '',
  role: 'accountant',
  scope: null,
};
const as = (userId: string, role: RoleKey) => {
  current.userId = userId;
  current.role = role;
  current.grants = undefined;
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
const responseOf = (e: unknown): unknown => (e as HttpException).getResponse();
const statusOf = (e: unknown): number => (e as HttpException).getStatus();
const invoiceRow = async (id: string) =>
  (await db.select().from(invoices).where(eq(invoices.id, id)))[0]!;

/** An issued NPR tax invoice: 4 x 250.00 at VAT 13% = 1,130.00 (drafted by U.acc, issued by U.fin). */
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
  const id = draft.invoice.id;
  await withTx(db, scopeA, systemActor('note-fixture'), (tx) =>
    tx.execute(
      sql`UPDATE app.invoices SET status = 'approved', version = version + 1 WHERE id = ${id}`,
    ),
  );
  as(U.fin, 'finance');
  await issuing.issue(id, { expectedVersion: (await invoiceRow(id)).version }, key());
  expect((await invoiceRow(id)).status).toBe('issued');
  return id;
}

interface TypedLine {
  description: string;
  uom: string;
  quantity: string;
  unitPrice: string;
  taxCodeId: string;
}
const typedLine = (description: string, quantity: string, unitPrice: string, taxCodeId: string) =>
  ({ description, uom: 'unit', quantity, unitPrice, taxCodeId }) satisfies TypedLine;

/** An issued NPR manual tax invoice with `lines` (drafted by U.acc, issued by U.fin). */
async function issuedInvoiceOf(lines: TypedLine[]): Promise<string> {
  as(U.acc, 'accountant');
  const draft = await drafting.draftManual(
    { customerId: f.customerPartyId, currency: 'NPR', manualReason: 'Several lines', lines },
    key(),
  );
  const id = draft.invoice.id;
  await withTx(db, scopeA, systemActor('note-fixture'), (tx) =>
    tx.execute(
      sql`UPDATE app.invoices SET status = 'approved', version = version + 1 WHERE id = ${id}`,
    ),
  );
  as(U.fin, 'finance');
  await issuing.issue(id, { expectedVersion: (await invoiceRow(id)).version }, key());
  return id;
}

/** Drafts a credit note on `originalId` for `quantity` of each listed original line. */
async function creditLines(
  originalId: string,
  lines: { originalLineNo: number; quantity: string }[],
): Promise<InvoiceDetail> {
  as(U.fin, 'finance');
  return notes.draftCreditNote({ originalInvoiceId: originalId, reason: 'Returned', lines }, key());
}

const linesOf = async (invoiceId: string) =>
  db
    .select()
    .from(invoiceLines)
    .where(eq(invoiceLines.invoiceId, invoiceId))
    .orderBy(asc(invoiceLines.lineNo));

/** The tax summary rows of `invoiceIds` on `taxCodeId`, summed: base and tax as numbers of paisa. */
async function codeTotals(invoiceIds: string[], taxCodeId: string) {
  const rows = await db
    .select({ base: invoiceTaxSummary.base, tax: invoiceTaxSummary.tax })
    .from(invoiceTaxSummary)
    .where(
      and(
        inArray(invoiceTaxSummary.invoiceId, invoiceIds),
        eq(invoiceTaxSummary.taxCodeId, taxCodeId),
      ),
    );
  const paisa = (v: string) => Math.round(Number(v) * 100);
  return {
    base: rows.reduce((a, r) => a + paisa(r.base), 0),
    tax: rows.reduce((a, r) => a + paisa(r.tax), 0),
  };
}

const creditBody = (originalInvoiceId: string, quantity: string) => ({
  originalInvoiceId,
  reason: 'Two days were not delivered',
  lines: [{ originalLineNo: 1, quantity }],
});
const debitBody = (originalInvoiceId: string) => ({
  originalInvoiceId,
  reason: 'Extra day of support',
  lines: [
    {
      description: 'Extra support',
      uom: 'day',
      quantity: '1',
      unitPrice: '100.00',
      taxCodeId: f.taxCodeVat13Id,
    },
  ],
});

async function credit(originalId: string, quantity: string, svc = notes): Promise<InvoiceDetail> {
  as(U.fin, 'finance');
  return svc.draftCreditNote(creditBody(originalId, quantity), key());
}

const liveCreditNotes = async (originalId: string) =>
  db
    .select({ id: invoices.id, total: invoices.total })
    .from(invoices)
    .where(and(eq(invoices.originalInvoiceId, originalId), eq(invoices.kind, 'credit_note')));

const requestOf = async (kind: string, invoiceId: string) =>
  (
    await db
      .select()
      .from(approvalRequests)
      .where(
        and(eq(approvalRequests.documentType, kind), eq(approvalRequests.documentId, invoiceId)),
      )
  )[0];

async function submit(id: string, userId: string, role: RoleKey): Promise<void> {
  as(userId, role);
  await submitting.submit(id, { expectedVersion: (await invoiceRow(id)).version }, key());
}

async function act(user: string, role: RoleKey, requestId: string): Promise<void> {
  const [r] = await db
    .select({ version: approvalRequests.version })
    .from(approvalRequests)
    .where(eq(approvalRequests.id, requestId));
  as(user, role);
  await approvals.act(requestId, { action: 'approve', expectedVersion: r!.version }, randomUUID());
}

beforeAll(async () => {
  testDb = await createTestDatabase();
  const admin0 = new Pool({ connectionString: testDb.adminUrl, max: 1 });
  await admin0.end();
  const bosAdmin = new Pool({ connectionString: testDb.adminUrl, max: 1 });
  await bosAdmin.end();

  ownerPool = new Pool({ connectionString: testDb.ownerUrl, max: 2 });
  appPool = new Pool({ connectionString: testDb.appUrl, max: 10 });
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
  U.fin2 = await staff('finance');
  U.admin = await staff('founder');
  roles.accountant = [U.acc, U.acc2];
  roles.finance = [U.fin, U.fin2];
  roles.founder = [U.admin];

  audit = new AuditService(db);
  as(U.admin, 'founder');
  const admin = new ApprovalsAdminService(db, audit, caller, () => NOW);
  const adminPublisher = new ApprovalsAdminService(db, audit, asSecondPerson(caller), () => NOW);
  approvals = new ApprovalsService(db, audit, notify, directory, caller, () => NOW);
  for (const [type, name, what] of WORKFLOWS) {
    await admin.createWorkflow({ key: type, name, spec: approvalSpec(type, what) });
    await adminPublisher.publish(type, 1, SKIP_LIVE_PUBLISHER_CHECK);
    approvals.registerSubject(new InvoiceApprovalSubject(type, () => NOW));
  }
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
  notes = new NoteDraftingService(db, authz, audit, caller, ledger, drafting, () => NOW);
});

afterAll(async () => {
  await appPool?.end();
  await ownerPool?.end();
  await testDb?.drop();
});

describe('credit notes: the credit cap (done check 7)', () => {
  it('drafts a partial credit priced from the original, then refuses a credit over what is left', async () => {
    const original = await issuedInvoice();
    const k = key();
    as(U.fin, 'finance');
    const first = await notes.draftCreditNote(creditBody(original, '3'), k);
    expect(first.invoice).toMatchObject({
      kind: 'credit_note',
      status: 'draft',
      number: null,
      originalInvoiceId: original,
      noteReason: 'Two days were not delivered',
      customerId: f.customerPartyId,
      currency: 'NPR',
    });
    expect(first.invoice.totals).toMatchObject({
      taxableAmount: '750.00',
      taxAmount: '97.50',
      total: '847.50',
    });
    expect(first.lines).toEqual([
      expect.objectContaining({
        lineNo: 1,
        quantity: '3.0000',
        unitPrice: '250.00',
        taxable: '750.00',
      }),
    ]);
    // A replay with the same key gives the same note, not a second one.
    expect((await notes.draftCreditNote(creditBody(original, '3'), k)).invoice.id).toBe(
      first.invoice.id,
    );

    // 282.50 is left; two more days (565.00) is over it.
    const err = await credit(original, '2').catch((e: unknown) => e);
    expect(statusOf(err)).toBe(409);
    expect(responseOf(err)).toMatchObject({ code: 'CREDIT_EXCEEDS_INVOICE' });
    expect(await liveCreditNotes(original)).toHaveLength(1);
  });

  it('refuses a quantity above the original line (400) and an original that is not issued (409)', async () => {
    const original = await issuedInvoice();
    const over = await credit(original, '5').catch((e: unknown) => e);
    expect(statusOf(over)).toBe(400);

    as(U.acc, 'accountant');
    const draft = await drafting.draftManual(
      {
        customerId: f.customerPartyId,
        currency: 'NPR',
        manualReason: 'Not issued yet',
        lines: [
          {
            description: 'X',
            uom: 'lot',
            quantity: '1',
            unitPrice: '10.00',
            taxCodeId: f.taxCodeVat13Id,
          },
        ],
      },
      key(),
    );
    const notIssued = await credit(draft.invoice.id, '1').catch((e: unknown) => e);
    expect(statusOf(notIssued)).toBe(409);
  });

  it('two concurrent 3-day credits on one invoice: one note, one CREDIT_EXCEEDS_INVOICE', async () => {
    const original = await issuedInvoice();
    const results = await Promise.allSettled([credit(original, '3'), credit(original, '3')]);
    const ok = results.filter((r) => r.status === 'fulfilled');
    const refused = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(ok).toHaveLength(1);
    expect(refused).toHaveLength(1);
    expect(responseOf(refused[0]!.reason)).toMatchObject({ code: 'CREDIT_EXCEEDS_INVOICE' });
    expect(await liveCreditNotes(original)).toHaveLength(1);
  });

  it('the deferred trigger is the backstop: its 23514 at commit answers CREDIT_EXCEEDS_INVOICE', async () => {
    const original = await issuedInvoice();
    // The service check passes (3 days = 847.50 of 1,130.00). Then, in the same transaction and before commit, a second
    // 847.50 credit row on the same original appears (as a concurrent writer that skipped the service would add it),
    // so only the deferred invoices_notes trigger can catch the excess: its 23514 at commit maps to the same 409.
    // (Two real concurrent inserts cannot be staged here: the tenant audit lock serialises them.)
    const held = new InvoiceDraftingService(
      db,
      authz,
      audit,
      caller,
      new LedgerService(),
      currencies,
      () => NOW,
    );
    const realLoad = held.loadDetail.bind(held);
    vi.spyOn(held, 'loadDetail').mockImplementation(async (tx, scope, id) => {
      await tx.execute(
        sql`INSERT INTO app.invoices (tenant_id, organization_id, kind, status, customer_party_id, original_invoice_id,
              note_reason, currency, subtotal, taxable_vat_amount, tax_amount, total)
            VALUES (${scope.tenantId}, ${scope.organizationId}, 'credit_note', 'draft', ${f.customerPartyId},
              ${original}, 'Written past the service', 'NPR', 750.00, 750.00, 97.50, 847.50)`,
      );
      return realLoad(tx, scope, id);
    });
    const noPrecheck = new NoteDraftingService(
      db,
      authz,
      audit,
      caller,
      new LedgerService(),
      held,
      () => NOW,
    );
    const err = await credit(original, '3', noPrecheck).catch((e: unknown) => e);
    expect(held.loadDetail).toHaveBeenCalledTimes(1);
    expect(statusOf(err)).toBe(409);
    expect(responseOf(err)).toMatchObject({ code: 'CREDIT_EXCEEDS_INVOICE' });
    // The whole transaction rolled back: neither row is there.
    expect(await liveCreditNotes(original)).toHaveLength(0);
  });
});

describe('credit notes: the cap per original line and per tax code (U12D)', () => {
  it('two notes each crediting line 1 in full: the second is refused naming the line, and line 2 can still be credited', async () => {
    // 2 x 500.00 + 2 x 500.00 at VAT 13% = 2,260.00; line 1 alone is 1,130.00, exactly half, so the total cap alone
    // would let line 1 be credited twice.
    const original = await issuedInvoiceOf([
      typedLine('Design', '2', '500.00', f.taxCodeVat13Id),
      typedLine('Build', '2', '500.00', f.taxCodeVat13Id),
    ]);
    const [firstLine, secondLine] = await linesOf(original);

    const first = await creditLines(original, [{ originalLineNo: 1, quantity: '2' }]);
    expect(first.invoice.totals).toMatchObject({ total: '1130.00' });
    expect((await linesOf(first.invoice.id)).map((l) => l.originalLineId)).toEqual([firstLine!.id]);

    for (const quantity of ['2', '1']) {
      const err = await creditLines(original, [{ originalLineNo: 1, quantity }]).catch(
        (e: unknown) => e,
      );
      expect(statusOf(err)).toBe(409);
      expect(responseOf(err)).toMatchObject({
        code: 'CREDIT_EXCEEDS_INVOICE',
        details: { originalLineNo: 1, remainingQuantity: '0.0000' },
      });
    }
    expect(await liveCreditNotes(original)).toHaveLength(1);

    const second = await creditLines(original, [{ originalLineNo: 2, quantity: '2' }]);
    expect(second.invoice.totals).toMatchObject({ total: '1130.00' });
    expect((await linesOf(second.invoice.id)).map((l) => l.originalLineId)).toEqual([
      secondLine!.id,
    ]);
    expect(await liveCreditNotes(original)).toHaveLength(2);
  });

  it('a discarded note frees its line again', async () => {
    const original = await issuedInvoiceOf([
      typedLine('Design', '2', '500.00', f.taxCodeVat13Id),
      typedLine('Build', '2', '500.00', f.taxCodeVat13Id),
    ]);
    const first = await creditLines(original, [{ originalLineNo: 1, quantity: '2' }]);
    await withTx(db, scopeA, systemActor('note-fixture'), (tx) =>
      tx.execute(
        sql`UPDATE app.invoices SET status = 'discarded', discarded_at = now(), version = version + 1 WHERE id = ${first.invoice.id}`,
      ),
    );
    const again = await creditLines(original, [{ originalLineNo: 1, quantity: '2' }]);
    expect(again.invoice.totals).toMatchObject({ total: '1130.00' });
  });

  it('on a two-code invoice the VAT credited on a code across notes never exceeds the VAT charged on it', async () => {
    // VAT 13% on 3 x 0.05 = 0.15 charges 0.02 (0.0195 half up). Each one-unit credit is a third of the bucket: 0.01 of
    // VAT, half up, so three of them would credit 0.03 of a 0.02 VAT. The large exempt line keeps the total cap far away.
    const original = await issuedInvoiceOf([
      typedLine('Cable', '3', '0.05', f.taxCodeVat13Id),
      typedLine('Training', '1', '1000.00', f.taxCodeExemptId),
    ]);
    expect(await codeTotals([original], f.taxCodeVat13Id)).toEqual({ base: 15, tax: 2 });

    const noteIds: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      noteIds.push(
        (await creditLines(original, [{ originalLineNo: 1, quantity: '1' }])).invoice.id,
      );
    }
    expect(await codeTotals(noteIds, f.taxCodeVat13Id)).toEqual({ base: 15, tax: 2 });

    const err = await creditLines(original, [{ originalLineNo: 1, quantity: '1' }]).catch(
      (e: unknown) => e,
    );
    expect(statusOf(err)).toBe(409);
    expect(responseOf(err)).toMatchObject({ code: 'CREDIT_EXCEEDS_INVOICE' });

    // The exempt line is untouched by all of it and is credited in full.
    const exempt = await creditLines(original, [{ originalLineNo: 2, quantity: '1' }]);
    expect(exempt.invoice.totals).toMatchObject({ total: '1000.00' });
    expect(await codeTotals([exempt.invoice.id], f.taxCodeExemptId)).toEqual({
      base: 100000,
      tax: 0,
    });
  });
});

describe('notes outside the entity and approval', () => {
  it('a source invoice of another entity is a 404 for both notes', async () => {
    const original = await issuedInvoice();
    current.scope = scopeB;
    try {
      const e1 = await credit(original, '1').catch((e: unknown) => e);
      expect(statusOf(e1)).toBe(404);
      as(U.fin, 'finance');
      const e2 = await notes.draftDebitNote(debitBody(original), key()).catch((e: unknown) => e);
      expect(statusOf(e2)).toBe(404);
    } finally {
      current.scope = null;
    }
    expect(await liveCreditNotes(original)).toHaveLength(0);
  });

  it('the drafter of a credit note cannot approve it (U6 subject)', async () => {
    const original = await issuedInvoice();
    const note = (await credit(original, '1')).invoice.id;
    await submit(note, U.fin, 'finance');
    const request = await requestOf('credit_note', note);
    expect(request).toBeDefined();
    await act(U.acc2, 'accountant', request!.id);
    const err = await act(U.fin, 'finance', request!.id).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ForbiddenException);
    expect((await invoiceRow(note)).status).toBe('submitted');
  });

  it('a debit note drafted, submitted, approved by Accountant then Finance and issued opens one receivable debit and one event', async () => {
    const original = await issuedInvoice();
    as(U.fin, 'finance');
    const drafted = await notes.draftDebitNote(debitBody(original), key());
    expect(drafted.invoice).toMatchObject({
      kind: 'debit_note',
      status: 'draft',
      originalInvoiceId: original,
    });
    expect(drafted.invoice.totals.total).toBe('113.00');
    const id = drafted.invoice.id;

    await submit(id, U.fin, 'finance');
    const request = await requestOf('debit_note', id);
    await act(U.acc2, 'accountant', request!.id);
    expect((await invoiceRow(id)).status).toBe('submitted');
    await act(U.fin2, 'finance', request!.id);
    const approved = await invoiceRow(id);
    expect(approved.status).toBe('approved');

    as(U.fin2, 'finance');
    const result = IssueInvoiceResultSchema.parse(
      await issuing.issue(id, { expectedVersion: approved.version }, key()),
    );
    expect(result).toMatchObject({ kind: 'issued', invoiceId: id });
    expect(result.number).toMatch(/^DN-/);
    expect((await invoiceRow(id)).status).toBe('issued');

    const items = await db.select().from(openItems).where(eq(openItems.sourceId, id));
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      side: 'receivable',
      direction: 'debit',
      sourceType: 'debit_note',
      amount: '113.00',
    });
    const events = await db.select().from(postingEvents).where(eq(postingEvents.sourceId, id));
    expect(events.map((e) => e.event)).toEqual(['debit_note_issued']);
  });
});

describe('saved reach on credit notes (U20a phase 2)', () => {
  it('checks invoice.credit_note on the original drafter after its read: 403 when readable, 404 when not', async () => {
    const original = await issuedInvoice(); // drafted by U.acc
    as(U.fin, 'finance');
    current.grants = new Map([...grantsOf('finance'), ['invoice.credit_note', 'own']]);
    await expect(notes.draftCreditNote(creditBody(original, '1'), key())).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(notes.draftDebitNote(debitBody(original), key())).rejects.toBeInstanceOf(
      ForbiddenException,
    );

    current.grants = new Map([...grantsOf('finance'), ['invoice.read', 'own']]);
    await expect(notes.draftCreditNote(creditBody(original, '1'), key())).rejects.toMatchObject({
      status: 404,
    });
    expect(await liveCreditNotes(original)).toEqual([]);

    // The drafter with an `own` credit grant reaches their own invoice.
    as(U.acc, 'accountant');
    current.grants = new Map([...grantsOf('accountant'), ['invoice.credit_note', 'own']]);
    const note = await notes.draftCreditNote(creditBody(original, '1'), key());
    expect(note.invoice.kind).toBe('credit_note');
  });
});

describe("debit notes fall due on the customer's payment terms (TR-Q12c)", () => {
  /**
   * The customer's account with entity A on a term of `netDays`, written as the dev seed writes it (the seed is the only
   * producer of party_accounts today); null removes the account.
   */
  async function setCustomerTerm(netDays: number | null): Promise<void> {
    await withTx(db, scopeA, systemActor('note-fixture'), async (tx) => {
      await tx.execute(
        sql`DELETE FROM app.party_accounts
            WHERE tenant_id = ${f.tenantId} AND organization_id = ${f.entityId} AND party_id = ${f.customerPartyId}`,
      );
      if (netDays === null) return;
      await tx.execute(
        sql`INSERT INTO app.payment_terms (tenant_id, code, name, net_days)
            VALUES (${f.tenantId}, ${`NET${netDays}`}, ${`Net ${netDays}`}, ${netDays})
            ON CONFLICT (tenant_id, code) DO NOTHING`,
      );
      await tx.execute(
        sql`INSERT INTO app.party_accounts (tenant_id, organization_id, party_id, default_currency, payment_term_id)
            SELECT ${f.tenantId}, ${f.entityId}, ${f.customerPartyId}, 'NPR', pt.id
            FROM app.payment_terms pt WHERE pt.tenant_id = ${f.tenantId} AND pt.code = ${`NET${netDays}`}`,
      );
    });
  }

  /** A manual tax invoice issued by U.fin with `dueDate`, so it has a credit period of its own. */
  async function issuedInvoiceDue(dueDate: string): Promise<string> {
    as(U.acc, 'accountant');
    const id = (
      await drafting.draftManual(
        {
          customerId: f.customerPartyId,
          currency: 'NPR',
          manualReason: 'Consulting on 30 days credit',
          dueDate,
          lines: [typedLine('Implementation', '1', '250.00', f.taxCodeVat13Id)],
        },
        key(),
      )
    ).invoice.id;
    await withTx(db, scopeA, systemActor('note-fixture'), (tx) =>
      tx.execute(
        sql`UPDATE app.invoices SET status = 'approved', version = version + 1 WHERE id = ${id}`,
      ),
    );
    as(U.fin, 'finance');
    await issuing.issue(id, { expectedVersion: (await invoiceRow(id)).version }, key());
    return id;
  }

  /** A debit note on `original` (a fresh issued invoice by default): drafted by U.fin, approved, issued by U.fin2. */
  async function issuedDebitNote(original?: string) {
    original ??= await issuedInvoice();
    as(U.fin, 'finance');
    const id = (await notes.draftDebitNote(debitBody(original), key())).invoice.id;
    expect((await invoiceRow(id)).dueDate).toBeNull();
    await withTx(db, scopeA, systemActor('note-fixture'), (tx) =>
      tx.execute(
        sql`UPDATE app.invoices SET status = 'approved', version = version + 1 WHERE id = ${id}`,
      ),
    );
    as(U.fin2, 'finance');
    await issuing.issue(id, { expectedVersion: (await invoiceRow(id)).version }, key());
    const row = await invoiceRow(id);
    expect(row.status).toBe('issued');
    const [item] = await db.select().from(openItems).where(eq(openItems.sourceId, id));
    return { row, item: item! };
  }

  afterAll(async () => {
    await setCustomerTerm(null);
  });

  it('a customer on Net 15 gets a debit note due 15 days after issue, on the note and its open item', async () => {
    await setCustomerTerm(15);
    const { row, item } = await issuedDebitNote();
    expect(row.issueDate).toBe('2026-11-09');
    expect(row.dueDate).toBe('2026-11-24');
    expect(item.dueDate).toBe('2026-11-24');
  });

  it('a 0-day term is due on the issue date', async () => {
    await setCustomerTerm(0);
    const { row, item } = await issuedDebitNote();
    expect(row.dueDate).toBe('2026-11-09');
    expect(item.dueDate).toBe('2026-11-09');
  });

  it('a customer with no term here gets the credit period of the original invoice (R2-022)', async () => {
    await setCustomerTerm(null);
    const original = await issuedInvoiceDue('2026-12-09');
    expect((await invoiceRow(original)).dueDate).toBe('2026-12-09');
    const { row, item } = await issuedDebitNote(original);
    expect(row.dueDate).toBe('2026-12-09');
    expect(item.dueDate).toBe('2026-12-09');
  });

  it('a customer with no term and an original due on receipt: the note is due on its issue date', async () => {
    await setCustomerTerm(null);
    const { row } = await issuedDebitNote();
    expect(row.dueDate).toBe('2026-11-09');
  });

  it('a tax invoice ignores the customer term (it keeps its own due date rule)', async () => {
    await setCustomerTerm(15);
    const id = await issuedInvoice();
    expect((await invoiceRow(id)).dueDate).toBe('2026-11-09');
  });
});

describe('the creator of a note may not issue it (TR-Q12f)', () => {
  async function approved(id: string): Promise<number> {
    await withTx(db, scopeA, systemActor('note-fixture'), (tx) =>
      tx.execute(
        sql`UPDATE app.invoices SET status = 'approved', version = version + 1 WHERE id = ${id}`,
      ),
    );
    return (await invoiceRow(id)).version;
  }
  const noteSeq = async (kind: 'credit_note' | 'debit_note') =>
    (
      await db.execute<{ last: number | null }>(
        sql`SELECT max(seq)::int AS last FROM app.invoices
            WHERE tenant_id = ${f.tenantId} AND organization_id = ${f.entityId} AND kind = ${kind}`,
      )
    ).rows[0]?.last ?? 0;

  it.each(['credit_note', 'debit_note'] as const)(
    'a %s: its creator gets 403 separation_of_duties and no number; another Finance user issues it',
    async (kind) => {
      const original = await issuedInvoice();
      as(U.fin, 'finance');
      const id = (
        kind === 'credit_note'
          ? await notes.draftCreditNote(creditBody(original, '1'), key())
          : await notes.draftDebitNote(debitBody(original), key())
      ).invoice.id;
      const version = await approved(id);
      const before = await noteSeq(kind);

      // The page says so before the click: the detail flags the note for its creator only.
      expect((await drafting.detail(id)).issueBlockedBySod).toBe(true);
      const err = await issuing
        .issue(id, { expectedVersion: version }, key())
        .catch((e: unknown) => e);
      expect(statusOf(err)).toBe(403);
      expect(responseOf(err)).toMatchObject({
        code: 'forbidden',
        reason: 'separation_of_duties',
        message: 'The creator of a credit or debit note cannot issue it',
      });
      const row = await invoiceRow(id);
      expect([row.status, row.number]).toEqual(['approved', null]);
      expect(await noteSeq(kind)).toBe(before);

      as(U.fin2, 'finance');
      expect((await drafting.detail(id)).issueBlockedBySod).toBeUndefined();
      const result = IssueInvoiceResultSchema.parse(
        await issuing.issue(id, { expectedVersion: version }, key()),
      );
      expect(result.kind).toBe('issued');
      expect((await invoiceRow(id)).issuedBy).toBe(U.fin2);
    },
  );

  it('a tax invoice is not covered: its drafter may still issue it', async () => {
    as(U.fin, 'finance');
    const id = (
      await drafting.draftManual(
        {
          customerId: f.customerPartyId,
          currency: 'NPR',
          manualReason: 'Drafted and issued by Finance',
          lines: [typedLine('Support', '1', '100.00', f.taxCodeVat13Id)],
        },
        key(),
      )
    ).invoice.id;
    const version = await approved(id);
    expect((await drafting.detail(id)).issueBlockedBySod).toBeUndefined();
    const result = IssueInvoiceResultSchema.parse(
      await issuing.issue(id, { expectedVersion: version }, key()),
    );
    expect(result.kind).toBe('issued');
  });
});
