// Integration tests of the delivery-hold release (F1-Q32, D56; R4c1 Q4) on a real Postgres: migration 0155's table,
// its final-row guard and audit trigger, the live `sales.delivery_hold.management_npr` setting, the idempotency
// table and the audit log. Orders are confirmed from quotations the quotation unit really writes (drafted, moved
// to Sent along 0016's transitions, accepted by RecordOutcomeService), so `created_by` is what confirm writes.
// Faked: the request context and authz.assert (the real pure can() on a principal whose grants are the real role
// defaults). Every answer is parsed with the contract schema the workspace parses it with, and every refusal goes
// through the real ErrorBodyFilter, so a test sees only the `reason` an HTTP client would get.
// The golden order is NPR 5,045,450.00, so the threshold is moved to sit at, or one paisa below, that amount.
// Run: pnpm --filter @bos/api exec vitest run src/modules/sales-orders/sales-order-delivery-release.integration.test.ts
import 'reflect-metadata';

import { randomUUID } from 'node:crypto';

import {
  DEFAULT_ROLE_PERMISSIONS,
  ErrorBodySchema,
  SalesOrderDetailSchema,
  type Permission,
  type QuotationDto,
  type RoleKey,
  type SalesOrderDetail,
  type Scope,
} from '@bos/contracts';
import {
  createStaffUser,
  createTenantWithEntity,
  opportunities,
  quotationVersions,
  salesOrders,
} from '@bos/db';
import { createTestDatabase, type TestDatabase } from '@bos/db/testing';
import { ForbiddenException, HttpException, type ArgumentsHost } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { AuditService } from '../../platform/audit/audit.service';
import type { AuthzService } from '../../platform/authz/authz.service';
import { can } from '../../platform/authz/can';
import type { Principal } from '../../platform/authz/principal';
import { systemActor, withTx, type TxScope } from '../../platform/db/tx';
import type { NotifyService } from '../../platform/notify/notify.service';
import { CurrencyEnabledService } from '../../platform/settings/currency-enabled';
import { DELIVERY_HOLD_THRESHOLD_KEY } from '../../platform/settings/delivery-hold';
import type { MoneyService } from '../../platform/settings/money.service';
import { NumberingService } from '../../platform/settings/numbering.service';
import { SettingsService } from '../../platform/settings/settings.service';
import { ErrorBodyFilter } from '../../platform/tenancy/error-body.filter';
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

vi.setConfig({ testTimeout: 60_000, hookTimeout: 180_000 });

const NOW = new Date('2026-11-20T20:00:00Z');
const DECIDED_ON = '2026-11-21';
/** The golden order's NPR amount: 4,465,000.00 + 13% VAT. */
const AMOUNT_NPR = '5045450.00';
const ONE_PAISA_BELOW = '5045449.99';

let testDb: TestDatabase;
let ownerPool: Pool;
let appPool: Pool;
let db: QuotationFixtureDb;
let f: QuotationFixture;
let scopeA: TxScope;
let scopeB: TxScope;
let drafting: DraftingService;
let recorder: RecordOutcomeService;
let settings: SettingsService;
let opportunitiesService: OpportunitiesService;
let service: SalesOrdersService;
/** Staff users who never created an order here: they act as Finance, Management and Founder. */
let financeUser: string;
let managementUser: string;
let founderUser: string;

const grantsOf = (role: RoleKey) =>
  new Map(Object.entries(DEFAULT_ROLE_PERMISSIONS[role])) as Map<Permission, Scope>;
const current: { scope: TxScope; role: RoleKey; userId?: string | undefined } = {
  scope: { tenantId: '', organizationId: '' },
  role: 'sales',
};
/** The fixture's quotation owner confirms every order, so they are its creator (`created_by`). */
const callerId = () => current.userId ?? f.ownerUserId;

