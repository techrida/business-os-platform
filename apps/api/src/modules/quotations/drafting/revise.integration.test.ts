// Integration tests of ReviseService.revise on a real Postgres (Testcontainers, needs Docker in WSL).
// Real: migrations as bos_owner, queries as bos_app (so every CHECK and trigger of 0016 runs, one_live_version
// and the transition guard included), PricingService (NPR only), SettingsService (quotation.validity_days at its
// default of 15), AuditService, and ApprovalsService.cancel on a pending request seeded by SQL. Faked: the request
// context, notify and the user directory (cancel uses neither), and authz.assert, which still runs the real pure
// can() on a fake principal. Quotations are created through DraftingService.create, then moved to Approved or
// Sent by raw SQL that follows 0016's transition guard (draft -> submitted -> approved -> sent) and writes the
// snapshot hashes in the submit statement, as quotation_versions_snapshot_check requires.
// Run: pnpm --filter @bos/api exec vitest run src/modules/quotations/drafting/revise.integration.test.ts
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
  quotationLines,
  quotations,
  quotationStatusHistory,
  quotationVersions,
} from '@bos/db';
import {
  ConflictException,
  ForbiddenException,
  HttpException,
  NotFoundException,
} from '@nestjs/common';
import { asc, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { AuditService } from '../../../platform/audit/audit.service';
import type { AuthzService } from '../../../platform/authz/authz.service';
import { can } from '../../../platform/authz/can';
import type { Principal } from '../../../platform/authz/principal';
import type { UserDirectory } from '../../../platform/authz/user-directory';
import { systemActor, withTx, type TxScope } from '../../../platform/db/tx';
import { CurrencyEnabledService } from '../../../platform/settings/currency-enabled';
import type { MoneyService } from '../../../platform/settings/money.service';
import { NumberingService } from '../../../platform/settings/numbering.service';
import { SettingsService } from '../../../platform/settings/settings.service';
import { ApprovalsService } from '../../approvals/requests.service';
import { PricingService } from '../pricing/pricing.service';
import { QUOTATION_OWNER_TYPE } from '../quotation-owner.policy';
import { CancelService } from './cancel.service';
import { DraftingService } from './drafting.service';
import {
  GOLDEN_INTERNAL_COST,
  GOLDEN_TOTALS,
  goldenCostedLines,
  goldenCreateBody,
  seedQuotationFixture,
  type QuotationFixture,
  type QuotationFixtureDb,
} from './quotation.fixture';
import { ReviseService } from './revise.service';
import { createTestDatabase, type TestDatabase } from '@bos/db/testing';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 180_000 });

/** 20 Nov 2026 20:00 UTC is already 21 Nov in Kathmandu (UTC+05:45): the new issue date is the Nepal day. */
const NOW = new Date('2026-11-20T20:00:00Z');
const NEW_ISSUE_DATE = '2026-11-21';
/** NEW_ISSUE_DATE plus the default quotation.validity_days (15): a revision's date once the old one has passed. */
const NEW_VALID_UNTIL = '2026-12-06';
/** The golden version's valid-until date, still ahead on NEW_ISSUE_DATE, so a revision keeps it (TR-Q12g). */
const KEPT_VALID_UNTIL = '2026-12-09';
const REASON = 'Customer asked for a second phase';

