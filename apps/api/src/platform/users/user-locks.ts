// The timed sign-in lock (F1-Q4), worker side. ZITADEL counts wrong passwords and one-time codes and locks the person
// once its org lockout policy says so; ZITADEL itself never unlocks them again. This file gives the lock its two app
// halves, the same for every deployment:
//
// - ensureLockoutPolicies pins ACCOUNT_LOCKOUT's attempt limits on every staff org and records, once, when the
//   policy was first known to be in place (ops.sync_cursors `users.lockout-pinned:<org>`). ZITADEL's default allows any number
//   of attempts (verified at v4.20.1: the instance policy sends no limits), so without this nobody is ever locked. It
//   runs before each reconcile pass, so a ZITADEL that was not ready when the worker started is fixed on a later pass.
//   A failure is logged as an error naming the org: the lockout is off until it succeeds.
// - expire ends each `failed_sign_ins` lock whose `locked_until` has passed (the mirror sets it, see
//   UserMirror.lockChange): it unlocks the person in ZITADEL, then marks them active and unlocked here, audited under
//   the system actor `system:users.lock-expiry`. It is the only way back in for a person nobody unlocks by hand, a
//   sole Founder included. Admin locks never expire.
//
// Each lock is handled on its own, under the tenant's identity lease (the one sync, reconcile, resolve and the admin
// status actions take), so the unlock and the write here never interleave with an admin lock, deactivate or role set of
// the same tenant that is half done. A lease that is busy leaves the lock for the next run a minute later.
// ZITADEL is called with no transaction open, so a slow ZITADEL holds no pooled
// connection or row lock. ZITADEL is re-read first: a person unlocked or deactivated in the meantime is only mirrored,
// never unlocked. Each write then takes the user's row lock (the one admin actions and syncs take) and goes ahead only
// while the lock is still the one read; when an admin changed it while ZITADEL was being unlocked, the person is locked
// again in ZITADEL and the admin's lock stands. So are they when the write here fails after ZITADEL was unlocked (the
// row lock timed out, say) and the row still shows a lock. A lock that cannot be ended now (ZITADEL down, a refusal,
// an unknown state) is postponed by one window instead of being retried every minute.
import { ACCOUNT_LOCKOUT } from '@bos/contracts';
import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';

import { lockAccessRevision } from '../../modules/access-settings/access-revision';
import { AuditService } from '../audit/audit.service';
import { dbBusyKindOf } from '../db/busy';
import { DB, type Db } from '../db/db.module';
import { type DbTransaction, type TxScope, systemActor, withTx } from '../db/tx';
import {
  assertFounderLeaseHeld,
  IdentityReconciler,
  withFounderRemovalLease,
} from './identity-reconcile';
import { runOutsideOperationDeadline } from './operation-deadline';
import { lockoutPinnedCursor } from './users.constants';
import { type UserRow, UsersStore } from './users.store';
import { ZitadelAdminClient, ZitadelNotConfiguredError } from './zitadel-admin.client';

/** The job name after `system:`; the audit log shows `system:users.lock-expiry`. */
export const LOCK_EXPIRY_ACTOR = 'users.lock-expiry';
/** The actor of the audit row a lockout-policy change gets. */
export const LOCKOUT_POLICY_ACTOR = 'users.lockout-policy';
/** Locks handled per run; the rest wait for the next run a minute later. */
const EXPIRY_BATCH = 100;
const WINDOW_MS = ACCOUNT_LOCKOUT.lockMinutes * 60_000;
/** Waits before each try of locking a person in ZITADEL again; the first try is at once. */
const RELOCK_DELAYS_MS = [0, 250, 1_000] as const;

export interface ExpiryResult {
  /** Unlocked in ZITADEL and here. */
  unlocked: number;
  /** ZITADEL no longer held them locked: the lock was only cleared here. */
  cleared: number;
  /** Could not be ended now; postponed by one window. */
  postponed: number;
}