const principalNow = (): Principal => ({
  userId: callerId(),
  zitadelUserId: `z-${callerId()}`,
  ...current.scope,
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
  const outcomes = new QuotationOutcomeService(
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
  financeUser = await seedOtherStaffUser(db, f);
  managementUser = await seedOtherStaffUser(db, f);
  founderUser = await seedOtherStaffUser(db, f);
});

afterAll(async () => {
  await appPool?.end();
  await ownerPool?.end();
  await testDb?.drop();
});

beforeEach(() => {
  current.scope = scopeA;
  current.role = 'sales';
  current.userId = undefined;
});

// ---------------------------------------------------------------------------------------- helpers

const as = (role: RoleKey, userId?: string) => {
  current.role = role;
  current.userId = userId;
};

async function setThreshold(value: string): Promise<void> {
  await withTx(db, scopeA, { kind: 'user', id: f.ownerUserId, correlationId: 'test-setup' }, (tx) =>
    settings.set(tx, DELIVERY_HOLD_THRESHOLD_KEY, value),
  );
}

/** What the API's ErrorBodyFilter would send for `exception`: its status and the parsed ErrorBody. */
function throughFilter(exception: HttpException) {
  const out: { status?: number; body?: unknown } = {};
  const req = { method: 'POST', path: '/v1/sales-orders/x/delivery-release', headers: {} };
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
  return { status: out.status, body: ErrorBodySchema.parse(out.body) };
}

/** The refusal as an HTTP client sees it; anything that is not an HttpException is rethrown, not hidden. */
async function refusal(
  promise: Promise<unknown>,
): Promise<{ status: number | undefined; code: string; reason: unknown }> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof HttpException) {
      const { status, body } = throughFilter(error);
      return { status, code: body.error.code, reason: body.error.reason };
    }
    throw error;
  }
  throw new Error('expected the call to fail');
}

