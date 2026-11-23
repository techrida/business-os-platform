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
import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Queue } from 'bullmq';

import { lockAccessRevision } from '../../modules/access-settings/access-revision';
import { AuditService } from '../audit/audit.service';
import type { EntityMembership, ResolvedUser } from '../authz/user-directory';
import { DB, type Db, type DbTransaction } from '../db/db.module';
import { type Actor, READ_ONLY, type TxOptions, type TxScope, systemActor, withTx } from '../db/tx';
import {
  assertFounderLeaseHeld,
  assertWithinOperationDeadline,
  dropOwnFounderRemoval,
  FounderLeaseLostError,
  IdentityReconciler,
  isDefiniteRefusal,
  recordedFounderRemovalOf,
  recordFounderRemoval,
  type SettleOutstandingRemoval,
  withFounderRemovalLease,
} from './identity-reconcile';
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

/**
 * The tenant's identity lease could not be had in time. A UserSyncContendedError too, but reconcile also stops trying
 * the rest of that org for the pass, so a held lease costs one claim, not one wait per user.
 */
export class LeaseBusyError extends UserSyncContendedError {}

/** What apply writes for one ZITADEL user: the user as read, the status to store and the lock (undefined keeps it). */
export interface NextState {
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

/** Whether `userId` is an effective Founder of any legal entity (active, with the role there). */
export async function holdsFounder(
  q: DbTransaction,
  store: UsersStore,
  tenantId: string,
  userId: string,
): Promise<boolean> {
  const founders = await store.effectiveRoleHolders(q, tenantId, 'founder');
  return founders.some((f) => f.userId === userId);
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
    // A person the mirror already has is read under the tenant's identity lease, so an admin change that is half done
    // (ZITADEL changed, the database not yet) is never read and written over. A person it has not seen yet has no admin
    // change in flight to wait for (an invite that has not committed is skipped by apply), so ZITADEL is read first to
    // learn their tenant.
    const local = await this.store.findByZitadelId(this.db, zitadelUserId);
    let first: ZitadelUser | null = null;
    let tenantId: string;
    if (local) {
      tenantId = local.tenantId;
    } else {
      first = await this.zitadel.getUser(zitadelUserId);
      if (!first) {
        this.logger.warn(`users.sync: ZITADEL did not return ${zitadelUserId}; left unchanged`);
        return false;
      }
      const known = await this.store.idpOrgByZitadelId(first.orgId);
      if (!known) {
        // P2 adds org sync; until then a user of an unknown org has nowhere to live.
        this.logger.warn(`users.sync skipped ${zitadelUserId}: its org has no app.idp_orgs row`);
        return false;
      }
      tenantId = known.tenantId;
    }
    return this.underLease(tenantId, zitadelUserId, async () => {
      const user = first ?? (await this.zitadel.getUser(zitadelUserId));
      if (!user) {
        this.logger.warn(`users.sync: ZITADEL did not return ${zitadelUserId}; left unchanged`);
        return false;
      }
      const org = await this.store.idpOrgByZitadelId(user.orgId);
      if (!org || org.tenantId !== tenantId) {
        this.logger.warn(`users.sync skipped ${zitadelUserId}: its org has no app.idp_orgs row`);
        return false;
      }
      const roles = await this.zitadel.listGrants(zitadelUserId, org.zitadelOrgId);
      return this.apply(org, user, roles);
    });
  }

