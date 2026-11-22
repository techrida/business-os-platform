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
} from '@bos/db';
import { and, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Principal } from '../../platform/authz/principal';
import type { Db } from '../../platform/db/db.module';
import { systemActor, withTx } from '../../platform/db/tx';
import { buildLink, renderEmail } from '../../platform/notify/templates';
import { SettingsService } from '../../platform/settings/settings.service';
import { UserMirror } from '../../platform/users/user-mirror';
import { UsersService } from '../../platform/users/users.service';
import { SqlUsersStore } from '../../platform/users/users.store';
import { RoleCache } from '../../platform/authz/role-cache';
import { ApprovalsAdminService } from './admin.service';
import { AdminWorkflowsController } from './admin-workflows.controller';
import { SKIP_LIVE_PUBLISHER_CHECK } from '../../../test/support/second-person';
import { canonicalSha256 } from '../../platform/hashing/canonical-json';
import type { ApprovalEmailTemplate, Caller } from './ports';
import { ApprovalsService, type SubmitInput } from './requests.service';
import { ApprovalsSlaService } from './sla.processor';
import { createTestDatabase, type TestDatabase } from '@bos/db/testing';

const WORKSPACE_URL = 'http://workspace.test';
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

let testDb: TestDatabase;
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

/**
 * Publishes as a second person (F1-Q11): the drafts here are saved by `me`, and the API refuses a publish by whoever
 * saved the draft, so Management (or the Founder, when Management saved it) publishes. `me` is restored afterwards.
 */
async function publishSeconded(key: string, version: number, svc = admin) {
  const editor = me;
  me = editor === U.mgmt ? U.founder : U.mgmt;
  try {
    return await svc.publish(key, version, SKIP_LIVE_PUBLISHER_CHECK);
  } finally {
    me = editor;
  }
}

let service: ApprovalsService;
let admin: ApprovalsAdminService;
let sla: ApprovalsSlaService;

beforeAll(async () => {
  testDb = await createTestDatabase();
  const admin0 = new Pool({ connectionString: testDb.adminUrl, max: 1 });
  await admin0.end();
  const bosAdmin = new Pool({ connectionString: testDb.adminUrl, max: 1 });
  await bosAdmin.end();

  ownerPool = new Pool({ connectionString: testDb.ownerUrl, max: 2 });
  appPool = new Pool({ connectionString: testDb.appUrl, max: 4 });
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
    // Names as the emails and the detail show them (D54-2): the requester has a display name; fin has an address
    // but no display name, so fin is "Unnamed user" everywhere, never the part of the address before the @.
    await tx.execute(
      sql`UPDATE app.users SET display_name = 'Sita Requester' WHERE id = ${U.requester}`,
    );
    await tx.execute(sql`UPDATE app.users SET display_name = NULL WHERE id = ${U.fin}`);
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
  await publishSeconded('test_memo', 1);
}, 180_000);

afterAll(async () => {
  await appPool?.end();
  await ownerPool?.end();
  await testDb?.drop();
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
        requesterName: 'Sita Requester',
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
    expect(pending.text).toContain('Sita Requester asked you to review');
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
            deciderName: 'Unnamed user',
            linkPath: memoPath,
          },
        },
      }),
    );
    // The detail names the deciders the same way: fin has an address and no display name.
    const detail = await service.get(requestId);
    const nameOf = (id: string) => detail.people?.find((person) => person.userId === id)?.name;
    expect(nameOf(U.fin)).toBe('Unnamed user');
    expect(nameOf(U.requester)).toBe('Sita Requester');
    // The old `outcome` key was ignored by the template, so the subject said "updated".
    const decided = renderEmail(
      'approval.decided',
      notify.notifyUser.mock.lastCall![1].email!.vars,
      { workspaceUrl: WORKSPACE_URL },
    );
    expect(decided.subject).toBe('test_memo MEMO-2082/83-00001: approved');
    expect(decided.text).toContain('Unnamed user marked test_memo MEMO-2082/83-00001 as approved.');
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
    await publishSeconded('test_memo', 2);
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
    await expect(publishSeconded('test_memo', 2)).rejects.toMatchObject({ status: 409 });
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
    const detail = await service.get(requestId);
    expect(detail.requestId).toBe(requestId);
    // A role step names no individual. Other staff and role members stay out of this response.
    expect(detail.people?.map((person) => person.userId)).toEqual([U.requester]);
    expect(detail.people?.[0]?.name).toBe('Sita Requester');
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

describe('SLA tick for an explicit route (internal memo)', () => {
  it('reminds the named user of the active step, not a role holder', async () => {
    const { requestId } = await submit({
      facts: {},
      explicitSteps: [{ userId: U.deputy, reason: 'Selected approver' }],
    });
    await sla.tick(new Date(new Date('2026-11-08T04:00:00Z').getTime() + 24 * 3_600_000));
    expect(await countActions(requestId, 'remind')).toBe(1);
    expect(notify.notifyUser).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        userId: U.deputy,
        dedupeKey: `approval:${requestId}:1:reminder`,
      }),
    );
    // No accountant or finance holder was asked about this request.
    const reminded = notify.notifyUser.mock.calls
      .map((c) => c[1] as unknown as { userId: string; dedupeKey: string })
      .filter((m) => m.dedupeKey === `approval:${requestId}:1:reminder`)
      .map((m) => m.userId);
    expect(reminded).toEqual([U.deputy]);
  });
});

