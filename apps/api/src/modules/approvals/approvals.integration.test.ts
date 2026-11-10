// Integration tests for the approval engine on a real Postgres (Testcontainers, needs Docker in WSL).
// Migrations run as bos_owner and the engine runs as bos_app, like production. Only the other units'
// services are faked: audit, notify, the user directory and the caller. The ADR 0027 tests switch the
// directory to the real SqlUsersStore, so membership role_keys are read from the database.
// Covers P1-PLAN section 7 U7: spec immutability, new versions, act idempotency, the 409s and 403s,
// separation of duties, delegation, blocked requests and the SLA tick with a fake clock.
import { randomUUID } from 'node:crypto';

import {
  PERMISSIONS,
  WorkflowSpecSchema,
  type Permission,
  type RoleKey,
  type Scope,
} from '@bos/contracts';
import {
  approvalActions,
  approvalRequests,
  approvalSteps,
  checkTenancy,
  createDepartment,
  createStaffUser,
  createTenantWithEntity,
  runMigrations,
} from '@bos/db';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { and, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Principal } from '../../platform/authz/principal';
import type { Db } from '../../platform/db/db.module';
import { systemActor, withTx } from '../../platform/db/tx';
import { buildLink, renderEmail } from '../../platform/notify/templates';
import { SqlUsersStore } from '../../platform/users/users.store';
import { ApprovalsAdminService } from './admin.service';
import { canonicalSha256 } from '../../platform/hashing/canonical-json';
import type { ApprovalEmailTemplate, Caller } from './ports';
import { ApprovalsService, type SubmitInput } from './requests.service';
import { ApprovalsSlaService } from './sla.processor';

const WORKSPACE_URL = 'http://workspace.test';
const OWNER_PW = 'owner-test-pw';
const APP_PW = 'app-test-pw';
// The ids come from the @bos/db fixtures in beforeAll (they pick their own uuids).
const scope = { tenantId: '', organizationId: '' };
let staffIdpOrgId = '';
const U = {
  requester: '',
  acc: '',
  fin: '',
  both: '', // holds accountant and finance
  mgmt: '',
  founder: '',
  deputy: '',
  stranger: '',
};
// A second entity in the same tenant, a user who is a member there only, and users with other statuses
// (R10, R22, R24).
const scopeB = { tenantId: '', organizationId: randomUUID() };
let userB = '';
let inactiveUser = '';
let leaver = '';
/** ADR 0027: finance in the mirror (and the token), but the membership in `scope` allows only sales. */
let narrowFin = '';
const roles: Partial<Record<RoleKey, string[]>> = {};
const resetRoles = () => {
  roles.accountant = [U.acc, U.both];
  roles.finance = [U.fin, U.both];
  roles.management = [U.mgmt];
  roles.founder = [U.founder];
};

const seedSpec = {
  documentType: 'test_memo',
  steps: [
    {
      id: 'accountant',
      kind: 'role',
      role: 'accountant',
      reason: 'Base route: accountant checks the memo',
    },
    { id: 'finance', kind: 'role', role: 'finance', reason: 'Base route: finance approves' },
  ],
  rules: [
    {
      id: 'over-10-lakh',
      when: { field: 'amountNpr', op: 'gt', value: '1000000' },
      add: { id: 'founder', kind: 'role', role: 'founder', reason: 'Founder approval' },
      position: 'end',
      reason: 'Founder approval because NPR equivalent exceeds 10,00,000',
    },
  ],
};

let container: StartedPostgreSqlContainer;
let ownerPool: Pool;
let appPool: Pool;
let db: Db;
let now = new Date('2026-11-08T04:00:00Z');
let me: string = U.acc;
const allGrants = new Map<Permission, Scope>(PERMISSIONS.map((p) => [p, 'all']));
let grants: Map<Permission, Scope> = allGrants;
let callerScope = scope;
/** The token's roles; by default the ones the mirror gives `me`. R2 sets a token that disagrees. */
let tokenRoles: RoleKey[] | undefined;
const rolesOf = (id: string) =>
  (Object.keys(roles) as RoleKey[]).filter((r) => roles[r]?.includes(id) === true);

const audit = { record: vi.fn(() => Promise.resolve(undefined)) };
// The fakes run the REAL template validation, as NotifyService does at enqueue time. A var the template
// ignores or a link outside /inbox/ and /memos/ then fails here, not first in an email inbox.
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
const nameOfUser = (id: string) => Object.entries(U).find(([, v]) => v === id)?.[0] ?? 'unknown';
/** When true, role holders come from the real SqlUsersStore (ADR 0027 tests); beforeEach resets it. */
let realDirectory = false;
let store: SqlUsersStore;
const users = {
  userIdsWithRole: vi.fn((s: { tenantId: string; organizationId: string }, role: RoleKey) =>
    realDirectory ? store.userIdsWithRole(s, role) : Promise.resolve(roles[role] ?? []),
  ),
  resolve: vi.fn(),
  emailOf: vi.fn((id: string) => Promise.resolve(`${nameOfUser(id)}@bos.test`)),
};
const caller = {
  current: (): Caller => ({
    scope: callerScope,
    actor: { kind: 'user' as const, id: me, correlationId: 'test-corr' },
    principal: {
      userId: me,
      zitadelUserId: `z-${me}`,
      ...callerScope,
      orgKind: 'staff',
      partyId: null,
      idpOrgId: staffIdpOrgId,
      roles: tokenRoles ?? rolesOf(me),
      departmentId: null,
      status: 'active',
      grants,
    } satisfies Principal,
  }),
};
const clock = () => now;
const onDecided = vi.fn(() => Promise.resolve(undefined));

let service: ApprovalsService;
let admin: ApprovalsAdminService;
let sla: ApprovalsSlaService;

function urlFor(user: string, password: string, database: string): string {
  const url = new URL(container.getConnectionUri());
  url.username = user;
  url.password = password;
  url.pathname = `/${database}`;
  return url.toString();
}

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
  appPool = new Pool({ connectionString: urlFor('bos_app', APP_PW, 'bos'), max: 4 });
  db = drizzle({ client: appPool });

  // The tenant with its default entity (scope), a second entity (scopeB) and a staff user with a
  // membership for every test user: admin checks that users are active members of the acting entity and
  // approvers must be active (R22, R24), so the people the tests route to must be real rows.
  const t = await createTenantWithEntity(ownerPool);
  Object.assign(scope, { tenantId: t.tenantId, organizationId: t.organizationId });
  scopeB.tenantId = t.tenantId;
  staffIdpOrgId = t.idpOrgId;
  // No fixture adds a second entity to a tenant. Through withTx: the audit triggers need bos.actor_id.
  await withTx(db, scopeB, systemActor('test-seed'), (tx) =>
    tx.execute(
      sql`INSERT INTO app.organizations (id, tenant_id, organization_id, code, name, legal_name, is_default)
          VALUES (${scopeB.organizationId}, ${scopeB.tenantId}, ${scopeB.organizationId},
                  ${`B${scopeB.organizationId.slice(0, 8)}`}, 'Entity B', 'Entity B', false)`,
    ),
  );
  // The user_roles mirror matches resetRoles(), so the real store and the fake agree.
  const mirror: Record<keyof typeof U, RoleKey[]> = {
    requester: [],
    acc: ['accountant'],
    fin: ['finance'],
    both: ['accountant', 'finance'],
    mgmt: ['management'],
    founder: ['founder'],
    deputy: [],
    stranger: [],
  };
  const staff = async (organizationId: string, roleKeys: RoleKey[] = []) =>
    (
      await createStaffUser(ownerPool, {
        tenantId: scope.tenantId,
        organizationId,
        idpOrgId: staffIdpOrgId,
        roleKeys,
      })
    ).userId;
  for (const key of Object.keys(U) as (keyof typeof U)[]) {
    U[key] = await staff(scope.organizationId, mirror[key]);
  }
  leaver = await staff(scope.organizationId);
  inactiveUser = await staff(scope.organizationId);
  userB = await staff(scopeB.organizationId);
  narrowFin = await staff(scope.organizationId, ['finance', 'sales']);
  await withTx(db, scope, systemActor('test-seed'), async (tx) => {
    await tx.execute(sql`UPDATE app.users SET status = 'inactive' WHERE id = ${inactiveUser}`);
    await tx.execute(
      sql`UPDATE app.user_entities SET role_keys = '{sales}'
          WHERE tenant_id = ${scope.tenantId} AND organization_id = ${scope.organizationId}
            AND user_id = ${narrowFin}`,
    );
  });
  store = new SqlUsersStore(db);

  service = new ApprovalsService(db, audit, notify, users, caller, clock);
  admin = new ApprovalsAdminService(db, audit, caller, clock);
  sla = new ApprovalsSlaService(db, service, audit, notify, clock);
  // The memo's own registration (TestMemoService) gives the same link hook.
  service.registerSubject({
    documentType: 'test_memo',
    onDecided,
    link: (_tx, documentId) => `/memos/${documentId}`,
  });

  resetRoles();
  me = U.founder;
  await admin.createWorkflow({ key: 'test_memo', name: 'Test memo', spec: seedSpec });
  await admin.publish('test_memo', 1);
}, 180_000);

