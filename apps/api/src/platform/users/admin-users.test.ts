// Tests for the admin-user review fixes: an invite that grants roles needs `admin.roles.write`, a
// half-finished invite can be repaired by inviting again, and emailOf answers only for active users.
// The emailOf test runs the real SQL in a Postgres container (needs Docker):
//   pnpm --filter @bos/api exec vitest run src/platform/users/admin-users.test.ts
import 'reflect-metadata';

import type { Permission, RoleKey } from '@bos/contracts';
import { ConflictException, ForbiddenException } from '@nestjs/common';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { Queue } from 'bullmq';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AuthzService } from '../authz/authz.service';
import type { RoleCache } from '../authz/role-cache';
import { bindIdentity, bindPrincipal, runWithRequestStore } from '../tenancy/request-context';
import { AdminUsersController } from './admin-users.controller';
import { UserMirror } from './user-mirror';
import type { UsersSyncData } from './users.constants';
import { FakeUsersStore, STAFF_ORG, STAFF_ZORG, TENANT, fakeDb, fakeQueue } from './users.fakes';
import { UsersService } from './users.service';
import { SqlUsersStore } from './users.store';
import {
  type CreateHumanInput,
  ZitadelHttpError,
  type ZitadelUser,
  type ZitadelUserPage,
} from './zitadel-admin.client';

/** ZITADEL that remembers who it created and answers 409 for a second createHuman of one email. */
class RepairableZitadel {
  users = new Map<string, ZitadelUser>();
  grants = new Map<string, RoleKey[]>();
  inviteCodes: string[] = [];
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
  setGrants(userId: string, _orgId: string, roles: readonly RoleKey[]) {
    if (this.failSetGrantsOnce) {
      this.failSetGrantsOnce = false;
      return Promise.reject(new Error('ZITADEL 503 during setGrants'));
    }
    this.grants.set(userId, [...roles]);
    return Promise.resolve();
  }
  sendInviteCode(userId: string) {
    this.inviteCodes.push(userId);
    return Promise.resolve();
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

/** Runs `fn` as an active admin holding exactly `permissions`, as the tenancy interceptor would bind it. */
function asAdmin<T>(permissions: Permission[], fn: () => Promise<T>): Promise<T> {
  return runWithRequestStore('corr-12345678', () => {
    bindIdentity({
      tenantId: TENANT,
      organizationId: STAFF_ORG,
      orgKind: 'staff',
      userId: 'zitadel-admin',
      roles: [],
      tokenExp: 1_900_000_000,
    });
    bindPrincipal({
      userId: ADMIN,
      zitadelUserId: 'zitadel-admin',
      tenantId: TENANT,
      organizationId: STAFF_ORG,
      orgKind: 'staff',
      roles: [],
      departmentId: null,
      status: 'active',
      grants: new Map(permissions.map((p) => [p, 'all' as const])),
    });
    return fn();
  });
}

let store: FakeUsersStore;
let zitadel: RepairableZitadel;
let authz: TestAuthz;
let controller: AdminUsersController;

beforeEach(() => {
  store = new FakeUsersStore();
  zitadel = new RepairableZitadel();
  const db = fakeDb();
  const client = zitadel as never;
  const mirror = new UserMirror(db, store, client, fakeQueue() as unknown as Queue<UsersSyncData>);
  authz = new TestAuthz(db, {} as RoleCache);
  controller = new AdminUsersController(db, new UsersService(mirror, store, client), authz);
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

describe('inviting again after a half-finished invite', () => {
  const both: Permission[] = ['admin.users.invite', 'admin.roles.write'];

  it('finds the ZITADEL user created by the failed attempt and finishes the missing steps', async () => {
    zitadel.failSetGrantsOnce = true;
    await expect(
      asAdmin(both, () => controller.invite({ ...NEW_USER, roles: ['finance'] })),
    ).rejects.toThrow('ZITADEL 503 during setGrants');
    // ZITADEL has the user; the mirror and the grant do not.
    expect(zitadel.users.size).toBe(1);
    expect(store.users).toHaveLength(0);

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
      status: 'invited',
    });
    expect(zitadel.grants.get(created!.id)).toEqual(['finance']);
    expect(store.roles.get(userId)).toEqual(['finance']);
    expect(zitadel.inviteCodes).toContain(created!.id);
    expect(authz.invalidations).toBe(1);
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
});

describe('SqlUsersStore.emailOf', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let sqlStore: SqlUsersStore;
  const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    pool = new Pool({ connectionString: container.getConnectionUri(), max: 2 });
    // Only the columns emailOf reads: this test is about the query, not the migrations.
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
    await container?.stop();
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
