// The credit hold of a deal for the people who may lift it (F1-Q20, F1-Q26): its position in NPR and the override.
// Route-level `credit.override` (Management and Finance by default, an on/off grant) is the whole check: Finance
// reads opportunities only at `own`, so the deal is found in the acting entity by id, never through the caller's
// opportunity scope, and only this narrow view of it is returned (no deal fields beyond the customer).
import { type CreditHoldDto, type CreditOverrideBody } from '@bos/contracts';
import { opportunities, scoped } from '@bos/db';
import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';

import { AuditService } from '../../platform/audit/audit.service';
import { AuthzService } from '../../platform/authz/authz.service';
import { DB, type Db } from '../../platform/db/db.module';
import { withTx, type DbTransaction, type TxScope } from '../../platform/db/tx';
import { nameIn, personNameMap } from '../../platform/users/person-names';
import { creditPosition } from './credit-hold';
import { OpportunitiesCaller } from './opportunities.caller';
import { type OpportunityRow } from './opportunities.types';

const notFound = () =>
  new NotFoundException({ code: 'not_found', message: 'Opportunity not found' });

@Injectable()
export class CreditHoldService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly caller: OpportunitiesCaller,
    private readonly authz: AuthzService,
    private readonly audit: AuditService,
  ) {}

  /** `GET /v1/opportunities/:id/credit-hold`: the deal's credit position now. 404 for a deal of another entity. */
  async get(id: string): Promise<CreditHoldDto> {
    const { scope, actor } = this.caller.current();
    this.assertMay(scope);
    return withTx(this.db, scope, actor, async (tx) => {
      const [row] = await tx
        .select()
        .from(opportunities)
        .where(scoped(scope).where(opportunities, eq(opportunities.id, id)));
      if (row === undefined) throw notFound();
      return this.toDto(tx, scope, row);
    });
  }

  /**
   * `POST /v1/opportunities/:id/credit-override`: lets the held deal's accepted quotation become a sales order. 404
   * for a deal of another entity; 409 `conflict` when the deal is not on hold (nothing to override). A deal already
   * overridden is returned as it is: the first override stands, and nothing new is written. The override is kept on
   * the deal (who, when, why) and audited (`opportunity.credit_overridden`, with the limit and exposure it was given
   * against). The deal's version moves, so a form open on it reloads.
   */
  async override(id: string, body: CreditOverrideBody): Promise<CreditHoldDto> {
    const { scope, actor, principal } = this.caller.current();
    this.assertMay(scope);
    return withTx(this.db, scope, actor, async (tx) => {
      const [row] = await tx
        .select()
        .from(opportunities)
        .where(scoped(scope).where(opportunities, eq(opportunities.id, id)))
        .for('update');
      if (row === undefined) throw notFound();
      if (row.creditOverrideAt !== null) return this.toDto(tx, scope, row);
      const position = await creditPosition(tx, scope, row.customerId);
      if (!position.held) {
        throw new ConflictException({
          code: 'conflict',
          message: 'This deal is not on credit hold; there is nothing to override',
        });
      }
      const now = new Date();
      const [updated] = await tx
        .update(opportunities)
        .set({
          creditOverrideReason: body.reason,
          creditOverrideByUserId: principal.userId,
          creditOverrideAt: now,
          updatedAt: now,
          version: sql`${opportunities.version} + 1`,
        })
        .where(scoped(scope).where(opportunities, eq(opportunities.id, id)))
        .returning();
      await this.audit.record(tx, {
        action: 'opportunity.credit_overridden',
        entityType: 'opportunities',
        entityId: id,
        before: { creditOverrideAt: null },
        after: { creditOverrideAt: now.toISOString(), creditOverrideByUserId: principal.userId },
        meta: {
          reason: body.reason,
          creditLimit: position.creditLimit,
          exposure: position.exposure,
          currency: 'NPR',
        },
      });
      return this.toDto(tx, scope, updated!);
    });
  }

  /** The route's `credit.override` again, on the acting entity: the grant is on/off, so it reaches every deal. */
  private assertMay(scope: TxScope): void {
    this.authz.assert('credit.override', {
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
    });
  }

  private async toDto(
    tx: DbTransaction,
    scope: TxScope,
    row: OpportunityRow,
  ): Promise<CreditHoldDto> {
    const position = await creditPosition(tx, scope, row.customerId);
    const by = row.creditOverrideByUserId;
    const names =
      by === null ? new Map<string, string>() : await personNameMap(tx, row.tenantId, [by]);
    return {
      opportunityId: row.id,
      customerId: row.customerId,
      currency: 'NPR',
      creditLimit: position.creditLimit,
      exposure: position.exposure,
      held: position.held,
      override:
        row.creditOverrideAt === null || row.creditOverrideReason === null || by === null
          ? null
          : {
              reason: row.creditOverrideReason,
              byUserId: by,
              byName: nameIn(names, by)!,
              at: row.creditOverrideAt.toISOString(),
            },
    };
  }
}
