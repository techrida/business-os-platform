// Integration tests of CancelService.cancel (F1-Q27) on a real Postgres (Testcontainers, needs Docker in WSL).
// Real: migrations as bos_owner, queries as bos_app (so the CHECKs and the version guard of 0016 run, including
// quotation_versions_cancel_reason_check), DraftingService.create, AuditService, and ApprovalsService.cancel on a
// pending request seeded by SQL. Faked: the request context, notify and the user directory (cancel uses neither),
// and authz.assert, which still runs the real pure can() on a fake principal. The round trip with a real submit
// and approver is in approval/quotation-approval.integration.test.ts.
// Run: pnpm --filter @bos/api exec vitest run src/modules/quotations/drafting/cancel.integration.test.ts
import 'reflect-metadata';

import { randomUUID } from 'node:crypto';

import {
  DEFAULT_ROLE_PERMISSIONS,
  QuotationVersionDtoSchema,
  type Permission,
  type QuotationDto,
  type RoleKey,
  type Scope,
} from '@bos/contracts';
import {
  approvalRequests,
  opportunities,
  outbox,
  quotations,
  quotationStatusHistory,
  quotationVersions,
} from '@bos/db';
import { ForbiddenException, HttpException } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { AuditService } from '../../../platform/audit/audit.service';
import type { AuthzService } from '../../../platform/authz/authz.service';
import { can } from '../../../platform/authz/can';
import type { Principal } from '../../../platform/authz/principal';
import type { UserDirectory } from '../../../platform/authz/user-directory';
import type { CoreConfig } from '../../../platform/config/config';
import { systemActor, withTx, type TxScope } from '../../../platform/db/tx';
import { NotifyService } from '../../../platform/notify/notify.service';
import { CurrencyEnabledService } from '../../../platform/settings/currency-enabled';
import type { MoneyService } from '../../../platform/settings/money.service';
import { NumberingService } from '../../../platform/settings/numbering.service';
import { SettingsService } from '../../../platform/settings/settings.service';
import { ApprovalsService } from '../../approvals/requests.service';
import { LeadLostReasonsService } from '../../leads/lost-reasons.service';
import type { OpportunityLostHandler } from '../../opportunities/opportunities.ports';
import { OpportunitiesService } from '../../opportunities/opportunities.service';
import { PricingService } from '../pricing/pricing.service';
import { QUOTATION_OWNER_TYPE } from '../quotation-owner.policy';
import { QuotationLostHandler } from '../lost/quotation-lost.handler';
import { CancelService } from './cancel.service';
import { DraftingService } from './drafting.service';
import {
  goldenCreateBody,
  seedOtherStaffUser,
  seedQuotationFixture,
  type QuotationFixture,
  type QuotationFixtureDb,
} from './quotation.fixture';
import { createTestDatabase, type TestDatabase } from '@bos/db/testing';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 180_000 });

const NOW = new Date('2026-11-20T20:00:00Z');
const REASON = 'Customer chose another supplier';

let testDb: TestDatabase;
let ownerPool: Pool;
let appPool: Pool;
let db: QuotationFixtureDb;
let f: QuotationFixture;
let scopeA: TxScope;
let drafting: DraftingService;
let approvals: ApprovalsService;
let service: CancelService;

const grantsOf = (role: RoleKey) =>
  new Map(Object.entries(DEFAULT_ROLE_PERMISSIONS[role])) as Map<Permission, Scope>;
/** The acting entity and grants of the fake caller; beforeEach resets both. */
const current: { scope: TxScope; grants: Map<Permission, Scope> } = {
  scope: { tenantId: '', organizationId: '' },
  grants: grantsOf('sales'),
};

