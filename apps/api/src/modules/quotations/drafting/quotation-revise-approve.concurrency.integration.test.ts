// Concurrency test: the approver decides the final step of a quotation's approval while its owner revises the
// quotation, at the same moment, on a real Postgres (the shared test database of @bos/db/testing).
// Real: migrations as bos_owner, queries as bos_app, DraftingService.create, QuotationSubmitService, the real
// ApprovalsService with the seed's quotation_version workflow (accountant -> finance for NPR 50,000), the real
// QuotationVersionSubject, ReviseService and AuditService (so the audit_capture triggers and the tenant's audit chain
// lock run). Faked: notify, the user directory and the request context. Each actor has its own fixed caller and authz.
//
// A submitted version cannot be revised, so revise loses every round: with a 409 for the submitted status when it
// locks first, or for a stale expectedVersion when the approve commits first. It still takes its locks before it
// can tell: the Idempotency-Key claim (an audited INSERT, so the tenant's audit-chain lock), the quotation, then the
// approval request (revise.service.ts:191-194). Without withTx's lock-first default, the approve takes the request
// first (requests.service.ts lockRequest) and the audit lock only at its first audited write.
//
// Each round: a fresh draft, submitted, the accountant step approved; then the finance approve and the owner's revise
// race, each in its own transaction on its own connection, with a 0-10 ms start offset on either side. One extra round
// forces the interleaving: a third connection holds the audit-chain lock, revise starts and waits on it, approve
// starts and waits on it too (with the 'lazy' order: at its first audited write, holding the request), then the lock
// is released to revise.
//
// Desired behaviour (the assertions): no error that is not a clean HTTP answer (no 40P01 deadlock, no 55P03), the
// approve wins every round, the revise gets 409, and the rows agree (version and request approved, no new revision).
// RACE_TX_AUDIT=lazy runs every withTx with `audit: 'lazy'` (the lock order before the lock-first default) to show
// what the default prevents.
// Run: pnpm --filter @bos/api exec vitest run src/modules/quotations/drafting/quotation-revise-approve.concurrency.integration.test.ts
import 'reflect-metadata';

import { randomUUID } from 'node:crypto';

import {
  DEFAULT_ROLE_PERMISSIONS,
  type CreateQuotationBody,
  type Permission,
  type RoleKey,
  type Scope,
} from '@bos/contracts';
import { approvalRequests, createStaffUser, quotationVersions, users } from '@bos/db';
import { createTestDatabase, type TestDatabase } from '@bos/db/testing';
import { ForbiddenException } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
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
} from '../../../../test/support/race';
import { asSecondPerson, SKIP_LIVE_PUBLISHER_CHECK } from '../../../../test/support/second-person';
import { AuditService } from '../../../platform/audit/audit.service';
import type { AuthzService } from '../../../platform/authz/authz.service';
import { can } from '../../../platform/authz/can';
import type { Principal } from '../../../platform/authz/principal';
import type { UserDirectory } from '../../../platform/authz/user-directory';
import type { DbTransaction } from '../../../platform/db/db.module';
import { systemActor, withTx, type TxScope } from '../../../platform/db/tx';
import { CurrencyEnabledService } from '../../../platform/settings/currency-enabled';
import type { MoneyService } from '../../../platform/settings/money.service';
import { NumberingService } from '../../../platform/settings/numbering.service';
import { SettingsService } from '../../../platform/settings/settings.service';
import { ApprovalsAdminService } from '../../approvals/admin.service';
import { ApprovalsService } from '../../approvals/requests.service';
import { QuotationSubmitService, QuotationSubmitStore } from '../approval/quotation-submit.service';
import {
  QUOTATION_VERSION_DOCUMENT_TYPE,
  QuotationVersionSubject,
} from '../approval/quotation-version.subject';
import { PricingService } from '../pricing/pricing.service';
import { DraftingService } from './drafting.service';
import {
  GOLDEN_ISSUE_DATE,
  seedQuotationFixture,
  type QuotationFixture,
  type QuotationFixtureDb,
} from './quotation.fixture';
import { ReviseService } from './revise.service';

