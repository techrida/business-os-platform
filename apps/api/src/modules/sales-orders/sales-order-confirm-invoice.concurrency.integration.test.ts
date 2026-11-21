// Concurrency test: Sales confirms the draft sales order an accepted quotation made (SalesOrdersService
// .confirmFromQuotation, which makes the advance line billable) while an accountant starts an invoice on the same
// order, at the same moment, on a real Postgres (the shared test database of @bos/db/testing). Two invoice paths race:
// a draft from the advance schedule line (InvoiceDraftingService.draftFromSchedule) and a proforma that names the
// order (draftProforma with salesOrderId, createTypedInTx).
// Real: migrations as bos_owner, queries as bos_app, DraftingService, RecordOutcomeService (the acceptance makes the
// draft order, F1-Q25), SalesOrdersService, InvoiceDraftingService, SettingsService, NumberingService, LedgerService,
// AuditService. Faked: the request context, notify, MoneyService (NPR only). Each actor has its own fixed caller and
// authz.
//
// Locks: all three commands claim their Idempotency-Key first (an audited INSERT, so the tenant's audit-chain lock),
// then confirm locks the quotation, its version, the order and the advance line; draftFromSchedule locks the order,
// then the line (LedgerService.lockForMoneyCommand); the proforma only reads the order and references it by foreign
// key.
//
// Each round: a fresh accepted quotation with its draft order; then the confirm and one invoice path race, each in its
// own transaction, with a 0-10 ms start offset on either side. Forced rounds: a third connection holds the audit-chain
// lock, one side starts and waits, the other starts and waits, then the lock is released (both orders for the
// schedule draft).
//
// Desired behaviour (the assertions): no error that is not a clean HTTP answer (no 40P01, no 55P03); the confirm
// succeeds every round; the schedule draft succeeds (after the confirm) or gets 409 for a line that is not billable
// yet; the proforma succeeds; and the rows agree (order confirmed; the advance line drafted with the invoice, or still
// billable with none; the proforma on the order).
// RACE_TX_AUDIT=lazy runs every withTx with `audit: 'lazy'` (the lock order before the lock-first default) to show
// what the default prevents.
// Run: pnpm --filter @bos/api exec vitest run src/modules/sales-orders/sales-order-confirm-invoice.concurrency.integration.test.ts
import 'reflect-metadata';

import { randomUUID } from 'node:crypto';

import {
  DEFAULT_ROLE_PERMISSIONS,
  type Permission,
  type QuotationDto,
  type RoleKey,
  type Scope,
} from '@bos/contracts';
import {
  billingScheduleLines,
  invoices,
  opportunities,
  quotationVersions,
  salesOrders,
} from '@bos/db';
import { createTestDatabase, type TestDatabase } from '@bos/db/testing';
import { ForbiddenException } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  forcedRound,
  outcomeOf,
  pgErrorOf,
  race,
  tally,
  type PgFields,
} from '../../../test/support/race';
import { AuditService } from '../../platform/audit/audit.service';
import type { AuthzService } from '../../platform/authz/authz.service';
import { can } from '../../platform/authz/can';
import type { Principal } from '../../platform/authz/principal';
import { systemActor, withTx, type TxScope } from '../../platform/db/tx';
import type { NotifyService } from '../../platform/notify/notify.service';
import { CurrencyEnabledService } from '../../platform/settings/currency-enabled';
import type { MoneyService } from '../../platform/settings/money.service';
import { NumberingService } from '../../platform/settings/numbering.service';
import { SettingsService } from '../../platform/settings/settings.service';
import { InvoiceDraftingService } from '../invoices/invoice-drafting.service';
import { LedgerService } from '../ledger/ledger.service';
import { LeadLostReasonsService } from '../leads/lost-reasons.service';
import { OpportunitiesService } from '../opportunities/opportunities.service';
import { DraftingService } from '../quotations/drafting/drafting.service';
import {
  GOLDEN_ISSUE_DATE,
  seedOtherStaffUser,
  seedQuotationFixture,
  type QuotationFixture,
  type QuotationFixtureDb,
} from '../quotations/drafting/quotation.fixture';
import { QuotationOutcomeService } from '../quotations/outcome/quotation-outcome.service';
import { RecordOutcomeService } from '../quotations/outcome/record-outcome.service';
import { PricingService } from '../quotations/pricing/pricing.service';
import { SalesOrdersService } from './sales-orders.service';

vi.mock('../../platform/db/tx', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../platform/db/tx')>();
  if (process.env.RACE_TX_AUDIT !== 'lazy') return real;
  const withTx: typeof real.withTx = (db, scope, actor, fn, options) =>
    real.withTx(db, scope, actor, fn, { audit: 'lazy', ...options });
  return { ...real, withTx };
});