const principalNow = (): Principal => ({
  userId: f.ownerUserId,
  zitadelUserId: `z-${f.ownerUserId}`,
  ...current.scope,
  orgKind: 'staff',
  partyId: null,
  idpOrgId: 'unused',
  roles: [],
  departmentId: null,
  status: 'active',
  grants: current.grants,
});
const caller = {
  current: () => ({
    scope: current.scope,
    actor: { kind: 'user' as const, id: f.ownerUserId, correlationId: 'test-corr' },
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
const onCancelled = vi.fn((_tx: unknown, _documentId: string, _reason: string) =>
  Promise.resolve(),
);

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
  current.scope = scopeA;
  const audit = new AuditService(db);
  const pricing = new PricingService(money);
  drafting = new DraftingService(
    db,
    new NumberingService(),
    pricing,
    authz as unknown as AuthzService,
    audit,
    caller,
    new CurrencyEnabledService(new SettingsService(db)),
  );
  approvals = new ApprovalsService(
    db,
    audit,
    { notifyUser: vi.fn(), notifyRole: vi.fn() },
    {} as unknown as UserDirectory,
    caller,
    () => NOW,
  );
  // The quotation subject belongs to the submit unit; cancel() calls the subject's hook, so the test registers one.
  approvals.registerSubject({
    documentType: QUOTATION_OWNER_TYPE,
    onDecided: () => Promise.resolve(),
    onCancelled,
  });
  service = new CancelService(
    db,
    approvals,
    authz as unknown as AuthzService,
    audit,
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
  onCancelled.mockClear();
});

// ---------------------------------------------------------------------------------------- helpers

async function statusOf(promise: Promise<unknown>): Promise<number> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof HttpException) return error.getStatus();
    throw error;
  }
  throw new Error('expected the call to fail');
}

const createQuotation = (): Promise<QuotationDto> =>
  drafting.create(goldenCreateBody(f), `create-${randomUUID()}`);

const versionRow = async (id: string) => {
  const [row] = await db.select().from(quotationVersions).where(eq(quotationVersions.id, id));
  return row!;
};

const parentRow = async (id: string) => {
  const [row] = await db.select().from(quotations).where(eq(quotations.id, id));
  return row!;
};

/**
 * Moves a draft version along 0016's transitions up to `target`, one statement per step as the service units
 * will: the submit statement writes both snapshot hashes (32 bytes) with the status, and each step bumps the row
 * version. `approvalRequestId` is set in the submit statement, as submit links its request.
 */
async function advance(
  versionId: string,
  target: 'submitted' | 'approved' | 'sent',
  approvalRequestId: string | null = null,
): Promise<number> {
  await withTx(db, scopeA, systemActor('test'), async (tx) => {
    await tx.execute(
      sql`UPDATE app.quotation_versions
             SET status = 'submitted', submitted_at = now(), version = version + 1,
                 content_sha256 = sha256('content'::bytea), snapshot_sha256 = sha256('snapshot'::bytea),
                 approval_request_id = ${approvalRequestId}
           WHERE id = ${versionId}`,
    );
    if (target === 'submitted') return;
    await tx.execute(
      sql`UPDATE app.quotation_versions SET status = 'approved', approved_at = now(), version = version + 1
           WHERE id = ${versionId}`,
    );
    if (target === 'sent') {
      await tx.execute(
        sql`UPDATE app.quotation_versions SET status = 'sent', sent_at = now(), version = version + 1
             WHERE id = ${versionId}`,
      );
    }
  });
  return (await versionRow(versionId)).version;
}

/** A pending approval request on `versionId` (workflow definition and version included), as submit leaves it. */
async function seedPendingRequest(versionId: string, number: string): Promise<string> {
  return withTx(db, scopeA, systemActor('test'), async (tx) => {
    const { rows: def } = await tx.execute<{ id: string }>(
      sql`INSERT INTO app.workflow_definitions (tenant_id, organization_id, key, name, document_type)
          VALUES (${f.tenantId}, ${f.entityId}, ${`quotation-${randomUUID()}`}, 'Quotation',
                  ${`${QUOTATION_OWNER_TYPE}-${randomUUID()}`})
          RETURNING id`,
    );
    const { rows: ver } = await tx.execute<{ id: string }>(
      sql`INSERT INTO app.workflow_versions (tenant_id, organization_id, definition_id, version, spec)
          VALUES (${f.tenantId}, ${f.entityId}, ${def[0]!.id}, 1, '{}')
          RETURNING id`,
    );
    const { rows: req } = await tx.execute<{ id: string }>(
      sql`INSERT INTO app.approval_requests (tenant_id, organization_id, definition_id, workflow_version_id,
            document_type, document_id, document_number, title, snapshot, snapshot_sha256, facts,
            requester_user_id, sod_user_ids, status, current_seq)
          VALUES (${f.tenantId}, ${f.entityId}, ${def[0]!.id}, ${ver[0]!.id}, ${QUOTATION_OWNER_TYPE},
                  ${versionId}, ${number}, 'Quotation', '{}', sha256('snapshot'::bytea), '{}',
                  ${f.ownerUserId}, ${`{${f.ownerUserId}}`}::uuid[], 'pending', 1)
          RETURNING id`,
    );
    return req[0]!.id;
  });
}

