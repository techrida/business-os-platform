// Integration tests of the quotation approval round trip on a real Postgres (Testcontainers, needs Docker in WSL).
// Real: migrations as bos_owner, queries as bos_app (so every 0016 CHECK and freeze trigger runs), DraftingService
// (create, PUT), QuotationSubmitService with its store, PricingService (NPR only: FX is a stub that fails if asked),
// the real ApprovalsService with the seed's quotation_version workflow published through ApprovalsAdminService, the
// real QuotationVersionSubject (so the M10 hash re-check runs on rows read back from Postgres) and the real
// AuditService. Faked: notify (it still runs the real link and template validation, as NotifyService does at
// enqueue), the user directory (role -> users; the users themselves are real staff users of entity A), the request
// context, and authz.assert, which still runs the real pure can() on a fake principal. The founder step's step-up
// is an HTTP concern (approvals.controller); the API e2e covers it, so the service is called directly here.
// Run: pnpm --filter @bos/api exec vitest run src/modules/quotations/approval/quotation-approval.integration.test.ts
import 'reflect-metadata';

import { randomUUID } from 'node:crypto';

import {
  DEFAULT_ROLE_PERMISSIONS,
  QuotationApprovalSnapshotSchema,
  defaultPortalDisplay,
  type ApprovalRequestDto,
  type CreateQuotationBody,
  type Discount,
  type Permission,
  type QuotationVersionDto,
  type RoleKey,
  type Scope,
} from '@bos/contracts';
import {
  approvalRequests,
  approvalSteps,
  createStaffUser,
  createTenantWithEntity,
  idempotencyKeys,
  quotationLines,
  quotationStatusHistory,
  quotationTaxSummary,
  quotationVersions,
  quotations,
  users,
} from '@bos/db';
import { ForbiddenException, HttpException } from '@nestjs/common';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { Queue } from 'bullmq';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { AuditService } from '../../../platform/audit/audit.service';
import type { AuthzService } from '../../../platform/authz/authz.service';
import { can } from '../../../platform/authz/can';
import type { Principal } from '../../../platform/authz/principal';
import type { DbTransaction } from '../../../platform/db/db.module';
import { systemActor, withTx, type TxScope } from '../../../platform/db/tx';
import { buildLink, renderEmail } from '../../../platform/notify/templates';
import { CurrencyEnabledService } from '../../../platform/settings/currency-enabled';
import type { MoneyService } from '../../../platform/settings/money.service';
import { NumberingService } from '../../../platform/settings/numbering.service';
import { SettingsService } from '../../../platform/settings/settings.service';
import { ApprovalsAdminService } from '../../approvals/admin.service';
import { asSecondPerson, SKIP_LIVE_PUBLISHER_CHECK } from '../../../../test/support/second-person';
import type { ApprovalEmailTemplate } from '../../approvals/ports';
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
import { toCustomerQuotationView } from '../render/customer-view';
import { renderQuotationHtml } from '../render/quotation-html';
import { contentSha256, materialFieldsOf } from './quotation-approval-snapshot';
import { QuotationSubmitService, QuotationSubmitStore } from './quotation-submit.service';
import {
  QUOTATION_VERSION_DOCUMENT_TYPE,
  QuotationVersionSubject,
} from './quotation-version.subject';
import { QuotationRenderNudge } from '../render/quotation-render.nudge';
import { createTestDatabase, type TestDatabase } from '@bos/db/testing';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 180_000 });

const WORKSPACE_URL = 'http://workspace.test';
const now = new Date('2026-11-09T04:00:00Z');

// Copied word for word from tools/seed-zitadel/src/db-seed.ts (QUOTATION_VERSION_WORKFLOW_SPEC, v1 of the
// quotation route). apps/api does not depend on the seed package, so it is not imported; keep the two in step.
const QUOTATION_VERSION_WORKFLOW_SPEC: unknown = {
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
  rules: [
    {
      id: 'management',
      when: {
        any: [
          { field: 'amountNpr', op: 'gt', value: '100000' },
          { field: 'discountApprovalRequired', op: 'eq', value: true },
        ],
      },
      add: {
        id: 'management',
        kind: 'role',
        role: 'management',
        reason:
          'Management approval: above 1,00,000 NPR or a discount above 12% ({effectiveDiscountPct}%)',
      },
      position: 'end',
      reason: 'Amount over NPR 1,00,000 or discount above 12%',
    },
    {
      id: 'over-10-lakh',
      when: { field: 'amountNpr', op: 'gt', value: '1000000' },
      add: {
        id: 'founder',
        kind: 'role',
        role: 'founder',
        reason: 'Founder approval because the NPR amount exceeds 10,00,000',
      },
      position: 'end',
      reason: 'Amount over NPR 10,00,000',
    },
  ],
  distinctApprovers: true,
  sla: { remindAfterHours: 24, escalateAfterHours: 72, escalateTo: { role: 'founder' } },
};

let testDb: TestDatabase;
let ownerPool: Pool;
let appPool: Pool;
let db: QuotationFixtureDb;
let f: QuotationFixture;
let scopeA: TxScope;
/** The render queue the approval's nudge enqueues on (render on commit, S3). */
const renderQueue = { add: vi.fn((..._args: unknown[]) => Promise.resolve({})) };
let scopeB: TxScope;
let approvals: ApprovalsService;
let drafting: DraftingService;
let submitter: QuotationSubmitService;
let canceller: CancelService;

/** Real staff users of entity A, one per approver role, plus the admin who publishes the workflow. */
const U = { acc: '', fin: '', mgmt: '', founder: '', admin: '' };
/** The fake directory's role members (the engine still checks each one is active in the entity). */
const roles: Partial<Record<RoleKey, string[]>> = {};
const resetRoles = () => {
  roles.accountant = [U.acc];
  roles.finance = [U.fin];
  roles.management = [U.mgmt];
  roles.founder = [U.founder];
};

const grantsOf = (role: RoleKey) =>
  new Map(Object.entries(DEFAULT_ROLE_PERMISSIONS[role])) as Map<Permission, Scope>;
