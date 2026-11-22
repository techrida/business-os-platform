// The k-users core: keeps app.users and app.user_roles equal to what ZITADEL says.
// Serves the NFR "role assignment has one source of truth" (P1-PLAN §1): ZITADEL grants are the
// truth, this file only mirrors them so approver lookups (userIdsWithRole) work without a token.
//
// Three ways in, all ending in the same apply(): the webhook (users.sync job), the 10-minute
// reconcile (the backstop for lost webhooks), and the JIT insert on a user's first request.
// It imports nothing from platform/authz at runtime (only the port's types), so the worker (which
// has no AuthzModule) can use it.
//
// ADR 0027: users are tenant-scoped. A ZITADEL org maps to app.idp_orgs; a staff user acts for the
// legal entities listed in app.user_entities, and a new staff user gets one membership in the
// tenant's default entity (the bootstrap rule). Writes run with the default entity as the withTx
// scope, because the audit fallback for tenant-scoped rows reads bos.organization_id.
import { ACCOUNT_LOCKOUT, type AdminUsersQuery, type RoleKey } from '@bos/contracts';
import { InjectQueue } from '@nestjs/bullmq';
import { ConflictException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Queue } from 'bullmq';

import { lockAccessRevision } from '../../modules/access-settings/access-revision';
import { AuditService } from '../audit/audit.service';
import type { EntityMembership, ResolvedUser } from '../authz/user-directory';
import { DB, type Db, type DbTransaction } from '../db/db.module';
import { type Actor, READ_ONLY, type TxOptions, type TxScope, systemActor, withTx } from '../db/tx';
import { IdentityReconciler, withFounderRemovalLease } from './identity-reconcile';
import {
  lockoutPinnedCursor,
  USERS_QUEUE,
  USERS_SYNC_JOB,
  type UsersSyncData,
} from './users.constants';
import {
  type IdpOrgRow,
  type ListedUsers,
  type UserLock,
  type UserRow,
  UsersStore,
} from './users.store';
import {
  ZitadelAdminClient,
  ZitadelHttpError,
  type MirroredStatus,
  ZitadelNotConfiguredError,
  type ZitadelUser,
} from './zitadel-admin.client';

/** The audit actor for everything that arrives from ZITADEL (hook, sync, reconcile, JIT). */
const zitadelActor = () => systemActor('zitadel');
// For a write that takes the access-revision lock and/or a user row lock before its first audited write:
// keeps lock order consistent (access_revisions -> user row -> audit.chain) with DepartmentsAdminService,
// AccessSettingsService, UserStatusService and UserLocks so concurrent writes cannot invert into 40P01.
const LOCKS_USER_ROW: TxOptions = { audit: 'lazy' };

function userChangedConflict(): ConflictException {
  return new ConflictException({
    code: 'conflict',
    message: 'This user was changed by someone else. Reload the page and try again.',
  });
}

const cursorName = (zitadelOrgId: string) => `users.reconcile:${zitadelOrgId}`;

/**
 * Hard stops for one reconcile pass. 200 pages of 100 is 20,000 users in one org, far above any real
 * org here; a walk that long means ZITADEL is not paging (offset ignored, endless list), not growth.
 * Twenty deactivations per pass is far above normal churn between two 10-minute passes; more than
 * that looks like a bug or an attack on the mirror, so it stops and waits for a human to look.
 */
const MAX_PAGES = 200;
const MAX_DEACTIVATIONS_PER_PASS = 20;

/** Tries of one apply when the row keeps changing between the read and the write. */
const APPLY_ATTEMPTS = 3;

/**
 * apply gave up: the user's row changed between the read and the write on every one of its APPLY_ATTEMPTS tries.
 * Not the same as "nothing to change": a sync job fails on it, so the queue tries the job again, and a reconcile
 * pass logs it and goes on with the next user (who stays seen, so never a deactivation candidate).
 */
export class UserSyncContendedError extends Error {
  override readonly name = 'UserSyncContendedError';

