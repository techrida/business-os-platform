// Tests for the admin-user review fixes: an invite that grants roles needs `admin.roles.write`, a
// half-finished invite can be repaired by inviting again, and emailOf answers only for active users.
// The emailOf test runs the real SQL in a Postgres test database (needs Docker), and the ADR 0027 test runs the
// store's tenant-scoped SQL against the real migrations (0013), so a wrong ON CONFLICT target fails (42P10):
//   pnpm --filter @bos/api exec vitest run src/platform/users/admin-users.test.ts
import 'reflect-metadata';

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { AdminUserSchema, type Permission, type RoleKey } from '@bos/contracts';
import { departments, idpOrgs, organizations, parties, tenants, userEntities } from '@bos/db';
import { createTestDatabase, type TestDatabase } from '@bos/db/testing';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { Queue } from 'bullmq';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { AuditService } from '../audit/audit.service';
import { AuthzService } from '../authz/authz.service';
import type { RoleCache } from '../authz/role-cache';
import type { Db } from '../db/db.module';
import { systemActor, withTx } from '../db/tx';
import { bindIdentity, bindPrincipal, runWithRequestStore } from '../tenancy/request-context';
import { AdminUsersController } from './admin-users.controller';
import { UserMirror } from './user-mirror';
import { UserStatusService } from './user-status';
import type { UsersSyncData } from './users.constants';
import {
  CUST_IDP,
  FakeUsersStore,
  FakeZitadel,
  STAFF_IDP,
  STAFF_ORG,
  STAFF_ZORG,
  TENANT,
  applyZitadelStatusTransition,
  fakeDb,
  fakeQueue,
} from './users.fakes';
import { UsersService } from './users.service';
import { SqlUsersStore } from './users.store';
import {
  type CreateHumanInput,
  type ZitadelAdminClient,
  ZitadelHttpError,
  type ZitadelUser,
  type ZitadelUserPage,
} from './zitadel-admin.client';

/** ZITADEL that remembers who it created and answers 409 for a second createHuman of one email. */
class RepairableZitadel {
  users = new Map<string, ZitadelUser>();
  grants = new Map<string, RoleKey[]>();
  grantOrgs = new Map<string, string>();
  inviteCodes: string[] = [];
  resetEmails: string[] = [];
  createCalls = 0;
  failSetGrantsOnce = false;
  pageSize = 1; // one user per page, so finding the user has to walk the pages
  private seq = 0;

