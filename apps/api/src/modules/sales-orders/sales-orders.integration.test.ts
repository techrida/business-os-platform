// Integration tests of sales orders (SalesOrdersService) on a real Postgres (Testcontainers, needs Docker in WSL).
// Real: migrations as bos_owner, queries as bos_app (so every CHECK and trigger of 0016 and 0020 runs, the
// deferred schedule-sum trigger and the one-live-order index included), SettingsService, NumberingService,
// AuditService, LedgerService, the idempotency table. Quotations are drafted by DraftingService, moved to Sent by
// raw SQL that follows 0016's transition guard and accepted by the real RecordOutcomeService, so the order is
// confirmed from what the quotation unit really writes. Faked: the request context, notify, and authz.assert
// (which still runs the real pure can() on a fake principal).
// The golden quotation here totals 5,045,450.00 (one VAT 13% line of 4,465,000.00, no discount): the sales order
// the plan's 60/20/20 and 40/60 examples are cut from.
// Every answer is parsed with the contract schema the workspace parses it with.
// Run: pnpm --filter @bos/api exec vitest run src/modules/sales-orders/sales-orders.integration.test.ts
import 'reflect-metadata';

import { randomUUID } from 'node:crypto';

import {
  CreditHoldDtoSchema,
  DEFAULT_ROLE_PERMISSIONS,
  OpportunityDtoSchema,
  QuotationEvidenceDtoSchema,
  SalesOrderDetailSchema,
  SalesOrderListItemSchema,
  type EvidencePolicy,
  type Permission,
  type QuotationDto,
  type RoleKey,
  type SalesOrderDetail,
  type Scope,
} from '@bos/contracts';
import {
  billingScheduleLines,
  documents,
  documentVersions,
  invoices,
  opportunities,
  partyAccounts,
  quotationVersions,
  quotations,
  salesOrderEvidence,
  salesOrderLines,
  salesOrders,
  salesOrderTaxSummary,
} from '@bos/db';
import { ForbiddenException, HttpException } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { AuditService } from '../../platform/audit/audit.service';
import { scopeWhereFor, type AuthzService } from '../../platform/authz/authz.service';
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
import { CreditHoldService } from '../opportunities/credit-hold.service';
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
import { createTestDatabase, type TestDatabase } from '@bos/db/testing';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 180_000 });

/** 20 Nov 2026 20:00 UTC is already 21 Nov in Kathmandu (BS fiscal year 2083/84). */
const NOW = new Date('2026-11-20T20:00:00Z');
const DECIDED_ON = '2026-11-21';
/** 4,465,000.00 + 13% VAT (580,450.00) = 5,045,450.00. */
const GOLDEN_TOTAL = '5045450.00';

type EvidenceKindName = 'contract' | 'purchase_order' | 'signed_quote';

let testDb: TestDatabase;
let ownerPool: Pool;
let appPool: Pool;
let db: QuotationFixtureDb;
let f: QuotationFixture;
let scopeA: TxScope;
let scopeB: TxScope;
let drafting: DraftingService;
let recorder: RecordOutcomeService;
let outcomes: QuotationOutcomeService;
let settings: SettingsService;
let opportunitiesService: OpportunitiesService;
let service: SalesOrdersService;

const grantsOf = (role: RoleKey) =>
  new Map(Object.entries(DEFAULT_ROLE_PERMISSIONS[role])) as Map<Permission, Scope>;
const current: {
  scope: TxScope;
  grants: Map<Permission, Scope>;
  userId?: string | undefined;
  departmentId?: string | null;
} = {
  scope: { tenantId: '', organizationId: '' },
  grants: grantsOf('sales'),
};
/** Who calls: the quotation owner of the fixture unless a test switches to someone else. */
const callerId = () => current.userId ?? f.ownerUserId;

const principalNow = (): Principal => ({
  userId: callerId(),
  zitadelUserId: `z-${callerId()}`,
  ...current.scope,
  orgKind: 'staff',
  partyId: null,
  idpOrgId: 'unused',
  roles: [],
  departmentId: current.departmentId ?? null,
  status: 'active',
  grants: current.grants,
});
const caller = {
  current: () => ({
    scope: current.scope,
    actor: { kind: 'user' as const, id: callerId(), correlationId: 'test-corr' },
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
const money = {
  toNprSnapshot: () => Promise.reject(new Error('MoneyService is not used for NPR quotations')),
} as unknown as MoneyService;
const notify = {
  notifyUser: vi.fn(() => Promise.resolve()),
  notifyRole: vi.fn(() => Promise.resolve()),
  nudge: vi.fn(() => Promise.resolve()),
};

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
  current.scope = scopeA;
  const audit = new AuditService(db);
  settings = new SettingsService(db);
  drafting = new DraftingService(
    db,
    new NumberingService(),
    new PricingService(money),
    authz as unknown as AuthzService,
    audit,
    caller,
    new CurrencyEnabledService(settings),
  );
  opportunitiesService = new OpportunitiesService(
    db,
    authz as unknown as AuthzService,
    audit,
    caller,
    new LeadLostReasonsService(db, audit, caller),
  );
  outcomes = new QuotationOutcomeService(
    settings,
    opportunitiesService,
    notify as unknown as NotifyService,
    audit,
    () => NOW,
  );
  recorder = new RecordOutcomeService(
    db,
    outcomes,
    authz as unknown as AuthzService,
    notify as unknown as NotifyService,
    caller,
  );
  service = new SalesOrdersService(
    db,
    settings,
    new NumberingService(),
    audit,
    new LedgerService(),
    caller,
    () => NOW,
  );
});

afterAll(async () => {
  await appPool?.end();
  await ownerPool?.end();
  await testDb?.drop();
});

beforeEach(() => {
  current.scope = scopeA;
  current.grants = grantsOf('sales');
  current.userId = undefined;
  current.departmentId = null;
});

afterEach(async () => {
  // The policy is per entity and shared by every test: put the default back.
  await setPolicy('signed_quote');
});

// ---------------------------------------------------------------------------------------- helpers

const userActor = () => ({
  kind: 'user' as const,
  id: f.ownerUserId,
  correlationId: 'test-setup',
});

async function setPolicy(policy: EvidencePolicy): Promise<void> {
  await withTx(db, scopeA, userActor(), (tx) => settings.set(tx, 'sales.evidence_policy', policy));
}

async function statusOf(promise: Promise<unknown>): Promise<{ status: number; code: unknown }> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof HttpException) {
      return {
        status: error.getStatus(),
        code: (error.getResponse() as { code?: unknown }).code,
      };
    }
    throw error;
  }
  throw new Error('expected the call to fail');
}

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

/** A kernel document of entity A (or B), as an upload leaves it: only its row matters to a sales order. */
async function seedDocument(scope: TxScope = scopeA): Promise<string> {
  const [row] = await withTx(db, scope, systemActor('test'), (tx) =>
    tx
      .insert(documents)
      .values({ ...scope, ownerType: 'test_evidence', ownerId: randomUUID() })
      .returning({ id: documents.id }),
  );
  return row!.id;
}

/** `seedDocument` whose only version the virus scan found infected (TR-Q12e). */
async function infectedDocument(): Promise<string> {
  const id = await seedDocument();
  await withTx(db, scopeA, systemActor('test'), (tx) =>
    tx.insert(documentVersions).values({
      ...scopeA,
      documentId: id,
      version: 1,
      filename: 'evidence.pdf',
      declaredMime: 'application/pdf',
      sizeBytes: 1024,
      storageKey: `${scopeA.tenantId}/${randomUUID()}`,
      status: 'infected',
    }),
  );
  return id;
}