let testDb: TestDatabase;
let ownerPool: Pool;
let appPool: Pool;
let db: QuotationFixtureDb;
let f: QuotationFixture;
let scopeA: TxScope;
let drafting: DraftingService;
let approvals: ApprovalsService;
let service: ReviseService;
let cancelService: CancelService;

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
  cancelService = new CancelService(
    db,
    approvals,
    authz as unknown as AuthzService,
    audit,
    caller,
    () => NOW,
  );
  service = new ReviseService(
    db,
    pricing,
    new SettingsService(db),
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

const createQuotation = (validUntil?: string): Promise<QuotationDto> =>
  drafting.create(
    { ...goldenCreateBody(f), ...(validUntil === undefined ? {} : { validUntil }) },
    `create-${randomUUID()}`,
  );

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
  target: 'approved' | 'sent',
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

// ------------------------------------------------------------------------------------------ revise

describe('ReviseService.revise', () => {
  it('revises an Approved version into a Draft revision 2 and supersedes the old one, links both ways', async () => {
    const q = await createQuotation();
    const oldId = q.currentVersionId;
    const expectedVersion = await advance(oldId, 'approved');

    const dto = QuotationVersionDtoSchema.parse(
      await service.revise(q.id, { reason: REASON, expectedVersion }, `revise-${randomUUID()}`),
    );

    expect(dto).toMatchObject({
      quotationId: q.id,
      number: q.number,
      revisionNo: 2,
      status: 'draft',
      customerId: f.customerPartyId,
      currency: 'NPR',
      issueDate: NEW_ISSUE_DATE,
      validUntil: KEPT_VALID_UNTIL,
      supersedesVersionId: oldId,
      supersededByVersionId: null,
      revisionReason: REASON,
      discount: { mode: 'pct', value: '8' },
      approvalRequestId: null,
      snapshotSha256: null,
      totals: GOLDEN_TOTALS,
    });
    expect(dto.lines.map((l) => l.description)).toEqual(['Implementation', 'Licences', 'Training']);

    const old = await versionRow(oldId);
    expect(old).toMatchObject({ status: 'superseded', supersededByVersionId: dto.id });
    expect((await parentRow(q.id)).currentVersionId).toBe(dto.id);

    const lines = await db
      .select()
      .from(quotationLines)
      .where(eq(quotationLines.versionId, dto.id))
      .orderBy(asc(quotationLines.lineNo));
    expect(lines).toHaveLength(3);

    const history = await db
      .select()
      .from(quotationStatusHistory)
      .where(eq(quotationStatusHistory.reason, REASON));
    expect(history.filter((h) => h.versionId === oldId || h.versionId === dto.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          versionId: oldId,
          fromStatus: 'approved',
          toStatus: 'superseded',
          actorId: f.ownerUserId,
        }),
        expect.objectContaining({
          versionId: dto.id,
          fromStatus: null,
          toStatus: 'draft',
          actorId: f.ownerUserId,
        }),
      ]),
    );

    const { rows: audit } = await ownerPool.query<{ action: string }>(
      `SELECT action FROM audit.audit_events WHERE tenant_id = $1 AND entity_id = $2 ORDER BY id`,
      [f.tenantId, q.id],
    );
    expect(audit.map((r) => r.action)).toContain('quotation.revised');
  });

  it('keeps the previous valid-until date while it has not passed, the issue day itself included (TR-Q12g)', async () => {
    for (const validUntil of [KEPT_VALID_UNTIL, NEW_ISSUE_DATE]) {
      const q = await createQuotation(validUntil);
      const expectedVersion = await advance(q.currentVersionId, 'sent');
      const dto = await service.revise(
        q.id,
        { reason: REASON, expectedVersion },
        `revise-${randomUUID()}`,
      );
      expect(dto).toMatchObject({ issueDate: NEW_ISSUE_DATE, validUntil });
      expect((await versionRow(dto.id)).validUntil).toBe(validUntil);
    }
  });

  it('gives the configured default once the previous valid-until date has passed (TR-Q12g)', async () => {
    const q = await createQuotation('2026-11-20');
    const expectedVersion = await advance(q.currentVersionId, 'approved');
    const dto = await service.revise(
      q.id,
      { reason: REASON, expectedVersion },
      `revise-${randomUUID()}`,
    );
    expect(dto).toMatchObject({ issueDate: NEW_ISSUE_DATE, validUntil: NEW_VALID_UNTIL });
  });

  it('returns the first answer to a retry with the same Idempotency-Key, and revises once', async () => {
    const q = await createQuotation();
    const expectedVersion = await advance(q.currentVersionId, 'approved');
    const key = `revise-${randomUUID()}`;
    const first = await service.revise(q.id, { reason: REASON, expectedVersion }, key);
    const second = await service.revise(q.id, { reason: REASON, expectedVersion }, key);
    expect(second.id).toBe(first.id);
    const versions = await db
      .select({ id: quotationVersions.id })
      .from(quotationVersions)
      .where(eq(quotationVersions.quotationId, q.id));
    expect(versions).toHaveLength(2);
  });

  it('omits the cost figures from the answer of a caller without quotation.cost.read, and replays them in full for one who has it (D29b)', async () => {
    const q = await drafting.create(
      goldenCreateBody(f, { lines: goldenCostedLines(f) }),
      `create-${randomUUID()}`,
    );
    const expectedVersion = await advance(q.currentVersionId, 'approved');
    const key = `revise-${randomUUID()}`;

    const noCost = new Map(current.grants);
    noCost.delete('quotation.cost.read');
    current.grants = noCost;
    const hidden = QuotationVersionDtoSchema.parse(
      await service.revise(q.id, { reason: REASON, expectedVersion }, key),
    );
    expect('internalCostTotal' in hidden).toBe(false);
    expect('marginPct' in hidden).toBe(false);
    for (const line of hidden.lines) expect('unitCost' in line).toBe(false);

    // The stored answer is full: the same retry as a caller who may read costs shows them.
    current.grants = grantsOf('sales');
    const shown = QuotationVersionDtoSchema.parse(
      await service.revise(q.id, { reason: REASON, expectedVersion }, key),
    );
    expect(shown.id).toBe(hidden.id);
    expect(shown.internalCostTotal).toBe(GOLDEN_INTERNAL_COST);
    expect(shown.marginPct).not.toBeNull();
    expect(shown.lines.map((l) => l.unitCost)).toEqual(['1000000.00', '400000.00', '20000.00']);
  });

  it('answers 409 for a Draft current version, and changes nothing', async () => {
    const q = await createQuotation();
    const before = await versionRow(q.currentVersionId);
    expect(
      await statusOf(
        service.revise(
          q.id,
          { reason: REASON, expectedVersion: before.version },
          `revise-${randomUUID()}`,
        ),
      ),
    ).toBe(409);
    expect(await versionRow(q.currentVersionId)).toMatchObject({
      status: 'draft',
      version: before.version,
      supersededByVersionId: null,
    });
    expect((await parentRow(q.id)).currentVersionId).toBe(q.currentVersionId);
  });

  it('revises a Sent version, which becomes Superseded', async () => {
    const q = await createQuotation();
    const expectedVersion = await advance(q.currentVersionId, 'sent');
    const dto = await service.revise(
      q.id,
      { reason: REASON, expectedVersion },
      `revise-${randomUUID()}`,
    );
    expect(dto).toMatchObject({ revisionNo: 2, status: 'draft' });
    expect(await versionRow(q.currentVersionId)).toMatchObject({
      status: 'superseded',
      supersededByVersionId: dto.id,
    });
    const all = await db
      .select()
      .from(quotationStatusHistory)
      .where(eq(quotationStatusHistory.versionId, q.currentVersionId));
    expect(all).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ fromStatus: 'sent', toStatus: 'superseded', reason: REASON }),
      ]),
    );
  });

  it('cancels an approval request still pending on the current version, with the revise reason', async () => {
    const q = await createQuotation();
    const requestId = await seedPendingRequest(q.currentVersionId, q.number);
    const expectedVersion = await advance(q.currentVersionId, 'approved', requestId);

    const dto = await service.revise(
      q.id,
      { reason: REASON, expectedVersion },
      `revise-${randomUUID()}`,
    );

    const [request] = await db
      .select()
      .from(approvalRequests)
      .where(eq(approvalRequests.id, requestId));
    expect(request).toMatchObject({ status: 'cancelled', version: 2 });
    expect(request!.decidedAt).not.toBeNull();
    expect(onCancelled).toHaveBeenCalledTimes(1);
    expect(onCancelled.mock.calls[0]!.slice(1)).toEqual([q.currentVersionId, REASON]);
    expect(dto).toMatchObject({ revisionNo: 2, approvalRequestId: null });
  });

  it('leaves a decided approval request alone', async () => {
    const q = await createQuotation();
    const requestId = await seedPendingRequest(q.currentVersionId, q.number);
    await withTx(db, scopeA, systemActor('test'), (tx) =>
      tx.execute(
        sql`UPDATE app.approval_requests SET status = 'approved', decided_at = now(), version = 2
             WHERE id = ${requestId}`,
      ),
    );
    const expectedVersion = await advance(q.currentVersionId, 'approved', requestId);
    await service.revise(q.id, { reason: REASON, expectedVersion }, `revise-${randomUUID()}`);
    const [request] = await db
      .select()
      .from(approvalRequests)
      .where(eq(approvalRequests.id, requestId));
    expect(request!.status).toBe('approved');
    expect(onCancelled).not.toHaveBeenCalled();
  });

  it('answers 409 for a stale expectedVersion, and changes nothing', async () => {
    const q = await createQuotation();
    const expectedVersion = await advance(q.currentVersionId, 'approved');
    await expect(
      service.revise(
        q.id,
        { reason: REASON, expectedVersion: expectedVersion - 1 },
        `revise-${randomUUID()}`,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(await versionRow(q.currentVersionId)).toMatchObject({
      status: 'approved',
      version: expectedVersion,
      supersededByVersionId: null,
    });
    expect((await parentRow(q.id)).currentVersionId).toBe(q.currentVersionId);
  });

  it('answers 404 for a quotation of another entity, and changes nothing', async () => {
    const q = await createQuotation();
    const expectedVersion = await advance(q.currentVersionId, 'approved');
    current.scope = { tenantId: f.tenantId, organizationId: f.otherEntityId };
    await expect(
      service.revise(q.id, { reason: REASON, expectedVersion }, `revise-${randomUUID()}`),
    ).rejects.toBeInstanceOf(NotFoundException);
    current.scope = scopeA;
    expect(await versionRow(q.currentVersionId)).toMatchObject({ status: 'approved' });
  });

  it('answers 404 for a quotation the caller neither owns nor may revise for others', async () => {
    const q = await createQuotation();
    const expectedVersion = await advance(q.currentVersionId, 'approved');
    // Own scope with another owner: out of scope, which must read as "not found", not "forbidden".
    await withTx(db, scopeA, systemActor('test'), (tx) =>
      tx.execute(sql`UPDATE app.quotations SET owner_user_id = NULL WHERE id = ${q.id}`),
    );
    expect(
      await statusOf(
        service.revise(q.id, { reason: REASON, expectedVersion }, `revise-${randomUUID()}`),
      ),
    ).toBe(404);
  });
});