/** A 5,045,450.00 quotation accepted by Sales; acceptance drafts its order (F1-Q25). */
async function acceptedQuotation(): Promise<QuotationDto> {
  const held = { role: current.role, userId: current.userId };
  as('sales');
  const [deal] = await withTx(db, scopeA, systemActor('test'), (tx) =>
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
  const q = await drafting.create(
    {
      opportunityId: deal!.id,
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
  const [version] = await db
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
      expectedVersion: version!.version,
    },
    `accept-${randomUUID()}`,
  );
  as(held.role, held.userId);
  return q;
}

/** A confirmed golden order, confirmed by the fixture's quotation owner (so they are its creator). */
async function confirmedOrder(): Promise<string> {
  const q = await acceptedQuotation();
  const held = { role: current.role, userId: current.userId };
  as('sales');
  const detail = await service.confirmFromQuotation(
    { quotationVersionId: q.currentVersionId, evidenceDocumentIds: [] },
    `so-${randomUUID()}`,
  );
  as(held.role, held.userId);
  expect(detail.order.status).toBe('confirmed');
  return detail.order.id;
}

const parsed = (detail: SalesOrderDetail) => SalesOrderDetailSchema.parse(detail);
const release = (orderId: string, reason = 'Customer collects on site today', key?: string) =>
  service.releaseDelivery(orderId, { reason }, key ?? `release-${randomUUID()}`);
const detailOf = async (orderId: string) => parsed(await service.detail(orderId));

const releaseRows = async (orderId: string) =>
  (
    await ownerPool.query<{
      released_by_user_id: string;
      order_amount_npr: string;
      threshold_npr: string;
    }>(
      'SELECT released_by_user_id, order_amount_npr, threshold_npr FROM app.sales_order_delivery_releases WHERE sales_order_id = $1',
      [orderId],
    )
  ).rows;
const releaseAudits = async (orderId: string) =>
  (
    await ownerPool.query<{ after: Record<string, unknown> }>(
      `SELECT after FROM audit.audit_events WHERE entity_id = $1 AND action = 'sales_order.delivery_released'`,
      [orderId],
    )
  ).rows;
/** The seeded user's display name; never null, so a broken join to users cannot pass as null === null. */
const displayNameOf = async (userId: string) => {
  const name = (
    await ownerPool.query<{ display_name: string | null }>(
      'SELECT display_name FROM app.users WHERE id = $1',
      [userId],
    )
  ).rows[0]!.display_name;
  expect(name).toMatch(/^staff /);
  return name;
};

// ------------------------------------------------------------------------------------------ release

describe('SalesOrdersService.releaseDelivery (F1-Q32)', () => {
  it('lets Finance release at the threshold, flips deliveryReleased, writes the row and the audit, and replays', async () => {
    await setThreshold(AMOUNT_NPR);
    const orderId = await confirmedOrder();

    as('finance', financeUser);
    const before = await detailOf(orderId);
    expect(before.deliveryReleased).toBe(false);
    expect(before.deliveryRelease).toBeNull();
    expect(before.can?.releaseDelivery).toBe(true);
    expect(before.can?.releaseDeliveryBlockedBy).toBeNull();
    expect(before.can?.releaseDeliveryAllowedRoles).toEqual(['finance', 'founder']);

    const key = `release-${randomUUID()}`;
    const after = parsed(await release(orderId, 'Customer collects on site today', key));
    expect(after.deliveryReleased).toBe(true);
    expect(after.deliveryRelease).toEqual({
      kind: 'override',
      releasedAt: NOW.toISOString(),
      releasedByName: await displayNameOf(financeUser),
      reason: 'Customer collects on site today',
    });
    expect(after.can?.releaseDelivery).toBe(false);
    // Released: nothing is left to release, so nothing blocks it and no role is named.
    expect(after.can?.releaseDeliveryBlockedBy).toBeNull();
    expect(after.can?.releaseDeliveryAllowedRoles).toEqual([]);

    // The releaser reads it back on the detail, as does the order's creator.
    expect((await detailOf(orderId)).deliveryRelease?.kind).toBe('override');
    as('sales');
    const asCreator = await detailOf(orderId);
    expect(asCreator.deliveryReleased).toBe(true);
    expect(asCreator.deliveryRelease?.reason).toBe('Customer collects on site today');

    expect(await releaseRows(orderId)).toEqual([
      {
        released_by_user_id: financeUser,
        order_amount_npr: AMOUNT_NPR,
        threshold_npr: AMOUNT_NPR,
      },
    ]);
    const audits = await releaseAudits(orderId);
    expect(audits).toHaveLength(1);
    expect(audits[0]!.after).toMatchObject({
      deliveryReleased: true,
      reason: 'Customer collects on site today',
      amountNpr: AMOUNT_NPR,
      thresholdNpr: AMOUNT_NPR,
      releaserRoles: ['finance'],
      allowedRoles: ['finance', 'founder'],
    });

    // The same key replays the answer and writes nothing more.
    as('finance', financeUser);
    const replay = parsed(await release(orderId, 'Customer collects on site today', key));
    expect(replay.deliveryRelease).toEqual(after.deliveryRelease);
    expect(await releaseRows(orderId)).toHaveLength(1);
    expect(await releaseAudits(orderId)).toHaveLength(1);

    // A new key on a released order is a 409; the row stays the one record.
    expect(await refusal(release(orderId, 'Again'))).toMatchObject({
      status: 409,
      code: 'delivery_already_released',
    });
    as('founder', founderUser);
    expect(await refusal(release(orderId, 'Again'))).toMatchObject({
      status: 409,
      code: 'delivery_already_released',
    });
    expect(await releaseRows(orderId)).toHaveLength(1);
  });

  it('refuses Finance one paisa above the threshold and lets Management release it', async () => {
    await setThreshold(ONE_PAISA_BELOW);
    const orderId = await confirmedOrder();

    as('finance', financeUser);
    expect((await detailOf(orderId)).can).toMatchObject({
      releaseDelivery: false,
      releaseDeliveryBlockedBy: 'amount',
      releaseDeliveryAllowedRoles: ['management', 'founder'],
    });
    expect(await refusal(release(orderId))).toEqual({
      status: 403,
      code: 'forbidden',
      reason: 'role_cannot_release_amount',
    });
    expect(await releaseRows(orderId)).toHaveLength(0);

    as('management', managementUser);
    expect((await detailOf(orderId)).can?.releaseDelivery).toBe(true);
    const after = parsed(await release(orderId, 'Board approved early delivery'));
    expect(after.deliveryReleased).toBe(true);
    expect(after.deliveryRelease?.releasedByName).toBe(await displayNameOf(managementUser));
    expect((await releaseAudits(orderId))[0]!.after).toMatchObject({
      thresholdNpr: ONE_PAISA_BELOW,
      releaserRoles: ['management'],
      allowedRoles: ['management', 'founder'],
    });
  });

  it('counts an order with no advance line as released: no Release delivery, nothing to record, and a release is refused', async () => {
    const orderId = await confirmedOrder();
    expect((await detailOf(orderId)).deliveryReleased).toBe(false);

    // The same order with its advance line turned into a milestone: nothing is left for the hold to wait on.
    await withTx(db, scopeA, systemActor('test'), (tx) =>
      tx.execute(sql`UPDATE app.billing_schedule_lines SET trigger = 'milestone'
        WHERE sales_order_id = ${orderId} AND trigger = 'advance'`),
    );

    as('founder', founderUser);
    const detail = await detailOf(orderId);
    expect(detail.deliveryReleased).toBe(true);
    expect(detail.deliveryRelease).toEqual({
      kind: 'no_advance',
      releasedAt: null,
      releasedByName: null,
      reason: null,
    });
    expect(detail.can?.releaseDelivery).toBe(false);
    expect(detail.can?.releaseDeliveryBlockedBy).toBeNull();
    expect(await refusal(release(orderId))).toMatchObject({
      status: 409,
      code: 'delivery_already_released',
    });
    expect(await releaseRows(orderId)).toHaveLength(0);

    // A cancelled order has no delivery to release, so it does not read as released either.
    await withTx(db, scopeA, systemActor('test'), (tx) =>
      tx.execute(
        sql`UPDATE app.sales_orders SET status = 'cancelled', cancelled_at = now(), cancel_reason = 'test' WHERE id = ${orderId}`,
      ),
    );
    const cancelled = await detailOf(orderId);
    expect(cancelled.deliveryReleased).toBe(false);
    expect(cancelled.deliveryRelease).toBeNull();
  });

  it('refuses Management at the threshold and lets the Founder release it', async () => {
    await setThreshold(AMOUNT_NPR);
    const orderId = await confirmedOrder();

    as('management', managementUser);
    expect((await detailOf(orderId)).can?.releaseDelivery).toBe(false);
    // At or below the threshold the order is Finance's (or the Founder's) to release, not Management's.
    expect(await refusal(release(orderId))).toEqual({
      status: 403,
      code: 'forbidden',
      reason: 'role_cannot_release_amount',
    });

    as('founder', founderUser);
    expect((await detailOf(orderId)).can?.releaseDelivery).toBe(true);
    expect(parsed(await release(orderId)).deliveryReleased).toBe(true);
  });

  it('never lets the order creator release it, even as Founder, and lets another Founder release above the threshold', async () => {
    await setThreshold(ONE_PAISA_BELOW);
    const orderId = await confirmedOrder();

    as('founder');
    expect((await detailOf(orderId)).can).toMatchObject({
      releaseDelivery: false,
      releaseDeliveryBlockedBy: 'requester',
      releaseDeliveryAllowedRoles: ['management', 'founder'],
    });
    expect(await refusal(release(orderId))).toEqual({
      status: 403,
      code: 'forbidden',
      reason: 'requester_cannot_release',
    });
    expect(await releaseRows(orderId)).toHaveLength(0);

    as('founder', founderUser);
    expect((await detailOf(orderId)).can?.releaseDelivery).toBe(true);
    expect(parsed(await release(orderId)).deliveryRelease?.kind).toBe('override');

    // The live threshold decides: the row keeps the amount and threshold it was decided with.
    expect(await releaseRows(orderId)).toEqual([
      {
        released_by_user_id: founderUser,
        order_amount_npr: AMOUNT_NPR,
        threshold_npr: ONE_PAISA_BELOW,
      },
    ]);
  });

  it('refuses a draft order, a role without the permission, and an order of another entity or tenant', async () => {
    await setThreshold(AMOUNT_NPR);
    const q = await acceptedQuotation();
    const [draft] = await db.select().from(salesOrders).where(eq(salesOrders.quotationId, q.id));
    expect(draft!.status).toBe('draft');

    as('finance', financeUser);
    expect((await detailOf(draft!.id)).can).toMatchObject({
      releaseDelivery: false,
      releaseDeliveryBlockedBy: null,
      releaseDeliveryAllowedRoles: [],
    });
    expect(await refusal(release(draft!.id))).toMatchObject({
      status: 409,
      code: 'sales_order_not_open',
    });

    const orderId = await confirmedOrder();
    as('accountant', financeUser);
    expect((await detailOf(orderId)).can).toMatchObject({
      releaseDelivery: false,
      releaseDeliveryBlockedBy: 'permission',
      releaseDeliveryAllowedRoles: [],
    });
    expect(await refusal(release(orderId))).toMatchObject({
      status: 403,
      reason: 'no_permission',
    });

    as('finance', financeUser);
    current.scope = scopeB;
    expect(await refusal(release(orderId))).toMatchObject({ status: 404, code: 'not_found' });
    // A Finance user of another tenant, in their own default entity, does not find the order.
    const tenantB = await createTenantWithEntity(appPool);
    const { userId: tenantBUser } = await createStaffUser(appPool, tenantB);
    current.scope = { tenantId: tenantB.tenantId, organizationId: tenantB.organizationId };
    as('finance', tenantBUser);
    expect(await refusal(release(orderId))).toMatchObject({ status: 404, code: 'not_found' });
    current.scope = scopeA;
    expect(await releaseRows(orderId)).toHaveLength(0);
    expect(await releaseRows(draft!.id)).toHaveLength(0);
  });

  it('reads the threshold on the transaction it runs in: detail and release work on a one-connection pool', async () => {
    await setThreshold(AMOUNT_NPR);
    const orderId = await confirmedOrder();
    // One connection, held by withTx: a threshold read that asked the pool for a second one would wait for it
    // forever under load (here: fail after the connection timeout).
    const onePool = new Pool({
      connectionString: testDb.appUrl,
      max: 1,
      connectionTimeoutMillis: 5_000,
    });
    try {
      const oneDb = drizzle({ client: onePool });
      const tight = new SalesOrdersService(
        oneDb,
        new SettingsService(oneDb),
        new NumberingService(),
        new AuditService(oneDb),
        new LedgerService(),
        caller,
        () => NOW,
      );
      as('finance', financeUser);
      expect(SalesOrderDetailSchema.parse(await tight.detail(orderId)).can).toMatchObject({
        releaseDelivery: true,
        releaseDeliveryAllowedRoles: ['finance', 'founder'],
      });
      const after = SalesOrderDetailSchema.parse(
        await tight.releaseDelivery(orderId, { reason: 'Picked up' }, `release-${randomUUID()}`),
      );
      expect(after.deliveryReleased).toBe(true);
      expect(await releaseRows(orderId)).toHaveLength(1);
    } finally {
      await onePool.end();
    }
  });

  it('refuses a change to a release row in the database: a release is final', async () => {
    await setThreshold(AMOUNT_NPR);
    const orderId = await confirmedOrder();
    as('finance', financeUser);
    await release(orderId);
    await expect(
      ownerPool.query(
        `UPDATE app.sales_order_delivery_releases SET reason = 'edited' WHERE sales_order_id = $1`,
        [orderId],
      ),
    ).rejects.toThrow(/final/);
  });
});