const errorName = (error: unknown): string => (error instanceof Error ? error.name : 'error');

@Injectable()
export class UserLocks {
  private readonly logger = new Logger(UserLocks.name);
  private readonly reconciler: IdentityReconciler;

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly store: UsersStore,
    private readonly zitadel: ZitadelAdminClient,
    private readonly audit: AuditService,
  ) {
    this.reconciler = new IdentityReconciler(db, store, zitadel, audit);
  }

  /** Pins the attempt limits on every staff org. Never throws: a failed org is logged and retried on the next pass. */
  async ensureLockoutPolicies(): Promise<void> {
    const want = {
      maxPasswordAttempts: ACCOUNT_LOCKOUT.maxPasswordAttempts,
      maxOtpAttempts: ACCOUNT_LOCKOUT.maxOtpAttempts,
    };
    for (const org of await this.store.listStaffIdpOrgs()) {
      try {
        const result = await this.zitadel.ensureOrgLockoutPolicy(org.zitadelOrgId, want);
        // From now on ZITADEL may lock people for failed sign-ins on this org. Kept from the first time: only a lock
        // ZITADEL set after it can be a timed lock (UserMirror.lockChange); any earlier one came from the console.
        const marker = lockoutPinnedCursor(org.zitadelOrgId);
        if ((await this.store.getCursor(marker)) === null) {
          await this.store.setCursor(marker, new Date().toISOString());
        }
        if (result === 'unchanged') continue;
        const scope = await this.entityScope(org.tenantId);
        await withTx(this.db, scope, systemActor(LOCKOUT_POLICY_ACTOR), (tx) =>
          this.audit.record(tx, {
            action: 'users.lockout_policy_pinned',
            entityType: 'idp_orgs',
            entityId: org.idpOrgId,
            meta: { zitadelOrgId: org.zitadelOrgId, result, ...want },
          }),
        );
        this.logger.log(`users.lockout-policy ${result} for org ${org.zitadelOrgId}`);
      } catch (error) {
        if (error instanceof ZitadelNotConfiguredError) {
          this.logger.warn(`users.lockout-policy skipped: ${error.message}`);
          return;
        }
        // The name only: a message can carry ZITADEL detail. Until this succeeds ZITADEL locks nobody.
        this.logger.error(
          `users.lockout-policy failed for org ${org.zitadelOrgId}: kind=${errorName(error)}; sign-in lockout is OFF for this org`,
        );
      }
    }
  }

  /** Ends every due `failed_sign_ins` lock, up to one batch. */
  async expire(now: Date = new Date()): Promise<ExpiryResult> {
    const result: ExpiryResult = { unlocked: 0, cleared: 0, postponed: 0 };
    for (const due of await this.store.expiredLocks(this.db, now, EXPIRY_BATCH)) {
      try {
        const outcome = await this.underLease(due.tenantId, due.id, () =>
          this.expireOne(due.id, due.tenantId, now),
        );
        if (outcome !== 'skipped') result[outcome] += 1;
      } catch (error) {
        if (error instanceof ZitadelNotConfiguredError) {
          this.logger.warn(`users.lock-expiry skipped: ${error.message}`);
          return result;
        }
        const busy = dbBusyKindOf(error);
        if (busy !== undefined) {
          // The access lock or the user's row stayed busy (lock_timeout) or this write lost a deadlock: contention, not a
          // failure. The lock is still due and the next run handles it.
          this.logger.warn(
            `users.lock-expiry: ${due.id} left for the next run (database busy: ${busy})`,
          );
          continue;
        }
        this.logger.error(`users.lock-expiry failed for ${due.id}: kind=${errorName(error)}`);
      }
    }
    return result;
  }

  /**
   * Runs one lock's expiry under the tenant's identity lease, without waiting for it: a lease another identity change
   * holds (or a takeover that could not be settled) leaves the lock due, and the next run tries again.
   */
  private async underLease<T>(
    tenantId: string,
    userId: string,
    fn: () => Promise<T>,
  ): Promise<T | 'skipped'> {
    const scope = await this.entityScope(tenantId);
    try {
      return await withFounderRemovalLease(
        this.store,
        tenantId,
        fn,
        undefined,
        (removal, clearRecord, origin) =>
          this.reconciler.settleOutstandingRemoval(
            scope,
            systemActor(LOCK_EXPIRY_ACTOR),
            removal,
            clearRecord,
            origin,
          ),
        0,
      );
    } catch (error) {
      if (error instanceof ConflictException) return 'skipped';
      if (error instanceof ServiceUnavailableException) {
        this.logger.warn(`users.lock-expiry: ${userId} left for the next run (${error.message})`);
        return 'skipped';
      }
      throw error;
    }
  }

  private async expireOne(
    userId: string,
    tenantId: string,
    now: Date,
  ): Promise<keyof ExpiryResult | 'skipped'> {
    const scope = await this.entityScope(tenantId);
    const row = await this.store.findById(this.db, scope, userId);
    // Unlocked, relocked by an admin or postponed since the scan: nothing is due any more.
    if (
      !row ||
      row.lockReason !== 'failed_sign_ins' ||
      !row.lockedUntil ||
      Date.parse(row.lockedUntil) > now.getTime()
    ) {
      return 'skipped';
    }
    const postpone = async (why: string) => {
      const { done } = await this.whileLockHeld(scope, row, (tx) =>
        this.store.postponeLock(tx, row.id, new Date(now.getTime() + WINDOW_MS)),
      );
      if (!done) return 'skipped';
      this.logger.warn(`users.lock-expiry postponed ${row.id}: ${why}`);
      return 'postponed' as const;
    };

    let read;
    try {
      read = await this.zitadel.getUser(row.zitadelUserId);
    } catch (error) {
      if (error instanceof ZitadelNotConfiguredError) throw error;
      return postpone(`could not read the user (kind=${errorName(error)})`);
    }
    if (!read || read.status === null)
      return postpone('ZITADEL did not say what state the user is in');

    if (!read.locked) {
      // Unlocked or deactivated in ZITADEL meanwhile: only mirror that.
      const status = read.status;
      const { done } = await this.whileLockHeld(scope, row, async (tx, current) => {
        await this.store.updateUser(tx, current.id, {
          email: current.email,
          displayName: current.displayName,
          status,
          lock: null,
        });
        if (status !== current.status) await this.store.bumpAuthzVersion(tx, scope);
      });
      return done ? 'cleared' : 'skipped';
    }

    try {
      await this.zitadel.unlockUser(row.zitadelUserId);
    } catch (error) {
      if (error instanceof ZitadelNotConfiguredError) throw error;
      return postpone(`ZITADEL did not unlock the user (kind=${errorName(error)})`);
    }
    // ZITADEL lets the person in from here on. Every way out that does not end the lock here too locks them again
    // there, or the next sync would clear the stored lock to match ZITADEL (UserMirror.lockChange).
    let unlocked: Awaited<ReturnType<UserLocks['whileLockHeld']>>;
    try {
      unlocked = await this.whileLockHeld(scope, row, async (tx, current) => {
        await this.store.updateUser(tx, current.id, {
          email: current.email,
          displayName: current.displayName,
          status: 'active',
          lock: null,
        });
        await this.store.bumpAuthzVersion(tx, scope);
        await this.audit.record(tx, {
          action: 'users.unlocked',
          entityType: 'users',
          entityId: current.id,
          before: { status: current.status, lockReason: 'failed_sign_ins' },
          after: { status: 'active', lockReason: null },
          meta: { reason: 'lock_expired', lockedUntil: current.lockedUntil },
        });
      });
    } catch (error) {
      // A row lock that timed out (55P03 behind an admin action), a failed write or commit: the lock may still stand.
      await this.relockIfStillLocked(
        scope,
        row,
        `ending the lock here failed (kind=${errorName(error)})`,
      );
      throw error;
    }
    if (unlocked.done) return 'unlocked';
    if (unlocked.current?.lockReason) {
      await this.lockAgain(row.id, row.zitadelUserId, 'its lock changed while it was being ended');
    }
    return 'skipped';
  }

  /**
   * After ZITADEL was unlocked and the write here did not go through: locks ZITADEL again unless the row, read again
   * with no transaction open, shows no lock any more (or no user). A row that cannot be read counts as still locked.
   * Never throws, so the caller's own error is the one that propagates.
   */
  private async relockIfStillLocked(scope: TxScope, seen: UserRow, why: string): Promise<void> {
    let current: UserRow | null | undefined;
    try {
      current = await this.store.findById(this.db, scope, seen.id);
    } catch {
      current = undefined;
    }
    if (current === null || (current !== undefined && !current.lockReason)) return;
    await this.lockAgain(seen.id, seen.zitadelUserId, why);
  }

  /**
   * Runs `write` under the user's row lock while their lock is still the one `seen` holds (status, reason and end).
   * Otherwise nothing is written and the row as it is now comes back.
   */
  private whileLockHeld(
    scope: TxScope,
    seen: UserRow,
    write: (tx: DbTransaction, current: UserRow) => Promise<void>,
  ): Promise<{ done: true } | { done: false; current: UserRow | null }> {
    return withTx(
      this.db,
      scope,
      systemActor(LOCK_EXPIRY_ACTOR),
      async (tx) => {
        // The access lock, then the lease row, then the user row: the order every identity write takes. A holder that
        // was taken over writes nothing (503).
        await lockAccessRevision(tx, scope.tenantId);
        await assertFounderLeaseHeld(tx);
        const current = await this.store.findById(tx, scope, seen.id, true);
        if (
          !current ||
          current.status !== seen.status ||
          (current.lockReason ?? null) !== (seen.lockReason ?? null) ||
          (current.lockedUntil ?? null) !== (seen.lockedUntil ?? null)
        ) {
          return { done: false, current };
        }
        await write(tx, current);
        return { done: true };
        // 'lazy': the user row lock comes before the first audited write, as on the admin status paths (UserStatusService)
        // that cannot take the tenant audit lock first; taking that lock before the row would invert the order against them.
      },
      { audit: 'lazy' },
    );
  }

  /**
   * ZITADEL was unlocked but the lock here still stands (an admin lock replaced the timed one meanwhile, or ending it
   * here failed), so ZITADEL holds the person locked again; otherwise the next sync would let them in. Tried a few
   * times; never throws.
   */
  private async lockAgain(userId: string, zitadelUserId: string, why: string): Promise<void> {
    let last: unknown;
    for (const delay of RELOCK_DELAYS_MS) {
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
      try {
        // Best effort that must still run once the operation deadline passed (the lease fence still applies).
        await runOutsideOperationDeadline(() => this.zitadel.lockUser(zitadelUserId));
        this.logger.warn(`users.lock-expiry: ${userId} locked again in ZITADEL: ${why}`);
        return;
      } catch (error) {
        last = error;
        if (error instanceof ZitadelNotConfiguredError) break;
      }
    }
    this.logger.error(
      `users.lock-expiry: could not lock ${userId} again in ZITADEL (${why}; kind=${errorName(last)}); ZITADEL lets them sign in while the lock here stands, and the next sync clears it to match`,
    );
  }

  /** The tenant and its default entity: users have no entity, and the audit row takes its scope from here. */
  private async entityScope(tenantId: string): Promise<TxScope> {
    const organizationId = await this.store.defaultEntityOf(tenantId);
    if (!organizationId) throw new Error(`tenant ${tenantId} has no default entity`);
    return { tenantId, organizationId };
  }
}
