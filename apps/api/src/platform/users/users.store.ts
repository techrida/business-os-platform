// Every SQL statement k-users runs, in one place.
// Serves the NFRs "every change is audited" (writes take the `tx` that withTx opened, so the audit
// trigger sees the actor) and "tenancy is never implicit" (every read names tenant and org).
//
// Raw `sql` with the P1-PLAN §4 column names on purpose: U1's drizzle file schema/identity.ts was a
// placeholder when this was written (columns since checked against 0002_identity_authz.sql). Swap to
// the drizzle tables at integration if you like; the UsersStore interface is what the rest of
// k-users (and its tests) depend on.
//
// ADR 0027: users and user_roles are tenant-scoped (no organization_id). A ZITADEL org maps to an
// app.idp_orgs row; which legal entities a staff user may act for lives in app.user_entities.
import type {
  AccessLevel,
  AdminUser,
  AdminUsersQuery,
  AdminUsersSummary,
  RoleKey,
  UserLockReason,
} from '@bos/contracts';
import { idpOrgs, organizations } from '@bos/db';
import { Inject, Injectable } from '@nestjs/common';
import { type SQL, and, eq, sql } from 'drizzle-orm';

import { DB, type Db, type DbTransaction } from '../db/db.module';
import { searchPage } from '../list';
import { type Actor, type TxScope, withTx } from '../db/tx';
import type { MirroredStatus } from './zitadel-admin.client';

/** Either the pool-backed db or an open transaction: both can run a statement. */
export type Queryable = Db | DbTransaction;

/** A ZITADEL org as app.idp_orgs maps it: the tenant, and staff vs portal (ADR 0027 section 2). */
export interface IdpOrgRow {
  idpOrgId: string;
  tenantId: string;
  zitadelOrgId: string;
  kind: 'staff' | 'customer' | 'vendor';
}

export interface UserRow {
  id: string;
  tenantId: string;
  idpOrgId: string;
  zitadelUserId: string;
  email: string | null;
  displayName: string | null;
  status: MirroredStatus;
  /** Why the user is locked (0125); null = not locked. The SQL store always returns it; fakes may leave it out. */
  lockReason?: UserLockReason | null;
  /** When a `failed_sign_ins` lock ends, as an ISO timestamp; null otherwise. */
  lockedUntil?: string | null;
  /**
   * A failed or ambiguous write to ZITADEL left this person's state unsure (migration 0189): the row is closed, and a
   * trigger keeps it from ever being 'active'. Sync never clears it; an admin resolves it. The SQL store always returns
   * it; fakes may leave it out.
   */
  identityReviewRequired?: boolean;
  /**
   * `updated_at` as text, from findById and findByZitadelId only: the row version a sync compares under the row lock
   * before it writes what it read from ZITADEL outside the transaction.
   */
  version?: string;
}

/** A lock to write (F1-Q4): `until` is null for an admin lock, which never ends by itself. */
export interface UserLock {
  reason: UserLockReason;
  lockedAt: Date;
  until: Date | null;
}

/**
 * The fields updateUser writes. `lock` undefined keeps the stored lock, null clears it. Whatever it says, a status
 * other than 'inactive' clears the lock: only an inactive (LOCKED in ZITADEL) person can be locked.
 */
export type UserUpdate = Omit<UserFields, 'zitadelUserId' | 'idpOrgId'> & {
  lock?: UserLock | null;
};

/** A `failed_sign_ins` lock whose time is up, for the lock-expiry job. */
export interface ExpiredLock {
  id: string;
  tenantId: string;
}

/** One app.user_entities row: an entity the staff user may act for (ADR 0027 section 3). */
export interface MembershipRow {
  organizationId: string;
  isDefault: boolean;
  /** NULL = every role in the token. */
  roleKeys: string[] | null;
  departmentId: string | null;
  /** `user_entities.level` (0079): staff, manager or head. The SQL store always returns it. */
  level?: AccessLevel;
}

/** The department an invite places a new person in (F1-Q50): where it lives, whether it is in use, and its head. */
export interface PlacementDepartment {
  organizationId: string;
  name: string;
  status: 'active' | 'retired';
  headUserId: string | null;
}

/** One user who holds a role in one legal entity (see `effectiveRoleHolders`). */
export interface EffectiveRoleHolder {
  organizationId: string;
  entityName: string;
  userId: string;
}

export interface UserFields {
  zitadelUserId: string;
  /** The IdP org the user logs in through; only insertUser reads it. */
  idpOrgId: string;
  email: string | null;
  displayName: string | null;
  status: MirroredStatus;
}

export type ListedUser = AdminUser & UserRow;
/** Up to `limit + 1` rows (the extra one says another page exists) and the count of all matches. */
export type ListedUsers = { rows: ListedUser[]; total: number };
/** A staff user flagged for identity review, before the reason is read from the audit log. */
export type FlaggedUserRow = {
  id: string;
  email: string | null;
  displayName: string | null;
  status: MirroredStatus;
  flaggedAt: string | null;
};
export type StaffSummary = Omit<AdminUsersSummary, 'canSendPasswordReset'>;

/** One ZITADEL event id as the webhook delivered it; the triple is the dedupe key (§3). */
export interface ZitadelEventKey {
  instanceId: string;
  aggregateId: string;
  sequence: string;
  eventType: string | null;
}

