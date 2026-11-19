// Integration tests of the purchase request round trip on a real Postgres (Testcontainers, needs Docker in WSL).
// Real: migrations as bos_owner, queries as bos_app (so every 0033 CHECK and the lines freeze trigger run),
// PurchaseRequestsService, the real ApprovalsService with the `purchase_request` workflow published through
// ApprovalsAdminService (the spec is PURCHASE_REQUEST_WORKFLOW_SPEC, which the seed unit copies), the real
// PurchaseRequestSubject, NumberingService, MoneyService (NPR needs no rate) and AuditService (the editors of the
// SoD list are read from it). Faked: notify (it still runs the real link and template validation, as NotifyService
// does at enqueue), the user directory (role -> users; the users themselves are real staff users of entity A), the
// request context, and authz.assert, which still runs the real pure can() on a fake principal.
// Run: pnpm --filter @bos/api exec vitest run src/modules/procurement/requests/purchase-requests.integration.test.ts
import 'reflect-metadata';

import { randomUUID } from 'node:crypto';

import {
  DEFAULT_ROLE_PERMISSIONS,
  type ApprovalRequestDto,
  type CreatePurchaseRequestBody,
  type Permission,
  type RoleKey,
  type Scope,
} from '@bos/contracts';
import {
  approvalRequests,
  approvalSteps,
  createCostCenter,
  createDepartment,
  createStaffUser,
  createTenantWithEntity,
  departments,
  purchaseRequestLines,
  purchaseRequests,
  runMigrations,
} from '@bos/db';
import { BadRequestException, ForbiddenException, HttpException } from '@nestjs/common';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { and, asc, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { AuditService } from '../../../platform/audit/audit.service';
import type { AuthzService } from '../../../platform/authz/authz.service';
import { can } from '../../../platform/authz/can';
import type { Principal } from '../../../platform/authz/principal';
import type { Db, DbTransaction } from '../../../platform/db/db.module';
import { systemActor, withTx, type TxScope } from '../../../platform/db/tx';
import { buildLink, renderEmail } from '../../../platform/notify/templates';
import { MoneyService } from '../../../platform/settings/money.service';
import { NumberingService } from '../../../platform/settings/numbering.service';
import { ApprovalsAdminService } from '../../approvals/admin.service';
import type { ApprovalEmailTemplate } from '../../approvals/ports';
import { ApprovalsService } from '../../approvals/requests.service';
import {
  PURCHASE_REQUEST_DOCUMENT_TYPE,
  PURCHASE_REQUEST_WORKFLOW_SPEC,
} from './purchase-request.rules';
import { PurchaseRequestSubject } from './purchase-request.subject';
import { PurchaseRequestsService } from './purchase-requests.service';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 180_000 });

const OWNER_PW = 'owner-test-pw';
const APP_PW = 'app-test-pw';
const WORKSPACE_URL = 'http://workspace.test';
const now = new Date('2026-11-09T04:00:00Z');

let container: StartedPostgreSqlContainer;
let ownerPool: Pool;
let appPool: Pool;
let db: Db;
let scopeA: TxScope;
let scopeB: TxScope;
let approvals: ApprovalsService;
let service: PurchaseRequestsService;

/** Real staff users of entity A. `req` and `other` raise requests, `head` heads `dept.headed`. */
const U = { req: '', other: '', head: '', ops: '', mgmt: '', proc: '', admin: '' };
/** Departments: one headed by `head`, one with no head, one headed by the requester, one in entity B. */
const centers = { active: '', inactive: '', otherEntity: '' };
const dept = { headed: '', headless: '', selfHeaded: '', otherEntity: '' };
/** The fake directory's role members (the engine still checks each one is active in the entity). */
const roles: Partial<Record<RoleKey, string[]>> = {};
const resetRoles = () => {
  roles.operations_head = [U.ops];
  roles.management = [U.mgmt];
  roles.founder = [U.admin];
};

const grantsOf = (role: RoleKey) =>
  new Map(Object.entries(DEFAULT_ROLE_PERMISSIONS[role])) as Map<Permission, Scope>;