vi.mock('../../../platform/db/tx', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../platform/db/tx')>();
  if (process.env.RACE_TX_AUDIT !== 'lazy') return real;
  const withTx: typeof real.withTx = (db, scope, actor, fn, options) =>
    real.withTx(db, scope, actor, fn, { audit: 'lazy', ...options });
  return { ...real, withTx };
});

vi.setConfig({ testTimeout: 600_000, hookTimeout: 180_000 });

const ROUNDS = 32;
const REASON = 'Customer asked for a second phase';
const now = new Date('2026-11-09T04:00:00Z');

// The base route of the seed's quotation_version workflow, as in quotation-approve-cancel.concurrency.integration.test.ts.
const WORKFLOW_SPEC: unknown = {
  documentType: 'quotation_version',
  steps: [
    {
      id: 'accountant',
      kind: 'role',
      role: 'accountant',
      reason: 'Base route: accountant checks the quotation',
    },
    { id: 'finance', kind: 'role', role: 'finance', reason: 'Base route: finance approves' },
  ],
  rules: [],
  distinctApprovers: true,
  sla: { remindAfterHours: 24, escalateAfterHours: 72, escalateTo: { role: 'founder' } },
};

let testDb: TestDatabase;
let ownerPool: Pool;
let appPool: Pool;
let db: QuotationFixtureDb;
let f: QuotationFixture;
let scopeA: TxScope;

const U = { acc: '', fin: '', mgmt: '', founder: '', admin: '' };
const roles: Partial<Record<RoleKey, string[]>> = {};

const grantsOf = (role: RoleKey) =>
  new Map(Object.entries(DEFAULT_ROLE_PERMISSIONS[role])) as Map<Permission, Scope>;

