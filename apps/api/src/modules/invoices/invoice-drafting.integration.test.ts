// Integration tests of invoice drafting and proforma issue on a real Postgres (Testcontainers, needs Docker in WSL).
// Real: migrations as bos_owner, queries as bos_app (so every CHECK and trigger of 0020 and 0021 runs), the services,
// NumberingService, LedgerService (the lock helper) and the real AuditService. Faked: the request context, authz.assert
// (the real pure can() on a fake principal), MoneyService (NPR only) and the entity settings. The controller is covered
// by its own wiring; the services are called directly and their exceptions carry the HTTP status.
// Covers P3 done checks 1 (golden manual invoice), 6 (double draft: one winner), 8 (no paid field) and the proforma path
// (PI number, no open item), plus the cross-entity 404 and the discard that frees a schedule line.
// Run: pnpm --filter @bos/api exec vitest run src/modules/invoices/invoice-drafting.integration.test.ts
import 'reflect-metadata';

import { randomUUID } from 'node:crypto';

import {
  DEFAULT_ROLE_PERMISSIONS,
  InvoiceDetailSchema,
  InvoiceListItemSchema,
  IssueInvoiceResultSchema,
  type Permission,
  type RoleKey,
  type Scope,
} from '@bos/contracts';
import { billingScheduleLines, invoices } from '@bos/db';
import {
  ConflictException,
  ForbiddenException,
  HttpException,
  NotFoundException,
} from '@nestjs/common';
import { and, eq, ne, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { AuditService } from '../../platform/audit/audit.service';
import type { AuthzService } from '../../platform/authz/authz.service';
import { can } from '../../platform/authz/can';
import type { Principal } from '../../platform/authz/principal';
import { systemActor, withTx, type TxScope } from '../../platform/db/tx';
import type { MoneyService } from '../../platform/settings/money.service';
import { NumberingService } from '../../platform/settings/numbering.service';
import type { CurrencyEnabledService } from '../../platform/settings/currency-enabled';
import type { SettingsService } from '../../platform/settings/settings.service';
import { LedgerService } from '../ledger/ledger.service';
import {
  seedOtherStaffUser,
  seedQuotationFixture,
  type QuotationFixture,
  type QuotationFixtureDb,
} from '../quotations/drafting/quotation.fixture';
import { InvoiceDraftingService } from './invoice-drafting.service';
import { InvoiceIssueService } from './invoice-issue.service';
import type { InvoiceCaller } from './invoice-support';
import { createTestDatabase, type TestDatabase } from '@bos/db/testing';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 180_000 });

/** 2026-11-09 11:45 in Kathmandu: BS 2083-07-23, fiscal year 2083/84. */
const NOW = new Date('2026-11-09T06:00:00Z');

let testDb: TestDatabase;
let ownerPool: Pool;
let appPool: Pool;
let db: QuotationFixtureDb;
let f: QuotationFixture;
let scopeA: TxScope;
let scopeB: TxScope;
let drafting: InvoiceDraftingService;
let issuing: InvoiceIssueService;

const grantsOf = (role: RoleKey) =>
  new Map(Object.entries(DEFAULT_ROLE_PERMISSIONS[role])) as Map<Permission, Scope>;
const current: {
  role: RoleKey;
  scope: TxScope | null;
  grants?: Map<Permission, Scope>;
  /** Who calls: the fixture's user unless a test switches to someone else. */
  userId?: string | undefined;
  departmentId?: string | null;
} = {
  role: 'accountant',
  scope: null,
};
const callerId = () => current.userId ?? f.ownerUserId;
const scopeNow = (): TxScope => current.scope ?? scopeA;