async function draftQuotation(
  paymentSchedule?: { label: string; percent: string }[],
  unitPrice = '4465000.00',
): Promise<QuotationDto> {
  const opportunityId = await seedOpportunity();
  return drafting.create(
    {
      opportunityId,
      currency: 'NPR',
      issueDate: GOLDEN_ISSUE_DATE,
      validUntil: '2026-12-09',
      lines: [
        {
          description: 'Platform build',
          uom: 'lot',
          quantity: '1',
          unitPrice,
          taxCodeId: f.taxCodeVat13Id,
        },
      ],
      ...(paymentSchedule === undefined ? {} : { paymentSchedule }),
    },
    `create-${randomUUID()}`,
  );
}

const versionRow = async (id: string) => {
  const [row] = await db.select().from(quotationVersions).where(eq(quotationVersions.id, id));
  return row!;
};

/** Moves a draft along 0016's transitions to Sent (and the opportunity to quotation_sent). */
async function sendQuotation(q: QuotationDto): Promise<number> {
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
  return (await versionRow(versionId)).version;
}

/** A 5,045,450.00 quotation accepted by staff with `evidenceKinds` (default policy: a signed quote). */
async function acceptedQuotation(
  options: {
    paymentSchedule?: { label: string; percent: string }[];
    evidenceKinds?: EvidenceKindName[];
  } = {},
): Promise<QuotationDto> {
  // Recording the outcome is Sales' work, whoever the test then acts as.
  const held = current.grants;
  current.grants = grantsOf('sales');
  const q = await draftQuotation(options.paymentSchedule);
  const expectedVersion = await sendQuotation(q);
  await recorder.record(
    q.id,
    q.currentVersionId,
    {
      outcome: 'accepted',
      decidedOn: DECIDED_ON,
      evidenceKinds: options.evidenceKinds ?? ['signed_quote'],
      expectedVersion,
    },
    `accept-${randomUUID()}`,
  );
  current.grants = held;
  return q;
}

/** A sent quotation accepted the way the portal accepts it: as the customer, with the typed name as a signed quote. */
async function portalAcceptedQuotation(): Promise<QuotationDto> {
  const held = current.grants;
  current.grants = grantsOf('sales');
  const q = await draftQuotation();
  await sendQuotation(q);
  const customerUser = await seedOtherStaffUser(db, f);
  await withTx(db, scopeA, { kind: 'user', id: customerUser, correlationId: 'portal' }, (tx) =>
    outcomes.accept(tx, {
      versionId: q.currentVersionId,
      quotationId: q.id,
      actorKind: 'customer_user',
      actorUserId: customerUser,
      decidedOn: DECIDED_ON,
      acceptedByName: 'Ram Thapa',
      evidenceKinds: ['signed_quote'],
    }),
  );
  current.grants = held;
  return q;
}

const confirmEvidence = (
  q: QuotationDto,
  body: { evidenceKinds: EvidenceKindName[]; evidenceDocumentIds?: string[]; comment?: string },
  key = `evidence-${randomUUID()}`,
) => recorder.confirmEvidence(q.id, q.currentVersionId, { evidenceDocumentIds: [], ...body }, key);

const confirm = (q: QuotationDto, evidenceDocumentIds: string[] = [], key = `so-${randomUUID()}`) =>
  service.confirmFromQuotation(
    { quotationVersionId: q.currentVersionId, evidenceDocumentIds },
    key,
  );

/** The answer as the workspace parses it. */
const parsed = (detail: SalesOrderDetail) => SalesOrderDetailSchema.parse(detail);

const liveOrders = (quotationId: string) =>
  db.select().from(salesOrders).where(eq(salesOrders.quotationId, quotationId));

/** The order statuses of a quotation: an accepted one has its draft (F1-Q25) until it is confirmed. */
const orderStatuses = async (quotationId: string) =>
  (await liveOrders(quotationId)).map((o) => o.status);

// ------------------------------------------------------------------------------------------ confirm

describe('SalesOrdersService.confirmFromQuotation', () => {
  it('cuts the golden 5,045,450.00 as 60/20/20 with the advance line billable at once', async () => {
    const q = await acceptedQuotation();
    const detail = parsed(await confirm(q));

    expect(detail.order).toMatchObject({
      status: 'confirmed',
      customerId: f.customerPartyId,
      quotationId: q.id,
      quotationVersionId: q.currentVersionId,
      currency: 'NPR',
      totals: {
        subtotal: '4465000.00',
        discountAmount: '0.00',
        taxableAmount: '4465000.00',
        taxAmount: '580450.00',
        total: GOLDEN_TOTAL,
      },
      npr: { amountNpr: GOLDEN_TOTAL, rate: '1' },
      version: 1,
    });
    expect(detail.order.number).toMatch(/^SO-\d{4}\/\d{2}-\d{5}$/);
    expect(detail.order.fiscalYear).toBe('2083/84');
    expect(detail.order.confirmedAt).toBe(NOW.toISOString());

    expect(detail.schedule.map((l) => l.amount)).toEqual([
      '3027270.00',
      '1009090.00',
      '1009090.00',
    ]);
    expect(detail.schedule.map((l) => l.percent)).toEqual(['60', '20', '20']);
    expect(detail.schedule.map((l) => [l.trigger, l.status])).toEqual([
      ['advance', 'billable'],
      ['milestone', 'planned'],
      ['uat', 'planned'],
    ]);
    expect(detail.schedule[0]!.billableMarkedAt).toBe(NOW.toISOString());
    expect(detail.deliveryReleased).toBe(false);

    expect(detail.lines).toEqual([
      expect.objectContaining({
        lineNo: 1,
        description: 'Platform build',
        quantity: '1.0000',
        unitPrice: '4465000.00',
        gross: '4465000.00',
        taxable: '4465000.00',
      }),
    ]);
    const tax = await db
      .select()
      .from(salesOrderTaxSummary)
      .where(eq(salesOrderTaxSummary.salesOrderId, detail.order.id));
    expect(tax).toEqual([expect.objectContaining({ base: '4465000.00', tax: '580450.00' })]);
    const lines = await db
      .select()
      .from(salesOrderLines)
      .where(eq(salesOrderLines.salesOrderId, detail.order.id));
    expect(lines).toHaveLength(1);
  });

  it('cuts a quotation payment schedule of 40/60 with the advance at 2,018,180.00', async () => {
    const q = await acceptedQuotation({
      paymentSchedule: [
        { label: 'Advance 40%', percent: '40' },
        { label: 'Balance 60%', percent: '60' },
      ],
    });
    const detail = parsed(await confirm(q));
    expect(detail.schedule.map((l) => [l.label, l.amount, l.trigger, l.status])).toEqual([
      ['Advance 40%', '2018180.00', 'advance', 'billable'],
      ['Balance 60%', '3027270.00', 'uat', 'planned'],
    ]);
  });

  it('preserves four-decimal quotation shares on the stored order and detail response', async () => {
    const q = await acceptedQuotation({
      paymentSchedule: [
        { label: 'Advance', percent: '33.3333' },
        { label: 'Delivery', percent: '33.3333' },
        { label: 'Balance', percent: '33.3334' },
      ],
    });
    const confirmed = parsed(await confirm(q));
    const reopened = parsed(await service.detail(confirmed.order.id));
    expect(reopened.schedule.map(({ percent, amount }) => [percent, amount])).toEqual([
      ['33.3333', '1681814.98'],
      ['33.3333', '1681814.98'],
      ['33.3334', '1681820.04'],
    ]);
  });

  it('answers the same order to a retry with the same key', async () => {
    const q = await acceptedQuotation();
    const body = { quotationVersionId: q.currentVersionId, evidenceDocumentIds: [] };
    const first = await service.confirmFromQuotation(body, 'same-key-1');
    const again = await service.confirmFromQuotation(body, 'same-key-1');
    expect(again).toEqual(first);
    expect(await liveOrders(q.id)).toHaveLength(1);
  });

  it('makes one order when two callers confirm at once with different keys, and when asked again', async () => {
    const q = await acceptedQuotation();
    const [a, b] = await Promise.all([confirm(q), confirm(q)]);
    expect(a.order.id).toBe(b.order.id);
    const third = await confirm(q);
    expect(third.order.id).toBe(a.order.id);

    const rows = await liveOrders(q.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.number).toBe(a.order.number);
    const lines = await db
      .select()
      .from(billingScheduleLines)
      .where(eq(billingScheduleLines.salesOrderId, a.order.id));
    expect(lines).toHaveLength(3);
  });

  it('refuses with 422 evidence_policy_unmet when a signed quote does not meet the contract policy', async () => {
    const q = await acceptedQuotation({ evidenceKinds: ['signed_quote'] });
    await setPolicy('contract');

    const failure = await statusOf(confirm(q));
    expect(failure).toEqual({ status: 422, code: 'evidence_policy_unmet' });
    expect(await orderStatuses(q.id)).toEqual(['draft']);

    // The same quotation confirms once the policy is one its evidence meets.
    await setPolicy('signed_quote');
    expect((await confirm(q)).order.status).toBe('confirmed');
  });

  it('accepts a contract under the contract policy', async () => {
    const q = await acceptedQuotation({ evidenceKinds: ['signed_quote', 'contract'] });
    await setPolicy('contract');
    expect((await confirm(q)).order.status).toBe('confirmed');
  });

  it('refuses a version that is not accepted with 409 quotation_not_accepted', async () => {
    const q = await draftQuotation();
    await sendQuotation(q);
    expect(await statusOf(confirm(q))).toEqual({ status: 409, code: 'quotation_not_accepted' });
    expect(await liveOrders(q.id)).toHaveLength(0);
  });

  it('files the named evidence documents, and refuses one of another entity with 422', async () => {
    const q = await acceptedQuotation();
    const foreign = await seedDocument(scopeB);
    expect(await statusOf(confirm(q, [foreign]))).toEqual({
      status: 422,
      code: 'invalid_evidence_document',
    });
    expect(await orderStatuses(q.id)).toEqual(['draft']);

    const doc = await seedDocument();
    const detail = parsed(await confirm(q, [doc]));
    expect(detail.evidence).toEqual([{ documentId: doc, kind: 'signed_quote' }]);
    const rows = await db
      .select()
      .from(salesOrderEvidence)
      .where(eq(salesOrderEvidence.salesOrderId, detail.order.id));
    expect(rows).toHaveLength(1);
  });

  it('refuses an evidence file the scan found infected with 409 document_infected and leaves the order a draft (TR-Q12e)', async () => {
    const q = await acceptedQuotation();
    expect(await statusOf(confirm(q, [await infectedDocument()]))).toEqual({
      status: 409,
      code: 'document_infected',
    });
    expect(await orderStatuses(q.id)).toEqual(['draft']);
  });

  it('takes consecutive SO numbers for consecutive orders', async () => {
    const first = await confirm(await acceptedQuotation());
    const second = await confirm(await acceptedQuotation());
    const seq = (n: string | null) => Number(n!.split('-').pop());
    expect(seq(second.order.number)).toBe(seq(first.order.number) + 1);
  });
});