vi.setConfig({ testTimeout: 600_000, hookTimeout: 180_000 });

const SCHEDULE_ROUNDS = 32;
const PROFORMA_ROUNDS = 16;
/** 20 Nov 2026 20:00 UTC is already 21 Nov in Kathmandu (BS fiscal year 2083/84), as in sales-orders.integration.test.ts. */
const NOW = new Date('2026-11-20T20:00:00Z');
const DECIDED_ON = '2026-11-21';

let testDb: TestDatabase;
let ownerPool: Pool;
let appPool: Pool;
let db: QuotationFixtureDb;
let f: QuotationFixture;
let scopeA: TxScope;
let drafting: DraftingService;
let recorder: RecordOutcomeService;
let opportunitiesService: OpportunitiesService;
let salesOrdersService: SalesOrdersService;
let invoicing: InvoiceDraftingService;

const grantsOf = (role: RoleKey) =>
  new Map(Object.entries(DEFAULT_ROLE_PERMISSIONS[role])) as Map<Permission, Scope>;

/** A caller and authz fixed to one user and role: concurrent calls never share a mutable identity. */
function identity(userId: string, role: RoleKey) {
  const principal: Principal = {
    userId,
    zitadelUserId: `z-${userId}`,
    ...scopeA,
    orgKind: 'staff',
    partyId: null,
    idpOrgId: 'unused',
    roles: [role],
    departmentId: null,
    status: 'active',
    grants: grantsOf(role),
  };
  const caller = {
    current: () => ({
      scope: scopeA,
      actor: { kind: 'user' as const, id: userId, correlationId: `race-${role}` },
      principal,
    }),
  };
  const authz = {
    assert: (action: Permission, ref?: Parameters<typeof can>[2]) => {
      const d = can(principal, action, ref);
      if (!d.allowed) {
        throw new ForbiddenException({ code: 'forbidden', message: 'Forbidden', reason: d.reason });
      }
    },
  } as unknown as AuthzService;
  return { caller, authz };
}

const money = {
  toNprSnapshot: () => Promise.reject(new Error('MoneyService is not used for NPR quotations')),
} as unknown as MoneyService;
const notify = {
  notifyUser: vi.fn(() => Promise.resolve()),
  nudge: vi.fn(() => Promise.resolve()),
} as unknown as NotifyService;

beforeAll(async () => {
  testDb = await createTestDatabase();
  ownerPool = new Pool({ connectionString: testDb.ownerUrl, max: 2 });
  appPool = new Pool({ connectionString: testDb.appUrl, max: 10 });
  db = drizzle({ client: appPool });

  f = await seedQuotationFixture(db);
  scopeA = { tenantId: f.tenantId, organizationId: f.entityId };
  const audit = new AuditService(db);
  const settings = new SettingsService(db);
  const sales = identity(f.ownerUserId, 'sales');
  const accountant = identity(await seedOtherStaffUser(db, f), 'accountant');

  drafting = new DraftingService(
    db,
    new NumberingService(),
    new PricingService(money),
    sales.authz,
    audit,
    sales.caller,
    new CurrencyEnabledService(settings),
  );
  opportunitiesService = new OpportunitiesService(
    db,
    sales.authz,
    audit,
    sales.caller,
    new LeadLostReasonsService(db, audit, sales.caller),
  );
  const outcomes = new QuotationOutcomeService(
    settings,
    opportunitiesService,
    notify,
    audit,
    () => NOW,
  );
  recorder = new RecordOutcomeService(db, outcomes, sales.authz, notify, sales.caller);
  salesOrdersService = new SalesOrdersService(
    db,
    settings,
    new NumberingService(),
    audit,
    new LedgerService(),
    sales.caller,
    () => NOW,
  );
  invoicing = new InvoiceDraftingService(
    db,
    accountant.authz,
    audit,
    accountant.caller,
    new LedgerService(),
    new CurrencyEnabledService(settings),
    () => NOW,
  );
});

afterAll(async () => {
  await appPool?.end();
  await ownerPool?.end();
  await testDb?.drop();
});

// ---------------------------------------------------------------------------------------- helpers

/** A fresh opportunity of entity A (Won is terminal, so every accepted quotation needs its own). */
async function seedOpportunity(): Promise<string> {
  const [row] = await withTx(db, scopeA, systemActor('test'), (tx) =>
    tx
      .insert(opportunities)
      .values({
        ...scopeA,
        number: `DEAL-${randomUUID().slice(0, 8)}`,
        name: 'Acme platform',
        customerId: f.customerPartyId,
        ownerUserId: f.ownerUserId,
        stage: 'qualified',
      })
      .returning({ id: opportunities.id }),
  );
  return row!.id;
}