export abstract class UsersStore {
  abstract idpOrgByZitadelId(zitadelOrgId: string): Promise<IdpOrgRow | null>;
  abstract idpOrgById(idpOrgId: string): Promise<IdpOrgRow | null>;
  /** The tenant's one staff IdP org: where invites are created and grants are set. */
  abstract staffIdpOrgOf(tenantId: string, q?: Queryable): Promise<IdpOrgRow | null>;
  /** Every staff IdP org; reconcile walks these (portal orgs are invisible to the provisioner token). */
  abstract listStaffIdpOrgs(): Promise<IdpOrgRow[]>;
  /** The tenant's default entity id: bootstrap memberships land here and user writes are audited under it. */
  abstract defaultEntityOf(tenantId: string, q?: Queryable): Promise<string | null>;
  /** The scope withTx put on this transaction (bos.tenant_id / bos.organization_id). */
  abstract txScope(tx: DbTransaction): Promise<TxScope>;

  /**
   * `lock` takes FOR NO KEY UPDATE, so a hook sync and a reconcile of the same user run one after the other. Not FOR
   * UPDATE: a row inserted with a foreign key to app.users takes FOR KEY SHARE on the user, which FOR UPDATE would
   * block, and that insert may hold its tenant's audit lock while it waits.
   */
  abstract findByZitadelId(
    q: Queryable,
    zitadelUserId: string,
    lock?: boolean,
  ): Promise<UserRow | null>;
  /**
   * Tenant-scoped: `scope.organizationId` is not a filter, users have no entity. `lock` takes FOR NO KEY UPDATE, the
   * same row lock a sync takes in findByZitadelId, so a status action and a sync of the same user run one after the
   * other while foreign-key checks against the user still go through.
   */
  abstract findById(
    q: Queryable,
    scope: TxScope,
    userId: string,
    lock?: boolean,
  ): Promise<UserRow | null>;
  /** Inserts, or returns the existing row's id when a concurrent insert won. */
  abstract insertUser(tx: DbTransaction, scope: TxScope, u: UserFields): Promise<string>;
  abstract updateUser(tx: DbTransaction, userId: string, u: UserUpdate): Promise<void>;
  /**
   * Closes the row and flags it for review: an active person becomes inactive, `lock` (when given) is stored, and the
   * flag stays until `clearIdentityReview`. Callers hold the user row lock and bump the authz version.
   */
  abstract flagIdentityReview(tx: DbTransaction, userId: string, lock?: UserLock): Promise<void>;
  /** Clears the review flag; the caller then writes the status ZITADEL reports (updateUser). */
  abstract clearIdentityReview(tx: DbTransaction, userId: string): Promise<void>;
  abstract notInactiveInIdpOrg(q: Queryable, org: IdpOrgRow): Promise<UserRow[]>;
  /** Up to `limit` `failed_sign_ins` locks that ended by `now`, across tenants, oldest first (the lock-expiry job). */
  abstract expiredLocks(q: Queryable, now: Date, limit: number): Promise<ExpiredLock[]>;
  /** Moves a `failed_sign_ins` lock's end to `until` (the lock-expiry job's retry after a failed unlock). */
  abstract postponeLock(tx: DbTransaction, userId: string, until: Date): Promise<void>;

  abstract membershipsOf(q: Queryable, tenantId: string, userId: string): Promise<MembershipRow[]>;
  /**
   * The bootstrap rule (ADR 0027 section 3): a membership in `entityId` (is_default, role_keys NULL)
   * when the user has none at all. Returns whether it inserted one.
   */
  abstract ensureDefaultMembership(
    tx: DbTransaction,
    tenantId: string,
    entityId: string,
    userId: string,
  ): Promise<boolean>;

  /** A department of the tenant by id (any entity), or null. */
  abstract departmentForPlacement(
    q: Queryable,
    tenantId: string,
    departmentId: string,
  ): Promise<PlacementDepartment | null>;
  /**
   * Sets the department and level of the user's membership in `organizationId`. The 0079 and 0086 triggers keep the
   * department head and `department_since` in step; the audit trigger records the change under the tx's actor.
   */
  abstract placeMembership(
    tx: DbTransaction,
    tenantId: string,
    organizationId: string,
    userId: string,
    placement: { departmentId: string | null; level: AccessLevel },
  ): Promise<void>;

  abstract rolesOf(q: Queryable, tenantId: string, userId: string): Promise<RoleKey[]>;
  abstract replaceRoles(
    tx: DbTransaction,
    scope: TxScope,
    userId: string,
    roles: readonly RoleKey[],
  ): Promise<void>;
  /** Bumps the tenant's authz_version so every process drops its cached principals and grants. */
  abstract bumpAuthzVersion(tx: DbTransaction, scope: TxScope): Promise<void>;

  /**
   * Active holders of `role` with a membership in the entity whose role_keys is NULL or has the role. Read on `q`
   * (the caller's transaction, when there is one), or on the pool.
   */
  abstract userIdsWithRole(scope: TxScope, role: RoleKey, q?: Queryable): Promise<string[]>;
  /**
   * Effective holders of `role` per legal entity, used by the last-Founder guard: an active user with the
   * role and a membership in the entity whose role_keys is NULL or has the role. One row per (entity, user).
   */
  abstract effectiveRoleHolders(
    q: Queryable,
    tenantId: string,
    role: RoleKey,
  ): Promise<EffectiveRoleHolder[]>;
  /**
   * The address of an `active` user only: notifications must not mail a deactivated or invited person. Read on `q`
   * (the caller's transaction, when there is one), or on the pool.
   */
  abstract emailOf(userId: string, q?: Queryable): Promise<string | null>;
  /**
   * The tenant's staff users (the staff IdP org's), with their mirrored roles. `total` counts every match of
   * the same scope, filters and search, ignoring the id cursor and the page.
   */
  abstract list(scope: TxScope, q: AdminUsersQuery): Promise<ListedUsers>;
  abstract summary(scope: TxScope): Promise<StaffSummary>;
  /** The tenant's staff users flagged for identity review (newest flag first, at most 200). */
  abstract listFlagged(scope: TxScope): Promise<FlaggedUserRow[]>;
  abstract recordActivity(scope: TxScope, actor: Actor): Promise<void>;