// ------------------------------------------------------------------------------------------ cancel

const cancel = (q: QuotationDto, expectedVersion: number, key = `cancel-${randomUUID()}`) =>
  service.cancel(q.id, { reason: REASON, expectedVersion }, key);

const historyOf = (versionId: string) =>
  db.select().from(quotationStatusHistory).where(eq(quotationStatusHistory.versionId, versionId));

describe('CancelService.cancel (F1-Q27)', () => {
  it('cancels a Draft with its reason, history, audit event, and stays the current version', async () => {
    const q = await createQuotation();
    const before = await versionRow(q.currentVersionId);
    const parentBefore = await parentRow(q.id);

    const dto = QuotationVersionDtoSchema.parse(await cancel(q, before.version));

    expect(dto).toMatchObject({
      id: q.currentVersionId,
      status: 'cancelled',
      cancelReason: REASON,
      cancelledAt: NOW.toISOString(),
    });
    expect(await versionRow(q.currentVersionId)).toMatchObject({
      status: 'cancelled',
      cancelReason: REASON,
      version: before.version + 1,
    });
    const parent = await parentRow(q.id);
    expect(parent.currentVersionId).toBe(q.currentVersionId);
    expect(parent.version).toBe(parentBefore.version + 1);
    expect(await historyOf(q.currentVersionId)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          fromStatus: 'draft',
          toStatus: 'cancelled',
          reason: REASON,
          actorId: f.ownerUserId,
        }),
      ]),
    );
    const { rows: audit } = await ownerPool.query<{ action: string }>(
      `SELECT action FROM audit.audit_events WHERE tenant_id = $1 AND entity_id = $2 ORDER BY id`,
      [f.tenantId, q.id],
    );
    expect(audit.map((r) => r.action)).toContain('quotation.cancelled');
  });

  it('cancels a Returned version', async () => {
    const q = await createQuotation();
    await advance(q.currentVersionId, 'submitted');
    await withTx(db, scopeA, systemActor('test'), (tx) =>
      tx.execute(
        sql`UPDATE app.quotation_versions SET status = 'returned', version = version + 1
             WHERE id = ${q.currentVersionId}`,
      ),
    );
    const before = await versionRow(q.currentVersionId);
    expect(before.status).toBe('returned');
    expect((await cancel(q, before.version)).status).toBe('cancelled');
  });

  it('cancels a Submitted version and its pending approval request, with the same reason', async () => {
    const q = await createQuotation();
    const requestId = await seedPendingRequest(q.currentVersionId, q.number);
    const expectedVersion = await advance(q.currentVersionId, 'submitted', requestId);

    const dto = await cancel(q, expectedVersion);

    expect(dto).toMatchObject({ status: 'cancelled', approvalRequestId: requestId });
    const [request] = await db
      .select()
      .from(approvalRequests)
      .where(eq(approvalRequests.id, requestId));
    expect(request).toMatchObject({ status: 'cancelled' });
    expect(onCancelled).toHaveBeenCalledTimes(1);
    expect(onCancelled.mock.calls[0]!.slice(1)).toEqual([q.currentVersionId, REASON]);
    expect(await historyOf(q.currentVersionId)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ fromStatus: 'submitted', toStatus: 'cancelled', reason: REASON }),
      ]),
    );
  });

  it('answers 409 for an Approved or Sent version, and changes nothing', async () => {
    for (const target of ['approved', 'sent'] as const) {
      const q = await createQuotation();
      const expectedVersion = await advance(q.currentVersionId, target);
      expect(await statusOf(cancel(q, expectedVersion))).toBe(409);
      expect(await versionRow(q.currentVersionId)).toMatchObject({
        status: target,
        version: expectedVersion,
        cancelReason: null,
      });
    }
  });

  it('answers 409 for a stale expectedVersion, keeping the pending request open', async () => {
    const q = await createQuotation();
    const requestId = await seedPendingRequest(q.currentVersionId, q.number);
    const expectedVersion = await advance(q.currentVersionId, 'submitted', requestId);
    expect(await statusOf(cancel(q, expectedVersion - 1))).toBe(409);
    expect(await versionRow(q.currentVersionId)).toMatchObject({ status: 'submitted' });
    const [request] = await db
      .select({ status: approvalRequests.status })
      .from(approvalRequests)
      .where(eq(approvalRequests.id, requestId));
    expect(request!.status).toBe('pending');
    expect(onCancelled).not.toHaveBeenCalled();
  });

  it('answers 409 when the revision the caller looked at is no longer the current one, and cancels nothing', async () => {
    const q = await createQuotation();
    const { version } = await versionRow(q.currentVersionId);
    const staleVersionId = randomUUID();
    const status = await statusOf(
      service.cancel(
        q.id,
        { reason: REASON, expectedVersion: version, versionId: staleVersionId },
        `cancel-${randomUUID()}`,
      ),
    );
    expect(status).toBe(409);
    expect(await versionRow(q.currentVersionId)).toMatchObject({
      status: 'draft',
      cancelReason: null,
    });
    // The same call naming the real current revision goes through.
    const ok = await service.cancel(
      q.id,
      { reason: REASON, expectedVersion: version, versionId: q.currentVersionId },
      `cancel-${randomUUID()}`,
    );
    expect(QuotationVersionDtoSchema.parse(ok).status).toBe('cancelled');
  });

  it('returns the first answer to a retry with the same Idempotency-Key, and cancels once', async () => {
    const q = await createQuotation();
    const { version } = await versionRow(q.currentVersionId);
    const key = `cancel-${randomUUID()}`;
    const first = await cancel(q, version, key);
    const again = await cancel(q, version, key);
    expect(again).toEqual(first);
    const rows = (await historyOf(q.currentVersionId)).filter((h) => h.toStatus === 'cancelled');
    expect(rows).toHaveLength(1);
  });

  it("answers 404 for another entity or a colleague's quotation under own scope, 403 without quotation.draft", async () => {
    const q = await createQuotation();
    const { version } = await versionRow(q.currentVersionId);

    current.scope = { tenantId: f.tenantId, organizationId: f.otherEntityId };
    expect(await statusOf(cancel(q, version))).toBe(404);
    current.scope = scopeA;

    current.grants = grantsOf('warehouse');
    expect(await statusOf(cancel(q, version))).toBe(403);
    current.grants = grantsOf('sales');

    await withTx(db, scopeA, systemActor('test'), (tx) =>
      tx.execute(sql`UPDATE app.quotations SET owner_user_id = NULL WHERE id = ${q.id}`),
    );
    expect(await statusOf(cancel(q, version))).toBe(404);
    expect(await versionRow(q.currentVersionId)).toMatchObject({ status: 'draft', version });
  });
});