/** Who calls: by default the fixture's owner, a sales user of entity A. */
const current: { userId: string; role: RoleKey; scope: TxScope | null } = {
  userId: '',
  role: 'sales',
  scope: null,
};
const as = (userId: string, role: RoleKey) => {
  current.userId = userId;
  current.role = role;
};
const scopeNow = (): TxScope => current.scope ?? scopeA;

const principalNow = (): Principal => ({
  userId: current.userId,
  zitadelUserId: `z-${current.userId}`,
  ...scopeNow(),
  orgKind: 'staff',
  partyId: null,
  idpOrgId: 'unused',
  // act() checks the token's roles hold the step's role, so the principal carries the role too.
  roles: [current.role],
  departmentId: null,
  status: 'active',
  grants: grantsOf(current.role),
});
/** One caller for every service, so switching the user or the entity switches it everywhere. */
const caller = {
  current: () => ({
    scope: scopeNow(),
    actor: { kind: 'user' as const, id: current.userId, correlationId: 'test-corr' },
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
/** NPR needs no rate; a call here means pricing took the FX path by mistake. */
const money = {
  toNprSnapshot: () => Promise.reject(new Error('MoneyService is not used for NPR quotations')),
} as unknown as MoneyService;

// The fakes run the REAL link and template validation, as NotifyService does at enqueue time: a decided notice
// linking outside the areas approval.decided allows fails here.
type Notice = {
  link: string;
  email?: { template: ApprovalEmailTemplate; vars: Record<string, string> };
};
const validate = (n: Notice) => {
  buildLink(WORKSPACE_URL, n.link);
  if (n.email !== undefined) {
    renderEmail(n.email.template, n.email.vars, { workspaceUrl: WORKSPACE_URL });
  }
  return Promise.resolve(undefined);
};
const notify = {
  notifyUser: vi.fn((_tx: unknown, n: Notice) => validate(n)),
  notifyRole: vi.fn((_tx: unknown, _role: unknown, n: Notice) => validate(n)),
};
const directory = {
  userIdsWithRole: vi.fn((_s: unknown, role: RoleKey) => Promise.resolve(roles[role] ?? [])),
  resolve: vi.fn(),
  emailOf: vi.fn(() => Promise.resolve(null)),
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
  const [owner] = await withTx(db, scopeA, systemActor('test'), (tx) =>
    tx
      .select({ idpOrgId: users.idpOrgId })
      .from(users)
      .where(and(eq(users.tenantId, f.tenantId), eq(users.id, f.ownerUserId))),
  );
  const staff = async (roleKey: RoleKey) =>
    (
      await createStaffUser(appPool, {
        ...scopeA,
        idpOrgId: owner!.idpOrgId,
        roleKeys: [roleKey],
      })
    ).userId;
  U.acc = await staff('accountant');
  U.fin = await staff('finance');
  U.mgmt = await staff('management');
  U.founder = await staff('founder');
  U.admin = await staff('founder');
  resetRoles();

  const audit = new AuditService(db);
  // The seed's workflow, published in entity A as an admin would.
  as(U.admin, 'founder');
  const admin = new ApprovalsAdminService(db, audit, caller, () => now);
  const adminPublisher = new ApprovalsAdminService(db, audit, asSecondPerson(caller), () => now);
  await admin.createWorkflow({
    key: 'quotation_version',
    name: 'Quotation',
    spec: QUOTATION_VERSION_WORKFLOW_SPEC,
  });
  await adminPublisher.publish('quotation_version', 1, SKIP_LIVE_PUBLISHER_CHECK);

  approvals = new ApprovalsService(db, audit, notify, directory, caller, () => now);
  approvals.registerSubject(
    new QuotationVersionSubject(
      () => now,
      new QuotationRenderNudge(renderQueue as unknown as Queue),
    ),
  );
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
  submitter = new QuotationSubmitService(
    db,
    authz as unknown as AuthzService,
    pricing,
    approvals,
    notify,
    audit,
    new QuotationSubmitStore(),
    caller,
    new SettingsService(db),
    () => now,
  );
  canceller = new CancelService(
    db,
    approvals,
    authz as unknown as AuthzService,
    audit,
    caller,
    () => now,
  );
});

afterAll(async () => {
  await appPool?.end();
  await ownerPool?.end();
  await testDb?.drop();
});

beforeEach(() => {
  vi.clearAllMocks();
  resetRoles();
  current.scope = null;
  as(f.ownerUserId, 'sales');
});

// ---------------------------------------------------------------------------------------- helpers

/** The HttpException `promise` rejects with; fails the test when it resolves. */
async function httpErrorOf(promise: Promise<unknown>): Promise<HttpException> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof HttpException) return error;
    throw error;
  }
  throw new Error('expected the call to fail');
}

/** The pg error behind `error` (drizzle may wrap it as `cause`). */
function pgErrorOf(error: unknown): { code?: string; constraint?: string } {
  let e: unknown = error;
  for (let depth = 0; typeof e === 'object' && e !== null && depth < 3; depth++) {
    const { code, constraint, cause } = e as {
      code?: unknown;
      constraint?: unknown;
      cause?: unknown;
    };
    if (typeof code === 'string' && code.length === 5) {
      return { code, ...(typeof constraint === 'string' ? { constraint } : {}) };
    }
    e = cause;
  }
  return {};
}

/** Reads (and the tamper write) in entity A as the system, under RLS like the services. */
const read = <T>(fn: (tx: DbTransaction) => Promise<T>) =>
  withTx(db, scopeA, systemActor('test'), fn);

/** A draft of entity A owned by the fixture's owner: one VAT 13% line at `unitPrice`, NPR. */
async function draft(
  unitPrice: string,
  discount?: Discount,
): Promise<{ quotationId: string; versionId: string; rowVersion: number }> {
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
        unitPrice,
        taxCodeId: f.taxCodeVat13Id,
      },
    ],
    ...(discount === undefined ? {} : { discount }),
  };
  const created = await drafting.create(body, randomUUID());
  const version = await drafting.getVersion(created.id, created.currentVersionId);
  return {
    quotationId: created.id,
    versionId: created.currentVersionId,
    rowVersion: version.version,
  };
}