const principalNow = (): Principal => ({
  userId: callerId(),
  zitadelUserId: `z-${callerId()}`,
  ...scopeNow(),
  orgKind: 'staff',
  partyId: null,
  idpOrgId: 'unused',
  roles: [],
  departmentId: current.departmentId ?? null,
  status: 'active',
  grants: current.grants ?? grantsOf(current.role),
});
const caller = {
  current: () => ({
    scope: scopeNow(),
    actor: { kind: 'user' as const, id: callerId(), correlationId: 'test-corr' },
    principal: principalNow(),
  }),
} as unknown as InvoiceCaller;
const authz = {
  assert: (action: Permission, ref?: Parameters<typeof can>[2]) => {
    const d = can(principalNow(), action, ref);
    if (!d.allowed) {
      throw new ForbiddenException({ code: 'forbidden', message: 'Forbidden', reason: d.reason });
    }
  },
} as unknown as AuthzService;
const money = {
  toNprSnapshot: (_tx: unknown, _scope: unknown, m: { amount: string; currency: string }) =>
    m.currency === 'NPR'
      ? Promise.resolve({
          amountNpr: m.amount,
          rate: '1',
          rateSource: 'NPR',
          rateDate: '2026-11-09',
        })
      : Promise.reject(new Error('MoneyService is not used for foreign currency here')),
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
// Every currency passes here; the refusal of a disabled one is unit-tested in invoice-drafting.currency.test.ts.
const currencies = { assertEnabled: () => Promise.resolve() } as unknown as CurrencyEnabledService;

const key = () => `key-${randomUUID()}`;
const codeOf = (e: unknown): unknown => (e as HttpException).getResponse();

let soSeq = 0;
/** A confirmed 5,045,450.00 order split 40/60: the 40% advance line is billable, the 60% line planned. */
async function seedOrder(): Promise<{ salesOrderId: string; advanceId: string; finalId: string }> {
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
    const line = (
      seq: number,
      label: string,
      trigger: string,
      percent: string,
      amount: string,
      status: string,
    ) =>
      one(
        sql`INSERT INTO app.billing_schedule_lines (tenant_id, organization_id, sales_order_id, seq, label, "trigger", percent, amount, amount_npr, status)
            VALUES (${scope.tenantId}, ${scope.organizationId}, ${salesOrderId}, ${seq}, ${label}, ${trigger}, ${percent}, ${amount}, ${amount}, ${status}) RETURNING id`,
      );
    const advanceId = await line(1, 'Advance 40%', 'advance', '40', '2018180.00', 'billable');
    const finalId = await line(2, 'Final 60%', 'delivery', '60', '3027270.00', 'planned');
    return { salesOrderId, advanceId, finalId };
  });
}

const lineRow = async (id: string) =>
  (
    await db
      .select({
        status: billingScheduleLines.status,
        invoiceId: billingScheduleLines.invoiceId,
      })
      .from(billingScheduleLines)
      .where(eq(billingScheduleLines.id, id))
  )[0];

const manualBody = (unitPrice = '1880000.00') => ({
  customerId: f.customerPartyId,
  currency: 'NPR' as const,
  manualReason: 'Consulting delivered without a sales order',
  lines: [
    {
      description: 'Implementation',
      uom: 'lot',
      quantity: '1',
      unitPrice,
      taxCodeId: f.taxCodeVat13Id,
    },
  ],
});

beforeAll(async () => {
  testDb = await createTestDatabase();
  const admin0 = new Pool({ connectionString: testDb.adminUrl, max: 1 });
  await admin0.end();
  const bosAdmin = new Pool({ connectionString: testDb.adminUrl, max: 1 });
  await bosAdmin.end();

  ownerPool = new Pool({ connectionString: testDb.ownerUrl, max: 2 });
  appPool = new Pool({ connectionString: testDb.appUrl, max: 8 });
  db = drizzle({ client: appPool });

  f = await seedQuotationFixture(db);
  scopeA = { tenantId: f.tenantId, organizationId: f.entityId };
  scopeB = { tenantId: f.tenantId, organizationId: f.otherEntityId };
  const clock = () => NOW;
  drafting = new InvoiceDraftingService(
    db,
    authz,
    new AuditService(db),
    caller,
    new LedgerService(),
    currencies,
    clock,
  );
  issuing = new InvoiceIssueService(
    db,
    authz,
    new AuditService(db),
    caller,
    new LedgerService(),
    new NumberingService(),
    money,
    settings,
    clock,
  );
});

