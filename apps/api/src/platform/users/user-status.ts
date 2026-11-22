// User status actions in Settings > Users (F1-Q5): deactivate, reactivate, lock and unlock a staff user from the app
// instead of the identity console, audited. A lock (F1-Q4) is the other way to shut someone out: ZITADEL locks a person
// by itself after too many failed sign-ins (a timed lock the lock-expiry job ends), and an admin may lock someone here
// (no expiry). Serves the NFR "a removed user must stop working": ZITADEL is the truth for whether a person can sign
// in. Each action runs in three phases so no database connection, row lock or tenant audit lock is ever held across a
// ZITADEL HTTP call:
//   (A) short READ_ONLY tx: lock access-revision, check live grant, read user and version, run all guards.
//   (B) ZITADEL calls with no transaction open.
//   (C) short tx: lock access-revision, re-check live grant, re-read user FOR NO KEY UPDATE, re-run guards, and write
//       only while the row version is unchanged (or upgrading a concurrent failed_sign_ins lock to an admin lock).
//       If the row already shows the desired outcome, record the audit row and return success.
// BOS never undoes a ZITADEL write (FU8). A failed or ambiguous one (a timeout or 5xx from ZITADEL, a step that fails
// after an earlier one worked, any failure in (C) once ZITADEL changed) closes the person's row and sets
// `identity_review_required` in its own transaction (IdentityReconciler.denyAfterFailure): a flagged row is never
// active, sync never clears the flag, and an admin resolves it after reading ZITADEL again. One best-effort remote
// close follows; nothing unlocks, reactivates or compensates in ZITADEL. A 4xx refusal on the first call changed
// nothing and flags nobody. The last-Founder guard holds across the three phases through a per-tenant lease
// (withFounderRemovalLease) with a hard deadline, after which no provider call starts. Taking a Founder away is recorded
// on the lease before (B) and cleared by (C) or the denial; a holder that takes a stalled lease over flags that person
// before its own guard runs, and the stalled holder, once it resumes, writes nothing more.
//
// What each action does depends on the person's status and lock (planFor):
//   deactivate  active: ZITADEL deactivate. Locked (either kind): ZITADEL unlock, then deactivate (if deactivate fails
//               the person is closed and flagged for review).
//   reactivate  deactivated and not locked: ZITADEL reactivate.
//   lock        active: ZITADEL lock. Under a failed-sign-in lock: read ZITADEL first and call lockUser only when ZITADEL
//               reports unlocked (real ZITADEL v4.20.1 refuses lockUser on an already-locked user).
//   unlock      locked (either kind): ZITADEL unlock.
import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';

import { lockAccessRevision } from '../../modules/access-settings/access-revision';
import { AuditService } from '../audit/audit.service';
import { DB, type Db, type DbTransaction } from '../db/db.module';
import { type Actor, READ_ONLY, type TxOptions, type TxScope, withTx } from '../db/tx';
import {
  assertFounderLeaseHeld,
  assertWithinOperationDeadline,
  dropOwnFounderRemoval,
  FounderLeaseLostError,
  IdentityReconciler,
  isDefiniteRefusal,
  recordFounderRemoval,
  withFounderRemovalLease,
} from './identity-reconcile';
import { holdsFounder, soleFounderEntities } from './user-mirror';
import { type UserLock, type UserRow, UsersStore } from './users.store';
import {
  type MirroredStatus,
  ZitadelAdminClient,
  ZitadelHttpError,
  ZitadelNotConfiguredError,
} from './zitadel-admin.client';

export const USER_STATUS_ACTIONS = ['deactivate', 'reactivate', 'lock', 'unlock'] as const;
export type UserStatusAction = (typeof USER_STATUS_ACTIONS)[number];

type ZitadelStep = (zitadel: ZitadelAdminClient, zitadelUserId: string) => Promise<void>;

/** What one action does to one person, decided from their status and lock. */
interface Plan {
  to: MirroredStatus;
  /** The ZITADEL calls, in order. */
  steps: ZitadelStep[];
  /** The lock to store with the new status: undefined keeps it, null clears it. */
  lock: UserLock | null | undefined;
  /** Whether the action takes or keeps access away (then the self and last-Founder guards apply). */
  removesAccess: boolean;
  audit: string;
}

