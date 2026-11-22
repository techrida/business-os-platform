// OpportunitiesService: reads and stage changes of opportunities, plus the two system-only moves that the
// quotation lifecycle makes (markQuotationSent, markWon). Serves the NFRs:
// - "the pipeline is auditable": every change is a row audited by the database trigger, and a stage change
//   also writes a domain event that carries the reason and note, and a stage history row (applyStageChange);
// - "no lost updates": a stage change names the version the caller saw; the row is locked, and a stale version
//   is a 409;
// - "authorization is deny-by-default": a record outside the caller's entity or scope is a 404, never a 403;
// - "Won is set by the system alone": the HTTP route cannot name won or quotation_sent, and the service
//   refuses them too, so a caller that skips the controller's parsing still cannot.
import {
  type LeadLostReasonRef,
  type OpportunityDto,
  type OpportunityStageChangeBody,
  type Permission,
} from '@bos/contracts';
import { customers, opportunities, quotations, salesOrders, scoped } from '@bos/db';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, desc, eq, inArray, sql, type SQL } from 'drizzle-orm';

import { AuditService } from '../../platform/audit/audit.service';
import { AuthzService, scopeWhereFor } from '../../platform/authz/authz.service';
import { loadRecordReaders, type RecordReaders } from '../../platform/authz/record-reach';
import { DB, type Db } from '../../platform/db/db.module';
import { withTx, type DbTransaction, type TxScope, READ_ONLY } from '../../platform/db/tx';
import { readTxContext } from '../../platform/documents/tx-context';
import { nameIn, personNameMap } from '../../platform/users/person-names';
import { searchPage } from '../../platform/list';
import { LeadLostReasonsService, lostReasonRefs } from '../leads/lost-reasons.service';
import { creditPosition, overrideCovers } from './credit-hold';
import { OpportunitiesCaller } from './opportunities.caller';
import type { OpportunityLostHandler } from './opportunities.ports';
import {
  type ListOpportunitiesQuery,
  type OpportunityRow,
  toOpportunityDto,
  toStageHistoryDto,
} from './opportunities.types';
import {
  applyStageChange,
  mayReopenOpportunity,
  opportunityRef,
  planStageChange,
  stageHistoryOf,
  type StageCaller,
  type StageChangeRefusal,
} from './opportunity-stage';

export { allowedOpportunityMoves, opportunityRef } from './opportunity-stage';

const AUDIT_ENTITY = 'opportunities';

const notFound = () =>
  new NotFoundException({ code: 'not_found', message: 'Opportunity not found' });

function refusalToException(kind: StageChangeRefusal, message: string): Error {
  switch (kind) {
    case 'reason_required':
      return new BadRequestException({ code: 'bad_request', message });
    case 'manager_only':
      return new ForbiddenException({ code: 'forbidden', message, reason: 'no_permission' });
    default:
      // stale, no_edge, system_only, not_system: the record's state does not allow this move.
      return new ConflictException({ code: 'conflict', message });
  }
}