  createHuman(orgId: string, input: CreateHumanInput) {
    this.createCalls += 1;
    for (const u of this.users.values()) {
      if (u.email === input.email) {
        return Promise.reject(new ZitadelHttpError('/CreateUser', 409, 'ALREADY_EXISTS'));
      }
    }
    this.seq += 1;
    const id = `z-created-${this.seq}`;
    this.users.set(id, {
      id,
      orgId,
      email: input.email,
      displayName: `${input.givenName} ${input.familyName}`,
      status: 'invited',
      createdAt: null,
    });
    return Promise.resolve(id);
  }
  setGrants(userId: string, orgId: string, roles: readonly RoleKey[]) {
    if (this.failSetGrantsOnce) {
      this.failSetGrantsOnce = false;
      return Promise.reject(new Error('ZITADEL 503 during setGrants'));
    }
    this.grants.set(userId, [...roles]);
    this.grantOrgs.set(userId, orgId);
    return Promise.resolve();
  }
  sendInviteCode(userId: string) {
    this.inviteCodes.push(userId);
    return Promise.resolve();
  }
  getUser(userId: string) {
    return Promise.resolve(this.users.get(userId) ?? null);
  }
  listGrants(userId: string, orgId: string) {
    if (!orgId) return Promise.resolve([]);
    const ownerOrg = this.grantOrgs.get(userId) ?? this.users.get(userId)?.orgId;
    if (ownerOrg !== undefined && ownerOrg !== orgId) return Promise.resolve([]);
    return Promise.resolve([...(this.grants.get(userId) ?? [])]);
  }
  sendPasswordReset(userId: string) {
    this.resetEmails.push(userId);
    return Promise.resolve();
  }
  statusCalls: string[] = [];
  /** A ZITADEL error the next status call answers with, once. */
  failNextStatusCall: Error | null = null;
  private setState(userId: string, call: 'lock' | 'unlock' | 'deactivate' | 'reactivate') {
    if (this.failNextStatusCall) {
      const error = this.failNextStatusCall;
      this.failNextStatusCall = null;
      return Promise.reject(error);
    }
    try {
      applyZitadelStatusTransition(this.users.get(userId), call);
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    this.statusCalls.push(`${call}:${userId}`);
    return Promise.resolve();
  }
  lockUser(userId: string) {
    return this.setState(userId, 'lock');
  }
  unlockUser(userId: string) {
    return this.setState(userId, 'unlock');
  }
  deactivateUser(userId: string) {
    return this.setState(userId, 'deactivate');
  }
  reactivateUser(userId: string) {
    return this.setState(userId, 'reactivate');
  }
  listUsers(orgId: string, cursor?: string | null): Promise<ZitadelUserPage> {
    const all = [...this.users.values()].filter((u) => u.orgId === orgId);
    const offset = cursor ? Number(cursor) : 0;
    const users = all.slice(offset, offset + this.pageSize);
    const next = offset + users.length;
    return Promise.resolve({ users, nextCursor: next < all.length ? String(next) : null });
  }
}

class TestAuthz extends AuthzService {
  invalidations = 0;
  override invalidate(): Promise<void> {
    this.invalidations += 1;
    return Promise.resolve();
  }
}

const ADMIN = '00000000-0000-4000-9000-0000000000ad';
const NEW_USER = {
  email: 'asha@techrida.test',
  givenName: 'Asha',
  familyName: 'Rai',
};

/** What the role cache says the stored admin may do now; asAdmin sets it to the permissions it binds. */
let liveAdminGrants = new Map<Permission, 'all'>();

/** Runs `fn` as an active admin holding exactly `permissions`, as the tenancy interceptor would bind it. */
function asAdmin<T>(permissions: Permission[], fn: () => Promise<T>): Promise<T> {
  liveAdminGrants = new Map(permissions.map((p) => [p, 'all' as const]));
  return runWithRequestStore('corr-12345678', () => {
    bindIdentity({
      tenantId: TENANT,
      organizationId: STAFF_ORG,
      orgKind: 'staff',
      partyId: null,
      idpOrgId: STAFF_IDP,
      userId: 'zitadel-admin',
      roles: [],
      departmentId: null,
      tokenExp: 1_900_000_000,
    });
    bindPrincipal({
      userId: ADMIN,
      zitadelUserId: 'zitadel-admin',
      tenantId: TENANT,
      organizationId: STAFF_ORG,
      orgKind: 'staff',
      partyId: null,
      idpOrgId: STAFF_IDP,
      roles: [],
      departmentId: null,
      status: 'active',
      grants: new Map(permissions.map((p) => [p, 'all' as const])),
    });
    return fn();
  });
}

let db: ReturnType<typeof fakeDb>;
let store: FakeUsersStore;
let liveStore: FakeUsersStore;
let zitadel: RepairableZitadel;
let authz: TestAuthz;
let controller: AdminUsersController;
let audit: AuditService;

beforeEach(() => {
  store = new FakeUsersStore();
  zitadel = new RepairableZitadel();
  db = fakeDb();
  const client = zitadel as never;
  const mirror = new UserMirror(db, store, client, fakeQueue() as unknown as Queue<UsersSyncData>);
  authz = new TestAuthz(db, {} as RoleCache);
  audit = new AuditService(db);
  // The admin the tests act as is a stored, active Founder of the staff entity in its own store: the role writes re-read it.
  liveStore = new FakeUsersStore();
  liveStore.users.push({
    id: ADMIN,
    tenantId: TENANT,
    idpOrgId: STAFF_IDP,
    zitadelUserId: 'zitadel-admin',
    email: 'admin@techrida.test',
    displayName: 'Admin',
    status: 'active',
  });
  liveStore.roles.set(ADMIN, ['founder']);
  liveStore.memberships.push({
    tenantId: TENANT,
    userId: ADMIN,
    organizationId: STAFF_ORG,
    isDefault: true,
    roleKeys: null,
    departmentId: null,
  });
  liveAdminGrants = new Map();
  const roleCache = { grantsFor: () => Promise.resolve(liveAdminGrants) } as unknown as RoleCache;
  controller = new AdminUsersController(
    new UsersService(mirror, store, client, db, audit),
    authz,
    liveStore,
    roleCache,
    new UserStatusService(db, store, client, audit),
  );
});

describe('GET /v1/admin/users validation', () => {
  it.each([
    { q: 'z'.repeat(201) },
    { q: ['a', 'b'] },
    { status: 'disabled' },
    { role: 'owner' },
    { departmentId: 'invalid' },
    { sort: 'email' },
    { page: '0' },
    { page: '10001' },
    { limit: '201' },
    { limit: ['10'] },
    { after: ADMIN, sort: 'name' },
    { after: ADMIN, page: '1' },
    { status: ['active', 'disabled'] },
    { role: ['sales', 'owner'] },
    { q: ['a', 'b'] },
    { unknown: 'x' },
  ])('rejects invalid directory parameters %#', async (query) => {
    await expect(controller.list(query, { setHeader: vi.fn() })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('trims search and passes validated filters and pagination to the store', async () => {
    const list = vi.spyOn(store, 'list');
    await asAdmin(['admin.users.read'], () =>
      controller.list(
        {
          q: '  aB  ',
          status: 'active',
          role: 'sales',
          departmentId: ADMIN,
          sort: 'lastActive',
          page: '3',
          limit: '10',
        },
        { setHeader: vi.fn() },
      ),
    );
    expect(list).toHaveBeenCalledWith(
      { tenantId: TENANT, organizationId: STAFF_ORG },
      {
        q: 'aB',
        status: ['active'],
        role: ['sales'],
        departmentId: ADMIN,
        sort: 'lastActive',
        page: 3,
        limit: 10,
      },
    );
  });

  it('accepts repeated status and role params, drops empties and duplicates, and ignores a one-letter search', async () => {
    const list = vi.spyOn(store, 'list');
    await asAdmin(['admin.users.read'], () =>
      controller.list(
        {
          q: 'a',
          status: ['active', 'invited', 'active', ''],
          role: ['sales', 'finance'],
        },
        { setHeader: vi.fn() },
      ),
    );
    expect(list).toHaveBeenCalledWith(
      { tenantId: TENANT, organizationId: STAFF_ORG },
      { status: ['active', 'invited'], role: ['sales', 'finance'], limit: 50 },
    );
  });
});

describe('GET /v1/admin/users total', () => {
  const listed = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      id: `00000000-0000-4000-9000-${String(i + 1).padStart(12, '0')}`,
      tenantId: TENANT,
      idpOrgId: STAFF_IDP,
      zitadelUserId: `z-${i}`,
      email: null,
      displayName: `Person ${i + 1}`,
      status: 'active' as const,
      roles: [],
      department: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      lastActiveAt: null,
    }));

  it('sends the store total as X-Total-Count, not the size of this page', async () => {
    vi.spyOn(store, 'list').mockResolvedValue({ rows: listed(3), total: 7 });
    const res = { setHeader: vi.fn() };
    const page = await asAdmin(['admin.users.read'], () =>
      controller.list({ status: 'active', sort: 'name', limit: '2' }, res),
    );
    expect(res.setHeader).toHaveBeenCalledWith('X-Total-Count', '7');
    expect(page.items).toHaveLength(2);
    expect(page.nextPage).toBe(2);
  });

  it('reports zero on an empty page', async () => {
    vi.spyOn(store, 'list').mockResolvedValue({ rows: [], total: 0 });
    const res = { setHeader: vi.fn() };
    const page = await asAdmin(['admin.users.read'], () => controller.list({}, res));
    expect(res.setHeader).toHaveBeenCalledWith('X-Total-Count', '0');
    expect(page).toEqual({ items: [], nextAfter: null, nextPage: null });
  });
});

describe('POST /v1/admin/users/:id/password-reset', () => {
  const adminGrant = ['admin.roles.write'] as const;

  // ZITADEL refuses a reset for an open invite, so these targets have accepted theirs.
  async function inviteForReset() {
    const invited = await asAdmin(['admin.users.invite'], () =>
      controller.invite({ ...NEW_USER, roles: [] }),
    );
    const target = store.users.find(({ id }) => id === invited.userId)!;
    target.status = 'active';
    zitadel.users.get(target.zitadelUserId)!.status = 'active';
    return invited;
  }

  it('requires the administrative grant and audits the target before requesting email', async () => {
    const { userId } = await inviteForReset();
    const record = vi.spyOn(audit, 'record').mockResolvedValue(undefined);
    await expect(
      asAdmin(['admin.users.read'], () => controller.sendPasswordReset(userId)),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(zitadel.resetEmails).toEqual([]);
    const send = vi.spyOn(zitadel, 'sendPasswordReset');
    await asAdmin([...adminGrant], () => controller.sendPasswordReset(userId));
    expect(record).toHaveBeenCalledWith(expect.anything(), {
      action: 'users.password_reset_requested',
      entityType: 'users',
      entityId: userId,
    });
    expect(record.mock.invocationCallOrder[0]).toBeLessThan(send.mock.invocationCallOrder[0]!);
    expect(zitadel.resetEmails).toEqual([store.users[0]!.zitadelUserId]);
  });

  it('rejects a different tenant and a target deactivated in either the mirror or ZITADEL', async () => {
    const { userId } = await inviteForReset();
    const target = store.users[0]!;
    const live = zitadel.users.get(target.zitadelUserId)!;
    const reset = () => asAdmin([...adminGrant], () => controller.sendPasswordReset(userId));
    target.tenantId = randomUUID();
    await expect(reset()).rejects.toBeInstanceOf(NotFoundException);
    target.tenantId = TENANT;
    target.status = 'inactive';
    await expect(reset()).rejects.toBeInstanceOf(ConflictException);
    target.status = 'active';
    live.status = 'inactive';
    await expect(reset()).rejects.toBeInstanceOf(ConflictException);
    expect(zitadel.resetEmails).toEqual([]);
  });

  it('rejects an invited user in either the mirror or ZITADEL without auditing', async () => {
    const { userId } = await inviteForReset();
    const target = store.users[0]!;
    const live = zitadel.users.get(target.zitadelUserId)!;
    const record = vi.spyOn(audit, 'record').mockResolvedValue(undefined);
    const reset = () => asAdmin([...adminGrant], () => controller.sendPasswordReset(userId));
    target.status = 'invited';
    await expect(reset()).rejects.toBeInstanceOf(ConflictException);
    target.status = 'active';
    live.status = 'invited';
    await expect(reset()).rejects.toBeInstanceOf(ConflictException);
    expect(record).not.toHaveBeenCalled();
    expect(zitadel.resetEmails).toEqual([]);
  });

  it('keeps the audit when the provider fails and exposes only a fixed error', async () => {
    const { userId } = await inviteForReset();
    const record = vi.spyOn(audit, 'record').mockResolvedValue(undefined);
    vi.spyOn(zitadel, 'sendPasswordReset').mockRejectedValue(new Error('provider failure detail'));
    await expect(
      asAdmin([...adminGrant], () => controller.sendPasswordReset(userId)),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(record).toHaveBeenCalledOnce();
  });
});

describe('POST /v1/admin/users/invite permissions', () => {
  it('refuses 403 no_permission when the invite grants a role and the caller lacks admin.roles.write', async () => {
    const error = await asAdmin(['admin.users.invite'], () =>
      controller.invite({ ...NEW_USER, roles: ['finance'] }),
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ForbiddenException);
    expect((error as ForbiddenException).getStatus()).toBe(403);
    expect((error as ForbiddenException).getResponse()).toMatchObject({ reason: 'no_permission' });
    // Refused before anything reached ZITADEL or the mirror.
    expect(zitadel.createCalls).toBe(0);
    expect(store.users).toHaveLength(0);
  });

  it('lets a caller with both permissions invite with a role', async () => {
    const { userId } = await asAdmin(['admin.users.invite', 'admin.roles.write'], () =>
      controller.invite({ ...NEW_USER, roles: ['finance'] }),
    );

    expect(store.roles.get(userId)).toEqual(['finance']);
    expect(authz.invalidations).toBe(1);
  });

  it('lets a caller with only admin.users.invite invite without any role', async () => {
    const { userId } = await asAdmin(['admin.users.invite'], () =>
      controller.invite({ ...NEW_USER, roles: [] }),
    );

    expect(store.users.map((u) => u.id)).toEqual([userId]);
    expect(store.roles.get(userId) ?? []).toEqual([]);
  });
});

describe('POST /v1/admin/users/invite with a department and level (F1-Q50)', () => {
  const SALES = '00000000-0000-4000-8000-0000000005a1';
  const OTHER_ENTITY = '00000000-0000-4000-8000-0000000000bb';
  const BOTH: Permission[] = ['admin.users.invite', 'admin.roles.write'];

  const department = (
    over: Partial<{
      organizationId: string;
      status: 'active' | 'retired';
      headUserId: string | null;
    }> = {},
  ) =>
    store.departments.set(SALES, {
      tenantId: TENANT,
      organizationId: STAFF_ORG,
      name: 'Sales',
      status: 'active',
      headUserId: null,
      ...over,
    });

  const membershipOf = (userId: string) => store.memberships.find((m) => m.userId === userId);

  it('places the new person in the department at the chosen level on their default-entity membership', async () => {
    department();
    const { userId } = await asAdmin(BOTH, () =>
      controller.invite({ ...NEW_USER, roles: [], departmentId: SALES, level: 'manager' }),
    );

    expect(membershipOf(userId)).toMatchObject({
      organizationId: STAFF_ORG,
      departmentId: SALES,
      level: 'manager',
    });
    expect(authz.invalidations).toBe(1);
  });

  it('accepts a department alone, at level staff', async () => {
    department();
    const { userId } = await asAdmin(BOTH, () =>
      controller.invite({ ...NEW_USER, roles: [], departmentId: SALES }),
    );
    expect(membershipOf(userId)).toMatchObject({ departmentId: SALES, level: 'staff' });
  });

  it('refuses 403 a department without admin.roles.write, before ZITADEL or the mirror', async () => {
    department();
    const error = await asAdmin(['admin.users.invite'], () =>
      controller.invite({ ...NEW_USER, roles: [], departmentId: SALES }),
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ForbiddenException);
    expect(zitadel.createCalls).toBe(0);
    expect(store.users).toHaveLength(0);
  });

  it('needs no extra grant for level staff without a department, and places nobody', async () => {
    const { userId } = await asAdmin(['admin.users.invite'], () =>
      controller.invite({ ...NEW_USER, roles: [], level: 'staff' }),
    );
    expect(membershipOf(userId)).toMatchObject({ departmentId: null });
    expect(membershipOf(userId)).not.toHaveProperty('level');
  });

  it('refuses a head without a department', async () => {
    const error = await asAdmin(BOTH, () =>
      controller.invite({ ...NEW_USER, roles: [], level: 'head' }),
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BadRequestException);
  });

  it.each([
    ['in another legal entity', { organizationId: OTHER_ENTITY }],
    ['retired', { status: 'retired' as const }],
  ])('refuses a department %s', async (_label, over) => {
    department(over);
    const error = await asAdmin(BOTH, () =>
      controller.invite({ ...NEW_USER, roles: [], departmentId: SALES }),
    ).catch((e: unknown) => e);
    expect((error as { getStatus?: () => number }).getStatus?.()).toBe(422);
  });

  /** The department is valid when checked before ZITADEL and retired when checked again at the membership write. */
  const retiredOnRecheck = () => {
    const real = store.departmentForPlacement.bind(store);
    let reads = 0;
    vi.spyOn(store, 'departmentForPlacement').mockImplementation(((
      ...args: Parameters<typeof real>
    ) =>
      real(...args).then((found) => {
        reads += 1;
        return reads === 1 || !found ? found : { ...found, status: 'retired' as const };
      })) as typeof real);
  };

  /** Nothing reached ZITADEL: no identity, no grants, no invite mail. */
  const expectZitadelUntouched = () => {
    expect(zitadel.createCalls).toBe(0);
    expect(zitadel.grants.size).toBe(0);
    expect(zitadel.inviteCodes).toEqual([]);
    expect(store.users).toHaveLength(0);
  };

  it.each([
    ['in another legal entity', { organizationId: OTHER_ENTITY }, 422],
    ['retired', { status: 'retired' as const }, 422],
    ['that already has a head', { headUserId: '00000000-0000-4000-9000-0000000009aa' }, 409],
  ])(
    'refuses a department %s before ZITADEL creates, grants or invites anyone',
    async (_label, over, status) => {
      department(over);
      const error = await asAdmin(BOTH, () =>
        controller.invite({ ...NEW_USER, roles: ['sales'], departmentId: SALES, level: 'head' }),
      ).catch((e: unknown) => e);

      expect((error as { getStatus?: () => number }).getStatus?.()).toBe(status);
      expectZitadelUntouched();
    },
  );

  it('refuses a head without a department before ZITADEL', async () => {
    const error = await asAdmin(BOTH, () =>
      controller.invite({ ...NEW_USER, roles: ['sales'], level: 'head' }),
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(BadRequestException);
    expectZitadelUntouched();
  });

  it('never deletes the identity or strips grants when the placement fails after ZITADEL was written; the person is denied in BOS (round 3)', async () => {
    department();
    retiredOnRecheck();

    const error = await asAdmin(BOTH, () =>
      controller.invite({ ...NEW_USER, roles: ['sales'], departmentId: SALES }),
    ).catch((e: unknown) => e);

    expect((error as { getStatus?: () => number }).getStatus?.()).toBe(422);
    expect(zitadel.createCalls).toBe(1);
    expect(zitadel.users.has('z-created-1')).toBe(true);
    // No compensation in ZITADEL: the grant stays; BOS holds the person closed and flagged.
    expect(zitadel.grants.get('z-created-1')).toEqual(['sales']);
    expect(store.users).toHaveLength(1);
    expect(store.users[0]).toMatchObject({
      zitadelUserId: 'z-created-1',
      identityReviewRequired: true,
    });
    expect(store.users[0]!.status).not.toBe('active');
  });

  it('keeps an identity it did not create (an earlier open invite), strips nothing when the placement fails late, and denies the person (round 3)', async () => {
    department();
    zitadel.users.set('z-open', {
      id: 'z-open',
      orgId: STAFF_ZORG,
      email: NEW_USER.email,
      displayName: 'Open invite',
      status: 'invited',
      createdAt: null,
    });
    retiredOnRecheck();

    const error = await asAdmin(BOTH, () =>
      controller.invite({ ...NEW_USER, roles: ['sales'], departmentId: SALES }),
    ).catch((e: unknown) => e);

    expect((error as { getStatus?: () => number }).getStatus?.()).toBe(422);
    expect(zitadel.users.has('z-open')).toBe(true);
    expect(zitadel.grants.get('z-open')).toEqual(['sales']);
    expect(store.users[0]).toMatchObject({ zitadelUserId: 'z-open', identityReviewRequired: true });
    expect(store.users[0]!.status).not.toBe('active');
  });

  it('refuses an unknown department, and a malformed one with 400', async () => {
    const unknown = await asAdmin(BOTH, () =>
      controller.invite({
        ...NEW_USER,
        roles: [],
        departmentId: '00000000-0000-4000-8000-0000000005ff',
      }),
    ).catch((e: unknown) => e);
    expect((unknown as { getStatus?: () => number }).getStatus?.()).toBe(422);

    const malformed = await asAdmin(BOTH, () =>
      controller.invite({ ...NEW_USER, roles: [], departmentId: 'sales' }),
    ).catch((e: unknown) => e);
    expect(malformed).toBeInstanceOf(BadRequestException);
  });

  it('keeps an existing head: a second head is refused with 409', async () => {
    department({ headUserId: ADMIN });
    const error = await asAdmin(BOTH, () =>
      controller.invite({ ...NEW_USER, roles: [], departmentId: SALES, level: 'head' }),
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConflictException);
    expect((error as ConflictException).getResponse()).toMatchObject({
      code: 'department_has_head',
    });
  });
});

describe('inviting again after a half-finished invite', () => {
  const both: Permission[] = ['admin.users.invite', 'admin.roles.write'];

  it('flags the ZITADEL user created by the failed attempt; a retry reuses it and the flag keeps the person closed (round 3)', async () => {
    zitadel.failSetGrantsOnce = true;
    await expect(
      asAdmin(both, () => controller.invite({ ...NEW_USER, roles: ['finance'] })),
    ).rejects.toThrow('ZITADEL 503 during setGrants');
    // ZITADEL has the user; BOS holds a closed, flagged, role-less row for it; nothing was undone.
    expect(zitadel.users.size).toBe(1);
    expect(store.users).toHaveLength(1);
    expect(store.users[0]).toMatchObject({ identityReviewRequired: true });
    expect(store.users[0]!.status).not.toBe('active');
    expect(store.roles.get(store.users[0]!.id) ?? []).toEqual([]);

    // A second user ahead of the first in the org, so the lookup has to page past it.
    const [created] = [...zitadel.users.values()];
    zitadel.users.clear();
    zitadel.users.set('z-other', {
      id: 'z-other',
      orgId: STAFF_ZORG,
      email: 'other@techrida.test',
      displayName: 'Other',
      status: 'active',
      createdAt: null,
    });
    zitadel.users.set(created!.id, created!);

    const { userId } = await asAdmin(both, () =>
      controller.invite({ ...NEW_USER, roles: ['finance'] }),
    );

    expect(zitadel.users.size).toBe(2); // no second ZITADEL user for the same email
    expect(store.users).toHaveLength(1);
    expect(store.users[0]).toMatchObject({
      id: userId,
      zitadelUserId: created!.id,
      email: NEW_USER.email,
      identityReviewRequired: true,
    });
    // The retry finished the steps, but only an admin's resolve clears the flag: the person stays closed.
    expect(store.users[0]!.status).not.toBe('active');
    expect(zitadel.grants.get(created!.id)).toEqual(['finance']);
    expect(zitadel.inviteCodes).toContain(created!.id);
  });

  it('still refuses with 409 when the email belongs to an active user', async () => {
    zitadel.users.set('z-active', {
      id: 'z-active',
      orgId: STAFF_ZORG,
      email: NEW_USER.email,
      displayName: 'Asha Rai',
      status: 'active',
      createdAt: null,
    });

    await expect(
      asAdmin(both, () => controller.invite({ ...NEW_USER, roles: ['founder'] })),
    ).rejects.toBeInstanceOf(ConflictException);
    // The existing user's grants were not touched.
    expect(zitadel.grants.has('z-active')).toBe(false);
    expect(store.users).toHaveLength(0);
  });

  it('keeps the grants and denies the person when reusing an open invite and phase C fails while still invited; no setGrants replay (round 3)', async () => {
    zitadel.users.set('z-open', {
      id: 'z-open',
      orgId: STAFF_ZORG,
      email: NEW_USER.email,
      displayName: 'Asha Rai',
      status: 'invited',
      createdAt: null,
    });
    zitadel.grants.set('z-open', ['accountant']);
    vi.spyOn(store, 'insertUser').mockRejectedValueOnce(new Error('db write failed'));

    await expect(
      asAdmin(both, () => controller.invite({ ...NEW_USER, roles: ['finance'] })),
    ).rejects.toThrow('db write failed');

    // Nothing is replayed into ZITADEL; the person is flagged and cannot be opened by a sync or a sign-in.
    expect(zitadel.grants.get('z-open')).toEqual(['finance']);
    const row = store.users.find((u) => u.zitadelUserId === 'z-open');
    expect(row).toMatchObject({ identityReviewRequired: true });
    expect(row!.status).not.toBe('active');
  });

  it('denies the person and replays no grants when the person finishes sign-up before phase C fails (round 3)', async () => {
    zitadel.users.set('z-open', {
      id: 'z-open',
      orgId: STAFF_ZORG,
      email: NEW_USER.email,
      displayName: 'Asha Rai',
      status: 'invited',
      createdAt: null,
    });
    zitadel.grants.set('z-open', ['accountant']);
    const realSend = zitadel.sendInviteCode.bind(zitadel);
    vi.spyOn(zitadel, 'sendInviteCode').mockImplementationOnce(async (id: string) => {
      await realSend(id);
      // Person accepts invite and becomes active in both ZITADEL and the mirror before phase (C).
      Object.assign(zitadel.users.get(id)!, { status: 'active' });
      store.users.push({
        id: '00000000-0000-4000-9000-000000000777',
        tenantId: TENANT,
        idpOrgId: STAFF_IDP,
        zitadelUserId: id,
        email: NEW_USER.email,
        displayName: 'Asha Rai',
        status: 'active',
      });
    });

    await expect(
      asAdmin(both, () => controller.invite({ ...NEW_USER, roles: ['finance'] })),
    ).rejects.toBeInstanceOf(ConflictException);

    // No compensation: the grant stays in ZITADEL, but BOS now denies the person until an admin resolves the flag.
    expect(zitadel.grants.get('z-open')).toEqual(['finance']);
    const row = store.users.find((u) => u.zitadelUserId === 'z-open');
    expect(row).toMatchObject({ identityReviewRequired: true });
    expect(row!.status).not.toBe('active');
  });
});

describe('role writes re-check the current roles of the caller (U20b-Q3)', () => {
  const TARGET = '00000000-0000-4000-9000-000000000201';

  beforeEach(() => {
    store.users.push({
      id: TARGET,
      tenantId: TENANT,
      idpOrgId: STAFF_IDP,
      zitadelUserId: 'z-target',
      email: 'target@techrida.test',
      displayName: 'Target',
      status: 'active',
    });
    store.roles.set(TARGET, ['sales']);
  });

  /** The token still says admin.roles.write, but the mirror no longer holds the Founder role: the role cache
   * (fed the mirror's roles) then returns no grants. Old code trusted the token and wrote the roles. */
  const formerFounder = () => {
    liveStore.roles.set(ADMIN, []);
    liveAdminGrants = new Map();
  };

  it('refuses 403 a former Founder re-granting Founder with an old token (old code: 204)', async () => {
    const error = await asAdmin(['admin.roles.write'], () => {
      formerFounder();
      return controller.setRoles(TARGET, { roles: ['founder'] });
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ForbiddenException);
    expect(store.roles.get(TARGET)).toEqual(['sales']);
  });

  it('refuses 403 a former Founder inviting someone with a role with an old token', async () => {
    const error = await asAdmin(['admin.users.invite', 'admin.roles.write'], () => {
      formerFounder();
      return controller.invite({ ...NEW_USER, roles: ['founder'] });
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ForbiddenException);
    expect(zitadel.createCalls).toBe(0);
    expect(store.users).toHaveLength(1);
  });

  it('still lets a current Founder set roles', async () => {
    await asAdmin(['admin.roles.write'], () => controller.setRoles(TARGET, { roles: ['finance'] }));
    expect(store.roles.get(TARGET)).toEqual(['finance']);
  });

  it('refuses an admin who was disabled after the token was issued', async () => {
    liveStore.users[0] = { ...liveStore.users[0]!, status: 'inactive' };
    const error = await asAdmin(['admin.roles.write'], () =>
      controller.setRoles(TARGET, { roles: ['finance'] }),
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ForbiddenException);
    expect(store.roles.get(TARGET)).toEqual(['sales']);
  });
});

describe('PUT /v1/admin/users/:id/roles last-Founder guard', () => {
  const FOUNDER_ONE = '00000000-0000-4000-9000-000000000101';
  const FOUNDER_TWO = '00000000-0000-4000-9000-000000000102';
  const INVITED_FOUNDER = '00000000-0000-4000-9000-000000000103';

  /** A membership in `organizationId`; `roleKeys` null means every role the user holds. */
  const joinEntity = (
    userId: string,
    organizationId = STAFF_ORG,
    roleKeys: string[] | null = null,
  ) =>
    store.memberships.push({
      tenantId: TENANT,
      userId,
      organizationId,
      isDefault: organizationId === STAFF_ORG,
      roleKeys,
      departmentId: null,
    });

  beforeEach(() => {
    store.users.push({
      id: FOUNDER_ONE,
      tenantId: TENANT,
      idpOrgId: STAFF_IDP,
      zitadelUserId: 'z-founder-1',
      email: 'kiran@techrida.test',
      displayName: 'Kiran Thapa',
      status: 'active',
    });
    store.roles.set(FOUNDER_ONE, ['founder']);
    joinEntity(FOUNDER_ONE);
  });

  it('refuses removing Founder from the only active Founder and does not touch ZITADEL', async () => {
    // An invited (not yet active) second Founder does not satisfy the guard.
    store.users.push({
      id: INVITED_FOUNDER,
      tenantId: TENANT,
      idpOrgId: STAFF_IDP,
      zitadelUserId: 'z-founder-invited',
      email: 'pending@techrida.test',
      displayName: 'Pending Founder',
      status: 'invited',
    });
    store.roles.set(INVITED_FOUNDER, ['founder']);
    joinEntity(INVITED_FOUNDER);

    let caught: unknown;
    try {
      await asAdmin(['admin.roles.write'], () =>
        controller.setRoles(FOUNDER_ONE, { roles: ['management'] }),
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ConflictException);
    expect((caught as ConflictException).getResponse()).toEqual({
      code: 'last_founder',
      message:
        'Kiran Thapa is the only Founder of Techrida Nepal. Make someone else a Founder there first.',
    });
    expect(zitadel.grants.has('z-founder-1')).toBe(false);
    expect(store.roles.get(FOUNDER_ONE)).toEqual(['founder']);
  });

  it('allows removing Founder once another active Founder exists', async () => {
    store.users.push({
      id: FOUNDER_TWO,
      tenantId: TENANT,
      idpOrgId: STAFF_IDP,
      zitadelUserId: 'z-founder-2',
      email: 'sita@techrida.test',
      displayName: 'Sita Shrestha',
      status: 'active',
    });
    store.roles.set(FOUNDER_TWO, ['founder']);
    joinEntity(FOUNDER_TWO);

    await asAdmin(['admin.roles.write'], () =>
      controller.setRoles(FOUNDER_ONE, { roles: ['management'] }),
    );
    expect(zitadel.grants.get('z-founder-1')).toEqual(['management']);
    expect(store.roles.get(FOUNDER_ONE)).toEqual(['management']);
    expect(authz.invalidations).toBe(1);
  });

  it.each([null, '   '])(
    'names a Founder without a display name (%j) "This person", never the email',
    async (displayName) => {
      store.users[0]!.displayName = displayName;
      let caught: unknown;
      try {
        await asAdmin(['admin.roles.write'], () =>
          controller.setRoles(FOUNDER_ONE, { roles: ['management'] }),
        );
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(ConflictException);
      const body = (caught as ConflictException).getResponse() as { message: string };
      expect(body.message).toBe(
        'This person is the only Founder of Techrida Nepal. Make someone else a Founder there first.',
      );
      expect(body.message).not.toContain('kiran@techrida.test');
    },
  );

  describe('per legal entity', () => {
    const ENTITY_B = '00000000-0000-4000-8000-0000000000bb';

    const addFounder = (id: string, status: 'active' | 'inactive' = 'active') => {
      store.users.push({
        id,
        tenantId: TENANT,
        idpOrgId: STAFF_IDP,
        zitadelUserId: `z-${id}`,
        email: `${id}@techrida.test`,
        displayName: 'Sita Shrestha',
        status,
      });
      store.roles.set(id, ['founder']);
    };

    const removeFounder = async (): Promise<unknown> => {
      try {
        await asAdmin(['admin.roles.write'], () =>
          controller.setRoles(FOUNDER_ONE, { roles: ['management'] }),
        );
        return null;
      } catch (error) {
        return error;
      }
    };

    beforeEach(() => {
      store.entityNames.set(ENTITY_B, 'Techrida India');
      // Kiran is a Founder in both entities; Sita only in the default one.
      joinEntity(FOUNDER_ONE, ENTITY_B);
      addFounder(FOUNDER_TWO);
      joinEntity(FOUNDER_TWO);
    });

    it("refuses removing entity B's only Founder while entity A still has Founders", async () => {
      const caught = await removeFounder();
      expect(caught).toBeInstanceOf(ConflictException);
      expect((caught as ConflictException).getResponse()).toEqual({
        code: 'last_founder',
        message:
          'Kiran Thapa is the only Founder of Techrida India. Make someone else a Founder there first.',
      });
      expect(zitadel.grants.has('z-founder-1')).toBe(false);
      expect(store.roles.get(FOUNDER_ONE)).toEqual(['founder']);
    });

    it('does not count a Founder whose entity B membership narrows role_keys to other roles', async () => {
      joinEntity(FOUNDER_TWO, ENTITY_B, ['sales']);
      expect(await removeFounder()).toBeInstanceOf(ConflictException);
      expect(store.roles.get(FOUNDER_ONE)).toEqual(['founder']);
    });

    it('does not count a deactivated Founder in entity B', async () => {
      addFounder(INVITED_FOUNDER, 'inactive');
      joinEntity(INVITED_FOUNDER, ENTITY_B);
      expect(await removeFounder()).toBeInstanceOf(ConflictException);
    });

    it('allows the removal once entity B has another effective Founder', async () => {
      // role_keys that include founder count the same as NULL (every role).
      joinEntity(FOUNDER_TWO, ENTITY_B, ['founder', 'sales']);
      expect(await removeFounder()).toBeNull();
      expect(zitadel.grants.get('z-founder-1')).toEqual(['management']);
      expect(store.roles.get(FOUNDER_ONE)).toEqual(['management']);
    });
  });
});

describe('POST /v1/admin/users/:id/deactivate, /reactivate, /lock and /unlock (F1-Q5, F1-Q4)', () => {
  const STAFF = '00000000-0000-4000-9000-000000000201';
  const SECOND_FOUNDER = '00000000-0000-4000-9000-000000000202';

  const addUser = (
    id: string,
    over: Partial<{
      status: 'active' | 'invited' | 'inactive';
      idpOrgId: string;
      roles: RoleKey[];
      lockReason: 'failed_sign_ins' | 'admin';
    }> = {},
  ) => {
    store.users.push({
      id,
      tenantId: TENANT,
      idpOrgId: over.idpOrgId ?? STAFF_IDP,
      zitadelUserId: `z-${id}`,
      email: `${id.slice(-3)}@techrida.test`,
      displayName: 'Mina Gurung',
      status: over.status ?? 'active',
      lockReason: over.lockReason ?? null,
      lockedUntil:
        over.lockReason === 'failed_sign_ins' ? new Date(Date.now() + 60_000).toISOString() : null,
    });
    store.roles.set(id, over.roles ?? ['sales']);
    store.memberships.push({
      tenantId: TENANT,
      userId: id,
      organizationId: STAFF_ORG,
      isDefault: true,
      roleKeys: null,
      departmentId: null,
    });
    zitadel.users.set(`z-${id}`, {
      id: `z-${id}`,
      orgId: STAFF_ZORG,
      email: null,
      displayName: 'Mina Gurung',
      status: over.status ?? 'active',
      locked: over.lockReason !== undefined,
      createdAt: null,
    });
  };

  const act = (
    action: 'deactivate' | 'reactivate' | 'lock' | 'unlock',
    id: string,
    permissions: Permission[] = ['admin.roles.write'],
  ) =>
    asAdmin(permissions, () => controller[action](id)).then(
      () => null,
      (e: unknown) => e,
    );

  it('deactivates an active user in ZITADEL first, then the mirror, bumping authz and invalidating the cache', async () => {
    addUser(STAFF);
    const record = vi.spyOn(audit, 'record');

    expect(await act('deactivate', STAFF)).toBeNull();

    expect(zitadel.statusCalls).toEqual([`deactivate:z-${STAFF}`]);
    expect(store.users.find((u) => u.id === STAFF)?.status).toBe('inactive');
    expect(store.authzBumps).toBe(1);
    expect(authz.invalidations).toBe(1);
    expect(record).toHaveBeenCalledWith(expect.anything(), {
      action: 'users.deactivated',
      entityType: 'users',
      entityId: STAFF,
      before: { status: 'active', lockReason: null },
      after: { status: 'inactive', lockReason: null },
    });
  });

  it('locks an active user in ZITADEL and stores an admin lock with no end, audited', async () => {
    addUser(STAFF);
    const record = vi.spyOn(audit, 'record');

    expect(await act('lock', STAFF)).toBeNull();

    expect(zitadel.statusCalls).toEqual([`lock:z-${STAFF}`]);
    expect(store.users.find((u) => u.id === STAFF)).toMatchObject({
      status: 'inactive',
      lockReason: 'admin',
      lockedUntil: null,
    });
    expect(store.authzBumps).toBe(1);
    expect(authz.invalidations).toBe(1);
    expect(record).toHaveBeenCalledWith(expect.anything(), {
      action: 'users.locked',
      entityType: 'users',
      entityId: STAFF,
      before: { status: 'active', lockReason: null },
      after: { status: 'inactive', lockReason: 'admin' },
    });
  });

  it('calls ZITADEL outside any transaction before writing the admin lock, and compensates on DB failure (FU1)', async () => {
    addUser(STAFF);
    let openWhenZitadelLocked: number | undefined;
    let storedWhenZitadelLocked: unknown;
    const lockUser = zitadel.lockUser.bind(zitadel);
    vi.spyOn(zitadel, 'lockUser').mockImplementation((id: string) => {
      openWhenZitadelLocked = db.open;
      storedWhenZitadelLocked = store.users.find((u) => u.id === STAFF)?.lockReason;
      return lockUser(id);
    });

    expect(await act('lock', STAFF)).toBeNull();
    expect(openWhenZitadelLocked).toBe(0);
    expect(storedWhenZitadelLocked).toBeNull();
    expect(store.users.find((u) => u.id === STAFF)?.lockReason).toBe('admin');

    // When Phase (C) fails after ZITADEL unlocked, compensation locks ZITADEL again.
    vi.spyOn(store, 'updateUser').mockRejectedValueOnce(new Error('db write failed'));
    const error = await act('unlock', STAFF);
    expect(error).toBeInstanceOf(Error);
    expect(zitadel.statusCalls).toEqual([
      `lock:z-${STAFF}`,
      `unlock:z-${STAFF}`,
      `lock:z-${STAFF}`,
    ]);
    expect(zitadel.users.get(`z-${STAFF}`)).toMatchObject({ status: 'inactive', locked: true });
  });

  it.each(['admin', 'failed_sign_ins'] as const)(
    'unlocks a user under a %s lock before it ends, clearing the lock, audited',
    async (reason) => {
      addUser(STAFF, { status: 'inactive', lockReason: reason });
      const record = vi.spyOn(audit, 'record');

      expect(await act('unlock', STAFF)).toBeNull();

      expect(zitadel.statusCalls).toEqual([`unlock:z-${STAFF}`]);
      expect(store.users.find((u) => u.id === STAFF)).toMatchObject({
        status: 'active',
        lockReason: null,
        lockedUntil: null,
      });
      expect(record).toHaveBeenCalledWith(expect.anything(), {
        action: 'users.unlocked',
        entityType: 'users',
        entityId: STAFF,
        before: { status: 'inactive', lockReason: reason },
        after: { status: 'active', lockReason: null },
      });
    },
  );

  it('skips lockUser when locking a failed_sign_ins user ZITADEL already holds locked (real v4.20.1 refuses re-locking, FU1 item 3)', async () => {
    addUser(STAFF, { status: 'inactive', lockReason: 'failed_sign_ins' });
    const record = vi.spyOn(audit, 'record');

    expect(await act('lock', STAFF)).toBeNull();

    // ZITADEL already held them locked, so lockUser was skipped (otherwise v4.20.1 throws 400 -> 409).
    expect(zitadel.statusCalls).toEqual([]);
    expect(zitadel.users.get(`z-${STAFF}`)).toMatchObject({ status: 'inactive', locked: true });
    expect(store.users.find((u) => u.id === STAFF)).toMatchObject({
      status: 'inactive',
      lockReason: 'admin',
      lockedUntil: null,
    });
    expect(record).toHaveBeenCalledWith(expect.anything(), {
      action: 'users.locked',
      entityType: 'users',
      entityId: STAFF,
      before: { status: 'inactive', lockReason: 'failed_sign_ins' },
      after: { status: 'inactive', lockReason: 'admin' },
    });
  });

  it('calls lockUser when locking a failed_sign_ins user ZITADEL already unlocked (lock-expiry race) and survives a stale sync (FU1 item 3)', async () => {
    addUser(STAFF, { status: 'inactive', lockReason: 'failed_sign_ins' });
    // Simulate a lock-expiry worker having already unlocked the user in ZITADEL before the admin clicks Lock.
    Object.assign(zitadel.users.get(`z-${STAFF}`)!, { status: 'active', locked: false });
    const staleUnlocked = { ...zitadel.users.get(`z-${STAFF}`)! };
    const record = vi.spyOn(audit, 'record');

    expect(await act('lock', STAFF)).toBeNull();

    expect(zitadel.statusCalls).toEqual([`lock:z-${STAFF}`]);
    expect(zitadel.users.get(`z-${STAFF}`)).toMatchObject({ status: 'inactive', locked: true });
    expect(store.users.find((u) => u.id === STAFF)).toMatchObject({
      status: 'inactive',
      lockReason: 'admin',
      lockedUntil: null,
    });
    expect(record).toHaveBeenCalledWith(expect.anything(), {
      action: 'users.locked',
      entityType: 'users',
      entityId: STAFF,
      before: { status: 'inactive', lockReason: 'failed_sign_ins' },
      after: { status: 'inactive', lockReason: 'admin' },
    });

    // A UserMirror.syncUser pass whose first read saw ZITADEL unlocked re-reads behind the lock and sees it locked:
    // the admin lock is NOT wiped.
    const mirror = new UserMirror(
      fakeDb(),
      store,
      zitadel as unknown as ZitadelAdminClient,
      fakeQueue() as unknown as Queue<UsersSyncData>,
    );
    const realGetUser = zitadel.getUser.bind(zitadel);
    let first = true;
    vi.spyOn(zitadel, 'getUser').mockImplementation((id: string) => {
      if (!first) return realGetUser(id);
      first = false;
      return Promise.resolve(staleUnlocked);
    });
    await mirror.syncUser(`z-${STAFF}`);
    expect(store.users.find((u) => u.id === STAFF)).toMatchObject({
      status: 'inactive',
      lockReason: 'admin',
      lockedUntil: null,
    });
  });

  it('fails closed (no unlock compensation) when the DB write fails after re-locking a failed_sign_ins user (round 3)', async () => {
    addUser(STAFF, { status: 'inactive', lockReason: 'failed_sign_ins' });
    Object.assign(zitadel.users.get(`z-${STAFF}`)!, { status: 'active', locked: false });
    vi.spyOn(store, 'updateUser').mockRejectedValueOnce(new Error('db write failed'));

    const error = await act('lock', STAFF);

    expect(error).toBeInstanceOf(Error);
    expect(zitadel.statusCalls[0]).toBe(`lock:z-${STAFF}`);
    expect(zitadel.statusCalls.some((c) => c.startsWith('unlock'))).toBe(false);
    expect(zitadel.users.get(`z-${STAFF}`)).toMatchObject({ status: 'inactive' });
    // The person is denied in BOS: closed and flagged for an admin to resolve.
    const row = store.users.find((u) => u.id === STAFF)!;
    expect(row.identityReviewRequired).toBe(true);
    expect(row.status).not.toBe('active');
  });

  it('refuses to lock someone already under an admin lock', async () => {
    addUser(STAFF, { status: 'inactive', lockReason: 'admin' });

    const error = await act('lock', STAFF);

    expect((error as ConflictException).getResponse()).toMatchObject({ code: 'wrong_status' });
    expect(zitadel.statusCalls).toEqual([]);
  });

  it.each(['admin', 'failed_sign_ins'] as const)(
    'deactivates a person under a %s lock: unlock, then deactivate in ZITADEL, lock cleared, audited (P2-2)',
    async (reason) => {
      addUser(STAFF, { status: 'inactive', lockReason: reason });
      const record = vi.spyOn(audit, 'record');

      expect(await act('deactivate', STAFF)).toBeNull();

      expect(zitadel.statusCalls).toEqual([`unlock:z-${STAFF}`, `deactivate:z-${STAFF}`]);
      expect(zitadel.users.get(`z-${STAFF}`)).toMatchObject({ status: 'inactive', locked: false });
      expect(store.users.find((u) => u.id === STAFF)).toMatchObject({
        status: 'inactive',
        lockReason: null,
        lockedUntil: null,
      });
      expect(record).toHaveBeenCalledWith(expect.anything(), {
        action: 'users.deactivated',
        entityType: 'users',
        entityId: STAFF,
        before: { status: 'inactive', lockReason: reason },
        after: { status: 'inactive', lockReason: null },
      });
    },
  );

  it('never reactivates a deactivated-from-locked user when phase C fails even if lock and re-deactivate would fail (FU1 round-2 B)', async () => {
    addUser(STAFF, { status: 'inactive', lockReason: 'admin' });
    vi.spyOn(store, 'updateUser').mockRejectedValueOnce(new Error('db write failed'));
    const warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const realDeactivate = zitadel.deactivateUser.bind(zitadel);
    let deactivateCalls = 0;
    vi.spyOn(zitadel, 'deactivateUser').mockImplementation((id: string) => {
      deactivateCalls += 1;
      if (deactivateCalls === 1) return realDeactivate(id);
      return Promise.reject(new Error('re-deactivate boom'));
    });
    const lockSpy = vi.spyOn(zitadel, 'lockUser').mockRejectedValue(new Error('relock boom'));

    const error = await act('deactivate', STAFF);

    expect(error).toBeInstanceOf(Error);
    // Must NEVER call reactivateUser (which could leave ZITADEL active when lock + re-deactivate both fail).
    expect(zitadel.statusCalls).toEqual([`unlock:z-${STAFF}`, `deactivate:z-${STAFF}`]);
    expect(lockSpy).toHaveBeenCalled(); // the one best-effort close; it failed, the row is the safe state
    expect(zitadel.users.get(`z-${STAFF}`)).toMatchObject({ status: 'inactive', locked: false });
    expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining('reactivate'));
    const row = store.users.find((u) => u.id === STAFF)!;
    expect(row.identityReviewRequired).toBe(true);
    expect(row.status).not.toBe('active');
  });

  it('retries lockUser when deactivate fails after unlock in phase B so ZITADEL never ends active (FU1 round-2 B)', async () => {
    addUser(STAFF, { status: 'inactive', lockReason: 'admin' });
    vi.spyOn(zitadel, 'deactivateUser').mockRejectedValueOnce(new Error('ZITADEL 503'));
    const realLock = zitadel.lockUser.bind(zitadel);
    let lockAttempts = 0;
    vi.spyOn(zitadel, 'lockUser').mockImplementation((id: string) => {
      lockAttempts += 1;
      if (lockAttempts < 3) return Promise.reject(new Error('transient relock 503'));
      return realLock(id);
    });

    const error = await act('deactivate', STAFF);

    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect(lockAttempts).toBe(3);
    expect(zitadel.statusCalls).toEqual([`unlock:z-${STAFF}`, `lock:z-${STAFF}`]);
    expect(zitadel.users.get(`z-${STAFF}`)).toMatchObject({ status: 'inactive', locked: true });
    expect(store.users.find((u) => u.id === STAFF)).toMatchObject({
      status: 'inactive',
      lockReason: 'admin',
    });
  });

  it('closes ZITADEL again when sync copies an unlock before phase C fails via a revoked grant, falling back to deactivate if lock is refused (FU1 round-2 A)', async () => {
    // 1. Happy relock: unlock succeeds in phase B -> sync writes active/no lock -> actor's grant revoked -> phase C 403 -> lockUser closes ZITADEL.
    addUser(STAFF, { status: 'inactive', lockReason: 'admin' });
    const realUnlock = zitadel.unlockUser.bind(zitadel);
    vi.spyOn(zitadel, 'unlockUser').mockImplementationOnce(async (id: string) => {
      await realUnlock(id);
      const row = store.users.find((u) => u.id === STAFF)!;
      await store.updateUser({} as never, STAFF, {
        email: row.email,
        displayName: row.displayName,
        status: 'active',
        lock: null,
      });
      liveAdminGrants = new Map();
    });

    const firstError = await act('unlock', STAFF);

    expect(firstError).toBeInstanceOf(ForbiddenException);
    expect(zitadel.statusCalls).toEqual([`unlock:z-${STAFF}`, `lock:z-${STAFF}`]);
    expect(zitadel.users.get(`z-${STAFF}`)).toMatchObject({ status: 'inactive', locked: true });

    // 2. Refused relock -> falls back to deactivateUser to fail closed.
    zitadel.statusCalls = [];
    vi.spyOn(zitadel, 'unlockUser').mockImplementationOnce(async (id: string) => {
      await realUnlock(id);
      const row = store.users.find((u) => u.id === STAFF)!;
      await store.updateUser({} as never, STAFF, {
        email: row.email,
        displayName: row.displayName,
        status: 'active',
        lock: null,
      });
      liveAdminGrants = new Map();
    });
    vi.spyOn(zitadel, 'lockUser').mockRejectedValueOnce(
      new ZitadelHttpError('/LockUser', 400, 'failed_precondition'),
    );
    // An admin resolved the flag the first failure set; reset the row back to locked so phase A plans an unlock.
    await store.clearIdentityReview({} as never, STAFF);
    const row = store.users.find((u) => u.id === STAFF)!;
    await store.updateUser({} as never, STAFF, {
      email: row.email,
      displayName: row.displayName,
      status: 'inactive',
      lock: { reason: 'admin', lockedAt: new Date(), until: null },
    });

    const secondError = await act('unlock', STAFF);

    expect(secondError).toBeInstanceOf(ForbiddenException);
    expect(zitadel.statusCalls).toEqual([`unlock:z-${STAFF}`, `deactivate:z-${STAFF}`]);
    expect(zitadel.users.get(`z-${STAFF}`)).toMatchObject({ status: 'inactive', locked: false });
  });

  it('deactivates ZITADEL again when sync copies a reactivate before phase C fails via a revoked grant (FU1 round-2 A)', async () => {
    addUser(STAFF, { status: 'inactive' });
    const realReactivate = zitadel.reactivateUser.bind(zitadel);
    vi.spyOn(zitadel, 'reactivateUser').mockImplementationOnce(async (id: string) => {
      await realReactivate(id);
      const row = store.users.find((u) => u.id === STAFF)!;
      await store.updateUser({} as never, STAFF, {
        email: row.email,
        displayName: row.displayName,
        status: 'active',
      });
      liveAdminGrants = new Map();
    });

    const error = await act('reactivate', STAFF);

    expect(error).toBeInstanceOf(ForbiddenException);
    expect(zitadel.statusCalls).toEqual([`reactivate:z-${STAFF}`, `deactivate:z-${STAFF}`]);
    expect(zitadel.users.get(`z-${STAFF}`)).toMatchObject({ status: 'inactive', locked: false });
  });

  it('strips nothing in ZITADEL when sync copies setRoles before phase C fails via a revoked grant; the person is denied (round 3)', async () => {
    addUser(STAFF, { roles: ['accountant'] });
    const realSetGrants = zitadel.setGrants.bind(zitadel);
    vi.spyOn(zitadel, 'setGrants').mockImplementationOnce(async (id, orgId, roles) => {
      await realSetGrants(id, orgId, roles);
      await store.replaceRoles(
        {} as never,
        { tenantId: TENANT, organizationId: STAFF_ORG },
        STAFF,
        [...roles],
      );
      liveAdminGrants = new Map();
    });

    const error = await asAdmin(['admin.roles.write'], () =>
      controller.setRoles(STAFF, { roles: ['accountant', 'founder'] }),
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ForbiddenException);
    // No role is stripped or re-granted: ZITADEL keeps what the set wrote, BOS closes and flags the person.
    expect(zitadel.grants.get(`z-${STAFF}`)).toEqual(['accountant', 'founder']);
    const row = store.users.find((u) => u.id === STAFF)!;
    expect(row.identityReviewRequired).toBe(true);
    expect(row.status).not.toBe('active');
  });

  it('does not reactivate ZITADEL when admin A deactivates while admin B committed a lock (FU1 item 1)', async () => {
    addUser(STAFF);
    const deactivateUser = zitadel.deactivateUser.bind(zitadel);
    vi.spyOn(zitadel, 'deactivateUser').mockImplementationOnce(async (id: string) => {
      // Admin B locked the person in both ZITADEL and DB before A's deactivateUser landed (v4.20.1 accepts
      // deactivateUser on a locked user!).
      await zitadel.lockUser(id);
      const row = store.users.find((u) => u.id === STAFF)!;
      await store.updateUser({} as never, STAFF, {
        email: row.email,
        displayName: row.displayName,
        status: 'inactive',
        lock: { reason: 'admin', lockedAt: new Date(), until: null },
      });
      await deactivateUser(id);
    });

    const error = await act('deactivate', STAFF);

    expect(error).toBeInstanceOf(ConflictException);
    expect((error as ConflictException).getResponse()).toMatchObject({ code: 'conflict' });
    // Must NOT call reactivateUser — person stays shut out in ZITADEL and DB!
    expect(zitadel.statusCalls).toEqual([`lock:z-${STAFF}`, `deactivate:z-${STAFF}`]);
    expect(zitadel.users.get(`z-${STAFF}`)).toMatchObject({ status: 'inactive', locked: false });
    expect(store.users.find((u) => u.id === STAFF)).toMatchObject({
      status: 'inactive',
      lockReason: 'admin',
    });
  });

  it('upgrades a row a sync turned into failed_sign_ins during phase B into an admin lock instead of 409 + undo (FU1 item 4)', async () => {
    addUser(STAFF);
    const record = vi.spyOn(audit, 'record');
    const lockUser = zitadel.lockUser.bind(zitadel);
    vi.spyOn(zitadel, 'lockUser').mockImplementationOnce(async (id: string) => {
      await lockUser(id);
      const row = store.users.find((u) => u.id === STAFF)!;
      await store.updateUser({} as never, STAFF, {
        email: row.email,
        displayName: row.displayName,
        status: 'inactive',
        lock: {
          reason: 'failed_sign_ins',
          lockedAt: new Date(),
          until: new Date(Date.now() + 60_000),
        },
      });
    });

    expect(await act('lock', STAFF)).toBeNull();
    expect(zitadel.statusCalls).toEqual([`lock:z-${STAFF}`]);
    expect(store.users.find((u) => u.id === STAFF)).toMatchObject({
      status: 'inactive',
      lockReason: 'admin',
      lockedUntil: null,
    });
    expect(record).toHaveBeenCalledWith(expect.anything(), {
      action: 'users.locked',
      entityType: 'users',
      entityId: STAFF,
      before: { status: 'inactive', lockReason: 'failed_sign_ins' },
      after: { status: 'inactive', lockReason: 'admin' },
    });
  });

  it('returns success without undoing and still writes an audit row when a concurrent write already achieved the same status outcome (FU1 item 4)', async () => {
    addUser(STAFF);
    const record = vi.spyOn(audit, 'record');
    const lockUser = zitadel.lockUser.bind(zitadel);
    vi.spyOn(zitadel, 'lockUser').mockImplementationOnce(async (id: string) => {
      await lockUser(id);
      const row = store.users.find((u) => u.id === STAFF)!;
      await store.updateUser({} as never, STAFF, {
        email: row.email,
        displayName: row.displayName,
        status: 'inactive',
        lock: { reason: 'admin', lockedAt: new Date(), until: null },
      });
    });

    expect(await act('lock', STAFF)).toBeNull();
    // Only the original lock call; no unlock compensation.
    expect(zitadel.statusCalls).toEqual([`lock:z-${STAFF}`]);
    expect(store.users.find((u) => u.id === STAFF)).toMatchObject({
      status: 'inactive',
      lockReason: 'admin',
    });
    expect(record).toHaveBeenCalledWith(expect.anything(), {
      action: 'users.locked',
      entityType: 'users',
      entityId: STAFF,
      before: { status: 'inactive', lockReason: 'admin' },
      after: { status: 'inactive', lockReason: 'admin' },
    });
  });

  it('locks a person again in ZITADEL when deactivating them fails after the unlock, and changes nothing here', async () => {
    addUser(STAFF, { status: 'inactive', lockReason: 'admin' });
    const deactivateUser = vi
      .spyOn(zitadel, 'deactivateUser')
      .mockRejectedValue(new ZitadelHttpError('/DeactivateUser', 400, 'precondition'));

    const error = await act('deactivate', STAFF);

    expect((error as ConflictException).getResponse()).toMatchObject({ code: 'identity_refused' });
    expect(deactivateUser).toHaveBeenCalledOnce();
    expect(zitadel.statusCalls).toEqual([`unlock:z-${STAFF}`, `lock:z-${STAFF}`]);
    expect(zitadel.users.get(`z-${STAFF}`)).toMatchObject({ status: 'inactive', locked: true });
    expect(store.users.find((u) => u.id === STAFF)).toMatchObject({ lockReason: 'admin' });
  });

  it('refuses to reactivate a locked user (ZITADEL holds them LOCKED, not INACTIVE): unlock is the action', async () => {
    addUser(STAFF, { status: 'inactive', lockReason: 'failed_sign_ins' });

    const error = await act('reactivate', STAFF);

    expect(error).toBeInstanceOf(ConflictException);
    expect((error as ConflictException).getResponse()).toMatchObject({ code: 'wrong_status' });
    expect(zitadel.statusCalls).toEqual([]);
  });

  it('refuses to lock yourself or the only Founder of an entity', async () => {
    store.users.push({
      id: ADMIN,
      tenantId: TENANT,
      idpOrgId: STAFF_IDP,
      zitadelUserId: 'zitadel-admin',
      email: 'admin@techrida.test',
      displayName: 'Admin',
      status: 'active',
    });
    addUser(STAFF, { roles: ['founder'] });

    const own = await act('lock', ADMIN);
    const founder = await act('lock', STAFF);

    expect((own as ConflictException).getResponse()).toMatchObject({ code: 'own_account' });
    expect((founder as ConflictException).getResponse()).toEqual({
      code: 'last_founder',
      message:
        'Mina Gurung is the only Founder of Techrida Nepal. Make someone else a Founder there before you lock them.',
    });
    expect(zitadel.statusCalls).toEqual([]);
  });

  it('does not let a sync read before the lock undo it', async () => {
    addUser(STAFF);
    const stale = { ...zitadel.users.get(`z-${STAFF}`)! };
    expect(await act('lock', STAFF)).toBeNull();
    // A reconcile that listed the user before the lock now applies what it read; the re-read behind the row lock wins.
    const mirror = new UserMirror(
      fakeDb(),
      store,
      zitadel as unknown as ZitadelAdminClient,
      fakeQueue() as unknown as Queue<UsersSyncData>,
    );
    const real = zitadel.getUser.bind(zitadel);
    let first = true;
    vi.spyOn(zitadel, 'getUser').mockImplementation((id: string) => {
      if (!first) return real(id);
      first = false;
      return Promise.resolve(stale);
    });

    await mirror.syncUser(`z-${STAFF}`);

    expect(store.users.find((u) => u.id === STAFF)).toMatchObject({
      status: 'inactive',
      lockReason: 'admin',
    });
  });

  it('reactivates a deactivated user and audits it', async () => {
    addUser(STAFF, { status: 'inactive' });
    const record = vi.spyOn(audit, 'record');

    expect(await act('reactivate', STAFF)).toBeNull();

    expect(zitadel.statusCalls).toEqual([`reactivate:z-${STAFF}`]);
    expect(store.users.find((u) => u.id === STAFF)?.status).toBe('active');
    expect(record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'users.reactivated', entityId: STAFF }),
    );
  });

  it("refuses the caller's own account, compared by app user id, before ZITADEL", async () => {
    // The admin's own row in the service's store carries the app id the principal names.
    store.users.push({
      id: ADMIN,
      tenantId: TENANT,
      idpOrgId: STAFF_IDP,
      zitadelUserId: 'zitadel-admin',
      email: 'admin@techrida.test',
      displayName: 'Admin',
      status: 'active',
    });

    const error = await act('deactivate', ADMIN);

    expect(error).toBeInstanceOf(ConflictException);
    expect((error as ConflictException).getResponse()).toMatchObject({ code: 'own_account' });
    expect(zitadel.statusCalls).toEqual([]);
  });

  it('refuses the only Founder of an entity, and allows it once another Founder exists', async () => {
    addUser(STAFF, { roles: ['founder'] });

    const refused = await act('deactivate', STAFF);
    expect(refused).toBeInstanceOf(ConflictException);
    expect((refused as ConflictException).getResponse()).toEqual({
      code: 'last_founder',
      message:
        'Mina Gurung is the only Founder of Techrida Nepal. Make someone else a Founder there before you deactivate them.',
    });
    expect(zitadel.statusCalls).toEqual([]);
    expect(store.users.find((u) => u.id === STAFF)?.status).toBe('active');

    addUser(SECOND_FOUNDER, { roles: ['founder'] });
    expect(await act('deactivate', STAFF)).toBeNull();
    expect(store.users.find((u) => u.id === STAFF)?.status).toBe('inactive');
  });

  it.each([
    ['deactivate', 'invited'],
    ['deactivate', 'inactive'],
    ['reactivate', 'active'],
    ['reactivate', 'invited'],
    ['lock', 'invited'],
    ['lock', 'inactive'],
    ['unlock', 'active'],
    ['unlock', 'inactive'],
  ] as const)('refuses to %s a user who is %s (and not locked)', async (action, status) => {
    addUser(STAFF, { status });
    const error = await act(action, STAFF);
    expect(error).toBeInstanceOf(ConflictException);
    expect((error as ConflictException).getResponse()).toMatchObject({ code: 'wrong_status' });
    expect(zitadel.statusCalls).toEqual([]);
  });

  it('answers 404 for a portal user and for an unknown id', async () => {
    addUser(STAFF, { idpOrgId: CUST_IDP });
    expect(await act('deactivate', STAFF)).toBeInstanceOf(NotFoundException);
    expect(await act('deactivate', SECOND_FOUNDER)).toBeInstanceOf(NotFoundException);
    expect(zitadel.statusCalls).toEqual([]);
  });

  it('refuses 403 a caller whose live grant is gone, before ZITADEL', async () => {
    addUser(STAFF);
    liveStore.roles.set(ADMIN, ['sales']);
    const error = await asAdmin(['admin.roles.write'], () => {
      // The token still says admin.roles.write; the role cache no longer does.
      liveAdminGrants = new Map();
      return controller.deactivate(STAFF);
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ForbiddenException);
    expect(zitadel.statusCalls).toEqual([]);
  });

  it('refuses 403 a grant narrower than company scope', async () => {
    addUser(STAFF);
    const error = await runWithRequestStore('corr-12345678', () => {
      bindIdentity({
        tenantId: TENANT,
        organizationId: STAFF_ORG,
        orgKind: 'staff',
        partyId: null,
        idpOrgId: STAFF_IDP,
        userId: 'zitadel-admin',
        roles: [],
        departmentId: null,
        tokenExp: 1_900_000_000,
      });
      bindPrincipal({
        userId: ADMIN,
        zitadelUserId: 'zitadel-admin',
        tenantId: TENANT,
        organizationId: STAFF_ORG,
        orgKind: 'staff',
        partyId: null,
        idpOrgId: STAFF_IDP,
        roles: [],
        departmentId: null,
        status: 'active',
        grants: new Map([['admin.roles.write', 'own']]),
      });
      return controller.deactivate(STAFF);
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ForbiddenException);
    expect(zitadel.statusCalls).toEqual([]);
  });

  it('turns a ZITADEL refusal into 409 changing nothing, and an ambiguous outage into 503 that closes and flags the person (round 3)', async () => {
    addUser(STAFF);
    zitadel.failNextStatusCall = new ZitadelHttpError('/DeactivateUser', 400, 'precondition');
    const refused = await act('deactivate', STAFF);
    expect(refused).toBeInstanceOf(ConflictException);
    expect((refused as ConflictException).getResponse()).toMatchObject({
      code: 'identity_refused',
    });
    // A definite refusal on the first call applied nothing: the row is untouched.
    expect(store.users.find((u) => u.id === STAFF)).toMatchObject({ status: 'active' });
    expect(store.users.find((u) => u.id === STAFF)?.identityReviewRequired).toBeFalsy();

    // A timeout leaves ZITADEL's state unknown: the row is closed and flagged, never left open.
    zitadel.failNextStatusCall = new Error('socket hang up');
    expect(await act('deactivate', STAFF)).toBeInstanceOf(ServiceUnavailableException);
    const row = store.users.find((u) => u.id === STAFF)!;
    expect(row.status).not.toBe('active');
    expect(row.identityReviewRequired).toBe(true);
  });

  it('lists a locked person with why and until when, as the directory needs to offer Unlock (F1-Q4)', async () => {
    addUser(STAFF, { status: 'inactive', lockReason: 'failed_sign_ins' });
    addUser(SECOND_FOUNDER, { status: 'inactive', lockReason: 'admin' });

    const page = await asAdmin(['admin.users.read'], () =>
      controller.list({}, { setHeader: vi.fn() }),
    );

    const until = store.users.find((u) => u.id === STAFF)?.lockedUntil;
    expect(until).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(page.items.find((u) => u.id === STAFF)).toMatchObject({
      status: 'inactive',
      lockReason: 'failed_sign_ins',
      lockedUntil: until,
    });
    expect(page.items.find((u) => u.id === SECOND_FOUNDER)).toMatchObject({
      lockReason: 'admin',
      lockedUntil: null,
    });
  });

  it.each(['lock', 'unlock'] as const)(
    'answers 404 to %s for a portal user and an unknown id, before ZITADEL',
    async (action) => {
      addUser(STAFF, { idpOrgId: CUST_IDP, status: action === 'lock' ? 'active' : 'inactive' });
      expect(await act(action, STAFF)).toBeInstanceOf(NotFoundException);
      expect(await act(action, SECOND_FOUNDER)).toBeInstanceOf(NotFoundException);
      expect(zitadel.statusCalls).toEqual([]);
    },
  );

  it.each(['lock', 'unlock'] as const)(
    'refuses 403 to %s without a company-wide admin.roles.write, before ZITADEL',
    async (action) => {
      addUser(STAFF, action === 'lock' ? {} : { status: 'inactive', lockReason: 'admin' });
      expect(await act(action, STAFF, ['admin.users.read'])).toBeInstanceOf(ForbiddenException);
      liveStore.roles.set(ADMIN, ['sales']);
      const stale = await asAdmin(['admin.roles.write'], () => {
        liveAdminGrants = new Map();
        return controller[action](STAFF);
      }).catch((e: unknown) => e);
      expect(stale).toBeInstanceOf(ForbiddenException);
      expect(zitadel.statusCalls).toEqual([]);
    },
  );

  it('reports canChangeStatus in the summary only for a company-wide grant', async () => {
    const yes = await asAdmin(['admin.users.read', 'admin.roles.write'], () =>
      controller.summary(),
    );
    expect(yes.canChangeStatus).toBe(true);
    const no = await asAdmin(['admin.users.read'], () => controller.summary());
    expect(no.canChangeStatus).toBe(false);
  });
});

describe('SqlUsersStore.emailOf', () => {
  let testDb: TestDatabase;
  let pool: Pool;
  let sqlStore: SqlUsersStore;
  const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

  beforeAll(async () => {
    // Unmigrated: only the columns emailOf reads, this test is about the query, not the migrations.
    testDb = await createTestDatabase({ migrated: false });
    pool = new Pool({ connectionString: testDb.adminUrl, max: 2 });
    await pool.query(
      `CREATE SCHEMA app;
       CREATE TABLE app.users (id uuid PRIMARY KEY, email text, status text NOT NULL);
       INSERT INTO app.users VALUES
         ('${id(1)}', 'active@techrida.test', 'active'),
         ('${id(2)}', 'gone@techrida.test', 'inactive'),
         ('${id(3)}', 'pending@techrida.test', 'invited')`,
    );
    sqlStore = new SqlUsersStore(drizzle({ client: pool }));
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    await testDb?.drop();
  });

  it('returns the address of an active user', async () => {
    expect(await sqlStore.emailOf(id(1))).toBe('active@techrida.test');
  });

  it('returns null for a deactivated user', async () => {
    expect(await sqlStore.emailOf(id(2))).toBeNull();
  });

  it('returns null for an invited user and for an unknown id', async () => {
    expect(await sqlStore.emailOf(id(3))).toBeNull();
    expect(await sqlStore.emailOf(id(99))).toBeNull();
  });
});

describe('SqlUsersStore against migration 0013 (ADR 0027: tenant-scoped users)', () => {
  let testDb: TestDatabase;
  let appPool: Pool;
  let db: Db;
  let sqlStore: SqlUsersStore;

  beforeAll(async () => {
    testDb = await createTestDatabase();
    appPool = new Pool({ connectionString: testDb.appUrl, max: 4 });
    appPool.on('error', () => undefined);
    db = drizzle({ client: appPool });
    sqlStore = new SqlUsersStore(db);
  }, 180_000);

  afterAll(async () => {
    await appPool?.end();
    await testDb?.drop();
  });

  it('upserts roles, memberships and authz_versions on the new keys, and userIdsWithRole honours role_keys', async () => {
    const tenantId = randomUUID();
    const entityId = randomUUID();
    const idpOrgId = randomUUID();
    const scope = { tenantId, organizationId: entityId };
    await withTx(db, scope, systemActor('test'), async (tx) => {
      await tx.insert(tenants).values({ id: tenantId });
      await tx.insert(organizations).values({
        id: entityId,
        tenantId,
        organizationId: entityId,
        code: 'TR',
        name: 'Techrida',
        legalName: 'Techrida Pvt. Ltd.',
        isDefault: true,
      });
      await tx.insert(idpOrgs).values({
        id: idpOrgId,
        tenantId,
        zitadelOrgId: `z-${tenantId}`,
        kind: 'staff',
        name: 'Techrida staff',
      });
    });
    expect(await sqlStore.defaultEntityOf(tenantId)).toBe(entityId);
    expect(await sqlStore.idpOrgByZitadelId(`z-${tenantId}`)).toEqual({
      idpOrgId,
      tenantId,
      zitadelOrgId: `z-${tenantId}`,
      kind: 'staff',
    });

    const fields = (z: string) => ({
      zitadelUserId: `${z}-${tenantId}`,
      idpOrgId,
      email: null,
      displayName: z,
      status: 'active' as const,
    });
    const ids = await withTx(db, scope, systemActor('test'), async (tx) => {
      const full = await sqlStore.insertUser(tx, scope, fields('full'));
      const salesOnly = await sqlStore.insertUser(tx, scope, fields('sales-only'));
      const outsider = await sqlStore.insertUser(tx, scope, fields('outsider'));
      expect(await sqlStore.ensureDefaultMembership(tx, tenantId, entityId, full)).toBe(true);
      expect(await sqlStore.ensureDefaultMembership(tx, tenantId, entityId, full)).toBe(false);
      await tx.insert(userEntities).values({
        tenantId,
        organizationId: entityId,
        userId: salesOnly,
        isDefault: true,
        roleKeys: ['sales'],
      });
      // A membership already exists, so the bootstrap rule leaves it (and its role_keys) alone.
      expect(await sqlStore.ensureDefaultMembership(tx, tenantId, entityId, salesOnly)).toBe(false);
      for (const run of [1, 2]) {
        await sqlStore.replaceRoles(tx, scope, full, ['finance']);
        await sqlStore.replaceRoles(tx, scope, salesOnly, ['finance', 'sales']);
        await sqlStore.replaceRoles(tx, scope, outsider, ['finance']);
        await sqlStore.bumpAuthzVersion(tx, scope);
        expect(run).toBeGreaterThan(0);
      }
      return { full, salesOnly, outsider };
    });

    expect(await sqlStore.rolesOf(db, tenantId, ids.salesOnly)).toEqual(['finance', 'sales']);
    expect(await sqlStore.membershipsOf(db, tenantId, ids.full)).toEqual([
      {
        organizationId: entityId,
        isDefault: true,
        roleKeys: null,
        departmentId: null,
        level: 'staff',
      },
    ]);
    // role_keys ['sales'] narrows the finance holder out; no membership at all keeps the outsider out.
    expect(await sqlStore.userIdsWithRole(scope, 'finance')).toEqual([ids.full]);
    expect(await sqlStore.userIdsWithRole(scope, 'sales')).toEqual([ids.salesOnly]);
    const version = await appPool.query<{ version: string }>(
      'SELECT version FROM app.authz_versions WHERE tenant_id = $1',
      [tenantId],
    );
    expect(version.rows).toEqual([{ version: '2' }]);
    // The other statements that name the new columns.
    expect(await sqlStore.staffIdpOrgOf(tenantId)).toMatchObject({ idpOrgId, kind: 'staff' });
    expect((await sqlStore.listStaffIdpOrgs()).map((o) => o.idpOrgId)).toContain(idpOrgId);
    const byZ = await sqlStore.findByZitadelId(db, `full-${tenantId}`, false);
    expect(byZ).toMatchObject({ id: ids.full, tenantId, idpOrgId, status: 'active' });
    expect(await sqlStore.findById(db, scope, ids.full)).toEqual(byZ);
    await withTx(db, scope, systemActor('test'), async (tx) => {
      expect(await sqlStore.findByZitadelId(tx, `full-${tenantId}`, true)).toEqual(byZ);
      await sqlStore.updateUser(tx, ids.outsider, {
        email: null,
        displayName: 'outsider',
        status: 'inactive',
      });
    });
    const org = (await sqlStore.idpOrgById(idpOrgId))!;
    expect((await sqlStore.notInactiveInIdpOrg(db, org)).map((u) => u.id).sort()).toEqual(
      [ids.full, ids.salesOnly].sort(),
    );
    const { rows: listed, total } = await sqlStore.list(scope, { limit: 10 });
    expect(listed).toHaveLength(3);
    expect(total).toBe(3);
    expect(listed[0]).not.toHaveProperty('organizationId');
    expect(listed[0]).not.toHaveProperty('departmentId');
  }, 60_000);

  it('counts effective Founders per legal entity, and the guard refuses orphaning one with real SQL', async () => {
    const tenantId = randomUUID();
    const entityA = randomUUID();
    const entityB = randomUUID();
    const idpOrgId = randomUUID();
    const scope = { tenantId, organizationId: entityA };
    const ids = await withTx(db, scope, systemActor('test'), async (tx) => {
      await tx.insert(tenants).values({ id: tenantId });
      await tx.insert(organizations).values([
        {
          id: entityA,
          tenantId,
          organizationId: entityA,
          code: 'A',
          name: 'Alpha Entity',
          legalName: 'Alpha Entity Pvt. Ltd.',
          isDefault: true,
        },
        {
          id: entityB,
          tenantId,
          organizationId: entityB,
          code: 'B',
          name: 'Beta Entity',
          legalName: 'Beta Entity Pvt. Ltd.',
        },
      ]);
      await tx.insert(idpOrgs).values({
        id: idpOrgId,
        tenantId,
        zitadelOrgId: `z-${tenantId}`,
        kind: 'staff',
        name: 'Staff',
      });
      const add = (z: string, status: 'active' | 'inactive' = 'active') =>
        sqlStore.insertUser(tx, scope, {
          zitadelUserId: `${z}-${tenantId}`,
          idpOrgId,
          email: `${z}@techrida.test`,
          displayName: z,
          status,
        });
      const kiran = await add('kiran');
      const sita = await add('sita');
      const gone = await add('gone', 'inactive');
      const loose = await add('loose');
      await tx.insert(userEntities).values([
        { tenantId, organizationId: entityA, userId: kiran, isDefault: true },
        { tenantId, organizationId: entityB, userId: kiran },
        { tenantId, organizationId: entityA, userId: sita, isDefault: true },
        // Narrowed to sales: not a Founder in B.
        { tenantId, organizationId: entityB, userId: sita, roleKeys: ['sales'] },
        { tenantId, organizationId: entityB, userId: gone, isDefault: true },
      ]);
      // `loose` holds founder with no membership: an effective Founder nowhere.
      for (const id of [kiran, sita, gone, loose]) {
        await sqlStore.replaceRoles(tx, scope, id, ['founder']);
      }
      return { kiran, sita, gone, loose };
    });

    expect(await sqlStore.effectiveRoleHolders(db, tenantId, 'founder')).toEqual(
      [
        { organizationId: entityA, entityName: 'Alpha Entity', userId: ids.kiran },
        { organizationId: entityA, entityName: 'Alpha Entity', userId: ids.sita },
        { organizationId: entityB, entityName: 'Beta Entity', userId: ids.kiran },
      ].sort((x, y) => x.entityName.localeCompare(y.entityName) || (x.userId < y.userId ? -1 : 1)),
    );

    const zitadel = new FakeZitadel();
    const mirror = new UserMirror(
      db,
      sqlStore,
      zitadel.asClient(),
      fakeQueue() as unknown as Queue<UsersSyncData>,
    );
    // Sita is a Founder in Alpha but not in Beta, so Kiran is Beta's only effective Founder.
    await expect(
      mirror.setRoles(scope, systemActor('test'), ids.kiran, ['management']),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(zitadel.setGrantsCalls).toEqual([]);
    expect(await sqlStore.rolesOf(db, tenantId, ids.kiran)).toEqual(['founder']);

    // Widening Sita's Beta membership to every role gives Beta another Founder; the removal goes through.
    await withTx(db, { tenantId, organizationId: entityB }, systemActor('test'), (tx) =>
      tx.execute(
        sql`UPDATE app.user_entities SET role_keys = NULL
            WHERE tenant_id = ${tenantId} AND organization_id = ${entityB} AND user_id = ${ids.sita}`,
      ),
    );
    await mirror.setRoles(scope, systemActor('test'), ids.kiran, ['management']);
    expect(await sqlStore.rolesOf(db, tenantId, ids.kiran)).toEqual(['management']);
  }, 60_000);

  const listRows = async (...args: Parameters<SqlUsersStore['list']>) =>
    (await sqlStore.list(...args)).rows;
  const totalOf = async (...args: Parameters<SqlUsersStore['list']>) =>
    (await sqlStore.list(...args)).total;

  async function directoryFixture(label: string) {
    const tenantId = randomUUID();
    const organizationId = randomUUID();
    const staff = randomUUID();
    const portal = randomUUID();
    const departmentId = randomUUID();
    const scope = { tenantId, organizationId };
    const ids = await withTx(db, scope, systemActor('directory-fixture'), async (tx) => {
      await tx.insert(tenants).values({ id: tenantId });
      await tx.insert(organizations).values({
        id: organizationId,
        tenantId,
        organizationId,
        code: label,
        name: label,
        legalName: label,
        isDefault: true,
      });
      await tx
        .insert(parties)
        .values({ id: portal, tenantId, code: label, kind: 'customer', name: label });
      await tx.insert(idpOrgs).values([
        { id: staff, tenantId, kind: 'staff', zitadelOrgId: staff, name: label },
        {
          id: portal,
          tenantId,
          kind: 'customer',
          partyId: portal,
          zitadelOrgId: portal,
          name: label,
        },
      ]);
      await tx
        .insert(departments)
        .values({ id: departmentId, tenantId, organizationId, name: 'Sales' });

      const add = (
        suffix: string,
        displayName: string | null,
        status: 'active' | 'invited' | 'inactive',
        idpOrgId = staff,
      ) =>
        sqlStore.insertUser(tx, scope, {
          zitadelUserId: `${tenantId}-${suffix}`,
          idpOrgId,
          displayName,
          email: `${suffix}@example.test`,
          status,
        });

      const alpha = await add('alpha', 'Alpha', 'active');
      const duplicate = await add('alpha-2', 'Alpha', 'invited');
      const target = await add('late%user', 'Zenith User', 'active');
      const inactive = await add('inactive', null, 'inactive');
      const outsider = await add('portal%user', 'Zenith User', 'active', portal);
      await tx
        .insert(userEntities)
        .values({ tenantId, organizationId, userId: target, departmentId });
      await sqlStore.replaceRoles(tx, scope, target, ['sales', 'finance']);
      return { alpha, duplicate, target, inactive, outsider };
    });
    return { scope, departmentId, ...ids };
  }

  it('searches and filters the whole staff directory with stable sort and isolated totals', async () => {
    const first = await directoryFixture('A');
    const second = await directoryFixture('B');
    const { scope, departmentId, alpha, duplicate, target, inactive } = first;
    expect(await sqlStore.summary(scope)).toEqual({
      total: 4,
      active: 2,
      invited: 1,
      deactivated: 1,
      departments: [{ id: departmentId, name: 'Sales' }],
    });
    expect(await sqlStore.summary(second.scope)).toMatchObject({ total: 4 });
    const sorted = [alpha, duplicate].sort();
    const pageOne = await listRows(scope, { limit: 1, sort: 'name', page: 1 });
    const pageTwo = await listRows(scope, { limit: 1, sort: 'name', page: 2 });
    expect(pageOne[0]?.id).toBe(sorted[0]);
    expect(pageTwo[0]?.id).toBe(sorted[1]);

    const matches = await listRows(scope, {
      limit: 1,
      q: '%USER',
      status: ['active'],
      role: ['sales'],
      departmentId,
    });
    expect(matches).toEqual([
      expect.objectContaining({
        id: target,
        roles: ['finance', 'sales'],
        department: { id: departmentId, name: 'Sales' },
        avatarDocumentId: null,
        lastActiveAt: null,
      }),
    ]);
    expect(AdminUserSchema.safeParse(matches[0]).success).toBe(true);
    // A search with few exact hits may add close matches after them, so only the first is pinned.
    expect((await listRows(scope, { limit: 10, q: 'zEnIth' }))[0]?.id).toBe(target);
    expect(await listRows(scope, { limit: 10, departmentId: second.departmentId })).toEqual([]);
    expect(await listRows(scope, { limit: 10, status: ['inactive'] })).toEqual([
      expect.objectContaining({ id: inactive, department: null }),
    ]);
    // Repeated values are any-of: two statuses, two roles.
    const byStatus = await listRows(scope, { limit: 10, status: ['inactive', 'invited'] });
    expect(byStatus.map(({ id }) => id).sort()).toEqual([duplicate, inactive].sort());
    const byRole = await listRows(scope, { limit: 10, role: ['finance', 'founder'] });
    expect(byRole.map(({ id }) => id)).toEqual([target]);
    // A typo finds the user, ranked after exact hits; the other tenant's user never appears.
    const typo = await listRows(scope, { limit: 10, q: 'Zenithh' });
    expect(typo[0]?.id).toBe(target);
    expect(typo.map(({ id }) => id)).not.toContain(second.target);
    // A filter narrows the fuzzy result too: the target is active, so inactive-only hides it.
    expect(await listRows(scope, { limit: 10, q: 'Zenithh', status: ['inactive'] })).toEqual([]);

    // The total counts the same scope, filters and search as the rows: the portal user and the other tenant's
    // four are never in it, and neither the page nor the id cursor changes it.
    expect(await totalOf(scope, { limit: 1 })).toBe(4);
    expect(await totalOf(scope, { limit: 1, sort: 'name', page: 9 })).toBe(4);
    expect(await listRows(scope, { limit: 1, sort: 'name', page: 9 })).toEqual([]);
    expect(await totalOf(scope, { limit: 1, after: alpha })).toBe(4);
    expect(await totalOf(scope, { limit: 1, status: ['active'] })).toBe(2);
    expect(await totalOf(scope, { limit: 1, status: ['inactive', 'invited'] })).toBe(2);
    expect(await totalOf(scope, { limit: 1, role: ['finance', 'founder'] })).toBe(1);
    expect(await totalOf(scope, { limit: 1, departmentId: second.departmentId })).toBe(0);
    // With a cursor the search is an exact substring match, so only the target's email matches.
    expect(await totalOf(scope, { limit: 1, q: '%USER', after: alpha })).toBe(1);
    // A fuzzy search counts the close matches it returns, too.
    const fuzzy = await sqlStore.list(scope, { limit: 10, q: 'Zenithh' });
    expect(fuzzy.total).toBe(fuzzy.rows.length);
    expect(await totalOf(scope, { limit: 1, q: 'Zenithh', status: ['inactive'] })).toBe(0);
  }, 60_000);

  it('throttles concurrent activity and excludes it from the audit without loosening scope', async () => {
    const first = await directoryFixture('C');
    const second = await directoryFixture('D');
    const audit = new AuditService(db);
    const countBefore = (await audit.list(first.scope, { limit: 100 })).length;
    const actor = { kind: 'user' as const, id: first.target, correlationId: 'corr-activity' };

    await Promise.all([
      sqlStore.recordActivity(first.scope, actor),
      sqlStore.recordActivity(first.scope, actor),
    ]);
    const [seen] = await listRows(first.scope, { limit: 1, sort: 'lastActive' });
    expect(seen?.id).toBe(first.target);
    expect(seen?.lastActiveAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    await new Promise((resolve) => setTimeout(resolve, 10));
    await sqlStore.recordActivity(first.scope, actor);
    expect((await listRows(first.scope, { limit: 1, sort: 'lastActive' }))[0]?.lastActiveAt).toBe(
      seen?.lastActiveAt,
    );

    await sqlStore.recordActivity(first.scope, { ...actor, id: second.target });
    await sqlStore.recordActivity(first.scope, { ...actor, id: first.inactive });
    expect(
      (await listRows(first.scope, { limit: 4, status: ['inactive'] }))[0]?.lastActiveAt,
    ).toBeNull();
    expect(
      (await listRows(second.scope, { limit: 4 })).every(
        ({ lastActiveAt }) => lastActiveAt === null,
      ),
    ).toBe(true);
    expect(await audit.list(first.scope, { limit: 100 })).toHaveLength(countBefore);
  }, 60_000);

  it('stores, lists, expires and clears a lock on the real columns and checks (0125, F1-Q4)', async () => {
    const f = await directoryFixture('L');
    const write = (update: Parameters<SqlUsersStore['updateUser']>[2]) =>
      withTx(db, f.scope, systemActor('test'), (tx) => sqlStore.updateUser(tx, f.inactive, update));
    const base = { email: 'inactive@example.test', displayName: null, status: 'inactive' as const };
    const lockedAt = new Date('2026-11-20T10:00:00.000Z');
    const until = new Date('2026-11-20T10:15:00.000Z');
    const expiredHere = async (now: Date) =>
      (await sqlStore.expiredLocks(db, now, 1000)).filter((l) => l.tenantId === f.scope.tenantId);

    await write({ ...base, lock: { reason: 'failed_sign_ins', lockedAt, until } });

    expect(await sqlStore.findById(db, f.scope, f.inactive)).toMatchObject({
      lockReason: 'failed_sign_ins',
      lockedUntil: '2026-11-20T10:15:00.000000Z',
    });
    const listed = await listRows(f.scope, { limit: 10, status: ['inactive'] });
    expect(listed.find((r) => r.id === f.inactive)).toMatchObject({
      lockReason: 'failed_sign_ins',
    });
    expect(await expiredHere(new Date('2026-11-20T10:14:59.000Z'))).toEqual([]);
    expect(await expiredHere(until)).toEqual([{ id: f.inactive, tenantId: f.scope.tenantId }]);
    // The lock-expiry job's retry moves only the end of a failed-sign-in lock.
    const later = new Date('2026-11-20T10:45:00.000Z');
    await withTx(db, f.scope, systemActor('test'), (tx) =>
      sqlStore.postponeLock(tx, f.inactive, later),
    );
    expect(await expiredHere(until)).toEqual([]);
    expect(await sqlStore.findById(db, f.scope, f.inactive)).toMatchObject({
      lockReason: 'failed_sign_ins',
      lockedUntil: '2026-11-20T10:45:00.000000Z',
    });

    // An admin lock never ends by itself: the shape check refuses one with an end time.
    const refused: unknown = await withTx(db, f.scope, systemActor('test'), (tx) =>
      tx.execute(
        sql`UPDATE app.users SET lock_reason = 'admin', locked_until = now() WHERE id = ${f.inactive}`,
      ),
    ).then(
      () => null,
      (error: unknown) => error,
    );
    const failure = refused as { constraint?: string; cause?: { constraint?: string } } | null;
    expect(failure?.cause?.constraint ?? failure?.constraint).toBe('users_lock_shape_check');

    // No lock in the update keeps the stored one; a status that lets the person in clears it.
    await write({ ...base, displayName: 'Renamed' });
    expect(await sqlStore.findById(db, f.scope, f.inactive)).toMatchObject({
      displayName: 'Renamed',
      lockReason: 'failed_sign_ins',
    });
    await write({ ...base, status: 'active' });
    expect(await sqlStore.findById(db, f.scope, f.inactive)).toMatchObject({
      status: 'active',
      lockReason: null,
      lockedUntil: null,
    });
    expect(await expiredHere(until)).toEqual([]);
  }, 60_000);

  it('migration 0126 turns stored timed locks into admin locks, audited as system:migration-0126 (P2-1)', async () => {
    const f = await directoryFixture('M');
    await withTx(db, f.scope, systemActor('test'), (tx) =>
      sqlStore.updateUser(tx, f.inactive, {
        email: 'inactive@example.test',
        displayName: null,
        status: 'inactive',
        lock: {
          reason: 'failed_sign_ins',
          lockedAt: new Date('2026-11-20T10:00:00.000Z'),
          until: new Date('2026-11-20T10:15:00.000Z'),
        },
      }),
    );
    const migration = readFileSync(
      new URL(
        '../../../../../packages/db/migrations/0126_user_locks_admin_default.sql',
        import.meta.url,
      ),
      'utf8',
    );
    const owner = new Pool({ connectionString: testDb.ownerUrl, max: 1 });
    try {
      const client = await owner.connect();
      try {
        await client.query('BEGIN');
        for (const statement of migration.split('--> statement-breakpoint')) {
          await client.query(statement);
        }
        await client.query('COMMIT');
      } finally {
        client.release();
      }

      expect(await sqlStore.findById(db, f.scope, f.inactive)).toMatchObject({
        status: 'inactive',
        lockReason: 'admin',
        lockedUntil: null,
      });
      const audited = await owner.query<{ reason: string }>(
        `SELECT after->>'lock_reason' AS reason FROM audit.audit_events
         WHERE entity_id = $1 AND actor_id = 'system:migration-0126'`,
        [f.inactive],
      );
      expect(audited.rows).toEqual([{ reason: 'admin' }]);
    } finally {
      await owner.end();
    }
  }, 60_000);

  it('places an invitee in a department at a level on the real membership row (F1-Q50)', async () => {
    const f = await directoryFixture('P');
    await withTx(db, f.scope, systemActor('test'), async (tx) => {
      expect(
        await sqlStore.departmentForPlacement(tx, f.scope.tenantId, f.departmentId),
      ).toMatchObject({
        organizationId: f.scope.organizationId,
        status: 'active',
        headUserId: null,
      });
      await sqlStore.ensureDefaultMembership(tx, f.scope.tenantId, f.scope.organizationId, f.alpha);
      await sqlStore.placeMembership(tx, f.scope.tenantId, f.scope.organizationId, f.alpha, {
        departmentId: f.departmentId,
        level: 'manager',
      });
    });

    expect(await sqlStore.membershipsOf(db, f.scope.tenantId, f.alpha)).toEqual([
      expect.objectContaining({ departmentId: f.departmentId, level: 'manager' }),
    ]);
  }, 60_000);
});