  /** True when the event is new; false when this (instance, aggregate, sequence) was seen before. */
  abstract recordEvent(e: ZitadelEventKey): Promise<boolean>;
  /**
   * Marks a ZITADEL identity whose invite has not committed in the database yet. Set before the invite's first grant or
   * mail, cleared in the transaction that writes the invited row. While it is set, no sign-in creates or activates a row
   * for that identity (a failed invite whose database writes all failed leaves no other trace).
   */
  abstract markInvitePending(zitadelUserId: string): Promise<void>;
  abstract clearInvitePending(tx: DbTransaction, zitadelUserId: string): Promise<void>;
  abstract isInvitePending(zitadelUserId: string): Promise<boolean>;
  abstract getCursor(name: string): Promise<string | null>;
  abstract setCursor(name: string, cursor: string): Promise<void>;

  /**
   * Takes the tenant's Founder-removal lease: true when this `leaseId` now holds it, false when another live lease does.
   * One statement, so two requests cannot both win. A lease older than `ttlSeconds` is dead (its holder crashed) and is
   * taken over. It spans the ZITADEL call of a Founder-removing action, which no transaction or row lock may.
   */
  async claimFounderLease(
    tenantId: string,
    leaseId: string,
    ttlSeconds: number,
    timeoutMs: number,
  ): Promise<boolean> {
    return (await this.claimFounderLeaseWithOrigin(tenantId, leaseId, ttlSeconds, timeoutMs)).claimed;
  }
  /**
   * Same claim, and says how it was won. `ttlTakeover` is true only when the lease was held by another holder that had
   * outlived `ttlSeconds` (a crashed or stalled one). A lease its holder released, or never held, is not a takeover. A
   * claim that cannot tell reports false, which callers treat as the cautious answer.
   */
  abstract claimFounderLeaseWithOrigin(
    tenantId: string,
    leaseId: string,
    ttlSeconds: number,
    timeoutMs: number,
  ): Promise<{ claimed: boolean; ttlTakeover: boolean }>;
  /**
   * Frees the lease when `leaseId` still holds it; a lease taken over after its TTL is left alone. An outstanding
   * Founder removal recorded under it stays on the free lease, and the next holder takes it over with the lease.
   */
  abstract releaseFounderLease(tenantId: string, leaseId: string): Promise<void>;
  /**
   * Records, on the lease row itself, that `leaseId`'s holder is about to change ZITADEL in a way that may remove a
   * Founder. True when recorded; false when `leaseId` no longer holds the lease (then no provider call may start). One
   * statement, so a takeover either carries the record or happens before it and makes it fail. The lease age is not
   * touched.
   */
  abstract recordFounderRemoval(
    tenantId: string,
    leaseId: string,
    removal: PendingFounderRemoval,
  ): Promise<boolean>;
  /** The outstanding Founder removal carried on the lease `leaseId` holds, or null when there is none. */
  abstract outstandingFounderRemoval(
    tenantId: string,
    leaseId: string,
  ): Promise<PendingFounderRemoval | null>;
  /**
   * Clears any Founder removal recorded on the lease `leaseId` holds. Inside a transaction `q`, it commits with the local
   * write that makes the removal moot (and is undone with it), and the lease row stays locked until that transaction
   * ends. Returns whether `leaseId` still holds the lease: false means it was taken over and nothing more may be written.
   */
  abstract settleFounderRemoval(tenantId: string, leaseId: string, q?: Queryable): Promise<boolean>;
}

/** A provider change that may remove a Founder, recorded before it starts and cleared once the database shows it. */
export interface PendingFounderRemoval {
  userId: string;
  zitadelUserId: string;
  /** The action: a status action ('deactivate', 'lock') or 'set_roles'. */
  intent: string;
}

/** The lease row's cursor: `free` or a lease id, then `|` and the outstanding removal as JSON when there is one. */
const FOUNDER_REMOVAL_SEPARATOR = '|';

export function parseFounderRemoval(
  cursor: string | null | undefined,
): PendingFounderRemoval | null {
  if (!cursor) return null;
  const at = cursor.indexOf(FOUNDER_REMOVAL_SEPARATOR);
  if (at < 0) return null;
  try {
    const parsed = JSON.parse(cursor.slice(at + 1)) as Partial<PendingFounderRemoval>;
    if (typeof parsed.userId !== 'string' || typeof parsed.zitadelUserId !== 'string') {
      throw new Error('malformed');
    }
    return {
      userId: parsed.userId,
      zitadelUserId: parsed.zitadelUserId,
      intent: String(parsed.intent),
    };
  } catch {
    // A suffix that cannot be read still names an outstanding removal: refuse rather than drop it.
    throw new Error('users.founder-lease: unreadable outstanding removal on the lease row');
  }
}

export function encodeFounderRemoval(removal: PendingFounderRemoval): string {
  return `${FOUNDER_REMOVAL_SEPARATOR}${JSON.stringify(removal)}`;
}

const invitePendingName = (zitadelUserId: string) => `users.invite-pending:${zitadelUserId}`;
const founderLeaseName = (tenantId: string) => `users.founder-lease:${tenantId}`;
const FOUNDER_LEASE_FREE = 'free';
/** The `|<outstanding removal>` part of the lease row's current cursor, or '' when there is none. */
const REMOVAL_SUFFIX = sql`CASE WHEN position(${FOUNDER_REMOVAL_SEPARATOR}::text in ops.sync_cursors.cursor) > 0
  THEN substr(ops.sync_cursors.cursor, position(${FOUNDER_REMOVAL_SEPARATOR}::text in ops.sync_cursors.cursor))
  ELSE '' END`;
