// Integration test (real Postgres, needs Docker): the approvals read path stays cheap (round 7, unit U1-07).
// The sidebar badge polls `inboxCount`, so its statement count and the columns it drags out of Postgres are
// the cost of every navigation. Pending requests sit on four workflow versions; a drizzle logger counts every
// statement the read path sends. The SQL checks pin the tenant predicate of the step and action reads and
// that the decision history never reads `result`.
import { randomUUID } from 'node:crypto';

import { PERMISSIONS, type Permission, type RoleKey, type Scope } from '@bos/contracts';
import { createStaffUser, createTenantWithEntity } from '@bos/db';
import { createTestDatabase, type TestDatabase } from '@bos/db/testing';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { SKIP_LIVE_PUBLISHER_CHECK } from '../../../test/support/second-person';
import type { Principal } from '../../platform/authz/principal';
import type { Db } from '../../platform/db/db.module';
import { systemActor, withTx } from '../../platform/db/tx';
import { SqlUsersStore } from '../../platform/users/users.store';
import { ApprovalsAdminService } from './admin.service';
import type { Caller } from './ports';
import type { DirectoryData } from './router';
import { ApprovalsService, directoryViewOf } from './requests.service';

const scope = { tenantId: '', organizationId: '' };
let staffIdpOrgId = '';
const U = { requester: '', acc: '', fin: '', mgmt: '', founder: '' };

/** Four published versions of one workflow, each routing through a different mix of roles. */
const step = (id: string, role: string) => ({
  id,
  kind: 'role',
  role,
  reason: `${role} checks the memo`,
});
const SPECS = [
  [step('a', 'accountant'), step('f', 'finance')],
  [step('a', 'accountant'), step('f', 'finance'), step('m', 'management')],
  [step('a', 'accountant'), step('m', 'management'), step('fo', 'founder')],
  [step('a', 'accountant'), step('f', 'finance'), step('m', 'management'), step('fo', 'founder')],
].map((steps) => ({ documentType: 'test_memo', steps, rules: [] }));
const REQUESTS_PER_VERSION = 3;

let testDb: TestDatabase;
let countingDb: Db;
let users: ConstructorParameters<typeof ApprovalsService>[3];
let ownerPool: Pool;
let appPool: Pool;
let db: Db;
let me = '';
let grants = new Map<Permission, Scope>(PERMISSIONS.map((p) => [p, 'all']));
let tokenRoles: RoleKey[] = [];
const statements: string[] = [];

const audit = { record: vi.fn(() => Promise.resolve(undefined)) };
const notify = {
  notifyUser: vi.fn(() => Promise.resolve(undefined)),
  notifyRole: vi.fn(() => Promise.resolve(undefined)),
};
const caller = {
  current: (): Caller => ({
    scope,
    actor: { kind: 'user' as const, id: me, correlationId: 'test-corr' },
    principal: {
      userId: me,
      zitadelUserId: `z-${me}`,
      ...scope,
      orgKind: 'staff',
      partyId: null,
      idpOrgId: staffIdpOrgId,
      roles: tokenRoles,
      departmentId: null,
      status: 'active',
      grants,
    } satisfies Principal,
  }),
};
const clock = () => new Date('2026-11-08T04:00:00Z');

let writer: ApprovalsService;
let counted: ApprovalsService;
let admin: ApprovalsAdminService;
const requestIds: string[] = [];

const submit = () =>
  withTx(db, scope, systemActor('test'), (tx) =>
    writer.submit(tx, {
      documentType: 'test_memo',
      documentId: randomUUID(),
      documentNumber: 'MEMO-2082/83-00001',
      title: 'Office chairs',
      snapshot: { title: 'Office chairs', amount: '50000.00', currency: 'NPR' },
      facts: { amountNpr: '50000.00' },
      requesterUserId: U.requester,
      sodUserIds: [U.requester],
    }),
  );

/** Runs `fn` and returns the SQL of every statement the counted service's database saw meanwhile. */
async function capture(fn: () => Promise<unknown>): Promise<string[]> {
  statements.length = 0;
  await fn();
  return [...statements];
}

/** The part of a statement after its first ` where `: what filters the rows. */
const whereOf = (sqlText: string) => sqlText.slice(sqlText.toLowerCase().indexOf(' where '));

