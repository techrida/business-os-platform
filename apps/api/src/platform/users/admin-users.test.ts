// Tests for the admin-user review fixes: an invite that grants roles needs `admin.roles.write`, a
// half-finished invite can be repaired by inviting again, and emailOf answers only for active users.
// The emailOf test runs the real SQL in a Postgres container (needs Docker), and the ADR 0027 test runs the
// store's tenant-scoped SQL against the real migrations (0013), so a wrong ON CONFLICT target fails (42P10):
//   pnpm --filter @bos/api exec vitest run src/platform/users/admin-users.test.ts
import 'reflect-metadata';

import { randomUUID } from 'node:crypto';

import { AdminUserSchema, type Permission, type RoleKey } from '@bos/contracts';
import {
  departments,
  idpOrgs,
  organizations,
  parties,
  runMigrations,
  tenants,
  userEntities,
} from '@bos/db';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { Queue } from 'bullmq';
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
import type { UsersSyncData } from './users.constants';
import {
  FakeUsersStore,
  STAFF_IDP,
  STAFF_ORG,
  STAFF_ZORG,
  TENANT,
  fakeDb,
  fakeQueue,
} from './users.fakes';
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
  getUser(userId: string) {
    return Promise.resolve(this.users.get(userId) ?? null);
  }
  sendPasswordReset(userId: string) {
    this.resetEmails.push(userId);
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

let store: FakeUsersStore;
let zitadel: RepairableZitadel;
let authz: TestAuthz;
let controller: AdminUsersController;
let audit: AuditService;

beforeEach(() => {
  store = new FakeUsersStore();
  zitadel = new RepairableZitadel();
  const db = fakeDb();
  const client = zitadel as never;
  const mirror = new UserMirror(db, store, client, fakeQueue() as unknown as Queue<UsersSyncData>);
  authz = new TestAuthz(db, {} as RoleCache);
  audit = new AuditService(db);
  controller = new AdminUsersController(
    db,
    new UsersService(mirror, store, client, db, audit),
    authz,
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

describe('PUT /v1/admin/users/:id/roles last-Founder guard', () => {
  const FOUNDER_ONE = '00000000-0000-4000-9000-000000000101';
  const FOUNDER_TWO = '00000000-0000-4000-9000-000000000102';
  const INVITED_FOUNDER = '00000000-0000-4000-9000-000000000103';

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
      message: 'Kiran Thapa is the only Founder. Make someone else a Founder first.',
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

    await asAdmin(['admin.roles.write'], () =>
      controller.setRoles(FOUNDER_ONE, { roles: ['management'] }),
    );
    expect(zitadel.grants.get('z-founder-1')).toEqual(['management']);
    expect(store.roles.get(FOUNDER_ONE)).toEqual(['management']);
    expect(authz.invalidations).toBe(1);
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

describe('SqlUsersStore against migration 0013 (ADR 0027: tenant-scoped users)', () => {
  const OWNER_PW = 'owner-test-pw';
  const APP_PW = 'app-test-pw';
  let container: StartedPostgreSqlContainer;
  let appPool: Pool;
  let db: Db;
  let sqlStore: SqlUsersStore;

  const urlFor = (user: string, password: string, database: string) => {
    const url = new URL(container.getConnectionUri());
    url.username = user;
    url.password = password;
    url.pathname = `/${database}`;
    return url.toString();
  };

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    const admin = new Pool({ connectionString: container.getConnectionUri(), max: 1 });
    await admin.query(`CREATE ROLE bos_owner LOGIN PASSWORD '${OWNER_PW}'`);
    await admin.query(`CREATE ROLE bos_app LOGIN PASSWORD '${APP_PW}'`);
    await admin.query('CREATE DATABASE bos OWNER bos_owner');
    await admin.query('REVOKE ALL ON DATABASE bos FROM PUBLIC');
    await admin.query('GRANT CONNECT ON DATABASE bos TO bos_app');
    await admin.end();
    const bosAdmin = new Pool({ connectionString: urlFor('test', 'test', 'bos'), max: 1 });
    await bosAdmin.query(
      'ALTER DEFAULT PRIVILEGES FOR ROLE bos_owner GRANT USAGE ON SCHEMAS TO bos_app',
    );
    await bosAdmin.query(
      'ALTER DEFAULT PRIVILEGES FOR ROLE bos_owner GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO bos_app',
    );
    await bosAdmin.end();
    await runMigrations(urlFor('bos_owner', OWNER_PW, 'bos'));
    appPool = new Pool({ connectionString: urlFor('bos_app', APP_PW, 'bos'), max: 4 });
    appPool.on('error', () => undefined);
    db = drizzle({ client: appPool });
    sqlStore = new SqlUsersStore(db);
  }, 180_000);

  afterAll(async () => {
    await appPool?.end();
    await container?.stop();
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
      { organizationId: entityId, isDefault: true, roleKeys: null, departmentId: null },
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
});
