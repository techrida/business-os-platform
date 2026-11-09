// The departments lookup of the purchase request form (P4 unit P2e): the acting entity's departments as
// { id, name }, by name. Staff only: a portal caller, or a staff user who is not active, is answered 403 before the
// table is read. Read-only, so no transaction, audit or idempotency; same pattern as PurchaseRequestsService.list.
import { departments, scoped } from '@bos/db';
import { ForbiddenException, Inject, Injectable } from '@nestjs/common';
import { asc } from 'drizzle-orm';

import { DB, type Db } from '../../../platform/db/db.module';
import { PurchaseRequestsCaller } from './purchase-requests.caller';

export interface DepartmentLookupItem {
  id: string;
  name: string;
}

@Injectable()
export class DepartmentsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly caller: PurchaseRequestsCaller,
  ) {}

  /** The departments of the acting entity, ordered by name (then id, so equal names keep a stable order). */
  async list(): Promise<DepartmentLookupItem[]> {
    const { principal, scope } = this.caller.current();
    if (principal.orgKind !== 'staff' || principal.status !== 'active') {
      throw new ForbiddenException({
        code: 'forbidden',
        message: 'Forbidden',
        reason: principal.status === 'active' ? 'no_permission' : 'inactive_user',
      });
    }
    return this.db
      .select({ id: departments.id, name: departments.name })
      .from(departments)
      .where(scoped(scope).where(departments))
      .orderBy(asc(departments.name), asc(departments.id));
  }
}