const submit = (
  d: { quotationId: string; versionId: string },
  expectedVersion: number,
  key: string = randomUUID(),
): Promise<QuotationVersionDto> =>
  submitter.submit(d.quotationId, d.versionId, { expectedVersion }, key);

const versionRow = async (versionId: string) => {
  const [row] = await read((tx) =>
    tx.select().from(quotationVersions).where(eq(quotationVersions.id, versionId)),
  );
  return row!;
};

const requestsOf = (versionId: string) =>
  read((tx) =>
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

const stepRolesOf = async (requestId: string) =>
  (
    await read((tx) =>
      tx
        .select({ roleKey: approvalSteps.roleKey })
        .from(approvalSteps)
        .where(eq(approvalSteps.requestId, requestId))
        .orderBy(asc(approvalSteps.seq)),
    )
  ).map((s) => s.roleKey);

const requestVersionOf = async (requestId: string) => {
  const [row] = await read((tx) =>
    tx
      .select({ version: approvalRequests.version })
      .from(approvalRequests)
      .where(eq(approvalRequests.id, requestId)),
  );
  return row!.version;
};

/** `user` (holding `role`) acts on the request's active step at its current version. */
async function act(
  user: string,
  role: RoleKey,
  requestId: string,
  action: 'approve' | 'return' | 'reject',
): Promise<ApprovalRequestDto> {
  const expectedVersion = await requestVersionOf(requestId);
  as(user, role);
  try {
    return await approvals.act(
      requestId,
      {
        action,
        expectedVersion,
        ...(action === 'approve' ? {} : { comment: `${action} for the test` }),
      },
      randomUUID(),
    );
  } finally {
    as(f.ownerUserId, 'sales');
  }
}

// ------------------------------------------------------------------------------------------------ tests

describe('quotation approval: submit', () => {
  it('routes NPR 15,00,000 to accountant, finance, management and founder, with matching hashes', async () => {
    const d = await draft('1500000.00');
    const dto = await submit(d, d.rowVersion);
    expect(dto.status).toBe('submitted');

    const [request, ...others] = await requestsOf(d.versionId);
    expect(others).toEqual([]);
    expect(request!.status).toBe('pending');
    expect(await stepRolesOf(request!.id)).toEqual([
      'accountant',
      'finance',
      'management',
      'founder',
    ]);
    const snapshot = QuotationApprovalSnapshotSchema.parse(request!.snapshot);
    // 15,00,000 + 13% VAT: the NPR grand total the founder band compares with.
    expect(snapshot).toMatchObject({
      nprTotal: expect.stringMatching(/^1695000(\.0+)?$/) as unknown,
      currency: 'NPR',
      discountApprovalRequired: false,
    });

    // A fresh read of the version, its lines and tax summary hashes to the stored content hash.
    const version = await versionRow(d.versionId);
    const lines = await read((tx) =>
      tx
        .select()
        .from(quotationLines)
        .where(eq(quotationLines.versionId, d.versionId))
        .orderBy(asc(quotationLines.lineNo)),
    );
    const taxSummary = await read((tx) =>
      tx.select().from(quotationTaxSummary).where(eq(quotationTaxSummary.versionId, d.versionId)),
    );
    const recomputed = contentSha256(materialFieldsOf(version, lines, taxSummary));
    expect(version.contentSha256).not.toBeNull();
    expect(Buffer.from(version.contentSha256!).equals(recomputed)).toBe(true);
    expect(version.snapshotSha256).not.toBeNull();
    expect(Buffer.from(version.snapshotSha256!).equals(Buffer.from(request!.snapshotSha256))).toBe(
      true,
    );
    expect(version.approvalRequestId).toBe(request!.id);

    const history = await read((tx) =>
      tx
        .select({ from: quotationStatusHistory.fromStatus, to: quotationStatusHistory.toStatus })
        .from(quotationStatusHistory)
        .where(eq(quotationStatusHistory.versionId, d.versionId)),
    );
    expect(history).toEqual([
      { from: null, to: 'draft' },
      { from: 'draft', to: 'submitted' },
    ]);

    const { rows: quoteAudit } = await ownerPool.query<{ action: string }>(
      `SELECT action FROM audit.audit_events WHERE tenant_id = $1 AND entity_id = $2 ORDER BY id`,
      [f.tenantId, d.quotationId],
    );
    expect(quoteAudit.map((r) => r.action)).toContain('quotation.submitted');
    const { rows: requestAudit } = await ownerPool.query<{ action: string }>(
      `SELECT action FROM audit.audit_events WHERE tenant_id = $1 AND entity_id = $2 ORDER BY id`,
      [f.tenantId, request!.id],
    );
    expect(requestAudit.length).toBeGreaterThan(0);
  });

  it('adds management, and only management, for a 13% discount on NPR 50,000', async () => {
    const d = await draft('50000.00', { mode: 'pct', value: '13' });
    await submit(d, d.rowVersion);
    const [request] = await requestsOf(d.versionId);
    expect(await stepRolesOf(request!.id)).toEqual(['accountant', 'finance', 'management']);
    expect(QuotationApprovalSnapshotSchema.parse(request!.snapshot).discountApprovalRequired).toBe(
      true,
    );
  });

  it('answers 409 for a version that is already approved, and for a stale expectedVersion', async () => {
    const approved = await draft('50000.00');
    await submit(approved, approved.rowVersion);
    const [request] = await requestsOf(approved.versionId);
    await act(U.acc, 'accountant', request!.id, 'approve');
    await act(U.fin, 'finance', request!.id, 'approve');
    const after = await versionRow(approved.versionId);
    expect(after.status).toBe('approved');
    expect((await httpErrorOf(submit(approved, after.version))).getStatus()).toBe(409);

    const stale = await draft('50000.00');
    await drafting.updateDraft(stale.quotationId, stale.versionId, {
      expectedVersion: stale.rowVersion,
      scope: 'Phase 1 only',
    });
    expect((await httpErrorOf(submit(stale, stale.rowVersion))).getStatus()).toBe(409);
    expect((await versionRow(stale.versionId)).status).toBe('draft');
  });

  it('answers 422 NO_ELIGIBLE_APPROVER without writing anything but the admins notice', async () => {
    roles.finance = [];
    const d = await draft('50000.00');
    const key = randomUUID();
    const error = await httpErrorOf(submit(d, d.rowVersion, key));
    expect(error.getStatus()).toBe(422);
    expect(error.getResponse()).toMatchObject({ code: 'NO_ELIGIBLE_APPROVER' });

    expect(await requestsOf(d.versionId)).toEqual([]);
    const claims = await read((tx) =>
      tx
        .select()
        .from(idempotencyKeys)
        .where(and(eq(idempotencyKeys.command, 'quotation.submit'), eq(idempotencyKeys.key, key))),
    );
    expect(claims).toEqual([]);
    const version = await versionRow(d.versionId);
    expect(version.status).toBe('draft');
    expect(version.version).toBe(d.rowVersion);
    expect(notify.notifyRole).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      expect.objectContaining({
        email: expect.objectContaining({ template: 'approval.blocked' }) as unknown,
      }),
    );
  });

  it('refuses a few-paisa total whose schedule would bill a 0.00 instalment, writing nothing (FR-4)', async () => {
    const tiny = async (unitPrice: string) => {
      const created = await drafting.create(
        {
          opportunityId: f.opportunityId,
          currency: 'NPR',
          issueDate: GOLDEN_ISSUE_DATE,
          validUntil: '2026-12-09',
          paymentSchedule: [
            { label: 'Advance', percent: '50' },
            { label: 'On delivery', percent: '50' },
          ],
          lines: [
            {
              description: 'Token item',
              uom: 'each',
              quantity: '1',
              unitPrice,
              taxCodeId: f.taxCodeExemptId,
            },
          ],
        },
        randomUUID(),
      );
      const version = await drafting.getVersion(created.id, created.currentVersionId);
      return {
        quotationId: created.id,
        versionId: created.currentVersionId,
        rowVersion: version.version,
        schedule: version.paymentSchedule,
      };
    };

    // NPR 0.01 over 50/50: the first share rounds half up to 0.01, so the last row is 0.00.
    const d = await tiny('0.01');
    expect(d.schedule.map((m) => m.amount)).toEqual(['0.01', '0.00']);
    const error = await httpErrorOf(submit(d, d.rowVersion));
    expect(error.getStatus()).toBe(422);
    const body = error.getResponse() as { message: string };
    expect(body).toMatchObject({
      code: 'PAYMENT_INSTALMENT_ZERO',
      details: { label: 'On delivery', total: '0.01' },
    });
    expect(body.message).toContain('"On delivery" would be NPR 0.00');
    expect(await versionRow(d.versionId)).toMatchObject({
      status: 'draft',
      approvalRequestId: null,
      version: d.rowVersion,
    });
    expect(await requestsOf(d.versionId)).toHaveLength(0);

    // NPR 0.03 over the same schedule bills 0.02 and 0.01: submitted as usual.
    const ok = await tiny('0.03');
    expect((await submit(ok, ok.rowVersion)).status).toBe('submitted');
  });

  it('answers 404 for a version of another entity', async () => {
    const d = await draft('50000.00');
    current.scope = scopeB;
    expect((await httpErrorOf(submit(d, d.rowVersion))).getStatus()).toBe(404);
    current.scope = null;
    expect((await versionRow(d.versionId)).status).toBe('draft');
  });

  it('replays the same answer for the same Idempotency-Key, with one request row', async () => {
    const d = await draft('50000.00');
    const key = randomUUID();
    const first = await submit(d, d.rowVersion, key);
    const second = await submit(d, d.rowVersion, key);
    expect(second).toEqual(JSON.parse(JSON.stringify(first)) as unknown);
    expect(await requestsOf(d.versionId)).toHaveLength(1);
  });
});

