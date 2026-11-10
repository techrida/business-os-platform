import type { CostCenter } from '@bos/contracts';
import { costCenters, scoped } from '@bos/db';
import { ForbiddenException, Inject, Injectable } from '@nestjs/common';
import { asc } from 'drizzle-orm';

import { DB, type Db } from '../../../platform/db/db.module';
import { PurchaseRequestsCaller } from './purchase-requests.caller';

@Injectable()
export class CostCentersService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly caller: PurchaseRequestsCaller,
  ) {}

  /** The cost centres of the acting entity, ordered by name (then id, so equal names keep a stable order). */
  async list(): Promise<CostCenter[]> {
    const { principal, scope } = this.caller.current();
    if (principal.orgKind !== 'staff' || principal.status !== 'active') {
      throw new ForbiddenException({
        code: 'forbidden',
        message: 'Forbidden',
        reason: principal.status === 'active' ? 'no_permission' : 'inactive_user',
      });
    }
    return this.db
      .select({
        id: costCenters.id,
        code: costCenters.code,
        name: costCenters.name,
        active: costCenters.active,
      })
      .from(costCenters)
      .where(scoped(scope).where(costCenters))
      .orderBy(asc(costCenters.name), asc(costCenters.id));
  }
}
