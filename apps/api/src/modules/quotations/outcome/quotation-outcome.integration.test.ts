// Integration tests of the quotation outcome (RecordOutcomeService over QuotationOutcomeService) on a real Postgres
// (Testcontainers, needs Docker in WSL). Real: migrations as bos_owner, queries as bos_app (so every CHECK and
// trigger of 0016 runs, quotation_versions_one_accepted and quotation_versions_rejected_check included),
// SettingsService (sales.evidence_policy at its default, signed_quote), AuditService, OpportunitiesService.markWon
// and markQuotationSent, the idempotency table. Faked: the request context, notify (its calls are asserted; the
// Accountant notices block uses the real NotifyService and directory chain, faking only the outbox queue), and
// authz.assert, which still runs the real pure can() on a fake principal. Quotations are created through
// DraftingService.create on a fresh opportunity each (Won is terminal), then moved to Approved or Sent by raw SQL
// that follows 0016's transition guard, as revise.integration.test.ts does; Sent also moves the opportunity to
// quotation_sent through the real markQuotationSent, as the send unit will.
// Evidence that does not meet the policy answers 422 (`evidence_policy_unmet`): the version is unchanged and
// other evidence would fix it, so it is a request problem, not a state conflict.
// Run: pnpm --filter @bos/api exec vitest run src/modules/quotations/outcome/quotation-outcome.integration.test.ts
import 'reflect-metadata';

import { randomUUID } from 'node:crypto';

import {
  DEFAULT_ROLE_PERMISSIONS,
  type Permission,
  type QuotationDto,
  type RecordOutcomeBody,
  type RoleKey,
  type Scope,
} from '@bos/contracts';
import {
  createStaffUser,
  opportunities,
  quotationAcceptances,
  quotationStatusHistory,
  quotationVersions,
  salesOrders,
  users,
} from '@bos/db';
import { ForbiddenException, HttpException } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { and, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { AuditService } from '../../../platform/audit/audit.service';
import type { AuthzService } from '../../../platform/authz/authz.service';
import { can } from '../../../platform/authz/can';
import type { Principal } from '../../../platform/authz/principal';
import type { CoreConfig } from '../../../platform/config/config';
import { systemActor, withTx, type TxScope } from '../../../platform/db/tx';
import { NotifyService } from '../../../platform/notify/notify.service';
import { CurrencyEnabledService } from '../../../platform/settings/currency-enabled';
import type { MoneyService } from '../../../platform/settings/money.service';
import { NumberingService } from '../../../platform/settings/numbering.service';
import { SettingsService } from '../../../platform/settings/settings.service';
import { UserMirror } from '../../../platform/users/user-mirror';
import { UsersService } from '../../../platform/users/users.service';
import { SqlUsersStore } from '../../../platform/users/users.store';
import { LeadLostReasonsService } from '../../leads/lost-reasons.service';
import { OpportunitiesService } from '../../opportunities/opportunities.service';
import { DraftingService } from '../drafting/drafting.service';
import {
  goldenCreateBody,
  seedQuotationFixture,
  type QuotationFixture,
  type QuotationFixtureDb,
} from '../drafting/quotation.fixture';
import { PricingService } from '../pricing/pricing.service';
import { QuotationOutcomeService } from './quotation-outcome.service';
import { RecordOutcomeService } from './record-outcome.service';
import { createTestDatabase, type TestDatabase } from '@bos/db/testing';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 180_000 });

/** 20 Nov 2026 20:00 UTC is already 21 Nov in Kathmandu; the golden quotation is valid until 9 Dec 2026. */
const NOW = new Date('2026-11-20T20:00:00Z');
const DECIDED_ON = '2026-11-21';

let testDb: TestDatabase;
let ownerPool: Pool;
let appPool: Pool;
let db: QuotationFixtureDb;
let f: QuotationFixture;
let scopeA: TxScope;
let drafting: DraftingService;
let opportunitiesService: OpportunitiesService;
let service: RecordOutcomeService;
let outcomes: QuotationOutcomeService;
let now = NOW;