const adminLock = (): UserLock => ({ reason: 'admin', lockedAt: new Date(), until: null });

// Takes the access-revision lock and user row lock before the first audited write, matching DepartmentsAdminService,
// AccessSettingsService, UserMirror.apply and UserLocks.whileLockHeld so lock ordering never inverts into 40P01.
const AFTER_ACCESS_LOCK: TxOptions = { audit: 'lazy' };

/** "You cannot <verb> your own account." */
const VERBS: Record<UserStatusAction, string> = {
  deactivate: 'deactivate',
  reactivate: 'reactivate',
  lock: 'lock',
  unlock: 'unlock',
};

const WRONG_STATE: Record<UserStatusAction, string> = {
  // ZITADEL cannot deactivate a user who never finished the invitation.
  deactivate: 'Only an active or locked user can be deactivated.',
  // A locked person is inactive here too, but ZITADEL holds them LOCKED: they are unlocked, not reactivated.
  reactivate: 'Only a deactivated user can be reactivated. A locked user is unlocked instead.',
  lock: 'Only an active user, or one locked after failed sign-ins, can be locked.',
  unlock: 'Only a locked user can be unlocked.',
};

function userChangedConflict(): ConflictException {
  return new ConflictException({
    code: 'conflict',
    message: 'This user was changed by someone else. Reload the page and try again.',
  });
}

function alreadyMatchesOutcome(action: UserStatusAction, row: UserRow): boolean {
  const reason = row.lockReason ?? null;
  switch (action) {
    case 'deactivate':
      return row.status === 'inactive' && reason === null;
    case 'reactivate':
    case 'unlock':
      return row.status === 'active' && reason === null;
    case 'lock':
      return row.status === 'inactive' && reason === 'admin';
  }
}

/** The plan for `action` on `target`, or null when the action does not fit their status and lock. */
function planFor(action: UserStatusAction, target: UserRow): Plan | null {
  const reason = target.lockReason ?? null;
  const active = target.status === 'active' && reason === null;
  const deactivated = target.status === 'inactive' && reason === null;
  switch (action) {
    case 'deactivate':
      if (active) {
        return {
          to: 'inactive',
          steps: [(z, id) => z.deactivateUser(id)],
          lock: undefined,
          removesAccess: true,
          audit: 'users.deactivated',
        };
      }
      if (reason === null) return null;
      return {
        to: 'inactive',
        steps: [(z, id) => z.unlockUser(id), (z, id) => z.deactivateUser(id)],
        lock: null,
        removesAccess: true,
        audit: 'users.deactivated',
      };
    case 'reactivate':
      if (!deactivated) return null;
      return {
        to: 'active',
        steps: [(z, id) => z.reactivateUser(id)],
        lock: undefined,
        removesAccess: false,
        audit: 'users.reactivated',
      };
    case 'lock':
      if (active) {
        return {
          to: 'inactive',
          steps: [(z, id) => z.lockUser(id)],
          lock: adminLock(),
          removesAccess: true,
          audit: 'users.locked',
        };
      }
      if (reason !== 'failed_sign_ins') return null;
      // Real ZITADEL v4.20.1 refuses lockUser on an already-locked user with 4xx: read first and call lockUser only
      // when ZITADEL reports unlocked (e.g. lock-expiry just unlocked them while the mirror still shows the timed
      // lock).
      return {
        to: 'inactive',
        steps: [
          async (z, id) => {
            const live = await z.getUser(id);
            if (live?.locked) return;
            await z.lockUser(id);
          },
        ],
        lock: adminLock(),
        removesAccess: true,
        audit: 'users.locked',
      };
    case 'unlock':
      if (reason === null) return null;
      return {
        to: 'active',
        steps: [(z, id) => z.unlockUser(id)],
        lock: null,
        removesAccess: false,
        audit: 'users.unlocked',
      };
  }
}

