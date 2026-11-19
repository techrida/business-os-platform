// Test doubles for k-users: an in-memory UsersStore with the same dedupe and upsert semantics as the
// SQL, a fake ZITADEL, a fake queue and a db whose transaction just runs the callback.
// Test-only: imported by *.test.ts files, never by runtime code.
import type { RoleKey } from '@bos/contracts';

import type { Db, DbTransaction } from '../db/db.module';
import type { TxScope } from '../db/tx';
import {
  type IdpOrgRow,
  type ListedUser,
  type ListedUsers,
  type MembershipRow,
  type Queryable,
  type UserFields,
  type UserRow,
  UsersStore,
  type ZitadelEventKey,
} from './users.store';
import type { ZitadelAdminClient, ZitadelUser, ZitadelUserPage } from './zitadel-admin.client';

export const TENANT = '00000000-0000-4000-8000-000000000001';
/** The tenant's default legal entity (ADR 0027): bootstrap memberships land here. */
export const STAFF_ORG = '00000000-0000-4000-8000-0000000000aa';
export const STAFF_IDP = '00000000-0000-4000-8000-0000000001aa';
export const STAFF_ZORG = 'z-staff';
export const CUST_IDP = '00000000-0000-4000-8000-0000000001cc';
export const CUST_ZORG = 'z-customer';

/** Counts the transactions withTx opened, so a test can see that writes went through it. */
export function fakeDb(): Db & { txCount: number } {
  const tx = { execute: () => Promise.resolve({ rows: [] }) } as unknown as DbTransaction;
  const db = {
    txCount: 0,
    transaction<T>(fn: (t: DbTransaction) => Promise<T>): Promise<T> {
      db.txCount += 1;
      return fn(tx);
    },
  };
  return db as unknown as Db & { txCount: number };
}

export class FakeUsersStore extends UsersStore {
  orgs: IdpOrgRow[] = [
    { idpOrgId: STAFF_IDP, tenantId: TENANT, zitadelOrgId: STAFF_ZORG, kind: 'staff' },
    { idpOrgId: CUST_IDP, tenantId: TENANT, zitadelOrgId: CUST_ZORG, kind: 'customer' },
  ];
  defaultEntities = new Map<string, string>([[TENANT, STAFF_ORG]]);
  users: UserRow[] = [];
  memberships: (MembershipRow & { tenantId: string; userId: string })[] = [];
  roles = new Map<string, RoleKey[]>();
  events = new Set<string>();
  cursors = new Map<string, string>();
  authzBumps = 0;
  scope: TxScope = { tenantId: TENANT, organizationId: STAFF_ORG };
  private seq = 0;