describe('admin: publishing a workflow needs a second person (F1-Q11)', () => {
  const spec = {
    documentType: 'second_person',
    steps: [{ id: 'fin', kind: 'role', role: 'finance', reason: 'Finance signs' }],
  };

  it('refuses the editor, audits the refusal, and publishes for another Management member', async () => {
    me = U.founder;
    await admin.createWorkflow({ key: 'second_person', name: 'Second person', spec });
    audit.record.mockClear();

    await expect(
      admin.publish('second_person', 1, SKIP_LIVE_PUBLISHER_CHECK),
    ).rejects.toMatchObject({
      status: 403,
      response: { reason: 'separation_of_duties' },
    });
    const recorded = () =>
      (audit.record.mock.calls as unknown as [unknown, { action: string; after?: unknown }][]).map(
        ([, entry]) => entry,
      );
    expect(
      recorded().find((e) => e.action === 'approvals.workflow.publish_refused')?.after,
    ).toEqual({
      key: 'second_person',
      version: 1,
      reason: 'own_draft',
      editedBy: U.founder,
    });
    let [wf] = (await admin.listWorkflows()).filter((w) => w.key === 'second_person');
    expect(wf?.versions[0]).toMatchObject({
      status: 'draft',
      createdBy: U.founder,
      createdByName: expect.any(String) as unknown,
      savedByCaller: true,
    });

    me = U.mgmt;
    const published = await admin.publish('second_person', 1, SKIP_LIVE_PUBLISHER_CHECK);
    expect(published).toMatchObject({
      status: 'published',
      createdBy: U.founder,
      publishedBy: U.mgmt,
      savedByCaller: false,
    });
    expect(recorded().find((e) => e.action === 'approvals.workflow.publish')?.after).toEqual({
      key: 'second_person',
      version: 1,
      editedBy: U.founder,
      publishedBy: U.mgmt,
    });

    // Management saves the next draft: now the Founder is the second person, and Management may not publish it.
    await admin.addVersion('second_person', spec);
    await expect(
      admin.publish('second_person', 2, SKIP_LIVE_PUBLISHER_CHECK),
    ).rejects.toMatchObject({ status: 403 });
    me = U.founder;
    await admin.publish('second_person', 2, SKIP_LIVE_PUBLISHER_CHECK);
    [wf] = (await admin.listWorkflows()).filter((w) => w.key === 'second_person');
    expect(wf?.versions.map((v) => [v.version, v.status, v.createdBy, v.publishedBy])).toEqual([
      [1, 'retired', U.founder, U.mgmt],
      [2, 'published', U.mgmt, U.founder],
    ]);
  });

  it("re-checks the publisher's live grant: Management demoted after sign-in cannot publish on the old token", async () => {
    me = U.founder;
    await admin.createWorkflow({
      key: 'demoted',
      name: 'Demoted publisher',
      spec: { ...spec, documentType: 'demoted' },
    });
    // The HTTP route, as the app builds it: the live check runs inside the publish transaction.
    const routes = new AdminWorkflowsController(admin, db, new RoleCache(db));
    const mirrorRoles = (roleKeys: RoleKey[]) =>
      withTx(db, scope, systemActor('test-seed'), async (tx) => {
        await tx.execute(
          sql`DELETE FROM app.user_roles WHERE tenant_id = ${scope.tenantId} AND user_id = ${U.mgmt}`,
        );
        for (const role of roleKeys) {
          await tx.execute(
            sql`INSERT INTO app.user_roles (tenant_id, user_id, role_key) VALUES (${scope.tenantId}, ${U.mgmt}, ${role})`,
          );
        }
      });
    // Management is taken away; the person keeps another role and the entity membership. Their token (the
    // principal below) still says Management until it expires.
    await mirrorRoles(['finance']);
    me = U.mgmt;
    try {
      await expect(routes.publish('demoted', 1)).rejects.toMatchObject({
        status: 403,
        response: { reason: 'no_permission' },
      });
      expect(
        (await admin.listWorkflows()).find((w) => w.key === 'demoted')?.versions[0]?.status,
      ).toBe('draft');
    } finally {
      await mirrorRoles(['management']);
    }
    // With Management back in the mirror, the same route publishes.
    await expect(routes.publish('demoted', 1)).resolves.toMatchObject({
      status: 'published',
      publishedBy: U.mgmt,
    });
  });

  it('refuses a draft whose editor was never recorded, whoever publishes it', async () => {
    me = U.founder;
    await admin.createWorkflow({
      key: 'no_editor',
      name: 'No editor',
      spec: { ...spec, documentType: 'no_editor' },
    });
    // A draft saved before 0127 recorded the editor.
    await withTx(db, scope, systemActor('test-seed'), (tx) =>
      tx.execute(
        sql`UPDATE app.workflow_versions v SET created_by = NULL
              FROM app.workflow_definitions d
             WHERE d.id = v.definition_id AND d.tenant_id = ${scope.tenantId} AND d.key = 'no_editor'`,
      ),
    );
    me = U.mgmt;
    const refusal: unknown = await admin
      .publish('no_editor', 1, SKIP_LIVE_PUBLISHER_CHECK)
      .catch((e: unknown) => e);
    expect(refusal).toMatchObject({ status: 403 });
    expect(JSON.stringify((refusal as { getResponse(): unknown }).getResponse())).toContain(
      'Save it again',
    );
    expect(
      (await admin.listWorkflows()).find((w) => w.key === 'no_editor')?.versions[0],
    ).toMatchObject({
      status: 'draft',
      createdBy: null,
      savedByCaller: false,
    });
  });
});