const grantsOf = (role: RoleKey) =>
  new Map(Object.entries(DEFAULT_ROLE_PERMISSIONS[role])) as Map<Permission, Scope>;
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
  current.scope = scopeA;
  const audit = new AuditService(db);
  drafting = new DraftingService(
    db,
    new NumberingService(),
    new PricingService(money),
    authz as unknown as AuthzService,
    audit,
    caller,
    new CurrencyEnabledService(new SettingsService(db)),
  );
  opportunitiesService = new OpportunitiesService(
    db,
    authz as unknown as AuthzService,
    audit,
    caller,
    new LeadLostReasonsService(db, audit, caller),
  );
  outcomes = new QuotationOutcomeService(
    new SettingsService(db),
    opportunitiesService,
    notify as unknown as NotifyService,
    audit,
    () => now,
  );
  service = new RecordOutcomeService(
    db,
    outcomes,
    authz as unknown as AuthzService,
    notify as unknown as NotifyService,
    caller,
  );
});

afterAll(async () => {
  await appPool?.end();
  await ownerPool?.end();
  await testDb?.drop();
});

beforeEach(() => {
  now = NOW;
  current.scope = scopeA;
  current.grants = grantsOf('sales');
  notify.notifyUser.mockClear();
  notify.notifyRole.mockClear();
  notify.nudge.mockClear();
});

// ---------------------------------------------------------------------------------------- helpers

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
        name: 'Acme website',
        customerId: f.customerPartyId,
        ownerUserId: f.ownerUserId,
        stage: 'qualified',
      })
      .returning({ id: opportunities.id }),
  );
  return row!.id;
}

async function createQuotation(): Promise<QuotationDto> {
  const opportunityId = await seedOpportunity();
  return drafting.create(goldenCreateBody(f, { opportunityId }), `create-${randomUUID()}`);
}

const versionRow = async (id: string) => {
  const [row] = await db.select().from(quotationVersions).where(eq(quotationVersions.id, id));
  return row!;
};

const opportunityRow = async (id: string) => {
  const [row] = await db.select().from(opportunities).where(eq(opportunities.id, id));
  return row!;
};

const acceptanceRows = (versionId: string) =>
  db.select().from(quotationAcceptances).where(eq(quotationAcceptances.versionId, versionId));

/** Moves a draft along 0016's transitions up to `target`; Sent also moves the opportunity to quotation_sent. */
async function advance(q: QuotationDto, target: 'approved' | 'sent'): Promise<number> {
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
    if (target === 'sent') {
      await tx.execute(
        sql`UPDATE app.quotation_versions SET status = 'sent', sent_at = now(), version = version + 1
             WHERE id = ${versionId}`,
      );
      await opportunitiesService.markQuotationSent(tx, q.opportunityId);
    }
  });
  return (await versionRow(versionId)).version;
}

const acceptBody = (
  expectedVersion: number,
  overrides: Partial<RecordOutcomeBody> = {},
): RecordOutcomeBody => ({
  outcome: 'accepted',
  decidedOn: DECIDED_ON,
  evidenceKinds: ['signed_quote'],
  expectedVersion,
  ...overrides,
});

/** A live, scanned-clean evidence document in the quotation's entity: acceptance now refuses an id that is not one. */
const cleanDocument = (): Promise<string> =>
  withTx(db, scopeA, systemActor('test'), async (tx) => {
    const { rows } = await tx.execute(
      sql`INSERT INTO app.documents (tenant_id, organization_id, owner_type, owner_id)
          VALUES (${scopeA.tenantId}, ${scopeA.organizationId}, 'test_evidence', ${randomUUID()}) RETURNING id`,
    );
    const id = (rows[0] as { id: string }).id;
    await tx.execute(
      sql`INSERT INTO app.document_versions (tenant_id, organization_id, document_id, version, filename,
            declared_mime, size_bytes, storage_key, status)
          VALUES (${scopeA.tenantId}, ${scopeA.organizationId}, ${id}, 1, 'signed.pdf',
                  'application/pdf', 1024, ${`${scopeA.tenantId}/${randomUUID()}`}, 'clean')`,
    );
    return id;
  });

const record = (q: QuotationDto, body: RecordOutcomeBody, key = `outcome-${randomUUID()}`) =>
  service.record(q.id, q.currentVersionId, body, key);

// ------------------------------------------------------------------------------------------ outcome

