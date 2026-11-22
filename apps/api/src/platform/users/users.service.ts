// UsersService: the UserDirectory port (U1) plus the k-users API from P1-PLAN §6.2.
// Serves the NFR "authorization decisions use current data": the tenancy interceptor resolves every
// caller through resolve() here. The logic lives in UserMirror (no authz imports, so the worker can
// use it); this class adapts it to the port U1 injects, and repairs a half-finished invite.
import type { AccessLevel, AdminUsersQuery, RoleKey } from '@bos/contracts';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';

import { lockAccessRevision } from '../../modules/access-settings/access-revision';
import { UserDirectory } from '../authz/user-directory';
import { AuditService } from '../audit/audit.service';
import { DB, type Db, type DbTransaction } from '../db/db.module';
import { type Actor, READ_ONLY, type TxOptions, type TxScope, withTx } from '../db/tx';
import { type InvitedUser, type InviteInput, type ResolvedUser, UserMirror } from './user-mirror';
import {
  assertWithinOperationDeadline,
  IDENTITY_REVIEW_RESOLVED,
  withFounderRemovalLease,
} from './identity-reconcile';
import { type IdpOrgRow, type ListedUsers, UsersStore } from './users.store';
import { ZitadelAdminClient, ZitadelHttpError, type ZitadelUser } from './zitadel-admin.client';

export interface InvitePlacement {
  departmentId: string | null;
  level: AccessLevel;
}

// Takes the access-revision lock and/or user row lock before the first audited write, matching
// DepartmentsAdminService, AccessSettingsService, UserMirror.apply and UserLocks.whileLockHeld.
const AFTER_ACCESS_LOCK: TxOptions = { audit: 'lazy' };

@Injectable()
export class UsersService extends UserDirectory {
  private readonly logger = new Logger(UsersService.name);
  private readonly activityAttempts = new Map<string, number>();
  private activityInFlight = 0;

  constructor(
    private readonly mirror: UserMirror,
    private readonly store: UsersStore,
    private readonly zitadel: ZitadelAdminClient,
    @Inject(DB) private readonly db: Db,
    private readonly audit: AuditService,
  ) {
    super();
  }

  resolve(i: { zitadelUserId: string; tenantId: string; idpOrgId: string }): Promise<ResolvedUser> {
    return this.mirror.resolve(i);
  }

  userIdsWithRole(scope: TxScope, role: RoleKey, q?: Db | DbTransaction): Promise<string[]> {
    return this.mirror.userIdsWithRole(scope, role, q);
  }

  emailOf(userId: string, q?: Db | DbTransaction): Promise<string | null> {
    return this.mirror.emailOf(userId, q);
  }

  syncUser(zitadelUserId: string): Promise<void> {
    return this.mirror.syncUser(zitadelUserId).then(() => undefined);
  }

  reconcile(): Promise<{ scanned: number; changed: number }> {
    return this.mirror.reconcile();
  }

  list(scope: TxScope, q: AdminUsersQuery): Promise<ListedUsers> {
    return this.mirror.list(scope, q);
  }

  summary(scope: TxScope) {
    return this.store.summary(scope);
  }

  override recordActivity(scope: TxScope, actor: Actor): void {
    const key = `${scope.tenantId}:${actor.id}`;
    const now = Date.now();
    if ((this.activityAttempts.get(key) ?? 0) > now || this.activityInFlight >= 2) return;

    this.activityAttempts.delete(key);
    if (this.activityAttempts.size >= 10_000) {
      const oldest = this.activityAttempts.keys().next();
      if (!oldest.done) this.activityAttempts.delete(oldest.value);
    }
    this.activityAttempts.set(key, now + 5 * 60_000);
    this.activityInFlight += 1;
    void this.store
      .recordActivity(scope, actor)
      .catch(() => this.logger.warn('Could not record staff activity'))
      .finally(() => {
        this.activityInFlight -= 1;
      });
  }