/** The lease row is held by `leaseId`, with or without an outstanding removal. */
const heldBy = (leaseId: string) =>
  sql`(ops.sync_cursors.cursor = ${leaseId}
    OR starts_with(ops.sync_cursors.cursor, ${leaseId + FOUNDER_REMOVAL_SEPARATOR}::text))`;

async function rows<T extends Record<string, unknown>>(q: Queryable, query: SQL): Promise<T[]> {
  // Db and DbTransaction share execute(); the cast only picks one of the two identical signatures.
  const result = await (q as Db).execute<T>(query);
  return result.rows as T[];
}

const USER_COLUMNS = sql`u.id, u.tenant_id AS "tenantId", u.idp_org_id AS "idpOrgId",
  u.zitadel_user_id AS "zitadelUserId", u.email, u.display_name AS "displayName", u.status,
  u.lock_reason AS "lockReason", u.identity_review_required AS "identityReviewRequired",
  to_char(u.locked_until AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "lockedUntil"`;

const FOUND_USER_COLUMNS = sql`${USER_COLUMNS}, u.updated_at::text AS "version"`;

const STAFF_USERS = sql`FROM app.users u
  JOIN app.idp_orgs io ON io.id = u.idp_org_id AND io.tenant_id = u.tenant_id AND io.kind = 'staff'`;

const DIRECTORY_ORDER = {
  name: sql`lower(coalesce(u.display_name, u.email)) ASC NULLS LAST, u.id`,
  lastActive: sql`u.last_active_at DESC NULLS LAST, u.id`,
  createdAt: sql`u.created_at DESC, u.id`,
};

const IDP_ORG_COLUMNS = {
  idpOrgId: idpOrgs.id,
  tenantId: idpOrgs.tenantId,
  zitadelOrgId: idpOrgs.zitadelOrgId,
  kind: idpOrgs.kind,
};

type UserRecord = UserRow & Record<string, unknown>;

@Injectable()
export class SqlUsersStore extends UsersStore {
  constructor(@Inject(DB) private readonly db: Db) {
    super();
  }

  async idpOrgByZitadelId(zitadelOrgId: string): Promise<IdpOrgRow | null> {
    const found = await this.db
      .select(IDP_ORG_COLUMNS)
      .from(idpOrgs)
      .where(eq(idpOrgs.zitadelOrgId, zitadelOrgId))
      .limit(1);
    return found[0] ?? null;
  }

  async idpOrgById(idpOrgId: string): Promise<IdpOrgRow | null> {
    const found = await this.db
      .select(IDP_ORG_COLUMNS)
      .from(idpOrgs)
      .where(eq(idpOrgs.id, idpOrgId))
      .limit(1);
    return found[0] ?? null;
  }

  async staffIdpOrgOf(tenantId: string, q: Queryable = this.db): Promise<IdpOrgRow | null> {
    const found = await (q as Db)
      .select(IDP_ORG_COLUMNS)
      .from(idpOrgs)
      .where(and(eq(idpOrgs.tenantId, tenantId), eq(idpOrgs.kind, 'staff')))
      .limit(1);
    return found[0] ?? null;
  }

  listStaffIdpOrgs(): Promise<IdpOrgRow[]> {
    return this.db.select(IDP_ORG_COLUMNS).from(idpOrgs).where(eq(idpOrgs.kind, 'staff'));
  }

  async defaultEntityOf(tenantId: string, q: Queryable = this.db): Promise<string | null> {
    const found = await (q as Db)
      .select({ id: organizations.id })
      .from(organizations)
      .where(and(eq(organizations.tenantId, tenantId), eq(organizations.isDefault, true)))
      .limit(1);
    return found[0]?.id ?? null;
  }

  async txScope(tx: DbTransaction): Promise<TxScope> {
    const [row] = await rows<{ tenantId: string; organizationId: string }>(
      tx,
      sql`SELECT current_setting('bos.tenant_id', true) AS "tenantId",
                 current_setting('bos.organization_id', true) AS "organizationId"`,
    );
    if (!row?.tenantId || !row.organizationId) {
      throw new Error('k-users write outside withTx: bos.tenant_id / bos.organization_id unset');
    }
    return row;
  }

  async findByZitadelId(
    q: Queryable,
    zitadelUserId: string,
    lock = false,
  ): Promise<UserRow | null> {
    const [row] = await rows<UserRecord>(
      q,
      sql`SELECT ${FOUND_USER_COLUMNS} FROM app.users u WHERE u.zitadel_user_id = ${zitadelUserId}
          ${lock ? sql`FOR NO KEY UPDATE` : sql``}`,
    );
    return row ?? null;
  }

  async findById(
    q: Queryable,
    scope: TxScope,
    userId: string,
    lock = false,
  ): Promise<UserRow | null> {
    const [row] = await rows<UserRecord>(
      q,
      sql`SELECT ${FOUND_USER_COLUMNS} FROM app.users u
          WHERE u.tenant_id = ${scope.tenantId} AND u.id = ${userId}
          ${lock ? sql`FOR NO KEY UPDATE` : sql``}`,
    );
    return row ?? null;
  }

  async insertUser(tx: DbTransaction, scope: TxScope, u: UserFields): Promise<string> {
    const [inserted] = await rows<{ id: string }>(
      tx,
      sql`INSERT INTO app.users (tenant_id, idp_org_id, zitadel_user_id, email, display_name, status, last_synced_at)
          VALUES (${scope.tenantId}, ${u.idpOrgId}, ${u.zitadelUserId}, ${u.email},
                  ${u.displayName}, ${u.status}, now())
          ON CONFLICT (zitadel_user_id) DO NOTHING
          RETURNING id`,
    );
    if (inserted) return inserted.id;
    const existing = await this.findByZitadelId(tx, u.zitadelUserId);
    if (!existing) throw new Error('app.users insert conflicted but no row was found');
    return existing.id;
  }