// ------------------------------------------------------------------------------------ list and detail

describe('draft sales order on acceptance (F1-Q25)', () => {
  const auditActions = async (entityId: string) =>
    (
      await ownerPool.query<{ action: string; after: Record<string, unknown> }>(
        'SELECT action, after FROM audit.audit_events WHERE entity_id = $1 ORDER BY occurred_at, id',
        [entityId],
      )
    ).rows;

  it('drafts the order when the quotation is accepted, and the Accountant confirms that same order', async () => {
    const q = await acceptedQuotation();
    const [draftRow] = await liveOrders(q.id);
    expect(draftRow).toMatchObject({
      status: 'draft',
      number: null,
      quotationVersionId: q.currentVersionId,
      total: GOLDEN_TOTAL,
      createdBy: null,
    });
    const draftLines = await db
      .select()
      .from(billingScheduleLines)
      .where(eq(billingScheduleLines.salesOrderId, draftRow!.id));
    // Nothing is billable before the Accountant confirms, not even the advance.
    expect(draftLines.map((l) => l.status)).toEqual(['planned', 'planned', 'planned']);
    expect((await auditActions(draftRow!.id)).map((a) => a.action)).toContain(
      'sales_order.drafted',
    );

    // The quotation's owner (Sales, own) reads the draft; nothing blocks it, but Sales cannot confirm.
    const asOwner = parsed(await service.detail(draftRow!.id));
    expect(asOwner.order).toMatchObject({ status: 'draft', number: null, confirmedAt: null });
    expect(asOwner.draft).toMatchObject({
      evidenceStatus: 'confirmed',
      policy: 'signed_quote',
      missing: [],
      blocker: null,
    });
    expect(asOwner.can?.confirm).toBe(false);
    const listed = (await service.list({ status: ['draft'] })).rows.map((r) =>
      SalesOrderListItemSchema.parse(r),
    );
    expect(listed.map((r) => r.id)).toContain(draftRow!.id);

    current.grants = grantsOf('accountant');
    current.userId = await seedOtherStaffUser(db, f);
    expect(parsed(await service.detail(draftRow!.id)).can?.confirm).toBe(true);
    const confirmed = parsed(await confirm(q));
    expect(confirmed.order).toMatchObject({ id: draftRow!.id, status: 'confirmed', version: 1 });
    expect(confirmed.order.number).toMatch(/^SO-\d{4}\/\d{2}-\d{5}$/);
    expect(confirmed.draft).toBeNull();
    expect(confirmed.schedule.map((l) => l.status)).toEqual(['billable', 'planned', 'planned']);
    const [after] = await liveOrders(q.id);
    // Whoever confirms a drafted order becomes its creator, as when the order was made at confirm.
    expect(after).toMatchObject({ createdBy: current.userId, confirmedBy: current.userId });
    expect(await liveOrders(q.id)).toHaveLength(1);
  });

  it('makes one draft when two people record the acceptance at once, and none again on a replay', async () => {
    const q = await draftQuotation();
    const expectedVersion = await sendQuotation(q);
    const record = (key: string) =>
      recorder.record(
        q.id,
        q.currentVersionId,
        {
          outcome: 'accepted',
          decidedOn: DECIDED_ON,
          evidenceKinds: ['signed_quote'],
          expectedVersion,
        },
        key,
      );
    const results = await Promise.allSettled([record('race-a'), record('race-b')]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    await record(results[0].status === 'fulfilled' ? 'race-a' : 'race-b');
    expect(await orderStatuses(q.id)).toEqual(['draft']);
  });

  it('keeps the acceptance when the order cannot be drafted, audits why and tells the owner', async () => {
    notify.notifyUser.mockClear();
    // 0.01 + 13% VAT is 0.01: the 60/20/20 default schedule would bill 0.00 twice.
    const q = await draftQuotation(undefined, '0.01');
    const expectedVersion = await sendQuotation(q);
    await recorder.record(
      q.id,
      q.currentVersionId,
      {
        outcome: 'accepted',
        decidedOn: DECIDED_ON,
        evidenceKinds: ['signed_quote'],
        expectedVersion,
      },
      `accept-${randomUUID()}`,
    );
    expect((await versionRow(q.currentVersionId)).status).toBe('accepted');
    expect(await liveOrders(q.id)).toHaveLength(0);
    const refused = (await auditActions(q.id)).find(
      (a) => a.action === 'sales_order.draft_refused',
    );
    expect(refused?.after).toMatchObject({
      versionId: q.currentVersionId,
      code: 'invalid_payment_schedule',
    });
    expect(notify.notifyUser).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        userId: f.ownerUserId,
        dedupeKey: `sales_order.draft_refused:${q.currentVersionId}`,
      }),
    );
    // The manual route answers the same refusal until the schedule is fixed.
    current.grants = grantsOf('accountant');
    expect(await statusOf(confirm(q))).toEqual({ status: 422, code: 'invalid_payment_schedule' });
  });

  it('drafts a portal acceptance its quotation owner can read, blocked until staff confirm the evidence', async () => {
    const q = await portalAcceptedQuotation();
    const [draftRow] = await liveOrders(q.id);
    expect(draftRow).toMatchObject({ status: 'draft', createdBy: null });

    // Sales reads at `own`: the order reaches its quotation's owner (U20a2-Q1), list and detail alike.
    expect((await service.list({})).rows.map((r) => r.id)).toContain(draftRow!.id);
    expect(parsed(await service.detail(draftRow!.id)).draft).toMatchObject({
      evidenceStatus: 'pending',
      blocker: 'evidence_not_confirmed',
    });

    current.grants = grantsOf('accountant');
    expect(parsed(await service.detail(draftRow!.id)).can?.confirm).toBe(false);
    current.grants = grantsOf('sales');
    await confirmEvidence(q, { evidenceKinds: ['signed_quote'] });
    current.grants = grantsOf('accountant');
    const ready = parsed(await service.detail(draftRow!.id));
    expect(ready.draft?.blocker).toBeNull();
    expect(ready.can?.confirm).toBe(true);
    expect((await confirm(q)).order.id).toBe(draftRow!.id);
  });
});

