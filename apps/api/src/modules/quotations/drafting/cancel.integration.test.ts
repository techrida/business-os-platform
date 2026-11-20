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
  quotations,
  quotationStatusHistory,
  quotationVersions,
  runMigrations,
} from '@bos/db';
import { ForbiddenException, HttpException } from '@nestjs/common';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { eq, sql } from 'drizzle-orm';
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
  goldenCreateBody,
  seedQuotationFixture,
  type QuotationFixture,
  type QuotationFixtureDb,
} from './quotation.fixture';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 180_000 });

const OWNER_PW = 'owner-test-pw';
const APP_PW = 'app-test-pw';
const NOW = new Date('2026-11-20T20:00:00Z');
const REASON = 'Customer chose another supplier';

let container: StartedPostgreSqlContainer;
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

const urlFor = (user: string, password: string, database: string) => {
  const url = new URL(container.getConnectionUri());
  url.username = user;
  url.password = password;
  url.pathname = `/${database}`;
  return url.toString();
};

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
  await container?.stop();
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