/** A caller and authz fixed to one user and role: concurrent calls never share a mutable identity. */
function identity(userId: () => string, role: RoleKey) {
  const principal = (): Principal => ({
    userId: userId(),
    zitadelUserId: `z-${userId()}`,
    ...scopeA,
    orgKind: 'staff',
    partyId: null,
    idpOrgId: 'unused',
    roles: [role],
    departmentId: null,
    status: 'active',
    grants: grantsOf(role),
  });
  const caller = {
    current: () => ({
      scope: scopeA,
      actor: { kind: 'user' as const, id: userId(), correlationId: `race-${role}` },
      principal: principal(),
    }),
  };
  const authz = {
    assert: (action: Permission, ref?: Parameters<typeof can>[2]) => {
      const d = can(principal(), action, ref);
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
  notifyUser: vi.fn(() => Promise.resolve(undefined)),
  notifyRole: vi.fn(() => Promise.resolve(undefined)),
};
const directory = {
  userIdsWithRole: vi.fn((_s: unknown, role: RoleKey) => Promise.resolve(roles[role] ?? [])),
  resolve: vi.fn(),
  emailOf: vi.fn(() => Promise.resolve(null)),
} as unknown as UserDirectory;

let drafting: DraftingService;
let submitter: QuotationSubmitService;
let reviser: ReviseService;
let accountantApprovals: ApprovalsService;
let financeApprovals: ApprovalsService;

beforeAll(async () => {
  testDb = await createTestDatabase();
  ownerPool = new Pool({ connectionString: testDb.ownerUrl, max: 2 });
  appPool = new Pool({ connectionString: testDb.appUrl, max: 10 });
  db = drizzle({ client: appPool });

  f = await seedQuotationFixture(db);
  scopeA = { tenantId: f.tenantId, organizationId: f.entityId };
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
  U.fin = await staff('finance');
  U.mgmt = await staff('management');
  U.founder = await staff('founder');
  U.admin = await staff('founder');
  roles.accountant = [U.acc];
  roles.finance = [U.fin];
  roles.management = [U.mgmt];
  roles.founder = [U.founder];

  const audit = new AuditService(db);
  const adminId = identity(() => U.admin, 'founder');
  await new ApprovalsAdminService(db, audit, adminId.caller, () => now).createWorkflow({
    key: 'quotation_version',
    name: 'Quotation',
    spec: WORKFLOW_SPEC,
  });
  await new ApprovalsAdminService(db, audit, asSecondPerson(adminId.caller), () => now).publish(
    'quotation_version',
    1,
    SKIP_LIVE_PUBLISHER_CHECK,
  );

  const ownerId = identity(() => f.ownerUserId, 'sales');
  const approvalsFor = (caller: ReturnType<typeof identity>['caller']) => {
    const service = new ApprovalsService(db, audit, notify, directory, caller, () => now);
    service.registerSubject(new QuotationVersionSubject(() => now));
    return service;
  };
  const ownerApprovals = approvalsFor(ownerId.caller);
  accountantApprovals = approvalsFor(identity(() => U.acc, 'accountant').caller);
  financeApprovals = approvalsFor(identity(() => U.fin, 'finance').caller);

  const pricing = new PricingService(money);
  const settings = new SettingsService(db);
  drafting = new DraftingService(
    db,
    new NumberingService(),
    pricing,
    ownerId.authz,
    audit,
    ownerId.caller,
    new CurrencyEnabledService(settings),
  );
  submitter = new QuotationSubmitService(
    db,
    ownerId.authz,
    pricing,
    ownerApprovals,
    notify,
    audit,
    new QuotationSubmitStore(),
    ownerId.caller,
    settings,
    () => now,
  );
  reviser = new ReviseService(
    db,
    pricing,
    settings,
    ownerApprovals,
    ownerId.authz,
    audit,
    ownerId.caller,
    () => now,
  );
});

afterAll(async () => {
  await appPool?.end();
  await ownerPool?.end();
  await testDb?.drop();
});

// ---------------------------------------------------------------------------------------- helpers

const read = <T>(fn: (tx: DbTransaction) => Promise<T>) =>
  withTx(db, scopeA, systemActor('test'), fn);

const versionRow = async (versionId: string) => {
  const [row] = await read((tx) =>
    tx.select().from(quotationVersions).where(eq(quotationVersions.id, versionId)),
  );
  return row!;
};

const versionsOf = (quotationId: string) =>
  read((tx) =>
    tx
      .select({ id: quotationVersions.id })
      .from(quotationVersions)
      .where(eq(quotationVersions.quotationId, quotationId)),
  );

const requestOf = async (versionId: string) => {
  const rows = await read((tx) =>
    tx
      .select()
      .from(approvalRequests)
      .where(
        and(
          eq(approvalRequests.documentType, QUOTATION_VERSION_DOCUMENT_TYPE),
          eq(approvalRequests.documentId, versionId),
        ),
      ),
  );
  expect(rows).toHaveLength(1);
  return rows[0]!;
};

/** A submitted NPR 50,000 quotation whose accountant step is approved: finance decides the final step next. */
async function awaitingFinalStep() {
  const body: CreateQuotationBody = {
    opportunityId: f.opportunityId,
    currency: 'NPR',
    issueDate: GOLDEN_ISSUE_DATE,
    validUntil: '2026-12-09',
    lines: [
      {
        description: 'Implementation',
        uom: 'job',
        quantity: '1',
        unitPrice: '50000.00',
        taxCodeId: f.taxCodeVat13Id,
      },
    ],
  };
  const created = await drafting.create(body, randomUUID());
  const versionId = created.currentVersionId;
  const draft = await drafting.getVersion(created.id, versionId);
  await submitter.submit(created.id, versionId, { expectedVersion: draft.version }, randomUUID());
  const request = await requestOf(versionId);
  await accountantApprovals.act(
    request.id,
    { action: 'approve', expectedVersion: request.version },
    randomUUID(),
  );
  const pending = await requestOf(versionId);
  expect(pending).toMatchObject({ status: 'pending', currentSeq: 2 });
  const version = await versionRow(versionId);
  expect(version.status).toBe('submitted');
  return {
    quotationId: created.id,
    versionId,
    requestId: pending.id,
    requestVersion: pending.version,
    rowVersion: version.version,
  };
}
type Pending = Awaited<ReturnType<typeof awaitingFinalStep>>;

const approveFinal = (q: Pending) =>
  financeApprovals.act(
    q.requestId,
    { action: 'approve', expectedVersion: q.requestVersion },
    randomUUID(),
  );
/** The owner revises with the row version they saw on the submitted version. */
const reviseQuotation = (q: Pending, expectedVersion = q.rowVersion) =>
  reviser.revise(q.quotationId, { reason: REASON, expectedVersion }, randomUUID());

type Round = {
  round: number;
  offset: string;
  approve: string;
  revise: string;
  versionStatus: string;
  requestStatus: string;
  versions: number;
};

let firstDeadlock: PgFields | null = null;
const noteDeadlock = (side: string, r: PromiseSettledResult<unknown>) => {
  if (r.status === 'rejected' && firstDeadlock === null && pgErrorOf(r.reason).code === '40P01') {
    firstDeadlock = { ...pgErrorOf(r.reason), message: `${side}: ${pgErrorOf(r.reason).message}` };
  }
};

async function finish(
  q: Pending,
  round: number,
  offset: string,
  approve: PromiseSettledResult<unknown>,
  revise: PromiseSettledResult<unknown>,
): Promise<Round> {
  noteDeadlock('approve', approve);
  noteDeadlock('revise', revise);
  return {
    round,
    offset,
    approve: outcomeOf(approve),
    revise: outcomeOf(revise),
    versionStatus: (await versionRow(q.versionId)).status,
    requestStatus: (await requestOf(q.versionId)).status,
    versions: (await versionsOf(q.quotationId)).length,
  };
}

// ------------------------------------------------------------------------------------------------ test

describe('quotation approval: final approve racing the owner revise', () => {
  it('control: each side alone, in either order, answers as expected', async () => {
    // Approve, then revise with the version the approve left: the approved version becomes revision 2's parent.
    const a = await awaitingFinalStep();
    await approveFinal(a);
    expect((await versionRow(a.versionId)).status).toBe('approved');
    const revised = await reviseQuotation(a, (await versionRow(a.versionId)).version);
    expect(revised).toMatchObject({ revisionNo: 2, status: 'draft' });
    // Revise first: a submitted version answers 409 and changes nothing; the approve then goes through.
    const b = await awaitingFinalStep();
    const refused = await Promise.allSettled([reviseQuotation(b)]);
    expect(outcomeOf(refused[0])).toBe('http-409:conflict');
    await approveFinal(b);
    expect((await versionRow(b.versionId)).status).toBe('approved');
  });

  it('never deadlocks: the approve wins, the revise gets 409, and the rows agree', async () => {
    const rounds: Round[] = [];

    // Forced: revise claims its key under the held audit lock; approve takes the request and waits at its first
    // audited write; then the lock is released to revise, which next wants the request.
    {
      const q = await awaitingFinalStep();
      const forced = await forcedRound(
        ownerPool,
        ownerPool,
        f.tenantId,
        () => reviseQuotation(q),
        () => approveFinal(q),
      );
      console.log(
        `[S2 step4 pair2] forced round: firstWaited=${forced.firstWaited} bothWaited=${forced.bothWaited} waiters=${JSON.stringify(forced.waiters)}`,
      );
      rounds.push(await finish(q, 0, 'forced', forced.second, forced.first));
    }

    for (let i = 1; i <= ROUNDS; i++) {
      const q = await awaitingFinalStep();
      const r = await race(
        i,
        () => approveFinal(q),
        () => reviseQuotation(q),
      );
      rounds.push(await finish(q, i, `approve+${r.offsets.a} revise+${r.offsets.b}`, r.a, r.b));
    }

    // Printed before any assertion, so a failure keeps the counts.
    console.log(
      `[S2 step4 pair2] rounds=${rounds.length} counts=${JSON.stringify(tally(rounds, ['approve', 'revise']), null, 1)}`,
    );
    console.log(`[S2 step4 pair2] per round:\n${rounds.map((r) => JSON.stringify(r)).join('\n')}`);
    console.log(`[S2 step4 pair2] first 40P01: ${JSON.stringify(firstDeadlock, null, 1)}`);

    expect(rounds.filter((r) => r.approve !== 'ok' || r.revise !== 'http-409:conflict')).toEqual(
      [],
    );
    expect(
      rounds.filter(
        (r) => r.versionStatus !== 'approved' || r.requestStatus !== 'approved' || r.versions !== 1,
      ),
    ).toEqual([]);
  });
});