describe('evidence confirmation before the order (F1-Q28)', () => {
  it('holds a portal acceptance until staff confirm evidence that meets the policy, then confirms the order on it', async () => {
    await setPolicy('contract');
    const q = await portalAcceptedQuotation();

    expect(await statusOf(confirm(q))).toEqual({ status: 422, code: 'evidence_not_confirmed' });
    const pending = QuotationEvidenceDtoSchema.parse(
      await recorder.evidence(q.id, q.currentVersionId),
    );
    expect(pending).toMatchObject({
      status: 'pending',
      policy: 'contract',
      missing: ['contract'],
      acceptance: { actorKind: 'customer_user', acceptedByName: 'Ram Thapa' },
      confirmation: null,
      can: { confirm: true },
    });

    expect(await statusOf(confirmEvidence(q, { evidenceKinds: ['signed_quote'] }))).toEqual({
      status: 422,
      code: 'evidence_policy_unmet',
    });
    const foreign = await seedDocument(scopeB);
    expect(
      await statusOf(
        confirmEvidence(q, { evidenceKinds: ['contract'], evidenceDocumentIds: [foreign] }),
      ),
    ).toEqual({ status: 422, code: 'invalid_evidence_document' });

    const contract = await seedDocument();
    const key = `evidence-${randomUUID()}`;
    const body = {
      evidenceKinds: ['contract'] as EvidenceKindName[],
      evidenceDocumentIds: [contract],
    };
    const confirmed = QuotationEvidenceDtoSchema.parse(await confirmEvidence(q, body, key));
    expect(confirmed).toMatchObject({
      status: 'confirmed',
      missing: [],
      confirmation: { evidenceKinds: ['contract'], evidenceDocumentIds: [contract] },
      can: { confirm: false },
    });
    expect(confirmed.confirmation?.confirmedBy).toBe(f.ownerUserId);
    // A retry replays; a second confirmation is refused.
    expect(await confirmEvidence(q, body, key)).toEqual(confirmed);
    expect(await statusOf(confirmEvidence(q, body))).toEqual({
      status: 409,
      code: 'evidence_already_confirmed',
    });
    // The same reader sees what they confirmed.
    expect((await recorder.evidence(q.id, q.currentVersionId)).status).toBe('confirmed');

    current.grants = grantsOf('accountant');
    const order = parsed(await confirm(q));
    expect(order.order.status).toBe('confirmed');
    expect(order.evidence).toEqual([{ documentId: contract, kind: 'contract' }]);
  });

  it('refuses to confirm evidence that names an infected file, and refuses the order once a recorded file turns infected (TR-Q12e)', async () => {
    await setPolicy('contract');
    const q = await portalAcceptedQuotation();
    expect(
      await statusOf(
        confirmEvidence(q, {
          evidenceKinds: ['contract'],
          evidenceDocumentIds: [await infectedDocument()],
        }),
      ),
    ).toEqual({ status: 409, code: 'document_infected' });

    // A file that was clean (or still scanning) when staff confirmed it is found infected afterwards.
    const contract = await seedDocument();
    await confirmEvidence(q, { evidenceKinds: ['contract'], evidenceDocumentIds: [contract] });
    await withTx(db, scopeA, systemActor('test'), (tx) =>
      tx.insert(documentVersions).values({
        ...scopeA,
        documentId: contract,
        version: 1,
        filename: 'contract.pdf',
        declaredMime: 'application/pdf',
        sizeBytes: 1024,
        storageKey: `${scopeA.tenantId}/${randomUUID()}`,
        status: 'infected',
      }),
    );
    current.grants = grantsOf('accountant');
    expect(await statusOf(confirm(q))).toEqual({ status: 409, code: 'document_infected' });
    expect(await orderStatuses(q.id)).toEqual(['draft']);
  });

  it('counts a staff entry as confirmed, and hides the evidence from a caller who cannot read the quotation', async () => {
    const q = await acceptedQuotation();
    const evidence = await recorder.evidence(q.id, q.currentVersionId);
    expect(evidence).toMatchObject({
      status: 'confirmed',
      confirmation: null,
      acceptance: { actorKind: 'staff' },
      can: { confirm: false },
    });
    expect(await statusOf(confirmEvidence(q, { evidenceKinds: ['signed_quote'] }))).toEqual({
      status: 409,
      code: 'evidence_already_confirmed',
    });

    current.userId = await seedOtherStaffUser(db, f);
    expect(await statusOf(recorder.evidence(q.id, q.currentVersionId))).toEqual({
      status: 404,
      code: 'not_found',
    });
    expect(await statusOf(confirmEvidence(q, { evidenceKinds: ['signed_quote'] }))).toEqual({
      status: 404,
      code: 'not_found',
    });
  });
});

