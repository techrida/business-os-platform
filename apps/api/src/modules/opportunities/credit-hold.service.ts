// The credit hold of a deal for the people who may lift it (F1-Q20, F1-Q26): its position in NPR and the override.
// Route-level `credit.override` (Management and Finance by default, an on/off grant) is the whole check: a holder
// need not read the deal (Settings may grant the override to a role whose opportunity read is narrower, or none),
// so the deal is found in the acting entity by id, never through the caller's opportunity scope, and only this
// narrow view of it is returned (no deal fields beyond the customer).
import { type CreditHoldDto, type CreditOverrideBody } from '@bos/contracts';
import { opportunities, scoped } from '@bos/db';
import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';

import { AuditService } from '../../platform/audit/audit.service';
import { AuthzService } from '../../platform/authz/authz.service';
import { DB, type Db } from '../../platform/db/db.module';
import { withTx, type DbTransaction, type TxScope, READ_ONLY } from '../../platform/db/tx';
import { nameIn, personNameMap } from '../../platform/users/person-names';
import { creditPosition, overrideCovers, type CreditPosition } from './credit-hold';
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
    return withTx(
      this.db,
      scope,
      actor,
      async (tx) => {
        const [row] = await tx
          .select()
          .from(opportunities)
          .where(scoped(scope).where(opportunities, eq(opportunities.id, id)));
        if (row === undefined) throw notFound();
        return this.toDto(tx, scope, row);
      },
      READ_ONLY,
    );
  }

  /**
   * `POST /v1/opportunities/:id/credit-override`: lets the held deal's accepted quotation become a sales order. 404
   * for a deal of another entity; 409 `conflict` when the deal is not on hold (nothing to override). A deal whose
   * override still covers the pending order is returned as it is: that override stands, and nothing new is written.
   * An override is tied to the value of the order it was given for (R5 FU4): when the pending order is worth more
   * than that, the hold stands again and a new override replaces the old one. The override is kept on the deal (who,
   * when, why, for what order value) and audited (`opportunity.credit_overridden`, with the limit, the receivables,
   * the uninvoiced orders and the pending order's value it was given against, and the override it replaced). The
   * deal's version moves, so a form open on it reloads.
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
      // The gate's rule (credit-hold.ts): receivables, uninvoiced orders and the deal's pending order, else a deal the
      // gate holds could never be overridden.
      const position = await creditPosition(tx, scope, row.customerId, { opportunityId: row.id });
      if (
        row.creditOverrideAt !== null &&
        (!position.held || overrideCovers(row.creditOverrideOrderValue, position.orderValue))
      ) {
        return this.toDto(tx, scope, row, position);
      }
      if (!position.held) {
        throw new ConflictException({
          code: 'conflict',
          message: 'This deal is not on credit hold; there is nothing to override',
        });
      }
      // The person gave the override for the order value they saw; if the deal's order is worth something else now
      // (a quotation was accepted or changed meanwhile), they have not reviewed it.
      if (body.orderValue !== undefined && body.orderValue !== position.orderValue) {
        throw new ConflictException({
          code: 'conflict',
          message:
            'The order on this deal changed since you opened the override; reload to see its value',
        });
      }
      const now = new Date();
      const [updated] = await tx
        .update(opportunities)
        .set({
          creditOverrideReason: body.reason,
          creditOverrideByUserId: principal.userId,
          creditOverrideAt: now,
          creditOverrideOrderValue: position.orderValue,
          updatedAt: now,
          version: sql`${opportunities.version} + 1`,
        })
        .where(scoped(scope).where(opportunities, eq(opportunities.id, id)))
        .returning();
      await this.audit.record(tx, {
        action: 'opportunity.credit_overridden',
        entityType: 'opportunities',
        entityId: id,
        before: {
          creditOverrideAt: row.creditOverrideAt?.toISOString() ?? null,
          creditOverrideOrderValue: row.creditOverrideOrderValue,
        },
        after: {
          creditOverrideAt: now.toISOString(),
          creditOverrideByUserId: principal.userId,
          creditOverrideOrderValue: position.orderValue,
        },
        meta: {
          reason: body.reason,
          creditLimit: position.creditLimit,
          exposure: position.exposure,
          uninvoiced: position.uninvoiced,
          orderValue: position.orderValue,
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
    known?: CreditPosition,
  ): Promise<CreditHoldDto> {
    const position =
      known ?? (await creditPosition(tx, scope, row.customerId, { opportunityId: row.id }));
    const by = row.creditOverrideByUserId;
    const names =
      by === null ? new Map<string, string>() : await personNameMap(tx, row.tenantId, [by]);
    return {
      opportunityId: row.id,
      customerId: row.customerId,
      currency: 'NPR',
      creditLimit: position.creditLimit,
      exposure: position.exposure,
      uninvoiced: position.uninvoiced,
      orderValue: position.orderValue,
      exposureWithOrder: position.exposureWithOrder,
      held: position.held,
      override:
        row.creditOverrideAt === null || row.creditOverrideReason === null || by === null
          ? null
          : {
              reason: row.creditOverrideReason,
              byUserId: by,
              byName: nameIn(names, by)!,
              at: row.creditOverrideAt.toISOString(),
              orderValue: row.creditOverrideOrderValue,
            },
      overrideCovers:
        row.creditOverrideAt !== null &&
        overrideCovers(row.creditOverrideOrderValue, position.orderValue),
    };
  }
}
