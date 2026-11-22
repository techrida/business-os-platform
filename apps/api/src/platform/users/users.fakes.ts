// Test doubles for k-users: an in-memory UsersStore with the same dedupe and upsert semantics as the
// SQL, a fake ZITADEL, a fake queue and a db whose transaction just runs the callback.
// Test-only: imported by *.test.ts files, never by runtime code.
import type { AccessLevel, RoleKey } from '@bos/contracts';

import type { Db, DbTransaction } from '../db/db.module';
import type { TxScope } from '../db/tx';
import {
  type EffectiveRoleHolder,
  type IdpOrgRow,
  type ListedUser,
  type ListedUsers,
  type MembershipRow,
  type PlacementDepartment,
  type Queryable,
  type ExpiredLock,
  type UserFields,
  type UserLock,
  type UserRow,
  type UserUpdate,
  UsersStore,
  type ZitadelEventKey,
} from './users.store';
import {
  type ZitadelAdminClient,
  ZitadelHttpError,
  type ZitadelUser,
  type ZitadelUserPage,
} from './zitadel-admin.client';

export const TENANT = '00000000-0000-4000-8000-000000000001';
/** The tenant's default legal entity (ADR 0027): bootstrap memberships land here. */
export const STAFF_ORG = '00000000-0000-4000-8000-0000000000aa';
export const STAFF_IDP = '00000000-0000-4000-8000-0000000001aa';
export const STAFF_ZORG = 'z-staff';
export const CUST_IDP = '00000000-0000-4000-8000-0000000001cc';
export const CUST_ZORG = 'z-customer';

/**
 * Counts the transactions withTx opened, so a test can see that writes went through it, and how many are open now, so
 * a fake ZITADEL can refuse to be called inside one.
 */
export function fakeDb(): Db & { txCount: number; open: number } {
  const tx = { execute: () => Promise.resolve({ rows: [] }) } as unknown as DbTransaction;
  const db = {
    txCount: 0,
    open: 0,
    async transaction<T>(fn: (t: DbTransaction) => Promise<T>): Promise<T> {
      db.txCount += 1;
      db.open += 1;
      try {
        return await fn(tx);
      } finally {
        db.open -= 1;
      }
    },
  };
  return db as unknown as Db & { txCount: number; open: number };
}