describe('SalesOrdersService.list and detail', () => {
  it('lists the order with its customer name, filters by status and customer, and parses as the UI does', async () => {
    const quote = await acceptedQuotation();
    const detail = await confirm(quote);
    const [quoteRow] = await db.select().from(quotations).where(eq(quotations.id, quote.id));
    const all = (await service.list({})).rows.map((i) => SalesOrderListItemSchema.parse(i));
    expect(all.find((i) => i.id === detail.order.id)).toEqual({
      id: detail.order.id,
      number: detail.order.number,
      customerId: f.customerPartyId,
      customerName: 'Acme Pvt. Ltd.',
      quotationNumber: quoteRow?.number,
      status: 'confirmed',
      currency: 'NPR',
      total: GOLDEN_TOTAL,
      confirmedAt: NOW.toISOString(),
    });
    expect((await service.list({ status: ['cancelled'] })).rows).toEqual([]);
    const byCustomer = await service.list({ customerId: [f.customerPartyId] });
    expect(byCustomer.rows.map((i) => i.id)).toContain(detail.order.id);
    expect((await service.list({ customerId: [randomUUID()] })).rows).toEqual([]);
  });

  it('uses the source quotation owner for Sales reads and hides other, unassigned and cross-tenant orders', async () => {
    const ownQuote = await acceptedQuotation();
    const otherQuote = await acceptedQuotation();
    const unassignedQuote = await acceptedQuotation();
    const own = await confirm(ownQuote);
    const otherOwner = await seedOtherStaffUser(db, f);
    // Someone else confirms the other two, as an accountant would: the salesperson neither created those orders
    // nor (below) owns their quotations.
    current.userId = otherOwner;
    const other = await confirm(otherQuote);
    const unassigned = await confirm(unassignedQuote);
    current.userId = undefined;

    await withTx(db, scopeA, userActor(), async (tx) => {
      await tx
        .update(quotations)
        .set({ ownerUserId: otherOwner })
        .where(eq(quotations.id, otherQuote.id));
      await tx
        .update(quotations)
        .set({ ownerUserId: null })
        .where(eq(quotations.id, unassignedQuote.id));
    });

    const listed = (await service.list({})).rows.map((item) => item.id);
    expect(listed).toContain(own.order.id);
    expect(listed).not.toContain(other.order.id);
    expect(listed).not.toContain(unassigned.order.id);
    expect((await service.list({ quotationVersionId: otherQuote.currentVersionId })).rows).toEqual(
      [],
    );
    expect(
      (await service.list({ quotationVersionId: ownQuote.currentVersionId })).rows,
    ).toMatchObject([{ id: own.order.id }]);
    expect((await service.detail(own.order.id)).order.id).toBe(own.order.id);
    for (const { order } of [other, unassigned]) {
      expect(await statusOf(service.detail(order.id))).toEqual({ status: 404, code: 'not_found' });
    }

    const outside = await seedQuotationFixture(db);
    current.scope = { tenantId: outside.tenantId, organizationId: outside.entityId };
    expect(await statusOf(service.detail(own.order.id))).toEqual({
      status: 404,
      code: 'not_found',
    });
    expect(await service.list({})).toEqual({ rows: [], total: 0 });

    current.scope = scopeA;
    current.grants = grantsOf('finance');
    expect((await service.detail(other.order.id)).order.id).toBe(other.order.id);
  });

  it('answers 404 to a read of another entity, and an empty list there', async () => {
    const detail = await confirm(await acceptedQuotation());
    current.scope = scopeB;
    expect(await statusOf(service.detail(detail.order.id))).toEqual({
      status: 404,
      code: 'not_found',
    });
    expect(await service.list({})).toEqual({ rows: [], total: 0 });
    current.scope = scopeA;
    expect((await service.detail(detail.order.id)).order.id).toBe(detail.order.id);
  });

  it('pages in a stable order with the total of all matches, and no limit returns every match', async () => {
    const made = [
      await confirm(await acceptedQuotation()),
      await confirm(await acceptedQuotation()),
    ];
    made.push(await confirm(await acceptedQuotation()));
    const everything = await service.list({});
    expect(everything.total).toBe(everything.rows.length);
    expect(everything.total).toBeGreaterThanOrEqual(3);
    const ids = everything.rows.map((r) => r.id);

    const first = await service.list({ limit: 2, offset: 0 });
    const second = await service.list({ limit: 2, offset: 2 });
    expect(first.rows).toHaveLength(2);
    expect(first.total).toBe(everything.total);
    expect(second.total).toBe(everything.total);
    expect([...first.rows, ...second.rows].map((r) => r.id)).toEqual(
      ids.slice(0, 2 + second.rows.length),
    );
    // Past the last row there is nothing, and the total is still right.
    const past = await service.list({ limit: 2, offset: everything.total + 10 });
    expect(past).toEqual({ rows: [], total: everything.total });
    for (const { order } of made) expect(ids).toContain(order.id);
  });

  it('filters by several statuses and several customers at once, and a filter matching nothing totals 0', async () => {
    const detail = await confirm(await acceptedQuotation());
    const byStatus = await service.list({ status: ['cancelled', 'confirmed'] });
    expect(byStatus.rows.map((r) => r.id)).toContain(detail.order.id);
    expect(byStatus.rows.every((r) => r.status === 'confirmed')).toBe(true);
    const byCustomers = await service.list({ customerId: [randomUUID(), f.customerPartyId] });
    expect(byCustomers.rows.map((r) => r.id)).toContain(detail.order.id);
    const none = await service.list({ status: ['cancelled'], customerId: [f.customerPartyId] });
    expect(none).toEqual({ rows: [], total: 0 });
  });

  it('searches the order number, the customer name and the quotation number', async () => {
    const q = await acceptedQuotation();
    const detail = await confirm(q);
    const idsFor = async (text: string) => (await service.list({ q: text })).rows.map((r) => r.id);
    expect(await idsFor(detail.order.number!)).toContain(detail.order.id);
    expect(await idsFor('acme pvt')).toContain(detail.order.id);
    // A number search can also bring close numbers; the exact hit is first.
    expect((await idsFor(q.number))[0]).toBe(detail.order.id);
    const paged = await service.list({ q: q.number, limit: 1 });
    expect(paged.rows).toHaveLength(1);
    expect(paged.total).toBe((await service.list({ q: q.number })).total);
  });

  it("finds a close match for a typo ('Acmee') inside the entity only", async () => {
    const detail = await confirm(await acceptedQuotation());
    const typo = await service.list({ q: 'Acmee' });
    expect(typo.rows.map((r) => r.id)).toContain(detail.order.id);
    expect(typo.total).toBe(typo.rows.length);
    // The fuzzy step carries the same scope: entity B sees none of entity A's orders.
    current.scope = scopeB;
    expect(await service.list({ q: 'Acmee' })).toEqual({ rows: [], total: 0 });
  });

  it("never widens the Sales own-scope: a matching filter, search or page does not reveal another owner's order", async () => {
    const mine = await acceptedQuotation();
    const theirs = await acceptedQuotation();
    const own = await confirm(mine);
    const otherOwner = await seedOtherStaffUser(db, f);
    await withTx(db, scopeA, userActor(), (tx) =>
      tx.update(quotations).set({ ownerUserId: otherOwner }).where(eq(quotations.id, theirs.id)),
    );
    // Confirming an order makes it the confirmer's own, so the other owner confirms theirs.
    current.userId = otherOwner;
    const other = await confirm(theirs);
    current.userId = undefined;

    const filters = [
      { customerId: [f.customerPartyId] },
      { status: ['confirmed' as const] },
      { q: theirs.number },
      { q: 'Acme' },
      { q: 'Acmee' },
    ];
    for (const filter of filters) {
      const { rows, total } = await service.list(filter);
      expect(
        rows.map((r) => r.id),
        JSON.stringify(filter),
      ).not.toContain(other.order.id);
      expect(total, JSON.stringify(filter)).toBe(rows.length);
    }
    // Close numbers may show up in fuzzy mode, but never an order the owner may not read.
    expect((await service.list({ q: mine.number })).rows[0]?.id).toBe(own.order.id);
    const summary = await service.summary({ q: theirs.number });
    const visible = await service.list({ q: theirs.number });
    expect(summary.total).toBe(visible.total);

    // Finance reads every order of the entity, so the same search finds it.
    current.grants = grantsOf('finance');
    expect((await service.list({ q: theirs.number })).rows[0]?.id).toBe(other.order.id);
  });

  it('summarises per status for the same visibility, ignoring status and honouring q and customer', async () => {
    const q = await acceptedQuotation();
    const detail = await confirm(q);
    const all = await service.summary({});
    const list = await service.list({});
    expect(all.total).toBe(list.total);
    expect(Object.keys(all.byStatus).sort()).toEqual([
      'cancelled',
      'completed',
      'confirmed',
      'draft',
    ]);
    expect(Object.values(all.byStatus).reduce((a, b) => a + b, 0)).toBe(all.total);
    expect(all.byStatus.confirmed).toBe(list.rows.filter((r) => r.status === 'confirmed').length);

    // The same q gives the same match set as the list, close matches included.
    for (const text of [q.number, 'Acme', 'Acmee']) {
      const counted = await service.summary({ q: text, customerId: [f.customerPartyId] });
      const listed = await service.list({ q: text, customerId: [f.customerPartyId] });
      expect(counted.total, text).toBe(listed.total);
      expect(
        Object.values(counted.byStatus).reduce((a, b) => a + b, 0),
        text,
      ).toBe(counted.total);
    }
    expect(await service.summary({ customerId: [randomUUID()] })).toEqual({
      total: 0,
      byStatus: { draft: 0, confirmed: 0, completed: 0, cancelled: 0 },
    });
    // Another entity counts none of A's orders.
    current.scope = scopeB;
    expect((await service.summary({ q: detail.order.number! })).total).toBe(0);
  });

  it('answers 404 to confirming a version of another entity', async () => {
    const q = await acceptedQuotation();
    current.scope = scopeB;
    expect(await statusOf(confirm(q))).toEqual({ status: 404, code: 'not_found' });
    current.scope = scopeA;
    expect(await orderStatuses(q.id)).toEqual(['draft']);
  });
});