  /**
   * Runs a mirror write that must not interleave with an admin identity change (deactivate, lock, role set, invite,
   * resolve): under the tenant's identity lease, the same one those take. A lease that cannot be had in time (another
   * change in progress, a takeover) counts as contention, like a row that keeps changing: the sync job is retried and a
   * reconcile pass leaves the user for the next pass.
   */
  private async underLease<T>(
    tenantId: string,
    zitadelUserId: string,
    fn: () => Promise<T>,
    waitMs?: number,
  ): Promise<T> {
    const scope = await this.entityScope(tenantId);
    try {
      return await withFounderRemovalLease(
        this.store,
        tenantId,
        fn,
        undefined,
        this.settleOutstandingRemoval(scope, zitadelActor()),
        waitMs,
      );
    } catch (error) {
      if (error instanceof ConflictException) throw new LeaseBusyError(zitadelUserId);
      if (error instanceof ServiceUnavailableException) {
        this.logger.warn(`users.lease: ${zitadelUserId} not mirrored (${error.message})`);
        throw new UserSyncContendedError(zitadelUserId);
      }
      throw error;
    }
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
      // Set once the tenant's identity lease could not be had: the rest of this org is left for the next pass.
      let leaseBusy = false;
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
            if (leaseBusy) continue;
            try {
              const didChange = await this.underLease(
                org.tenantId,
                user.id,
                async () => {
                  const roles = await this.zitadel.listGrants(user.id, org.zitadelOrgId);
                  return this.apply(org, user, roles);
                },
                0,
              );
              if (didChange) changed += 1;
            } catch (error) {
              if (!(error instanceof UserSyncContendedError)) throw error;
              if (error instanceof LeaseBusyError) leaseBusy = true;
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
      if (leaseBusy) continue; // the next pass starts the org over
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
    // An invite whose database write never committed: its grants and mail may exist in ZITADEL, but BOS never made this
    // person. No row is created and no invited row is activated until the invite commits (or an admin resolves it).
    if (await this.store.isInvitePending(i.zitadelUserId)) {
      throw new ForbiddenException('This invitation is not complete yet.');
    }
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
    } else if (row.status === 'invited' && row.identityReviewRequired !== true) {
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
    await this.store.clearInvitePending(tx, zitadelUserId);
    if (b.roles.length > 0) {
      await this.store.replaceRoles(tx, scope, userId, b.roles);
      await this.store.bumpAuthzVersion(tx, scope);
    }
    return userId;
  }

  /**
   * After an invite failed once the person may exist in ZITADEL (with grants, or an invite mail sent): closes and flags
   * their row, writing a closed invited row with no roles when none exists yet. Nothing is changed in ZITADEL (no grants
   * stripped, no identity deleted); a retry of the same invite reuses the identity, and an admin resolves the flag.
   * Never throws.
   */
  flagFailedInvite(
    scope: TxScope,
    actor: Actor,
    org: IdpOrgRow,
    invited: { zitadelUserId: string },
    b: InviteInput,
  ): Promise<void> {
    return this.reconciler.denyAfterFailure(scope, actor, {
      reason: 'users.invite:failed',
      zitadelUserId: invited.zitadelUserId,
      createRow: (tx) =>
        this.writeInvitedUser(tx, org, scope, invited.zitadelUserId, { ...b, roles: [] }),
      // Even when both database writes fail, the new identity is deactivated in ZITADEL (best effort).
      close: 'deactivate',
    });
  }

  /**
   * Sets a staff user's roles with ZITADEL called outside any transaction: (A) guard + version/roles snapshot tx,
   * (B) ZITADEL setGrants, (C) re-checked versioned write tx. A failed or ambiguous write closes and flags the
   * person (IdentityReconciler.denyAfterFailure); nothing is replaced or re-granted in ZITADEL. A role set runs under
   * the tenant's identity lease (see user-status.ts). The caller invalidates authz after this resolves.
   */
  async setRoles(
    scope: TxScope,
    actor: Actor,
    userId: string,
    roles: RoleKey[],
    assertAccess?: (tx: DbTransaction) => Promise<void>,
  ): Promise<void> {
    return withFounderRemovalLease(
      this.store,
      scope.tenantId,
      () => this.setRolesOnce(scope, actor, userId, roles, assertAccess),
      undefined,
      this.settleOutstandingRemoval(scope, actor),
    );
  }

  /** Settles a Founder removal inherited with the tenant's lease (see withFounderRemovalLease). */
  settleOutstandingRemoval(scope: TxScope, actor: Actor): SettleOutstandingRemoval {
    return (removal, clearRecord) =>
      this.reconciler.settleOutstandingRemoval(scope, actor, removal, clearRecord);
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
        await this.assertCanSetRoles(tx, scope.tenantId, user, previousRoles);
        const founder = await holdsFounder(tx, this.store, scope.tenantId, userId);
        return { user, org, previousRoles, founder };
      },
      READ_ONLY,
    );

