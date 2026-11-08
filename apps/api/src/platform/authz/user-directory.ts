// The port authz uses to look up users without depending on the users module (P1 plan §6.2).
// U6's `UsersModule` is global and provides it with `{ provide: UserDirectory, useExisting: UsersService }`.
// An abstract class, not an interface, so Nest can use it as the injection token.
import type { RoleKey } from '@bos/contracts';

import type { TxScope } from '../db/tx';
import type { Principal } from './principal';

export abstract class UserDirectory {
  /**
   * Maps a token identity to our user row. Creates the row (status `active`) and enqueues
   * `users.sync` when it is missing, so a first login works before the webhook arrives.
   *
   * The lookup is by ZITADEL id alone, so it returns the row's own `tenantId` and `organizationId`:
   * the tenancy interceptor refuses the request when they differ from the token's org (review R26).
   */
  abstract resolve(i: {
    zitadelUserId: string;
    tenantId: string;
    organizationId: string;
  }): Promise<{
    userId: string;
    status: Principal['status'];
    departmentId: string | null;
    tenantId: string;
    organizationId: string;
  }>;

  /** Active users holding `role` in this scope: the approver lookup for routing and notifications. */
  abstract userIdsWithRole(scope: TxScope, role: RoleKey): Promise<string[]>;

  /** The address to email, or null when the user has none or is unknown. */
  abstract emailOf(userId: string): Promise<string | null>;
}
