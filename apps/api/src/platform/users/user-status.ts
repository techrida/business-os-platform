// User status actions in Settings > Users (F1-Q5): deactivate and reactivate a staff user from the app instead of the
// identity console, audited. Serves the NFR "a removed user must stop working": ZITADEL is the truth for whether a
// person can sign in, so each action changes ZITADEL first and then the mirror, in the admin's transaction, while
// holding the user's row lock. The mirror's sync takes the same lock and re-reads ZITADEL before it changes a status,
// so a sync that read the user before the action cannot write the older state back afterwards.
//
// Guards, all before ZITADEL is called: the target is a staff user of the caller's tenant, it is not the caller (no
// one shuts themselves out), the action fits its current status, and an action that takes access away never leaves a
// legal entity without an effective Founder. The caller holds the access-revision lock (the controller takes it), the
// same lock role writes and access saves take, so two such actions cannot each see the other Founder.
import {
  ConflictException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';

import { AuditService } from '../audit/audit.service';
import type { DbTransaction } from '../db/db.module';
import type { Actor } from '../db/tx';
import { soleFounderEntities } from './user-mirror';
import { type UserRow, UsersStore } from './users.store';
import {
  type MirroredStatus,
  ZitadelAdminClient,
  ZitadelHttpError,
  ZitadelNotConfiguredError,
} from './zitadel-admin.client';

export const USER_STATUS_ACTIONS = ['deactivate', 'reactivate'] as const;
export type UserStatusAction = (typeof USER_STATUS_ACTIONS)[number];

interface ActionRule {
  /** The mirrored status the action starts from. */
  from: MirroredStatus;
  to: MirroredStatus;
  /** Whether the action takes access away (then the self and last-Founder guards apply). */
  removesAccess: boolean;
  audit: string;
  /** "You cannot <verb> your own account." */
  verb: string;
  wrongState: string;
}

const RULES: Record<UserStatusAction, ActionRule> = {
  deactivate: {
    from: 'active',
    to: 'inactive',
    removesAccess: true,
    audit: 'users.deactivated',
    verb: 'deactivate',
    // ZITADEL cannot deactivate a user who never finished the invitation.
    wrongState: 'Only an active user can be deactivated.',
  },
  reactivate: {
    from: 'inactive',
    to: 'active',
    removesAccess: false,
    audit: 'users.reactivated',
    verb: 'reactivate',
    wrongState: 'Only a deactivated user can be reactivated.',
  },
};

@Injectable()
export class UserStatusService {
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
    const rule = RULES[action];
    const scope = await this.store.txScope(tx);
    const org = await this.store.staffIdpOrgOf(scope.tenantId);
    const target = await this.store.findById(tx, scope, userId, true);
    // Portal users are not administered here, as for roles and password resets.
    if (!org || !target || target.idpOrgId !== org.idpOrgId) {
      throw new NotFoundException('User not found');
    }
    if (rule.removesAccess && target.id === actor.id) {
      throw new ConflictException({
        code: 'own_account',
        message: `You cannot ${rule.verb} your own account.`,
      });
    }
    if (target.status !== rule.from) {
      throw new ConflictException({ code: 'wrong_status', message: rule.wrongState });
    }
    if (rule.removesAccess) await this.assertNotSoleFounder(tx, scope.tenantId, target, rule);

    const before = target.status;
    await this.identityCall(() =>
      action === 'deactivate'
        ? this.zitadel.deactivateUser(target.zitadelUserId)
        : this.zitadel.reactivateUser(target.zitadelUserId),
    );
    await this.store.updateUser(tx, target.id, {
      email: target.email,
      displayName: target.displayName,
      status: rule.to,
    });
    // Every process drops its cached principals at once, so a deactivated person is refused on their next request.
    await this.store.bumpAuthzVersion(tx, scope);
    await this.audit.record(tx, {
      action: rule.audit,
      entityType: 'users',
      entityId: target.id,
      before: { status: before },
      after: { status: rule.to },
    });
  }

  private async assertNotSoleFounder(
    tx: DbTransaction,
    tenantId: string,
    target: UserRow,
    rule: ActionRule,
  ): Promise<void> {
    const entities = await soleFounderEntities(tx, this.store, tenantId, target.id);
    if (entities === null) return;
    // Never the email: the address is not a name (U20a2-Q10).
    const name = target.displayName?.trim() || 'This person';
    throw new ConflictException({
      code: 'last_founder',
      message: `${name} is the only Founder of ${entities}. Make someone else a Founder there before you ${rule.verb} them.`,
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