// ------------------------------------------------------------------------------------ mark billable

describe('SalesOrdersService.markBillable', () => {
  // Marking is the Accountant's (sales_order.mark_billable); Sales holds no such grant.
  beforeEach(() => {
    current.grants = grantsOf('accountant');
  });

  const mark = (
    detail: SalesOrderDetail,
    lineIndex: number,
    body: { evidenceDocumentId?: string; expectedVersion?: number } = {},
    key = `mark-${randomUUID()}`,
  ) =>
    service.markBillable(
      detail.order.id,
      detail.schedule[lineIndex]!.id,
      { expectedVersion: detail.order.version, ...body },
      key,
    );

  it('needs evidence on a milestone line: 422 without it, then billable with it', async () => {
    const detail = await confirm(await acceptedQuotation());
    expect(await statusOf(mark(detail, 1))).toEqual({ status: 422, code: 'evidence_required' });
    const unchanged = await service.detail(detail.order.id);
    expect(unchanged.schedule[1]!.status).toBe('planned');
    expect(unchanged.order.version).toBe(1);

    const doc = await seedDocument();
    const after = parsed(await mark(detail, 1, { evidenceDocumentId: doc }));
    expect(after.schedule[1]).toMatchObject({
      status: 'billable',
      billableEvidenceDocumentId: doc,
      billableMarkedAt: NOW.toISOString(),
    });
    expect(after.schedule[2]!.status).toBe('planned');
    expect(after.order.version).toBe(2);
  });

  it('refuses a stale order version with 409, a foreign document with 422 and a line already billable with 409', async () => {
    const detail = await confirm(await acceptedQuotation());
    const doc = await seedDocument();
    await mark(detail, 1, { evidenceDocumentId: doc });

    // Version 1 was current when `detail` was read; the first mark moved the order to 2.
    expect((await statusOf(mark(detail, 2, { evidenceDocumentId: doc }))).status).toBe(409);
    const foreign = await seedDocument(scopeB);
    expect(
      await statusOf(mark(detail, 2, { evidenceDocumentId: foreign, expectedVersion: 2 })),
    ).toEqual({ status: 422, code: 'invalid_evidence_document' });
    expect(
      await statusOf(
        mark(detail, 2, { evidenceDocumentId: await infectedDocument(), expectedVersion: 2 }),
      ),
    ).toEqual({ status: 409, code: 'document_infected' });
    expect(
      await statusOf(mark(detail, 1, { evidenceDocumentId: doc, expectedVersion: 2 })),
    ).toEqual({ status: 409, code: 'schedule_line_not_planned' });
    // The advance line is billable since confirm.
    expect(await statusOf(mark(detail, 0, { expectedVersion: 2 }))).toEqual({
      status: 409,
      code: 'schedule_line_not_planned',
    });
  });

  it('replays an answered command with the same key and makes one change', async () => {
    const detail = await confirm(await acceptedQuotation());
    const doc = await seedDocument();
    const body = { evidenceDocumentId: doc, expectedVersion: 1 };
    const lineId = detail.schedule[1]!.id;
    const first = await service.markBillable(detail.order.id, lineId, body, 'mark-same-key');
    const again = await service.markBillable(detail.order.id, lineId, body, 'mark-same-key');
    expect(again).toEqual(first);
    expect((await service.detail(detail.order.id)).order.version).toBe(2);
  });

  it('answers 404 outside the entity and for a line of another order', async () => {
    const detail = await confirm(await acceptedQuotation());
    const other = await confirm(await acceptedQuotation());
    const doc = await seedDocument();
    expect(
      await statusOf(
        service.markBillable(
          detail.order.id,
          other.schedule[1]!.id,
          { evidenceDocumentId: doc, expectedVersion: 1 },
          `mark-${randomUUID()}`,
        ),
      ),
    ).toEqual({ status: 404, code: 'not_found' });

    current.scope = scopeB;
    expect(await statusOf(mark(detail, 1, { evidenceDocumentId: doc }))).toEqual({
      status: 404,
      code: 'not_found',
    });
    current.scope = scopeA;
    expect((await service.detail(detail.order.id)).schedule[1]!.status).toBe('planned');
  });
});

// Audit #7: Sales reads its own order but holds no invoice.read, so an "Open invoice" link led to a refusal. The
// order now names each held invoice (number and status only) under its own read, and says per line whether the
// caller may open it, by the same invoice.read filter the invoice route applies.
describe('SalesOrdersService.detail held invoices (audit #7)', () => {
  async function holdInvoice(detail: SalesOrderDetail): Promise<string> {
    const line = detail.schedule[0]!;
    return withTx(db, scopeA, userActor(), async (tx) => {
      const [row] = await tx
        .insert(invoices)
        .values({
          tenantId: scopeA.tenantId,
          organizationId: scopeA.organizationId,
          kind: 'tax_invoice',
          status: 'draft',
          customerPartyId: f.customerPartyId,
          salesOrderId: detail.order.id,
          scheduleLineId: line.id,
          currency: 'NPR',
        })
        .returning({ id: invoices.id });
      await tx
        .update(billingScheduleLines)
        .set({ status: 'drafted', invoiceId: row!.id })
        .where(eq(billingScheduleLines.id, line.id));
      return row!.id;
    });
  }

  it('names the invoice to Sales without a link, and only the number and status', async () => {
    const detail = await confirm(await acceptedQuotation());
    const invoiceId = await holdInvoice(detail);

    const asSales = parsed(await service.detail(detail.order.id));
    const held = asSales.schedule[0]!;
    expect(held.invoiceId).toBe(invoiceId);
    expect(held.invoice).toEqual({ number: null, status: 'draft' });
    expect(Object.keys(held.invoice!).sort()).toEqual(['number', 'status']);
    expect(held.can).toEqual({ openInvoice: false });
    expect(asSales.schedule[1]!.invoice).toBeNull();
    expect(asSales.schedule[1]!.can).toEqual({ openInvoice: false });
    expect(asSales.can).toEqual({ markBillable: false, draftInvoice: false, confirm: false });
  });

  it('lets a role that reads invoices open it, and follows a live grant given to Sales', async () => {
    const detail = await confirm(await acceptedQuotation());
    await holdInvoice(detail);

    current.grants = grantsOf('accountant');
    const asAccountant = parsed(await service.detail(detail.order.id));
    expect(asAccountant.schedule[0]!.can).toEqual({ openInvoice: true });
    expect(asAccountant.can).toEqual({ markBillable: true, draftInvoice: true, confirm: false });

    current.grants = new Map([...grantsOf('sales'), ['invoice.read', 'all']]);
    const asEditedSales = parsed(await service.detail(detail.order.id));
    expect(asEditedSales.schedule[0]!.can).toEqual({ openInvoice: true });
    expect(asEditedSales.can).toEqual({
      markBillable: false,
      draftInvoice: false,
      confirm: false,
    });
  });
});

