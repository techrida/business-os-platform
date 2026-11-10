import type { CostCenter } from '@bos/contracts';
import { costCenters, scoped } from '@bos/db';
import { ConflictException, ForbiddenException, Inject, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { asc, eq } from 'drizzle-orm';

import { AuditService } from '../../../platform/audit/audit.service';
import { can } from '../../../platform/authz/can';
import { withIdempotency } from '../../../platform/db/idempotency';
import { withTx } from '../../../platform/db/tx';
import { DB, type Db } from '../../../platform/db/db.module';
import { PurchaseRequestsCaller } from './purchase-requests.caller';

@Injectable()
export class CostCentersService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly caller: PurchaseRequestsCaller,
    @Optional() private readonly audit: AuditService = new AuditService(),
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

  async create(body: { code: string; name: string }, key: string): Promise<CostCenter> {
    const { scope, actor } = this.managementCaller();
    try {
      return await withTx(this.db, scope, actor, async tx => {
        const done = await withIdempotency(tx, { command: 'cost_center.create', key, body: { ...body, organizationId: scope.organizationId } }, async () => {
          const [row] = await tx.insert(costCenters).values({ ...scope, ...body }).returning();
          const result = this.dto(row!);
          await this.audit.record(tx, { action: 'cost_center.created', entityType: 'cost_centers', entityId: row!.id, after: result });
          return { status: 201, response: result };
        });
        return done.response;
      });
    } catch (error) {
      const pg = (error as { cause?: { code?: string; constraint?: string } }).cause;
      if (pg?.code === '23505' && pg.constraint === 'cost_centers_tenant_org_code_unique')
        throw new ConflictException({ code: 'conflict', message: 'This cost centre code already exists in this entity' });
      throw error;
    }
  }

  async update(id: string, body: { name?: string; active?: boolean }, key: string): Promise<CostCenter> {
    const { scope, actor } = this.managementCaller();
    return withTx(this.db, scope, actor, async tx => {
      const done = await withIdempotency(tx, { command: 'cost_center.update', key, body: { id, body, organizationId: scope.organizationId } }, async () => {
        const where = scoped(scope).where(costCenters, eq(costCenters.id, id));
        const [before] = await tx.select().from(costCenters).where(where).for('update');
        if (!before) throw new NotFoundException({code: 'not_found', message: 'Cost centre not found'});
        const [row] = await tx.update(costCenters).set({ ...body, updatedAt: new Date() }).where(where).returning();
        const result = this.dto(row!);
        await this.audit.record(tx, { action: 'cost_center.updated', entityType: 'cost_centers', entityId: id, before: this.dto(before), after: result });
        return { status: 200, response: result };
      });
      return done.response;
    });
  }

  private managementCaller() {
    const caller = this.caller.current();
    if (caller.principal.orgKind !== 'staff' || !can(caller.principal, 'admin.settings.write').allowed)
      throw new ForbiddenException({ code: 'forbidden', message: 'Forbidden' });
    return caller;
  }

  private dto(row: typeof costCenters.$inferSelect): CostCenter {
    return { id: row.id, code: row.code, name: row.name, active: row.active };
  }

}