describe('admin: the small-team rule for publishing a workflow (F1-Q11 a)', () => {
  const spec = {
    documentType: 'small_team',
    steps: [{ id: 'fin', kind: 'role', role: 'finance', reason: 'Finance signs' }],
  };
  type Entry = { action: string; after?: unknown };
  const recorded = () =>
    (audit.record.mock.calls as unknown as [unknown, Entry][]).map(([, entry]) => entry);

  /**
   * A company of its own: the shared tenant always has Management, so nobody there is ever alone. The first user
   * holds `firstRoles` and saves version 1 of `small_team`; the others hold the given mirror roles. Leaves `me`,
   * `callerScope` and `tokenRoles` on the first user (beforeEach resets them).
   */
  async function smallTeam(firstRoles: RoleKey[], ...others: RoleKey[][]) {
    const t = await createTenantWithEntity(ownerPool);
    const s = { tenantId: t.tenantId, organizationId: t.organizationId };
    const staff = async (roleKeys: RoleKey[]) =>
      (await createStaffUser(ownerPool, { ...s, idpOrgId: t.idpOrgId, roleKeys })).userId;
    const first = await staff(firstRoles);
    const rest: string[] = [];
    for (const roleKeys of others) rest.push(await staff(roleKeys));
    const svc = new ApprovalsAdminService(db, audit, caller, clock, undefined, new RoleCache(db));
    callerScope = s;
    me = first;
    tokenRoles = firstRoles;
    await svc.createWorkflow({ key: 'small_team', name: 'Small team', spec });
    audit.record.mockClear();
    // The HTTP route, as the app builds it: body parsing, then the live publisher check inside the transaction.
    const routes = new AdminWorkflowsController(svc, db, new RoleCache(db));
    const draft = async () => (await svc.listWorkflows()).find((w) => w.key === 'small_team');
    return { s, first, rest, svc, routes, draft };
  }

  it('lets a Founder who is the only publisher publish their own draft with a reason, and audits it', async () => {
    const { first, routes, draft } = await smallTeam(['founder']);
    expect((await draft())?.versions[0]).toMatchObject({
      status: 'draft',
      savedByCaller: true,
      publishSoleEligible: true,
    });

    await expect(
      routes.publish('small_team', 1, { reason: '  Nobody else works here yet  ' }),
    ).resolves.toMatchObject({ status: 'published', createdBy: first, publishedBy: first });
    expect(
      recorded().find((e) => e.action === 'approvals.workflow.publish_sole_eligible')?.after,
    ).toEqual({
      key: 'small_team',
      version: 1,
      editedBy: first,
      publishedBy: first,
      soleEligible: true,
      reason: 'Nobody else works here yet',
    });
    expect(recorded().map((e) => e.action)).not.toContain('approvals.workflow.publish');
    expect((await draft())?.versions[0]).toMatchObject({
      status: 'published',
      publishSoleEligible: false,
    });
  });

  it('reads the Founder role live: a token that still says founder after a demotion to Management is refused', async () => {
    const { routes, draft } = await smallTeam(['management']);
    tokenRoles = ['founder'];
    await expect(
      routes.publish('small_team', 1, { reason: 'Nobody else works here' }),
    ).rejects.toMatchObject({ status: 403, response: { reason: 'separation_of_duties' } });
    expect((await draft())?.versions[0]).toMatchObject({ status: 'draft' });
  });

  it('asks the sole Founder for a reason when it is missing or blank, and leaves the draft', async () => {
    const { routes, draft } = await smallTeam(['founder']);
    for (const body of [undefined, {}, { reason: '   ' }]) {
      await expect(routes.publish('small_team', 1, body)).rejects.toMatchObject({
        status: 400,
        response: { reason: 'sole_eligible_reason_required' },
      });
    }
    expect((await draft())?.versions[0]).toMatchObject({
      status: 'draft',
      publishSoleEligible: true,
    });
    expect(recorded().map((e) => e.action)).not.toContain(
      'approvals.workflow.publish_sole_eligible',
    );
  });

  it('refuses the Founder while a second Management member is active, then allows it once they are locked', async () => {
    const { first, rest, svc, draft } = await smallTeam(['founder'], ['management']);
    const [second] = rest;
    expect((await draft())?.versions[0]).toMatchObject({
      savedByCaller: true,
      publishSoleEligible: false,
    });
    await expect(
      svc.publish('small_team', 1, SKIP_LIVE_PUBLISHER_CHECK, { reason: 'Second one is away' }),
    ).rejects.toMatchObject({ status: 403, response: { reason: 'separation_of_duties' } });
    expect(
      recorded().find((e) => e.action === 'approvals.workflow.publish_refused')?.after,
    ).toEqual({ key: 'small_team', version: 1, reason: 'own_draft', editedBy: first });
    // The second person is viewing someone else's draft: never the flag.
    me = second!;
    tokenRoles = ['management'];
    expect((await draft())?.versions[0]).toMatchObject({
      savedByCaller: false,
      publishSoleEligible: false,
    });

    // An admin-locked user does not count (0125: a locked person is inactive); a failed-sign-in lock would.
    await withTx(db, callerScope, systemActor('test-seed'), (tx) =>
      tx.execute(
        sql`UPDATE app.users SET status = 'inactive', lock_reason = 'admin', locked_at = now()
             WHERE id = ${second!}`,
      ),
    );
    me = first;
    tokenRoles = ['founder'];
    expect((await draft())?.versions[0]).toMatchObject({ publishSoleEligible: true });
    await expect(
      svc.publish('small_team', 1, SKIP_LIVE_PUBLISHER_CHECK, { reason: 'Only one left' }),
    ).resolves.toMatchObject({ status: 'published', publishedBy: first });
  });

  it('keeps refusing the Founder while the second Management member is only locked out after failed sign-ins', async () => {
    const { rest, svc, draft } = await smallTeam(['founder'], ['management']);
    const [second] = rest;
    // A timed lock ends by itself, so the second person still counts.
    await withTx(db, callerScope, systemActor('test-seed'), (tx) =>
      tx.execute(
        sql`UPDATE app.users SET status = 'inactive', lock_reason = 'failed_sign_ins', locked_at = now(),
                   locked_until = now() + interval '15 minutes'
             WHERE id = ${second!}`,
      ),
    );
    expect((await draft())?.versions[0]).toMatchObject({
      savedByCaller: true,
      publishSoleEligible: false,
    });
    await expect(
      svc.publish('small_team', 1, SKIP_LIVE_PUBLISHER_CHECK, { reason: 'Second one is away' }),
    ).rejects.toMatchObject({ status: 403, response: { reason: 'separation_of_duties' } });
    expect((await draft())?.versions[0]?.status).toBe('draft');
  });

  it('never applies to a non-Founder, however small the team', async () => {
    const { svc, draft } = await smallTeam(['management']);
    expect((await draft())?.versions[0]).toMatchObject({
      savedByCaller: true,
      publishSoleEligible: false,
    });
    await expect(
      svc.publish('small_team', 1, SKIP_LIVE_PUBLISHER_CHECK, { reason: 'Nobody else' }),
    ).rejects.toMatchObject({ status: 403, response: { reason: 'separation_of_duties' } });
    expect((await draft())?.versions[0]?.status).toBe('draft');
  });

  it('does not count a second user who may not publish workflows', async () => {
    const { first, svc, draft } = await smallTeam(['founder'], ['sales'], ['accountant']);
    expect((await draft())?.versions[0]).toMatchObject({ publishSoleEligible: true });
    await expect(
      svc.publish('small_team', 1, SKIP_LIVE_PUBLISHER_CHECK, { reason: 'Sales cannot publish' }),
    ).resolves.toMatchObject({ status: 'published', publishedBy: first });
  });

  it('fails closed without the role table: a hand-built service keeps the second-person refusal', async () => {
    await smallTeam(['founder']);
    const bare = new ApprovalsAdminService(db, audit, caller, clock);
    expect(
      (await bare.listWorkflows()).find((w) => w.key === 'small_team')?.versions[0],
    ).toMatchObject({ publishSoleEligible: false });
    await expect(
      bare.publish('small_team', 1, SKIP_LIVE_PUBLISHER_CHECK, { reason: 'Nobody else' }),
    ).rejects.toMatchObject({ status: 403 });
  });
});