afterAll(async () => {
  await appPool?.end();
  await ownerPool?.end();
  await container?.stop();
});

beforeEach(() => {
  vi.clearAllMocks();
  resetRoles();
  grants = allGrants;
  callerScope = scope;
  tokenRoles = undefined;
  realDirectory = false;
  now = new Date('2026-11-08T04:00:00Z');
});

const submit = (over: Partial<SubmitInput> = {}) =>
  withTx(db, scope, systemActor('test'), (tx) =>
    service.submit(tx, {
      documentType: 'test_memo',
      documentId: randomUUID(),
      documentNumber: 'MEMO-2082/83-00001',
      title: 'Office chairs',
      snapshot: { title: 'Office chairs', amount: '50000.00', currency: 'NPR' },
      facts: { amountNpr: '50000.00' },
      requesterUserId: U.requester,
      sodUserIds: [U.requester],
      ...over,
    }),
  );

const submitMemo = submit;

const act = (as: string, requestId: string, body: object, key = randomUUID()) => {
  me = as;
  return service.act(requestId, body as never, key);
};

const countActions = async (requestId: string, action: string) =>
  (await db.select().from(approvalActions).where(eq(approvalActions.requestId, requestId))).filter(
    (a) => a.action === action,
  ).length;

describe('assignment people lookup', () => {
  it('paginates only active staff in the caller tenant/entity and accepts the selected assignments', async () => {
    grants = new Map<Permission, Scope>([
      ['approvals.groups.write', 'all'],
      ['approvals.delegations.write', 'all'],
    ]);
    expect(caller.current().principal.grants.has('admin.users.read')).toBe(false);
    const foreign = await createTenantWithEntity(ownerPool);
    const outsider = await createStaffUser(ownerPool, foreign);
    const found: string[] = [];
    let after: string | undefined;
    do {
      const page = await admin.listAssignmentPeople({ limit: 2, after });
      found.push(...page.items.map((u) => u.id));
      after = page.nextAfter ?? undefined;
    } while (after);
    expect(found).toContain(U.acc);
    expect(found).toContain(U.deputy);
    expect(found).not.toContain(outsider.userId);
    expect(found).not.toContain(userB);
    expect(found).not.toContain(inactiveUser);
    const group = await admin.createGroup({
      key: `picker-${randomUUID()}`,
      name: 'Picker regression',
    });
    await admin.addMember(group.id, U.acc);
    await expect(admin.addMember(group.id, outsider.userId)).rejects.toThrow('Not an active user');
    const delegation = await admin.createDelegation({
      fromUserId: U.acc,
      toUserId: U.deputy,
      startsAt: now,
      endsAt: new Date(now.getTime() + 3_600_000),
      documentType: null,
    });
    expect(delegation.id).toBeTruthy();
    await admin.revokeDelegation(delegation.id);
    await admin.deleteGroup(group.id);
  });
});

describe('migration 0006', () => {
  it('gives every approvals table its tenancy columns', async () => {
    const mine = new Set([
      'app.workflow_definitions',
      'app.workflow_versions',
      'app.approval_groups',
      'app.approval_group_members',
      'app.delegations',
      'app.approval_requests',
      'app.approval_steps',
      'app.approval_actions',
    ]);
    const violations = await checkTenancy(ownerPool);
    expect(violations.filter((v) => mine.has(v.table))).toEqual([]);
  });

  it('keeps a published spec immutable, also for the table owner', async () => {
    const { rows } = await ownerPool.query<{ id: string }>(
      `SELECT v.id FROM app.workflow_versions v JOIN app.workflow_definitions d ON d.id = v.definition_id
       WHERE d.key = 'test_memo' AND v.version = 1`,
    );
    const id = rows[0]!.id;
    await expect(
      appPool.query(`UPDATE app.workflow_versions SET spec = '{}'::jsonb WHERE id = $1`, [id]),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      ownerPool.query(`UPDATE app.workflow_versions SET status = 'draft' WHERE id = $1`, [id]),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      ownerPool.query(`DELETE FROM app.workflow_versions WHERE id = $1`, [id]),
    ).rejects.toMatchObject({
      code: '23514',
    });
  });

  it('makes approval_actions append-only for bos_app', async () => {
    await expect(
      appPool.query(`UPDATE app.approval_actions SET comment = 'x'`),
    ).rejects.toMatchObject({
      code: '42501',
    });
    await expect(appPool.query(`DELETE FROM app.approval_actions`)).rejects.toMatchObject({
      code: '42501',
    });
  });
});

