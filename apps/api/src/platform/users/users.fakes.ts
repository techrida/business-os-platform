// Test doubles for k-users: an in-memory UsersStore with the same dedupe and upsert semantics as the
// SQL, a fake ZITADEL, a fake queue and a db whose transaction just runs the callback.
// Test-only: imported by *.test.ts files, never by runtime code.
import type { RoleKey } from '@bos/contracts';

import type { Db, DbTransaction } from '../db/db.module';
import type { TxScope } from '../db/tx';
import {
  type ListedUser,
  type OrgRow,
  type Queryable,
  type UserFields,
  type UserRow,
  UsersStore,
  type ZitadelEventKey,
} from './users.store';
import type { ZitadelAdminClient, ZitadelUser, ZitadelUserPage } from './zitadel-admin.client';

export const TENANT = '00000000-0000-4000-8000-000000000001';
export const STAFF_ORG = '00000000-0000-4000-8000-0000000000aa';
export const STAFF_ZORG = 'z-staff';

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
  orgs: OrgRow[] = [{ tenantId: TENANT, organizationId: STAFF_ORG, zitadelOrgId: STAFF_ZORG }];
  users: UserRow[] = [];
  roles = new Map<string, RoleKey[]>();
  events = new Set<string>();
  cursors = new Map<string, string>();
  authzBumps = 0;
  scope: TxScope = { tenantId: TENANT, organizationId: STAFF_ORG };
  private seq = 0;

  orgByZitadelId(z: string) {
    return Promise.resolve(this.orgs.find((o) => o.zitadelOrgId === z) ?? null);
  }
  orgById(id: string) {
    return Promise.resolve(this.orgs.find((o) => o.organizationId === id) ?? null);
  }
  listOrgs() {
    return Promise.resolve([...this.orgs]);
  }
  txScope() {
    return Promise.resolve(this.scope);
  }
  findByZitadelId(_q: Queryable, z: string) {
    return Promise.resolve(this.users.find((u) => u.zitadelUserId === z) ?? null);
  }
  findById(_q: Queryable, s: TxScope, id: string) {
    return Promise.resolve(
      this.users.find(
        (u) => u.id === id && u.tenantId === s.tenantId && u.organizationId === s.organizationId,
      ) ?? null,
    );
  }
  insertUser(_tx: DbTransaction, s: TxScope, u: UserFields) {
    const existing = this.users.find((x) => x.zitadelUserId === u.zitadelUserId);
    if (existing) return Promise.resolve(existing.id);
    this.seq += 1;
    const id = `00000000-0000-4000-9000-${String(this.seq).padStart(12, '0')}`;
    this.users.push({ id, ...s, ...u, departmentId: null });
    return Promise.resolve(id);
  }
  updateUser(_tx: DbTransaction, id: string, u: Omit<UserFields, 'zitadelUserId'>) {
    const row = this.users.find((x) => x.id === id);
    if (row) Object.assign(row, u);
    return Promise.resolve();
  }
  notInactiveInOrg(_q: Queryable, s: TxScope) {
    return Promise.resolve(
      this.users.filter((u) => u.organizationId === s.organizationId && u.status !== 'inactive'),
    );
  }
  rolesOf(_q: Queryable, id: string) {
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
            u.organizationId === s.organizationId &&
            u.status === 'active' &&
            (this.roles.get(u.id) ?? []).includes(role),
        )
        .map((u) => u.id),
    );
  }
  emailOf(id: string) {
    return Promise.resolve(this.users.find((u) => u.id === id)?.email ?? null);
  }
  list(s: TxScope): Promise<ListedUser[]> {
    return Promise.resolve(
      this.users
        .filter((u) => u.organizationId === s.organizationId)
        .map((u) => ({ ...u, roles: this.roles.get(u.id) ?? [] })),
    );
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
