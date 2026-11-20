// User status actions in Settings > Users (F1-Q5): deactivate, reactivate, lock and unlock a staff user from the app
// instead of the identity console, audited. A lock (F1-Q4) is the other way to shut someone out: ZITADEL locks a person
// by itself after too many failed sign-ins (a timed lock the lock-expiry job ends), and an admin may lock someone here
// (no expiry). Serves the NFR "a removed user must stop working": ZITADEL is the truth for whether a person can sign
// in, so each action changes ZITADEL and the mirror in the admin's transaction, while holding the user's row lock. The
// mirror's sync takes the same lock and re-reads ZITADEL before it changes a status or lock, so a sync that read the
// user before the action cannot write the older state back afterwards.
//
// What each action does depends on the person's status and lock (planFor):
//   deactivate  active: ZITADEL deactivate. Locked (either kind): ZITADEL unlock, then deactivate (ZITADEL holds them
//               LOCKED, and the lock goes); if the deactivate fails, they are locked again in ZITADEL.
//   reactivate  deactivated and not locked: ZITADEL reactivate.
//   lock        active: an admin lock, written here before ZITADEL is called. Under a failed-sign-in lock: the lock
//               becomes an admin lock that never ends by itself; ZITADEL already holds them LOCKED, so it is not called.
//   unlock      locked (either kind): ZITADEL unlock.
//
// Guards, all before ZITADEL is called: the target is a staff user of the caller's tenant, it is not the caller (no
// one shuts themselves out), the action fits its current status and lock, and an action that keeps or takes access
// away never leaves a legal entity without an effective Founder. The caller holds the access-revision lock (the
// controller takes it), the same lock role writes and access saves take, so two such actions cannot each see the
// other Founder.
import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';

import { AuditService } from '../audit/audit.service';
import type { DbTransaction } from '../db/db.module';
import type { Actor } from '../db/tx';
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
  /** The ZITADEL calls, in order; none when ZITADEL already holds the person as the action leaves them. */
  steps: ZitadelStep[];
  /** Puts ZITADEL back when a later step fails after an earlier one succeeded. */
  undo?: ZitadelStep;
  /** The lock to store with the new status: undefined keeps it, null clears it. */
  lock: UserLock | null | undefined;
  /**
   * Write here first and call ZITADEL last, just before commit. For a lock: a ZITADEL lock whose database write was
   * lost would look like a lock the app did not write. ZITADEL failing rolls the writes back.
   */
  identityLast: boolean;
  /** Whether the action takes or keeps access away (then the self and last-Founder guards apply). */
  removesAccess: boolean;
  audit: string;
}

const adminLock = (): UserLock => ({ reason: 'admin', lockedAt: new Date(), until: null });

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
          identityLast: false,
          removesAccess: true,
          audit: 'users.deactivated',
        };
      }
      if (reason === null) return null;
      return {
        to: 'inactive',
        steps: [(z, id) => z.unlockUser(id), (z, id) => z.deactivateUser(id)],
        undo: (z, id) => z.lockUser(id),
        lock: null,
        identityLast: false,
        removesAccess: true,
        audit: 'users.deactivated',
      };
    case 'reactivate':
      if (!deactivated) return null;
      return {
        to: 'active',
        steps: [(z, id) => z.reactivateUser(id)],
        lock: undefined,
        identityLast: false,
        removesAccess: false,
        audit: 'users.reactivated',
      };
    case 'lock':
      if (active) {
        return {
          to: 'inactive',
          steps: [(z, id) => z.lockUser(id)],
          lock: adminLock(),
          identityLast: true,
          removesAccess: true,
          audit: 'users.locked',
        };
      }
      if (reason !== 'failed_sign_ins') return null;
      return {
        to: 'inactive',
        steps: [],
        lock: adminLock(),
        identityLast: false,
        removesAccess: true,
        audit: 'users.locked',
      };
    case 'unlock':
      if (reason === null) return null;
      return {
        to: 'active',
        steps: [(z, id) => z.unlockUser(id)],
        lock: null,
        identityLast: false,
        removesAccess: false,
        audit: 'users.unlocked',
      };
  }
}

@Injectable()
export class UserStatusService {
  private readonly logger = new Logger(UserStatusService.name);

  constructor(
    private readonly store: UsersStore,
    private readonly zitadel: ZitadelAdminClient,
    private readonly audit: AuditService,
  ) {}

  /**
   * Runs `action` on `userId` in `tx` (the admin's, holding the access-revision lock). The caller invalidates the
   * authz cache after commit; the bumped authz version already drops the user's cached principal everywhere.
   */
  async apply(
    tx: DbTransaction,
    actor: Actor,
    userId: string,
    action: UserStatusAction,
  ): Promise<void> {
    const scope = await this.store.txScope(tx);
    const org = await this.store.staffIdpOrgOf(scope.tenantId);
    const target = await this.store.findById(tx, scope, userId, true);
    // Portal users are not administered here, as for roles and password resets.
    if (!org || !target || target.idpOrgId !== org.idpOrgId) {
      throw new NotFoundException('User not found');
    }
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
    if (plan.removesAccess) await this.assertNotSoleFounder(tx, scope.tenantId, target, action);

    const before = { status: target.status, lockReason: target.lockReason ?? null };
    if (!plan.identityLast) await this.runSteps(plan, target);
    await this.store.updateUser(tx, target.id, {
      email: target.email,
      displayName: target.displayName,
      status: plan.to,
      ...(plan.lock === undefined ? {} : { lock: plan.lock }),
    });
    // Every process drops its cached principals at once, so a deactivated person is refused on their next request.
    await this.store.bumpAuthzVersion(tx, scope);
    await this.audit.record(tx, {
      action: plan.audit,
      entityType: 'users',
      entityId: target.id,
      before,
      after: {
        status: plan.to,
        lockReason: plan.lock === undefined ? before.lockReason : (plan.lock?.reason ?? null),
      },
    });
    if (plan.identityLast) await this.runSteps(plan, target);
  }

  /**
   * The plan's ZITADEL calls in order. When one fails after an earlier one succeeded, `undo` puts ZITADEL back (a
   * locked person stays locked) before the error goes up and the transaction rolls back.
   */
  private async runSteps(plan: Plan, target: UserRow): Promise<void> {
    for (const [index, step] of plan.steps.entries()) {
      try {
        await this.identityCall(() => step(this.zitadel, target.zitadelUserId));
      } catch (error) {
        if (index > 0 && plan.undo) {
          await plan.undo(this.zitadel, target.zitadelUserId).catch((undoError: unknown) => {
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