describe('saved reach on sales orders (U20a phase 2)', () => {
  const ids = (rows: readonly { id: string }[]) => rows.map((r) => r.id);
  const moveQuotation = (quotationId: string, ownerUserId: string) =>
    withTx(db, scopeA, userActor(), (tx) =>
      tx.update(quotations).set({ ownerUserId }).where(eq(quotations.id, quotationId)),
    );

  it('own and department read the orders the caller confirmed or whose quotation they own: list, summary and detail agree', async () => {
    const otherOwner = await seedOtherStaffUser(db, f);
    const myQuote = await acceptedQuotation();
    const confirmedQuote = await acceptedQuotation();
    const neitherQuote = await acceptedQuotation();
    current.userId = otherOwner;
    const ofMyQuote = await confirm(myQuote);
    const neither = await confirm(neitherQuote);
    current.userId = undefined;
    const confirmedByMe = await confirm(confirmedQuote);
    await moveQuotation(confirmedQuote.id, otherOwner);
    await moveQuotation(neitherQuote.id, otherOwner);

    // Orders carry no department, so `department` reaches exactly what `own` reaches.
    for (const reach of ['own', 'department'] as const) {
      current.grants = new Map([...grantsOf('sales'), ['sales_order.read', reach]]);
      // A department of the caller's own, which no order carries.
      current.departmentId = randomUUID();
      const page = await service.list({});
      expect(ids(page.rows), reach).toEqual(
        expect.arrayContaining([ofMyQuote.order.id, confirmedByMe.order.id]),
      );
      expect(ids(page.rows), reach).not.toContain(neither.order.id);
      expect(page.total, reach).toBe(page.rows.length);
      expect((await service.summary({})).total, reach).toBe(page.total);
      for (const visible of [ofMyQuote, confirmedByMe]) {
        expect((await service.detail(visible.order.id)).order.id).toBe(visible.order.id);
      }
      expect(await statusOf(service.detail(neither.order.id)), reach).toEqual({
        status: 404,
        code: 'not_found',
      });
    }

    current.grants = grantsOf('accountant');
    expect((await service.detail(neither.order.id)).order.id).toBe(neither.order.id);
    expect(ids((await service.list({})).rows)).toContain(neither.order.id);
  });

  it('the registry alone reaches an order through its quotation owner, so every scopeWhereFor agrees (U20a2-Q1)', async () => {
    const otherOwner = await seedOtherStaffUser(db, f);
    const mine = await acceptedQuotation();
    const theirs = await acceptedQuotation();
    current.userId = otherOwner;
    const ofMyQuote = await confirm(mine);
    const ofTheirQuote = await confirm(theirs);
    current.userId = undefined;
    await moveQuotation(theirs.id, otherOwner);

    for (const reach of ['own', 'department'] as const) {
      current.grants = new Map([...grantsOf('sales'), ['sales_order.read', reach]]);
      const where = scopeWhereFor(principalNow(), salesOrders, 'sales_order.read');
      const rows = await withTx(db, scopeA, userActor(), (tx) =>
        tx.select({ id: salesOrders.id }).from(salesOrders).where(where),
      );
      expect(ids(rows), reach).toContain(ofMyQuote.order.id);
      expect(ids(rows), reach).not.toContain(ofTheirQuote.order.id);
    }
  });

  it('mark billable is a 404 outside the read and a 403 outside the mark-billable reach', async () => {
    const otherOwner = await seedOtherStaffUser(db, f);
    const q = await acceptedQuotation();
    current.userId = otherOwner;
    const theirs = await confirm(q);
    current.userId = undefined;
    await moveQuotation(q.id, otherOwner);
    // The milestone line needs evidence, so a caller who passes both checks gets that 422 and changes nothing.
    const markMilestone = () =>
      service.markBillable(
        theirs.order.id,
        theirs.schedule[1]!.id,
        { expectedVersion: theirs.order.version },
        `mark-${randomUUID()}`,
      );

    current.grants = new Map([...grantsOf('accountant'), ['sales_order.mark_billable', 'own']]);
    expect(await statusOf(markMilestone())).toEqual({ status: 403, code: 'forbidden' });
    expect((await service.detail(theirs.order.id)).can!.markBillable).toBe(false);

    current.grants = new Map([...grantsOf('accountant'), ['sales_order.read', 'own']]);
    expect(await statusOf(markMilestone())).toEqual({ status: 404, code: 'not_found' });

    current.grants = grantsOf('accountant');
    expect(await statusOf(markMilestone())).toEqual({ status: 422, code: 'evidence_required' });
    expect((await service.detail(theirs.order.id)).can!.markBillable).toBe(true);
  });
});

// --------------------------------------------------------------------------------------- lock order

