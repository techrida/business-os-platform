// The timed sign-in lock (F1-Q4), worker side. ZITADEL counts wrong passwords and one-time codes and locks the person
// once its org lockout policy says so; ZITADEL itself never unlocks them again. This file gives the lock its two app
// halves, the same for every deployment:
//
// - ensureLockoutPolicies pins ACCOUNT_LOCKOUT's attempt limits on every staff org. ZITADEL's default allows any number
//   of attempts (verified at v4.20.1: the instance policy sends no limits), so without this nobody is ever locked. It
//   runs before each reconcile pass, so a ZITADEL that was not ready when the worker started is fixed on a later pass.
//   A failure is logged as an error naming the org: the lockout is off until it succeeds.
// - expire ends each `failed_sign_ins` lock whose `locked_until` has passed (the mirror sets it, see
//   UserMirror.lockChange): it unlocks the person in ZITADEL, then marks them active and unlocked here, audited under
//   the system actor `system:users.lock-expiry`. It is the only way back in for a person nobody unlocks by hand, a
//   sole Founder included. Admin locks never expire.
//
// Each lock is handled in its own transaction, holding the user's row lock (the one admin actions and syncs take), and
// ZITADEL is re-read first: a person unlocked or deactivated in the meantime is only mirrored, never unlocked. A lock
// that cannot be ended now (ZITADEL down, a refusal, an unknown state) is postponed by one window instead of being
// retried every minute.
import { ACCOUNT_LOCKOUT } from '@bos/contracts';
import { Inject, Injectable, Logger } from '@nestjs/common';

import { AuditService } from '../audit/audit.service';
import { DB, type Db } from '../db/db.module';
import { type TxScope, systemActor, withTx } from '../db/tx';
import { UsersStore } from './users.store';
import { ZitadelAdminClient, ZitadelNotConfiguredError } from './zitadel-admin.client';

/** The job name after `system:`; the audit log shows `system:users.lock-expiry`. */
export const LOCK_EXPIRY_ACTOR = 'users.lock-expiry';
/** The actor of the audit row a lockout-policy change gets. */
export const LOCKOUT_POLICY_ACTOR = 'users.lockout-policy';
/** Locks handled per run; the rest wait for the next run a minute later. */
const EXPIRY_BATCH = 100;
const WINDOW_MS = ACCOUNT_LOCKOUT.lockMinutes * 60_000;

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

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly store: UsersStore,
    private readonly zitadel: ZitadelAdminClient,
    private readonly audit: AuditService,
  ) {}

  /** Pins the attempt limits on every staff org. Never throws: a failed org is logged and retried on the next pass. */
  async ensureLockoutPolicies(): Promise<void> {
    const want = {
      maxPasswordAttempts: ACCOUNT_LOCKOUT.maxPasswordAttempts,
      maxOtpAttempts: ACCOUNT_LOCKOUT.maxOtpAttempts,
    };
    for (const org of await this.store.listStaffIdpOrgs()) {
      try {
        const result = await this.zitadel.ensureOrgLockoutPolicy(org.zitadelOrgId, want);
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
        const outcome = await this.expireOne(due.id, due.tenantId, now);
        if (outcome !== 'skipped') result[outcome] += 1;
      } catch (error) {
        if (error instanceof ZitadelNotConfiguredError) {
          this.logger.warn(`users.lock-expiry skipped: ${error.message}`);
          return result;
        }
        this.logger.error(`users.lock-expiry failed for ${due.id}: kind=${errorName(error)}`);
      }
    }
    return result;
  }

  private async expireOne(
    userId: string,
    tenantId: string,
    now: Date,
  ): Promise<keyof ExpiryResult | 'skipped'> {
    const scope = await this.entityScope(tenantId);
    return withTx(this.db, scope, systemActor(LOCK_EXPIRY_ACTOR), async (tx) => {
      const row = await this.store.findById(tx, scope, userId, true);
      // Unlocked, relocked by an admin or postponed since the scan: nothing is due any more.
      if (
        !row ||
        row.lockReason !== 'failed_sign_ins' ||
        !row.lockedUntil ||
        Date.parse(row.lockedUntil) > now.getTime()
      ) {
        return 'skipped';
      }
      // Read before any write: the row is the caller's object, and the audit row records what was there.
      const before = { status: row.status, lockedUntil: row.lockedUntil };
      const postpone = async (why: string) => {
        await this.store.postponeLock(tx, row.id, new Date(now.getTime() + WINDOW_MS));
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
        await this.store.updateUser(tx, row.id, {
          email: row.email,
          displayName: row.displayName,
          status: read.status,
          lock: null,
        });
        if (read.status !== before.status) await this.store.bumpAuthzVersion(tx, scope);
        return 'cleared';
      }

      try {
        await this.zitadel.unlockUser(row.zitadelUserId);
      } catch (error) {
        if (error instanceof ZitadelNotConfiguredError) throw error;
        return postpone(`ZITADEL did not unlock the user (kind=${errorName(error)})`);
      }
      await this.store.updateUser(tx, row.id, {
        email: row.email,
        displayName: row.displayName,
        status: 'active',
        lock: null,
      });
      await this.store.bumpAuthzVersion(tx, scope);
      await this.audit.record(tx, {
        action: 'users.unlocked',
        entityType: 'users',
        entityId: row.id,
        before: { status: before.status, lockReason: 'failed_sign_ins' },
        after: { status: 'active', lockReason: null },
        meta: { reason: 'lock_expired', lockedUntil: before.lockedUntil },
      });
      return 'unlocked';
    });
  }

  /** The tenant and its default entity: users have no entity, and the audit row takes its scope from here. */
  private async entityScope(tenantId: string): Promise<TxScope> {
    const organizationId = await this.store.defaultEntityOf(tenantId);
    if (!organizationId) throw new Error(`tenant ${tenantId} has no default entity`);
    return { tenantId, organizationId };
  }
}