describe('submit', () => {
  it('freezes the snapshot hash, the version, reasons and the SLA times, and notifies step 1', async () => {
    const { requestId, status } = await submit();
    expect(status).toBe('pending');
    const [req] = await db
      .select()
      .from(approvalRequests)
      .where(eq(approvalRequests.id, requestId));
    expect(
      req!.snapshotSha256.equals(
        canonicalSha256({ currency: 'NPR', amount: '50000.00', title: 'Office chairs' }),
      ),
    ).toBe(true);
    const steps = await db
      .select()
      .from(approvalSteps)
      .where(eq(approvalSteps.requestId, requestId));
    expect(
      steps.sort((a, b) => a.seq - b.seq).map((s) => [s.seq, s.roleKey, s.status, s.reason]),
    ).toEqual([
      [1, 'accountant', 'active', 'Base route: accountant checks the memo'],
      [2, 'finance', 'waiting', 'Base route: finance approves'],
    ]);
    expect(steps[0]!.remindAt?.toISOString()).toBe('2026-11-09T04:00:00.000Z');
    expect(steps[0]!.escalateAt?.toISOString()).toBe('2026-11-11T04:00:00.000Z');
    expect(notify.notifyUser.mock.calls.map((c) => (c as unknown[])[1])).toEqual([
      expect.objectContaining({ userId: U.acc, link: `/inbox/${requestId}` }),
      expect.objectContaining({ userId: U.both }),
    ]);
    // The pending email names the type and the requester and links to the request (each var is one
    // the template reads; the fake notify also rendered it through the real renderEmail).
    expect(notify.notifyUser.mock.calls[0]![1].email).toEqual({
      template: 'approval.pending',
      vars: {
        documentNumber: 'MEMO-2082/83-00001',
        documentType: 'test_memo',
        requesterName: 'requester',
        linkPath: `/inbox/${requestId}`,
      },
    });
    const pending = renderEmail(
      'approval.pending',
      notify.notifyUser.mock.calls[0]![1].email!.vars,
      {
        workspaceUrl: WORKSPACE_URL,
      },
    );
    expect(pending.subject).toBe('Approval needed: test_memo MEMO-2082/83-00001');
    expect(pending.text).toContain('requester asked you to review');
    expect(pending.text).toContain(`${WORKSPACE_URL}/inbox/${requestId}`);
    expect(audit.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'approvals.submit' }),
    );
  });

  it('refuses a second open request for the same document with 409', async () => {
    const documentId = randomUUID();
    await submit({ documentId });
    await expect(submit({ documentId })).rejects.toMatchObject({ status: 409 });
  });

  it('refuses facts the rules cannot evaluate with 400', async () => {
    await expect(submit({ facts: {} })).rejects.toMatchObject({ status: 400 });
  });

  it('blocks when SoD empties a step, tells founders, and reroute unblocks once fixed', async () => {
    roles.accountant = [U.requester];
    const { requestId, status } = await submit();
    expect(status).toBe('blocked');
    expect(notify.notifyRole).toHaveBeenCalledWith(
      expect.anything(),
      'founder',
      expect.objectContaining({
        email: {
          template: 'approval.blocked',
          vars: {
            documentNumber: 'MEMO-2082/83-00001',
            documentType: 'test_memo',
            linkPath: `/inbox/${requestId}`,
          },
        },
      }),
    );
    me = U.founder;
    const stillBlocked = await service.reroute(requestId);
    expect(stillBlocked).toMatchObject({ status: 'blocked', version: 2 });

    roles.accountant = [U.acc];
    const unblocked = await service.reroute(requestId);
    expect(unblocked).toMatchObject({ status: 'pending', version: 3, blockReason: null });
    expect(unblocked.steps[0]).toMatchObject({ status: 'active' });
    expect(await countActions(requestId, 'reroute')).toBe(2);

    // The approver leaves: a pending request becomes blocked again, and founders hear about it.
    notify.notifyRole.mockClear();
    roles.accountant = [U.requester];
    const reblocked = await service.reroute(requestId);
    expect(reblocked).toMatchObject({ status: 'blocked', version: 4 });
    expect(reblocked.steps[0]).toMatchObject({ status: 'waiting' });
    expect(notify.notifyRole).toHaveBeenCalledWith(
      expect.anything(),
      'founder',
      expect.objectContaining({ dedupeKey: `approval:${requestId}:blocked:4` }),
    );
  });

  it('previews the plan without writing', async () => {
    const plan = await service.preview(scope, 'test_memo', { amountNpr: '2000000' }, [U.requester]);
    expect(plan.steps.map((s) => s.roleKey)).toEqual(['accountant', 'finance', 'founder']);
  });
});