describe('RecordOutcomeService.record', () => {
  it('accepts a Sent version: Accepted, an acceptance row, the opportunity Won with this version, the owner told', async () => {
    const q = await createQuotation();
    const expectedVersion = await advance(q, 'sent');

    const dto = await record(q, acceptBody(expectedVersion, { comment: 'Signed copy attached' }));

    expect(dto).toMatchObject({
      versionId: q.currentVersionId,
      outcome: 'accepted',
      actorKind: 'staff',
      actorId: f.ownerUserId,
      decidedOn: DECIDED_ON,
      evidenceKinds: ['signed_quote'],
    });
    const version = await versionRow(q.currentVersionId);
    expect(version).toMatchObject({ status: 'accepted', version: expectedVersion + 1 });
    expect(version.acceptedAt).not.toBeNull();
    expect(await acceptanceRows(q.currentVersionId)).toEqual([
      expect.objectContaining({
        outcome: 'accepted',
        actorKind: 'staff',
        evidenceKinds: ['signed_quote'],
        comment: 'Signed copy attached',
      }),
    ]);
    expect(await opportunityRow(q.opportunityId)).toMatchObject({
      stage: 'won',
      wonQuotationVersionId: q.currentVersionId,
    });
    const history = await db
      .select()
      .from(quotationStatusHistory)
      .where(eq(quotationStatusHistory.versionId, q.currentVersionId));
    expect(history).toContainEqual(
      expect.objectContaining({ fromStatus: 'sent', toStatus: 'accepted', actorId: f.ownerUserId }),
    );
    expect(notify.notifyUser).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        userId: f.ownerUserId,
        link: `/quotations/${q.id}`,
        dedupeKey: `quotation.accepted:${q.currentVersionId}`,
        email: expect.objectContaining({ template: 'quotation.accepted' }) as unknown,
      }),
    );
    expect(notify.nudge).toHaveBeenCalledTimes(1);
  });

  it('stores the evidence document ids on the acceptance row and returns them from the column', async () => {
    const q = await createQuotation();
    const expectedVersion = await advance(q, 'sent');
    const docA = await cleanDocument();
    const docB = await cleanDocument();

    const dto = await record(q, acceptBody(expectedVersion, { evidenceDocumentIds: [docA, docB] }));

    expect(dto.evidenceDocumentIds).toEqual([docA, docB]);
    expect(dto.acceptedByName).toBeNull();
    const [row] = await acceptanceRows(q.currentVersionId);
    expect(row).toMatchObject({ evidenceDocumentIds: [docA, docB], acceptedByName: null });
  });

  it('refuses an evidence file the scan found infected with 409 document_infected; the version stays Sent (TR-Q12e)', async () => {
    const q = await createQuotation();
    const expectedVersion = await advance(q, 'sent');
    const documentId = await withTx(db, scopeA, systemActor('test'), async (tx) => {
      const { rows } = await tx.execute(
        sql`INSERT INTO app.documents (tenant_id, organization_id, owner_type, owner_id)
            VALUES (${scopeA.tenantId}, ${scopeA.organizationId}, 'test_evidence', ${randomUUID()}) RETURNING id`,
      );
      const id = (rows[0] as { id: string }).id;
      await tx.execute(
        sql`INSERT INTO app.document_versions (tenant_id, organization_id, document_id, version, filename,
              declared_mime, size_bytes, storage_key, status)
            VALUES (${scopeA.tenantId}, ${scopeA.organizationId}, ${id}, 1, 'signed.pdf',
                    'application/pdf', 1024, ${`${scopeA.tenantId}/${randomUUID()}`}, 'infected')`,
      );
      return id;
    });

    await expect(
      record(q, acceptBody(expectedVersion, { evidenceDocumentIds: [documentId] })),
    ).rejects.toMatchObject({ status: 409, response: { code: 'document_infected' } });
    expect((await versionRow(q.currentVersionId)).status).toBe('sent');
    expect(await acceptanceRows(q.currentVersionId)).toEqual([]);
  });

  it('refuses a removed evidence file with 422 invalid_evidence_document, as evidence confirmation does', async () => {
    const q = await createQuotation();
    const expectedVersion = await advance(q, 'sent');
    const documentId = await withTx(db, scopeA, systemActor('test'), async (tx) => {
      const { rows } = await tx.execute(
        sql`INSERT INTO app.documents (tenant_id, organization_id, owner_type, owner_id, removed_at)
            VALUES (${scopeA.tenantId}, ${scopeA.organizationId}, 'test_evidence', ${randomUUID()}, now())
            RETURNING id`,
      );
      return (rows[0] as { id: string }).id;
    });

    await expect(
      record(q, acceptBody(expectedVersion, { evidenceDocumentIds: [documentId] })),
    ).rejects.toMatchObject({ status: 422, response: { code: 'invalid_evidence_document' } });
    expect((await versionRow(q.currentVersionId)).status).toBe('sent');
    expect(await acceptanceRows(q.currentVersionId)).toEqual([]);
  });

  it('stores the name the customer signed with and the ids when the core is called directly (the portal path)', async () => {
    const q = await createQuotation();
    await advance(q, 'sent');
    const doc = await cleanDocument();

    const dto = await withTx(db, scopeA, systemActor('test'), (tx) =>
      outcomes.accept(tx, {
        versionId: q.currentVersionId,
        actorKind: 'customer_user',
        actorUserId: f.ownerUserId,
        decidedOn: DECIDED_ON,
        acceptedByName: 'Sita Sharma',
        evidenceKinds: ['signed_quote'],
        evidenceDocumentIds: [doc],
      }),
    );

    expect(dto.evidenceDocumentIds).toEqual([doc]);
    expect(dto.acceptedByName).toBe('Sita Sharma');
    expect(await acceptanceRows(q.currentVersionId)).toEqual([
      expect.objectContaining({
        actorKind: 'customer_user',
        acceptedByName: 'Sita Sharma',
        evidenceDocumentIds: [doc],
      }),
    ]);
  });

  it('refuses a signer name over 200 characters (the table CHECK) and keeps the version Sent', async () => {
    const q = await createQuotation();
    await advance(q, 'sent');

    await expect(
      withTx(db, scopeA, systemActor('test'), (tx) =>
        outcomes.accept(tx, {
          versionId: q.currentVersionId,
          actorKind: 'customer_user',
          actorUserId: f.ownerUserId,
          decidedOn: DECIDED_ON,
          acceptedByName: 'x'.repeat(201),
          evidenceKinds: ['signed_quote'],
        }),
      ),
    ).rejects.toThrow();
    expect((await versionRow(q.currentVersionId)).status).toBe('sent');
    expect(await acceptanceRows(q.currentVersionId)).toEqual([]);
  });

  it('keeps the acceptance append-only: the new columns cannot be rewritten afterwards', async () => {
    const q = await createQuotation();
    const expectedVersion = await advance(q, 'sent');
    await record(q, acceptBody(expectedVersion, { evidenceDocumentIds: [await cleanDocument()] }));

    await expect(
      withTx(db, scopeA, systemActor('test'), (tx) =>
        tx.execute(
          sql`UPDATE app.quotation_acceptances SET evidence_document_ids = '{}' WHERE version_id = ${q.currentVersionId}`,
        ),
      ),
    ).rejects.toMatchObject({ cause: { constraint: 'quotation_acceptances_append_only' } });
  });

  it('answers 422 to evidence the policy (signed_quote by default) does not accept, and changes nothing', async () => {
    const q = await createQuotation();
    const expectedVersion = await advance(q, 'sent');

    expect(
      await statusOf(record(q, acceptBody(expectedVersion, { evidenceKinds: ['purchase_order'] }))),
    ).toEqual({ status: 422, code: 'evidence_policy_unmet' });
    expect(await versionRow(q.currentVersionId)).toMatchObject({ status: 'sent' });
    expect(await acceptanceRows(q.currentVersionId)).toEqual([]);
    expect(await opportunityRow(q.opportunityId)).toMatchObject({ stage: 'quotation_sent' });
  });

  it('rejects a Sent version as the customer: Rejected with source customer, a rejection row, no Won', async () => {
    const q = await createQuotation();
    const expectedVersion = await advance(q, 'sent');

    const dto = await record(q, {
      outcome: 'rejected',
      decidedOn: DECIDED_ON,
      comment: 'Went with another vendor',
      evidenceKinds: [],
      expectedVersion,
    });

    expect(dto).toMatchObject({ outcome: 'rejected', comment: 'Went with another vendor' });
    const version = await versionRow(q.currentVersionId);
    expect(version).toMatchObject({ status: 'rejected', rejectionSource: 'customer' });
    expect(version.rejectedAt).not.toBeNull();
    expect(await acceptanceRows(q.currentVersionId)).toEqual([
      expect.objectContaining({ outcome: 'rejected', comment: 'Went with another vendor' }),
    ]);
    expect(await opportunityRow(q.opportunityId)).toMatchObject({ stage: 'quotation_sent' });
    expect(notify.notifyUser).not.toHaveBeenCalled();
  });

  it('answers 409 to an acceptance dated after valid_until, and changes nothing', async () => {
    const q = await createQuotation();
    const expectedVersion = await advance(q, 'sent');
    now = new Date('2026-12-15T06:00:00Z');

    expect(
      await statusOf(record(q, acceptBody(expectedVersion, { decidedOn: '2026-12-10' }))),
    ).toEqual({ status: 409, code: 'quotation_expired' });
    expect(await versionRow(q.currentVersionId)).toMatchObject({ status: 'sent' });
    expect(await acceptanceRows(q.currentVersionId)).toEqual([]);
  });

  it('answers 422 to a decision dated after today in Kathmandu', async () => {
    const q = await createQuotation();
    const expectedVersion = await advance(q, 'sent');

    expect(
      await statusOf(record(q, acceptBody(expectedVersion, { decidedOn: '2026-11-22' }))),
    ).toEqual({ status: 422, code: 'decided_on_in_future' });
  });

  it('answers 409 to accepting an Approved (not yet Sent) version, which the database alone would allow', async () => {
    const q = await createQuotation();
    const expectedVersion = await advance(q, 'approved');

    expect(await statusOf(record(q, acceptBody(expectedVersion)))).toEqual({
      status: 409,
      code: 'quotation_not_sent',
    });
    expect(await versionRow(q.currentVersionId)).toMatchObject({ status: 'approved' });
    expect(await acceptanceRows(q.currentVersionId)).toEqual([]);
  });

  it('answers 409 to a second acceptance under a new key, and replays the first under the same key', async () => {
    const q = await createQuotation();
    const expectedVersion = await advance(q, 'sent');
    const key = `outcome-${randomUUID()}`;
    const first = await record(q, acceptBody(expectedVersion), key);

    await expect(record(q, acceptBody(expectedVersion), key)).resolves.toEqual(first);
    expect(await statusOf(record(q, acceptBody(expectedVersion + 1)))).toEqual({
      status: 409,
      code: 'quotation_not_sent',
    });
    expect(await acceptanceRows(q.currentVersionId)).toHaveLength(1);
    expect(notify.nudge).toHaveBeenCalledTimes(1);
  });

  it('answers 409 to a stale expectedVersion, and changes nothing', async () => {
    const q = await createQuotation();
    const expectedVersion = await advance(q, 'sent');

    expect(await statusOf(record(q, acceptBody(expectedVersion - 1)))).toEqual({
      status: 409,
      code: 'conflict',
    });
    expect(await versionRow(q.currentVersionId)).toMatchObject({ status: 'sent' });
  });

  it('answers 404 for a quotation of another entity, and changes nothing', async () => {
    const q = await createQuotation();
    const expectedVersion = await advance(q, 'sent');
    current.scope = { tenantId: f.tenantId, organizationId: f.otherEntityId };

    expect(await statusOf(record(q, acceptBody(expectedVersion)))).toEqual({
      status: 404,
      code: 'not_found',
    });
    current.scope = scopeA;
    expect(await versionRow(q.currentVersionId)).toMatchObject({ status: 'sent' });
    expect(await acceptanceRows(q.currentVersionId)).toEqual([]);
  });

  it('answers 404 for a version id that belongs to another quotation', async () => {
    const q = await createQuotation();
    const other = await createQuotation();
    const expectedVersion = await advance(other, 'sent');

    expect(
      await statusOf(
        service.record(
          q.id,
          other.currentVersionId,
          acceptBody(expectedVersion),
          `outcome-${randomUUID()}`,
        ),
      ),
    ).toEqual({ status: 404, code: 'not_found' });
    expect(await versionRow(other.currentVersionId)).toMatchObject({ status: 'sent' });
  });
});