  async sendPasswordReset(scope: TxScope, actor: Actor, userId: string): Promise<void> {
    const org = await this.store.staffIdpOrgOf(scope.tenantId);
    const target = await this.store.findById(this.db, scope, userId);
    if (!org || !target || target.idpOrgId !== org.idpOrgId) {
      throw new NotFoundException('User not found');
    }
    if (target.status === 'inactive') {
      throw new ConflictException('This user is deactivated');
    }
    // ZITADEL refuses a password reset for USER_STATE_INITIAL (Errors.User.NotInitialised): an
    // invited user has no password yet and finishes the invitation instead.
    if (target.status === 'invited') {
      throw new ConflictException('This user has not accepted their invitation yet');
    }
    // Check the source of truth as well as the mirror. Reconcile can lag behind deactivation.
    const live = await this.passwordResetProviderCall(() =>
      this.zitadel.getUser(target.zitadelUserId),
    );
    if (!live || live.orgId !== org.zitadelOrgId) throw new NotFoundException('User not found');
    if (live.status !== 'active' || !live.email) {
      throw new ConflictException('This user cannot receive a password reset email');
    }
    // Commit the request audit before calling the provider. The event describes the admin's
    // request, so it stays accurate even if the external email request fails or times out.
    await withTx(this.db, scope, actor, (tx) =>
      this.audit.record(tx, {
        action: 'users.password_reset_requested',
        entityType: 'users',
        entityId: target.id,
      }),
    );
    await this.passwordResetProviderCall(() =>
      this.zitadel.sendPasswordReset(target.zitadelUserId),
    );
  }