describe('act', () => {
  it('replays the same key and body without a second action row', async () => {
    const { requestId } = await submit();
    const key = randomUUID();
    const first = await act(U.acc, requestId, { action: 'approve', expectedVersion: 1 }, key);
    const again = await act(U.acc, requestId, { action: 'approve', expectedVersion: 1 }, key);
    expect(first.version).toBe(2);
    expect(again).toEqual(first);
    expect(await countActions(requestId, 'approve')).toBe(1);
  });

  it('answers 409 for the same key with a different body', async () => {
    const { requestId } = await submit();
    const key = randomUUID();
    await act(U.acc, requestId, { action: 'approve', expectedVersion: 1 }, key);
    await expect(
      act(U.acc, requestId, { action: 'reject', comment: 'no', expectedVersion: 1 }, key),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('answers 409 for a stale expectedVersion', async () => {
    const { requestId } = await submit();
    await act(U.acc, requestId, { action: 'approve', expectedVersion: 1 });
    await expect(
      act(U.fin, requestId, { action: 'approve', expectedVersion: 1 }),
    ).rejects.toMatchObject({
      status: 409,
    });
  });

  it('answers 403 out_of_scope to someone who is not an approver of the active step', async () => {
    const { requestId } = await submit();
    await expect(
      act(U.mgmt, requestId, { action: 'approve', expectedVersion: 1 }),
    ).rejects.toMatchObject({
      status: 403,
      response: { reason: 'out_of_scope' },
    });
  });

  it('answers 403 separation_of_duties to the requester, even when they hold the role', async () => {
    const { requestId } = await submit({ requesterUserId: U.both, sodUserIds: [U.both] });
    await expect(
      act(U.both, requestId, { action: 'approve', expectedVersion: 1 }),
    ).rejects.toMatchObject({
      status: 403,
      response: { reason: 'separation_of_duties' },
    });
  });

  it('answers 403 separation_of_duties when one approver tries a second step (distinctApprovers)', async () => {
    const { requestId } = await submit();
    await act(U.both, requestId, { action: 'approve', expectedVersion: 1 });
    await expect(
      act(U.both, requestId, { action: 'approve', expectedVersion: 2 }),
    ).rejects.toMatchObject({
      status: 403,
      response: { reason: 'separation_of_duties' },
    });
  });

  it('answers 400 to return or reject without a comment', async () => {
    const { requestId } = await submit();
    await expect(
      act(U.acc, requestId, { action: 'return', expectedVersion: 1 }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      act(U.acc, requestId, { action: 'reject', expectedVersion: 1 }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('approves through every step, then tells the document and the requester', async () => {
    const { requestId } = await submit();
    await act(U.acc, requestId, { action: 'approve', expectedVersion: 1 });
    const done = await act(U.fin, requestId, {
      action: 'approve',
      expectedVersion: 2,
      comment: 'ok',
    });
    expect(done).toMatchObject({ status: 'approved', version: 3 });
    expect(done.decidedAt).not.toBeNull();
    expect(onDecided).toHaveBeenCalledWith(expect.anything(), done.documentId, 'approved');
    const memoPath = `/memos/${done.documentId}`;
    expect(notify.notifyUser).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({
        userId: U.requester,
        link: memoPath,
        email: {
          template: 'approval.decided',
          vars: {
            documentNumber: 'MEMO-2082/83-00001',
            documentType: 'test_memo',
            decision: 'approved',
            deciderName: 'fin',
            linkPath: memoPath,
          },
        },
      }),
    );
    // The old `outcome` key was ignored by the template, so the subject said "updated".
    const decided = renderEmail(
      'approval.decided',
      notify.notifyUser.mock.lastCall![1].email!.vars,
      { workspaceUrl: WORKSPACE_URL },
    );
    expect(decided.subject).toBe('test_memo MEMO-2082/83-00001: approved');
    expect(decided.text).toContain('fin marked test_memo MEMO-2082/83-00001 as approved.');
    expect(decided.text).toContain(`${WORKSPACE_URL}${memoPath}`);
    await expect(
      act(U.fin, requestId, { action: 'approve', expectedVersion: 3 }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('a rejection ends the request and skips the waiting steps', async () => {
    const { requestId } = await submit();
    const done = await act(U.acc, requestId, {
      action: 'reject',
      comment: 'Duplicate',
      expectedVersion: 1,
    });
    expect(done.status).toBe('rejected');
    expect(done.steps.map((s) => s.status)).toEqual(['rejected', 'skipped']);
    expect(onDecided).toHaveBeenCalledWith(expect.anything(), done.documentId, 'rejected');
  });

  it('lets an active delegate decide on behalf of the approver, and only inside the dates', async () => {
    me = U.founder;
    const { id } = await admin.createDelegation({
      fromUserId: U.acc,
      toUserId: U.deputy,
      startsAt: new Date('2026-11-01T00:00:00Z'),
      endsAt: new Date('2026-11-10T00:00:00Z'),
      documentType: 'test_memo',
    });
    const { requestId } = await submit();
    const dto = await act(U.deputy, requestId, { action: 'approve', expectedVersion: 1 });
    expect(dto.steps[0]).toMatchObject({ decidedBy: U.deputy, decidedOnBehalfOf: U.acc });

    now = new Date('2026-11-12T00:00:00Z');
    const later = await submit();
    await expect(
      act(U.deputy, later.requestId, { action: 'approve', expectedVersion: 1 }),
    ).rejects.toMatchObject({
      status: 403,
    });
    me = U.founder;
    await admin.revokeDelegation(id);
  });

  it('answers 404 for an unknown request', async () => {
    await expect(
      act(U.acc, randomUUID(), { action: 'approve', expectedVersion: 1 }),
    ).rejects.toMatchObject({
      status: 404,
    });
  });
});

describe('versions, inbox and reading', () => {
  it('a new published version affects only new requests', async () => {
    const old = await submit();
    me = U.founder;
    const v2 = WorkflowSpecSchema.parse({
      ...seedSpec,
      steps: [
        ...seedSpec.steps,
        { id: 'mgmt', kind: 'role', role: 'management', reason: 'v2: management too' },
      ],
    });
    await admin.addVersion('test_memo', v2);
    await admin.publish('test_memo', 2);
    const fresh = await submit();

    me = U.acc;
    expect((await service.get(fresh.requestId)).steps).toHaveLength(3);
    await act(U.acc, old.requestId, { action: 'approve', expectedVersion: 1 });
    const done = await act(U.fin, old.requestId, { action: 'approve', expectedVersion: 2 });
    expect(done.status).toBe('approved');
    expect(done.steps).toHaveLength(2);

    const list = await admin.listWorkflows();
    expect(list[0]?.versions.map((v) => [v.version, v.status])).toEqual([
      [1, 'retired'],
      [2, 'published'],
    ]);
    await expect(admin.publish('test_memo', 2)).rejects.toMatchObject({ status: 409 });
    await expect(
      admin.addVersion('test_memo', { ...seedSpec, documentType: 'other' }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('shows a request in the inbox of its approvers only', async () => {
    const { requestId } = await submit({ facts: { amountNpr: '75000.50' } });
    me = U.acc;
    const mine = await service.inbox();
    expect(mine.find((i) => i.requestId === requestId)).toMatchObject({
      amountNpr: '75000.50',
      reason: 'Base route: accountant checks the memo',
      version: 1,
    });
    me = U.requester;
    expect((await service.inbox()).some((i) => i.requestId === requestId)).toBe(false);
  });

  it('lets the requester read their own request and refuses a stranger with own scope', async () => {
    const { requestId } = await submit();
    grants = new Map([['approvals.requests.read', 'own']]);
    me = U.requester;
    expect((await service.get(requestId)).requestId).toBe(requestId);
    // R23: out of scope answers like an unknown id, so the id's existence does not leak.
    me = U.stranger;
    await expect(service.get(requestId)).rejects.toMatchObject({ status: 404 });
  });
});

describe('SLA tick (fake clock)', () => {
  it('reminds once at 24 h and escalates once at 72 h, without reassigning', async () => {
    const start = new Date('2026-11-08T04:00:00Z');
    const hours = (h: number) => new Date(start.getTime() + h * 3_600_000);
    const { requestId } = await submit();
    // Other open requests from earlier tests are due too; count only this request's actions.
    const tickAt = async (h: number) => {
      await sla.tick(hours(h));
      return {
        remind: await countActions(requestId, 'remind'),
        escalate: await countActions(requestId, 'escalate'),
      };
    };
    expect(await tickAt(23)).toEqual({ remind: 0, escalate: 0 });
    expect(await tickAt(24)).toEqual({ remind: 1, escalate: 0 });
    expect(notify.notifyUser).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ dedupeKey: `approval:${requestId}:1:reminder` }),
    );
    expect(await tickAt(48)).toEqual({ remind: 1, escalate: 0 });
    expect(await tickAt(72)).toEqual({ remind: 1, escalate: 1 });
    expect(notify.notifyRole).toHaveBeenCalledWith(
      expect.anything(),
      'founder',
      expect.objectContaining({ dedupeKey: `approval:${requestId}:1:escalated` }),
    );
    expect(await tickAt(200)).toEqual({ remind: 1, escalate: 1 });

    const [step] = await db
      .select()
      .from(approvalSteps)
      .where(and(eq(approvalSteps.requestId, requestId), eq(approvalSteps.seq, 1)));
    expect(step).toMatchObject({ status: 'active', decidedBy: null, roleKey: 'accountant' });
    me = U.acc;
    expect((await service.get(requestId)).version).toBe(1);
  }, 30_000);
});

describe('admin: groups and delegations', () => {
  it('manages a group, routes a group step to its members, and refuses unknown groups on publish', async () => {
    me = U.founder;
    const groupSpec = {
      documentType: 'purchase',
      steps: [{ id: 'treasury', kind: 'group', group: 'treasury', reason: 'Treasury signs' }],
    };
    await admin.createWorkflow({ key: 'purchase', name: 'Purchase', spec: groupSpec });
    await expect(admin.publish('purchase', 1)).rejects.toMatchObject({ status: 400 });

    const { id } = await admin.createGroup({ key: 'treasury', name: 'Treasury' });
    await expect(admin.createGroup({ key: 'treasury', name: 'Again' })).rejects.toMatchObject({
      status: 409,
    });
    await admin.addMember(id, U.mgmt);
    await admin.addMember(id, U.fin);
    await admin.removeMember(id, U.fin);
    expect((await admin.listGroups()).find((g) => g.id === id)?.memberUserIds).toEqual([U.mgmt]);
    await admin.publish('purchase', 1);

    service.registerSubject({ documentType: 'purchase', onDecided });
    const { requestId } = await submit({ documentType: 'purchase' });
    const dto = await act(U.mgmt, requestId, { action: 'approve', expectedVersion: 1 });
    expect(dto).toMatchObject({
      status: 'approved',
      steps: [expect.objectContaining({ kind: 'group', groupId: id })],
    });

    me = U.founder;
    await expect(admin.deleteGroup(id)).rejects.toMatchObject({ status: 409 });
    await expect(admin.removeMember(id, U.stranger)).rejects.toMatchObject({ status: 404 });
    await expect(admin.addMember(randomUUID(), U.stranger)).rejects.toMatchObject({ status: 404 });
    const spare = await admin.createGroup({ key: 'spare', name: 'Spare' });
    await admin.deleteGroup(spare.id);
    await expect(admin.deleteGroup(spare.id)).rejects.toMatchObject({ status: 404 });
  });

  it('validates, lists and revokes delegations', async () => {
    me = U.founder;
    const window = {
      startsAt: new Date('2026-11-01T00:00:00Z'),
      endsAt: new Date('2026-11-02T00:00:00Z'),
      documentType: null,
    };
    expect(() =>
      admin.createDelegation({ fromUserId: U.acc, toUserId: U.acc, ...window }),
    ).toThrow();
    expect(() =>
      admin.createDelegation({
        fromUserId: U.acc,
        toUserId: U.fin,
        ...window,
        endsAt: window.startsAt,
      }),
    ).toThrow();
    const { id } = await admin.createDelegation({ fromUserId: U.fin, toUserId: U.mgmt, ...window });
    expect((await admin.listDelegations()).some((d) => d.id === id)).toBe(true);
    await admin.revokeDelegation(id);
    expect((await admin.listDelegations()).some((d) => d.id === id)).toBe(false);
    await expect(admin.revokeDelegation(id)).rejects.toMatchObject({ status: 404 });
    await expect(
      admin.createWorkflow({ key: 'bad', name: 'Bad', spec: { steps: 'nope' } }),
    ).rejects.toMatchObject({
      status: 400,
    });
  });
});

describe('P1 review fixes (FIX-A2)', () => {
  const window = {
    startsAt: new Date('2026-11-01T00:00:00Z'),
    endsAt: new Date('2026-11-30T00:00:00Z'),
    documentType: null,
  };

  it('R2: refuses a direct approver whose token no longer carries the step role', async () => {
    const { requestId } = await submit();
    await act(U.acc, requestId, { action: 'approve', expectedVersion: 1 });
    roles.finance = [U.fin, U.both, U.mgmt]; // the mirror still lists U.mgmt as finance
    tokenRoles = ['management']; // the token, which is the truth, no longer does
    await expect(
      act(U.mgmt, requestId, { action: 'approve', expectedVersion: 2 }),
    ).rejects.toMatchObject({ status: 403, response: { reason: 'out_of_scope' } });
  });

  it('R9: records submittedByUserId as the actor of the submit row', async () => {
    const { requestId } = await submit({ submittedByUserId: U.deputy });
    const rows = await db
      .select()
      .from(approvalActions)
      .where(and(eq(approvalActions.requestId, requestId), eq(approvalActions.action, 'submit')));
    expect(rows.map((r) => r.actorUserId)).toEqual([U.deputy]);
  });

  it('R10: removeMember scoped to org A cannot delete a member of an org B group', async () => {
    me = U.founder;
    callerScope = scopeB;
    const g = await admin.createGroup({ key: 'org-b-group', name: 'Org B group' });
    await admin.addMember(g.id, userB);
    callerScope = scope;
    await expect(admin.removeMember(g.id, userB)).rejects.toMatchObject({ status: 404 });
    const { rows } = await ownerPool.query(
      'SELECT 1 FROM app.approval_group_members WHERE group_id = $1 AND user_id = $2',
      [g.id, userB],
    );
    expect(rows).toHaveLength(1);
  });

  it('R13: one SLA candidate that fails does not stop the others', async () => {
    const bad = await submit();
    const good = await submit();
    const original = notify.notifyUser.getMockImplementation()!;
    notify.notifyUser.mockImplementation((tx: unknown, n: Notice) =>
      (n as Notice & { dedupeKey: string }).dedupeKey.includes(bad.requestId)
        ? Promise.reject(new Error('mail is down'))
        : original(tx, n),
    );
    try {
      await expect(sla.tick(new Date(now.getTime() + 24 * 3_600_000))).resolves.toBeDefined();
    } finally {
      notify.notifyUser.mockImplementation(original);
    }
    expect(await countActions(bad.requestId, 'remind')).toBe(0);
    expect(await countActions(good.requestId, 'remind')).toBe(1);
  });

  it('R22: preview names eligible approvers only to callers who may act', async () => {
    me = U.requester;
    grants = new Map([['approvals.requests.read', 'own']]);
    const facts = { amountNpr: '50000.00' };
    const redacted = await service.preview(scope, 'test_memo', facts, [U.requester]);
    expect(redacted.steps.length).toBeGreaterThan(0);
    expect(redacted.steps.every((s) => s.eligibleUserIds.length === 0)).toBe(true);
    grants = allGrants;
    const full = await service.preview(scope, 'test_memo', facts, [U.requester]);
    expect(full.steps[0]!.eligibleUserIds).toEqual([U.acc, U.both]);
  });

  it('R22: addMember and createDelegation refuse unknown, inactive and other-org users with 400', async () => {
    me = U.founder;
    const g = await admin.createGroup({ key: 'r22-group', name: 'R22' });
    await expect(admin.addMember(g.id, randomUUID())).rejects.toMatchObject({ status: 400 });
    await expect(admin.addMember(g.id, inactiveUser)).rejects.toMatchObject({ status: 400 });
    await expect(admin.addMember(g.id, userB)).rejects.toMatchObject({ status: 400 });
    expect((await admin.listGroups()).find((x) => x.id === g.id)?.memberUserIds).toEqual([]);
    await expect(
      admin.createDelegation({ fromUserId: U.acc, toUserId: randomUUID(), ...window }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      admin.createDelegation({ fromUserId: inactiveUser, toUserId: U.acc, ...window }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      admin.createDelegation({ fromUserId: U.acc, toUserId: userB, ...window }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('R23: act answers an ineligible caller 403 before any version or status conflict', async () => {
    const open = await submit();
    await expect(
      act(U.mgmt, open.requestId, { action: 'approve', expectedVersion: 7 }),
    ).rejects.toMatchObject({ status: 403, response: { reason: 'out_of_scope' } });
    const closed = await submit();
    await act(U.acc, closed.requestId, { action: 'reject', comment: 'No', expectedVersion: 1 });
    await expect(
      act(U.mgmt, closed.requestId, { action: 'approve', expectedVersion: 2 }),
    ).rejects.toMatchObject({ status: 403, response: { reason: 'out_of_scope' } });
  });

  it('R24: a deactivated group member cannot act, nor can their delegate', async () => {
    me = U.founder;
    const g = await admin.createGroup({ key: 'ops', name: 'Ops' });
    await admin.addMember(g.id, U.mgmt);
    await admin.addMember(g.id, leaver);
    await admin.createDelegation({
      fromUserId: leaver,
      toUserId: U.deputy,
      ...window,
      documentType: 'ops_memo',
    });
    await admin.createWorkflow({
      key: 'ops_memo',
      name: 'Ops memo',
      spec: {
        documentType: 'ops_memo',
        steps: [{ id: 'ops', kind: 'group', group: 'ops', reason: 'Ops signs' }],
      },
    });
    await admin.publish('ops_memo', 1);
    service.registerSubject({ documentType: 'ops_memo', onDecided });
    await withTx(db, scope, systemActor('test'), (tx) =>
      tx.execute(sql`UPDATE app.users SET status = 'inactive' WHERE id = ${leaver}`),
    );

    const { requestId, status } = await submit({ documentType: 'ops_memo' });
    expect(status).toBe('pending');
    await expect(
      act(leaver, requestId, { action: 'approve', expectedVersion: 1 }),
    ).rejects.toMatchObject({ status: 403, response: { reason: 'out_of_scope' } });
    await expect(
      act(U.deputy, requestId, { action: 'approve', expectedVersion: 1 }),
    ).rejects.toMatchObject({ status: 403, response: { reason: 'out_of_scope' } });
  });
});

describe('P1 review fixes (FIX-A2b)', () => {
  const inboxHas = async (as: string, requestId: string) => {
    me = as;
    return (await service.inbox()).some((i) => i.requestId === requestId);
  };

  it('R12: reroute after a decision does not keep the decider eligible for a later step', async () => {
    const { requestId } = await submit();
    await act(U.both, requestId, { action: 'approve', expectedVersion: 1 });
    roles.finance = [U.both]; // finance's only member is the person who already decided step 1
    me = U.founder;
    const dto = await service.reroute(requestId);
    expect(dto.status).toBe('blocked');
    expect(dto.blockReason).toContain('Step 2');
    expect(notify.notifyRole).toHaveBeenCalled();
  });

  it('R12: the inbox hides an item whose role the token no longer carries', async () => {
    const { requestId } = await submit();
    expect(await inboxHas(U.acc, requestId)).toBe(true);
    tokenRoles = ['management'];
    expect(await inboxHas(U.acc, requestId)).toBe(false);
  });

  it('R12: the inbox hides a later step from the person who decided an earlier one', async () => {
    const { requestId } = await submit();
    expect(await inboxHas(U.both, requestId)).toBe(true);
    await act(U.both, requestId, { action: 'approve', expectedVersion: 1 });
    expect(await inboxHas(U.both, requestId)).toBe(false);
    expect(await inboxHas(U.fin, requestId)).toBe(true);
  });
});

describe('P1 review fixes (FIX-A2c)', () => {
  const window = {
    startsAt: new Date('2026-11-01T00:00:00Z'),
    endsAt: new Date('2026-11-30T00:00:00Z'),
  };
  // Accountant then finance, with distinctApprovers on and off. Own document types, so the test_memo
  // versions other tests publish do not change these routes.
  beforeAll(async () => {
    me = U.founder;
    for (const [documentType, distinctApprovers] of [
      ['r12_on', true],
      ['r12_off', false],
    ] as const) {
      await admin.createWorkflow({
        key: documentType,
        name: documentType,
        spec: { documentType, distinctApprovers, steps: seedSpec.steps },
      });
      await admin.publish(documentType, 1);
      service.registerSubject({ documentType, onDecided });
    }
  });

  it('R12: an approve that leaves the next step only earlier deciders blocks the request', async () => {
    roles.finance = [U.both]; // finance's only member is the person who will decide step 1
    const { requestId, status } = await submit({ documentType: 'r12_on' });
    expect(status).toBe('pending');
    vi.clearAllMocks();

    const dto = await act(U.both, requestId, { action: 'approve', expectedVersion: 1 });
    expect(dto).toMatchObject({ status: 'blocked', currentSeq: 2, version: 2, decidedAt: null });
    expect(dto.blockReason).toContain('Step 2');
    expect(dto.steps.map((s) => s.status)).toEqual(['approved', 'waiting']);
    expect(notify.notifyRole).toHaveBeenCalledWith(
      expect.anything(),
      'founder',
      expect.objectContaining({
        dedupeKey: `approval:${requestId}:blocked:2`,
        email: {
          template: 'approval.blocked',
          vars: {
            documentNumber: 'MEMO-2082/83-00001',
            documentType: 'r12_on',
            linkPath: `/inbox/${requestId}`,
          },
        },
      }),
    );
    expect(notify.notifyUser).not.toHaveBeenCalled();
    expect(onDecided).not.toHaveBeenCalled();
    expect(await countActions(requestId, 'block')).toBe(1);
    const approveAudit = (
      audit.record.mock.calls as unknown as [unknown, { action: string; after: unknown }][]
    )
      .map((c) => c[1])
      .find((e) => e.action === 'approvals.approve');
    expect(approveAudit?.after).toMatchObject({ status: 'blocked', seq: 2 });

    // Once finance has another member, reroute reopens step 2 (currentSeq already points at it).
    roles.finance = [U.both, U.fin];
    me = U.founder;
    const reopened = await service.reroute(requestId);
    expect(reopened).toMatchObject({ status: 'pending', currentSeq: 2, blockReason: null });
    expect(reopened.steps[1]).toMatchObject({ status: 'active' });
    const done = await act(U.fin, requestId, { action: 'approve', expectedVersion: 3 });
    expect(done.status).toBe('approved');
  });

  it('R12 control: with distinctApprovers off the same flow leaves step 2 pending for that person', async () => {
    roles.finance = [U.both];
    const { requestId } = await submit({ documentType: 'r12_off' });
    vi.clearAllMocks();

    const dto = await act(U.both, requestId, { action: 'approve', expectedVersion: 1 });
    expect(dto).toMatchObject({ status: 'pending', currentSeq: 2, blockReason: null });
    expect(dto.steps[1]).toMatchObject({ status: 'active' });
    expect(notify.notifyRole).not.toHaveBeenCalled();
    expect(notify.notifyUser).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ userId: U.both, dedupeKey: `approval:${requestId}:2:pending` }),
    );
    const done = await act(U.both, requestId, { action: 'approve', expectedVersion: 2 });
    expect(done.status).toBe('approved');
  });

  it('R12: the next step is announced only to people who may still decide it', async () => {
    const { requestId } = await submit({ documentType: 'r12_on' });
    vi.clearAllMocks();
    await act(U.both, requestId, { action: 'approve', expectedVersion: 1 });
    const told = notify.notifyUser.mock.calls.map(
      (c) => (c[1] as Notice & { userId: string }).userId,
    );
    expect(told).toEqual([U.fin]);
  });

  it('R12: a delegate for two approvers acts for the one who did not decide an earlier step', async () => {
    roles.finance = [U.acc, U.fin]; // U.acc decides step 1 and also holds finance
    me = U.founder;
    // U.acc's delegation first, so a lookup that ignores earlier deciders picks U.acc.
    const viaAcc = await admin.createDelegation({
      fromUserId: U.acc,
      toUserId: U.deputy,
      ...window,
      documentType: 'r12_on',
    });
    const viaFin = await admin.createDelegation({
      fromUserId: U.fin,
      toUserId: U.deputy,
      ...window,
      documentType: 'r12_on',
    });
    try {
      const { requestId } = await submit({ documentType: 'r12_on' });
      await act(U.acc, requestId, { action: 'approve', expectedVersion: 1 });
      me = U.deputy;
      expect((await service.inbox()).some((i) => i.requestId === requestId)).toBe(true);
      const dto = await act(U.deputy, requestId, { action: 'approve', expectedVersion: 2 });
      expect(dto.status).toBe('approved');
      expect(dto.steps[1]).toMatchObject({ decidedBy: U.deputy, decidedOnBehalfOf: U.fin });
    } finally {
      me = U.founder;
      await admin.revokeDelegation(viaAcc.id);
      await admin.revokeDelegation(viaFin.id);
    }
  });
});

describe('ADR 0027: role steps use the roles of the request entity', () => {
  it('refuses a token finance holder whose membership in the entity allows only sales, and keeps the step out of their inbox', async () => {
    realDirectory = true; // role holders from app.user_roles and app.user_entities, not the fake map
    const { requestId } = await submit();
    await act(U.acc, requestId, { action: 'approve', expectedVersion: 1 });

    // What the tenancy interceptor binds: token [finance, sales] narrowed by role_keys {sales}.
    tokenRoles = ['sales'];
    await expect(
      act(narrowFin, requestId, { action: 'approve', expectedVersion: 2 }),
    ).rejects.toMatchObject({ status: 403, response: { reason: 'out_of_scope' } });
    me = narrowFin;
    expect((await service.inbox()).some((i) => i.requestId === requestId)).toBe(false);

    // Even a principal that still carried finance is no approver: the directory reads the membership.
    tokenRoles = ['finance', 'sales'];
    await expect(
      act(narrowFin, requestId, { action: 'approve', expectedVersion: 2 }),
    ).rejects.toMatchObject({ status: 403, response: { reason: 'out_of_scope' } });
    expect((await service.inbox()).some((i) => i.requestId === requestId)).toBe(false);

    // A finance holder whose membership allows every token role still sees and decides the step.
    tokenRoles = undefined;
    me = U.fin;
    expect((await service.inbox()).some((i) => i.requestId === requestId)).toBe(true);
    // (test_memo v2, published earlier in this file, adds a management step after finance.)
    const dto = await act(U.fin, requestId, { action: 'approve', expectedVersion: 2 });
    expect(dto.steps[1]).toMatchObject({ decidedBy: U.fin });
  });

  it('drops a group member who has no membership in the request entity', async () => {
    me = U.founder;
    const moved = (
      await createStaffUser(ownerPool, {
        tenantId: scope.tenantId,
        organizationId: scope.organizationId,
        idpOrgId: staffIdpOrgId,
      })
    ).userId;
    const g = await admin.createGroup({ key: 'adr27-signers', name: 'ADR 0027 signers' });
    await admin.addMember(g.id, U.mgmt);
    await admin.addMember(g.id, moved);
    await admin.createWorkflow({
      key: 'adr27_memo',
      name: 'ADR 0027 memo',
      spec: {
        documentType: 'adr27_memo',
        steps: [{ id: 'sign', kind: 'group', group: 'adr27-signers', reason: 'Signers sign' }],
      },
    });
    await admin.publish('adr27_memo', 1);
    service.registerSubject({ documentType: 'adr27_memo', onDecided });
    // The user leaves the entity: the group row stays, the membership does not.
    await withTx(db, scope, systemActor('test'), (tx) =>
      tx.execute(
        sql`DELETE FROM app.user_entities
            WHERE tenant_id = ${scope.tenantId} AND organization_id = ${scope.organizationId}
              AND user_id = ${moved}`,
      ),
    );

    const { requestId, status } = await submit({ documentType: 'adr27_memo' });
    expect(status).toBe('pending');
    await expect(
      act(moved, requestId, { action: 'approve', expectedVersion: 1 }),
    ).rejects.toMatchObject({ status: 403, response: { reason: 'out_of_scope' } });
    expect((await service.inbox()).some((i) => i.requestId === requestId)).toBe(false);
    me = U.mgmt;
    expect((await service.inbox()).some((i) => i.requestId === requestId)).toBe(true);
    const dto = await act(U.mgmt, requestId, { action: 'approve', expectedVersion: 1 });
    expect(dto.status).toBe('approved');
  });
});

describe('cancel (K1, kernel gap M5)', () => {
  const REASON = 'Quotation revised while pending';
  const asRequester = { kind: 'user' as const, id: '', correlationId: 'test-corr' };
  const cancel = (requestId: string, reason = REASON) =>
    withTx(db, scope, systemActor('test'), (tx) =>
      service.cancel(tx, requestId, reason, { ...asRequester, id: U.requester }),
    );
  // Its own document type: other tests publish new test_memo versions with more steps.
  const submit = (over: Partial<SubmitInput> = {}) =>
    submitMemo({ documentType: 'k1_cancel', ...over });
  beforeAll(async () => {
    me = U.founder;
    await admin.createWorkflow({
      key: 'k1_cancel',
      name: 'K1 cancel',
      spec: { documentType: 'k1_cancel', steps: seedSpec.steps },
    });
    await admin.publish('k1_cancel', 1);
    service.registerSubject({ documentType: 'k1_cancel', onDecided });
  });

  it('cancels a pending request: status, version, skipped steps, a cancel row and an audit event', async () => {
    const { requestId } = await submit();
    const dto = await cancel(requestId);
    expect(dto).toMatchObject({ status: 'cancelled', version: 2 });
    expect(dto.decidedAt).not.toBeNull();
    expect(dto.steps.map((s) => s.status)).toEqual(['skipped', 'skipped']);
    // find, not the last row: the fake clock gives submit and cancel the same createdAt, and ids are random.
    expect(dto.actions.find((a) => a.action === 'cancel')).toMatchObject({
      action: 'cancel',
      actorUserId: U.requester,
      comment: REASON,
    });
    expect(await countActions(requestId, 'cancel')).toBe(1);
    expect(audit.record).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'approvals.cancel',
        entityType: 'approval_request',
        entityId: requestId,
        before: { status: 'pending', version: 1 },
        after: { status: 'cancelled', version: 2, reason: REASON },
      }),
    );
    // No longer open: it leaves the inbox, and the subject is not told it was decided.
    me = U.acc;
    expect((await service.inbox()).some((i) => i.requestId === requestId)).toBe(false);
    expect(onDecided).not.toHaveBeenCalled();
  });

  it('cancels a blocked request too', async () => {
    roles.accountant = [];
    const { requestId, status } = await submit();
    expect(status).toBe('blocked');
    const dto = await cancel(requestId);
    expect(dto.status).toBe('cancelled');
    expect(dto.steps.every((s) => s.status === 'skipped')).toBe(true);
  });

  it('frees the document for a new submission', async () => {
    const documentId = randomUUID();
    const first = await submit({ documentId });
    await expect(submit({ documentId })).rejects.toMatchObject({ status: 409 });
    await cancel(first.requestId);
    expect((await submit({ documentId })).status).toBe('pending');
  });

  it('answers 409 to a second cancel and writes nothing more', async () => {
    const { requestId } = await submit();
    await cancel(requestId);
    vi.clearAllMocks();
    await expect(cancel(requestId)).rejects.toMatchObject({ status: 409 });
    expect(await countActions(requestId, 'cancel')).toBe(1);
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('answers 409 to a cancel of a decided request', async () => {
    const { requestId } = await submit();
    await act(U.acc, requestId, { action: 'reject', comment: 'No', expectedVersion: 1 });
    await expect(cancel(requestId)).rejects.toMatchObject({ status: 409 });
  });

  it('answers 409 to an approver who acts after the cancel, with the old or the new version', async () => {
    const { requestId } = await submit();
    await cancel(requestId);
    await expect(
      act(U.acc, requestId, { action: 'approve', expectedVersion: 1 }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      act(U.acc, requestId, { action: 'approve', expectedVersion: 2 }),
    ).rejects.toMatchObject({ status: 409 });
    expect(await countActions(requestId, 'approve')).toBe(0);
  });

  it('refuses a blank reason with 400', async () => {
    const { requestId } = await submit();
    await expect(cancel(requestId, '   ')).rejects.toMatchObject({ status: 400 });
  });

  it('answers 404 for a request of another entity', async () => {
    const { requestId } = await submit();
    await expect(
      withTx(db, scopeB, systemActor('test'), (tx) =>
        service.cancel(tx, requestId, REASON, systemActor('test')),
      ),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('records a system cancel with no actor user (approval_actions_actor_check allows it)', async () => {
    const { requestId } = await submit();
    await withTx(db, scope, systemActor('test'), (tx) =>
      service.cancel(tx, requestId, 'Quotation expired', systemActor('quotation-expiry')),
    );
    const [row] = await db
      .select()
      .from(approvalActions)
      .where(and(eq(approvalActions.requestId, requestId), eq(approvalActions.action, 'cancel')));
    expect(row).toMatchObject({ actorUserId: null, comment: 'Quotation expired' });
  });
});

describe('subject hooks (K1): link and onCancelled', () => {
  const onCancelled = vi.fn((_tx: unknown, _documentId: string, _reason: string) =>
    Promise.resolve(undefined),
  );
  beforeAll(async () => {
    me = U.founder;
    await admin.createWorkflow({
      key: 'k1_quote',
      name: 'K1 quote',
      spec: { documentType: 'k1_quote', steps: [seedSpec.steps[0]!] },
    });
    await admin.publish('k1_quote', 1);
    service.registerSubject({
      documentType: 'k1_quote',
      onDecided,
      onCancelled,
      // Async, as a subject that reads its document (the quotation version) gives it.
      link: (_tx, documentId) => Promise.resolve(`/quotations/${documentId}`),
    });
    service.registerSubject({ documentType: 'k1_nolink', onDecided });
    await admin.createWorkflow({
      key: 'k1_nolink',
      name: 'K1 no link',
      spec: { documentType: 'k1_nolink', steps: [seedSpec.steps[0]!] },
    });
    await admin.publish('k1_nolink', 1);
  });

  it('sends the decided notice to the link the subject gives', async () => {
    const { requestId } = await submit({ documentType: 'k1_quote' });
    const done = await act(U.acc, requestId, { action: 'approve', expectedVersion: 1 });
    expect(done.status).toBe('approved');
    const path = `/quotations/${done.documentId}`;
    expect(notify.notifyUser).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ userId: U.requester, link: path }),
    );
    const email = notify.notifyUser.mock.lastCall![1].email!;
    expect(email.template).toBe('approval.decided');
    expect(email.vars['linkPath']).toBe(path);
  });

  it('keeps the memo link for test_memo through its link hook', async () => {
    const { requestId } = await submit();
    const done = await act(U.acc, requestId, {
      action: 'reject',
      comment: 'No',
      expectedVersion: 1,
    });
    expect(notify.notifyUser).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ link: `/memos/${done.documentId}` }),
    );
  });

  it('falls back to the inbox for a subject without a link', async () => {
    const { requestId } = await submit({ documentType: 'k1_nolink' });
    await act(U.acc, requestId, { action: 'reject', comment: 'No', expectedVersion: 1 });
    expect(notify.notifyUser).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ link: `/inbox/${requestId}` }),
    );
  });

  it('tells the subject about a cancel with the reason, and not onDecided', async () => {
    const documentId = randomUUID();
    const { requestId } = await submit({ documentType: 'k1_quote', documentId });
    await withTx(db, scope, systemActor('test'), (tx) =>
      service.cancel(tx, requestId, 'Revised', systemActor('test')),
    );
    expect(onCancelled).toHaveBeenCalledWith(expect.anything(), documentId, 'Revised');
    expect(onDecided).not.toHaveBeenCalled();
  });

  it('rolls the cancel back when onCancelled throws (same transaction)', async () => {
    const { requestId } = await submit({ documentType: 'k1_quote' });
    onCancelled.mockRejectedValueOnce(new Error('subject refused'));
    await expect(
      withTx(db, scope, systemActor('test'), (tx) =>
        service.cancel(tx, requestId, 'Revised', systemActor('test')),
      ),
    ).rejects.toThrow('subject refused');
    const [row] = await db
      .select()
      .from(approvalRequests)
      .where(eq(approvalRequests.id, requestId));
    expect(row).toMatchObject({ status: 'pending', version: 1 });
  });
});

describe('request eligibility before disclosure or locking', () => {
  const action = { action: 'approve' as const, expectedVersion: 1 };

  it.each(['customer', 'vendor', 'staff'] as const)(
    'answers identically for existing and unknown ids to an unrelated %s principal',
    async (orgKind) => {
      const { requestId } = await submit();
      me = U.stranger;
      grants = new Map();
      const original = caller.current();
      const identity = vi.spyOn(caller, 'current').mockReturnValue({
        ...original,
        principal: { ...original.principal, orgKind },
      });
      try {
        for (const read of [
          (id: string) => service.get(id),
          (id: string) => service.getForAction(id, action, 'unrelated-key'),
          (id: string) => service.act(id, action, 'unrelated-key'),
        ]) {
          const responses = [];
          for (const id of [requestId, randomUUID()]) {
            const error = await read(id).catch((e: unknown) => e);
            expect(error).toMatchObject({ status: 404 });
            responses.push((error as { getResponse(): unknown }).getResponse());
          }
          expect(responses[0]).toEqual(responses[1]);
        }
      } finally {
        identity.mockRestore();
      }
    },
  );

  it('refuses portal callers before any request query, even with approval grants', async () => {
    me = U.acc;
    const original = caller.current();
    const identity = vi.spyOn(caller, 'current').mockReturnValue({
      ...original,
      principal: { ...original.principal, orgKind: 'vendor' },
    });
    const select = vi.spyOn(db, 'select');
    const transaction = vi.spyOn(db, 'transaction');
    try {
      await expect(service.get(randomUUID())).rejects.toMatchObject({ status: 404 });
      await expect(service.getForAction(randomUUID(), action, 'portal-key')).rejects.toMatchObject({
        status: 404,
      });
      await expect(service.act(randomUUID(), action, 'portal-key')).rejects.toMatchObject({
        status: 404,
      });
      await expect(service.act(randomUUID(), {} as never, 'portal-key')).rejects.toMatchObject({
        status: 404,
      });
      await expect(service.inbox()).rejects.toMatchObject({ status: 404 });
      expect(select).not.toHaveBeenCalled();
      expect(transaction).not.toHaveBeenCalled();
    } finally {
      select.mockRestore();
      transaction.mockRestore();
      identity.mockRestore();
    }
  });

  it('refuses unrelated staff before starting the locking transaction', async () => {
    const { requestId } = await submit();
    me = U.stranger;
    grants = new Map();
    const transaction = vi.spyOn(db, 'transaction');
    try {
      await expect(service.act(requestId, action, 'staff-key')).rejects.toMatchObject({
        status: 404,
      });
      expect(transaction).not.toHaveBeenCalled();
    } finally {
      transaction.mockRestore();
    }
  });

  it('refuses an entity-mismatched principal before querying or starting a transaction', async () => {
    me = U.acc;
    const original = caller.current();
    const identity = vi.spyOn(caller, 'current').mockReturnValue({
      ...original,
      principal: { ...original.principal, organizationId: scopeB.organizationId },
    });
    const select = vi.spyOn(db, 'select');
    const transaction = vi.spyOn(db, 'transaction');
    try {
      await expect(service.act(randomUUID(), action, 'wrong-entity-key')).rejects.toMatchObject({
        status: 404,
      });
      expect(select).not.toHaveBeenCalled();
      expect(transaction).not.toHaveBeenCalled();
    } finally {
      select.mockRestore();
      transaction.mockRestore();
      identity.mockRestore();
    }
  });

  it('lets a designated head without an approval role read and act, and conflicts on a key reused across requests', async () => {
    me = U.founder;
    const { departmentId } = await createDepartment(ownerPool, scope);
    await withTx(db, scope, systemActor('head-seed'), (tx) =>
      tx.execute(
        sql`UPDATE app.departments SET head_user_id = ${U.deputy} WHERE id = ${departmentId}`,
      ),
    );
    await admin.createWorkflow({
      key: 'purchase_request',
      name: 'Head approval',
      spec: {
        documentType: 'purchase_request',
        steps: [
          {
            id: 'head',
            kind: 'department_head',
            fallbackRole: 'operations_head',
            reason: 'Head approves',
          },
        ],
        rules: [],
      },
    });
    await admin.publish('purchase_request', 1);
    service.registerSubject({ documentType: 'purchase_request', onDecided });
    const first = await submit({ documentType: 'purchase_request', facts: { departmentId } });
    const second = await submit({ documentType: 'purchase_request', facts: { departmentId } });
    me = U.deputy;
    grants = new Map();
    expect(rolesOf(me)).toEqual([]);
    expect((await service.get(first.requestId)).requestId).toBe(first.requestId);
    const key = randomUUID();
    await service.getForAction(first.requestId, action, key);
    const result = await service.act(first.requestId, action, key);
    expect(await service.act(first.requestId, action, key)).toEqual(result);
    await service.getForAction(second.requestId, action, key);
    await expect(service.act(second.requestId, action, key)).rejects.toMatchObject({ status: 409 });
    expect((await service.get(second.requestId)).status).toBe('pending');
    expect(await countActions(second.requestId, 'approve')).toBe(0);
  });
});
