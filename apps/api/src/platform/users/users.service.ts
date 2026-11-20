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

import { UserDirectory } from '../authz/user-directory';
import { AuditService } from '../audit/audit.service';
import { DB, type Db, type DbTransaction } from '../db/db.module';
import { type Actor, type TxScope, withTx } from '../db/tx';
import { type InvitedUser, type ResolvedUser, UserMirror } from './user-mirror';
import { type ListedUsers, UsersStore } from './users.store';
import { ZitadelAdminClient, type ZitadelUser } from './zitadel-admin.client';

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
   * Invites a user. If ZITADEL already holds that email as a still-open invite (an earlier attempt
   * created the user, then failed before the grant or the mirror write), this finishes the missing
   * steps instead of failing with "already exists". An email that belongs to a user who finished
   * sign-up stays a 409: an invite must never re-grant roles to a live account.
   */
  async invite(
    tx: DbTransaction,
    b: { email: string; givenName: string; familyName: string; roles: RoleKey[] },
  ): Promise<InvitedUser> {
    try {
      return await this.mirror.invite(tx, b);
    } catch (error) {
      if (!(error instanceof ConflictException)) throw error;
      return this.finishInvite(tx, b, error);
    }
  }

  /**
   * F1-Q50: puts a just-invited person in a department at a level, on the membership the invite bootstrapped in the
   * tenant's default entity, checking the placement again first (assertPlacement).
   *
   * The caller checked the placement before the invite wrote anything to ZITADEL, holding the tenant's access-revision
   * lock, which every department write takes too (DepartmentsService.lockForDepartmentWrite), so this check cannot
   * normally fail. If it does, or the write fails, ZITADEL has already been written: this takes the person's roles
   * back there and deletes the identity when this invite created it (an identity that existed before, an earlier open
   * invite, is kept with no roles), then rethrows, and the transaction undoes the mirror rows. A ZITADEL failure while
   * taking things back is logged; the invite mail already sent cannot be recalled, but a deleted identity's link no
   * longer works.
   */
  async placeInvitee(
    tx: DbTransaction,
    invited: InvitedUser,
    placement: { departmentId: string | null; level: AccessLevel },
  ): Promise<void> {
    try {
      const entityId = await this.assertPlacement(tx, placement);
      const scope = await this.store.txScope(tx);
      await this.store.placeMembership(tx, scope.tenantId, entityId, invited.userId, placement);
      await this.store.bumpAuthzVersion(tx, scope);
    } catch (error) {
      await this.takeBackInvite(tx, invited);
      throw error;
    }
  }

  /**
   * Whether `placement` fits a new person (F1-Q50), returning the default entity they are placed in. A head needs a
   * department; the department must be active, in the default entity, and without a head (changing a head goes
   * through Departments, which shows what the change does). The invite calls it before ZITADEL is written.
   */
  async assertPlacement(
    tx: DbTransaction,
    placement: { departmentId: string | null; level: AccessLevel },
  ): Promise<string> {
    if (placement.level === 'head' && placement.departmentId === null) {
      throw new BadRequestException({
        code: 'validation',
        message: 'Choose a department for a department head.',
        details: { departmentId: 'Choose a department for a department head.' },
      });
    }
    const scope = await this.store.txScope(tx);
    const entityId = await this.store.defaultEntityOf(scope.tenantId);
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

  /** Undoes what an invite wrote to ZITADEL (see placeInvitee). Never throws: the caller rethrows its own error. */
  private async takeBackInvite(tx: DbTransaction, invited: InvitedUser): Promise<void> {
    const scope = await this.store.txScope(tx);
    const org = await this.store.staffIdpOrgOf(scope.tenantId);
    const kind = (error: unknown) => (error instanceof Error ? error.name : 'error');
    if (!org) return;
    try {
      await this.zitadel.setGrants(invited.zitadelUserId, org.zitadelOrgId, []);
    } catch (error) {
      this.logger.error(
        `users.invite: could not take back the roles of ${invited.zitadelUserId} in ZITADEL (kind=${kind(error)})`,
      );
    }
    if (!invited.created) return;
    try {
      await this.zitadel.deleteUser(invited.zitadelUserId);
    } catch (error) {
      this.logger.error(
        `users.invite: could not delete the identity ${invited.zitadelUserId} the failed invite created (kind=${kind(error)})`,
      );
    }
  }

  setRoles(tx: DbTransaction, userId: string, roles: RoleKey[]): Promise<void> {
    return this.mirror.setRoles(tx, userId, roles);
  }

  private async finishInvite(
    tx: DbTransaction,
    b: { email: string; givenName: string; familyName: string; roles: RoleKey[] },
    conflict: ConflictException,
  ): Promise<InvitedUser> {
    const scope = await this.store.txScope(tx);
    const org = await this.store.staffIdpOrgOf(scope.tenantId);
    if (!org) throw new NotFoundException('Organization not found');

    const open = await this.findOpenInvite(org.zitadelOrgId, b.email);
    if (!open) throw conflict;
    const row = await this.store.findByZitadelId(tx, open.id);
    if (row && row.status !== 'invited') throw conflict;

    // The same steps as a first invite, in the same order. Each one is safe to repeat: setGrants
    // replaces the whole set, insertUser returns the row that exists, the bootstrap membership is
    // added only when the user has none, replaceRoles diffs.
    await this.zitadel.setGrants(open.id, org.zitadelOrgId, b.roles);
    await this.zitadel.sendInviteCode(open.id);
    const userId = await this.store.insertUser(tx, scope, {
      zitadelUserId: open.id,
      idpOrgId: org.idpOrgId,
      email: b.email,
      displayName: `${b.givenName} ${b.familyName}`,
      status: 'invited',
    });
    await this.mirror.bootstrap(tx, org, scope, userId);
    if (b.roles.length > 0) {
      await this.store.replaceRoles(tx, scope, userId, b.roles);
      await this.store.bumpAuthzVersion(tx, scope);
    }
    return { userId, zitadelUserId: open.id, created: false };
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
