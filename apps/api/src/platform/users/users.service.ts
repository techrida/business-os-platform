// UsersService: the UserDirectory port (U1) plus the k-users API from P1-PLAN §6.2.
// Serves the NFR "authorization decisions use current data": the tenancy interceptor resolves every
// caller through resolve() here. The logic lives in UserMirror (no authz imports, so the worker can
// use it); this class adapts it to the port U1 injects, and repairs a half-finished invite.
import type { RoleKey } from '@bos/contracts';
import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';

import { UserDirectory } from '../authz/user-directory';
import type { DbTransaction } from '../db/db.module';
import type { TxScope } from '../db/tx';
import { type ResolvedUser, UserMirror } from './user-mirror';
import { type ListedUser, UsersStore } from './users.store';
import { ZitadelAdminClient, type ZitadelUser } from './zitadel-admin.client';

@Injectable()
export class UsersService extends UserDirectory {
  constructor(
    private readonly mirror: UserMirror,
    private readonly store: UsersStore,
    private readonly zitadel: ZitadelAdminClient,
  ) {
    super();
  }

  resolve(i: { zitadelUserId: string; tenantId: string; idpOrgId: string }): Promise<ResolvedUser> {
    return this.mirror.resolve(i);
  }

  userIdsWithRole(scope: TxScope, role: RoleKey): Promise<string[]> {
    return this.mirror.userIdsWithRole(scope, role);
  }

  emailOf(userId: string): Promise<string | null> {
    return this.mirror.emailOf(userId);
  }

  syncUser(zitadelUserId: string): Promise<void> {
    return this.mirror.syncUser(zitadelUserId).then(() => undefined);
  }

  reconcile(): Promise<{ scanned: number; changed: number }> {
    return this.mirror.reconcile();
  }

  list(scope: TxScope, q: { limit: number; after?: string | undefined }): Promise<ListedUser[]> {
    return this.mirror.list(scope, q);
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
  ): Promise<{ userId: string }> {
    try {
      return await this.mirror.invite(tx, b);
    } catch (error) {
      if (!(error instanceof ConflictException)) throw error;
      return this.finishInvite(tx, b, error);
    }
  }

  setRoles(tx: DbTransaction, userId: string, roles: RoleKey[]): Promise<void> {
    return this.mirror.setRoles(tx, userId, roles);
  }

  private async finishInvite(
    tx: DbTransaction,
    b: { email: string; givenName: string; familyName: string; roles: RoleKey[] },
    conflict: ConflictException,
  ): Promise<{ userId: string }> {
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
    return { userId };
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