  private async passwordResetProviderCall<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch {
      // Provider failure details can contain identity data. Keep them out of logs and responses.
      throw new ServiceUnavailableException('Could not request a password reset email. Try again.');
    }
  }

  /**
   * Invites a user (and optionally places them in a department at a level, F1-Q50) with ZITADEL called outside any
   * transaction:
   *   (A) short READ_ONLY tx (when granting access): lock access-revision, check live grant, validate placement.
   *   (B) ZITADEL createHuman + setGrants + sendInviteCode (or finish an earlier open invite on 409).
   *   (C) short tx: re-lock access-revision, re-check live grant and placement, write mirror + membership + roles.
   * If (C) fails, shrinks the grants to what the database still allows and never deletes the identity (FU8; never
   * throwing), then rethrows the original error.
   */
  async invite(
    scope: TxScope,
    actor: Actor,
    b: InviteInput,
    placement: InvitePlacement | null = null,
    assertAccess?: (tx: DbTransaction) => Promise<void>,
  ): Promise<InvitedUser> {
    // One identity change at a time per tenant: the lease keeps two invites (or an invite and a role set) from running
    // their ZITADEL calls and writes interleaved.
    return withFounderRemovalLease(this.store, scope.tenantId, () =>
      this.inviteOnce(scope, actor, b, placement, assertAccess),
    );
  }

  private async inviteOnce(
    scope: TxScope,
    actor: Actor,
    b: InviteInput,
    placement: InvitePlacement | null,
    assertAccess?: (tx: DbTransaction) => Promise<void>,
  ): Promise<InvitedUser> {
    const assignsAccess = b.roles.length > 0 || placement !== null;
    const org = assignsAccess
      ? await withTx(
          this.db,
          scope,
          actor,
          async (tx) => {
            await lockAccessRevision(tx, scope.tenantId);
            if (assertAccess) await assertAccess(tx);
            const found = await this.store.staffIdpOrgOf(scope.tenantId, tx);
            if (!found) throw new NotFoundException('Organization not found');
            if (placement !== null) await this.assertPlacement(tx, scope, placement);
            return found;
          },
          READ_ONLY,
        )
      : await this.staffOrgOf(scope.tenantId);

    const prepared = await this.prepareInviteInZitadel(scope, actor, org, b);

    try {
      const userId = await withTx(
        this.db,
        scope,
        actor,
        async (tx) => {
          if (assignsAccess) {
            await lockAccessRevision(tx, scope.tenantId);
            if (assertAccess) await assertAccess(tx);
          }
          const entityId =
            placement !== null ? await this.assertPlacement(tx, scope, placement) : null;
          if (!prepared.created) {
            const existing = await this.store.findByZitadelId(tx, prepared.zitadelUserId, true);
            if (existing && existing.status !== 'invited') {
              throw new ConflictException('A user with this email already exists');
            }
          }
          const id = await this.mirror.writeInvitedUser(tx, org, scope, prepared.zitadelUserId, b);
          if (placement !== null && entityId !== null) {
            await this.store.placeMembership(tx, scope.tenantId, entityId, id, placement);
            await this.store.bumpAuthzVersion(tx, scope);
          }
          return id;
        },
        AFTER_ACCESS_LOCK,
      );
      return { userId, zitadelUserId: prepared.zitadelUserId, created: prepared.created };
    } catch (error) {
      await this.mirror.flagFailedInvite(scope, actor, org, prepared, b);
      throw error;
    }
  }

  /**
   * Resolves a person flagged for identity review (a failed or ambiguous write to ZITADEL left their state unsure): reads
   * ZITADEL again (it must answer), clears the flag under the locks with an audit row, then runs a full sync so the row
   * takes the status, lock and roles ZITADEL holds. If the sync fails the row stays closed and unflagged until the next
   * sync. The caller invalidates authz after this resolves.
   */
  async resolveIdentityReview(
    scope: TxScope,
    actor: Actor,
    userId: string,
    assertAccess?: (tx: DbTransaction) => Promise<void>,
  ): Promise<void> {
    const target = await withTx(
      this.db,
      scope,
      actor,
      async (tx) => {
        await lockAccessRevision(tx, scope.tenantId);
        if (assertAccess) await assertAccess(tx);
        const org = await this.store.staffIdpOrgOf(scope.tenantId, tx);
        const found = await this.store.findById(tx, scope, userId);
        if (!org || !found || found.idpOrgId !== org.idpOrgId) {
          throw new NotFoundException('User not found');
        }
        if (found.identityReviewRequired !== true) {
          throw new ConflictException({
            code: 'wrong_status',
            message: 'This person is not waiting for a review.',
          });
        }
        return found;
      },
      READ_ONLY,
    );

    // ZITADEL must answer before anything is cleared.
    const live = await this.zitadel.getUser(target.zitadelUserId);
    if (live === null || !live.status) {
      throw new ConflictException({
        code: 'identity_unreadable',
        message: 'The sign-in service does not know this person right now. Try again later.',
      });
    }

    await withTx(
      this.db,
      scope,
      actor,
      async (tx) => {
        await lockAccessRevision(tx, scope.tenantId);
        if (assertAccess) await assertAccess(tx);
        const current = await this.store.findById(tx, scope, userId, true);
        if (!current || current.identityReviewRequired !== true) return;
        await this.store.clearIdentityReview(tx, current.id);
        await this.store.bumpAuthzVersion(tx, scope);
        await this.audit.record(tx, {
          action: IDENTITY_REVIEW_RESOLVED,
          entityType: 'users',
          entityId: current.id,
          before: { reviewRequired: true, status: current.status },
          after: { reviewRequired: false },
          meta: { zitadel: { status: live.status, locked: live.locked === true } },
        });
      },
      AFTER_ACCESS_LOCK,
    );
    await this.mirror.syncUser(target.zitadelUserId);
  }

  /**
   * Whether `placement` fits a new person (F1-Q50), returning the default entity they are placed in. A head needs a
   * department; the department must be active, in the default entity, and without a head (changing a head goes
   * through Departments, which shows what the change does). The invite calls it in (A) and again in (C).
   */
  async assertPlacement(
    tx: DbTransaction,
    scope: TxScope,
    placement: InvitePlacement,
  ): Promise<string> {
    if (placement.level === 'head' && placement.departmentId === null) {
      throw new BadRequestException({
        code: 'validation',
        message: 'Choose a department for a department head.',
        details: { departmentId: 'Choose a department for a department head.' },
      });
    }
    const entityId = await this.store.defaultEntityOf(scope.tenantId, tx);
    if (!entityId) throw new NotFoundException('Organization not found');
    if (placement.departmentId !== null) {
      const department = await this.store.departmentForPlacement(
        tx,
        scope.tenantId,
        placement.departmentId,
      );
      if (!department || department.organizationId !== entityId) {
        throw new UnprocessableEntityException({
          code: 'unprocessable',
          message: 'That department is not available for new people. Choose another one.',
          details: { departmentId: 'Choose another department.' },
        });
      }
      if (department.status !== 'active') {
        throw new UnprocessableEntityException({
          code: 'unprocessable',
          message: `${department.name} is retired. Choose another department.`,
          details: { departmentId: 'Choose another department.' },
        });
      }
      if (placement.level === 'head' && department.headUserId !== null) {
        throw new ConflictException({
          code: 'department_has_head',
          message: `${department.name} already has a head. Add this person at another level, then change the head in Departments.`,
        });
      }
    }
    return entityId;
  }

  setRoles(
    scope: TxScope,
    actor: Actor,
    userId: string,
    roles: RoleKey[],
    assertAccess?: (tx: DbTransaction) => Promise<void>,
  ): Promise<void> {
    return this.mirror.setRoles(scope, actor, userId, roles, assertAccess);
  }

  private async staffOrgOf(tenantId: string): Promise<IdpOrgRow> {
    const org = await this.store.staffIdpOrgOf(tenantId);
    if (!org) throw new NotFoundException('Organization not found');
    return org;
  }

  /**
   * Creates the ZITADEL user, sets grants and sends the invite code with no transaction open. On 409 from
   * createHuman, walks the org for an open invite (an earlier half-finished attempt) and finishes its missing steps;
   * an email that belongs to a user who finished sign-up stays a 409.
   */
  private async prepareInviteInZitadel(
    scope: TxScope,
    actor: Actor,
    org: IdpOrgRow,
    b: InviteInput,
  ): Promise<{ zitadelUserId: string; created: boolean }> {
    let zitadelUserId: string | null = null;
    try {
      assertWithinOperationDeadline();
      zitadelUserId = await this.zitadel.createHuman(org.zitadelOrgId, b);
    } catch (error) {
      if (!(error instanceof ZitadelHttpError && error.status === 409)) throw error;
    }
    if (zitadelUserId !== null) {
      await this.finishInviteSteps(scope, actor, org, b, zitadelUserId);
      return { zitadelUserId, created: true };
    }

    const conflict = new ConflictException('A user with this email already exists');
    const open = await this.findOpenInvite(org.zitadelOrgId, b.email);
    if (!open) throw conflict;
    const row = await this.store.findByZitadelId(this.db, open.id);
    if (row && row.status !== 'invited') throw conflict;

    // The same steps as a first invite, in the same order. Each one is safe to repeat: setGrants replaces the whole
    // set, and sendInviteCode resends the invite link.
    await this.finishInviteSteps(scope, actor, org, b, open.id);
    return { zitadelUserId: open.id, created: false };
  }

  /**
   * Grants and invite mail for an identity that exists. A failure here may have changed ZITADEL (part of the grants, a
   * mail sent): the person is closed and flagged, with no roles in the database, and nothing is undone in ZITADEL.
   */
  private async finishInviteSteps(
    scope: TxScope,
    actor: Actor,
    org: IdpOrgRow,
    b: InviteInput,
    zitadelUserId: string,
  ): Promise<void> {
    try {
      assertWithinOperationDeadline();
      await this.zitadel.setGrants(zitadelUserId, org.zitadelOrgId, b.roles);
      assertWithinOperationDeadline();
      await this.zitadel.sendInviteCode(zitadelUserId);
    } catch (error) {
      await this.mirror.flagFailedInvite(scope, actor, org, { zitadelUserId }, b);
      throw error;
    }
  }

  /** ZITADEL has no lookup by email in our client, so walk the org's pages for an open invite. */
  private async findOpenInvite(zitadelOrgId: string, email: string): Promise<ZitadelUser | null> {
    const wanted = email.toLowerCase();
    let cursor: string | null = null;
    do {
      const page = await this.zitadel.listUsers(zitadelOrgId, cursor);
      const hit = page.users.find((u) => u.email?.toLowerCase() === wanted);
      if (hit) return hit.status === 'invited' ? hit : null;
      cursor = page.nextCursor;
    } while (cursor !== null);
    return null;
  }
}