  idpOrgByZitadelId(z: string) {
    return Promise.resolve(this.orgs.find((o) => o.zitadelOrgId === z) ?? null);
  }
  idpOrgById(id: string) {
    return Promise.resolve(this.orgs.find((o) => o.idpOrgId === id) ?? null);
  }
  staffIdpOrgOf(tenantId: string) {
    return Promise.resolve(
      this.orgs.find((o) => o.tenantId === tenantId && o.kind === 'staff') ?? null,
    );
  }
  listStaffIdpOrgs() {
    return Promise.resolve(this.orgs.filter((o) => o.kind === 'staff'));
  }
  defaultEntityOf(tenantId: string) {
    return Promise.resolve(this.defaultEntities.get(tenantId) ?? null);
  }
  txScope() {
    return Promise.resolve(this.scope);
  }
  findByZitadelId(_q: Queryable, z: string) {
    return Promise.resolve(this.users.find((u) => u.zitadelUserId === z) ?? null);
  }
  findById(_q: Queryable, s: TxScope, id: string) {
    return Promise.resolve(
      this.users.find((u) => u.id === id && u.tenantId === s.tenantId) ?? null,
    );
  }
  insertUser(_tx: DbTransaction, s: TxScope, u: UserFields) {
    const existing = this.users.find((x) => x.zitadelUserId === u.zitadelUserId);
    if (existing) return Promise.resolve(existing.id);
    this.seq += 1;
    const id = `00000000-0000-4000-9000-${String(this.seq).padStart(12, '0')}`;
    this.users.push({ id, tenantId: s.tenantId, ...u });
    return Promise.resolve(id);
  }
  updateUser(_tx: DbTransaction, id: string, u: Omit<UserFields, 'zitadelUserId' | 'idpOrgId'>) {
    const row = this.users.find((x) => x.id === id);
    if (row) Object.assign(row, u);
    return Promise.resolve();
  }
  notInactiveInIdpOrg(_q: Queryable, o: IdpOrgRow) {
    return Promise.resolve(
      this.users.filter((u) => u.idpOrgId === o.idpOrgId && u.status !== 'inactive'),
    );
  }
  membershipsOf(_q: Queryable, tenantId: string, userId: string): Promise<MembershipRow[]> {
    return Promise.resolve(
      this.memberships
        .filter((m) => m.tenantId === tenantId && m.userId === userId)
        .map(({ organizationId, isDefault, roleKeys, departmentId, level }) => ({
          organizationId,
          isDefault,
          roleKeys,
          departmentId,
          // Only when a test set one: the SQL store always answers a level, but most fixtures predate it.
          ...(level === undefined ? {} : { level }),
        })),
    );
  }
  ensureDefaultMembership(_tx: DbTransaction, tenantId: string, entityId: string, userId: string) {
    if (this.memberships.some((m) => m.tenantId === tenantId && m.userId === userId)) {
      return Promise.resolve(false);
    }
    this.memberships.push({
      tenantId,
      userId,
      organizationId: entityId,
      isDefault: true,
      roleKeys: null,
      departmentId: null,
    });
    return Promise.resolve(true);
  }
  rolesOf(_q: Queryable, _tenantId: string, id: string) {
    return Promise.resolve([...(this.roles.get(id) ?? [])].sort());
  }
  replaceRoles(_tx: DbTransaction, _s: TxScope, id: string, roles: readonly RoleKey[]) {
    this.roles.set(id, [...roles]);
    return Promise.resolve();
  }
  bumpAuthzVersion() {
    this.authzBumps += 1;
    return Promise.resolve();
  }
  userIdsWithRole(s: TxScope, role: RoleKey) {
    return Promise.resolve(
      this.users
        .filter(
          (u) =>
            u.tenantId === s.tenantId &&
            u.status === 'active' &&
            (this.roles.get(u.id) ?? []).includes(role) &&
            this.memberships.some(
              (m) =>
                m.userId === u.id &&
                m.organizationId === s.organizationId &&
                (m.roleKeys === null || m.roleKeys.includes(role)),
            ),
        )
        .map((u) => u.id),
    );
  }
  activeRoleHolderIds(_q: Queryable, tenantId: string, role: RoleKey) {
    return Promise.resolve(
      this.users
        .filter(
          (u) =>
            u.tenantId === tenantId &&
            u.status === 'active' &&
            (this.roles.get(u.id) ?? []).includes(role),
        )
        .map((u) => u.id),
    );
  }
  emailOf(id: string) {
    return Promise.resolve(this.users.find((u) => u.id === id)?.email ?? null);
  }
  /** Every staff user of the tenant; filters, search and paging are the SQL store's job. */
  list(s: TxScope): Promise<ListedUsers> {
    const rows = this.staff(s);
    return Promise.resolve({ rows, total: rows.length });
  }
  private staff(s: TxScope): ListedUser[] {
    return this.users
      .filter(
        (u) =>
          u.tenantId === s.tenantId &&
          this.orgs.some((o) => o.idpOrgId === u.idpOrgId && o.kind === 'staff'),
      )
      .map((u) => ({
        ...u,
        avatarDocumentId: null,
        roles: this.roles.get(u.id) ?? [],
        department: null,
        lastActiveAt: null,
        createdAt: '2026-01-01T00:00:00.000Z',
      }));
  }
  summary(scope: TxScope) {
    const users = this.staff(scope);
    return Promise.resolve({
      total: users.length,
      active: users.filter(({ status }) => status === 'active').length,
      invited: users.filter(({ status }) => status === 'invited').length,
      deactivated: users.filter(({ status }) => status === 'inactive').length,
      departments: [],
    });
  }
  recordActivity() {
    return Promise.resolve();
  }
  recordEvent(e: ZitadelEventKey) {
    const key = `${e.instanceId}|${e.aggregateId}|${e.sequence}`;
    if (this.events.has(key)) return Promise.resolve(false);
    this.events.add(key);
    return Promise.resolve(true);
  }
  getCursor(name: string) {
    return Promise.resolve(this.cursors.get(name) ?? null);
  }
  setCursor(name: string, cursor: string) {
    this.cursors.set(name, cursor);
    return Promise.resolve();
  }
}

