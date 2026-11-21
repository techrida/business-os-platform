// Concurrency test: the approver decides the final step of a quotation's approval while its owner cancels the
// quotation, at the same moment, on a real Postgres (the shared test database of @bos/db/testing).
// Real: migrations as bos_owner, queries as bos_app, DraftingService.create, QuotationSubmitService, the real
// ApprovalsService with the seed's quotation_version workflow (accountant -> finance for NPR 50,000), the real
// QuotationVersionSubject, CancelService and AuditService (so the audit_capture triggers and the tenant's audit
// chain lock run). Faked: notify, the user directory and the request context. Each actor has its own fixed caller
// and authz, so the two sides of a race never see each other's identity.
//
// Each round: a fresh draft, submitted, the accountant step approved; then the finance approve and the owner's
// cancel race, each in its own transaction on its own connection. The cancel start is offset 0..28 ms by round, so
// the two lock windows overlap at different points. One extra round forces the interleaving: the owner's cancel is
// parked (between its first statements and ApprovalsService.cancel) until the approve is seen waiting on a lock.
//
// Desired behaviour (the assertions): no error that is not an HTTP answer (no 40P01 deadlock, no 55P03), exactly
// one side wins each round, and the final version and request rows agree with the winner.
// Run: pnpm --filter @bos/api exec vitest run src/modules/quotations/approval/quotation-approve-cancel.concurrency.integration.test.ts
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
import { ForbiddenException, HttpException } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

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
import { CancelService } from '../drafting/cancel.service';
import { DraftingService } from '../drafting/drafting.service';
import {
  GOLDEN_ISSUE_DATE,
  seedQuotationFixture,
  type QuotationFixture,
  type QuotationFixtureDb,
} from '../drafting/quotation.fixture';
import { PricingService } from '../pricing/pricing.service';
import { QuotationSubmitService, QuotationSubmitStore } from './quotation-submit.service';
import {
  QUOTATION_VERSION_DOCUMENT_TYPE,
  QuotationVersionSubject,
} from './quotation-version.subject';
import { createTestDatabase, type TestDatabase } from '@bos/db/testing';

vi.setConfig({ testTimeout: 600_000, hookTimeout: 180_000 });

const ROUNDS = 40;
const REASON = 'Customer chose another supplier';
const now = new Date('2026-11-09T04:00:00Z');