describe('quotation approval: decisions', () => {
  it('approves every step of NPR 15,00,000 and links the decided notice to the quotation', async () => {
    const d = await draft('1500000.00');
    await submit(d, d.rowVersion);
    const [request] = await requestsOf(d.versionId);
    await act(U.acc, 'accountant', request!.id, 'approve');
    await act(U.fin, 'finance', request!.id, 'approve');
    await act(U.mgmt, 'management', request!.id, 'approve');
    const done = await act(U.founder, 'founder', request!.id, 'approve');
    expect(done.status).toBe('approved');

    // The subject's M10 re-check ran on the rows read back from Postgres and let the outcome through.
    const version = await versionRow(d.versionId);
    expect(version.status).toBe('approved');
    expect(version.approvedAt).not.toBeNull();
    const path = `/quotations/${d.quotationId}`;
    expect(notify.notifyUser).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        userId: f.ownerUserId,
        link: path,
        email: expect.objectContaining({
          template: 'approval.decided',
          vars: expect.objectContaining({ linkPath: path, decision: 'approved' }) as unknown,
        }) as unknown,
      }),
    );
  });

  it('returns the version, which can then be edited and submitted again', async () => {
    const d = await draft('50000.00');
    await submit(d, d.rowVersion);
    const [first] = await requestsOf(d.versionId);
    await act(U.acc, 'accountant', first!.id, 'return');
    const returned = await versionRow(d.versionId);
    expect(returned.status).toBe('returned');

    const { version: edited } = await drafting.updateDraft(d.quotationId, d.versionId, {
      expectedVersion: returned.version,
      scope: 'Phase 1 only',
    });
    expect(edited).toBe(returned.version + 1);
    const again = await submit(d, edited);
    expect(again.status).toBe('submitted');
    const requests = await requestsOf(d.versionId);
    expect(requests).toHaveLength(2);
    expect(requests.filter((r) => r.status === 'pending').map((r) => r.id)).not.toContain(
      first!.id,
    );
    expect((await versionRow(d.versionId)).approvalRequestId).not.toBe(first!.id);
  });

  it('rejects the version with rejection_source internal', async () => {
    const d = await draft('50000.00');
    await submit(d, d.rowVersion);
    const [request] = await requestsOf(d.versionId);
    await act(U.acc, 'accountant', request!.id, 'reject');
    const version = await versionRow(d.versionId);
    expect(version.status).toBe('rejected');
    expect(version.rejectionSource).toBe('internal');
  });

  it('refuses the owner, who submitted it, on a step whose role they hold (SoD)', async () => {
    roles.accountant = [f.ownerUserId, U.acc];
    const d = await draft('50000.00');
    await submit(d, d.rowVersion);
    const [request] = await requestsOf(d.versionId);
    const error = await httpErrorOf(act(f.ownerUserId, 'accountant', request!.id, 'approve'));
    expect(error.getStatus()).toBe(403);
    expect(error.getResponse()).toMatchObject({ reason: 'separation_of_duties' });
  });
});