/** Who calls: by default the requester, an operations officer of entity A. */
const current: { userId: string; role: RoleKey; scope: TxScope | null } = {
  userId: '',
  role: 'operations_officer',
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

const urlFor = (user: string, password: string, database: string) => {
  const url = new URL(container.getConnectionUri());
  url.username = user;
  url.password = password;
  url.pathname = `/${database}`;
  return url.toString();
};

const read = <T>(fn: (tx: DbTransaction) => Promise<T>) =>
  withTx(db, scopeA, systemActor('test'), fn);

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

  // One tenant, entity A (the acting one) and entity B.
  const tenant = await createTenantWithEntity(appPool);
  scopeA = { tenantId: tenant.tenantId, organizationId: tenant.organizationId };
  const otherEntityId = randomUUID();
  await withTx(db, scopeA, systemActor('test'), (tx) =>
    tx.execute(
      sql`INSERT INTO app.organizations (id, tenant_id, organization_id, name, code, legal_name, is_default)
          VALUES (${otherEntityId}, ${scopeA.tenantId}, ${otherEntityId}, ${`E-${otherEntityId}`},
                  ${`E-${otherEntityId}`}, ${`E-${otherEntityId}`}, false)`,
    ),
  );
  scopeB = { tenantId: scopeA.tenantId, organizationId: otherEntityId };

  const staff = async (roleKey: RoleKey) =>
    (await createStaffUser(appPool, { ...scopeA, idpOrgId: tenant.idpOrgId, roleKeys: [roleKey] }))
      .userId;
  U.req = await staff('operations_officer');
  U.other = await staff('operations_officer');
  U.head = await staff('operations_officer');
  U.ops = await staff('operations_head');
  U.mgmt = await staff('management');
  U.proc = await staff('procurement');
  U.admin = await staff('founder');
  resetRoles();

  centers.active = (await createCostCenter(appPool, scopeA)).costCenterId;
  centers.inactive = (await createCostCenter(appPool, { ...scopeA, active: false })).costCenterId;
  centers.otherEntity = (await createCostCenter(appPool, scopeB)).costCenterId;
  dept.headed = (await createDepartment(appPool, scopeA)).departmentId;
  dept.headless = (await createDepartment(appPool, scopeA)).departmentId;
  dept.selfHeaded = (await createDepartment(appPool, scopeA)).departmentId;
  dept.otherEntity = (await createDepartment(appPool, scopeB)).departmentId;
  // The head must be an active staff user of entity A, or the engine counts the department as headless.
  for (const [d, head] of [
    [dept.headed, U.head],
    [dept.selfHeaded, U.req],
  ] as const) {
    await withTx(db, scopeA, systemActor('test'), (tx) =>
      tx.execute(sql`UPDATE app.departments SET head_user_id = ${head} WHERE id = ${d}`),
    );
  }

  const audit = new AuditService(db);
  // The workflow the seed unit publishes, published in entity A as an admin would.
  as(U.admin, 'founder');
  const admin = new ApprovalsAdminService(db, audit, caller, () => now);
  await admin.createWorkflow({
    key: PURCHASE_REQUEST_DOCUMENT_TYPE,
    name: 'Purchase request',
    spec: PURCHASE_REQUEST_WORKFLOW_SPEC,
  });
  await admin.publish(PURCHASE_REQUEST_DOCUMENT_TYPE, 1);

  approvals = new ApprovalsService(db, audit, notify, directory, caller, () => now);
  approvals.registerSubject(new PurchaseRequestSubject(() => now));
  service = new PurchaseRequestsService(
    db,
    authz as unknown as AuthzService,
    approvals,
    notify,
    audit,
    new NumberingService(),
    // NPR needs no rate row, so the settings are never read.
    new MoneyService(db, {} as never),
    caller,
    () => now,
  );
});

afterAll(async () => {
  await appPool?.end();
  await ownerPool?.end();
  await container?.stop();
});