beforeAll(async () => {
  testDb = await createTestDatabase();
  ownerPool = new Pool({ connectionString: testDb.ownerUrl, max: 2 });
  appPool = new Pool({ connectionString: testDb.appUrl, max: 4 });
  db = drizzle({ client: appPool });
  countingDb = drizzle({
    client: appPool,
    logger: { logQuery: (query: string) => void statements.push(query) },
  });

  const t = await createTenantWithEntity(ownerPool);
  Object.assign(scope, { tenantId: t.tenantId, organizationId: t.organizationId });
  staffIdpOrgId = t.idpOrgId;
  const staff = async (roleKeys: RoleKey[]) =>
    (
      await createStaffUser(ownerPool, {
        tenantId: scope.tenantId,
        organizationId: scope.organizationId,
        idpOrgId: staffIdpOrgId,
        roleKeys,
      })
    ).userId;
  U.requester = await staff([]);
  U.acc = await staff(['accountant']);
  U.fin = await staff(['finance']);
  U.mgmt = await staff(['management']);
  U.founder = await staff(['founder']);

  // The real directory: role holders come from app.user_roles and app.user_entities, as in production.
  const store = new SqlUsersStore(db);
  users = store as unknown as ConstructorParameters<typeof ApprovalsService>[3];
  writer = new ApprovalsService(db, audit, notify, users, caller, clock);
  counted = new ApprovalsService(countingDb, audit, notify, users, caller, clock);
  admin = new ApprovalsAdminService(db, audit, caller, clock);
  writer.registerSubject({
    documentType: 'test_memo',
    onDecided: () => Promise.resolve(undefined),
    link: (_tx, documentId) => `/memos/${documentId}`,
  });

  // One published version at a time; the requests of each version stay pending under it.
  for (const [i, spec] of SPECS.entries()) {
    me = U.founder;
    if (i === 0) await admin.createWorkflow({ key: 'test_memo', name: 'Test memo', spec });
    else await admin.addVersion('test_memo', spec);
    me = U.mgmt; // a second person publishes (F1-Q11)
    await admin.publish('test_memo', i + 1, SKIP_LIVE_PUBLISHER_CHECK);
    for (let n = 0; n < REQUESTS_PER_VERSION; n++) requestIds.push((await submit()).requestId);
  }
}, 180_000);

afterAll(async () => {
  await appPool?.end();
  await ownerPool?.end();
  await testDb?.drop();
});

