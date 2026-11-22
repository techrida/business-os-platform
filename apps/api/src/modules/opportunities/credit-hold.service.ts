// The credit hold of a deal for the people who may lift it (F1-Q20, F1-Q26): its position in NPR and the override.
// Route-level `credit.override` (Management and Finance by default, an on/off grant) is the whole check: a holder
// need not read the deal (Settings may grant the override to a role whose opportunity read is narrower, or none),
// so the deal is found in the acting entity by id, never through the caller's opportunity scope, and only this
// narrow view of it is returned (no deal fields beyond the customer).
import { type CreditHoldDto, type CreditOverrideBody } from '@bos/contracts';
import { opportunities, quotations, quotationVersions, salesOrders, scoped } from '@bos/db';
import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, eq, inArray, sql } from 'drizzle-orm';

import { AuditService } from '../../platform/audit/audit.service';
import { AuthzService } from '../../platform/authz/authz.service';
import { DB, type Db } from '../../platform/db/db.module';
import { withTx, type DbTransaction, type TxScope, READ_ONLY } from '../../platform/db/tx';
import { nameIn, personNameMap } from '../../platform/users/person-names';
import { creditPosition, overrideCovers, type CreditPosition } from './credit-hold';
import { OpportunitiesCaller } from './opportunities.caller';
import { type OpportunityRow } from './opportunities.types';

type QuotationVersionRow = typeof quotationVersions.$inferSelect;

const notFound = () =>
  new NotFoundException({ code: 'not_found', message: 'Opportunity not found' });

/** The order value the person gave the override for is not the deal's order value now: they have not reviewed it. */
const orderChanged = () =>
  new ConflictException({
    code: 'conflict',
    message:
      'The order on this deal changed since you opened the override; reload to see its value',
  });

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
   * `POST /v1/opportunities/:id/credit-override`: lets one accepted quotation version of the held deal
   * (`body.quotationVersionId`) become a sales order at the order value the person saw (`body.orderValue`). 404 for
   * a deal of another entity, or a version that is not one of this deal's quotations; 409 `conflict` when the version
   * is not accepted or its quotation already has a confirmed or completed order, when the deal is not on hold for it
   * (nothing to override), or when the order is worth something else now than `body.orderValue`, also when an
   * override already stands. A deal whose override still covers that version at that value is returned as it is
   * when the body names that value: that override stands, and nothing new is written. An override covers
   * exactly one version and order value (R5 FU10, overrideCovers): a second order on the deal, a new version or
   * another value holds again, and a new override replaces the old one. The override is kept on the deal (who, when,
   * why, for which version and order value) and audited (`opportunity.credit_overridden`, with the limit, the
   * receivables, the uninvoiced orders and the version and order value it was given against, and the override it
   * replaced). The deal's version moves, so a form open on it reloads.
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
      const version = await this.versionOfDeal(tx, scope, row.id, body.quotationVersionId);
      // The gate's rule (credit-hold.ts) for the version the gate will confirm: receivables, uninvoiced orders and
      // that version's order, else a deal the gate holds could never be overridden.
      const position = await creditPosition(tx, scope, row.customerId, { version });
      const covers = overrideCovers(
        {
          versionId: row.creditOverrideQuotationVersionId,
          orderValue: row.creditOverrideOrderValue,
        },
        { versionId: version.id, orderValue: position.orderValue },
      );
      if (row.creditOverrideAt !== null && (!position.held || covers)) {
        // A repeat still names the order value the person saw (R5 FX5): a standing override is no answer to an
        // override given for another value, which is an order they have not reviewed.
        if (body.orderValue !== position.orderValue) throw orderChanged();
        return this.toDto(tx, scope, row);
      }
      if (!position.held) {
        throw new ConflictException({
          code: 'conflict',
          message: 'This deal is not on credit hold; there is nothing to override',
        });
      }
      // The person gave the override for the order value they saw; if the deal's order is worth something else now
      // (a quotation was accepted or changed meanwhile), they have not reviewed it.
      if (body.orderValue !== position.orderValue) throw orderChanged();
      const now = new Date();
      const [updated] = await tx
        .update(opportunities)
        .set({
          creditOverrideReason: body.reason,
          creditOverrideByUserId: principal.userId,
          creditOverrideAt: now,
          creditOverrideOrderValue: position.orderValue,
          creditOverrideQuotationVersionId: version.id,
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
          creditOverrideQuotationVersionId: row.creditOverrideQuotationVersionId,
        },
        after: {
          creditOverrideAt: now.toISOString(),
          creditOverrideByUserId: principal.userId,
          creditOverrideOrderValue: position.orderValue,
          creditOverrideQuotationVersionId: version.id,
        },
        meta: {
          reason: body.reason,
          creditLimit: position.creditLimit,
          exposure: position.exposure,
          uninvoiced: position.uninvoiced,
          orderValue: position.orderValue,
          quotationVersionId: version.id,
          currency: 'NPR',
        },
      });
      return this.toDto(tx, scope, updated!);
    });
  }

  /**
   * The accepted quotation version `versionId` of the deal, not yet ordered: the order the override is for. 404 when
   * it is not a version of one of this deal's quotations in the acting entity (never another deal's), 409 `conflict`
   * when it is not accepted, or its quotation already has a confirmed or completed order (the same test as the deal's
   * pending versions, credit-hold.ts). Plain reads: the deal row is locked, and the confirm locks the quotation and
   * then the version, so taking them here as well would add a second lock order.
   */
  private async versionOfDeal(
    tx: DbTransaction,
    scope: TxScope,
    opportunityId: string,
    versionId: string,
  ): Promise<QuotationVersionRow> {
    const [found] = await tx
      .select({ version: quotationVersions })
      .from(quotationVersions)
      .innerJoin(
        quotations,
        and(
          eq(quotations.tenantId, quotationVersions.tenantId),
          eq(quotations.organizationId, quotationVersions.organizationId),
          eq(quotations.id, quotationVersions.quotationId),
        ),
      )
      .where(
        scoped(scope).where(
          quotationVersions,
          and(eq(quotationVersions.id, versionId), eq(quotations.opportunityId, opportunityId)),
        ),
      );
    if (found === undefined) {
      throw new NotFoundException({ code: 'not_found', message: 'Quotation version not found' });
    }
    const { version } = found;
    if (version.status !== 'accepted') {
      throw new ConflictException({
        code: 'conflict',
        message: `A ${version.status} quotation cannot be ordered; only an accepted one needs a credit override`,
      });
    }
    const [ordered] = await tx
      .select({ id: salesOrders.id })
      .from(salesOrders)
      .where(
        scoped(scope).where(
          salesOrders,
          and(
            eq(salesOrders.quotationId, version.quotationId),
            inArray(salesOrders.status, ['confirmed', 'completed']),
          ),
        ),
      )
      .limit(1);
    if (ordered !== undefined) {
      throw new ConflictException({
        code: 'conflict',
        message: 'This quotation is already a sales order; there is nothing to override',
      });
    }
    return version;
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
      pendingQuotationVersionId: position.pendingQuotationVersionId,
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
              quotationVersionId: row.creditOverrideQuotationVersionId,
            },
      overrideCovers:
        row.creditOverrideAt !== null &&
        overrideCovers(
          {
            versionId: row.creditOverrideQuotationVersionId,
            orderValue: row.creditOverrideOrderValue,
          },
          { versionId: position.pendingQuotationVersionId, orderValue: position.orderValue },
        ),
    };
  }
}