  constructor(readonly zitadelUserId: string) {
    super(`users.apply: ${zitadelUserId} kept changing while it was synced`);
  }
}

/** What apply writes for one ZITADEL user: the user as read, the status to store and the lock (undefined keeps it). */
interface NextState {
  user: ZitadelUser;
  status: MirroredStatus;
  lock: UserLock | null | undefined;
}

export interface ReconcileLimits {
  maxPages?: number;
  maxDeactivations?: number;
}

function sameRoles(a: readonly string[], b: readonly string[]): boolean {
  const left = [...new Set(a)].sort();
  const right = [...new Set(b)].sort();
  return left.length === right.length && left.every((v, i) => v === right[i]);
}

export type { EntityMembership, ResolvedUser };

export interface InviteInput {
  email: string;
  givenName: string;
  familyName: string;
  roles: RoleKey[];
}

/** A person an invite reached: the app row, their ZITADEL identity, and whether this invite created it. */
export interface InvitedUser {
  userId: string;
  zitadelUserId: string;
  /** False when the invite finished an earlier open invite (the identity existed before this request). */
  created: boolean;
}

/**
 * The legal entities whose only effective Founder is `userId`, joined for a message, or null when there is none.
 * Per entity, not company-wide: an entity whose only Founder this is would be left with none, even when other entities
 * still have Founders. The caller holds the access-revision lock, so two removals cannot both see the other Founder.
 */
export async function soleFounderEntities(
  q: DbTransaction,
  store: UsersStore,
  tenantId: string,
  userId: string,
): Promise<string | null> {
  const founders = await store.effectiveRoleHolders(q, tenantId, 'founder');
  const orphaned = founders.filter(
    (f) =>
      f.userId === userId &&
      !founders.some((o) => o.organizationId === f.organizationId && o.userId !== userId),
  );
  return orphaned.length > 0 ? orphaned.map((f) => f.entityName).join(', ') : null;
}