@Injectable()
export class UserStatusService {
  private readonly reconciler: IdentityReconciler;

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly store: UsersStore,
    private readonly zitadel: ZitadelAdminClient,
    private readonly audit: AuditService,
  ) {
    this.reconciler = new IdentityReconciler(db, store, zitadel, audit);
  }

  /**
   * Runs `action` on `userId` with ZITADEL called outside any transaction: (A) guard + version snapshot tx,
   * (B) ZITADEL steps, (C) re-checked versioned write tx; if (C) fails, reconciles from the live row and ZITADEL with
   * the closing state winning. The caller invalidates the authz cache after this resolves.
   */
  async apply(
    scope: TxScope,
    actor: Actor,
    userId: string,
    action: UserStatusAction,
    assertAccess?: (tx: DbTransaction) => Promise<void>,
  ): Promise<void> {
    // A deactivate or lock may take a Founder away: one identity change at a time per tenant, so the last-Founder guard
    // of (A) still holds when ZITADEL has been changed and (C) writes (see the header). The other actions take it too.
    // A removal this action records on the lease and never clears (it stalls past the TTL after ZITADEL closed the
    // person) is settled by the next holder before its guard runs.
    return withFounderRemovalLease(
      this.store,
      scope.tenantId,
      () => this.run(scope, actor, userId, action, assertAccess),
      undefined,
      (removal, clearRecord) =>
        this.reconciler.settleOutstandingRemoval(scope, actor, removal, clearRecord),
    );
  }

  private async run(
    scope: TxScope,
    actor: Actor,
    userId: string,
    action: UserStatusAction,
    assertAccess?: (tx: DbTransaction) => Promise<void>,
  ): Promise<void> {
    const { target, plan, idpOrgId, removesFounder } = await withTx(
      this.db,
      scope,
      actor,
      async (tx) => {
        await lockAccessRevision(tx, scope.tenantId);
        if (assertAccess) await assertAccess(tx);
        const org = await this.store.staffIdpOrgOf(scope.tenantId, tx);
        const found = await this.store.findById(tx, scope, userId);
        // Portal users are not administered here, as for roles and password resets.
        if (!org || !found || found.idpOrgId !== org.idpOrgId) {
          throw new NotFoundException('User not found');
        }
        const planned = await this.guardAndPlan(tx, scope.tenantId, actor, found, action);
        const founder =
          planned.removesAccess && (await holdsFounder(tx, this.store, scope.tenantId, found.id));
        return {
          target: found,
          plan: planned,
          idpOrgId: org.idpOrgId,
          removesFounder: founder,
        };
      },
      READ_ONLY,
    );

    await this.runSteps(scope, actor, plan, target, action, removesFounder);

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
          if (!current || current.idpOrgId !== idpOrgId) throw userChangedConflict();
          if ((current.version ?? null) !== (target.version ?? null)) {
            if (alreadyMatchesOutcome(action, current)) {
              const state = { status: current.status, lockReason: current.lockReason ?? null };
              await this.audit.record(tx, {
                action: plan.audit,
                entityType: 'users',
                entityId: current.id,
                before: state,
                after: state,
              });
              return;
            }
            // A sync turning an active row into a timed failed_sign_ins lock while phase B ran is upgraded to the
            // admin lock in place rather than failing with 409.
            const canUpgradeTimedLock =
              action === 'lock' &&
              current.status === 'inactive' &&
              current.lockReason === 'failed_sign_ins';
            if (!canUpgradeTimedLock) throw userChangedConflict();
          }
          const verified = await this.guardAndPlan(tx, scope.tenantId, actor, current, action);
          const before = { status: current.status, lockReason: current.lockReason ?? null };
          await this.store.updateUser(tx, current.id, {
            email: current.email,
            displayName: current.displayName,
            status: verified.to,
            ...(verified.lock === undefined ? {} : { lock: verified.lock }),
          });
          // Every process drops its cached principals at once, so a deactivated person is refused on their next request.
          await this.store.bumpAuthzVersion(tx, scope);
          await this.audit.record(tx, {
            action: verified.audit,
            entityType: 'users',
            entityId: current.id,
            before,
            after: {
              status: verified.to,
              lockReason:
                verified.lock === undefined ? before.lockReason : (verified.lock?.reason ?? null),
            },
          });
        },
        AFTER_ACCESS_LOCK,
      );
    } catch (error) {
      // The lease was taken over: the new holder settles the recorded removal, this one changes nothing more.
      if (error instanceof FounderLeaseLostError) throw error;
      // Phase B already changed ZITADEL: whatever failed here, the person is closed and flagged, never reopened.
      await this.deny(scope, actor, target, action, 'phase_c_failed');
      throw error;
    }
  }

  private async guardAndPlan(
    tx: DbTransaction,
    tenantId: string,
    actor: Actor,
    target: UserRow,
    action: UserStatusAction,
  ): Promise<Plan> {
    const plan = planFor(action, target);
    if (plan?.removesAccess && target.id === actor.id) {
      throw new ConflictException({
        code: 'own_account',
        message: `You cannot ${VERBS[action]} your own account.`,
      });
    }
    if (!plan) {
      throw new ConflictException({ code: 'wrong_status', message: WRONG_STATE[action] });
    }
    if (!plan.removesAccess && target.identityReviewRequired === true) {
      throw new ConflictException({
        code: 'identity_review_required',
        message:
          'This person is closed until their sign-in state is reviewed. Resolve it first, then try again.',
      });
    }
    if (plan.removesAccess) await this.assertNotSoleFounder(tx, tenantId, target, action);
    return plan;
  }

  /**
   * The plan's ZITADEL calls in order, with no transaction open. A failure is ambiguous (the person may be in any
   * state) unless it is a 4xx refusal on the first call, which changed nothing: then the person is closed and flagged.
   */
  private async runSteps(
    scope: TxScope,
    actor: Actor,
    plan: Plan,
    target: UserRow,
    action: UserStatusAction,
    removesFounder: boolean,
  ): Promise<void> {
    for (const [index, step] of plan.steps.entries()) {
      if (index === 0) {
        assertWithinOperationDeadline();
        // Taking a Founder away: recorded on the lease before the first call (see withFounderRemovalLease).
        if (removesFounder) await recordFounderRemoval(target, action);
      }
      try {
        if (index > 0) assertWithinOperationDeadline();
        await this.identityCall(() => step(this.zitadel, target.zitadelUserId));
      } catch (error) {
        if (index > 0 || !isDefiniteRefusal(error)) {
          await this.deny(scope, actor, target, action, 'phase_b_failed');
        } else {
          await dropOwnFounderRemoval(target.id);
        }
        throw error;
      }
    }
  }

  /** Closes and flags `target`; the remote close follows the action's intent (lock when it was or is to be locked). */
  private deny(
    scope: TxScope,
    actor: Actor,
    target: UserRow,
    action: UserStatusAction,
    reason: string,
  ): Promise<void> {
    const lock = action === 'lock' || (target.lockReason ?? null) !== null;
    return this.reconciler.denyAfterFailure(scope, actor, {
      reason: `users.${action}:${reason}`,
      userId: target.id,
      zitadelUserId: target.zitadelUserId,
      close: lock ? 'lock' : 'deactivate',
    });
  }

  private async assertNotSoleFounder(
    tx: DbTransaction,
    tenantId: string,
    target: UserRow,
    action: UserStatusAction,
  ): Promise<void> {
    const entities = await soleFounderEntities(tx, this.store, tenantId, target.id);
    if (entities === null) return;
    // Never the email: the address is not a name (U20a2-Q10).
    const name = target.displayName?.trim() || 'This person';
    throw new ConflictException({
      code: 'last_founder',
      message: `${name} is the only Founder of ${entities}. Make someone else a Founder there before you ${VERBS[action]} them.`,
    });
  }

  /** ZITADEL's refusals become a 409 and its outages a 503; neither carries ZITADEL's own text. */
  private async identityCall(call: () => Promise<void>): Promise<void> {
    try {
      await call();
    } catch (error) {
      if (error instanceof ZitadelNotConfiguredError) throw error;
      if (error instanceof ZitadelHttpError && error.status >= 400 && error.status < 500) {
        throw new ConflictException({
          code: 'identity_refused',
          message: 'The sign-in service did not accept this change. Reload the page and try again.',
        });
      }
      throw new ServiceUnavailableException('The sign-in service did not answer. Try again.');
    }
  }
}