/**
 * A 5,045,450.00 quotation drafted by DraftingService, moved to Sent along 0016's transitions (as
 * sales-orders.integration.test.ts does) and accepted by RecordOutcomeService with a signed quote: the acceptance
 * makes the draft order. Returns the order and its advance line (planned until the order is confirmed).
 */
async function draftOrder() {
  const q: QuotationDto = await drafting.create(
    {
      opportunityId: await seedOpportunity(),
      currency: 'NPR',
      issueDate: GOLDEN_ISSUE_DATE,
      validUntil: '2026-12-09',
      lines: [
        {
          description: 'Platform build',
          uom: 'lot',
          quantity: '1',
          unitPrice: '4465000.00',
          taxCodeId: f.taxCodeVat13Id,
        },
      ],
    },
    `create-${randomUUID()}`,
  );
  const versionId = q.currentVersionId;
  await withTx(db, scopeA, systemActor('test'), async (tx) => {
    await tx.execute(
      sql`UPDATE app.quotation_versions
             SET status = 'submitted', submitted_at = now(), version = version + 1,
                 content_sha256 = sha256('content'::bytea), snapshot_sha256 = sha256('snapshot'::bytea)
           WHERE id = ${versionId}`,
    );
    await tx.execute(
      sql`UPDATE app.quotation_versions SET status = 'approved', approved_at = now(), version = version + 1
           WHERE id = ${versionId}`,
    );
    await tx.execute(
      sql`UPDATE app.quotation_versions SET status = 'sent', sent_at = now(), version = version + 1
           WHERE id = ${versionId}`,
    );
    await opportunitiesService.markQuotationSent(tx, q.opportunityId);
  });
  const [sent] = await db
    .select({ version: quotationVersions.version })
    .from(quotationVersions)
    .where(eq(quotationVersions.id, versionId));
  await recorder.record(
    q.id,
    versionId,
    {
      outcome: 'accepted',
      decidedOn: DECIDED_ON,
      evidenceKinds: ['signed_quote'],
      expectedVersion: sent!.version,
    },
    `accept-${randomUUID()}`,
  );
  const [order] = await db.select().from(salesOrders).where(eq(salesOrders.quotationId, q.id));
  expect(order).toMatchObject({ status: 'draft' });
  const [advance] = await db
    .select()
    .from(billingScheduleLines)
    .where(
      and(
        eq(billingScheduleLines.salesOrderId, order!.id),
        eq(billingScheduleLines.trigger, 'advance'),
      ),
    );
  expect(advance).toMatchObject({ status: 'planned' });
  return { versionId, orderId: order!.id, advanceId: advance!.id };
}
type Order = Awaited<ReturnType<typeof draftOrder>>;

const confirmOrder = (o: Order) =>
  salesOrdersService.confirmFromQuotation(
    { quotationVersionId: o.versionId, evidenceDocumentIds: [] },
    `so-${randomUUID()}`,
  );
const draftAdvance = (o: Order) =>
  invoicing.draftFromSchedule({ scheduleLineId: o.advanceId }, `inv-${randomUUID()}`);
const draftProforma = (o: Order) =>
  invoicing.draftProforma(
    {
      customerId: f.customerPartyId,
      currency: 'NPR',
      salesOrderId: o.orderId,
      lines: [
        {
          description: 'Advance for the platform build',
          uom: 'lot',
          quantity: '1',
          unitPrice: '1786000.00',
          taxCodeId: f.taxCodeVat13Id,
        },
      ],
    },
    `pi-${randomUUID()}`,
  );

type Path = 'schedule' | 'proforma';
type Round = {
  path: Path;
  round: number;
  offset: string;
  confirm: string;
  invoice: string;
  orderStatus: string;
  advance: string;
  /** Live invoices of the order, by kind. */
  invoices: string;
};

let firstDeadlock: PgFields | null = null;
const noteDeadlock = (side: string, r: PromiseSettledResult<unknown>) => {
  if (r.status === 'rejected' && firstDeadlock === null && pgErrorOf(r.reason).code === '40P01') {
    firstDeadlock = { ...pgErrorOf(r.reason), message: `${side}: ${pgErrorOf(r.reason).message}` };
  }
};