afterAll(async () => {
  await appPool?.end();
  await ownerPool?.end();
  await testDb?.drop();
});

beforeEach(() => {
  current.role = 'accountant';
  current.scope = null;
  delete current.grants;
  current.userId = undefined;
  current.departmentId = null;
});

describe('manual invoice (done check 1, golden case)', () => {
  it('stores 1,880,000.00 less 5% with VAT 13% as 1,786,000.00 + 232,180.00 = 2,018,180.00', async () => {
    const detail = await drafting.draftManual(
      { ...manualBody(), discount: { mode: 'pct', value: '5' } },
      key(),
    );
    expect(InvoiceDetailSchema.safeParse(detail).success).toBe(true);
    expect(detail.invoice).toMatchObject({
      kind: 'tax_invoice',
      status: 'draft',
      number: null,
      issueDate: null,
      npr: null,
      salesOrderId: null,
      manualReason: 'Consulting delivered without a sales order',
      totals: {
        subtotal: '1880000.00',
        discountAmount: '94000.00',
        taxableAmount: '1786000.00',
        exemptAmount: '0.00',
        zeroRatedAmount: '0.00',
        taxAmount: '232180.00',
        total: '2018180.00',
      },
    });
    expect(detail.lines).toHaveLength(1);
    expect(detail.lines[0]).toMatchObject({
      gross: '1880000.00',
      discountAlloc: '94000.00',
      taxable: '1786000.00',
      taxAmount: '232180.00',
    });
    expect(detail.taxSummary).toEqual([
      expect.objectContaining({ label: 'VAT 13%', base: '1786000.00', tax: '232180.00' }),
    ]);
    // Check 8: nothing on the document says it is paid.
    expect(Object.keys(detail.invoice).some((k) => /paid/i.test(k))).toBe(false);
  });

  it('reaches the same totals from what the contract body can say: a 1,786,000.00 line, no discount', async () => {
    const detail = await drafting.draftManual(manualBody('1786000.00'), key());
    expect(detail.invoice.totals).toMatchObject({
      taxableAmount: '1786000.00',
      taxAmount: '232180.00',
      total: '2018180.00',
    });
  });

  it('answers a replayed Idempotency-Key with the first invoice, and a changed body with 422', async () => {
    const k = key();
    const first = await drafting.draftManual(manualBody(), k);
    const again = await drafting.draftManual(manualBody(), k);
    expect(again.invoice.id).toBe(first.invoice.id);
    await expect(drafting.draftManual(manualBody('1.00'), k)).rejects.toMatchObject({
      status: 422,
    });
  });

  it('refuses a manual invoice whose discount takes the whole amount (a zero total cannot be issued)', async () => {
    const refused = await drafting
      .draftManual({ ...manualBody(), discount: { mode: 'pct', value: '100' } }, key())
      .catch((e: unknown) => e);
    expect(refused).toMatchObject({ status: 400 });
    expect(codeOf(refused)).toMatchObject({
      message: 'The invoice total must be above zero: a discount cannot take the whole amount',
    });
  });

  it('refuses a zero-priced manual invoice without blaming a discount it does not have', async () => {
    const refused = await drafting.draftManual(manualBody('0.00'), key()).catch((e: unknown) => e);
    expect(refused).toMatchObject({ status: 400 });
    // Old code named a discount here too.
    expect(codeOf(refused)).toEqual({
      code: 'bad_request',
      message: 'The invoice total must be above zero',
    });
  });

  it('refuses a caller without invoice.draft', async () => {
    current.role = 'management';
    await expect(drafting.draftManual(manualBody(), key())).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });
});