describe('confirm and a draft of the advance line at once (lock order)', () => {
  it('serialises on the sales order: the confirm commits, then the advance invoice is drafted', async () => {
    const q = await acceptedQuotation();
    const [order] = await liveOrders(q.id);
    const [advance] = await db
      .select()
      .from(billingScheduleLines)
      .where(eq(billingScheduleLines.salesOrderId, order!.id))
      .orderBy(billingScheduleLines.seq);
    expect(advance).toMatchObject({ trigger: 'advance', status: 'planned' });

    current.grants = grantsOf('accountant');
    current.userId = await seedOtherStaffUser(db, f);
    const invoicing = new InvoiceDraftingService(
      db,
      authz as unknown as AuthzService,
      new AuditService(db),
      caller,
      new LedgerService(),
      new CurrencyEnabledService(settings),
      () => NOW,
    );

    // The container's superuser holds the advance line, so the confirm stops at it; then a draft of that line starts.
    // Order first (now), the draft waits behind the confirm. Line first (the old order), the confirm waits on the
    // draft's order lock while the draft waits on the confirm's line lock: a deadlock, or a 409 for the draft.
    const superPool = new Pool({ connectionString: testDb.adminUrl, max: 2 });
    const waiters = async (n: number, stop: () => boolean): Promise<boolean> => {
      const deadline = Date.now() + 20_000;
      for (;;) {
        const { rows } = await superPool.query<{ n: number }>(
          'SELECT count(DISTINCT l.pid)::int AS n FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid WHERE NOT l.granted AND a.datname = current_database()',
        );
        if ((rows[0]?.n ?? 0) >= n) return true;
        if (stop() || Date.now() > deadline) return false;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    };
    const blocker = await superPool.connect();
    try {
      await blocker.query('BEGIN');
      await blocker.query(
        'SELECT id FROM app.billing_schedule_lines WHERE id = $1 FOR NO KEY UPDATE',
        [advance!.id],
      );
      let settled = 0;
      const confirming = confirm(q).finally(() => (settled += 1));
      confirming.catch(() => undefined);
      expect(await waiters(1, () => settled > 0)).toBe(true);
      const drafting = invoicing
        .draftFromSchedule({ scheduleLineId: advance!.id }, `inv-${randomUUID()}`)
        .finally(() => (settled += 1));
      drafting.catch(() => undefined);
      expect(await waiters(2, () => settled > 0)).toBe(true);
      await blocker.query('COMMIT');

      const [confirmed, drafted] = await Promise.allSettled([confirming, drafting]);
      expect(confirmed.status).toBe('fulfilled');
      expect(drafted.status).toBe('fulfilled');
    } finally {
      await blocker.query('ROLLBACK').catch(() => undefined);
      blocker.release();
      await superPool.end();
    }

    // No evidence row was filed: its foreign-key lock on the order would serialise the two on its own.
    expect(
      await db
        .select()
        .from(salesOrderEvidence)
        .where(eq(salesOrderEvidence.salesOrderId, order!.id)),
    ).toHaveLength(0);
    const [after] = await liveOrders(q.id);
    expect(after).toMatchObject({ id: order!.id, status: 'confirmed' });
    const [line] = await db
      .select()
      .from(billingScheduleLines)
      .where(eq(billingScheduleLines.id, advance!.id));
    expect(line).toMatchObject({ status: 'drafted' });
    expect(line!.invoiceId).not.toBeNull();
  });
});

// ------------------------------------------------------------------------------------ credit hold

describe('credit hold at the hand-over to a sales order (F1-Q20, F1-Q26)', () => {
  let credit: CreditHoldService;
  let ledger: LedgerService;
  let financeUser: string;

  beforeAll(async () => {
    credit = new CreditHoldService(
      db,
      caller,
      authz as unknown as AuthzService,
      new AuditService(db),
    );
    ledger = new LedgerService();
    financeUser = await seedOtherStaffUser(db, f);
  });

  async function setLimit(creditLimit: string | null): Promise<void> {
    await withTx(db, scopeA, systemActor('test'), (tx) =>
      tx
        .insert(partyAccounts)
        .values({ ...scopeA, partyId: f.customerPartyId, creditLimit })
        .onConflictDoUpdate({
          target: [partyAccounts.tenantId, partyAccounts.organizationId, partyAccounts.partyId],
          set: { creditLimit },
        }),
    );
  }

  /** An open receivable item of the fixture's customer, as an issued invoice or a received payment leaves it. */
  async function openItem(
    direction: 'debit' | 'credit',
    currency: 'NPR' | 'USD',
    amount: string,
    fxRate = '1',
  ): Promise<void> {
    const amountNpr = (Number(amount) * Number(fxRate)).toFixed(2);
    await withTx(db, scopeA, systemActor('test'), (tx) =>
      ledger.openItem(tx, scopeA, systemActor('test'), {
        side: 'receivable',
        direction,
        partyId: f.customerPartyId,
        sourceType: direction === 'debit' ? 'tax_invoice' : 'payment',
        sourceId: randomUUID(),
        currency,
        amount,
        amountNpr,
        fxRate,
        ...(currency === 'NPR' ? {} : { fxSource: 'nrb', fxDate: DECIDED_ON }),
        documentDate: DECIDED_ON,
      }),
    );
  }

  async function holdOf(promise: Promise<unknown>) {
    try {
      await promise;
    } catch (error) {
      if (error instanceof HttpException) {
        return { status: error.getStatus(), body: error.getResponse() as Record<string, unknown> };
      }
      throw error;
    }
    throw new Error('expected the call to fail');
  }

  const asFinance = () => {
    current.grants = grantsOf('finance');
    current.userId = financeUser;
  };

  it('holds over the limit only, lets Finance override with a reason, then confirms with the same key', async () => {
    // NPR 80,000.00 invoiced + USD 200.00 at 133.50 (26,700.00) less a NPR 6,700.00 payment = exactly the limit.
    await setLimit('100000.00');
    try {
      await openItem('debit', 'NPR', '80000.00');
      await openItem('debit', 'USD', '200.00', '133.50');
      await openItem('credit', 'NPR', '6700.00');

      const atLimit = await acceptedQuotation();
      expect(parsed(await confirm(atLimit)).order.status).toBe('confirmed');

      await openItem('debit', 'NPR', '0.01');
      const q = await acceptedQuotation();
      const key = `so-${randomUUID()}`;
      const refused = await holdOf(confirm(q, [], key));
      expect(refused.status).toBe(409);
      // The deal only: Sales confirms, and the amounts are for holders of credit.override.
      expect(refused.body).toMatchObject({
        code: 'credit_hold',
        details: { opportunityId: q.opportunityId },
      });
      expect(JSON.stringify(refused.body)).not.toContain('100000');
      // The acceptance drafted the order (F1-Q25); the hold leaves it a draft, with no number.
      const [heldDraft] = await liveOrders(q.id);
      expect(await orderStatuses(q.id)).toEqual(['draft']);
      expect(heldDraft?.number).toBeNull();

      // The deal's own page carries the flag for whoever reads the deal, amounts only through credit.override.
      const deal = OpportunityDtoSchema.parse(await opportunitiesService.get(q.opportunityId));
      // The draft order the acceptance made is not a sales order yet: the hold still stands in its way.
      expect(deal.creditHold).toEqual({ held: true, overridden: false, ordered: false });
      expect((await statusOf(credit.get(q.opportunityId))).status).toBe(403);
      expect(
        (await statusOf(credit.override(q.opportunityId, { reason: 'Sales says fine' }))).status,
      ).toBe(403);

      asFinance();
      const before = CreditHoldDtoSchema.parse(await credit.get(q.opportunityId));
      expect(before).toMatchObject({
        creditLimit: '100000.00',
        exposure: '100000.01',
        held: true,
        override: null,
      });
      const overridden = CreditHoldDtoSchema.parse(
        await credit.override(q.opportunityId, { reason: 'Advance cheque received' }),
      );
      expect(overridden.override).toMatchObject({
        reason: 'Advance cheque received',
        byUserId: financeUser,
      });
      // A second override keeps the first one.
      const again = await credit.override(q.opportunityId, { reason: 'Another reason' });
      expect(again.override).toEqual(overridden.override);
      const { rows } = await ownerPool.query(
        `SELECT meta FROM audit.audit_events
          WHERE tenant_id = $1 AND action = 'opportunity.credit_overridden' AND entity_id = $2`,
        [f.tenantId, q.opportunityId],
      );
      expect(rows).toEqual([
        {
          meta: {
            reason: 'Advance cheque received',
            creditLimit: '100000.00',
            exposure: '100000.01',
            currency: 'NPR',
          },
        },
      ]);

      current.grants = grantsOf('sales');
      current.userId = undefined;
      const released = parsed(await confirm(q, [], key)).order;
      expect(released.status).toBe('confirmed');
      expect(released.id).toBe(heldDraft?.id);
      expect(
        OpportunityDtoSchema.parse(await opportunitiesService.get(q.opportunityId)).creditHold,
      ).toEqual({ held: true, overridden: true, ordered: true });
    } finally {
      await setLimit(null);
    }
  });

  it('refuses to override a deal that is not on hold, and answers 404 for a deal of another entity', async () => {
    const q = await acceptedQuotation();
    asFinance();
    expect(CreditHoldDtoSchema.parse(await credit.get(q.opportunityId))).toMatchObject({
      creditLimit: null,
      held: false,
      override: null,
    });
    expect(await statusOf(credit.override(q.opportunityId, { reason: 'Just in case' }))).toEqual({
      status: 409,
      code: 'conflict',
    });
    current.scope = scopeB;
    expect((await statusOf(credit.get(q.opportunityId))).status).toBe(404);
  });
});