  async updateUser(tx: DbTransaction, userId: string, u: UserUpdate): Promise<void> {
    const lock = u.status === 'inactive' ? u.lock : null;
    const lockSet =
      lock === undefined
        ? sql``
        : lock === null
          ? sql`, lock_reason = NULL, locked_at = NULL, locked_until = NULL`
          : sql`, lock_reason = ${lock.reason}, locked_at = ${lock.lockedAt.toISOString()}::timestamptz,
              locked_until = ${lock.until?.toISOString() ?? null}::timestamptz`;
    await tx.execute(
      sql`UPDATE app.users SET email = ${u.email}, display_name = ${u.displayName},
            status = ${u.status}, last_synced_at = now(), updated_at = now() ${lockSet}
          WHERE id = ${userId}`,
    );
  }

  async flagIdentityReview(tx: DbTransaction, userId: string, lock?: UserLock): Promise<void> {
    const lockSet =
      lock === undefined
        ? sql``
        : sql`, lock_reason = ${lock.reason}, locked_at = ${lock.lockedAt.toISOString()}::timestamptz,
            locked_until = ${lock.until?.toISOString() ?? null}::timestamptz`;
    await tx.execute(
      sql`UPDATE app.users SET identity_review_required = true, identity_review_at = now(), updated_at = now(),
            status = CASE WHEN status = 'active' THEN 'inactive' ELSE status END ${lockSet}
          WHERE id = ${userId}`,
    );
  }

  async clearIdentityReview(tx: DbTransaction, userId: string): Promise<void> {
    await tx.execute(
      sql`UPDATE app.users SET identity_review_required = false, identity_review_at = NULL, updated_at = now()
          WHERE id = ${userId}`,
    );
  }

  async postponeLock(tx: DbTransaction, userId: string, until: Date): Promise<void> {
    await tx.execute(
      sql`UPDATE app.users SET locked_until = ${until.toISOString()}::timestamptz, updated_at = now()
          WHERE id = ${userId} AND lock_reason = 'failed_sign_ins'`,
    );
  }

  expiredLocks(q: Queryable, now: Date, limit: number): Promise<ExpiredLock[]> {
    return rows<ExpiredLock & Record<string, unknown>>(
      q,
      sql`SELECT u.id, u.tenant_id AS "tenantId" FROM app.users u
          WHERE u.lock_reason = 'failed_sign_ins' AND u.locked_until <= ${now.toISOString()}::timestamptz
            AND NOT u.identity_review_required
          ORDER BY u.locked_until, u.id
          LIMIT ${limit}`,
    );
  }

  notInactiveInIdpOrg(q: Queryable, org: IdpOrgRow): Promise<UserRow[]> {
    return rows<UserRecord>(
      q,
      sql`SELECT ${USER_COLUMNS} FROM app.users u
          WHERE u.tenant_id = ${org.tenantId} AND u.idp_org_id = ${org.idpOrgId}
            AND u.status <> 'inactive'`,
    );
  }

  membershipsOf(q: Queryable, tenantId: string, userId: string): Promise<MembershipRow[]> {
    // A membership left on a retired department grants no department reach: it reads as unassigned
    // staff, the same as a null department.
    return rows<MembershipRow & Record<string, unknown>>(
      q,
      sql`SELECT ue.organization_id AS "organizationId", ue.is_default AS "isDefault",
                 ue.role_keys AS "roleKeys",
                 CASE WHEN d.status = 'retired' THEN NULL ELSE ue.department_id END AS "departmentId",
                 CASE WHEN d.status = 'retired' THEN 'staff' ELSE ue.level END AS level
          FROM app.user_entities ue
          LEFT JOIN app.departments d ON d.tenant_id = ue.tenant_id
            AND d.organization_id = ue.organization_id AND d.id = ue.department_id
          WHERE ue.tenant_id = ${tenantId} AND ue.user_id = ${userId}
          ORDER BY ue.is_default DESC, ue.organization_id`,
    );
  }

  async ensureDefaultMembership(
    tx: DbTransaction,
    tenantId: string,
    entityId: string,
    userId: string,
  ): Promise<boolean> {
    // NOT EXISTS: only a user with no membership at all gets one. The explicit target (ADR 0027
    // section 9) makes a concurrent bootstrap of the same user a no-op instead of an error.
    const inserted = await rows<{ one: number }>(
      tx,
      sql`INSERT INTO app.user_entities (tenant_id, organization_id, user_id, is_default, role_keys)
          SELECT ${tenantId}::uuid, ${entityId}::uuid, ${userId}::uuid, true, NULL
          WHERE NOT EXISTS (
            SELECT 1 FROM app.user_entities WHERE tenant_id = ${tenantId} AND user_id = ${userId})
          ON CONFLICT (tenant_id, organization_id, user_id) DO NOTHING
          RETURNING 1 AS one`,
    );
    return inserted.length > 0;
  }

  async departmentForPlacement(
    q: Queryable,
    tenantId: string,
    departmentId: string,
  ): Promise<PlacementDepartment | null> {
    const [row] = await rows<PlacementDepartment & Record<string, unknown>>(
      q,
      sql`SELECT d.organization_id AS "organizationId", d.name, d.status, d.head_user_id AS "headUserId"
          FROM app.departments d WHERE d.tenant_id = ${tenantId} AND d.id = ${departmentId}`,
    );
    return row ?? null;
  }

  async placeMembership(
    tx: DbTransaction,
    tenantId: string,
    organizationId: string,
    userId: string,
    placement: { departmentId: string | null; level: AccessLevel },
  ): Promise<void> {
    await tx.execute(
      sql`UPDATE app.user_entities SET department_id = ${placement.departmentId}, level = ${placement.level}
          WHERE tenant_id = ${tenantId} AND organization_id = ${organizationId} AND user_id = ${userId}`,
    );
  }