describe('quotation approval: cancel while waiting (F1-Q27)', () => {
  it('the owner cancels a submitted quotation: the request leaves the inbox and can no longer be decided', async () => {
    const d = await draft('50000.00');
    const submitted = await submit(d, d.rowVersion);
    const [request] = await requestsOf(d.versionId);
    as(U.acc, 'accountant');
    try {
      expect((await approvals.inbox()).map((i) => i.requestId)).toContain(request!.id);
    } finally {
      as(f.ownerUserId, 'sales');
    }

    // The detail offers Cancel to the owner while it waits.
    expect((await drafting.detail(d.quotationId)).capabilities).toMatchObject({
      canEdit: false,
      canCancel: true,
    });

    const cancelled = await canceller.cancel(
      d.quotationId,
      { reason: 'Customer withdrew the enquiry', expectedVersion: submitted.version },
      randomUUID(),
    );
    expect(cancelled).toMatchObject({
      status: 'cancelled',
      cancelReason: 'Customer withdrew the enquiry',
    });

    const [after] = await requestsOf(d.versionId);
    expect(after!.status).toBe('cancelled');
    as(U.acc, 'accountant');
    try {
      expect((await approvals.inbox()).map((i) => i.requestId)).not.toContain(request!.id);
    } finally {
      as(f.ownerUserId, 'sales');
    }
    expect((await httpErrorOf(act(U.acc, 'accountant', request!.id, 'approve'))).getStatus()).toBe(
      409,
    );
    expect(await versionRow(d.versionId)).toMatchObject({ status: 'cancelled' });
    expect((await drafting.detail(d.quotationId)).capabilities).toMatchObject({
      canEdit: false,
      canRevise: false,
      canCancel: false,
    });
  });
});

describe('quotation approval: inbox (demo feedback 2026-11-17 guard)', () => {
  /**
   * The document ids in the inbox `user` (holding `role`) sees, then back to the owner. A caller with
   * no approval assignment at all is refused the inbox (403 out_of_scope), which is an empty inbox here.
   */
  async function inboxOf(user: string, role: RoleKey): Promise<string[]> {
    as(user, role);
    try {
      return (await approvals.inbox()).map((i) => i.documentId);
    } catch (error) {
      if (error instanceof HttpException && error.getStatus() === 403) return [];
      throw error;
    } finally {
      as(f.ownerUserId, 'sales');
    }
  }

  it("puts nothing in an inbox on save; submit puts it in the accountant's inbox, and the author cannot decide it", async () => {
    const d = await draft('50000.00');
    // Saved (created and edited), not submitted: no request and no inbox item anywhere.
    const { version: saved } = await drafting.updateDraft(d.quotationId, d.versionId, {
      expectedVersion: d.rowVersion,
      scope: 'Saved, not submitted',
    });
    expect(await requestsOf(d.versionId)).toEqual([]);
    expect(await inboxOf(U.acc, 'accountant')).not.toContain(d.versionId);

    await submit(d, saved);
    const [request, ...others] = await requestsOf(d.versionId);
    expect(others).toEqual([]);
    expect(await inboxOf(U.acc, 'accountant')).toContain(d.versionId);
    // The author does not see it, and a decision from them is refused.
    expect(await inboxOf(f.ownerUserId, 'sales')).not.toContain(d.versionId);
    // Refused either way: today a Sales author cannot even see the request (404); a 403 would do too.
    const error = await httpErrorOf(act(f.ownerUserId, 'sales', request!.id, 'approve'));
    expect([403, 404]).toContain(error.getStatus());
    expect((await versionRow(d.versionId)).status).toBe('submitted');
    expect((await requestsOf(d.versionId))[0]?.status).toBe('pending');
  });
});

describe('quotation approval: terms and conditions', () => {
  it('create -> clear with null -> set -> submit stores the text, hashes it, prints it and freezes it', async () => {
    const d = await draft('50000.00');
    const base = await drafting.getVersion(d.quotationId, d.versionId);
    expect(base.termsAndConditions).toBeNull();

    // Set, then clear with null: the column follows the PUT merge rule exactly like exclusions.
    const set = await drafting.updateDraft(d.quotationId, d.versionId, {
      expectedVersion: base.version,
      termsAndConditions: 'Payment within 30 days.',
    });
    expect((await drafting.getVersion(d.quotationId, d.versionId)).termsAndConditions).toBe(
      'Payment within 30 days.',
    );
    const cleared = await drafting.updateDraft(d.quotationId, d.versionId, {
      expectedVersion: set.version,
      termsAndConditions: null,
    });
    expect((await drafting.getVersion(d.quotationId, d.versionId)).termsAndConditions).toBeNull();
    const final = await drafting.updateDraft(d.quotationId, d.versionId, {
      expectedVersion: cleared.version,
      termsAndConditions: 'Goods remain ours until paid.',
    });

    await submit(d, final.version);
    const row = await versionRow(d.versionId);
    expect(row.termsAndConditions).toBe('Goods remain ours until paid.');

    // The stored content hash covers the text: recomputing from the rows read back matches it.
    const lines = await read((tx) =>
      tx.select().from(quotationLines).where(eq(quotationLines.versionId, d.versionId)),
    );
    const taxSummary = await read((tx) =>
      tx.select().from(quotationTaxSummary).where(eq(quotationTaxSummary.versionId, d.versionId)),
    );
    expect(
      Buffer.from(row.contentSha256!).equals(
        contentSha256(materialFieldsOf(row, lines, taxSummary)),
      ),
    ).toBe(true);
    expect(
      Buffer.from(row.contentSha256!).equals(
        contentSha256(materialFieldsOf({ ...row, termsAndConditions: null }, lines, taxSummary)),
      ),
    ).toBe(false);

    // The customer view built from the stored row prints it.
    const view = toCustomerQuotationView(
      {
        version: { ...row, status: 'approved' },
        quotation: { number: 'QT-2082-0001' },
        customer: {
          legalName: 'Himal Traders Pvt. Ltd.',
          panVatNo: null,
          country: 'NP',
          addressLine: '1 Durbar Marg',
          addressCity: 'Kathmandu',
        },
        contact: null,
        paymentTerm: null,
        lines,
        taxSummary,
        issuer: {
          legalName: 'Techrida Pvt. Ltd.',
          panVatNo: null,
          address: { line: '1 Durbar Marg', city: 'Kathmandu', country: 'NP' },
        },
        display: defaultPortalDisplay(),
      },
      { purpose: 'render' },
    );
    expect(view.termsAndConditions).toBe('Goods remain ours until paid.');
    expect(renderQuotationHtml(view)).toContain('Goods remain ours until paid.');

    // Frozen once submitted: a write past the service is refused by quotation_versions_guard.
    const error = await read((tx) =>
      tx.execute(
        sql`UPDATE app.quotation_versions SET terms_and_conditions = 'changed' WHERE id = ${d.versionId}`,
      ),
    ).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(pgErrorOf(error)).toEqual({
      code: '23514',
      constraint: 'quotation_versions_frozen_check',
    });
    expect((await versionRow(d.versionId)).termsAndConditions).toBe(
      'Goods remain ours until paid.',
    );
  });
});