// ------------------------------------------------------------------------------- Accountant notices

describe('Accountant and Finance notices on acceptance (S4: a drafted order, pending portal evidence)', () => {
  let accountantUserId: string;
  let financeUserId: string;
  let bothRolesUserId: string;
  let noticed: RecordOutcomeService;
  let noticedOutcomes: QuotationOutcomeService;

  beforeAll(async () => {
    const [owner] = await db
      .select({ idpOrgId: users.idpOrgId })
      .from(users)
      .where(and(eq(users.tenantId, f.tenantId), eq(users.id, f.ownerUserId)));
    const staff = (roleKeys: readonly string[]) =>
      createStaffUser(appPool, { ...scopeA, idpOrgId: owner!.idpOrgId, roleKeys });
    accountantUserId = (await staff(['accountant'])).userId;
    financeUserId = (await staff(['finance'])).userId;
    // Holds both roles that can confirm a draft order: it is told once, not twice.
    bothRolesUserId = (await staff(['accountant', 'finance'])).userId;
    // Another role holder of the same entity, next to the role-less owner: neither may get these notices.
    await staff(['sales']);
    // The real directory chain, so the role lookup reads app.user_roles; ZITADEL and audit are never reached.
    const store = new SqlUsersStore(db);
    const directory = new UsersService(
      new UserMirror(db, store, {} as never, {} as never),
      store,
      {} as never,
      db,
      {} as never,
    );
    const realNotify = new NotifyService(
      db,
      {
        WORKSPACE_PUBLIC_URL: 'https://app.example.test',
        PORTAL_PUBLIC_URL: 'https://portal.example.test',
      } as CoreConfig,
      directory,
      { add: vi.fn(() => Promise.resolve()) } as unknown as Queue,
    );
    noticedOutcomes = new QuotationOutcomeService(
      new SettingsService(db),
      opportunitiesService,
      realNotify,
      new AuditService(db),
      () => now,
    );
    noticed = new RecordOutcomeService(
      db,
      noticedOutcomes,
      authz as unknown as AuthzService,
      realNotify,
      caller,
    );
  });

  const bellRows = async (dedupeKey: string) =>
    (
      await appPool.query<{ user_id: string; link: string }>(
        'SELECT user_id, link FROM app.notifications WHERE tenant_id = $1 AND dedupe_key = $2',
        [f.tenantId, dedupeKey],
      )
    ).rows.sort((a, b) => a.user_id.localeCompare(b.user_id));

  const byUser = (rows: readonly { user_id: string; link: string }[]) =>
    [...rows].sort((a, b) => a.user_id.localeCompare(b.user_id));

  const draftOrderId = async (quotationId: string) => {
    const rows = await db
      .select({ id: salesOrders.id })
      .from(salesOrders)
      .where(eq(salesOrders.quotationId, quotationId));
    expect(rows).toHaveLength(1);
    return rows[0]!.id;
  };

  it('a portal acceptance tells Accountants and Finance of the drafted order, and the Accountants of the evidence to confirm', async () => {
    const q = await createQuotation();
    await advance(q, 'sent');

    await withTx(db, scopeA, systemActor('test'), (tx) =>
      noticedOutcomes.accept(tx, {
        versionId: q.currentVersionId,
        actorKind: 'customer_user',
        actorUserId: f.ownerUserId,
        decidedOn: DECIDED_ON,
        acceptedByName: 'Sita Sharma',
        evidenceKinds: ['signed_quote'],
      }),
    );

    const orderId = await draftOrderId(q.id);
    // One bell row each: the Accountant, the Finance user and the user holding both roles (once, not twice).
    expect(await bellRows(`sales_order.drafted:${orderId}`)).toEqual(
      byUser(
        [accountantUserId, financeUserId, bothRolesUserId].map((user_id) => ({
          user_id,
          link: `/sales-orders/${orderId}`,
        })),
      ),
    );
    // The evidence notice stays with the Accountants (Finance is not told).
    expect(await bellRows(`quotation.evidence_pending:${q.currentVersionId}`)).toEqual(
      byUser(
        [accountantUserId, bothRolesUserId].map((user_id) => ({
          user_id,
          link: `/quotations/${q.id}`,
        })),
      ),
    );
  });

  it('a staff acceptance tells Accountants and Finance of the drafted order only (its evidence is confirmed on entry), once on a replay', async () => {
    const q = await createQuotation();
    const expectedVersion = await advance(q, 'sent');
    const key = `outcome-${randomUUID()}`;

    await noticed.record(q.id, q.currentVersionId, acceptBody(expectedVersion), key);
    await noticed.record(q.id, q.currentVersionId, acceptBody(expectedVersion), key);

    const orderId = await draftOrderId(q.id);
    // One bell row each: the Accountant, the Finance user and the user holding both roles (once, not twice).
    expect(await bellRows(`sales_order.drafted:${orderId}`)).toEqual(
      byUser(
        [accountantUserId, financeUserId, bothRolesUserId].map((user_id) => ({
          user_id,
          link: `/sales-orders/${orderId}`,
        })),
      ),
    );
    expect(await bellRows(`quotation.evidence_pending:${q.currentVersionId}`)).toEqual([]);
  });
});