  async rolesOf(q: Queryable, tenantId: string, userId: string): Promise<RoleKey[]> {
    const found = await rows<{ role: RoleKey }>(
      q,
      sql`SELECT role_key AS role FROM app.user_roles
          WHERE tenant_id = ${tenantId} AND user_id = ${userId} ORDER BY role_key`,
    );
    return found.map((r) => r.role);
  }

  async replaceRoles(
    tx: DbTransaction,
    scope: TxScope,
    userId: string,
    roles: readonly RoleKey[],
  ): Promise<void> {
    const keep = [...new Set(roles)];
    // Delete only what went away and insert only what is new, so the audit log shows the real diff.
    await tx.execute(
      keep.length === 0
        ? sql`DELETE FROM app.user_roles WHERE tenant_id = ${scope.tenantId} AND user_id = ${userId}`
        : sql`DELETE FROM app.user_roles WHERE tenant_id = ${scope.tenantId} AND user_id = ${userId}
                AND role_key NOT IN (${sql.join(
                  keep.map((r) => sql`${r}`),
                  sql`, `,
                )})`,
    );
    for (const role of keep) {
      await tx.execute(
        sql`INSERT INTO app.user_roles (tenant_id, user_id, role_key, source)
            VALUES (${scope.tenantId}, ${userId}, ${role}, 'zitadel')
            ON CONFLICT (tenant_id, user_id, role_key) DO NOTHING`,
      );
    }
  }

  async bumpAuthzVersion(tx: DbTransaction, scope: TxScope): Promise<void> {
    // authz_versions_tenant_unique (0013) makes this one race-free statement.
    await tx.execute(
      sql`INSERT INTO app.authz_versions (tenant_id, version)
          VALUES (${scope.tenantId}, 1)
          ON CONFLICT (tenant_id)
          DO UPDATE SET version = app.authz_versions.version + 1, updated_at = now()`,
    );
  }

  async userIdsWithRole(scope: TxScope, role: RoleKey, q: Queryable = this.db): Promise<string[]> {
    const found = await rows<{ id: string }>(
      q,
      sql`SELECT u.id FROM app.user_roles ur
          JOIN app.users u ON u.tenant_id = ur.tenant_id AND u.id = ur.user_id
          JOIN app.user_entities ue ON ue.tenant_id = ur.tenant_id AND ue.user_id = ur.user_id
            AND ue.organization_id = ${scope.organizationId}
          WHERE ur.tenant_id = ${scope.tenantId} AND ur.role_key = ${role} AND u.status = 'active'
            AND (ue.role_keys IS NULL OR ${role}::text = ANY (ue.role_keys))
          ORDER BY u.id`,
    );
    return found.map((r) => r.id);
  }

  effectiveRoleHolders(
    q: Queryable,
    tenantId: string,
    role: RoleKey,
  ): Promise<EffectiveRoleHolder[]> {
    return rows<EffectiveRoleHolder & Record<string, unknown>>(
      q,
      sql`SELECT ue.organization_id AS "organizationId", o.name AS "entityName", u.id AS "userId"
          FROM app.user_roles ur
          JOIN app.users u ON u.tenant_id = ur.tenant_id AND u.id = ur.user_id
          JOIN app.user_entities ue ON ue.tenant_id = ur.tenant_id AND ue.user_id = ur.user_id
          JOIN app.organizations o ON o.tenant_id = ue.tenant_id AND o.id = ue.organization_id
          WHERE ur.tenant_id = ${tenantId} AND ur.role_key = ${role} AND u.status = 'active'
            AND (ue.role_keys IS NULL OR ${role}::text = ANY (ue.role_keys))
          ORDER BY o.name, ue.organization_id, u.id`,
    );
  }

  async emailOf(userId: string, q: Queryable = this.db): Promise<string | null> {
    const [row] = await rows<{ email: string | null }>(
      q,
      sql`SELECT email FROM app.users WHERE id = ${userId} AND status = 'active'`,
    );
    return row?.email ?? null;
  }