describe('quotation approval: tamper after submit', () => {
  it('the freeze trigger refuses a line price change on a submitted version', async () => {
    const d = await draft('50000.00');
    await submit(d, d.rowVersion);
    const error = await read((tx) =>
      tx.execute(
        sql`UPDATE app.quotation_lines SET unit_price = unit_price + 1 WHERE version_id = ${d.versionId}`,
      ),
    ).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(pgErrorOf(error)).toEqual({ code: '23514', constraint: 'quotation_lines_frozen_check' });
  });

  it('a change made around the triggers fails the final approval with 409 (M10)', async () => {
    const d = await draft('50000.00');
    await submit(d, d.rowVersion);
    const [request] = await requestsOf(d.versionId);
    await act(U.acc, 'accountant', request!.id, 'approve');

    // A superuser session with triggers off (replica) stands in for a write that got past the freeze.
    const superPool = new Pool({ connectionString: testDb.adminUrl, max: 1 });
    try {
      const client = await superPool.connect();
      try {
        await client.query(`SET session_replication_role = replica`);
        const { rowCount } = await client.query(
          `UPDATE app.quotation_lines SET description = 'Tampered' WHERE version_id = $1`,
          [d.versionId],
        );
        expect(rowCount).toBe(1);
      } finally {
        client.release();
      }
    } finally {
      await superPool.end();
    }

    const error = await httpErrorOf(act(U.fin, 'finance', request!.id, 'approve'));
    expect(error.getStatus()).toBe(409);
    // The refusal rolled the decision back: the version waits and the request is still pending.
    expect((await versionRow(d.versionId)).status).toBe('submitted');
    const [after] = await requestsOf(d.versionId);
    expect(after!.status).toBe('pending');
  });
});

// ------------------------------------------------------------------- named first-step approver (demo 2026-11-17)

