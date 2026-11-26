// Integration test (real Postgres, needs Docker): the approvals read path stays cheap (round 7, unit U1-07).
// The sidebar badge polls `inboxCount`, so its statement count and the columns it drags out of Postgres are
// the cost of every navigation. Pending requests sit on four workflow versions; a drizzle logger counts every
// statement the read path sends. The SQL checks pin the tenant predicate of the step and action reads and
// that the decision history never reads `result`.
import { randomUUID } from 'node:crypto';

import { PERMISSIONS, type Permission, type RoleKey, type Scope } from '@bos/contracts';
import { createStaffUser, createTenantWithEntity } from '@bos/db';
import { createTestDatabase, type TestDatabase } from '@bos/db/testing';
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
import { ApprovalsService } from './requests.service';

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
    expect(sent.length).toBeLessThanOrEqual(8);
    expect(sent.filter((s) => s.includes('"snapshot"'))).toEqual([]);
  });

  it('keeps a frozen spec in memory: a second count reads no workflow version', async () => {
    asAccountant();
    await counted.inboxCount();
    const sent = await capture(() => counted.inboxCount());
    expect(sent.filter((s) => s.includes('"workflow_versions"'))).toEqual([]);
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
});