describe('draft from a schedule line (done check 6)', () => {
  it('cuts the 40% advance: 2,018,180.00, and the line becomes drafted with the invoice id', async () => {
    const so = await seedOrder();
    const detail = await drafting.draftFromSchedule(
      { scheduleLineId: so.advanceId, salesOrderId: so.salesOrderId },
      key(),
    );
    expect(InvoiceDetailSchema.safeParse(detail).success).toBe(true);
    expect(detail.invoice).toMatchObject({
      kind: 'tax_invoice',
      status: 'draft',
      salesOrderId: so.salesOrderId,
      scheduleLineId: so.advanceId,
      manualReason: null,
      totals: {
        taxableAmount: '1786000.00',
        taxAmount: '232180.00',
        total: '2018180.00',
      },
    });
    expect(await lineRow(so.advanceId)).toEqual({
      status: 'drafted',
      invoiceId: detail.invoice.id,
    });
    // The 60% line is not billable yet.
    await expect(
      drafting.draftFromSchedule({ scheduleLineId: so.finalId }, key()),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('gives one winner and SCHEDULE_LINE_TAKEN to the other when two drafts race', async () => {
    const so = await seedOrder();
    const results = await Promise.allSettled([
      drafting.draftFromSchedule({ scheduleLineId: so.advanceId }, key()),
      drafting.draftFromSchedule({ scheduleLineId: so.advanceId }, key()),
    ]);
    const won = results.filter((r) => r.status === 'fulfilled');
    const lost = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect(lost[0]!.reason).toBeInstanceOf(ConflictException);
    expect(codeOf(lost[0]!.reason)).toMatchObject({ code: 'SCHEDULE_LINE_TAKEN' });
    const live = await db
      .select({ id: invoices.id })
      .from(invoices)
      .where(and(eq(invoices.scheduleLineId, so.advanceId), ne(invoices.status, 'discarded')));
    expect(live).toHaveLength(1);
  });

  it('answers a later draft of a taken line with SCHEDULE_LINE_TAKEN', async () => {
    const so = await seedOrder();
    await drafting.draftFromSchedule({ scheduleLineId: so.advanceId }, key());
    const err = await drafting
      .draftFromSchedule({ scheduleLineId: so.advanceId }, key())
      .catch((e: unknown) => e);
    expect(codeOf(err)).toMatchObject({ code: 'SCHEDULE_LINE_TAKEN' });
  });

  it("refuses a salesOrderId that is not the line's own order with a 404", async () => {
    const so = await seedOrder();
    await expect(
      drafting.draftFromSchedule(
        { scheduleLineId: so.advanceId, salesOrderId: randomUUID() },
        key(),
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('discard', () => {
  it('discards the draft and frees the schedule line, which can then be drafted again', async () => {
    const so = await seedOrder();
    const drafted = await drafting.draftFromSchedule({ scheduleLineId: so.advanceId }, key());
    const discarded = await drafting.discard(
      drafted.invoice.id,
      { expectedVersion: drafted.invoice.version, reason: 'Wrong customer contact' },
      key(),
    );
    expect(discarded.invoice.status).toBe('discarded');
    expect(await lineRow(so.advanceId)).toEqual({ status: 'billable', invoiceId: null });
    const again = await drafting.draftFromSchedule({ scheduleLineId: so.advanceId }, key());
    expect(again.invoice.id).not.toBe(drafted.invoice.id);
    expect(await lineRow(so.advanceId)).toEqual({ status: 'drafted', invoiceId: again.invoice.id });
  });

  it('answers a stale expectedVersion with 409 and leaves the line drafted', async () => {
    const so = await seedOrder();
    const drafted = await drafting.draftFromSchedule({ scheduleLineId: so.advanceId }, key());
    await expect(
      drafting.discard(
        drafted.invoice.id,
        { expectedVersion: drafted.invoice.version + 5, reason: 'stale' },
        key(),
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    expect((await lineRow(so.advanceId))?.status).toBe('drafted');
  });
});

describe('proforma (plan A12)', () => {
  const proformaBody = () => ({
    customerId: f.customerPartyId,
    currency: 'NPR' as const,
    lines: manualBody('1786000.00').lines,
  });

  it('issues with a PI number and no open item, and refuses what is not a proforma', async () => {
    const draft = await drafting.draftProforma(proformaBody(), key());
    expect(draft.invoice).toMatchObject({ kind: 'proforma', status: 'draft', number: null });

    current.role = 'accountant';
    await expect(
      issuing.issue(draft.invoice.id, { expectedVersion: draft.invoice.version }, key()),
    ).rejects.toBeInstanceOf(ForbiddenException);

    current.role = 'finance';
    const k = key();
    const issued = await issuing.issue(
      draft.invoice.id,
      { expectedVersion: draft.invoice.version },
      k,
    );
    expect(IssueInvoiceResultSchema.safeParse(issued).success).toBe(true);
    expect(issued.kind).toBe('issued');
    expect(issued.number).toMatch(/^PI-2083\/84-\d{5}$/);

    const detail = await drafting.detail(draft.invoice.id);
    expect(InvoiceDetailSchema.safeParse(detail).success).toBe(true);
    expect(detail.invoice).toMatchObject({
      status: 'issued',
      number: issued.number,
      issueDate: '2026-11-09',
      issueDateBs: '2083-07-23',
      npr: { amountNpr: '2018180.00', rate: '1.000000' },
      seller: { panVatNo: '301234567' },
      buyer: { legalName: 'Acme Pvt. Ltd.' },
    });
    expect(detail.invoice.contentHash).toMatch(/^[0-9a-f]{64}$/);

    // No open item: a proforma never posts to the ledger.
    const open = await ownerPool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM app.open_items WHERE source_id = $1',
      [draft.invoice.id],
    );
    expect(open.rows[0]?.n).toBe(0);

    // A replay of the same key and a second click with another key both say already_issued, same number.
    const replay = await issuing.issue(
      draft.invoice.id,
      { expectedVersion: draft.invoice.version },
      k,
    );
    expect(replay).toEqual(issued);
    const second = await issuing.issue(
      draft.invoice.id,
      { expectedVersion: draft.invoice.version },
      key(),
    );
    expect(second).toEqual({
      kind: 'already_issued',
      invoiceId: draft.invoice.id,
      number: issued.number,
    });

    // A tax invoice does not issue here until approval exists (U6).
    const tax = await drafting.draftManual(manualBody(), key());
    const refused = await issuing
      .issue(tax.invoice.id, { expectedVersion: tax.invoice.version }, key())
      .catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(ConflictException);
    expect(codeOf(refused)).toMatchObject({ code: 'NOT_APPROVED' });
  });

  it('numbers the next proforma PI-...-00002 with no gap', async () => {
    current.role = 'finance';
    const a = await drafting.draftProforma(proformaBody(), key());
    const issued = await issuing.issue(a.invoice.id, { expectedVersion: a.invoice.version }, key());
    const n = Number(issued.number.split('-')[2]);
    const b = await drafting.draftProforma(proformaBody(), key());
    const next = await issuing.issue(b.invoice.id, { expectedVersion: b.invoice.version }, key());
    expect(Number(next.number.split('-')[2])).toBe(n + 1);
  });
});

describe('detail customer name', () => {
  it('names the customer of a draft for a caller who may read invoices but not customers', async () => {
    const draft = await drafting.draftManual(manualBody(), key());
    expect(draft.invoice.buyer).toBeNull();
    current.grants = new Map<Permission, Scope>([['invoice.read', 'all']]);
    const detail = await drafting.detail(draft.invoice.id);
    expect(InvoiceDetailSchema.parse(detail).customerName).toBe('Acme Pvt. Ltd.');
    expect(detail.invoice.buyer).toBeNull();
  });

  it('stays a 404 from another legal entity, so no name leaks there', async () => {
    const draft = await drafting.draftManual(manualBody(), key());
    current.grants = new Map<Permission, Scope>([['invoice.read', 'all']]);
    current.scope = scopeB;
    await expect(drafting.detail(draft.invoice.id)).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('list and cross-entity isolation', () => {
  it('lists with filters, and every invoice of entity A is a 404 from entity B', async () => {
    const so = await seedOrder();
    const drafted = await drafting.draftFromSchedule({ scheduleLineId: so.advanceId }, key());
    const proforma = await drafting.draftProforma(
      {
        customerId: f.customerPartyId,
        currency: 'NPR',
        lines: manualBody('10.00').lines,
      },
      key(),
    );

    const { rows: all, total, totals } = await drafting.list();
    expect(total).toBe(all.length);
    // Drafts and proformas are rows but not money: only issued tax invoices, debit notes and credit notes count.
    expect(totals.length).toBeGreaterThan(0);
    expect(totals.every((t) => t.amount === '0.00')).toBe(true);
    expect(all.every((i) => InvoiceListItemSchema.safeParse(i).success)).toBe(true);
    expect(all.map((i) => i.id)).toEqual(
      expect.arrayContaining([drafted.invoice.id, proforma.invoice.id]),
    );
    expect(all[0]?.customerName).toBe('Acme Pvt. Ltd.');
    const proformas = (await drafting.list({ kind: ['proforma'] })).rows;
    expect(proformas.every((i) => i.kind === 'proforma')).toBe(true);
    expect(proformas.map((i) => i.id)).toContain(proforma.invoice.id);
    expect((await drafting.list({ customerId: [randomUUID()] })).rows.length).toBe(0);

    // Several values of one filter, a search, and a page with the total of all matches.
    const either = await drafting.list({ kind: ['proforma', 'tax_invoice'], status: ['draft'] });
    expect(either.rows.map((i) => i.id)).toEqual(
      expect.arrayContaining([drafted.invoice.id, proforma.invoice.id]),
    );
    expect((await drafting.list({ q: 'Acme' })).total).toBe(all.length);
    const page = await drafting.list({ limit: 1, offset: 1 });
    expect(page.rows.length).toBe(1);
    expect(page.total).toBe(all.length);
    expect(page.rows[0]?.id).toBe(all[1]?.id);
    // A filter that names the other entity's customer narrows to nothing; it never reaches further.
    const summary = await drafting.summary({ q: 'Acme' });
    expect(summary.total).toBe(all.length);
    expect(summary.byStatus.draft).toBeGreaterThanOrEqual(2);
    expect(summary.customers.map((c) => c.name)).toEqual(['Acme Pvt. Ltd.']);
    // Settlement is derived from an open item, and a draft has none.
    expect((await drafting.list({ settlement: ['paid', 'overdue', 'unpaid'] })).total).toBe(0);

    current.scope = scopeB;
    current.role = 'finance';
    expect((await drafting.list()).rows.length).toBe(0);
    expect((await drafting.list({ q: 'Acme' })).rows.length).toBe(0);
    const other = await drafting.summary();
    expect(other.total).toBe(0);
    expect(other.customers).toEqual([]);
    await expect(drafting.detail(drafted.invoice.id)).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      drafting.discard(drafted.invoice.id, { expectedVersion: 1, reason: 'not mine' }, key()),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      issuing.issue(proforma.invoice.id, { expectedVersion: 1 }, key()),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      drafting.draftFromSchedule({ scheduleLineId: so.finalId }, key()),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('saved reach on invoices (U20a phase 2)', () => {
  const ids = (rows: readonly { id: string }[]) => rows.map((r) => r.id);
  const narrowed = (edits: readonly [Permission, Scope][]) =>
    new Map<Permission, Scope>([...grantsOf('accountant'), ...edits]);

  it('own and department read only the invoices the caller drafted: list, summary and detail agree', async () => {
    const other = await seedOtherStaffUser(db, f);
    const mine = await drafting.draftManual(manualBody(), key());
    current.userId = other;
    const theirs = await drafting.draftManual(manualBody(), key());
    current.userId = undefined;

    // Invoices carry no department, so `department` reaches exactly what `own` reaches.
    for (const reach of ['own', 'department'] as const) {
      current.grants = narrowed([['invoice.read', reach]]);
      // A department of the caller's own, which no invoice carries.
      current.departmentId = randomUUID();
      const page = await drafting.list({});
      expect(ids(page.rows), reach).toContain(mine.invoice.id);
      expect(ids(page.rows), reach).not.toContain(theirs.invoice.id);
      expect(page.total, reach).toBe(page.rows.length);
      expect((await drafting.summary({})).total, reach).toBe(page.total);
      expect((await drafting.detail(mine.invoice.id)).invoice.id).toBe(mine.invoice.id);
      await expect(drafting.detail(theirs.invoice.id), reach).rejects.toMatchObject({
        status: 404,
      });
    }

    delete current.grants;
    current.role = 'founder';
    expect((await drafting.detail(theirs.invoice.id)).invoice.id).toBe(theirs.invoice.id);
    expect(ids((await drafting.list({})).rows)).toContain(theirs.invoice.id);
  });

  it('own drafting starts drafts and discards only the caller own; another readable draft is 403, an unreadable one 404', async () => {
    const other = await seedOtherStaffUser(db, f);
    current.userId = other;
    const theirs = await drafting.draftManual(manualBody(), key());
    current.userId = undefined;
    const discard = (d: typeof theirs) =>
      drafting.discard(
        d.invoice.id,
        { expectedVersion: d.invoice.version, reason: 'Drafted twice' },
        key(),
      );

    // A new draft is the caller's own, so an `own` drafting grant may start one.
    current.grants = narrowed([['invoice.draft', 'own']]);
    const mine = await drafting.draftManual(manualBody(), key());
    await expect(discard(theirs)).rejects.toBeInstanceOf(ForbiddenException);
    expect((await drafting.detail(theirs.invoice.id)).invoice.status).toBe('draft');
    expect((await discard(mine)).invoice.status).toBe('discarded');

    current.grants = narrowed([['invoice.read', 'own']]);
    await expect(discard(theirs)).rejects.toMatchObject({ status: 404 });
    delete current.grants;
    expect((await drafting.detail(theirs.invoice.id)).invoice.status).toBe('draft');
  });

  it("offers an own grant's actions only on the caller's invoices in list and detail, and the commands still refuse", async () => {
    const other = await seedOtherStaffUser(db, f);
    current.userId = other;
    const theirs = await drafting.draftManual(manualBody(), key());
    current.userId = undefined;
    const mine = await drafting.draftManual(manualBody(), key());
    const writes: Permission[] = [
      'invoice.draft',
      'invoice.submit',
      'invoice.issue',
      'invoice.credit_note',
    ];
    const listCan = async (id: string) =>
      (await drafting.list({})).rows.find((r) => r.id === id)?.can;
    const detailCan = async (id: string) => (await drafting.detail(id)).can;
    const allOf = (v: boolean) => ({ submit: v, issue: v, discard: v, notes: v });

    // Read stays `all`, so both rows are listed; every write is narrowed to the drafter.
    current.grants = narrowed(writes.map((p): [Permission, Scope] => [p, 'own']));
    expect(await listCan(mine.invoice.id)).toMatchObject(allOf(true));
    expect(await listCan(theirs.invoice.id)).toMatchObject(allOf(false));
    expect(await detailCan(mine.invoice.id)).toMatchObject(allOf(true));
    expect(await detailCan(theirs.invoice.id)).toMatchObject(allOf(false));
    // A payment is judged on the customer, as the payment command checks it, not on the drafter.
    expect((await listCan(theirs.invoice.id))?.recordPayment).toBe(true);

    // The API still refuses what the row does not offer.
    await expect(
      drafting.discard(
        theirs.invoice.id,
        { expectedVersion: theirs.invoice.version, reason: 'Not mine' },
        key(),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      issuing.issue(theirs.invoice.id, { expectedVersion: theirs.invoice.version }, key()),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect((await drafting.detail(theirs.invoice.id)).invoice.status).toBe('draft');

    // `all` reaches every drafter's invoice.
    current.grants = narrowed(writes.map((p): [Permission, Scope] => [p, 'all']));
    expect(await listCan(theirs.invoice.id)).toMatchObject(allOf(true));
    expect(await detailCan(theirs.invoice.id)).toMatchObject(allOf(true));

    // Without the grant the row offers nothing.
    const without = narrowed([]);
    for (const p of [...writes, 'payment.record' as const]) without.delete(p);
    current.grants = without;
    expect(await listCan(theirs.invoice.id)).toEqual({ ...allOf(false), recordPayment: false });
    expect(await detailCan(mine.invoice.id)).toEqual({
      ...allOf(false),
      recordPayment: false,
      editDueDate: {
        allowed: false,
        reason: 'Only someone who may draft this invoice can change its due date',
      },
    });
  });
});

// Last in the file: its issued invoice and open item would change the list counts and totals the tests above check.
describe('detail settlement (no ar.read needed)', () => {
  /**
   * An issued 1,000.00 NPR tax invoice of the fixture's customer with its debit open item, as U6's issue writes them
   * (the same rows as the receivables tests' helper). Issued 2026-11-01, due 2026-12-01: unpaid on NOW.
   */
  async function issuedWithOpenItem(seq: number): Promise<string> {
    return withTx(db, scopeA, systemActor('invoice-fixture'), async (tx) => {
      const inserted = await tx.execute<{ id: string }>(
        sql`INSERT INTO app.invoices
              (tenant_id, organization_id, kind, customer_party_id, manual_reason, currency, subtotal, discount_amount,
               taxable_vat_amount, tax_amount, total)
            VALUES (${scopeA.tenantId}, ${scopeA.organizationId}, 'tax_invoice', ${f.customerPartyId}, 'One-off sale',
                    'NPR', 1000.00, 0, 1000.00, 0, 1000.00)
            RETURNING id`,
      );
      const id = inserted.rows[0]!.id;
      await tx.execute(
        sql`UPDATE app.invoices
               SET status = 'issued', number = ${`INV-2083/84-${String(seq).padStart(5, '0')}`}, seq = ${seq},
                   fiscal_year = '2083/84', issue_date = '2026-11-01', issue_date_bs = '2083-07-15',
                   due_date = '2026-12-01', fx_rate = 1, amount_npr = total,
                   seller_snapshot = '{"legalName": "Techrida Pvt. Ltd.", "panVatNo": null, "address": null}',
                   buyer_snapshot = '{"legalName": "Acme", "panVatNo": null, "address": null}',
                   content_hash = decode(repeat('ab', 32), 'hex'), issued_at = now()
             WHERE id = ${id}`,
      );
      await new LedgerService().openItem(tx, scopeA, systemActor('invoice-fixture'), {
        side: 'receivable',
        direction: 'debit',
        partyId: f.customerPartyId,
        sourceType: 'tax_invoice',
        sourceId: id,
        currency: 'NPR',
        amount: '1000.00',
        amountNpr: '1000.00',
        fxRate: '1',
        documentDate: '2026-11-01',
        dueDate: '2026-12-01',
      });
      return id;
    });
  }

  it('carries the settlement and open amount for a caller with invoice.read and payment.record but no ar.read', async () => {
    const id = await issuedWithOpenItem(90001);
    // Drafted while the caller still holds invoice.draft (the accountant's grants).
    const draft = await drafting.draftManual(manualBody(), key());
    current.grants = new Map<Permission, Scope>([
      ['invoice.read', 'all'],
      ['payment.record', 'all'],
    ]);
    const detail = InvoiceDetailSchema.parse(await drafting.detail(id));
    // Old code sent no settlement on the detail, so the page asked the ar.read-gated statement and hid Record payment.
    expect(detail.settlement).toBe('unpaid');
    expect(detail.openAmount).toBe('1000.00');

    const onDraft = InvoiceDetailSchema.parse(await drafting.detail(draft.invoice.id));
    expect(onDraft.settlement).toBeNull();
    expect(onDraft.openAmount).toBeNull();
  });
});