describe('quotation approval: the author names the first-step approver', () => {
  /** More people: a second accountant and a Sales colleague of entity A, and people who must be refused. */
  const X = { acc2: '', mate: '', warehouse: '', accB: '', otherTenant: '' };

  beforeAll(async () => {
    const [owner] = await read((tx) =>
      tx
        .select({ idpOrgId: users.idpOrgId })
        .from(users)
        .where(and(eq(users.tenantId, f.tenantId), eq(users.id, f.ownerUserId))),
    );
    const staffOf = async (scope: TxScope, roleKey: RoleKey, idpOrgId = owner!.idpOrgId) =>
      (await createStaffUser(appPool, { ...scope, idpOrgId, roleKeys: [roleKey] })).userId;
    X.acc2 = await staffOf(scopeA, 'accountant');
    X.mate = await staffOf(scopeA, 'sales');
    X.warehouse = await staffOf(scopeA, 'warehouse');
    X.accB = await staffOf(scopeB, 'accountant');
    const other = await createTenantWithEntity(appPool, { code: 'OTHER-T' });
    await read((tx) =>
      tx.update(users).set({ displayName: 'Mina Rai' }).where(eq(users.id, X.acc2)),
    );
    X.otherTenant = await staffOf(
      { tenantId: other.tenantId, organizationId: other.organizationId },
      'accountant',
      other.idpOrgId,
    );
  });

  beforeEach(() => {
    roles.accountant = [U.acc, X.acc2];
    roles.sales = [f.ownerUserId, X.mate];
    roles.warehouse = [X.warehouse];
  });

  const submitNaming = (
    d: { quotationId: string; versionId: string; rowVersion: number },
    approverUserId?: string,
  ) =>
    submitter.submit(
      d.quotationId,
      d.versionId,
      { expectedVersion: d.rowVersion, ...(approverUserId ? { approverUserId } : {}) },
      randomUUID(),
    );

  /** The request ids in `user`'s inbox, or 'denied' when the inbox answers 403. */
  async function inboxIds(user: string, role: RoleKey): Promise<string[] | 'denied'> {
    as(user, role);
    try {
      return (await approvals.inbox()).map((i) => i.requestId);
    } catch (error) {
      if (error instanceof HttpException && error.getStatus() === 403) return 'denied';
      throw error;
    } finally {
      as(f.ownerUserId, 'sales');
    }
  }

  const toldAboutApproval = () =>
    notify.notifyUser.mock.calls
      .filter(
        ([, n]) => (n as { email?: { template: string } }).email?.template === 'approval.pending',
      )
      .map(([, n]) => (n as unknown as { userId: string }).userId)
      .sort();

  it('without a choice, every eligible accountant sees, is told about and may decide the step (unchanged)', async () => {
    const d = await draft('50000.00');
    await submitNaming(d);
    const [request] = await requestsOf(d.versionId);
    expect(await inboxIds(U.acc, 'accountant')).toContain(request!.id);
    expect(await inboxIds(X.acc2, 'accountant')).toContain(request!.id);
    expect(toldAboutApproval()).toEqual([U.acc, X.acc2].sort());
    const decided = await act(U.acc, 'accountant', request!.id, 'approve');
    expect(decided.steps[0]).toMatchObject({ status: 'approved', decidedBy: U.acc });
    expect(decided.steps[0]!.assigneeUserId ?? null).toBeNull();
  });

  it('a Sales author names one accountant: only they see it, are told and may decide it', async () => {
    const d = await draft('50000.00');
    await submitNaming(d, X.acc2);
    const [request] = await requestsOf(d.versionId);
    expect(request!.status).toBe('pending');

    expect(await inboxIds(U.acc, 'accountant')).not.toContain(request!.id);
    expect(await inboxIds(X.acc2, 'accountant')).toContain(request!.id);
    expect(toldAboutApproval()).toEqual([X.acc2]);

    const refused = await httpErrorOf(act(U.acc, 'accountant', request!.id, 'approve'));
    expect(refused.getStatus()).toBe(403);

    const decided = await act(X.acc2, 'accountant', request!.id, 'approve');
    expect(decided.steps[0]).toMatchObject({
      status: 'approved',
      decidedBy: X.acc2,
      assigneeUserId: X.acc2,
    });
    // The later steps are unchanged: finance is next, open to finance as before.
    expect(decided.steps[1]).toMatchObject({ roleKey: 'finance', status: 'active' });
    expect(decided.steps[1]!.assigneeUserId ?? null).toBeNull();

    // The request names its people itself, so the inbox page needs no admin directory.
    as(X.acc2, 'accountant');
    try {
      const read2 = await approvals.get(request!.id);
      expect(read2.people).toContainEqual({
        userId: X.acc2,
        name: 'Mina Rai',
        avatarDocumentId: null,
      });
    } finally {
      as(f.ownerUserId, 'sales');
    }
    // So does the quotation, for its owner and the actors of its history.
    const detail = await drafting.detail(d.quotationId);
    const named = new Set((detail.people ?? []).map((p) => p.userId));
    for (const actor of detail.statusHistory.flatMap((h) => (h.actorId ? [h.actorId] : []))) {
      expect(named.has(actor)).toBe(true);
    }
  });

  it('a quotation names exactly its owner and its history actors; an unset owner adds no one', async () => {
    const d = await draft('50000.00');
    await submitNaming(d, X.acc2);
    const [request] = await requestsOf(d.versionId);
    await act(X.acc2, 'accountant', request!.id, 'approve');

    // An owner who never acted on the quotation, so only the owner column can name them.
    const setOwner = (ownerUserId: string | null) =>
      read((tx) =>
        tx.update(quotations).set({ ownerUserId }).where(eq(quotations.id, d.quotationId)),
      );
    await setOwner(X.mate);
    const detailAs = async (user: string, role: RoleKey) => {
      as(user, role);
      try {
        return await drafting.detail(d.quotationId);
      } finally {
        as(f.ownerUserId, 'sales');
      }
    };
    /** The people as the API should name them: each id with its display name, sorted by id. */
    const expectedPeople = async (ids: readonly string[]) => {
      const rows = await read((tx) =>
        tx
          .select({ userId: users.id, name: users.displayName })
          .from(users)
          .where(inArray(users.id, [...ids])),
      );
      expect(rows).toHaveLength(ids.length);
      return rows
        .map((r) => ({ ...r, avatarDocumentId: null }))
        .sort((a, b) => a.userId.localeCompare(b.userId));
    };
    const sorted = (people: readonly { userId: string; name: string }[] | undefined) =>
      [...(people ?? [])].sort((a, b) => a.userId.localeCompare(b.userId));

    const owned = await detailAs(X.mate, 'sales');
    expect(owned.quotation.ownerUserId).toBe(X.mate);
    const actors = [...new Set(owned.statusHistory.flatMap((h) => (h.actorId ? [h.actorId] : [])))];
    // The author drafted and submitted it; the owner is none of the actors.
    expect(actors).toContain(f.ownerUserId);
    expect(actors).not.toContain(X.mate);
    // Exactly the owner and each distinct actor: no one else, and no one of another tenant.
    expect(sorted(owned.people)).toEqual(await expectedPeople([X.mate, ...actors]));
    expect((owned.people ?? []).map((p) => p.userId)).not.toContain(X.otherTenant);

    // Without an owner the history actors remain, and nothing else; the read does not fail.
    await setOwner(null);
    const unowned = await detailAs(U.acc, 'accountant');
    expect(unowned.quotation.ownerUserId ?? null).toBeNull();
    expect(sorted(unowned.people)).toEqual(await expectedPeople(actors));
  });

  it('a named Sales colleague sees and decides only that step, and nothing else', async () => {
    const named = await draft('50000.00');
    await submitNaming(named, X.mate);
    const [request] = await requestsOf(named.versionId);
    const open = await draft('50000.00');
    await submitNaming(open);
    const [other] = await requestsOf(open.versionId);

    // The inbox lists the one assigned request, not the open one.
    expect(await inboxIds(X.mate, 'sales')).toEqual([request!.id]);
    // The accountants no longer see the named one.
    expect(await inboxIds(U.acc, 'accountant')).not.toContain(request!.id);

    // They cannot read or decide the other request.
    as(X.mate, 'sales');
    try {
      expect((await httpErrorOf(approvals.get(other!.id))).getStatus()).toBe(404);
      expect((await approvals.get(request!.id)).requestId).toBe(request!.id);
    } finally {
      as(f.ownerUserId, 'sales');
    }
    const otherRefused = await httpErrorOf(act(X.mate, 'sales', other!.id, 'approve'));
    expect([403, 404]).toContain(otherRefused.getStatus());

    const decided = await act(X.mate, 'sales', request!.id, 'approve');
    expect(decided.steps[0]).toMatchObject({ status: 'approved', decidedBy: X.mate });
    expect(decided.steps[1]).toMatchObject({ roleKey: 'finance', status: 'active' });

    // The finance step is not theirs: no inbox row, no decision.
    expect(await inboxIds(X.mate, 'sales')).toEqual([]);
    const later = await httpErrorOf(act(X.mate, 'sales', request!.id, 'approve'));
    expect([403, 404]).toContain(later.getStatus());
  });

  it('shows a named Sales colleague the quotation without a link to a page they cannot open (U18 #2)', async () => {
    const named = await draft('50000.00');
    await submitNaming(named, X.mate);
    const [request] = await requestsOf(named.versionId);

    // The colleague reads only their own quotations, and the quotation page refuses them, so no link.
    as(X.mate, 'sales');
    try {
      const { context } = await approvals.get(request!.id);
      expect(context).toMatchObject({ href: null, documents: [] });
      expect(context!.title).toMatch(/^Quotation /);
      expect(context!.fields).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ key: 'status', value: 'submitted' }),
          expect.objectContaining({ key: 'total', kind: 'money', currency: 'NPR' }),
        ]),
      );
      expect(
        (await httpErrorOf(drafting.getVersion(named.quotationId, named.versionId))).getStatus(),
      ).toBe(404);
    } finally {
      as(f.ownerUserId, 'sales');
    }

    // The author owns the quotation: the same approval links it, and the page opens for them.
    const { context } = await approvals.get(request!.id);
    expect(context?.href).toBe(`/quotations/${named.quotationId}`);
    expect((await drafting.getVersion(named.quotationId, named.versionId)).id).toBe(
      named.versionId,
    );
  });

  it('lets a past approver look back at the request they approved, with its live context, after the last step (U18-Q8)', async () => {
    const d = await draft('50000.00');
    await submitNaming(d, X.mate);
    const [request] = await requestsOf(d.versionId);
    await act(X.mate, 'sales', request!.id, 'approve');
    const final = await act(U.fin, 'finance', request!.id, 'approve');
    expect(final.status).toBe('approved');
    expect((await versionRow(d.versionId)).status).toBe('approved');

    // Their own-scope request read does not reach someone else's request, and nothing waits on them: only having
    // decided a step lets them read it, the context showing the version as it stands now.
    expect(await inboxIds(X.mate, 'sales')).not.toContain(request!.id);
    as(X.mate, 'sales');
    try {
      const dto = await approvals.get(request!.id);
      expect(dto).toMatchObject({ requestId: request!.id, status: 'approved' });
      expect(dto.steps[0]).toMatchObject({ status: 'approved', decidedBy: X.mate });
      expect(dto.context).toMatchObject({ href: null, documents: [] });
      expect(dto.context!.fields).toEqual(
        expect.arrayContaining([expect.objectContaining({ key: 'status', value: 'approved' })]),
      );
    } finally {
      as(f.ownerUserId, 'sales');
    }

    // A colleague who took no part still cannot read it.
    as(X.warehouse, 'warehouse');
    try {
      expect((await httpErrorOf(approvals.get(request!.id))).getStatus()).toBe(404);
    } finally {
      as(f.ownerUserId, 'sales');
    }
  });

  it('admits only the original Sales decision for replay after the Finance step activates', async () => {
    const draftQuote = await draft('50000.00');
    await submitNaming(draftQuote, X.mate);
    const [request] = await requestsOf(draftQuote.versionId);
    const id = request!.id;
    const key = randomUUID();
    const action = { action: 'approve' as const, expectedVersion: await requestVersionOf(id) };
    as(X.mate, 'sales');
    try {
      await approvals.getForAction(id, action, key);
      const result = await approvals.act(id, action, key);
      await approvals.getForAction(id, action, key);
      expect(await approvals.act(id, action, key)).toEqual(result);
      await expect(approvals.getForAction(id, action, randomUUID())).rejects.toMatchObject({
        status: 404,
      });
    } finally {
      as(f.ownerUserId, 'sales');
    }
  });

  it('refuses the author, another entity, another tenant and an ineligible user at submit, writing nothing', async () => {
    // A directory that (wrongly) lists people of entity B and of another tenant as accountants: the server's own
    // tenant, entity and active-staff check must still refuse them.
    roles.accountant = [U.acc, X.acc2, X.accB, X.otherTenant];
    for (const who of [f.ownerUserId, X.accB, X.otherTenant, X.warehouse, U.fin]) {
      const d = await draft('50000.00');
      const error = await httpErrorOf(submitNaming(d, who));
      expect(error.getStatus()).toBe(422);
      expect(error.getResponse()).toMatchObject({ code: 'APPROVER_NOT_ELIGIBLE' });
      expect((await versionRow(d.versionId)).status).toBe('draft');
      expect(await requestsOf(d.versionId)).toEqual([]);
    }
  });
});

