// OpportunitiesService: reads and stage changes of opportunities, plus the two system-only moves that the
// quotation lifecycle makes (markQuotationSent, markWon). Serves the NFRs:
// - "the pipeline is auditable": every change is a row audited by the database trigger, and a stage change
//   also writes a domain event that carries the reason and note;
// - "no lost updates": a stage change names the version the caller saw; the row is locked, and a stale version
//   is a 409;
// - "authorization is deny-by-default": a record outside the caller's entity or scope is a 404, never a 403;
// - "Won is set by the system alone": the HTTP route cannot name won or quotation_sent, and the service
//   refuses them too, so a caller that skips the controller's parsing still cannot.
import {
  type OpportunityDto,
  type OpportunityStageChangeBody,
  type Permission,
} from '@bos/contracts';
import { customers, opportunities, scoped } from '@bos/db';
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
import { type ResourceRef } from '../../platform/authz/can';
import { DB, type Db } from '../../platform/db/db.module';
import { updateVersioned } from '../../platform/db/idempotency';
import { withTx, type DbTransaction, type TxScope } from '../../platform/db/tx';
import { readTxContext } from '../../platform/documents/tx-context';
import { nameIn, personNameMap } from '../../platform/users/person-names';
import { searchPage } from '../../platform/list';
import { OpportunitiesCaller } from './opportunities.caller';
import type { OpportunityLostHandler } from './opportunities.ports';
import {
  type ListOpportunitiesQuery,
  type OpportunityRow,
  toOpportunityDto,
} from './opportunities.types';
import { planStageChange, type StageCaller, type StageChangeRefusal } from './opportunity-stage';

const AUDIT_ENTITY = 'opportunities';

const notFound = () =>
  new NotFoundException({ code: 'not_found', message: 'Opportunity not found' });

/** What authz decides on for one opportunity. No party column: a portal grant reaches no opportunity. */
export function opportunityRef(row: OpportunityRow): ResourceRef {
  return {
    tenantId: row.tenantId,
    organizationId: row.organizationId,
    ownerUserId: row.ownerUserId,
  };
}

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
      columns: [opportunities.name, opportunities.number, customers.legalName],
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
    return {
      items: rows.map((r) =>
        toOpportunityDto(r.opportunity, nameIn(names, r.opportunity.ownerUserId)),
      ),
      total,
    };
  }

  async get(id: string): Promise<OpportunityDto> {
    const { scope } = this.caller.current();
    const [row] = await this.db
      .select()
      .from(opportunities)
      .where(scoped(scope).where(opportunities, eq(opportunities.id, id)));
    if (row === undefined) throw notFound();
    this.assertVisible('crm.opportunity.read', row);
    return toOpportunityDto(row, await this.ownerNameOf(this.db, row));
  }

  // ------------------------------------------------------------------------------------------ stage change

  /** A user's move. Only edges marked `user` are open: won, quotation_sent and the manager reopen are refused. */
  async changeStage(id: string, body: OpportunityStageChangeBody): Promise<OpportunityDto> {
    const { scope, actor } = this.caller.current();
    // Every HTTP caller is a plain user: only edges the table marks `user` are open. The manager edge (reopening a
    // lost opportunity) stays closed until the product names who a manager is; the planner already supports it.
    const by: StageCaller = 'user';
    return withTx(this.db, scope, actor, async (tx) => {
      const row = await this.lock(tx, scope, id);
      // Scope first (404), then state (409): someone who may not edit learns nothing about the stage.
      this.assertVisible('crm.opportunity.write', row);

      const plan = planStageChange({
        current: row.stage,
        currentVersion: row.version,
        to: body.stage,
        by,
        reason: body.reason,
        note: body.note,
        expectedVersion: body.expectedVersion,
      });
      if (!plan.ok) throw refusalToException(plan.kind, plan.message);

      const updated = await updateVersioned(tx, opportunities, id, body.expectedVersion, {
        ...plan.set,
        updatedAt: new Date(),
      });
      await this.audit.record(tx, {
        action: 'opportunity.stage_changed',
        entityType: AUDIT_ENTITY,
        entityId: id,
        before: { stage: row.stage, version: row.version },
        after: { stage: updated.stage, version: updated.version },
        meta: { reason: plan.set.stageReason, note: plan.set.stageNote },
      });
      if (updated.stage === 'lost') {
        // Same transaction: a handler that throws rolls the loss back.
        for (const handler of this.lostHandlers.values()) {
          await handler.onLost(tx, {
            opportunityId: id,
            scope,
            reason: plan.set.stageReason ?? '',
            note: plan.set.stageNote ?? '',
          });
        }
      }
      return toOpportunityDto(updated, await this.ownerNameOf(tx, updated));
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
      return toOpportunityDto(row, await this.ownerNameOf(tx, row));
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
      return toOpportunityDto(row, await this.ownerNameOf(tx, row));
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
    const updated = await updateVersioned(tx, opportunities, row.id, row.version, {
      ...plan.set,
      ...extra,
      updatedAt: new Date(),
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
    return toOpportunityDto(updated, await this.ownerNameOf(tx, updated));
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
   * confirm that a guessed id exists. Other denials (no grant at all, inactive user) stay 403.
   */
  private assertVisible(action: Permission, row: OpportunityRow): void {
    try {
      this.authz.assert(action, opportunityRef(row));
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