// ------------------------------------------------------------------------------------ Lost deal

/**
 * Resolves once `pending` waits on a row lock in this database (or has already settled, as code that takes no lock
 * does), so the test commits the blocking transaction only after the call queued behind it.
 */
async function queuedBehindLock(pending: Promise<unknown>): Promise<void> {
  let settled = false;
  pending.then(
    () => (settled = true),
    () => (settled = true),
  );
  for (let i = 0; i < 200 && !settled; i++) {
    const { rows } = await ownerPool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
        WHERE NOT l.granted AND a.datname = current_database()`,
    );
    if (rows[0]!.n > 0) return;
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('ReviseService.revise on a Lost deal', () => {
  /**
   * A quotation on its own deal whose Sent version has Expired: the Lost cascade cancels only live versions, so an
   * expired one stays revisable unless revise itself checks the deal.
   */
  const expiredOnOwnDeal = async (): Promise<{
    q: QuotationDto;
    dealId: string;
    version: number;
  }> => {
    const [deal] = await withTx(db, scopeA, systemActor('test'), (tx) =>
      tx
        .insert(opportunities)
        .values({
          ...scopeA,
          number: `DEAL-${randomUUID().slice(0, 8)}`,
          name: 'Deal that is lost',
          customerId: f.customerPartyId,
          ownerUserId: f.ownerUserId,
          stage: 'quotation_sent',
        })
        .returning({ id: opportunities.id }),
    );
    const q = await drafting.create(
      goldenCreateBody(f, { opportunityId: deal!.id }),
      `create-${randomUUID()}`,
    );
    await advance(q.currentVersionId, 'sent');
    await withTx(db, scopeA, systemActor('test'), (tx) =>
      tx.execute(
        sql`UPDATE app.quotation_versions SET status = 'expired', version = version + 1
             WHERE id = ${q.currentVersionId}`,
      ),
    );
    return { q, dealId: deal!.id, version: (await versionRow(q.currentVersionId)).version };
  };
  /** Mark Lost's write to the deal row: stage, its reason and note, the row version. */
  const markLostSql = (id: string) =>
    sql`UPDATE app.opportunities
           SET stage = 'lost', stage_reason = 'Price', stage_note = 'Went elsewhere', version = version + 1
         WHERE id = ${id}`;

  it('revises an expired version while the deal is open', async () => {
    const { q, version } = await expiredOnOwnDeal();
    const dto = await service.revise(
      q.id,
      { reason: REASON, expectedVersion: version },
      `revise-${randomUUID()}`,
    );
    expect(dto).toMatchObject({ revisionNo: 2, status: 'draft' });
  });

  it('answers 409 once the deal is Lost, and adds no revision', async () => {
    const { q, dealId, version } = await expiredOnOwnDeal();
    await withTx(db, scopeA, systemActor('test'), (tx) => tx.execute(markLostSql(dealId)));
    const error = await service
      .revise(q.id, { reason: REASON, expectedVersion: version }, `revise-${randomUUID()}`)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConflictException);
    expect(JSON.stringify((error as ConflictException).getResponse())).toContain(
      'This deal is Lost; a quotation on it cannot be revised',
    );
    expect(await versionRow(q.currentVersionId)).toMatchObject({ status: 'expired', version });
    expect((await parentRow(q.id)).currentVersionId).toBe(q.currentVersionId);
  });

  it('answers 404, not the Lost 409, to a caller out of scope of the quotation, and adds no revision', async () => {
    const { q, dealId, version } = await expiredOnOwnDeal();
    await withTx(db, scopeA, systemActor('test'), async (tx) => {
      await tx.execute(markLostSql(dealId));
      // Own scope with another owner: out of scope, so the caller must not learn that the deal is Lost.
      await tx.execute(sql`UPDATE app.quotations SET owner_user_id = NULL WHERE id = ${q.id}`);
    });
    current.grants = new Map(grantsOf('sales')).set('quotation.revise', 'own');
    const error = await service
      .revise(q.id, { reason: REASON, expectedVersion: version }, `revise-${randomUUID()}`)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NotFoundException);
    expect(await versionRow(q.currentVersionId)).toMatchObject({ status: 'expired', version });
    expect((await parentRow(q.id)).currentVersionId).toBe(q.currentVersionId);
    const versions = await db
      .select({ id: quotationVersions.id })
      .from(quotationVersions)
      .where(eq(quotationVersions.quotationId, q.id));
    expect(versions).toHaveLength(1);
  });

  it('refuses a revise queued behind Mark Lost once Mark Lost commits', async () => {
    const { q, dealId, version } = await expiredOnOwnDeal();
    let revise!: Promise<unknown>;
    await withTx(db, scopeA, systemActor('test'), async (tx) => {
      await tx.execute(sql`SELECT id FROM app.opportunities WHERE id = ${dealId} FOR UPDATE`);
      await tx.execute(markLostSql(dealId));
      revise = service.revise(
        q.id,
        { reason: REASON, expectedVersion: version },
        `revise-${randomUUID()}`,
      );
      await queuedBehindLock(revise);
    });
    expect(await statusOf(revise)).toBe(409);
    expect((await parentRow(q.id)).currentVersionId).toBe(q.currentVersionId);
  });
});

// ------------------------------------------------------------------------------ cancel a revision (R6D restore)

describe('cancelling an unsent revision gives the replaced version back', () => {
  const reviseFrom = async (target: 'approved' | 'sent') => {
    const q = await createQuotation();
    const expectedVersion = await advance(q.currentVersionId, target);
    const v2 = await service.revise(
      q.id,
      { reason: REASON, expectedVersion },
      `revise-${randomUUID()}`,
    );
    return { q, v1Id: q.currentVersionId, v2 };
  };
  const cancelRevision = async (q: QuotationDto, v2: { id: string }) =>
    cancelService.cancel(
      q.id,
      {
        reason: 'The change is not needed',
        expectedVersion: (await versionRow(v2.id)).version,
        versionId: v2.id,
      },
      `cancel-${randomUUID()}`,
    );

  it.each(['sent', 'approved'] as const)(
    'restores a %s version as the live, current version, with a history row and an audit event',
    async (target) => {
      const { q, v1Id, v2 } = await reviseFrom(target);
      expect(await versionRow(v1Id)).toMatchObject({ status: 'superseded' });

      await cancelRevision(q, v2);

      expect(await versionRow(v2.id)).toMatchObject({ status: 'cancelled' });
      expect(await versionRow(v1Id)).toMatchObject({
        status: target,
        supersededByVersionId: null,
      });
      expect((await parentRow(q.id)).currentVersionId).toBe(v1Id);
      const history = await db
        .select()
        .from(quotationStatusHistory)
        .where(eq(quotationStatusHistory.versionId, v1Id));
      expect(history).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ fromStatus: 'superseded', toStatus: target }),
        ]),
      );
      const { rows: audits } = await ownerPool.query(
        `SELECT 1 FROM audit.audit_events WHERE action = 'quotation.restored' AND entity_id = $1`,
        [q.id],
      );
      expect(audits).toHaveLength(1);
    },
  );

  it('lets the restored version be revised again: the cancelled revision keeps its number', async () => {
    const { q, v1Id, v2 } = await reviseFrom('sent');
    await cancelRevision(q, v2);
    const again = await service.revise(
      q.id,
      { reason: REASON, expectedVersion: (await versionRow(v1Id)).version },
      `revise-${randomUUID()}`,
    );
    expect(again).toMatchObject({ revisionNo: 3, status: 'draft' });
    expect(await versionRow(v1Id)).toMatchObject({
      status: 'superseded',
      supersededByVersionId: again.id,
    });
  });

  it('keeps the valid-until date, so a restored version that is past it expires in the normal sweep', async () => {
    const { q, v1Id, v2 } = await reviseFrom('sent');
    const before = (await versionRow(v1Id)).validUntil;
    await cancelRevision(q, v2);
    expect((await versionRow(v1Id)).validUntil).toBe(before);
  });

  it('does not restore anything when Mark Lost cancels the revision: the deal is over', async () => {
    const { q, v1Id } = await reviseFrom('sent');
    await withTx(db, scopeA, systemActor('test'), async (tx) => {
      const [row] = await tx
        .select({ opportunityId: quotations.opportunityId })
        .from(quotations)
        .where(eq(quotations.id, q.id));
      await cancelService.cancelOnLost(
        tx,
        scopeA,
        { kind: 'user', id: f.ownerUserId, correlationId: 'lost' },
        row!.opportunityId,
        'Price',
      );
    });
    expect(await versionRow(v1Id)).toMatchObject({ status: 'superseded' });
  });
});