  async list(scope: TxScope, q: AdminUsersQuery): Promise<ListedUsers> {
    const from = sql`${STAFF_USERS}
          LEFT JOIN app.user_entities ue ON ue.tenant_id = u.tenant_id AND ue.user_id = u.id
            AND ue.organization_id = ${scope.organizationId}
          LEFT JOIN app.departments d ON d.tenant_id = ue.tenant_id
            AND d.organization_id = ue.organization_id AND d.id = ue.department_id`;
    const any = (values: readonly string[]) =>
      sql.join(
        values.map((v) => sql`${v}`),
        sql`, `,
      );
    // Scope and filters only; the search and the cursor are added below.
    const filters = sql`u.tenant_id = ${scope.tenantId}
      ${q.status?.length ? sql`AND u.status IN (${any(q.status)})` : sql``}
      ${q.departmentId ? sql`AND d.id = ${q.departmentId}` : sql``}
      ${
        q.role?.length
          ? sql`AND EXISTS (SELECT 1 FROM app.user_roles ur WHERE ur.tenant_id = u.tenant_id
              AND ur.user_id = u.id AND ur.role_key IN (${any(q.role)}))`
          : sql``
      }`;
    const order = q.sort ? DIRECTORY_ORDER[q.sort] : sql`u.id`;
    const count = async (reader: Queryable, where: SQL | undefined) => {
      const [row] = await rows<{ n: number }>(
        reader,
        sql`SELECT count(*)::int AS n ${from} WHERE ${where}`,
      );
      return row?.n ?? 0;
    };
    const select = (where: SQL | undefined, orderBy: SQL[], tail: SQL) => sql`
      SELECT ${USER_COLUMNS}, u.avatar_document_id AS "avatarDocumentId",
        to_char(u.last_active_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "lastActiveAt",
        to_char(u.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "createdAt",
        CASE WHEN d.id IS NOT NULL THEN jsonb_build_object('id', d.id, 'name', d.name) END AS department,
        ARRAY(SELECT ur.role_key FROM app.user_roles ur
          WHERE ur.tenant_id = u.tenant_id AND ur.user_id = u.id ORDER BY ur.role_key) AS roles
      ${from}
      WHERE ${where}
      ORDER BY ${sql.join(orderBy, sql`, `)}
      ${tail}`;

    // The id cursor (`u.id > after`) assumes id order, which similarity ranking breaks: with a cursor the
    // search stays an exact substring match.
    if (!q.q || q.after) {
      // Search punctuation literally. ILIKE supplies case folding and uses the trigram indexes.
      const pattern = q.q ? `%${q.q.replace(/[!%_]/g, '!$&')}%` : null;
      const matching = sql`${filters}
            ${pattern ? sql`AND (u.display_name ILIKE ${pattern} ESCAPE '!' OR u.email ILIKE ${pattern} ESCAPE '!')` : sql``}`;
      const [found, total] = await Promise.all([
        rows<ListedUser & Record<string, unknown>>(
          this.db,
          select(
            sql`${matching} ${q.after ? sql`AND u.id > ${q.after}` : sql``}`,
            [order],
            sql`LIMIT ${q.limit + 1} OFFSET ${((q.page ?? 1) - 1) * q.limit}`,
          ),
        ),
        // The cursor only moves through the matches, so the total leaves it out.
        count(this.db, matching),
      ]);
      return { rows: found, total };
    }

    // One extra row tells the controller whether another page exists.
    const result = await searchPage<ListedUser & Record<string, unknown>>(this.db, {
      q: q.q,
      columns: [sql`u.display_name`, sql`u.email`],
      where: filters,
      orderBy: [order],
      limit: q.limit + 1,
      offset: ((q.page ?? 1) - 1) * q.limit,
      // Run on `tx`, not this.db: fuzzy mode sets its similarity threshold for that transaction only.
      rows: (tx, p) =>
        rows(tx, select(p.where, p.orderBy, sql`LIMIT ${p.limit} OFFSET ${p.offset}`)),
      count,
    });
    return { rows: result.rows, total: result.total };
  }

  listFlagged(scope: TxScope): Promise<FlaggedUserRow[]> {
    return rows<FlaggedUserRow>(
      this.db,
      sql`SELECT u.id, u.email, u.display_name AS "displayName", u.status,
            to_char(u.identity_review_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "flaggedAt"
          ${STAFF_USERS}
          WHERE u.tenant_id = ${scope.tenantId} AND u.identity_review_required
          ORDER BY u.identity_review_at DESC NULLS LAST, u.id
          LIMIT 200`,
    );
  }

  async summary(scope: TxScope): Promise<StaffSummary> {
    const [summary] = await rows<StaffSummary>(
      this.db,
      sql`SELECT count(*)::int AS total,
            (count(*) FILTER (WHERE u.status = 'active'))::int AS active,
            (count(*) FILTER (WHERE u.status = 'invited'))::int AS invited,
            (count(*) FILTER (WHERE u.status = 'inactive'))::int AS deactivated,
            coalesce((SELECT jsonb_agg(jsonb_build_object('id', d.id, 'name', d.name)
                        ORDER BY lower(d.name), d.id)
              FROM app.departments d WHERE d.tenant_id = ${scope.tenantId}
                AND d.organization_id = ${scope.organizationId}), '[]'::jsonb) AS departments
          ${STAFF_USERS}
          WHERE u.tenant_id = ${scope.tenantId}`,
    );
    return summary!;
  }

  recordActivity(scope: TxScope, actor: Actor): Promise<void> {
    return withTx(
      this.db,
      scope,
      actor,
      async (tx) => {
        await tx.execute(sql`SET LOCAL statement_timeout = '500ms'`);
        // The WHERE clause is rechecked by Postgres after a concurrent update, so this is also
        // the throttle across API instances. The timestamp is independent of profile updated_at.
        await tx.execute(sql`UPDATE app.users SET last_active_at = now()
        WHERE tenant_id = ${scope.tenantId} AND id = ${actor.id} AND status = 'active'
          AND (last_active_at IS NULL OR last_active_at < now() - interval '5 minutes')`);
        // 'lazy': last_active_at is ignored by the audit trigger (0041), so this never takes the tenant audit lock.
      },
      { audit: 'lazy' },
    );
  }

  async recordEvent(e: ZitadelEventKey): Promise<boolean> {
    // ops.* has no tenancy and no audit trigger, so this is a plain statement, not withTx.
    const inserted = await rows<{ one: number }>(
      this.db,
      sql`INSERT INTO ops.zitadel_events (instance_id, aggregate_id, sequence, event_type, received_at)
          VALUES (${e.instanceId}, ${e.aggregateId}, ${e.sequence}, ${e.eventType}, now())
          ON CONFLICT (instance_id, aggregate_id, sequence) DO NOTHING
          RETURNING 1 AS one`,
    );
    return inserted.length > 0;
  }

  async markInvitePending(zitadelUserId: string): Promise<void> {
    await this.setCursor(invitePendingName(zitadelUserId), 'pending');
  }
  async clearInvitePending(tx: DbTransaction, zitadelUserId: string): Promise<void> {
    await tx.execute(
      sql`UPDATE ops.sync_cursors SET cursor = 'done', updated_at = now() WHERE name = ${invitePendingName(zitadelUserId)}`,
    );
  }
  async isInvitePending(zitadelUserId: string): Promise<boolean> {
    return (await this.getCursor(invitePendingName(zitadelUserId))) === 'pending';
  }