    assertWithinOperationDeadline();
    // A role set on a Founder may take the role away (or, failing, close the person): recorded on the lease first.
    if (plan.founder) await recordFounderRemoval(plan.user, 'set_roles');
    try {
      await this.zitadel.setGrants(plan.user.zitadelUserId, plan.org.zitadelOrgId, roles);
    } catch (error) {
      // A 4xx refusal changed nothing; anything else may have replaced part of the grants.
      if (!isDefiniteRefusal(error)) {
        await this.reconciler.denyAfterFailure(scope, actor, {
          reason: 'users.set_roles:phase_b_failed',
          userId: plan.user.id,
          zitadelUserId: plan.user.zitadelUserId,
          close: null,
        });
      } else {
        await dropOwnFounderRemoval(plan.user.id);
      }
      throw error;
    }

    try {
      await withTx(
        this.db,
        scope,
        actor,
        async (tx) => {
          await lockAccessRevision(tx, scope.tenantId);
          // The lease must still be held (it clears a recorded removal with this write); a taken-over holder writes nothing.
          await assertFounderLeaseHeld(tx);
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
          await this.assertCanSetRoles(tx, scope.tenantId, current, currentRoles);
          if (!sameRoles(currentRoles, roles)) {
            await this.store.replaceRoles(tx, scope, userId, roles);
            await this.store.bumpAuthzVersion(tx, scope);
          }
        },
        LOCKS_USER_ROW,
      );
    } catch (error) {
      // The lease was taken over after this holder recorded a Founder removal: the new holder settles it. Otherwise
      // the person is flagged here as after any failed role set (no ZITADEL call either way).
      if (error instanceof FounderLeaseLostError && recordedFounderRemovalOf(plan.user.id)) {
        throw error;
      }
      await this.reconciler.denyAfterFailure(scope, actor, {
        reason: 'users.set_roles:phase_c_failed',
        userId: plan.user.id,
        zitadelUserId: plan.user.zitadelUserId,
        close: null,
      });
      throw error;
    }
  }

  private async assertCanSetRoles(
    tx: DbTransaction,
    tenantId: string,
    user: UserRow,
    currentRoles: readonly RoleKey[],
  ): Promise<void> {
    // Any edit of the only active Founder is refused, also one that keeps founder: a failed edit closes and flags the
    // person, which would leave the company with no Founder.
    if (user.status !== 'active' || !currentRoles.includes('founder')) return;
    const entities = await soleFounderEntities(tx, this.store, tenantId, user.id);
    if (entities === null) return;
    // Never the email: the address is not a name (U20a2-Q10).
    const name = user.displayName?.trim() || 'This person';
    throw new ConflictException({
      code: 'last_founder',
      message: `${name} is the only Founder of ${entities}. Add another Founder first.`,
    });
  }

  /**
   * Resolving a flagged person, step 1 (no transaction open): reads ZITADEL (the user and the grants) and works out what
   * the row should become. Any failed or unreadable answer is a 503 and nothing is cleared.
   */
  async prepareResolve(
    org: IdpOrgRow,
    existing: UserRow,
  ): Promise<{ read: ZitadelUser; roles: RoleKey[]; next: NextState }> {
    const unreadable = () =>
      new ServiceUnavailableException(
        'The sign-in service does not answer for this person right now. Try again later.',
      );
    let read: ZitadelUser | null;
    let roles: RoleKey[];
    try {
      read = await this.zitadel.getUser(existing.zitadelUserId);
      if (read === null || read.status === null) throw unreadable();
      roles = await this.zitadel.listGrants(existing.zitadelUserId, org.zitadelOrgId);
    } catch (error) {
      if (error instanceof ServiceUnavailableException) throw error;
      this.logger.warn(`users.resolve: ZITADEL unreadable (kind=${(error as Error).name})`);
      throw unreadable();
    }
    let next: NextState;
    try {
      next = await this.nextState(
        org,
        { ...existing, identityReviewRequired: false },
        read,
        read.status,
        true,
      );
    } catch (error) {
      if (error instanceof ServiceUnavailableException) throw error;
      this.logger.warn(`users.resolve: ZITADEL unreadable (kind=${(error as Error).name})`);
      throw unreadable();
    }
    return { read, roles, next };
  }

  /**
   * Step 2, inside the caller's transaction (which holds the access lock): the flag must still be the one read before
   * ZITADEL was called (same row version: any re-flag, status action or sync since then changes it), else 409. Then
   * clears the flag and writes what ZITADEL holds, in one commit.
   */
  async commitResolve(
    tx: DbTransaction,
    org: IdpOrgRow,
    scope: TxScope,
    userId: string,
    seen: UserRow,
    plan: { roles: RoleKey[]; next: NextState },
  ): Promise<UserRow> {
    const current = await this.store.findById(tx, scope, userId, true);
    if (
      !current ||
      current.identityReviewRequired !== true ||
      (current.version ?? null) !== (seen.version ?? null)
    ) {
      throw new ConflictException({
        code: 'conflict',
        message:
          'This person changed while the sign-in service was read. Check them and try again.',
      });
    }
    await this.store.clearIdentityReview(tx, current.id);
    // An admin has read ZITADEL: a failed invite's pending marker no longer keeps this person out.
    await this.store.clearInvitePending(tx, current.zitadelUserId);
    await this.write(
      tx,
      org,
      scope,
      { ...current, identityReviewRequired: false },
      plan.next,
      plan.roles,
    );
    await this.store.bumpAuthzVersion(tx, scope);
    return current;
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
    // An invite whose database write never committed: nothing here creates a row or opens one for this identity (a
    // closing state is still written). The marker clears when the invite commits or an admin resolves it.
    if (read.status !== 'inactive' && (await this.store.isInvitePending(read.id))) {
      this.logger.warn(`users.apply skipped ${read.id}: its invite has not committed`);
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
          // Under the tenant's identity lease (see underLease): in the order every access write takes, the access
          // lock first, then the lease row; a holder that was taken over writes nothing.
          await lockAccessRevision(tx, org.tenantId);
          await assertFounderLeaseHeld(tx);
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
    strict = false,
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
      // Resolving a flagged person (strict) must not guess: an unconfirmed read propagates, so nothing is cleared.
      const fresh = strict
        ? await this.zitadel.getUser(user.id)
        : await this.zitadel.getUser(user.id).catch(() => null);
      if (strict && !fresh?.status) {
        throw new ServiceUnavailableException(
          'The sign-in service does not answer for this person right now. Try again later.',
        );
      }
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
    const { user, lock } = next;
    // A flagged person is never reopened by what ZITADEL says (migration 0190 enforces it in the database too): the
    // sync may keep closing, never opening, until an admin resolves the flag.
    const status =
      existing?.identityReviewRequired === true && next.status === 'active'
        ? existing.status
        : next.status;
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
      try {
        await this.underLease(org.tenantId, local.zitadelUserId, () => this.deactivate(local), 0);
      } catch (error) {
        if (!(error instanceof UserSyncContendedError)) throw error;
        this.logger.warn(`${error.message}; left for the next pass`);
        if (error instanceof LeaseBusyError) break;
        continue;
      }
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
        await lockAccessRevision(tx, user.tenantId);
        await assertFounderLeaseHeld(tx);
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