beforeEach(() => {
  vi.clearAllMocks();
  resetRoles();
  current.scope = null;
  as(U.req, 'operations_officer');
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
const codeOf = (e: HttpException) => (e.getResponse() as { code?: string }).code;

const body = (over: Partial<CreatePurchaseRequestBody> = {}): CreatePurchaseRequestBody => ({
  requestType: 'goods',
  departmentId: dept.headed,
  costCenterId: centers.active,
  justification: 'Chairs for the new training room',
  requiredBy: '2026-12-01',
  budgetCode: 'OPS-2083',
  currency: 'NPR',
  isEmergency: false,
  lines: [{ description: 'Chairs', uom: 'pcs', quantity: '10', estimatedUnitPrice: '4500.00' }],
  ...over,
});

const draft = (over: Partial<CreatePurchaseRequestBody> = {}) =>
  service.create(body(over), randomUUID());

const prRow = async (id: string) => {
  const [row] = await read((tx) =>
    tx.select().from(purchaseRequests).where(eq(purchaseRequests.id, id)),
  );
  return row!;
};

const requestsOf = (prId: string) =>
  read((tx) =>
    tx
      .select()
      .from(approvalRequests)
      .where(
        and(
          eq(approvalRequests.documentType, PURCHASE_REQUEST_DOCUMENT_TYPE),
          eq(approvalRequests.documentId, prId),
        ),
      ),
  );

const stepsOf = (requestId: string) =>
  read((tx) =>
    tx
      .select({
        kind: approvalSteps.kind,
        roleKey: approvalSteps.roleKey,
        userId: approvalSteps.userId,
      })
      .from(approvalSteps)
      .where(eq(approvalSteps.requestId, requestId))
      .orderBy(asc(approvalSteps.seq)),
  );

/** `user` (holding `role`) acts on the request's active step at its current version. */
async function act(
  user: string,
  role: RoleKey,
  requestId: string,
  action: 'approve' | 'return' | 'reject',
): Promise<ApprovalRequestDto> {
  const [req] = await read((tx) =>
    tx
      .select({ version: approvalRequests.version })
      .from(approvalRequests)
      .where(eq(approvalRequests.id, requestId)),
  );
  as(user, role);
  try {
    return await approvals.act(
      requestId,
      {
        action,
        expectedVersion: req!.version,
        ...(action === 'approve' ? {} : { comment: `${action} for the test` }),
      },
      randomUUID(),
    );
  } finally {
    as(U.req, 'operations_officer');
  }
}

/** Drafts and submits a request, returning its id and its (only) approval request. */
async function submitted(over: Partial<CreatePurchaseRequestBody> = {}) {
  const d = await draft(over);
  const dto = await service.submit(d.id, undefined, randomUUID());
  const [request] = await requestsOf(d.id);
  return { id: d.id, dto, request: request! };
}

// ------------------------------------------------------------------------------------------------ tests

describe('purchase request: the department route (AD10, AD11, AD12)', () => {
  it('routes to the department head only: no Accountant, no Finance step', async () => {
    const { id, dto, request } = await submitted();
    expect(dto.status).toBe('submitted');
    expect(dto.number).toMatch(/^PR-\d{4}\/\d{2}-\d{5}$/);
    // The snapshot the approval thresholds read, written by the same UPDATE as the status.
    expect(dto).toMatchObject({
      estimatedTotal: '45000.00',
      estimatedTotalNpr: '45000.00',
      fxRate: '1.000000',
      approvalRequestId: request.id,
    });
    expect(dto.submittedAt).toBe(now.toISOString());

    expect(request.status).toBe('pending');
    expect(request.documentNumber).toBe(dto.number);
    expect(request.facts).toEqual({
      departmentId: dept.headed,
      isEmergency: false,
      amountNpr: '45000.00',
    });
    expect(request.sodUserIds).toContain(U.req);
    const steps = await stepsOf(request.id);
    expect(steps).toEqual([{ kind: 'department_head', roleKey: null, userId: U.head }]);
    expect(steps.some((s) => s.roleKey === 'accountant' || s.roleKey === 'finance')).toBe(false);
    expect((await prRow(id)).status).toBe('submitted');
  });

  it('adds a Management step for an emergency request', async () => {
    const { request } = await submitted({ isEmergency: true, emergencyReason: 'Pump failed' });
    expect(await stepsOf(request.id)).toEqual([
      { kind: 'department_head', roleKey: null, userId: U.head },
      { kind: 'role', roleKey: 'management', userId: null },
    ]);
  });

  it('falls back to operations_head when the department head is the requester', async () => {
    const { request } = await submitted({ departmentId: dept.selfHeaded });
    expect(await stepsOf(request.id)).toEqual([
      { kind: 'department_head', roleKey: 'operations_head', userId: null },
    ]);
  });

  it('falls back to operations_head when the department has no head', async () => {
    const { request } = await submitted({ departmentId: dept.headless });
    expect(await stepsOf(request.id)).toEqual([
      { kind: 'department_head', roleKey: 'operations_head', userId: null },
    ]);
  });

  it('with no head and no operations_head: 422 NO_ELIGIBLE_APPROVER, no request row, still a draft', async () => {
    roles.operations_head = [];
    const d = await draft({ departmentId: dept.headless });
    const error = await httpErrorOf(service.submit(d.id, undefined, randomUUID()));
    expect(error.getStatus()).toBe(422);
    expect(codeOf(error)).toBe('NO_ELIGIBLE_APPROVER');

    expect(await requestsOf(d.id)).toEqual([]);
    const row = await prRow(d.id);
    expect(row.status).toBe('draft');
    expect(row.number).toBeNull();
    expect(row.approvalRequestId).toBeNull();
    // The admins are told, in a transaction of their own, and the notice opens the inbox.
    expect(notify.notifyRole).toHaveBeenCalled();
    expect(notify.notifyRole.mock.calls[0]![2]).toMatchObject({ link: '/inbox/' });

    // Once someone holds the role, the same draft submits and takes the first number only now.
    roles.operations_head = [U.ops];
    const ok = await service.submit(d.id, undefined, randomUUID());
    expect(ok.status).toBe('submitted');
    expect(ok.number).not.toBeNull();
  });

  it('a retried submit with the same Idempotency-Key opens one approval request', async () => {
    const d = await draft();
    const key = randomUUID();
    const first = await service.submit(d.id, undefined, key);
    const second = await service.submit(d.id, undefined, key);
    expect(second).toEqual(first);
    expect(await requestsOf(d.id)).toHaveLength(1);
  });
});

describe('purchase request: the decision', () => {
  it('names the requesting department of the snapshot for its approver', async () => {
    const { request } = await submitted();
    const [d] = await withTx(db, scopeA, systemActor('test'), (tx) =>
      tx
        .select({ id: departments.id, name: departments.name })
        .from(departments)
        .where(eq(departments.id, dept.headed)),
    );
    as(U.head, 'operations_officer');
    const dto = await approvals.get(request.id);
    expect(dto.snapshot).toMatchObject({ purchaseRequest: { departmentId: dept.headed } });
    expect(dto.references).toEqual([{ id: dept.headed, name: d!.name }]);
  });

  it('lets the designated officer read, see and decide only their active PR head step, with an exact replay', async () => {
    const { id, request } = await submitted();
    as(U.head, 'operations_officer');
    expect(can(principalNow(), 'approvals.requests.act').allowed).toBe(false);
    expect((await approvals.inbox()).map((i) => i.requestId)).toContain(request.id);
    expect((await approvals.get(request.id)).requestId).toBe(request.id);
    const action = { action: 'approve' as const, expectedVersion: request.version };
    const key = randomUUID();
    await approvals.getForAction(request.id, action, key);
    const first = await approvals.act(request.id, action, key);
    expect((await prRow(id)).status).toBe('dept_approved');
    expect((await approvals.inbox()).some((i) => i.requestId === request.id)).toBe(false);
    expect((await httpErrorOf(approvals.get(request.id))).getStatus()).toBe(404);
    await approvals.getForAction(request.id, action, key);
    expect(await approvals.act(request.id, action, key)).toEqual(first);
    as(U.other, 'operations_officer');
    expect((await httpErrorOf(approvals.getForAction(request.id, action, key))).getStatus()).toBe(
      404,
    );
    expect((await httpErrorOf(approvals.act(request.id, action, key))).getStatus()).toBe(404);
    as(U.head, 'operations_officer');
    expect(
      (await httpErrorOf(approvals.getForAction(request.id, action, randomUUID()))).getStatus(),
    ).toBe(404);
    expect(
      (
        await httpErrorOf(
          approvals.getForAction(request.id, { ...action, expectedVersion: 99 }, key),
        )
      ).getStatus(),
    ).toBe(404);
  });

  it('exposes no head request to an unrelated officer, and preserves the entity and tenant walls', async () => {
    const { request } = await submitted();
    as(U.other, 'operations_officer');
    expect((await httpErrorOf(approvals.inbox())).getStatus()).toBe(403);
    expect((await httpErrorOf(approvals.get(request.id))).getStatus()).toBe(404);
    expect(
      (
        await httpErrorOf(
          approvals.act(request.id, { action: 'approve', expectedVersion: 99 }, randomUUID()),
        )
      ).getStatus(),
    ).toBe(404);
    as(U.head, 'operations_officer');
    for (const foreign of [scopeB, { ...scopeA, tenantId: randomUUID() }]) {
      current.scope = foreign;
      expect((await httpErrorOf(approvals.get(request.id))).getStatus()).toBe(404);
      expect(
        (
          await httpErrorOf(
            approvals.act(request.id, { action: 'approve', expectedVersion: 1 }, randomUUID()),
          )
        ).getStatus(),
      ).toBe(404);
    }
  });

  it('removes access when the named head loses that department designation', async () => {
    const { request } = await submitted();
    await read((tx) =>
      tx.execute(
        sql`UPDATE app.departments SET head_user_id = ${U.other} WHERE id = ${dept.headed}`,
      ),
    );
    // Remaining head of another department does not keep the old request assignment valid.
    await read((tx) =>
      tx.execute(
        sql`UPDATE app.departments SET head_user_id = ${U.head} WHERE id = ${dept.selfHeaded}`,
      ),
    );
    try {
      as(U.head, 'operations_officer');
      expect((await httpErrorOf(approvals.get(request.id))).getStatus()).toBe(404);
      expect(
        (
          await httpErrorOf(
            approvals.act(request.id, { action: 'approve', expectedVersion: 1 }, randomUUID()),
          )
        ).getStatus(),
      ).toBe(404);
    } finally {
      await read((tx) =>
        tx.execute(
          sql`UPDATE app.departments SET head_user_id = ${U.head} WHERE id = ${dept.headed}`,
        ),
      );
      await read((tx) =>
        tx.execute(
          sql`UPDATE app.departments SET head_user_id = ${U.req} WHERE id = ${dept.selfHeaded}`,
        ),
      );
    }
  });

  it('ends the head exception when an emergency PR moves to its Management role step', async () => {
    const { request } = await submitted({ isEmergency: true, emergencyReason: 'Urgent repair' });
    await act(U.head, 'operations_officer', request.id, 'approve');
    as(U.head, 'operations_officer');
    expect((await approvals.inbox()).some((i) => i.requestId === request.id)).toBe(false);
    expect((await httpErrorOf(approvals.get(request.id))).getStatus()).toBe(404);
    expect(
      (
        await httpErrorOf(
          approvals.act(request.id, { action: 'approve', expectedVersion: 2 }, randomUUID()),
        )
      ).getStatus(),
    ).toBe(404);
  });

  it('keeps a head delegate eligible but never lets the requester act through a delegation', async () => {
    as(U.admin, 'founder');
    const admin = new ApprovalsAdminService(db, new AuditService(db), caller, () => now);
    const delegated = [];
    for (const toUserId of [U.other, U.req]) {
      delegated.push(
        await admin.createDelegation({
          fromUserId: U.head,
          toUserId,
          startsAt: new Date(now.getTime() - 60_000),
          endsAt: new Date(now.getTime() + 60_000),
          documentType: 'purchase_request',
        }),
      );
    }
    try {
      as(U.req, 'operations_officer');
      const { request } = await submitted();
      expect((await approvals.inbox()).some((i) => i.requestId === request.id)).toBe(false);
      expect(
        (
          await httpErrorOf(
            approvals.act(request.id, { action: 'approve', expectedVersion: 1 }, randomUUID()),
          )
        ).getStatus(),
      ).toBe(404);
      as(U.other, 'operations_officer');
      expect((await approvals.inbox()).some((i) => i.requestId === request.id)).toBe(true);
      expect((await approvals.get(request.id)).requestId).toBe(request.id);
      const decided = await approvals.act(
        request.id,
        { action: 'approve', expectedVersion: 1 },
        randomUUID(),
      );
      expect(decided.steps[0]).toMatchObject({
        decidedBy: U.other,
        decidedOnBehalfOf: U.head,
      });
    } finally {
      as(U.admin, 'founder');
      for (const d of delegated) await admin.revokeDelegation(d.id);
    }
  });

  it('admits the operations_head fallback only while the effective token retains that role', async () => {
    const { request } = await submitted({ departmentId: dept.headless });
    as(U.ops, 'operations_head');
    expect(can(principalNow(), 'approvals.requests.act').allowed).toBe(false);
    expect((await approvals.inbox()).some((i) => i.requestId === request.id)).toBe(true);
    expect((await approvals.get(request.id)).requestId).toBe(request.id);
    // The directory mirror still lists this user; the effective token no longer carries the role.
    as(U.ops, 'operations_officer');
    expect((await httpErrorOf(approvals.inbox())).getStatus()).toBe(403);
    expect((await httpErrorOf(approvals.get(request.id))).getStatus()).toBe(404);
    expect(
      (
        await httpErrorOf(
          approvals.act(request.id, { action: 'approve', expectedVersion: 1 }, randomUUID()),
        )
      ).getStatus(),
    ).toBe(404);
    as(U.ops, 'operations_head');
    expect(
      (await approvals.act(request.id, { action: 'approve', expectedVersion: 1 }, randomUUID()))
        .status,
    ).toBe('approved');
  });

  it.each(['user', 'department_head'] as const)(
    'does not grant a named officer rights on a non-PR %s workflow',
    async (kind) => {
      as(U.admin, 'founder');
      const documentType = `head_control_${kind}`;
      const admin = new ApprovalsAdminService(db, new AuditService(db), caller, () => now);
      await admin.createWorkflow({
        key: documentType,
        name: documentType,
        spec: {
          documentType,
          steps: [
            { id: 'head', kind, ...(kind === 'user' ? { user: U.head } : {}), reason: 'Control' },
          ],
        },
      });
      await admin.publish(documentType, 1);
      approvals.registerSubject({ documentType, onDecided: async () => {} });
      const { requestId } = await read((tx) =>
        approvals.submit(tx, {
          documentType,
          documentId: randomUUID(),
          title: 'Control request',
          snapshot: {},
          facts: { departmentId: dept.headed },
          requesterUserId: U.req,
          sodUserIds: [U.req],
        }),
      );
      as(U.head, 'operations_officer');
      expect((await approvals.inbox()).some((i) => i.requestId === requestId)).toBe(false);
      expect((await httpErrorOf(approvals.get(requestId))).getStatus()).toBe(404);
      expect(
        (
          await httpErrorOf(
            approvals.act(requestId, { action: 'approve', expectedVersion: 1 }, randomUUID()),
          )
        ).getStatus(),
      ).toBe(404);
    },
  );

  it('approve moves it to dept_approved', async () => {
    const { id, request } = await submitted();
    await act(U.head, 'operations_officer', request.id, 'approve');
    const row = await prRow(id);
    expect(row.status).toBe('dept_approved');
    expect(row.version).toBe(3);
    expect((await service.get(id)).status).toBe('dept_approved');
  });

  it('an emergency request is dept_approved only after Management too', async () => {
    const { id, request } = await submitted({ isEmergency: true, emergencyReason: 'Pump failed' });
    await act(U.head, 'operations_officer', request.id, 'approve');
    expect((await prRow(id)).status).toBe('submitted');
    await act(U.mgmt, 'management', request.id, 'approve');
    expect((await prRow(id)).status).toBe('dept_approved');
  });

  it('reject moves it to rejected', async () => {
    const { id, request } = await submitted();
    await act(U.head, 'operations_officer', request.id, 'reject');
    expect((await prRow(id)).status).toBe('rejected');
  });

  it('the requester cannot approve their own request when they head the department', async () => {
    const { request } = await submitted({ departmentId: dept.selfHeaded });
    const error = await httpErrorOf(act(U.req, 'operations_officer', request.id, 'approve'));
    expect(error.getStatus()).toBe(404);
  });

  it('return moves it to returned; it is editable, keeps its number on resubmit and gets a new request', async () => {
    const { id, dto, request } = await submitted();
    await act(U.head, 'operations_officer', request.id, 'return');
    expect((await prRow(id)).status).toBe('returned');

    const edited = await service.update(
      id,
      body({
        lines: [
          { description: 'Chairs', uom: 'pcs', quantity: '12', estimatedUnitPrice: '4500.00' },
        ],
      }),
      undefined,
      randomUUID(),
    );
    expect(edited).toMatchObject({
      status: 'returned',
      estimatedTotal: '54000.00',
      estimatedTotalNpr: null,
      fxRate: null,
    });

    const again = await service.submit(id, undefined, randomUUID());
    expect(again).toMatchObject({ status: 'submitted', number: dto.number });
    expect(again.estimatedTotalNpr).toBe('54000.00');
    expect(await requestsOf(id)).toHaveLength(2);
  });
});

describe('purchase request: lines are frozen after submit', () => {
  it('the service refuses an edit with 409', async () => {
    const { id } = await submitted();
    const error = await httpErrorOf(service.update(id, body(), undefined, randomUUID()));
    expect(error.getStatus()).toBe(409);
  });

  it('the database trigger refuses a line insert, update and delete on a submitted request', async () => {
    const { id } = await submitted();
    const [line] = await read((tx) =>
      tx.select().from(purchaseRequestLines).where(eq(purchaseRequestLines.purchaseRequestId, id)),
    );
    await expect(
      read((tx) =>
        tx
          .update(purchaseRequestLines)
          .set({ quantity: '99' })
          .where(eq(purchaseRequestLines.id, line!.id)),
      ),
    ).rejects.toThrow();
    await expect(
      read((tx) => tx.delete(purchaseRequestLines).where(eq(purchaseRequestLines.id, line!.id))),
    ).rejects.toThrow();
    await expect(
      read((tx) =>
        tx.insert(purchaseRequestLines).values({
          ...scopeA,
          purchaseRequestId: id,
          lineNo: 2,
          description: 'Sneaked in',
          uom: 'pcs',
          quantity: '1',
          estimatedUnitPrice: '1.00',
          estimatedAmount: '1.00',
        }),
      ),
    ).rejects.toThrow();
  });

  it('a submitted request cannot be cancelled; a draft can', async () => {
    const { id } = await submitted();
    expect((await httpErrorOf(service.cancel(id, undefined, randomUUID()))).getStatus()).toBe(409);
    const d = await draft();
    expect((await service.cancel(d.id, undefined, randomUUID())).status).toBe('cancelled');
  });

  it('a stale expectedVersion is a 409', async () => {
    const d = await draft();
    const error = await httpErrorOf(service.submit(d.id, d.version + 1, randomUUID()));
    expect(error.getStatus()).toBe(409);
  });
});

describe('purchase request: scope', () => {
  it('another entity sees 404 on every route, and cannot name our department', async () => {
    const d = await draft();
    current.scope = scopeB;
    expect((await httpErrorOf(service.get(d.id))).getStatus()).toBe(404);
    expect(
      (await httpErrorOf(service.update(d.id, body(), undefined, randomUUID()))).getStatus(),
    ).toBe(404);
    expect((await httpErrorOf(service.submit(d.id, undefined, randomUUID()))).getStatus()).toBe(
      404,
    );
    expect((await httpErrorOf(service.cancel(d.id, undefined, randomUUID()))).getStatus()).toBe(
      404,
    );
    expect((await service.list({ limit: 200, offset: 0 })).rows).toEqual([]);
    // A department of entity B is not a department of the acting entity A.
    current.scope = null;
    const error = await httpErrorOf(draft({ departmentId: dept.otherEntity }));
    expect(error.getStatus()).toBe(400);
    expect((await prRow(d.id)).status).toBe('draft');
  });

  it('under own scope another requester gets 404, and Procurement (all) reads it', async () => {
    const d = await draft();
    as(U.other, 'operations_officer');
    expect((await httpErrorOf(service.get(d.id))).getStatus()).toBe(404);
    expect((await httpErrorOf(service.submit(d.id, undefined, randomUUID()))).getStatus()).toBe(
      404,
    );
    expect((await service.list({ limit: 200, offset: 0 })).rows.map((r) => r.id)).not.toContain(
      d.id,
    );

    as(U.proc, 'procurement');
    expect((await service.get(d.id)).id).toBe(d.id);
    expect((await service.list({ limit: 200, offset: 0 })).rows.map((r) => r.id)).toContain(d.id);
    // Reading everything does not let Procurement edit someone else's request.
    expect(
      (await httpErrorOf(service.update(d.id, body(), undefined, randomUUID()))).getStatus(),
    ).toBe(404);

    // The requester's own list is not empty under `own` scope.
    as(U.req, 'operations_officer');
    expect((await service.list({ limit: 200, offset: 0 })).rows.map((r) => r.id)).toContain(d.id);
    expect(
      (await service.list({ status: ['cancelled'], limit: 200, offset: 0 })).rows.map((r) => r.id),
    ).not.toContain(d.id);
  });
});

describe('purchase request: list filters, search and paging', () => {
  it('filters by several statuses, searches, pages with a stable total and keeps the scope', async () => {
    as(U.req, 'operations_officer');
    const chairs = await draft({ justification: 'Chairs for the Himalayan lounge' });
    const desks = await draft({ justification: 'Standing desks for finance' });
    await service.cancel(desks.id, undefined, randomUUID());

    const both = await service.list({ status: ['draft', 'cancelled'], limit: 200, offset: 0 });
    expect(both.rows.map((r) => r.id)).toEqual(expect.arrayContaining([chairs.id, desks.id]));
    const onlyCancelled = await service.list({ status: ['cancelled'], limit: 200, offset: 0 });
    expect(onlyCancelled.rows.map((r) => r.id)).not.toContain(chairs.id);

    const found = await service.list({ q: 'standing desks', limit: 50, offset: 0 });
    expect(found.rows.map((r) => r.id)).toEqual([desks.id]);
    expect(found.total).toBe(1);

    const all = await service.list({ limit: 200, offset: 0 });
    const first = await service.list({ limit: 1, offset: 0 });
    const second = await service.list({ limit: 1, offset: 1 });
    expect(first.total).toBe(all.total);
    expect(first.rows[0]?.id).toBe(all.rows[0]?.id);
    expect(second.rows[0]?.id).toBe(all.rows[1]?.id);

    // Another entity gets neither the rows nor the count, whatever the filter says.
    current.scope = scopeB;
    const other = await service.list({
      q: 'standing desks',
      status: ['cancelled'],
      limit: 50,
      offset: 0,
    });
    expect(other).toEqual({ rows: [], total: 0 });
  });
});

describe('purchase request: the live RFQ', () => {
  /** An RFQ row of entity A for the request, as the sourcing unit leaves it. */
  const insertRfq = async (prId: string, status: 'open' | 'cancelled') => {
    const id = randomUUID();
    await read((tx) =>
      tx.execute(
        sql`INSERT INTO app.rfqs (id, tenant_id, organization_id, purchase_request_id, number, deadline, status, created_by)
            VALUES (${id}, ${scopeA.tenantId}, ${scopeA.organizationId}, ${prId}, ${`RFQ-T-${id.slice(0, 8)}`},
                    '2026-11-20T10:00:00Z', ${status}, ${U.proc})`,
      ),
    );
    return id;
  };

  it('is null before an RFQ exists, on get, list and every write answer', async () => {
    const d = await draft();
    expect(d.rfqId).toBeNull();
    expect((await service.get(d.id)).rfqId).toBeNull();
    const listed = (await service.list({ limit: 200, offset: 0 })).rows.find((r) => r.id === d.id);
    expect(listed?.rfqId).toBeNull();
    expect((await service.update(d.id, body(), undefined, randomUUID())).rfqId).toBeNull();
    expect((await service.submit(d.id, undefined, randomUUID())).rfqId).toBeNull();
    const c = await draft();
    expect((await service.cancel(c.id, undefined, randomUUID())).rfqId).toBeNull();
  });

  it('names the live RFQ on get and list, and ignores a cancelled one', async () => {
    const withRfq = await draft();
    const cancelledOnly = await draft();
    const dead = await insertRfq(cancelledOnly.id, 'cancelled');
    const old = await insertRfq(withRfq.id, 'cancelled');
    const live = await insertRfq(withRfq.id, 'open');
    expect(dead).not.toBe(old);

    expect((await service.get(withRfq.id)).rfqId).toBe(live);
    expect((await service.get(cancelledOnly.id)).rfqId).toBeNull();
    const listed = (await service.list({ limit: 200, offset: 0 })).rows;
    expect(listed.find((r) => r.id === withRfq.id)?.rfqId).toBe(live);
    expect(listed.find((r) => r.id === cancelledOnly.id)?.rfqId).toBeNull();
  });

  it('never shows the RFQ of another entity: that request is a 404 there', async () => {
    const d = await draft();
    await insertRfq(d.id, 'open');
    current.scope = scopeB;
    expect((await httpErrorOf(service.get(d.id))).getStatus()).toBe(404);
    expect((await service.list({ limit: 200, offset: 0 })).rows).toEqual([]);
  });
});

describe('purchase request cost centres', () => {
  it.each(['inactive', 'otherEntity'] as const)(
    'refuses a %s cost centre on create',
    async (kind) => {
      as(U.req, 'operations_officer');
      current.scope = null;
      await expect(
        service.create(body({ costCenterId: centers[kind] }), randomUUID()),
      ).rejects.toBeInstanceOf(BadRequestException);
    },
  );
});

describe('editing a request with a retired cost centre', () => {
  it('allows unrelated edits while retaining its original centre', async () => {
    const { costCenterId } = await createCostCenter(appPool, scopeA);
    const draft = await service.create(body({ costCenterId }), randomUUID());
    await withTx(db, scopeA, systemActor('test'), (tx) =>
      tx.execute(sql`UPDATE app.cost_centers SET active = false WHERE id = ${costCenterId}`),
    );
    const updated = await service.update(
      draft.id,
      body({ costCenterId, justification: 'Updated need' }),
      draft.version,
      randomUUID(),
    );
    expect(updated.costCenterId).toBe(costCenterId);
    expect(updated.justification).toBe('Updated need');
    await expect(
      service.update(
        updated.id,
        body({ costCenterId: centers.otherEntity }),
        updated.version,
        randomUUID(),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('department and cost-centre names on a request (I-27)', () => {
  /** The stored names, read as the system so the test does not trust the service's own lookup. */
  const namesOf = async (deptId: string, ccId: string) =>
    read(async (tx) => {
      const [d] = await tx
        .execute<{ name: string }>(sql`SELECT name FROM app.departments WHERE id = ${deptId}`)
        .then((r) => r.rows);
      const [c] = await tx
        .execute<{ name: string }>(sql`SELECT name FROM app.cost_centers WHERE id = ${ccId}`)
        .then((r) => r.rows);
      return { departmentName: d!.name, costCenterName: c!.name };
    });

  it("names another requester's department and cost centre for Procurement, in the detail and the list", async () => {
    const mine = await draft();
    const expected = await namesOf(dept.headed, centers.active);
    as(U.proc, 'procurement');
    const got = await service.get(mine.id);
    expect(got.requesterUserId).toBe(U.req);
    expect({ departmentName: got.departmentName, costCenterName: got.costCenterName }).toEqual(
      expected,
    );
    const row = (await service.list({ limit: 100, offset: 0 })).rows.find((r) => r.id === mine.id);
    expect(row).toMatchObject(expected);
  });

  it('names each request by its own department when several are listed', async () => {
    const other = await draft({ departmentId: dept.headless });
    const expected = await namesOf(dept.headless, centers.active);
    as(U.proc, 'procurement');
    const row = (await service.list({ limit: 100, offset: 0 })).rows.find((r) => r.id === other.id);
    expect(row?.departmentName).toBe(expected.departmentName);
  });

  it("does not show another entity's request, or its names, to entity A's Procurement", async () => {
    const { costCenterId } = await createCostCenter(appPool, {
      ...scopeB,
      name: `Entity B centre ${randomUUID()}`,
    });
    current.scope = scopeB;
    const theirs = await service.create(
      body({ departmentId: dept.otherEntity, costCenterId }),
      randomUUID(),
    );
    const theirNames = await namesOf(dept.otherEntity, costCenterId);
    current.scope = null;
    as(U.proc, 'procurement');
    const listed = await service.list({ limit: 100, offset: 0 });
    expect(listed.rows.some((r) => r.id === theirs.id)).toBe(false);
    expect(JSON.stringify(listed)).not.toContain(theirNames.departmentName);
    expect(JSON.stringify(listed)).not.toContain(theirNames.costCenterName);
    expect((await httpErrorOf(service.get(theirs.id))).getStatus()).toBe(404);
  });
});