@Injectable()
export class OpportunitiesService {
  private readonly lostHandlers = new Map<string, OpportunityLostHandler>();

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly authz: AuthzService,
    private readonly audit: AuditService,
    private readonly caller: OpportunitiesCaller,
    private readonly lostReasons: LeadLostReasonsService,
  ) {}

  /**
   * The quotations module calls this once when it starts. A duplicate name throws: two registrations of the
   * same handler would cancel the quotations twice.
   */
  registerLostHandler(handler: OpportunityLostHandler): void {
    if (this.lostHandlers.has(handler.name)) {
      throw new Error(`OpportunitiesService: lost handler "${handler.name}" is already registered`);
    }
    this.lostHandlers.set(handler.name, handler);
  }

  // -------------------------------------------------------------------------------------------------- read

  async list(q: ListOpportunitiesQuery): Promise<{ items: OpportunityDto[]; total: number }> {
    const { scope, principal } = this.caller.current();
    // Scope first; every filter only narrows it.
    const filters: SQL[] = [scopeWhereFor(principal, opportunities, 'crm.opportunity.read')];
    if (q.stage !== undefined && q.stage.length > 0) {
      filters.push(inArray(opportunities.stage, q.stage));
    }
    if (q.owner !== undefined && q.owner.length > 0) {
      filters.push(inArray(opportunities.ownerUserId, q.owner));
    }
    // The search also matches the customer's name, so the count runs over the same join as the rows.
    const customerOf = and(
      eq(customers.tenantId, opportunities.tenantId),
      eq(customers.id, opportunities.customerId),
    );
    const { rows, total } = await searchPage(this.db, {
      q: q.q,
      // The customer's name is only searchable by a caller who may read customers.
      columns: principal.grants.has('customer.read')
        ? [opportunities.name, opportunities.number, customers.legalName]
        : [opportunities.name, opportunities.number],
      where: scoped(scope).where(opportunities, and(...filters)),
      orderBy: [desc(opportunities.createdAt), desc(opportunities.id)],
      limit: q.limit,
      offset: q.offset,
      rows: (tx, p) =>
        tx
          .select({ opportunity: opportunities })
          .from(opportunities)
          .innerJoin(customers, customerOf)
          .where(p.where)
          .orderBy(...p.orderBy)
          .limit(p.limit)
          .offset(p.offset),
      count: async (tx, where) => {
        const [row] = await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(opportunities)
          .innerJoin(customers, customerOf)
          .where(where);
        return row?.n ?? 0;
      },
    });
    const names = await personNameMap(
      this.db,
      scope.tenantId,
      rows.map((r) => r.opportunity.ownerUserId),
    );
    const refs = await lostReasonRefs(
      this.db,
      scope.tenantId,
      rows.map((r) => r.opportunity.lostReasonId),
    );
    return {
      items: rows.map((r) =>
        toOpportunityDto(
          r.opportunity,
          nameIn(names, r.opportunity.ownerUserId),
          refs.get(r.opportunity.lostReasonId ?? '') ?? null,
          principal,
        ),
      ),
      total,
    };
  }

  async get(id: string): Promise<OpportunityDto> {
    const { scope, actor, principal } = this.caller.current();
    const [row] = await this.db
      .select()
      .from(opportunities)
      .where(scoped(scope).where(opportunities, eq(opportunities.id, id)));
    if (row === undefined) throw notFound();
    // The list reaches a deal through a follow-up assigned to the caller; the record check must see it too.
    this.assertVisible(
      'crm.opportunity.read',
      row,
      await loadRecordReaders(this.db, scope, opportunities, id),
    );
    // F1-Q20/F1-Q26: the flag only (the amounts are for credit.override holders), counting the accepted quotation's
    // order the way the sales order gate does (credit-hold.ts), and whether a sales order already
    // went ahead (a draft one is what the hold keeps waiting). In a transaction, so the ledger and the orders are
    // read under the entity's row security rather than seen as empty.
    // R4a Q13: the stage history comes with the detail, behind the same read check.
    const { credit, ordered, history } = await withTx(
      this.db,
      scope,
      actor,
      async (tx) => ({
        credit: await creditPosition(tx, scope, row.customerId, { opportunityId: row.id }),
        ordered: await this.hasSalesOrder(tx, scope, row.id),
        history: await stageHistoryOf(tx, scope, row.id),
      }),
      READ_ONLY,
    );
    const actorNames = await personNameMap(
      this.db,
      row.tenantId,
      history.map((h) => h.actorUserId),
    );
    return {
      ...toOpportunityDto(
        row,
        await this.ownerNameOf(this.db, row),
        await this.lostReasonOf(this.db, row),
        principal,
      ),
      creditHold: {
        // Once the deal's order is confirmed and no other accepted quotation waits to become one, nothing is left to
        // hold: the confirmed order's own balance counts in the position, and would keep the flag raised for good
        // (R5 FU10).
        held: credit.held && !(ordered && credit.pendingQuotationVersionId === null),
        // An override covers one quotation version at one order value (R5 FU10); once the deal is ordered it was
        // given and used, so it reads as overridden.
        overridden:
          row.creditOverrideAt !== null &&
          ((ordered && credit.pendingQuotationVersionId === null) ||
            overrideCovers(
              {
                versionId: row.creditOverrideQuotationVersionId,
                orderValue: row.creditOverrideOrderValue,
              },
              { versionId: credit.pendingQuotationVersionId, orderValue: credit.orderValue },
            )),
        ordered,
      },
      stageHistory: toStageHistoryDto(history, actorNames),
    };
  }

  /** Whether one of the deal's quotations became a confirmed or completed sales order (not a draft, not cancelled). */
  private async hasSalesOrder(tx: DbTransaction, scope: TxScope, id: string): Promise<boolean> {
    const [order] = await tx
      .select({ id: salesOrders.id })
      .from(salesOrders)
      .innerJoin(
        quotations,
        and(
          eq(quotations.tenantId, salesOrders.tenantId),
          eq(quotations.id, salesOrders.quotationId),
        ),
      )
      .where(
        scoped(scope).where(
          salesOrders,
          and(
            eq(quotations.opportunityId, id),
            inArray(salesOrders.status, ['confirmed', 'completed']),
          ),
        ),
      )
      .limit(1);
    return order !== undefined;
  }

  // ------------------------------------------------------------------------------------------ stage change

  /**
   * A user's move. Over HTTP, won and quotation_sent are still refused; a manager, head or founder with write
   * scope may also take the manager edge (reopening a lost opportunity). Lost carries an option of the shared
   * tenant list (D49, D54-3), or a new one added in the same step.
   */
  async changeStage(
    id: string,
    body: OpportunityStageChangeBody,
    by?: StageCaller,
  ): Promise<OpportunityDto> {
    const { scope, actor, principal } = this.caller.current();
    return withTx(this.db, scope, actor, async (tx) => {
      const row = await this.lock(tx, scope, id);
      // Scope first (404), then state (409): someone who may not edit learns nothing about the stage.
      this.assertVisible('crm.opportunity.write', row);
      // The reopen edge needs the live crm.opportunity.reopen grant on this deal's department as well as the level.
      const callerBy: StageCaller =
        by ?? (mayReopenOpportunity(principal, row) ? 'manager' : 'user');

      // Probe the planner first with a placeholder reason so scope/stale/edge errors win before choosing or
      // inserting a lost-reason option.
      let reason = body.reason;
      let lostReasonId: string | null = null;
      const planProbe = planStageChange({
        current: row.stage,
        currentVersion: row.version,
        to: body.stage,
        by: callerBy,
        reason: body.stage === 'lost' ? 'probe' : body.reason,
        note: body.note,
        expectedVersion: body.expectedVersion,
        heldFromStage: row.heldFromStage,
      });
      if (!planProbe.ok) throw refusalToException(planProbe.kind, planProbe.message);
      if (body.stage === 'lost') {
        const chosen = await this.lostReasons.choose(tx, scope.tenantId, body);
        reason = chosen.label;
        lostReasonId = chosen.id;
      }
      const plan = planStageChange({
        current: row.stage,
        currentVersion: row.version,
        to: body.stage,
        by: callerBy,
        reason,
        note: body.note,
        expectedVersion: body.expectedVersion,
        heldFromStage: row.heldFromStage,
      });
      if (!plan.ok) throw refusalToException(plan.kind, plan.message);

      // Leaving lost (or any move that is not to lost) clears the reference with the text.
      const updated = await applyStageChange(tx, row, body.expectedVersion, {
        ...plan.set,
        lostReasonId,
      });
      await this.audit.record(tx, {
        action: 'opportunity.stage_changed',
        entityType: AUDIT_ENTITY,
        entityId: id,
        before: { stage: row.stage, version: row.version },
        after: { stage: updated.stage, version: updated.version },
        meta: {
          reason: plan.set.stageReason,
          note: plan.set.stageNote,
          lostReasonId,
          ...(row.stage === 'on_hold' || updated.stage === 'on_hold'
            ? { heldFromStage: row.heldFromStage ?? plan.set.heldFromStage }
            : {}),
        },
      });
      if (updated.stage === 'lost') {
        // Same transaction: a handler that throws rolls the loss back.
        for (const handler of this.lostHandlers.values()) {
          await handler.onLost(tx, {
            opportunityId: id,
            scope,
            actor,
            reason: plan.set.stageReason ?? '',
            note: plan.set.stageNote ?? '',
          });
        }
      }
      return toOpportunityDto(
        updated,
        await this.ownerNameOf(tx, updated),
        await this.lostReasonOf(tx, updated),
        principal,
      );
    });
  }

  // ----------------------------------------------------------------------------- system-only moves (Q units)

  /**
   * Quotation sent: a system move from qualified, requirement_received or proposal_sent. Runs in the caller's
   * transaction (opened by withTx), so the opportunity and the quotation commit together. Already
   * quotation_sent or negotiation is left as it is and returned: sending a revised quotation is not a new
   * stage, and failing here would roll back the send. From won, lost or on_hold it is a 409.
   */
  async markQuotationSent(tx: DbTransaction, opportunityId: string): Promise<OpportunityDto> {
    const { scope } = await readTxContext(tx);
    const row = await this.lock(tx, scope, opportunityId);
    if (row.stage === 'quotation_sent' || row.stage === 'negotiation') {
      return toOpportunityDto(
        row,
        await this.ownerNameOf(tx, row),
        await this.lostReasonOf(tx, row),
      );
    }
    return this.systemMove(tx, row, 'quotation_sent', {});
  }

  /**
   * Won: a system move from quotation_sent or negotiation, carrying the accepted quotation version (the
   * database CHECK refuses a won row without it). Calling it again with the same version is a no-op, so a
   * retried acceptance does not fail; a different version on a won opportunity is a 409.
   */
  async markWon(
    tx: DbTransaction,
    opportunityId: string,
    quotationVersionId: string,
  ): Promise<OpportunityDto> {
    const { scope } = await readTxContext(tx);
    const row = await this.lock(tx, scope, opportunityId);
    if (row.stage === 'won' && row.wonQuotationVersionId === quotationVersionId) {
      return toOpportunityDto(
        row,
        await this.ownerNameOf(tx, row),
        await this.lostReasonOf(tx, row),
      );
    }
    return this.systemMove(tx, row, 'won', { wonQuotationVersionId: quotationVersionId });
  }

  private async systemMove(
    tx: DbTransaction,
    row: OpportunityRow,
    to: 'quotation_sent' | 'won',
    extra: { wonQuotationVersionId?: string },
  ): Promise<OpportunityDto> {
    const plan = planStageChange({
      current: row.stage,
      currentVersion: row.version,
      to,
      by: 'system',
    });
    if (!plan.ok) throw refusalToException(plan.kind, plan.message);
    const updated = await applyStageChange(tx, row, row.version, {
      ...plan.set,
      lostReasonId: null,
      ...extra,
    });
    await this.audit.record(tx, {
      action: `opportunity.${to}`,
      entityType: AUDIT_ENTITY,
      entityId: row.id,
      before: { stage: row.stage, version: row.version },
      after: { stage: updated.stage, version: updated.version },
      meta: extra.wonQuotationVersionId
        ? { wonQuotationVersionId: extra.wonQuotationVersionId }
        : {},
    });
    return toOpportunityDto(updated, await this.ownerNameOf(tx, updated), null);
  }

  /** The lost reason option of an opportunity, by its current label (D49, D54-3); null without one. */
  private async lostReasonOf(
    q: Db | DbTransaction,
    row: Pick<OpportunityRow, 'tenantId' | 'lostReasonId'>,
  ): Promise<LeadLostReasonRef | null> {
    if (row.lostReasonId === null) return null;
    return (
      (await lostReasonRefs(q, row.tenantId, [row.lostReasonId])).get(row.lostReasonId) ?? null
    );
  }

  /** The owner's display name (D46), read in the opportunity's tenant. */
  private async ownerNameOf(
    q: Db | DbTransaction,
    row: Pick<OpportunityRow, 'tenantId' | 'ownerUserId'>,
  ): Promise<string | null> {
    const names = await personNameMap(q, row.tenantId, [row.ownerUserId]);
    return nameIn(names, row.ownerUserId);
  }

  // ----------------------------------------------------------------------------------------------- helpers

  /**
   * Record-level authz that answers 404, not 403, for an opportunity outside the caller's scope: a 403 would
   * confirm that a guessed id exists. Other denials (no grant at all, inactive user) stay 403. `readers` only on a
   * read (opportunityRef).
   */
  private assertVisible(action: Permission, row: OpportunityRow, readers?: RecordReaders): void {
    try {
      this.authz.assert(action, opportunityRef(row, readers));
    } catch (error) {
      const reason =
        error instanceof ForbiddenException
          ? (error.getResponse() as { reason?: unknown }).reason
          : undefined;
      if (reason === 'out_of_scope') throw notFound();
      throw error;
    }
  }

  /**
   * The opportunity row of this entity, locked until the transaction ends. `updateVersioned` filters on the
   * tenant only, so this scoped read is what keeps another entity's opportunity out of reach.
   */
  private async lock(tx: DbTransaction, scope: TxScope, id: string): Promise<OpportunityRow> {
    const [row] = await tx
      .select()
      .from(opportunities)
      .where(scoped(scope).where(opportunities, eq(opportunities.id, id)))
      .for('update');
    if (row === undefined) throw notFound();
    return row;
  }
}