// The base route of the seed's quotation_version workflow (tools/seed-zitadel/src/db-seed.ts), as copied in
// quotation-approval.integration.test.ts. NPR 50,000 without a discount stays on the base route.
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
let canceller: CancelService;
let ownerApprovals: ApprovalsService;
let accountantApprovals: ApprovalsService;
let financeApprovals: ApprovalsService;
/** While set, the owner's ApprovalsService.cancel waits for it before taking the request lock. */
let cancelGate: Promise<void> | null = null;

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
  ownerApprovals = approvalsFor(ownerId.caller);
  accountantApprovals = approvalsFor(identity(() => U.acc, 'accountant').caller);
  financeApprovals = approvalsFor(identity(() => U.fin, 'finance').caller);
  const realCancel = ownerApprovals.cancel.bind(ownerApprovals);
  ownerApprovals.cancel = async (...args: Parameters<ApprovalsService['cancel']>) => {
    if (cancelGate !== null) await cancelGate;
    return realCancel(...args);
  };

  const pricing = new PricingService(money);
  drafting = new DraftingService(
    db,
    new NumberingService(),
    pricing,
    ownerId.authz,
    audit,
    ownerId.caller,
    new CurrencyEnabledService(new SettingsService(db)),
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
    new SettingsService(db),
    () => now,
  );
  canceller = new CancelService(
    db,
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

type PgFields = { code?: string; detail?: string; where?: string; message?: string };

/** The pg error behind `error` (drizzle wraps it as `cause`). */
function pgErrorOf(error: unknown): PgFields {
  let e: unknown = error;
  for (let depth = 0; typeof e === 'object' && e !== null && depth < 4; depth++) {
    const x = e as {
      code?: unknown;
      detail?: unknown;
      where?: unknown;
      message?: unknown;
      cause?: unknown;
    };
    if (typeof x.code === 'string' && x.code.length === 5) {
      return {
        code: x.code,
        ...(typeof x.detail === 'string' ? { detail: x.detail } : {}),
        ...(typeof x.where === 'string' ? { where: x.where } : {}),
        ...(typeof x.message === 'string' ? { message: x.message } : {}),
      };
    }
    e = x.cause;
  }
  return {};
}

/** 'ok', 'http-<status>', 'pg-<sqlstate>' or 'other: <message>'. */
function outcomeOf(r: PromiseSettledResult<unknown>): string {
  if (r.status === 'fulfilled') return 'ok';
  const e: unknown = r.reason;
  if (e instanceof HttpException) return `http-${e.getStatus()}`;
  const pg = pgErrorOf(e);
  if (pg.code !== undefined) return `pg-${pg.code}`;
  return `other: ${e instanceof Error ? e.message : String(e)}`;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const read = <T>(fn: (tx: DbTransaction) => Promise<T>) =>
  withTx(db, scopeA, systemActor('test'), fn);

const versionRow = async (versionId: string) => {
  const [row] = await read((tx) =>
    tx.select().from(quotationVersions).where(eq(quotationVersions.id, versionId)),
  );
  return row!;
};

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

/** Ungranted locks in this test's database (Postgres is shared with other test files). */
async function waitingLocks() {
  const { rows } = await ownerPool.query<{
    pid: number;
    locktype: string;
    mode: string;
    relation: string | null;
    query: string;
  }>(
    `SELECT l.pid, l.locktype, l.mode, l.relation::regclass::text AS relation, left(a.query, 160) AS query
       FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
      WHERE NOT l.granted AND a.datname = current_database()`,
  );
  return rows;
}

type Round = {
  round: number;
  offsetMs: number | 'forced';
  approve: string;
  cancel: string;
  versionStatus: string;
  requestStatus: string;
};

let firstDeadlock: PgFields | null = null;
const noteDeadlock = (side: string, r: PromiseSettledResult<unknown>) => {
  if (r.status === 'rejected' && firstDeadlock === null && pgErrorOf(r.reason).code === '40P01') {
    firstDeadlock = { ...pgErrorOf(r.reason), message: `${side}: ${pgErrorOf(r.reason).message}` };
  }
};

async function finish(
  q: Awaited<ReturnType<typeof awaitingFinalStep>>,
  round: number,
  offsetMs: Round['offsetMs'],
  approve: PromiseSettledResult<unknown>,
  cancel: PromiseSettledResult<unknown>,
): Promise<Round> {
  noteDeadlock('approve', approve);
  noteDeadlock('cancel', cancel);
  return {
    round,
    offsetMs,
    approve: outcomeOf(approve),
    cancel: outcomeOf(cancel),
    versionStatus: (await versionRow(q.versionId)).status,
    requestStatus: (await requestOf(q.versionId)).status,
  };
}

const approveFinal = (q: Awaited<ReturnType<typeof awaitingFinalStep>>) =>
  financeApprovals.act(
    q.requestId,
    { action: 'approve', expectedVersion: q.requestVersion },
    randomUUID(),
  );
const cancelQuotation = (q: Awaited<ReturnType<typeof awaitingFinalStep>>) =>
  canceller.cancel(q.quotationId, { reason: REASON, expectedVersion: q.rowVersion }, randomUUID());

// ------------------------------------------------------------------------------------------------ test

describe('quotation approval: final approve racing the owner cancel', () => {
  it('never deadlocks: exactly one side wins and the rows agree with it', async () => {
    // Evidence: which tables carry the audit_capture trigger (each audited write takes the tenant's
    // audit-chain advisory lock, packages/db/migrations/0008_audit_hardening.sql:111).
    const { rows: triggers } = await ownerPool.query<{ relname: string }>(
      `SELECT c.relname FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'app' AND t.tgname = 'audit_capture'
          AND c.relname IN ('idempotency_keys', 'quotations', 'quotation_versions', 'approval_requests',
                            'approval_steps', 'approval_actions')
        ORDER BY c.relname`,
    );
    const { rows: dt } = await ownerPool.query<{ deadlock_timeout: string }>(
      'SHOW deadlock_timeout',
    );
    console.log(
      `[S2 evidence] audit_capture on: ${triggers.map((t) => t.relname).join(', ')}; deadlock_timeout=${dt[0]!.deadlock_timeout}`,
    );

    const rounds: Round[] = [];

    // The forced interleaving: cancel claims its Idempotency-Key (an audited INSERT) and locks the quotation, then
    // parks before ApprovalsService.cancel; approve starts and runs until it waits on a lock; then cancel goes on.
    {
      const q = await awaitingFinalStep();
      let release!: () => void;
      cancelGate = new Promise<void>((resolve) => (release = resolve));
      const cancelP = cancelQuotation(q);
      await sleep(300);
      const approveP = approveFinal(q);
      let seen: Awaited<ReturnType<typeof waitingLocks>> = [];
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        seen = await waitingLocks();
        if (seen.length > 0) break;
        await sleep(25);
      }
      console.log(
        `[S2 evidence] forced round: waiting locks while cancel is parked: ${JSON.stringify(seen)}`,
      );
      release();
      cancelGate = null;
      const [approve, cancel] = await Promise.allSettled([approveP, cancelP]);
      rounds.push(await finish(q, 0, 'forced', approve, cancel));
    }

    for (let i = 1; i <= ROUNDS; i++) {
      const q = await awaitingFinalStep();
      const offsetMs = ((i - 1) % 8) * 4;
      const [approve, cancel] = await Promise.allSettled([
        approveFinal(q),
        sleep(offsetMs).then(() => cancelQuotation(q)),
      ]);
      rounds.push(await finish(q, i, offsetMs, approve, cancel));
    }

    // Printed before any assertion, so a failure keeps the counts.
    const counts: Record<string, number> = {};
    for (const r of rounds) {
      counts[`approve:${r.approve}`] = (counts[`approve:${r.approve}`] ?? 0) + 1;
      counts[`cancel:${r.cancel}`] = (counts[`cancel:${r.cancel}`] ?? 0) + 1;
      const pair = `${r.approve} / ${r.cancel}`;
      counts[`pair:${pair}`] = (counts[`pair:${pair}`] ?? 0) + 1;
    }
    console.log(`[S2 evidence] rounds=${rounds.length} counts=${JSON.stringify(counts, null, 1)}`);
    console.log(`[S2 evidence] per round:\n${rounds.map((r) => JSON.stringify(r)).join('\n')}`);
    console.log(`[S2 evidence] first 40P01: ${JSON.stringify(firstDeadlock, null, 1)}`);

    const isAnswer = (o: string) => o === 'ok' || /^http-4\d\d$/.test(o);
    expect(rounds.filter((r) => !isAnswer(r.approve) || !isAnswer(r.cancel))).toEqual([]);
    expect(
      rounds.filter((r) => [r.approve, r.cancel].filter((o) => o === 'ok').length !== 1),
    ).toEqual([]);
    expect(
      rounds.filter((r) =>
        r.approve === 'ok'
          ? r.versionStatus !== 'approved' || r.requestStatus !== 'approved'
          : r.versionStatus !== 'cancelled' || r.requestStatus !== 'cancelled',
      ),
    ).toEqual([]);
  });
});
