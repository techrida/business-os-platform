// UsersService: the UserDirectory port (U1) plus the k-users API from P1-PLAN §6.2.
// Serves the NFR "authorization decisions use current data": the tenancy interceptor resolves every
// caller through resolve() here. The logic lives in UserMirror (no authz imports, so the worker can
// use it); this class only adapts it to the port U1 injects.
import type { RoleKey } from '@bos/contracts';
import { Injectable } from '@nestjs/common';

import { UserDirectory } from '../authz/user-directory';
import type { DbTransaction } from '../db/db.module';
import type { TxScope } from '../db/tx';
import { type ResolvedUser, UserMirror } from './user-mirror';
import type { ListedUser } from './users.store';

@Injectable()
export class UsersService extends UserDirectory {
  constructor(private readonly mirror: UserMirror) {
    super();
  }

  resolve(i: {
    zitadelUserId: string;
    tenantId: string;
    organizationId: string;
  }): Promise<ResolvedUser> {
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

  invite(
    tx: DbTransaction,
    b: { email: string; givenName: string; familyName: string; roles: RoleKey[] },
  ): Promise<{ userId: string }> {
    return this.mirror.invite(tx, b);
  }

  setRoles(tx: DbTransaction, userId: string, roles: RoleKey[]): Promise<void> {
    return this.mirror.setRoles(tx, userId, roles);
  }
}