export class FakeUsersStore extends UsersStore {
  orgs: IdpOrgRow[] = [
    { idpOrgId: STAFF_IDP, tenantId: TENANT, zitadelOrgId: STAFF_ZORG, kind: 'staff' },
    { idpOrgId: CUST_IDP, tenantId: TENANT, zitadelOrgId: CUST_ZORG, kind: 'customer' },
  ];
  defaultEntities = new Map<string, string>([[TENANT, STAFF_ORG]]);
  /** organizations.name by entity id, for the last-Founder message. */
  entityNames = new Map<string, string>([[STAFF_ORG, 'Techrida Nepal']]);
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
  /** Copies, as the SQL store returns: a change made after the read does not show in the row read. */
  findByZitadelId(_q: Queryable, z: string) {
    return Promise.resolve(this.found(this.users.find((u) => u.zitadelUserId === z)));
  }
  findById(_q: Queryable, s: TxScope, id: string, _lock?: boolean) {
    return Promise.resolve(
      this.found(this.users.find((u) => u.id === id && u.tenantId === s.tenantId)),
    );
  }
  private found(row: UserRow | undefined): UserRow | null {
    return row ? { ...row, version: row.version ?? '0' } : null;
  }
  private versions = 0;
  /** As `updated_at = now()` does: every write gives the row a new version. */
  private touch(row: UserRow) {
    this.versions += 1;
    row.version = `v${this.versions}`;
  }
  insertUser(_tx: DbTransaction, s: TxScope, u: UserFields) {
    const existing = this.users.find((x) => x.zitadelUserId === u.zitadelUserId);
    if (existing) return Promise.resolve(existing.id);
    this.seq += 1;
    const id = `00000000-0000-4000-9000-${String(this.seq).padStart(12, '0')}`;
    const row: UserRow = { id, tenantId: s.tenantId, ...u };
    this.touch(row);
    this.users.push(row);
    return Promise.resolve(id);
  }
  /** Every updateUser call, in order (the lock tests read what was written). */
  updates: { id: string; update: UserUpdate }[] = [];
  updateUser(_tx: DbTransaction, id: string, u: UserUpdate) {
    this.updates.push({ id, update: u });
    const row = this.users.find((x) => x.id === id);
    if (row) {
      const { lock, ...fields } = u;
      Object.assign(row, fields);
      // As the trigger of migration 0190: a flagged person is never active.
      if (row.identityReviewRequired === true && row.status === 'active') row.status = 'inactive';
      // As the SQL store: a status other than inactive clears the lock; undefined keeps it.
      const next = u.status === 'inactive' ? lock : null;
      if (next === null) {
        row.lockReason = null;
        row.lockedUntil = null;
      } else if (next) {
        row.lockReason = next.reason;
        row.lockedUntil = next.until?.toISOString() ?? null;
      }
      this.touch(row);
    }
    return Promise.resolve();
  }
  flagIdentityReview(_tx: DbTransaction, id: string, lock?: UserLock) {
    const row = this.users.find((x) => x.id === id);
    if (row) {
      row.identityReviewRequired = true;
      if (row.status === 'active') row.status = 'inactive';
      if (lock) {
        row.lockReason = lock.reason;
        row.lockedUntil = lock.until?.toISOString() ?? null;
      }
      this.touch(row);
    }
    return Promise.resolve();
  }
  clearIdentityReview(_tx: DbTransaction, id: string) {
    const row = this.users.find((x) => x.id === id);
    if (row) {
      row.identityReviewRequired = false;
      this.touch(row);
    }
    return Promise.resolve();
  }
  postponeLock(_tx: DbTransaction, id: string, until: Date) {
    const row = this.users.find((x) => x.id === id && x.lockReason === 'failed_sign_ins');
    if (row) {
      row.lockedUntil = until.toISOString();
      this.touch(row);
    }
    return Promise.resolve();
  }
  expiredLocks(_q: Queryable, now: Date, limit: number): Promise<ExpiredLock[]> {
    return Promise.resolve(
      this.users
        .filter(
          (u) =>
            u.lockReason === 'failed_sign_ins' &&
            u.identityReviewRequired !== true &&
            u.lockedUntil != null &&
            Date.parse(u.lockedUntil) <= now.getTime(),
        )
        .sort((a, b) => Date.parse(a.lockedUntil ?? '') - Date.parse(b.lockedUntil ?? ''))
        .slice(0, limit)
        .map((u) => ({ id: u.id, tenantId: u.tenantId })),
    );
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
  /** Departments by id, with the tenant they belong to. */
  departments = new Map<string, PlacementDepartment & { tenantId: string }>();
  departmentForPlacement(_q: Queryable, tenantId: string, departmentId: string) {
    const found = this.departments.get(departmentId);
    if (!found || found.tenantId !== tenantId) return Promise.resolve(null);
    const { organizationId, name, status, headUserId } = found;
    return Promise.resolve({ organizationId, name, status, headUserId });
  }
  placeMembership(
    _tx: DbTransaction,
    tenantId: string,
    organizationId: string,
    userId: string,
    placement: { departmentId: string | null; level: AccessLevel },
  ) {
    const row = this.memberships.find(
      (m) => m.tenantId === tenantId && m.organizationId === organizationId && m.userId === userId,
    );
    if (row) Object.assign(row, placement);
    return Promise.resolve();
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
  effectiveRoleHolders(_q: Queryable, tenantId: string, role: RoleKey) {
    const holders: EffectiveRoleHolder[] = [];
    for (const m of this.memberships) {
      if (m.tenantId !== tenantId || (m.roleKeys !== null && !m.roleKeys.includes(role))) continue;
      const user = this.users.find((u) => u.id === m.userId && u.tenantId === tenantId);
      if (user?.status !== 'active' || !(this.roles.get(user.id) ?? []).includes(role)) continue;
      holders.push({
        organizationId: m.organizationId,
        entityName: this.entityNames.get(m.organizationId) ?? m.organizationId,
        userId: user.id,
      });
    }
    return Promise.resolve(holders);
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
  founderLeases = new Map<string, string>();
  claimFounderLease(tenantId: string, leaseId: string, _ttlSeconds?: number, _timeoutMs?: number) {
    const held = this.founderLeases.get(tenantId);
    if (held !== undefined && held !== leaseId) return Promise.resolve(false);
    this.founderLeases.set(tenantId, leaseId);
    return Promise.resolve(true);
  }
  releaseFounderLease(tenantId: string, leaseId: string) {
    if (this.founderLeases.get(tenantId) === leaseId) this.founderLeases.delete(tenantId);
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
  grantOrgs = new Map<string, string>();
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
  listGrants(id: string, orgId: string) {
    if (!orgId) return Promise.resolve([]);
    const ownerOrg = this.grantOrgs.get(id) ?? this.users.get(id)?.orgId;
    if (ownerOrg !== undefined && ownerOrg !== orgId) return Promise.resolve([]);
    return Promise.resolve([...(this.grants.get(id) ?? [])]);
  }
  createHuman() {
    return Promise.resolve('z-new');
  }
  setGrants(userId: string, orgId: string, roles: RoleKey[]) {
    this.setGrantsCalls.push({ userId, orgId, roles });
    this.grants.set(userId, roles);
    this.grantOrgs.set(userId, orgId);
    return Promise.resolve();
  }
  sendInviteCode() {
    return Promise.resolve();
  }
  statusCalls: string[] = [];
  lockUser(userId: string) {
    applyZitadelStatusTransition(this.users.get(userId), 'lock');
    this.statusCalls.push(`lock:${userId}`);
    return Promise.resolve();
  }
  unlockUser(userId: string) {
    applyZitadelStatusTransition(this.users.get(userId), 'unlock');
    this.statusCalls.push(`unlock:${userId}`);
    return Promise.resolve();
  }
  deactivateUser(userId: string) {
    applyZitadelStatusTransition(this.users.get(userId), 'deactivate');
    this.statusCalls.push(`deactivate:${userId}`);
    return Promise.resolve();
  }
  reactivateUser(userId: string) {
    applyZitadelStatusTransition(this.users.get(userId), 'reactivate');
    this.statusCalls.push(`reactivate:${userId}`);
    return Promise.resolve();
  }

  asClient(): ZitadelAdminClient {
    return this as unknown as ZitadelAdminClient;
  }
}

/**
 * Mirrors ZITADEL v4.20.1 state-change preconditions:
 *   - lockUser: accepted only when active or invited (not already locked or inactive)
 *   - unlockUser: accepted only when locked
 *   - reactivateUser: accepted only when inactive and not locked
 *   - deactivateUser: accepted when active or locked (refused for invited or already deactivated)
 */
export function applyZitadelStatusTransition(
  user: ZitadelUser | undefined,
  action: 'lock' | 'unlock' | 'deactivate' | 'reactivate',
): void {
  const locked = user?.locked === true;
  switch (action) {
    case 'lock':
      if (!user || locked || (user.status !== 'active' && user.status !== 'invited')) {
        throw new ZitadelHttpError('/LockUser', 400, 'failed_precondition');
      }
      Object.assign(user, { status: 'inactive', locked: true });
      return;
    case 'unlock':
      if (!user || !locked) {
        throw new ZitadelHttpError('/UnlockUser', 400, 'failed_precondition');
      }
      Object.assign(user, { status: 'active', locked: false });
      return;
    case 'reactivate':
      if (!user || user.status !== 'inactive' || locked) {
        throw new ZitadelHttpError('/ReactivateUser', 400, 'failed_precondition');
      }
      Object.assign(user, { status: 'active', locked: false });
      return;
    case 'deactivate':
      if (!user || (user.status !== 'active' && !locked)) {
        throw new ZitadelHttpError('/DeactivateUser', 400, 'failed_precondition');
      }
      Object.assign(user, { status: 'inactive', locked: false });
      return;
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