@Injectable()
export class UserMirror {
  private readonly logger = new Logger(UserMirror.name);
  private readonly reconciler: IdentityReconciler;

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly store: UsersStore,
    private readonly zitadel: ZitadelAdminClient,
    @InjectQueue(USERS_QUEUE) private readonly queue: Queue<UsersSyncData>,
  ) {
    this.reconciler = new IdentityReconciler(db, store, zitadel, new AuditService(db));
  }

  /**
   * Re-fetches one user and their grants from ZITADEL and upserts the mirror. Returns whether
   * anything changed. A user ZITADEL reports as inactive is deactivated by apply().
   *
   * `getUser` returning nothing is NOT proof the user was deleted: the provisioner token only sees
   * the orgs it is a member of, so a customer or vendor user looks "not found" to it. Deactivating
   * on that locked every portal persona out on the real stack (2026-11-08). Only a complete
   * reconcile pass of the user's org may deactivate a user who is missing from ZITADEL.
   *
   * Throws UserSyncContendedError when the row kept changing under every try, so the job is retried.
   */
  async syncUser(zitadelUserId: string): Promise<boolean> {
    const user = await this.zitadel.getUser(zitadelUserId);
    if (!user) {
      this.logger.warn(`users.sync: ZITADEL did not return ${zitadelUserId}; left unchanged`);
      return false;
    }

    const org = await this.store.idpOrgByZitadelId(user.orgId);
    if (!org) {
      // P2 adds org sync; until then a user of an unknown org has nowhere to live.
      this.logger.warn(`users.sync skipped ${zitadelUserId}: its org has no app.idp_orgs row`);
      return false;
    }
    const roles = await this.zitadel.listGrants(zitadelUserId, org.zitadelOrgId);
    return this.apply(org, user, roles);
  }

  /**
   * Walks every staff IdP org page by page and upserts each user. A user missing from a COMPLETE and
   * TRUSTWORTHY pass of its org is a deactivation candidate (see deactivateMissing). A partial pass
   * (a page failed, or the run resumed from a saved cursor) is not proof of absence, so it
   * deactivates nobody; the next full pass will.
   *
   * The listing is only trusted when it shows signs of paging correctly. ZITADEL's offset and page
   * size are unverified, so a pass aborts (no deactivations, error logged, cursor reset) when it
   * hits the page cap, when a page repeats the previous page, or when ZITADEL's own totalResult
   * disagrees with the number of distinct users collected. Without that, a server that ignored the
   * offset would make every user beyond the first page look "missing".
   */
  async reconcile(limits: ReconcileLimits = {}): Promise<{ scanned: number; changed: number }> {
    const maxPages = limits.maxPages ?? MAX_PAGES;
    const maxDeactivations = limits.maxDeactivations ?? MAX_DEACTIVATIONS_PER_PASS;
    let scanned = 0;
    let changed = 0;
    for (const org of await this.store.listStaffIdpOrgs()) {
      const name = cursorName(org.zitadelOrgId);
      const start = await this.store.getCursor(name);
      const fullPass = start === null || start === '0';
      // Taken before the first page: anyone created in ZITADEL after this is not "missing", just new.
      const passStart = new Date();
      const seen = new Set<string>();
      let cursor: string | null = fullPass ? null : start;
      let pages = 0;
      let previousIds = new Set<string>();
      let total: number | null = null;
      let abort: string | null = null;
      try {
        for (;;) {
          if (pages >= maxPages) {
            abort = `hit the page cap of ${maxPages} pages`;
            break;
          }
          pages += 1;
          const page = await this.zitadel.listUsers(org.zitadelOrgId, cursor);
          if (page.users.length > 0 && page.users.every((u) => previousIds.has(u.id))) {
            abort = 'a page repeated the previous page (ZITADEL may be ignoring the offset)';
            break;
          }
          previousIds = new Set(page.users.map((u) => u.id));
          total = page.totalResult ?? null;
          for (const user of page.users) {
            scanned += 1;
            seen.add(user.id);
            const roles = await this.zitadel.listGrants(user.id, org.zitadelOrgId);
            try {
              if (await this.apply(org, user, roles)) changed += 1;
            } catch (error) {
              if (!(error instanceof UserSyncContendedError)) throw error;
              // This user only: the pass goes on, and they are seen, so never deactivated as missing.
              this.logger.warn(`${error.message}; left for the next pass`);
            }
          }
          if (page.nextCursor === null) break;
          cursor = page.nextCursor;
          // Saved after each page, so a crash resumes here instead of starting the org over.
          await this.store.setCursor(name, cursor);
        }
      } catch (error) {
        if (error instanceof ZitadelNotConfiguredError) {
          this.logger.warn(`users.reconcile skipped: ${error.message}`);
          return { scanned, changed };
        }
        this.logger.error(
          `users.reconcile failed for org ${org.zitadelOrgId}: ${(error as Error).message}`,
        );
        continue;
      }
      // Reset in every non-error outcome, so an aborted pass restarts the org instead of resuming
      // from a cursor a misbehaving ZITADEL handed out.
      await this.store.setCursor(name, '0');
      if (abort === null && fullPass && total !== null && seen.size !== total) {
        abort = `collected ${seen.size} users but ZITADEL reports ${total}`;
      }
      if (abort !== null) {
        this.logger.error(
          `users.reconcile aborted for org ${org.zitadelOrgId}: ${abort}; no users deactivated`,
        );
        continue;
      }
      if (fullPass) changed += await this.deactivateMissing(org, seen, passStart, maxDeactivations);
    }
    return { scanned, changed };
  }

  /**
   * UserDirectory.resolve: the app user behind a verified token. The first request of a user the
   * webhook has not delivered yet inserts a minimal active row (JIT) and asks for a full sync.
   *
   * An `invited` row behind a valid token is an accepted invite: ZITADEL only issues tokens to
   * users that finished it, and can() denies `invited`. So the row turns active here instead of
   * waiting up to 10 minutes for the webhook or the reconcile.
   */
  async resolve(i: {
    zitadelUserId: string;
    tenantId: string;
    idpOrgId: string;
  }): Promise<ResolvedUser> {
    let row = await this.store.findByZitadelId(this.db, i.zitadelUserId);
    if (!row) {
      const org = await this.store.idpOrgById(i.idpOrgId);
      if (!org || org.tenantId !== i.tenantId) throw new Error('JIT user insert: unknown IdP org');
      const scope = await this.entityScope(org.tenantId);
      await withTx(
        this.db,
        scope,
        zitadelActor(),
        async (tx) => {
          const userId = await this.store.insertUser(tx, scope, {
            zitadelUserId: i.zitadelUserId,
            idpOrgId: org.idpOrgId,
            email: null,
            displayName: null,
            status: 'active',
          });
          await this.bootstrap(tx, org, scope, userId);
        },
        LOCKS_USER_ROW,
      );
      await this.enqueueSync(i.zitadelUserId);
      row = await this.store.findByZitadelId(this.db, i.zitadelUserId);
      if (!row) throw new Error('JIT user insert left no row');
    } else if (row.status === 'invited') {
      const invited = row;
      await withTx(
        this.db,
        await this.entityScope(invited.tenantId),
        zitadelActor(),
        (tx) =>
          this.store.updateUser(tx, invited.id, {
            email: invited.email,
            displayName: invited.displayName,
            status: 'active',
          }),
        LOCKS_USER_ROW,
      );
      await this.enqueueSync(i.zitadelUserId);
      row = { ...invited, status: 'active' };
    }
    return {
      userId: row.id,
      tenantId: row.tenantId,
      idpOrgId: row.idpOrgId,
      status: row.status,
      memberships: await this.store.membershipsOf(this.db, row.tenantId, row.id),
    };
  }

  /**
   * A Valkey hiccup must not fail the user's request: the reconcile fills the row in anyway. Retried like the hook's
   * job (hooks.controller.ts), so a sync that lost to concurrent writes (UserSyncContendedError) runs again.
   */
  private async enqueueSync(zitadelUserId: string): Promise<void> {
    await this.queue
      .add(
        USERS_SYNC_JOB,
        { zitadelUserId },
        {
          attempts: 5,
          backoff: { type: 'exponential', delay: 2_000 },
          removeOnComplete: 100,
          removeOnFail: 500,
        },
      )
      .catch((error: Error) => this.logger.warn(`users.sync enqueue failed: ${error.message}`));
  }

  userIdsWithRole(scope: TxScope, role: RoleKey, q?: Db | DbTransaction): Promise<string[]> {
    return this.store.userIdsWithRole(scope, role, q);
  }

  emailOf(userId: string, q?: Db | DbTransaction): Promise<string | null> {
    return this.store.emailOf(userId, q);
  }

  list(scope: TxScope, q: AdminUsersQuery): Promise<ListedUsers> {
    return this.store.list(scope, q);
  }

  /** Writes the mirror row, default membership and roles for an invitee inside the caller's tx. */
  async writeInvitedUser(
    tx: DbTransaction,
    org: IdpOrgRow,
    scope: TxScope,
    zitadelUserId: string,
    b: InviteInput,
  ): Promise<string> {
    const userId = await this.store.insertUser(tx, scope, {
      zitadelUserId,
      idpOrgId: org.idpOrgId,
      email: b.email,
      displayName: `${b.givenName} ${b.familyName}`,
      status: 'invited',
    });
    await this.bootstrap(tx, org, scope, userId);
    if (b.roles.length > 0) {
      await this.store.replaceRoles(tx, scope, userId, b.roles);
      await this.store.bumpAuthzVersion(tx, scope);
    }
    return userId;
  }

  /**
   * After an invite's database write failed: shrinks the person's grants in ZITADEL to what the database still allows
   * and they held before the invite (see IdentityReconciler.reconcileRoles), and never deletes the identity (FU8: a
   * concurrent invite may have committed it). A fresh identity with no row ends with no roles, still an open invite that
   * a retry of the same invite finishes. A row means a concurrent invite committed the identity: it is left alone.
   * Never throws.
   */
  async reconcileFailedInvite(
    scope: TxScope,
    actor: Actor,
    org: IdpOrgRow,
    invited: { zitadelUserId: string; created: boolean; previousGrants?: readonly RoleKey[] },
    requested: readonly RoleKey[],
  ): Promise<void> {
    await this.reconciler.reconcileRoles(scope, actor, {
      zitadelUserId: invited.zitadelUserId,
      zitadelOrgId: org.zitadelOrgId,
      idpOrgId: org.idpOrgId,
      requested,
      previous: invited.created ? [] : (invited.previousGrants ?? []),
      skipWhenRowExists: invited.created,
    });
  }

  /**
   * Sets a staff user's roles with ZITADEL called outside any transaction: (A) guard + version/roles snapshot tx,
   * (B) ZITADEL setGrants, (C) re-checked versioned write tx. On failure or conflict it never writes a stored snapshot
   * back: it reads ZITADEL and the committed roles as they are now and keeps only roles both still hold that this
   * request did not add (IdentityReconciler.reconcileRoles), so a role another admin just revoked is never granted
   * again. A role set runs under the tenant's Founder-removal lease (see user-status.ts). The caller
   * invalidates authz after this resolves.
   */
  async setRoles(
    scope: TxScope,
    actor: Actor,
    userId: string,
    roles: RoleKey[],
    assertAccess?: (tx: DbTransaction) => Promise<void>,
  ): Promise<void> {
    return withFounderRemovalLease(this.store, scope.tenantId, () =>
      this.setRolesOnce(scope, actor, userId, roles, assertAccess),
    );
  }

  private async setRolesOnce(
    scope: TxScope,
    actor: Actor,
    userId: string,
    roles: RoleKey[],
    assertAccess?: (tx: DbTransaction) => Promise<void>,
  ): Promise<void> {
    const plan = await withTx(
      this.db,
      scope,
      actor,
      async (tx) => {
        await lockAccessRevision(tx, scope.tenantId);
        if (assertAccess) await assertAccess(tx);
        const org = await this.staffOrgOf(scope, tx);
        const user = await this.store.findById(tx, scope, userId);
        // Staff roles are granted in the staff org: a portal user is not an admin target (as before 0027).
        if (!user || user.idpOrgId !== org.idpOrgId) throw new NotFoundException('User not found');
        const previousRoles = await this.store.rolesOf(tx, scope.tenantId, userId);
        await this.assertCanSetRoles(tx, scope.tenantId, user, previousRoles, roles);
        return { user, org, previousRoles };
      },
      READ_ONLY,
    );

    await this.zitadel.setGrants(plan.user.zitadelUserId, plan.org.zitadelOrgId, roles);

    try {
      await withTx(
        this.db,
        scope,
        actor,
        async (tx) => {
          await lockAccessRevision(tx, scope.tenantId);
          if (assertAccess) await assertAccess(tx);
          const current = await this.store.findById(tx, scope, userId, true);
          if (!current || current.idpOrgId !== plan.org.idpOrgId) throw userChangedConflict();
          const currentRoles = await this.store.rolesOf(tx, scope.tenantId, userId);
          const rowChanged = (current.version ?? null) !== (plan.user.version ?? null);
          const rolesChanged = !sameRoles(currentRoles, plan.previousRoles);
          if (rowChanged || rolesChanged) {
            // Another writer already landed the exact roles requested while ZITADEL was called.
            if (!rowChanged && sameRoles(currentRoles, roles)) return;
            throw userChangedConflict();
          }
          await this.assertCanSetRoles(tx, scope.tenantId, current, currentRoles, roles);
          if (!sameRoles(currentRoles, roles)) {
            await this.store.replaceRoles(tx, scope, userId, roles);
            await this.store.bumpAuthzVersion(tx, scope);
          }
        },
        LOCKS_USER_ROW,
      );
    } catch (error) {
      await this.reconciler.reconcileRoles(scope, actor, {
        zitadelUserId: plan.user.zitadelUserId,
        zitadelOrgId: plan.org.zitadelOrgId,
        idpOrgId: plan.org.idpOrgId,
        requested: roles,
        previous: plan.previousRoles,
        skipWhenNoRow: true,
      });
      throw error;
    }
  }

  private async assertCanSetRoles(
    tx: DbTransaction,
    tenantId: string,
    user: UserRow,
    currentRoles: readonly RoleKey[],
    nextRoles: readonly RoleKey[],
  ): Promise<void> {
    if (
      user.status !== 'active' ||
      !currentRoles.includes('founder') ||
      nextRoles.includes('founder')
    ) {
      return;
    }
    const entities = await soleFounderEntities(tx, this.store, tenantId, user.id);
    if (entities === null) return;
    // Never the email: the address is not a name (U20a2-Q10).
    const name = user.displayName?.trim() || 'This person';
    throw new ConflictException({
      code: 'last_founder',
      message: `${name} is the only Founder of ${entities}. Make someone else a Founder there first.`,
    });
  }

  /** The one write path for ZITADEL data: upsert the user, mirror the roles, bump authz on change. */
  private async apply(
    org: IdpOrgRow,
    read: ZitadelUser,
    roles: readonly RoleKey[],
  ): Promise<boolean> {
    if (read.status === null) {
      // A state we cannot read must never lock anyone out or let anyone in: write nothing at all.
      this.logger.warn(
        `users.apply skipped ${read.id}: unknown state from ZITADEL; left unchanged`,
      );
      return false;
    }
    const scope = await this.entityScope(org.tenantId);
    for (let attempt = 1; ; attempt += 1) {
      const seen = await this.store.findByZitadelId(this.db, read.id);
      const next = await this.nextState(org, seen, read, read.status);
      // ZITADEL was read with no transaction open. The write goes ahead only while the row is still the version read
      // before that, so an admin action or another sync that committed in between is never overwritten.
      const changed = await withTx(
        this.db,
        scope,
        zitadelActor(),
        async (tx) => {
          const existing = await this.store.findByZitadelId(tx, read.id, true);
          if ((existing?.version ?? null) !== (seen?.version ?? null)) return null;
          return this.write(tx, org, scope, existing, next, roles);
        },
        LOCKS_USER_ROW,
      );
      if (changed !== null) return changed;
      if (attempt >= APPLY_ATTEMPTS) throw new UserSyncContendedError(read.id);
    }
  }

  /** What to write for `read`, worked out with no transaction open. */
  private async nextState(
    org: IdpOrgRow,
    existing: UserRow | null,
    read: ZitadelUser,
    readStatus: MirroredStatus,
  ): Promise<NextState> {
    let user = read;
    let status = readStatus;
    let lockConfirmed = true;
    if (
      existing &&
      (existing.status !== status || Boolean(existing.lockReason) !== Boolean(user.locked))
    ) {
      // `user` may have been read before `existing`. An admin status action may have finished in between, and
      // writing the older state back would undo it: a deactivated leaver active again until the next pass. So a
      // status or lock change is re-read now, after `existing`; apply writes only if the row is still that version.
      const fresh = await this.zitadel.getUser(user.id).catch(() => null);
      if (fresh?.status) {
        user = fresh;
        status = fresh.status;
      } else {
        // Unconfirmed: the stored lock stays as it is.
        lockConfirmed = false;
        if (status === 'active' || status === 'invited') {
          // Unconfirmed, and it would let someone in: leave the row for the next pass.
          this.logger.warn(`users.apply: could not confirm ${user.id}; status left unchanged`);
          status = existing.status;
        }
      }
    }
    const lock = lockConfirmed ? await this.lockChange(org, existing, user) : undefined;
    return { user, status, lock };
  }

  private async write(
    tx: DbTransaction,
    org: IdpOrgRow,
    scope: TxScope,
    existing: UserRow | null,
    next: NextState,
    roles: readonly RoleKey[],
  ): Promise<boolean> {
    const { user, status, lock } = next;
    let changed = false;
    let userId: string;
    if (!existing) {
      userId = await this.store.insertUser(tx, scope, {
        zitadelUserId: user.id,
        idpOrgId: org.idpOrgId,
        email: user.email,
        displayName: user.displayName,
        status,
      });
      if (lock) {
        await this.store.updateUser(tx, userId, {
          email: user.email,
          displayName: user.displayName,
          status,
          lock,
        });
      }
      await this.bootstrap(tx, org, scope, userId);
      changed = true;
    } else {
      userId = existing.id;
      const statusChanged = existing.status !== status;
      if (
        existing.email !== user.email ||
        existing.displayName !== user.displayName ||
        existing.status !== status ||
        lock !== undefined
      ) {
        await this.store.updateUser(tx, userId, {
          email: user.email,
          displayName: user.displayName,
          status,
          ...(lock === undefined ? {} : { lock }),
        });
        // A status change (disabled, re-enabled) reaches every request at once: the per-request user cache
        // is keyed on the authz version, so without a bump a disabled user stays active for up to 60 s.
        if (statusChanged) await this.store.bumpAuthzVersion(tx, scope);
        changed = true;
      }
    }
    if (!sameRoles(await this.store.rolesOf(tx, scope.tenantId, userId), roles)) {
      await this.store.replaceRoles(tx, scope, userId, roles);
      await this.store.bumpAuthzVersion(tx, scope);
      changed = true;
    }
    return changed;
  }

  /**
   * The lock to write for what ZITADEL says (F1-Q4), or undefined to keep the stored one. A user ZITADEL no longer
   * holds locked has the stored lock cleared.
   *
   * A lock the app did not write is an `admin` lock, which never ends by itself: someone locked the person in the
   * ZITADEL console (every lock from before the lockout policy existed is one of those), or an app lock whose
   * database write was lost. Only a lock that can be the lockout policy at work becomes a `failed_sign_ins` lock that
   * the lock-expiry job ends: ZITADEL changed the user (`details.changeDate`) after the policy was pinned on the
   * org (UserLocks.ensureLockoutPolicies stores when) and within one lock window of now. That lock ends one window
   * after the change date. Wrongly calling a console lock timed would let the person back in, so every doubt
   * (no change date, no pin, an old change) keeps the person locked.
   */
  private async lockChange(
    org: IdpOrgRow,
    existing: UserRow | null,
    read: ZitadelUser,
  ): Promise<UserLock | null | undefined> {
    const stored = existing?.lockReason ?? null;
    if (!read.locked) return stored !== null ? null : undefined;
    if (stored !== null) return undefined;
    const now = new Date();
    const changedAt = read.changedAt && read.changedAt <= now ? read.changedAt : null;
    const pinned = await this.store.getCursor(lockoutPinnedCursor(org.zitadelOrgId));
    const pinnedAt = pinned ? Date.parse(pinned) : Number.NaN;
    const window = ACCOUNT_LOCKOUT.lockMinutes * 60_000;
    if (
      changedAt !== null &&
      !Number.isNaN(pinnedAt) &&
      changedAt.getTime() >= pinnedAt &&
      now.getTime() - changedAt.getTime() < window
    ) {
      return {
        reason: 'failed_sign_ins',
        lockedAt: changedAt,
        until: new Date(changedAt.getTime() + window),
      };
    }
    return { reason: 'admin', lockedAt: changedAt ?? now, until: null };
  }

  /**
   * The org's local users the pass did not see are only CANDIDATES. Each is asked about directly,
   * and only a definite "inactive" answer deactivates it: not found (maybe just invisible to the
   * provisioner token), an unknown state, an active user the listing missed, and a user created
   * after the pass started all stay as they are. At most `max` are deactivated per pass.
   *
   * Known gap: a user deleted in ZITADEL answers "not found", so reconcile never deactivates it
   * any more; an admin must deactivate it by hand until deletion events are mirrored.
   */
  private async deactivateMissing(
    org: IdpOrgRow,
    seen: ReadonlySet<string>,
    passStart: Date,
    max: number,
  ): Promise<number> {
    const locals = await this.store.notInactiveInIdpOrg(this.db, org);
    const missing = locals.filter((u) => !seen.has(u.zitadelUserId));
    if (seen.size === 0 && missing.length > 0) {
      // Safeguard: an empty list for an org that has users is far more likely a token that cannot
      // see the org than a real mass deletion. Refuse to lock everyone out on that evidence.
      this.logger.warn(
        `users.reconcile: ZITADEL listed no users for org ${org.zitadelOrgId}; not deactivating ${missing.length}`,
      );
      return 0;
    }
    let deactivated = 0;
    for (const [index, local] of missing.entries()) {
      if (deactivated >= max) {
        this.logger.warn(
          `users.reconcile: deactivation cap of ${max} reached for org ${org.zitadelOrgId}; ${missing.length - index} candidates left for a later pass`,
        );
        break;
      }
      const remote = await this.confirm(local.zitadelUserId);
      if (!remote) continue;
      if (remote.createdAt && remote.createdAt >= passStart) continue; // newer than the pass
      if (remote.status === null) {
        this.logger.warn(
          `users.reconcile: ${local.zitadelUserId} has an unknown state in ZITADEL; left unchanged`,
        );
        continue;
      }
      if (remote.status !== 'inactive') continue;
      await this.deactivate(local);
      deactivated += 1;
    }
    return deactivated;
  }

  /** One candidate's own record, or null when it cannot be confirmed (not found or the call failed). */
  private async confirm(zitadelUserId: string): Promise<ZitadelUser | null> {
    try {
      const user = await this.zitadel.getUser(zitadelUserId);
      if (!user) {
        this.logger.warn(
          `users.reconcile: ZITADEL does not return ${zitadelUserId}; left unchanged`,
        );
      }
      return user;
    } catch (error) {
      this.logger.warn(
        `users.reconcile: could not confirm ${zitadelUserId}: ${(error as Error).message}; left unchanged`,
      );
      return null;
    }
  }

  private async deactivate(user: UserRow): Promise<void> {
    const scope = await this.entityScope(user.tenantId);
    await withTx(
      this.db,
      scope,
      zitadelActor(),
      async (tx) => {
        await this.store.updateUser(tx, user.id, {
          email: user.email,
          displayName: user.displayName,
          status: 'inactive',
        });
        // Bump the authz version so the per-request user cache drops the user at once (see apply).
        await this.store.bumpAuthzVersion(tx, scope);
      },
      LOCKS_USER_ROW,
    );
  }

  /** The tenant's staff IdP org: invites are created and grants are set there. */
  private async staffOrgOf(scope: TxScope, q?: Db | DbTransaction): Promise<IdpOrgRow> {
    const org = await this.store.staffIdpOrgOf(scope.tenantId, q);
    if (!org) throw new NotFoundException('Organization not found');
    return org;
  }

  /**
   * The withTx scope for a user write: the tenant and its default entity. users and user_roles have
   * no organization_id, so their audit rows take bos.organization_id from this scope.
   */
  private async entityScope(tenantId: string): Promise<TxScope> {
    const organizationId = await this.store.defaultEntityOf(tenantId);
    if (!organizationId) throw new Error(`tenant ${tenantId} has no default entity`);
    return { tenantId, organizationId };
  }

  /**
   * The bootstrap rule (ADR 0027 section 3): a staff user just created with no membership gets one
   * in the tenant's default entity (role_keys NULL). Portal users get none. Runs in the caller's tx.
   */
  async bootstrap(
    tx: DbTransaction,
    org: IdpOrgRow,
    scope: TxScope,
    userId: string,
  ): Promise<void> {
    if (org.kind !== 'staff') return;
    const entityId = await this.store.defaultEntityOf(scope.tenantId, tx);
    if (!entityId) throw new Error(`tenant ${scope.tenantId} has no default entity`);
    await this.store.ensureDefaultMembership(tx, scope.tenantId, entityId, userId);
  }
}
