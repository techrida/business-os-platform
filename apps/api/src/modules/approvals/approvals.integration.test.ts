// Integration tests for the approval engine on a real Postgres (Testcontainers, needs Docker in WSL).
// Migrations run as bos_owner and the engine runs as bos_app, like production. Only the other units'
// services are faked: audit, notify, the user directory and the caller.
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
  runMigrations,
} from '@bos/db';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Principal } from '../../platform/authz/principal';
import type { Db } from '../../platform/db/db.module';
import { systemActor, withTx } from '../../platform/db/tx';
import { buildLink, renderEmail } from '../../platform/notify/templates';
import { ApprovalsAdminService } from './admin.service';
import { canonicalSha256 } from './canonical-json';
import type { ApprovalEmailTemplate } from './ports';
import { ApprovalsService, type SubmitInput } from './requests.service';
import { ApprovalsSlaService } from './sla.processor';

const WORKSPACE_URL = 'http://workspace.test';
const OWNER_PW = 'owner-test-pw';
const APP_PW = 'app-test-pw';
const scope = { tenantId: randomUUID(), organizationId: randomUUID() };
const U = {
  requester: randomUUID(),
  acc: randomUUID(),
  fin: randomUUID(),
  both: randomUUID(), // holds accountant and finance
  mgmt: randomUUID(),
  founder: randomUUID(),
  deputy: randomUUID(),
  stranger: randomUUID(),
};
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
const users = {
  userIdsWithRole: vi.fn((_s: unknown, role: RoleKey) => Promise.resolve(roles[role] ?? [])),
  resolve: vi.fn(),
  emailOf: vi.fn((id: string) => Promise.resolve(`${nameOfUser(id)}@bos.test`)),
};
const caller = {
  current: () => ({
    scope,
    actor: { kind: 'user' as const, id: me, correlationId: 'test-corr' },
    principal: {
      userId: me,
      zitadelUserId: `z-${me}`,
      ...scope,
      orgKind: 'staff',
      roles: [],
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

  service = new ApprovalsService(db, audit, notify, users, caller, clock);
  admin = new ApprovalsAdminService(db, audit, caller, clock);
  sla = new ApprovalsSlaService(db, service, audit, notify, clock);
  service.registerSubject({ documentType: 'test_memo', onDecided });

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

const act = (as: string, requestId: string, body: object, key = randomUUID()) => {
  me = as;
  return service.act(requestId, body as never, key);
};

const countActions = async (requestId: string, action: string) =>
  (await db.select().from(approvalActions).where(eq(approvalActions.requestId, requestId))).filter(
    (a) => a.action === action,
  ).length;

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
    me = U.stranger;
    await expect(service.get(requestId)).rejects.toMatchObject({ status: 403 });
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