describe('inbox count on pending requests of four workflow versions', () => {
  const asAccountant = () => {
    me = U.acc;
    tokenRoles = ['accountant'];
    grants = new Map<Permission, Scope>([['approvals.requests.act', 'all']]);
  };

  it('counts every pending request the accountant may decide', async () => {
    asAccountant();
    const { count } = await counted.inboxCount();
    expect(count).toBe(SPECS.length * REQUESTS_PER_VERSION);
    const page = await counted.inboxPage({});
    expect(page.total).toBe(count);
  });

  it('sends at most 8 statements and never selects the snapshot', async () => {
    asAccountant();
    // A service of its own: its frozen specs are not in memory yet, the worst case of a first poll.
    const cold = new ApprovalsService(countingDb, audit, notify, users, caller, clock);
    const sent = await capture(() => cold.inboxCount());
    expect(sent.length).toBeLessThanOrEqual(5); // plan bound 8; measured 5 on a cold cache, was 22
    expect(sent.filter((s) => /"snapshot(_sha256)?"/.test(s))).toEqual([]);
  });

  it('keeps a frozen spec in memory: a second count reads no workflow version', async () => {
    asAccountant();
    await counted.inboxCount();
    const sent = await capture(() => counted.inboxCount());
    expect(sent.filter((s) => s.includes('"workflow_versions"'))).toEqual([]);
    expect(sent.length).toBeLessThanOrEqual(4);
  });

  it('reads the role holders of all roles in one statement, the same as one read per role', async () => {
    const store = new SqlUsersStore(countingDb);
    const asked: RoleKey[] = ['accountant', 'finance', 'management', 'founder', 'sales'];
    const sent = await capture(async () => {
      const all = await store.userIdsWithRoles(scope, asked);
      for (const role of asked) {
        expect(all.get(role)).toEqual(await store.userIdsWithRole(scope, role));
      }
      expect(all.get('sales')).toEqual([]);
      expect(all.get('accountant')).toEqual([U.acc]);
    });
    // One batched read plus one per role; the batched read is the first statement.
    expect(sent).toHaveLength(1 + asked.length);
  });

  it('keeps the same 403 for a caller with no approval assignment', async () => {
    me = U.requester;
    tokenRoles = [];
    grants = new Map<Permission, Scope>();
    await expect(counted.inboxCount()).rejects.toMatchObject({
      status: 403,
      response: { reason: 'out_of_scope' },
    });
  });

  it('filters the step and action reads of one request by tenant, and leaves result out', async () => {
    me = U.acc;
    tokenRoles = ['accountant'];
    grants = new Map<Permission, Scope>([['approvals.requests.read', 'all']]);
    const sent = await capture(() => counted.get(requestIds[0]!));
    const stepReads = sent.filter((s) => /from "app"."approval_steps"/.test(s));
    const actionReads = sent.filter((s) => /from "app"."approval_actions"/.test(s));
    expect(stepReads.length).toBeGreaterThan(0);
    expect(actionReads.length).toBeGreaterThan(0);
    for (const s of stepReads) expect(whereOf(s)).toContain('"tenant_id"');
    for (const s of actionReads) {
      expect(whereOf(s)).toContain('"tenant_id"');
      expect(whereOf(s)).toContain('"organization_id"');
      expect(s).not.toContain('"result"');
    }
  });
  it('returns one SQL page at 2,500 waiting, with matching count and age buckets', async () => {
    asAccountant();
    const extra = 2500 - requestIds.length;
    await withTx(db, scope, systemActor('test'), (tx) =>
      tx.execute(sql`
      with added as (
        insert into app.approval_requests
        select (jsonb_populate_record(r,jsonb_build_object(
          'id',gen_random_uuid(),'document_id',gen_random_uuid(),
          'submitted_at',${clock().toISOString()}::timestamptz - interval '2 days'
        ))).* from app.approval_requests r cross join generate_series(1,${extra}::int)
        where r.id=${requestIds[0]}
        returning id
      )
      insert into app.approval_steps
      select (jsonb_populate_record(s,jsonb_build_object('id',gen_random_uuid(),'request_id',added.id))).*
      from app.approval_steps s cross join added where s.request_id=${requestIds[0]} and s.seq=1
    `),
    );
    const sent = await capture(async () => {
      const page = await counted.inboxPage({ limit: 10, offset: 20 });
      expect(page.items).toHaveLength(10);
      expect(page.total).toBe(2500);
    });
    expect(sent.length).toBeLessThanOrEqual(6);
    expect(sent.some((query) => query.includes('limit') && query.includes('offset'))).toBe(true);
    expect(await counted.inboxCount()).toEqual({ count: 2500 });
    expect(await counted.inboxSummary()).toEqual(
      expect.arrayContaining([
        { documentType: 'test_memo', state: 'pending', age: 'under_week', count: extra },
        { documentType: 'test_memo', state: 'pending', age: 'under_day', count: requestIds.length },
      ]),
    );
  }, 30000);
});

describe('directoryViewOf: the active-user set stays the answer one spec alone would get', () => {
  const H = randomUUID();
  const N = randomUUID();
  const base = { roleMembers: new Map(), groups: new Map(), delegations: [] };
  const spec = (steps: object[]) => ({ documentType: 'x', steps, rules: [] }) as never;
  const headStep = { id: 'h', kind: 'department_head', reason: 'head' };
  const userStep = (user: string) => ({ id: 'u', kind: 'user', user, reason: 'named' });
  const union = (active: string[]): DirectoryData => ({
    ...base,
    departmentHeads: new Map([['dept', H]]),
    activeUserIds: new Set(active),
  });

  it('leaves the set out for a spec that names nobody, as that spec alone would', () => {
    const view = directoryViewOf(union([N]), spec([step('a', 'accountant')]), []);
    expect(view.activeUserIds).toBeUndefined();
  });

  it("does not let another version's named user restrict a stale department head", () => {
    // Version A names N; version B has a department_head step whose stored head is H, who is not active.
    const viewB = directoryViewOf(union([N]), spec([headStep]), [H]);
    expect(viewB.activeUserIds).toEqual(new Set());
    const viewA = directoryViewOf(union([N]), spec([userStep(N)]), []);
    expect(viewA.activeUserIds).toEqual(new Set([N]));
  });

  it('keeps the whole set for a spec without a named user when the rows name users', () => {
    const view = directoryViewOf(union([N]), spec([step('a', 'accountant')]), [N]);
    expect(view.activeUserIds).toEqual(new Set([N]));
  });
});
