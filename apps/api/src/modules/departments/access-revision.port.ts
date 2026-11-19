// Seam between the department save and the tenant's access revision counter (U20b, spec 7.2 and 7.6).
// The counter is the one `app.access_revisions` row that the access settings write path also bumps, so a
// department save and an access save refuse each other's stale views. It is not `authz_versions`, which also
// moves when a user's roles change.
import { ConflictException, Injectable } from '@nestjs/common';

import type { Db, DbTransaction } from '../../platform/db/db.module';
import type { TxScope } from '../../platform/db/tx';
import {
  bumpAccessRevision,
  lockAccessRevision,
  readAccessRevision,
} from '../access-settings/access-revision';

export const ACCESS_REVISION_PORT = Symbol('ACCESS_REVISION_PORT');

export interface AccessRevisionPort {
  /** The tenant's current access revision, an opaque string ("0" before the first change). */
  read(q: Db | DbTransaction, scope: TxScope): Promise<string>;
  /**
   * Takes the tenant's access write lock inside `tx`, refuses with 409 `stale_access` when `expectedRevision`
   * is given and no longer current, bumps the counter and returns the new revision.
   */
  bump(tx: DbTransaction, scope: TxScope, expectedRevision?: string): Promise<string>;
}

@Injectable()
export class AccessRevisionTableStore implements AccessRevisionPort {
  async read(q: Db | DbTransaction, scope: TxScope): Promise<string> {
    return (await readAccessRevision(q, scope.tenantId)).revision;
  }

  async bump(tx: DbTransaction, scope: TxScope, expectedRevision?: string): Promise<string> {
    await lockAccessRevision(tx, scope.tenantId);
    if (expectedRevision !== undefined) {
      const current = (await readAccessRevision(tx, scope.tenantId)).revision;
      if (current !== expectedRevision) {
        throw new ConflictException({
          code: 'stale_access',
          message: 'Access was changed by someone else. Reload to see the latest.',
        });
      }
    }
    return bumpAccessRevision(tx, scope);
  }
}