describe('quotation approval: render on commit (S3)', () => {
  it('enqueues the version render once, when the last approval commits, and not before', async () => {
    const d = await draft('1500000.00');
    await submit(d, d.rowVersion);
    const [request] = await requestsOf(d.versionId);
    renderQueue.add.mockClear();
    await act(U.acc, 'accountant', request!.id, 'approve');
    await act(U.fin, 'finance', request!.id, 'approve');
    await act(U.mgmt, 'management', request!.id, 'approve');
    expect(renderQueue.add).not.toHaveBeenCalled();
    await act(U.founder, 'founder', request!.id, 'approve');
    expect(renderQueue.add).toHaveBeenCalledTimes(1);
    expect(renderQueue.add).toHaveBeenCalledWith(
      'quotation.render.one',
      { ...scopeA, id: d.versionId },
      { jobId: `quotation.render.one-${d.versionId}`, removeOnComplete: true, removeOnFail: true },
    );
  });

  it('enqueues nothing for a returned or rejected version', async () => {
    const returned = await draft('50000.00');
    await submit(returned, returned.rowVersion);
    const rejected = await draft('50000.00');
    await submit(rejected, rejected.rowVersion);
    renderQueue.add.mockClear();
    await act(U.acc, 'accountant', (await requestsOf(returned.versionId))[0]!.id, 'return');
    await act(U.acc, 'accountant', (await requestsOf(rejected.versionId))[0]!.id, 'reject');
    expect(renderQueue.add).not.toHaveBeenCalled();
  });
});