  async getCursor(name: string): Promise<string | null> {
    const [row] = await rows<{ cursor: string | null }>(
      this.db,
      sql`SELECT cursor FROM ops.sync_cursors WHERE name = ${name}`,
    );
    return row?.cursor ?? null;
  }

  async claimFounderLeaseWithOrigin(
    tenantId: string,
    leaseId: string,
    ttlSeconds: number,
    timeoutMs: number,
  ): Promise<{ claimed: boolean; ttlTakeover: boolean }> {
    // The statement may wait on the row of a holder that is releasing it; it never waits longer than the caller's own
    // wait for the lease, so that wait is real. A timeout counts as "not claimed".
    const ms = Math.max(100, Math.floor(timeoutMs));
    try {
      return await this.db.transaction(async (tx) => {
        await tx.execute(sql.raw(`SET LOCAL statement_timeout = ${ms}`));
        await tx.execute(sql.raw(`SET LOCAL lock_timeout = ${ms}`));
        // Read under the row lock the claim below takes anyway, so the age seen here is the age the claim tests: a
        // takeover is a lease another holder still shows (not free, not ours) that is older than the TTL.
        const [before] = await rows<{ ttl: boolean }>(
          tx,
          sql`SELECT (updated_at < now() - make_interval(secs => ${ttlSeconds})
                      AND NOT (cursor = ${FOUNDER_LEASE_FREE}
                               OR starts_with(cursor, ${FOUNDER_LEASE_FREE + FOUNDER_REMOVAL_SEPARATOR}::text)
                               OR cursor = ${leaseId}
                               OR starts_with(cursor, ${leaseId + FOUNDER_REMOVAL_SEPARATOR}::text))) AS ttl
                FROM ops.sync_cursors WHERE name = ${founderLeaseName(tenantId)} FOR UPDATE`,
        );
        // The cursor is `free` or a lease id, optionally followed by `|<outstanding removal>`: a claim keeps that
        // suffix, so a removal its holder never cleared passes to the next holder with the lease.
        const claimed = await rows<{ name: string }>(
          tx,
          sql`INSERT INTO ops.sync_cursors (name, cursor, updated_at)
              VALUES (${founderLeaseName(tenantId)}, ${leaseId}, now())
              ON CONFLICT (name) DO UPDATE
                SET cursor = EXCLUDED.cursor || (${REMOVAL_SUFFIX}), updated_at = EXCLUDED.updated_at
              WHERE ops.sync_cursors.cursor = ${FOUNDER_LEASE_FREE}
                 OR starts_with(ops.sync_cursors.cursor, ${FOUNDER_LEASE_FREE + FOUNDER_REMOVAL_SEPARATOR}::text)
                 OR ops.sync_cursors.cursor = EXCLUDED.cursor
                 OR starts_with(ops.sync_cursors.cursor, EXCLUDED.cursor || ${FOUNDER_REMOVAL_SEPARATOR}::text)
                 OR ops.sync_cursors.updated_at < now() - make_interval(secs => ${ttlSeconds})
              RETURNING name`,
        );
        return { claimed: claimed.length > 0, ttlTakeover: claimed.length > 0 && before?.ttl === true };
      });
    } catch (error) {
      const code =
        (error as { code?: string; cause?: { code?: string } }).code ??
        (error as { cause?: { code?: string } }).cause?.code;
      if (code === '57014' || code === '55P03') return { claimed: false, ttlTakeover: false };
      throw error;
    }
  }
  async releaseFounderLease(tenantId: string, leaseId: string): Promise<void> {
    await this.db.execute(
      sql`UPDATE ops.sync_cursors SET cursor = ${FOUNDER_LEASE_FREE}::text || (${REMOVAL_SUFFIX}), updated_at = now()
          WHERE name = ${founderLeaseName(tenantId)} AND ${heldBy(leaseId)}`,
    );
  }
  async recordFounderRemoval(
    tenantId: string,
    leaseId: string,
    removal: PendingFounderRemoval,
  ): Promise<boolean> {
    // Only on a lease with no outstanding removal: the holder settles an inherited one before it starts.
    const recorded = await rows<{ name: string }>(
      this.db,
      sql`UPDATE ops.sync_cursors SET cursor = ${leaseId + encodeFounderRemoval(removal)}::text
          WHERE name = ${founderLeaseName(tenantId)} AND cursor = ${leaseId}
          RETURNING name`,
    );
    return recorded.length > 0;
  }
  async outstandingFounderRemoval(
    tenantId: string,
    leaseId: string,
  ): Promise<PendingFounderRemoval | null> {
    const cursor = await this.getCursor(founderLeaseName(tenantId));
    if (cursor === null || !cursor.startsWith(leaseId + FOUNDER_REMOVAL_SEPARATOR)) return null;
    return parseFounderRemoval(cursor);
  }
  async settleFounderRemoval(
    tenantId: string,
    leaseId: string,
    q: Queryable = this.db,
  ): Promise<boolean> {
    const held = await rows<{ name: string }>(
      q,
      sql`UPDATE ops.sync_cursors SET cursor = ${leaseId}
          WHERE name = ${founderLeaseName(tenantId)} AND ${heldBy(leaseId)}
          RETURNING name`,
    );
    return held.length > 0;
  }
  async setCursor(name: string, cursor: string): Promise<void> {
    await this.db.execute(
      sql`INSERT INTO ops.sync_cursors (name, cursor, updated_at) VALUES (${name}, ${cursor}, now())
          ON CONFLICT (name) DO UPDATE SET cursor = EXCLUDED.cursor, updated_at = EXCLUDED.updated_at`,
    );
  }
}
