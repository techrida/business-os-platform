// Approval actions written in one transaction share created_at (the service clock). The history must still
// list them in the order they were written, so the tie is broken by the insertion sequence, not by the random id.
// Real Postgres (bos_app pool) and the real ApprovalsService; audit, notify, the directory and the caller are faked.
import { randomUUID } from 'node:crypto';

import { PERMISSIONS, type Permission, type RoleKey, type Scope } from '@bos/contracts';
import { approvalActions, createStaffUser, createTenantWithEntity } from '@bos/db';
import { createTestDatabase, type TestDatabase } from '@bos/db/testing';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { SKIP_LIVE_PUBLISHER_CHECK } from '../../../test/support/second-person';
import type { Principal } from '../../platform/authz/principal';
import type { Db } from '../../platform/db/db.module';
import { systemActor, withTx } from '../../platform/db/tx';
import { ApprovalsAdminService } from './admin.service';
import type { Caller } from './ports';
import { ApprovalsService } from './requests.service';

/** The largest uuid: any id gen_random_uuid() gives sorts before it. */
const MAX_UUID = 'ffffffff-ffff-ffff-ffff-ffffffffffff';

const scope = { tenantId: '', organizationId: '' };
let staffIdpOrgId = '';
const U = { requester: '', acc: '', fin: '', mgmt: '', founder: '' };
const roles: Partial<Record<RoleKey, string[]>> = {};
const rolesOf = (id: string) =>
  (Object.keys(roles) as RoleKey[]).filter((r) => roles[r]?.includes(id) === true);
const grants = new Map<Permission, Scope>(PERMISSIONS.map((p) => [p, 'all']));
let me = '';
const now = new Date('2026-11-08T04:00:00Z');

const audit = { record: vi.fn(() => Promise.resolve(undefined)) };
const notify = {
  notifyUser: vi.fn(() => Promise.resolve(undefined)),
  notifyRole: vi.fn(() => Promise.resolve(undefined)),
};
const users = {
  userIdsWithRole: vi.fn((_s: unknown, role: RoleKey) => Promise.resolve(roles[role] ?? [])),
  resolve: vi.fn(),
  emailOf: vi.fn((id: string) => Promise.resolve(`${id}@bos.test`)),
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
      roles: rolesOf(me),
      departmentId: null,
      status: 'active',
      grants,
    } satisfies Principal,
  }),
};
const clock = () => now;

let testDb: TestDatabase;
let ownerPool: Pool;
let appPool: Pool;
let db: Db;
let service: ApprovalsService;

beforeAll(async () => {
  testDb = await createTestDatabase();
  ownerPool = new Pool({ connectionString: testDb.ownerUrl, max: 2 });
  appPool = new Pool({ connectionString: testDb.appUrl, max: 2 });
  db = drizzle({ client: appPool });

  const t = await createTenantWithEntity(ownerPool);
  Object.assign(scope, { tenantId: t.tenantId, organizationId: t.organizationId });
  staffIdpOrgId = t.idpOrgId;
  const mirror: Record<keyof typeof U, RoleKey[]> = {
    requester: [],
    acc: ['accountant'],
    fin: ['finance'],
    mgmt: ['management'],
    founder: ['founder'],
  };
  for (const key of Object.keys(U) as (keyof typeof U)[]) {
    U[key] = (
      await createStaffUser(ownerPool, {
        tenantId: scope.tenantId,
        organizationId: scope.organizationId,
        idpOrgId: staffIdpOrgId,
        roleKeys: mirror[key],
      })
    ).userId;
  }
  roles.accountant = [U.acc];
  roles.finance = [U.fin];
  roles.management = [U.mgmt];
  roles.founder = [U.founder];

  service = new ApprovalsService(db, audit, notify, users, caller, clock);
  const admin = new ApprovalsAdminService(db, audit, caller, clock);
  service.registerSubject({
    documentType: 'test_memo',
    onDecided: () => Promise.resolve(undefined),
    link: (_tx, documentId) => `/memos/${documentId}`,
  });
  // Saved by the founder, published by management (a second person).
  me = U.founder;
  await admin.createWorkflow({
    key: 'test_memo',
    name: 'Test memo',
    spec: {
      documentType: 'test_memo',
      steps: [
        { id: 'accountant', kind: 'role', role: 'accountant', reason: 'Accountant checks' },
        { id: 'finance', kind: 'role', role: 'finance', reason: 'Finance approves' },
      ],
    },
  });
  me = U.mgmt;
  await admin.publish('test_memo', 1, SKIP_LIVE_PUBLISHER_CHECK);
}, 180_000);

afterAll(async () => {
  await appPool?.end();
  await ownerPool?.end();
  await testDb?.drop();
});

describe('approval action order', () => {
  it('lists actions written in one transaction in insertion order, even when the later id sorts first', async () => {
    const submitted = await withTx(db, scope, systemActor('test'), (tx) =>
      service.submit(tx, {
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
    const requestId = submitted.requestId;

    // Two rows in ONE transaction with the same created_at: first the largest possible id (written by the app
    // role directly), then a row through the service's own writer, whose random id always sorts before it.
    const later = new Date(now.getTime() + 60_000);
    const dto = await withTx(db, scope, systemActor('test'), async (tx) => {
      await tx.insert(approvalActions).values({
        ...scope,
        id: MAX_UUID,
        requestId,
        stepId: null,
        actorUserId: null,
        action: 'remind',
        comment: 'first',
        requestVersion: 1,
        createdAt: later,
      });
      await service.writeAction(tx, scope, {
        requestId,
        actorUserId: null,
        action: 'escalate',
        comment: 'second',
        requestVersion: 1,
        now: later,
      });
      return service.loadDto(tx, scope, requestId);
    });

    expect(dto.actions.map((a) => a.action)).toEqual(['submit', 'remind', 'escalate']);
    expect(dto.actions.slice(1).map((a) => a.comment)).toEqual(['first', 'second']);
    expect(dto.actions[1]?.createdAt).toBe(dto.actions[2]?.createdAt);

    // Read again in a fresh transaction after commit: the order is stored, not an artefact of the writer.
    const reread = await withTx(db, scope, systemActor('test'), (tx) =>
      service.loadDto(tx, scope, requestId),
    );
    expect(reread.actions.map((a) => a.comment)).toEqual([null, 'first', 'second']);
  });
});