/**
 * ZITADEL as a map of users and grants; listUsers pages by `pageSize`. The knobs below reproduce the
 * ways the real list call can lie: `ignoreOffset` (always serves the first page), `hiddenFromList`
 * (a user getUser still returns but the list omits), `totalOverride`/`omitTotal` (a wrong or absent
 * totalResult) and `onListUsers` (something happens in ZITADEL while a pass is running).
 */
export class FakeZitadel {
  users = new Map<string, ZitadelUser>();
  grants = new Map<string, RoleKey[]>();
  pageSize = 2;
  failListFor = new Set<string>();
  setGrantsCalls: { userId: string; orgId: string; roles: RoleKey[] }[] = [];
  getUserCalls: string[] = [];
  listUsersCalls = 0;
  ignoreOffset = false;
  hiddenFromList = new Set<string>();
  totalOverride: number | null = null;
  omitTotal = false;
  onListUsers: ((call: number) => void) | null = null;

  getUser(id: string) {
    this.getUserCalls.push(id);
    return Promise.resolve(this.users.get(id) ?? null);
  }
  listUsers(orgId: string, cursor?: string | null): Promise<ZitadelUserPage> {
    if (this.failListFor.has(orgId)) return Promise.reject(new Error('ZITADEL 503'));
    this.listUsersCalls += 1;
    this.onListUsers?.(this.listUsersCalls);
    const all = [...this.users.values()].filter(
      (u) => u.orgId === orgId && !this.hiddenFromList.has(u.id),
    );
    const requested = cursor ? Number(cursor) : 0;
    const served = this.ignoreOffset ? 0 : requested;
    const users = all.slice(served, served + this.pageSize);
    // Like the real client: the next cursor comes from the offset it asked for, not from what it got.
    const next = requested + users.length;
    return Promise.resolve({
      users,
      nextCursor: next < all.length ? String(next) : null,
      totalResult: this.omitTotal ? null : (this.totalOverride ?? all.length),
    });
  }
  listGrants(id: string) {
    return Promise.resolve([...(this.grants.get(id) ?? [])]);
  }
  createHuman() {
    return Promise.resolve('z-new');
  }
  setGrants(userId: string, orgId: string, roles: RoleKey[]) {
    this.setGrantsCalls.push({ userId, orgId, roles });
    this.grants.set(userId, roles);
    return Promise.resolve();
  }
  sendInviteCode() {
    return Promise.resolve();
  }

  asClient(): ZitadelAdminClient {
    return this as unknown as ZitadelAdminClient;
  }
}

export function fakeQueue() {
  const added: { name: string; data: unknown }[] = [];
  return {
    added,
    add(name: string, data: unknown) {
      added.push({ name, data });
      return Promise.resolve({ id: String(added.length) });
    },
  };
}

export function zUser(id: string, over: Partial<ZitadelUser> = {}): ZitadelUser {
  return {
    id,
    orgId: STAFF_ZORG,
    email: `${id}@techrida.test`,
    displayName: `User ${id}`,
    status: 'active',
    createdAt: null,
    ...over,
  };
}