// ------------------------------------------------------------------------------------ Lost opportunity

describe('the Lost cascade (QuotationLostHandler)', () => {
  const lostActor = () => ({
    kind: 'user' as const,
    id: f.ownerUserId,
    correlationId: 'lost-corr',
  });
  const lose = (opportunityId: string, afterHandler?: () => never) =>
    withTx(db, scopeA, lostActor(), async (tx) => {
      await new QuotationLostHandler(service).onLost(tx, {
        opportunityId,
        scope: scopeA,
        actor: lostActor(),
        reason: 'Price',
        note: 'went elsewhere',
      });
      afterHandler?.();
    });
  const auditCancels = async (quotationId: string) =>
    (
      await new AuditService(db).list(scopeA, {
        entityType: 'quotations',
        entityId: quotationId,
        limit: 50,
      })
    ).filter((e) => e.action === 'quotation.cancelled');
  const opportunityInA = async (): Promise<string> => {
    const [row] = await withTx(db, scopeA, systemActor('test'), (tx) =>
      tx
        .insert(opportunities)
        .values({
          ...scopeA,
          number: `DEAL-${randomUUID().slice(0, 8)}`,
          name: 'Another deal',
          customerId: f.customerPartyId,
          ownerUserId: f.ownerUserId,
          stage: 'qualified',
        })
        .returning({ id: opportunities.id }),
    );
    return row!.id;
  };

  it('cancels a draft, a submitted (with its approval request), an approved and a sent version, with reason, history and audit', async () => {
    const opportunityId = await opportunityInA();
    const mk = () => drafting.create(goldenCreateBody(f, { opportunityId }), `c-${randomUUID()}`);
    const draft = await mk();
    const submitted = await mk();
    const approved = await mk();
    const sent = await mk();
    const requestId = await seedPendingRequest(submitted.currentVersionId, submitted.number);
    await advance(submitted.currentVersionId, 'submitted', requestId);
    await advance(approved.currentVersionId, 'approved');
    await advance(sent.currentVersionId, 'sent');

    await lose(opportunityId);

    for (const q of [draft, submitted, approved, sent]) {
      const v = await versionRow(q.currentVersionId);
      expect(v.status, q.number).toBe('cancelled');
      expect(v.cancelReason).toBe('Opportunity marked lost: Price');
      const h = (await historyOf(q.currentVersionId)).filter((x) => x.toStatus === 'cancelled');
      expect(h).toHaveLength(1);
      expect(h[0]).toMatchObject({
        actorId: f.ownerUserId,
        reason: 'Opportunity marked lost: Price',
      });
      const events = await auditCancels(q.id);
      expect(events).toHaveLength(1);
      expect(events[0]!.meta).toMatchObject({ cause: 'opportunity_lost' });
    }
    const [request] = await db
      .select()
      .from(approvalRequests)
      .where(eq(approvalRequests.id, requestId));
    expect(request!.status).toBe('cancelled');
  });

  it('leaves an accepted quotation, an already cancelled one, and a quotation of another opportunity as they are', async () => {
    const opportunityId = await opportunityInA();
    const accepted = await drafting.create(
      goldenCreateBody(f, { opportunityId }),
      `c-${randomUUID()}`,
    );
    await advance(accepted.currentVersionId, 'sent');
    await withTx(db, scopeA, systemActor('test'), (tx) =>
      tx.execute(
        sql`UPDATE app.quotation_versions SET status = 'accepted', accepted_at = now(), version = version + 1
             WHERE id = ${accepted.currentVersionId}`,
      ),
    );
    const already = await drafting.create(
      goldenCreateBody(f, { opportunityId }),
      `c-${randomUUID()}`,
    );
    const { version } = await versionRow(already.currentVersionId);
    await cancel(already, version);
    const otherDeal = await createQuotation();
    const before = await versionRow(already.currentVersionId);

    await lose(opportunityId);

    expect((await versionRow(accepted.currentVersionId)).status).toBe('accepted');
    expect(await versionRow(already.currentVersionId)).toMatchObject({
      status: 'cancelled',
      version: before.version,
      cancelReason: REASON,
    });
    expect((await versionRow(otherDeal.currentVersionId)).status).toBe('draft');
  });

  it('rolls the cancellations back when the transaction fails after the handler', async () => {
    const opportunityId = await opportunityInA();
    const q = await drafting.create(goldenCreateBody(f, { opportunityId }), `c-${randomUUID()}`);
    await expect(
      lose(opportunityId, () => {
        throw new Error('the loss could not be recorded');
      }),
    ).rejects.toThrow('the loss could not be recorded');
    expect((await versionRow(q.currentVersionId)).status).toBe('draft');
  });

  it('drops a cancelled Sent version\'s still-pending "ready to review" mail, and leaves claimed, sent and unrelated mail alone', async () => {
    // The real producer: QuotationSendService queues this mail through notifyEmail with these fields.
    const notify = new NotifyService(
      db,
      {
        WORKSPACE_PUBLIC_URL: 'https://workspace.example.com',
        PORTAL_PUBLIC_URL: 'https://portal.example.com',
      } as CoreConfig,
      {} as unknown as UserDirectory,
      {} as Queue,
    );
    const queueSentMail = (q: QuotationDto) =>
      withTx(db, scopeA, systemActor('test'), (tx) =>
        notify.notifyEmail(tx, {
          toEmail: 'buyer@example.test',
          template: 'quotation.sent',
          data: {
            quotationNumber: q.number,
            customerName: 'Himal Traders',
            validUntil: '2026-12-09',
            linkPath: `/quotations/${q.currentVersionId}`,
          },
          dedupeKey: `quotation.sent:${q.currentVersionId}`,
        }),
      );
    const setMailStatus = (q: QuotationDto, status: 'sending' | 'sent') =>
      withTx(db, scopeA, systemActor('test'), (tx) =>
        tx.execute(
          status === 'sending'
            ? sql`UPDATE app.outbox SET status = 'sending', claimed_at = now()
                   WHERE dedupe_key = ${`quotation.sent:${q.currentVersionId}`}`
            : sql`UPDATE app.outbox SET status = 'sent', sent_at = now()
                   WHERE dedupe_key = ${`quotation.sent:${q.currentVersionId}`}`,
        ),
      );
    const mailOf = async (q: QuotationDto) =>
      (
        await withTx(db, scopeA, systemActor('test'), (tx) =>
          tx
            .select({ status: outbox.status })
            .from(outbox)
            .where(eq(outbox.dedupeKey, `quotation.sent:${q.currentVersionId}`)),
        )
      ).map((r) => r.status);

    const opportunityId = await opportunityInA();
    const mk = () => drafting.create(goldenCreateBody(f, { opportunityId }), `c-${randomUUID()}`);
    const pending = await mk();
    const claimed = await mk();
    const delivered = await mk();
    const otherDeal = await createQuotation();
    for (const q of [pending, claimed, delivered, otherDeal]) {
      await advance(q.currentVersionId, 'sent');
      await queueSentMail(q);
    }
    await setMailStatus(claimed, 'sending');
    await setMailStatus(delivered, 'sent');
    expect(await mailOf(pending)).toEqual(['pending']);

    await lose(opportunityId);

    for (const q of [pending, claimed, delivered]) {
      expect((await versionRow(q.currentVersionId)).status, q.number).toBe('cancelled');
    }
    expect(await mailOf(pending)).toEqual([]);
    expect(await mailOf(claimed)).toEqual(['sending']);
    expect(await mailOf(delivered)).toEqual(['sent']);
    expect(await mailOf(otherDeal)).toEqual(['pending']);
  });

  it('through the real changeStage route: the manager who marks the deal lost is the actor, a failing cascade keeps it open, and the quotation is cancelled with the lost reason', async () => {
    const manager = await seedOtherStaffUser(db, f);
    const routeCaller = {
      current: () => ({
        scope: scopeA,
        actor: { kind: 'user' as const, id: manager, correlationId: 'route-corr' },
        principal: {
          ...principalNow(),
          userId: manager,
          zitadelUserId: `z-${manager}`,
          level: 'manager',
          grants: grantsOf('founder'),
        } as Principal,
      }),
    };
    const routeAuthz = {
      assert: (action: Permission, ref?: Parameters<typeof can>[2]) => {
        const d = can(routeCaller.current().principal, action, ref);
        if (!d.allowed) throw new ForbiddenException({ code: 'forbidden', reason: d.reason });
      },
    };
    const audit = new AuditService(db);
    const build = (handler: OpportunityLostHandler | undefined) => {
      const svc = new OpportunitiesService(
        db,
        routeAuthz as unknown as AuthzService,
        audit,
        routeCaller,
        new LeadLostReasonsService(db, audit, routeCaller),
      );
      svc.registerLostHandler(handler ?? new QuotationLostHandler(service));
      return svc;
    };
    const opportunityId = await opportunityInA();
    const q = await drafting.create(goldenCreateBody(f, { opportunityId }), `c-${randomUUID()}`);
    await advance(q.currentVersionId, 'sent');
    const stage = async () => {
      const [row] = await db
        .select()
        .from(opportunities)
        .where(eq(opportunities.id, opportunityId));
      return row!;
    };
    const body = (expectedVersion: number) => ({
      stage: 'lost' as const,
      newLostReason: 'Went with a rival',
      note: 'Signed elsewhere',
      expectedVersion,
    });

    const failing = build({
      name: 'quotations.cancel',
      onLost: (tx, e) =>
        new QuotationLostHandler(service)
          .onLost(tx, e)
          .then(() => Promise.reject(new Error('a later handler failed'))),
    });
    const before = await stage();
    await expect(failing.changeStage(opportunityId, body(before.version))).rejects.toThrow(
      'a later handler failed',
    );
    expect((await stage()).stage).toBe('qualified');
    expect((await versionRow(q.currentVersionId)).status).toBe('sent');

    await build(undefined).changeStage(opportunityId, body(before.version));
    expect((await stage()).stage).toBe('lost');
    expect(await versionRow(q.currentVersionId)).toMatchObject({
      status: 'cancelled',
      cancelReason: 'Opportunity marked lost: Went with a rival',
    });
    const history = (await historyOf(q.currentVersionId)).filter((h) => h.toStatus === 'cancelled');
    expect(history).toEqual([expect.objectContaining({ actorId: manager, fromStatus: 'sent' })]);
    const events = await auditCancels(q.id);
    expect(events).toEqual([expect.objectContaining({ actorId: manager })]);
  });
});
