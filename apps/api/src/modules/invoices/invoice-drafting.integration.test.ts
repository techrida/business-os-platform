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
import { billingScheduleLines, invoices, runMigrations } from '@bos/db';
import {
  ConflictException,
  ForbiddenException,
  HttpException,
  NotFoundException,
} from '@nestjs/common';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
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
  seedQuotationFixture,
  type QuotationFixture,
  type QuotationFixtureDb,
} from '../quotations/drafting/quotation.fixture';
import { InvoiceDraftingService } from './invoice-drafting.service';
import { InvoiceIssueService } from './invoice-issue.service';
import type { InvoiceCaller } from './invoice-support';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 180_000 });

const OWNER_PW = 'owner-test-pw';
const APP_PW = 'app-test-pw';
/** 2026-11-09 11:45 in Kathmandu: BS 2083-07-23, fiscal year 2083/84. */
const NOW = new Date('2026-11-09T06:00:00Z');

let container: StartedPostgreSqlContainer;
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
const current: { role: RoleKey; scope: TxScope | null; grants?: Map<Permission, Scope> } = {
  role: 'accountant',
  scope: null,
};
const scopeNow = (): TxScope => current.scope ?? scopeA;

const principalNow = (): Principal => ({
  userId: f.ownerUserId,
  zitadelUserId: `z-${f.ownerUserId}`,
  ...scopeNow(),
  orgKind: 'staff',
  partyId: null,
  idpOrgId: 'unused',
  roles: [],
  departmentId: null,
  status: 'active',
  grants: current.grants ?? grantsOf(current.role),
});
const caller = {
  current: () => ({
    scope: scopeNow(),
    actor: { kind: 'user' as const, id: f.ownerUserId, correlationId: 'test-corr' },
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
        ? { line1: '1 Durbar Marg', city: 'Kathmandu', country: 'NP' }
        : key === 'entity.pan_vat_no'
          ? '301234567'
          : null,
    ),
} as unknown as SettingsService;
// Every currency passes here; the refusal of a disabled one is unit-tested in invoice-drafting.currency.test.ts.
const currencies = { assertEnabled: () => Promise.resolve() } as unknown as CurrencyEnabledService;

const urlFor = (user: string, password: string, database: string) => {
  const url = new URL(container.getConnectionUri());
  url.username = user;
  url.password = password;
  url.pathname = `/${database}`;
  return url.toString();
};

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
  await container?.stop();
});

beforeEach(() => {
  current.role = 'accountant';
  current.scope = null;
  delete current.grants;
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

    const all = await drafting.list();
    expect(all.every((i) => InvoiceListItemSchema.safeParse(i).success)).toBe(true);
    expect(all.map((i) => i.id)).toEqual(
      expect.arrayContaining([drafted.invoice.id, proforma.invoice.id]),
    );
    expect(all[0]?.customerName).toBe('Acme Pvt. Ltd.');
    const proformas = await drafting.list({ kind: 'proforma' });
    expect(proformas.every((i) => i.kind === 'proforma')).toBe(true);
    expect(proformas.map((i) => i.id)).toContain(proforma.invoice.id);
    expect((await drafting.list({ customerId: randomUUID() })).length).toBe(0);

    current.scope = scopeB;
    current.role = 'finance';
    expect((await drafting.list()).length).toBe(0);
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