async function finish(
  o: Order,
  path: Path,
  round: number,
  offset: string,
  confirm: PromiseSettledResult<unknown>,
  invoice: PromiseSettledResult<unknown>,
): Promise<Round> {
  noteDeadlock('confirm', confirm);
  noteDeadlock(path, invoice);
  const [order] = await db.select().from(salesOrders).where(eq(salesOrders.id, o.orderId));
  const [line] = await db
    .select()
    .from(billingScheduleLines)
    .where(eq(billingScheduleLines.id, o.advanceId));
  const linked = await db
    .select({ id: invoices.id, kind: invoices.kind })
    .from(invoices)
    .where(eq(invoices.salesOrderId, o.orderId));
  const drafted = line!.invoiceId !== null && linked.some((i) => i.id === line!.invoiceId);
  return {
    path,
    round,
    offset,
    confirm: outcomeOf(confirm),
    invoice: outcomeOf(invoice),
    orderStatus: order!.status,
    advance: `${line!.status}${line!.invoiceId === null ? '' : drafted ? '+invoice' : '+unknown-invoice'}`,
    invoices:
      linked
        .map((i) => i.kind)
        .sort()
        .join(',') || 'none',
  };
}

/** The rows that agree with a round's outcomes. */
function coherent(r: Round): boolean {
  if (r.orderStatus !== 'confirmed') return false;
  if (r.path === 'proforma') return r.advance === 'billable' && r.invoices === 'proforma';
  return r.invoice === 'ok'
    ? r.advance === 'drafted+invoice' && r.invoices === 'tax_invoice'
    : r.advance === 'billable' && r.invoices === 'none';
}

// ------------------------------------------------------------------------------------------------ test

describe('sales order confirm racing an invoice started on the same order', () => {
  it('control: each side alone answers as expected', async () => {
    // Draft first: the advance line is still planned, so 409; confirm then makes it billable and the draft goes on.
    const a = await draftOrder();
    expect(outcomeOf((await Promise.allSettled([draftAdvance(a)]))[0])).toBe('http-409:conflict');
    await confirmOrder(a);
    await draftAdvance(a);
    // A proforma on the draft order, then the confirm.
    const b = await draftOrder();
    await draftProforma(b);
    await confirmOrder(b);
  });

  it('never deadlocks: the confirm succeeds, the invoice paths answer cleanly, and the rows agree', async () => {
    const rounds: Round[] = [];

    const forced: [Path, 'confirm-first' | 'invoice-first'][] = [
      ['schedule', 'confirm-first'],
      ['schedule', 'invoice-first'],
      ['proforma', 'confirm-first'],
    ];
    for (const [path, order] of forced) {
      const o = await draftOrder();
      const invoice = () => (path === 'schedule' ? draftAdvance(o) : draftProforma(o));
      const r =
        order === 'confirm-first'
          ? await forcedRound(ownerPool, ownerPool, f.tenantId, () => confirmOrder(o), invoice)
          : await forcedRound(ownerPool, ownerPool, f.tenantId, invoice, () => confirmOrder(o));
      console.log(
        `[S2 step4 pair1] forced ${path} ${order}: firstWaited=${r.firstWaited} bothWaited=${r.bothWaited} waiters=${JSON.stringify(r.waiters)}`,
      );
      const [confirm, inv] = order === 'confirm-first' ? [r.first, r.second] : [r.second, r.first];
      rounds.push(await finish(o, path, 0, `forced ${order}`, confirm, inv));
    }

    for (const [path, count] of [
      ['schedule', SCHEDULE_ROUNDS],
      ['proforma', PROFORMA_ROUNDS],
    ] as const) {
      for (let i = 1; i <= count; i++) {
        const o = await draftOrder();
        const r = await race(
          i,
          () => confirmOrder(o),
          () => (path === 'schedule' ? draftAdvance(o) : draftProforma(o)),
        );
        rounds.push(
          await finish(o, path, i, `confirm+${r.offsets.a} ${path}+${r.offsets.b}`, r.a, r.b),
        );
      }
    }

    // Printed before any assertion, so a failure keeps the counts.
    for (const path of ['schedule', 'proforma'] as const) {
      const of = rounds.filter((r) => r.path === path);
      console.log(
        `[S2 step4 pair1] ${path}: rounds=${of.length} counts=${JSON.stringify(tally(of, ['confirm', 'invoice']), null, 1)}`,
      );
    }
    console.log(`[S2 step4 pair1] per round:\n${rounds.map((r) => JSON.stringify(r)).join('\n')}`);
    console.log(`[S2 step4 pair1] first 40P01: ${JSON.stringify(firstDeadlock, null, 1)}`);

    const cleanInvoice = (r: Round) =>
      r.invoice === 'ok' || (r.path === 'schedule' && r.invoice === 'http-409:conflict');
    expect(rounds.filter((r) => r.confirm !== 'ok' || !cleanInvoice(r))).toEqual([]);
    expect(rounds.filter((r) => !coherent(r))).toEqual([]);
  });
});