describe('admin: groups and delegations', () => {
  it('manages a group, routes a group step to its members, and refuses unknown groups on publish', async () => {
    me = U.founder;
    const groupSpec = {
      documentType: 'purchase',
      steps: [{ id: 'treasury', kind: 'group', group: 'treasury', reason: 'Treasury signs' }],
    };
    await admin.createWorkflow({ key: 'purchase', name: 'Purchase', spec: groupSpec });
    await expect(publishSeconded('purchase', 1)).rejects.toMatchObject({ status: 400 });

    const { id } = await admin.createGroup({ key: 'treasury', name: 'Treasury' });
    await expect(admin.createGroup({ key: 'treasury', name: 'Again' })).rejects.toMatchObject({
      status: 409,
    });
    await admin.addMember(id, U.mgmt);
    await admin.addMember(id, U.fin);
    await admin.removeMember(id, U.fin);
    expect((await admin.listGroups()).find((g) => g.id === id)?.memberUserIds).toEqual([U.mgmt]);
    await publishSeconded('purchase', 1);

    service.registerSubject({ documentType: 'purchase', onDecided });
    const { requestId } = await submit({ documentType: 'purchase' });
    const dto = await act(U.mgmt, requestId, { action: 'approve', expectedVersion: 1 });
    expect(dto).toMatchObject({
      status: 'approved',
      steps: [expect.objectContaining({ kind: 'group', groupId: id })],
    });

    me = U.founder;
    const detail = await service.get(requestId);
    expect(detail.steps[0]?.groupName).toBe('Treasury');
    expect(detail.people?.map((person) => person.userId).sort()).toEqual(
      [U.requester, U.mgmt].sort(),
    );
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

  it('refuses a negative amount threshold on create and on a new version (FX6)', async () => {
    const negative = (value: string) => ({
      ...seedSpec,
      rules: [{ ...seedSpec.rules[0]!, when: { field: 'amountNpr', op: 'gt', value } }],
    });
    const refused = admin.createWorkflow({
      key: 'negative',
      name: 'Negative',
      spec: negative('-5'),
    });
    await expect(refused).rejects.toMatchObject({ status: 400 });
    await expect(refused).rejects.toThrow('Enter an amount of zero or more.');
    await expect(admin.addVersion('test_memo', negative('-0.01'))).rejects.toMatchObject({
      status: 400,
    });
    const saved = await admin.addVersion('test_memo', negative('0'));
    expect(saved.version).toBeGreaterThan(1);
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
    await publishSeconded('ops_memo', 1);
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
      await publishSeconded(documentType, 1);
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
    await publishSeconded('adr27_memo', 1);
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
    await publishSeconded('k1_cancel', 1);
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
    await publishSeconded('k1_quote', 1);
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
    await publishSeconded('k1_nolink', 1);
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

describe('subject hooks (S3): afterDecided runs once the decision commits', () => {
  /** The request's status as another connection reads it when the hook runs: committed or not. */
  const seen: string[] = [];
  const afterDecided = vi.fn(async (d: { documentId: string }) => {
    const [row] = await db
      .select({ status: approvalRequests.status })
      .from(approvalRequests)
      .where(eq(approvalRequests.documentId, d.documentId));
    seen.push(row?.status ?? 'missing');
  });
  beforeAll(async () => {
    me = U.founder;
    await admin.createWorkflow({
      key: 's3_after',
      name: 'S3 after decided',
      spec: { documentType: 's3_after', steps: [seedSpec.steps[0]!] },
    });
    await publishSeconded('s3_after', 1);
    service.registerSubject({ documentType: 's3_after', onDecided, afterDecided });
  });
  beforeEach(() => {
    seen.length = 0;
    afterDecided.mockClear();
  });

  it('hands the subject the scope, document, outcome and snapshot after the commit', async () => {
    const documentId = randomUUID();
    const { requestId } = await submit({ documentType: 's3_after', documentId });
    await act(U.acc, requestId, { action: 'approve', expectedVersion: 1 });
    expect(afterDecided).toHaveBeenCalledTimes(1);
    expect(afterDecided).toHaveBeenCalledWith({
      scope,
      documentId,
      outcome: 'approved',
      snapshot: { title: 'Office chairs', amount: '50000.00', currency: 'NPR' },
    });
    // Read from another connection inside the hook: the decision was already committed.
    expect(seen).toEqual(['approved']);
  });

  it('keeps the decision when the hook fails, and is not called again for a replay', async () => {
    const { requestId } = await submit({ documentType: 's3_after' });
    afterDecided.mockRejectedValueOnce(new Error('queue down'));
    const key = randomUUID();
    const body = { action: 'reject', comment: 'No', expectedVersion: 1 };
    await expect(act(U.acc, requestId, body, key)).resolves.toMatchObject({ status: 'rejected' });
    await expect(act(U.acc, requestId, body, key)).resolves.toMatchObject({ status: 'rejected' });
    expect(afterDecided).toHaveBeenCalledTimes(1);
    const [row] = await db
      .select({ status: approvalRequests.status })
      .from(approvalRequests)
      .where(eq(approvalRequests.id, requestId));
    expect(row?.status).toBe('rejected');
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
    await publishSeconded('purchase_request', 1);
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

  it('lets a department head who decided a request reload it, and still refuses a stranger (U18 #10)', async () => {
    me = U.founder;
    const { departmentId } = await createDepartment(ownerPool, scope);
    await withTx(db, scope, systemActor('head-seed'), (tx) =>
      tx.execute(
        sql`UPDATE app.departments SET head_user_id = ${U.deputy} WHERE id = ${departmentId}`,
      ),
    );
    if (!(await admin.listWorkflows()).some((w) => w.key === 'purchase_request')) {
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
      await publishSeconded('purchase_request', 1);
    }
    try {
      service.registerSubject({ documentType: 'purchase_request', onDecided });
    } catch {
      // Registered by the test above when it ran first.
    }
    const { requestId } = await submit({
      documentType: 'purchase_request',
      facts: { departmentId },
    });
    // A head holds only the staff base grant: their own requests, not every request.
    const staffBase = new Map<Permission, Scope>([['approvals.requests.read', 'own']]);
    me = U.deputy;
    grants = staffBase;
    const decided = await service.act(requestId, action, randomUUID());
    expect(decided.status).toBe('approved');
    // The reload after the decision: the step is no longer active, but the head acted on the request.
    const reloaded = await service.get(requestId);
    expect(reloaded).toMatchObject({ requestId, status: 'approved' });
    expect(reloaded.steps[0]).toMatchObject({ status: 'approved', decidedBy: U.deputy });

    // No leak: a staff member with the same grant and no action on the request still gets the unknown-id answer.
    me = U.stranger;
    await expect(service.get(requestId)).rejects.toMatchObject({ status: 404 });
  });
});

describe('inbox filters: search and type narrow the list, never widen who may decide', () => {
  const token = () => `INBX${randomUUID().slice(0, 8)}`;
  const idsOf = (page: { items: { requestId: string }[] }) => page.items.map((i) => i.requestId);
  let prDepartmentId = '';

  /** Every title carries the test's own token, so a `q` filter makes the totals independent of other tests. */
  const memo = (title: string, over: Partial<SubmitInput> = {}) =>
    submit({ title, documentNumber: `${title}-N`, ...over });

  /** Puts U.deputy at the head of a department with a purchase_request route (shared with the head test above). */
  const ensurePurchaseRequest = async () => {
    if (prDepartmentId !== '') return;
    me = U.founder;
    const { departmentId } = await createDepartment(ownerPool, scope);
    await withTx(db, scope, systemActor('inbox-head-seed'), (tx) =>
      tx.execute(
        sql`UPDATE app.departments SET head_user_id = ${U.deputy} WHERE id = ${departmentId}`,
      ),
    );
    // The earlier head test may already have created and published the workflow and the subject.
    try {
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
      await publishSeconded('purchase_request', 1);
    } catch {
      /* already there */
    }
    try {
      service.registerSubject({ documentType: 'purchase_request', onDecided });
    } catch {
      /* already registered */
    }
    prDepartmentId = departmentId;
  };
  const purchaseRequest = (title: string) =>
    submit({
      title,
      documentNumber: `${title}-N`,
      documentType: 'purchase_request',
      facts: { departmentId: prDepartmentId },
    });

  it('still answers 403 when the filter only matches another approver’s request', async () => {
    const t = token();
    await memo(`${t} chairs`);
    me = U.stranger;
    grants = new Map();
    await expect(service.inboxPage({ q: t })).rejects.toMatchObject({
      status: 403,
      response: { reason: 'out_of_scope' },
    });
    await expect(service.inboxPage({ q: t, documentType: ['test_memo'] })).rejects.toMatchObject({
      status: 403,
    });
    // The unfiltered list gives the same answer: the filter neither causes nor hides the 403.
    await expect(service.inboxPage({})).rejects.toMatchObject({ status: 403 });
  });

  it('gives an approver whose filter matches nothing an empty page, not a 403', async () => {
    await ensurePurchaseRequest();
    const t = token();
    const pr = await purchaseRequest(`${t} head request`);
    const nothing = `NOMATCH${randomUUID().slice(0, 8)}`;

    // A department head without the generic approve grant: their only assignment is the PR above.
    me = U.deputy;
    grants = new Map();
    expect(idsOf(await service.inboxPage({ q: t }))).toEqual([pr.requestId]);
    await expect(service.inboxPage({ q: nothing })).resolves.toEqual({ items: [], total: 0 });
    await expect(service.inboxPage({ documentType: ['test_memo'] })).resolves.toEqual({
      items: [],
      total: 0,
    });

    // A generic approver too.
    me = U.acc;
    grants = allGrants;
    await expect(service.inboxPage({ q: nothing })).resolves.toEqual({ items: [], total: 0 });
  });

  it('counts what the caller may decide, not what the search matches', async () => {
    const t = token();
    const mine = [await memo(`${t} a`), await memo(`${t} b`), await memo(`${t} c`)].map(
      (r) => r.requestId,
    );
    // U.acc prepared these two, so separation of duties keeps them out of U.acc's inbox although SQL matches.
    await memo(`${t} own 1`, { requesterUserId: U.acc, sodUserIds: [U.acc] });
    await memo(`${t} own 2`, { requesterUserId: U.acc, sodUserIds: [U.acc] });

    me = U.both;
    const everything = await service.inboxPage({ q: t });
    expect(everything.total).toBe(5);

    me = U.acc;
    const page = await service.inboxPage({ q: t });
    expect(page.total).toBe(3);
    expect(idsOf(page).sort()).toEqual([...mine].sort());
    // A one-row page still reports the eligible total, not 1 and not the 5 SQL rows.
    const first = await service.inboxPage({ q: t, limit: 1 });
    expect(first.items).toHaveLength(1);
    expect(first.total).toBe(3);
  });

  it('slices after the eligibility check and pages never overlap', async () => {
    const t = token();
    const eligible: string[] = [];
    for (let i = 0; i < 5; i++) {
      eligible.push((await memo(`${t} ok ${i}`)).requestId);
      // Interleave rows U.acc may not decide, so a slice taken in SQL would come up short.
      await memo(`${t} own ${i}`, { requesterUserId: U.acc, sodUserIds: [U.acc] });
    }
    me = U.acc;
    const all = await service.inboxPage({ q: t });
    expect(all.total).toBe(5);
    expect(idsOf(all).sort()).toEqual([...eligible].sort());
    const order = idsOf(all);

    const pages = [
      await service.inboxPage({ q: t, limit: 2, offset: 0 }),
      await service.inboxPage({ q: t, limit: 2, offset: 2 }),
      await service.inboxPage({ q: t, limit: 2, offset: 4 }),
    ];
    expect(pages.map((p) => p.items.length)).toEqual([2, 2, 1]);
    expect(pages.map((p) => p.total)).toEqual([5, 5, 5]);
    expect(pages.flatMap(idsOf)).toEqual(order);
    expect(new Set(pages.flatMap(idsOf)).size).toBe(5);
    await expect(service.inboxPage({ q: t, limit: 2, offset: 10 })).resolves.toMatchObject({
      items: [],
      total: 5,
    });
    // The no-argument call keeps returning the whole list as an array (dashboard count, inbox/[id]).
    expect(await service.inbox()).toEqual(expect.arrayContaining(all.items));
  });

  it('narrows by document type without widening who may decide', async () => {
    await ensurePurchaseRequest();
    const t = token();
    const pr = await purchaseRequest(`${t} pr`);
    const memoRequest = await memo(`${t} memo`);

    // The head has no approval role: the memo matches both filters but is not theirs.
    me = U.deputy;
    grants = new Map();
    expect(idsOf(await service.inboxPage({ q: t }))).toEqual([pr.requestId]);
    expect(idsOf(await service.inboxPage({ q: t, documentType: ['purchase_request'] }))).toEqual([
      pr.requestId,
    ]);
    expect(
      idsOf(await service.inboxPage({ q: t, documentType: ['purchase_request', 'test_memo'] })),
    ).toEqual([pr.requestId]);
    await expect(service.inboxPage({ q: t, documentType: ['test_memo'] })).resolves.toEqual({
      items: [],
      total: 0,
    });

    // An accountant: the type filter keeps the memo, drops everything of another type, and an unknown
    // well-formed type is an empty list rather than an error.
    me = U.acc;
    grants = allGrants;
    expect(idsOf(await service.inboxPage({ q: t, documentType: ['test_memo'] }))).toEqual([
      memoRequest.requestId,
    ]);
    await expect(service.inboxPage({ q: t, documentType: ['no_such_type'] })).resolves.toEqual({
      items: [],
      total: 0,
    });
  });

  // Not covered: another tenant's request. Nothing in this file builds a workflow in a second tenant, and the
  // only other scope (scopeB) is an entity of the same tenant with no published route. The tenant and entity
  // predicates in eligibleInbox are asserted by the SQL where-clause, not by a fixture here.
  it.skip('never lists another tenant’s request (needs a second-tenant workflow fixture)', () => {});
});

describe('approvals.sla_defaults setting (a spec that leaves sla out)', () => {
  // Own document types, so the test_memo versions other tests publish do not change these routes.
  let settings: SettingsService;
  let withSettings: ApprovalsAdminService;
  const setSla = (value: unknown) =>
    withTx(db, scope, systemActor('test'), (tx) =>
      settings.set(tx, 'approvals.sla_defaults', value),
    );
  /** Creates and publishes `documentType` through the settings-aware admin service, then submits once. */
  const publishAndSubmit = async (documentType: string, sla?: object) => {
    me = U.founder;
    await withSettings.createWorkflow({
      key: documentType,
      name: documentType,
      spec: { documentType, steps: seedSpec.steps, ...(sla === undefined ? {} : { sla }) },
    });
    await publishSeconded(documentType, 1, withSettings);
    service.registerSubject({ documentType, onDecided });
    const { requestId } = await submit({ documentType });
    const steps = await db
      .select()
      .from(approvalSteps)
      .where(eq(approvalSteps.requestId, requestId));
    const first = steps.find((s) => s.seq === 1)!;
    const stored = (await withSettings.listWorkflows()).find((w) => w.key === documentType)!;
    return {
      remindAt: first.remindAt?.toISOString(),
      escalateAt: first.escalateAt?.toISOString(),
      sla: WorkflowSpecSchema.parse(stored.versions[0]!.spec).sla,
    };
  };

  beforeAll(() => {
    settings = new SettingsService(db);
    withSettings = new ApprovalsAdminService(db, audit, caller, clock, settings);
  });

  it('with nothing set, uses the 24h/72h/founder default exactly as before the setting existed', async () => {
    expect(await publishAndSubmit('sla_unset')).toEqual({
      remindAt: '2026-11-09T04:00:00.000Z',
      escalateAt: '2026-11-11T04:00:00.000Z',
      sla: { remindAfterHours: 24, escalateAfterHours: 72, escalateTo: { role: 'founder' } },
    });
  });

  it('a changed setting drives the reminder, escalation and escalation role; an explicit sla still wins', async () => {
    try {
      await setSla({
        remindAfterHours: 4,
        escalateAfterHours: 8,
        escalateTo: { role: 'management' },
      });
      expect(await publishAndSubmit('sla_from_setting')).toEqual({
        remindAt: '2026-11-08T08:00:00.000Z',
        escalateAt: '2026-11-08T12:00:00.000Z',
        sla: { remindAfterHours: 4, escalateAfterHours: 8, escalateTo: { role: 'management' } },
      });
      // A spec that names sla (even partly) keeps today's behaviour: the schema fills the rest, not the setting.
      expect(
        await publishAndSubmit('sla_explicit', { remindAfterHours: 48, escalateAfterHours: 96 }),
      ).toEqual({
        remindAt: '2026-11-10T04:00:00.000Z',
        escalateAt: '2026-11-12T04:00:00.000Z',
        sla: { remindAfterHours: 48, escalateAfterHours: 96, escalateTo: { role: 'founder' } },
      });
    } finally {
      await setSla({});
    }
  });
});

describe('quotation snapshot cost figures follow the viewer (D29)', () => {
  const QUOTE = 'quotation_version';
  const SNAPSHOT = {
    nprTotal: '2690999.99',
    effectiveDiscountPct: '13.0000',
    marginPct: '21.5000',
    nprDiscountAmount: '402500.00',
    currency: 'NPR',
    fxRate: '1',
    customerName: 'Himal Traders',
    quotationNumber: 'QT-2082/83-00001',
    revisionNo: 1,
    discountApprovalRequired: true,
  };
  // A reader of approvals with, and without, the cost permission. Same user, same request: only the grants differ.
  const readerWithoutCost = new Map<Permission, Scope>([['approvals.requests.read', 'all']]);
  const readerWithCost = new Map<Permission, Scope>([
    ['approvals.requests.read', 'all'],
    ['quotation.cost.read', 'all'],
  ]);
  const submitQuote = (over: Partial<SubmitInput> = {}) =>
    submit({
      documentType: QUOTE,
      documentNumber: 'QT-2082/83-00001',
      title: 'Quotation QT-2082/83-00001 revision 1',
      snapshot: SNAPSHOT,
      ...over,
    });
  const storedSnapshot = async (requestId: string) => {
    const [row] = await db
      .select()
      .from(approvalRequests)
      .where(eq(approvalRequests.id, requestId));
    return row!;
  };

  beforeAll(async () => {
    me = U.founder;
    await admin.createWorkflow({
      key: QUOTE,
      name: 'Quotation version',
      spec: { documentType: QUOTE, steps: [seedSpec.steps[0]!] },
    });
    await publishSeconded(QUOTE, 1);
    service.registerSubject({ documentType: QUOTE, onDecided });
  });

  it('omits marginPct (key absent) for a reader without quotation.cost.read', async () => {
    const { requestId } = await submitQuote();
    me = U.acc;
    grants = readerWithoutCost;
    const { marginPct: _margin, ...visible } = SNAPSHOT;
    const dto = await service.get(requestId);
    expect(dto.snapshot).toEqual(visible);
    expect('marginPct' in (dto.snapshot as object)).toBe(false);
  });

  it('shows marginPct to the same reader once the grant is present', async () => {
    const { requestId } = await submitQuote();
    me = U.acc;
    grants = readerWithCost;
    expect((await service.get(requestId)).snapshot).toEqual(SNAPSHOT);
  });

  it('keeps the stored snapshot and its hash whatever the reader sees', async () => {
    const { requestId } = await submitQuote();
    const before = await storedSnapshot(requestId);
    me = U.acc;
    grants = readerWithoutCost;
    await service.get(requestId);
    const after = await storedSnapshot(requestId);
    expect(after.snapshot).toEqual(SNAPSHOT);
    expect(after.snapshotSha256.equals(canonicalSha256(SNAPSHOT))).toBe(true);
    expect(after.snapshotSha256.equals(before.snapshotSha256)).toBe(true);
    // The grant is read live: the next read by a holder is full again.
    grants = readerWithCost;
    expect((await service.get(requestId)).snapshot).toEqual(SNAPSHOT);
  });

  it('filters the answer of a decision and of its replay, and stores the full snapshot', async () => {
    const { requestId } = await submitQuote();
    me = U.acc;
    grants = new Map<Permission, Scope>([['approvals.requests.act', 'all']]);
    const key = randomUUID();
    const body = { action: 'approve' as const, expectedVersion: 1 };
    const first = await service.act(requestId, body, key);
    expect(first.status).toBe('approved');
    expect(first.snapshot).not.toHaveProperty('marginPct');
    expect(first.snapshot).toMatchObject({ nprTotal: SNAPSHOT.nprTotal });
    // An exact retry replays the stored result; it is filtered for the caller too.
    const replay = await service.act(requestId, body, key);
    expect(replay.snapshot).not.toHaveProperty('marginPct');
    expect((await storedSnapshot(requestId)).snapshot).toEqual(SNAPSHOT);
  });

  it('shows marginPct in the answer of a decision to an approver who holds quotation.cost.read', async () => {
    const { requestId } = await submitQuote();
    me = U.acc;
    grants = new Map<Permission, Scope>([
      ['approvals.requests.act', 'all'],
      ['quotation.cost.read', 'all'],
    ]);
    const done = await service.act(
      requestId,
      { action: 'approve', expectedVersion: 1 },
      randomUUID(),
    );
    expect(done.snapshot).toEqual(SNAPSHOT);
  });

  it('leaves another document type alone, even if its snapshot has a marginPct key', async () => {
    const snapshot = { title: 'Office chairs', marginPct: '5.0000' };
    const { requestId } = await submit({ snapshot });
    me = U.acc;
    grants = readerWithoutCost;
    expect((await service.get(requestId)).snapshot).toEqual(snapshot);
  });
});

// Runs after the D29 block: that block's beforeAll creates the quotation_version workflow unguarded.
describe('inbox count: the badge equals the list total for every kind of approver', () => {
  let prHead = '';
  let salesUser = '';
  let prDepartmentId = '';

  /** Count and list for the current caller; they must agree, and the count is returned. */
  const countAndTotal = async () => {
    const { count } = await service.inboxCount();
    const page = await service.inboxPage({});
    expect(count).toBe(page.total);
    expect(page.items).toHaveLength(count);
    return count;
  };
  /** Takes the caller's count, runs `change`, and returns how much the count moved (list and count agreeing). */
  const deltaAs = async (who: string, change: () => Promise<unknown>) => {
    me = who;
    const before = await countAndTotal();
    await change();
    me = who;
    return (await countAndTotal()) - before;
  };

  beforeAll(async () => {
    const staff = async (roleKeys: RoleKey[]) =>
      (
        await createStaffUser(ownerPool, {
          tenantId: scope.tenantId,
          organizationId: scope.organizationId,
          idpOrgId: staffIdpOrgId,
          roleKeys,
        })
      ).userId;
    prHead = await staff([]);
    salesUser = await staff(['sales']);
    const { departmentId } = await createDepartment(ownerPool, scope);
    prDepartmentId = departmentId;
    await withTx(db, scope, systemActor('inbox-count-seed'), (tx) =>
      tx.execute(
        sql`UPDATE app.departments SET head_user_id = ${prHead} WHERE id = ${departmentId}`,
      ),
    );
    // The inbox filter tests above may already have created the head route and its subject.
    me = U.founder;
    try {
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
      await publishSeconded('purchase_request', 1);
    } catch {
      /* already there */
    }
    try {
      service.registerSubject({ documentType: 'purchase_request', onDecided });
    } catch {
      /* already registered */
    }
  });

  it('counts a role step for its role holder with the generic grant', async () => {
    expect(await deltaAs(U.acc, () => submit())).toBe(1);
  });

  it('does not count a role step for a generic approver without the role', async () => {
    expect(await deltaAs(U.mgmt, () => submit())).toBe(0);
  });

  it('counts a named-user step for that user', async () => {
    expect(
      await deltaAs(U.deputy, () =>
        submit({ facts: {}, explicitSteps: [{ userId: U.deputy, reason: 'Selected approver' }] }),
      ),
    ).toBe(1);
  });

  it('counts the delegator’s step for an active delegate', async () => {
    me = U.founder;
    const { id } = await admin.createDelegation({
      fromUserId: U.acc,
      toUserId: U.stranger,
      startsAt: new Date('2026-11-01T00:00:00Z'),
      endsAt: new Date('2026-11-10T00:00:00Z'),
      documentType: 'test_memo',
    });
    try {
      expect(await deltaAs(U.stranger, () => submit())).toBe(1);
    } finally {
      me = U.founder;
      await admin.revokeDelegation(id);
    }
  });

  it('counts a purchase request for its department head, who has no generic grant', async () => {
    grants = new Map();
    expect(
      await deltaAs(prHead, () =>
        submit({
          title: 'Head request',
          documentType: 'purchase_request',
          facts: { departmentId: prDepartmentId },
        }),
      ),
    ).toBe(1);
  });

  it('counts a quotation step for a Sales user named outside the step’s role', async () => {
    roles.sales = [salesUser];
    try {
      grants = new Map();
      expect(
        await deltaAs(salesUser, () =>
          submit({
            documentType: 'quotation_version',
            title: 'Quotation for the badge',
            assigneeUserId: salesUser,
          }),
        ),
      ).toBe(1);
    } finally {
      delete roles.sales;
    }
  });

  it('does not count a request the caller is separated from (separation of duties)', async () => {
    expect(
      await deltaAs(U.acc, () => submit({ requesterUserId: U.acc, sodUserIds: [U.acc] })),
    ).toBe(0);
    // Control: the same request counts for another accountant.
    expect(
      await deltaAs(U.both, () => submit({ requesterUserId: U.acc, sodUserIds: [U.acc] })),
    ).toBe(1);
  });

  it('does not count a later step for whoever decided an earlier one (distinctApprovers)', async () => {
    let requestId = '';
    me = U.fin;
    const finBefore = await countAndTotal();
    expect(
      await deltaAs(U.both, async () => {
        requestId = (await submit()).requestId;
        await act(U.both, requestId, { action: 'approve', expectedVersion: 1 });
      }),
    ).toBe(0);
    // Control: the finance step is now open and counts for a finance holder who did not decide step 1.
    me = U.fin;
    expect((await countAndTotal()) - finBefore).toBe(1);
  });

  it('refuses a caller with no approval assignment with the same 403 as the list, never 0', async () => {
    await submit();
    me = U.stranger;
    grants = new Map();
    const refusal = { status: 403, response: { reason: 'out_of_scope' } };
    await expect(service.inboxCount()).rejects.toMatchObject(refusal);
    await expect(service.inboxPage({})).rejects.toMatchObject(refusal);
  });
});

/**
 * A Db that records every call made on it while a transaction it opened is still open. Such a call takes a second
 * pooled connection while the transaction holds the first, so under load the pool can run dry and stall.
 */
function poolGuard(real: Db): { db: Db; touches: string[] } {
  const touches: string[] = [];
  let open = 0;
  const where = () =>
    (new Error().stack ?? '')
      .split('\n')
      .filter((line) => line.includes('/src/') && !line.includes('.test.'))
      .slice(0, 2)
      .map((line) => line.trim())
      .join(' < ');
  const db = new Proxy(real, {
    get(target, prop) {
      const value: unknown = Reflect.get(target, prop);
      if (typeof value !== 'function') return value;
      if (prop === 'transaction') {
        return (fn: (tx: unknown) => Promise<unknown>, config?: unknown) =>
          target.transaction(async (tx) => {
            open += 1;
            try {
              return await fn(tx);
            } finally {
              open -= 1;
            }
          }, config as never);
      }
      return (...args: unknown[]) => {
        if (open > 0) touches.push(`${String(prop)} at ${where()}`);
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
  return { db, touches };
}

describe('reads inside a submit or decision transaction', () => {
  it('names the requester and the decider through the transaction, never a second pooled connection', async () => {
    // Its own two-step workflow: earlier tests publish other versions of test_memo.
    me = U.founder;
    await admin.createWorkflow({
      key: 'pool_memo',
      name: 'Pool memo',
      spec: {
        documentType: 'pool_memo',
        steps: [
          { id: 'accountant', kind: 'role', role: 'accountant', reason: 'Accountant checks' },
          { id: 'finance', kind: 'role', role: 'finance', reason: 'Finance approves' },
        ],
      },
    });
    await publishSeconded('pool_memo', 1);
    const guard = poolGuard(db);
    const guarded = new ApprovalsService(guard.db, audit, notify, users, caller, clock);
    guarded.registerSubject({
      documentType: 'pool_memo',
      onDecided,
      link: (_tx, documentId) => `/memos/${documentId}`,
    });
    const { requestId } = await withTx(guard.db, scope, systemActor('test'), (tx) =>
      guarded.submit(tx, {
        documentType: 'pool_memo',
        documentId: randomUUID(),
        documentNumber: 'MEMO-2082/83-00001',
        title: 'Office chairs',
        snapshot: { title: 'Office chairs', amount: '50000.00', currency: 'NPR' },
        facts: { amountNpr: '50000.00' },
        requesterUserId: U.requester,
        sodUserIds: [U.requester],
      }),
    );
    me = U.acc;
    await guarded.act(requestId, { action: 'approve', expectedVersion: 1 }, randomUUID());
    me = U.fin;
    const done = await guarded.act(
      requestId,
      { action: 'approve', expectedVersion: 2 },
      randomUUID(),
    );

    expect(done.status).toBe('approved');
    expect(guard.touches).toEqual([]);
    // The names still arrive: the pending email names the requester, the decided email the decider.
    const emails = notify.notifyUser.mock.calls.map(([, n]) => n.email);
    const pending = emails.find((e) => e?.template === 'approval.pending');
    const decided = emails.find((e) => e?.template === 'approval.decided');
    expect(pending?.vars.requesterName).toBe('Sita Requester');
    expect(decided?.vars.deciderName).toBe('Unnamed user');
  });

  it('finds the role holders of each step through the transaction, never a second pooled connection', async () => {
    me = U.founder;
    await admin.createWorkflow({
      key: 'pool_dir_memo',
      name: 'Pool directory memo',
      spec: {
        documentType: 'pool_dir_memo',
        steps: [
          { id: 'accountant', kind: 'role', role: 'accountant', reason: 'Accountant checks' },
          { id: 'finance', kind: 'role', role: 'finance', reason: 'Finance approves' },
        ],
      },
    });
    await publishSeconded('pool_dir_memo', 1);
    const guard = poolGuard(db);
    // The real directory chain (UsersService -> UserMirror -> SqlUsersStore) over the watched handle, so a layer
    // that drops the transaction shows up here. The ZITADEL client, queue and audit are never reached.
    const guardStore = new SqlUsersStore(guard.db);
    const directory = new UsersService(
      new UserMirror(guard.db, guardStore, {} as never, {} as never),
      guardStore,
      {} as never,
      guard.db,
      {} as never,
    );
    const guarded = new ApprovalsService(guard.db, audit, notify, directory, caller, clock);
    guarded.registerSubject({
      documentType: 'pool_dir_memo',
      onDecided,
      link: (_tx, documentId) => `/memos/${documentId}`,
    });
    const { requestId, status } = await withTx(guard.db, scope, systemActor('test'), (tx) =>
      guarded.submit(tx, {
        documentType: 'pool_dir_memo',
        documentId: randomUUID(),
        documentNumber: 'MEMO-2082/83-00002',
        title: 'Office chairs',
        snapshot: { title: 'Office chairs', amount: '50000.00', currency: 'NPR' },
        facts: { amountNpr: '50000.00' },
        requesterUserId: U.requester,
        sodUserIds: [U.requester],
      }),
    );
    // Not blocked: the real store found an accountant for step 1 through the transaction.
    expect(status).toBe('pending');
    me = U.acc;
    await guarded.act(requestId, { action: 'approve', expectedVersion: 1 }, randomUUID());
    me = U.fin;
    const done = await guarded.act(
      requestId,
      { action: 'approve', expectedVersion: 2 },
      randomUUID(),
    );

    expect(done.status).toBe('approved');
    expect(guard.touches).toEqual([]);
  });
});
