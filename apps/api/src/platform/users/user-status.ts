// User status actions in Settings > Users (F1-Q5): deactivate, reactivate, lock and unlock a staff user from the app
// instead of the identity console, audited. A lock (F1-Q4) is the other way to shut someone out: ZITADEL locks a person
// by itself after too many failed sign-ins (a timed lock the lock-expiry job ends), and an admin may lock someone here
// (no expiry). Serves the NFR "a removed user must stop working": ZITADEL is the truth for whether a person can sign
// in. Each action runs in three phases so no database connection, row lock or tenant audit lock is ever held across a
// ZITADEL HTTP call:
//   (A) short READ_ONLY tx: lock access-revision, check live grant, read user and version, run all guards.
//   (B) ZITADEL calls with no transaction open (with in-order undo if a later step fails).
//   (C) short tx: lock access-revision, re-check live grant, re-read user FOR NO KEY UPDATE, re-run guards, and write
//       only while the row version is unchanged. If the row already shows the desired outcome, return success; on any
//       other change or DB failure, compensate ZITADEL back to the pre-state (never throwing) and rethrow.
//
// What each action does depends on the person's status and lock (planFor):
//   deactivate  active: ZITADEL deactivate (compensate: reactivate). Locked (either kind): ZITADEL unlock, then
//               deactivate (if deactivate fails: lockUser; if phase C fails: reactivate, then lock).
//   reactivate  deactivated and not locked: ZITADEL reactivate (compensate: deactivate).
//   lock        active: ZITADEL lock (compensate: unlock). Under a failed-sign-in lock: ZITADEL lock too (idempotent:
//               lock-expiry may have just unlocked them in ZITADEL while the mirror still shows the timed lock);
//               compensate: none (stay locked: fail closed).
//   unlock      locked (either kind): ZITADEL unlock (compensate: lock).
import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';

import { lockAccessRevision } from '../../modules/access-settings/access-revision';
import { AuditService } from '../audit/audit.service';
import { DB, type Db, type DbTransaction } from '../db/db.module';
import { type Actor, READ_ONLY, type TxOptions, type TxScope, withTx } from '../db/tx';
import { soleFounderEntities } from './user-mirror';
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
  /** Puts ZITADEL back when a later step in `steps` fails after an earlier one succeeded. */
  stepUndo?: ZitadelStep;
  /** Puts ZITADEL back to the pre-state when phase (C) fails after `steps` all succeeded. */
  compensate: ZitadelStep[];
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
          compensate: [(z, id) => z.reactivateUser(id)],
          lock: undefined,
          removesAccess: true,
          audit: 'users.deactivated',
        };
      }
      if (reason === null) return null;
      return {
        to: 'inactive',
        steps: [(z, id) => z.unlockUser(id), (z, id) => z.deactivateUser(id)],
        stepUndo: (z, id) => z.lockUser(id),
        compensate: [(z, id) => z.reactivateUser(id), (z, id) => z.lockUser(id)],
        lock: null,
        removesAccess: true,
        audit: 'users.deactivated',
      };
    case 'reactivate':
      if (!deactivated) return null;
      return {
        to: 'active',
        steps: [(z, id) => z.reactivateUser(id)],
        compensate: [(z, id) => z.deactivateUser(id)],
        lock: undefined,
        removesAccess: false,
        audit: 'users.reactivated',
      };
    case 'lock':
      if (active) {
        return {
          to: 'inactive',
          steps: [(z, id) => z.lockUser(id)],
          compensate: [(z, id) => z.unlockUser(id)],
          lock: adminLock(),
          removesAccess: true,
          audit: 'users.locked',
        };
      }
      if (reason !== 'failed_sign_ins') return null;
      // Still call lockUser (idempotent): lock-expiry may have just unlocked them in ZITADEL while the row still
      // shows the timed lock, and without locking again the next sync would clear the admin lock. No compensation on
      // failure: stay locked (fail closed).
      return {
        to: 'inactive',
        steps: [(z, id) => z.lockUser(id)],
        compensate: [],
        lock: adminLock(),
        removesAccess: true,
        audit: 'users.locked',
      };
    case 'unlock':
      if (reason === null) return null;
      return {
        to: 'active',
        steps: [(z, id) => z.unlockUser(id)],
        compensate: [(z, id) => z.lockUser(id)],
        lock: null,
        removesAccess: false,
        audit: 'users.unlocked',
      };
  }
}

@Injectable()
export class UserStatusService {
  private readonly logger = new Logger(UserStatusService.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly store: UsersStore,
    private readonly zitadel: ZitadelAdminClient,
    private readonly audit: AuditService,
  ) {}

  /**
   * Runs `action` on `userId` with ZITADEL called outside any transaction: (A) guard + version snapshot tx,
   * (B) ZITADEL steps, (C) re-checked versioned write tx, compensating ZITADEL if (C) fails. The caller invalidates
   * the authz cache after this resolves.
   */
  async apply(
    scope: TxScope,
    actor: Actor,
    userId: string,
    action: UserStatusAction,
    assertAccess?: (tx: DbTransaction) => Promise<void>,
  ): Promise<void> {
    const { target, plan, idpOrgId } = await withTx(
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
        return { target: found, plan: planned, idpOrgId: org.idpOrgId };
      },
      READ_ONLY,
    );

    await this.runSteps(plan, target);

    try {
      await withTx(
        this.db,
        scope,
        actor,
        async (tx) => {
          await lockAccessRevision(tx, scope.tenantId);
          if (assertAccess) await assertAccess(tx);
          const current = await this.store.findById(tx, scope, userId, true);
          if (!current || current.idpOrgId !== idpOrgId) throw userChangedConflict();
          if ((current.version ?? null) !== (target.version ?? null)) {
            if (alreadyMatchesOutcome(action, current)) return;
            throw userChangedConflict();
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
      await this.compensate(plan, target);
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
    if (plan.removesAccess) await this.assertNotSoleFounder(tx, tenantId, target, action);
    return plan;
  }

  /**
   * The plan's ZITADEL calls in order, with no transaction open. When one fails after an earlier one succeeded,
   * `stepUndo` puts ZITADEL back (a locked person stays locked) before the error goes up.
   */
  private async runSteps(plan: Plan, target: UserRow): Promise<void> {
    for (const [index, step] of plan.steps.entries()) {
      try {
        await this.identityCall(() => step(this.zitadel, target.zitadelUserId));
      } catch (error) {
        if (index > 0 && plan.stepUndo) {
          await plan.stepUndo(this.zitadel, target.zitadelUserId).catch((undoError: unknown) => {
            const kind = undoError instanceof Error ? undoError.name : 'error';
            this.logger.error(
              `users.status: could not lock ${target.id} again in ZITADEL after a failed change (kind=${kind}); the next sync mirrors what ZITADEL holds`,
            );
          });
        }
        throw error;
      }
    }
  }

  /**
   * Restores ZITADEL to the pre-state after phase (C) fails or finds a changed row. Never throws; logs only the error
   * name so the original error propagates untouched.
   */
  private async compensate(plan: Plan, target: UserRow): Promise<void> {
    for (const step of plan.compensate) {
      try {
        await step(this.zitadel, target.zitadelUserId);
      } catch (undoError) {
        const kind = undoError instanceof Error ? undoError.name : 'error';
        this.logger.error(
          `users.status: could not restore ${target.id} in ZITADEL after a failed write (kind=${kind}); the next sync mirrors what ZITADEL holds`,
        );
        return;
      }
    }
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
