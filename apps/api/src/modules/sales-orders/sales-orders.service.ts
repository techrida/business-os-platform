// SalesOrdersService: the confirmed sale and its billing schedule (P3 unit U9; plan decisions A7, A14, A15).
// Serves the NFRs:
// - "no double effects": confirm runs under the quotation's row lock and inside withIdempotency, so a retry
//   (same key) replays and a second confirm of the same quotation (another key) finds the live order and returns
//   it instead of making a second one; the one-live-order unique index is the backstop, not the check;
// - "amounts are exact": totals, lines and tax are copied from the accepted version, the schedule is cut by
//   money-rules' splitSchedule so it adds up to the total to the paisa (the database re-checks at commit);
// - "no gaps in a numbered series": the SO number is taken last, in the same transaction;
// - "deny-by-default": every read goes through scoped(), so an order of another entity is a 404;
// - "a saved reach is the reach enforced" (U20a phase 2): an order is the caller's own when they confirmed it
//   (`created_by`, the column record-reach.ts registers) or own the quotation it was confirmed from, so a
//   salesperson keeps seeing the orders of their deals (ACCESS-SETTINGS-UX-SPEC 3.2: "Records they created or
//   own"). record-reach.ts registers both (`owner` and `ownerVia`, U20a2-Q1), so every `scopeWhereFor` on orders
//   reads the rule. Orders carry no department, so `department` reaches what `own` does. The list, the summary,
//   the detail and mark billable read the same rule (`readWhere` in SQL, `canOnOrder` on a row).
//
// Confirm, in one transaction (plan section 2, money command shape): withTx -> withIdempotency -> lock the
// quotation, then its version (the order QuotationOutcomeService.lockSent uses) -> checks (evidence confirmed and
// meeting the policy, F1-Q28) -> the draft the acceptance made (F1-Q25), or a new draft with lines, tax summary and
// schedule (draft-order.ts) -> the order locked -> evidence, the advance line billable -> NumberingService.issue
// (last row lock) -> draft to confirmed. Lock order: quotation, version, sales order, schedule line, number; the
// sales order before its lines, as InvoiceDraftingService.draftFromSchedule takes them, so a confirm and a draft of
// the advance line wait for each other instead of deadlocking. Mark billable: withTx -> withIdempotency -> sales
// order, then schedule line locks (LedgerService.lockForMoneyCommand) -> conditional updates. Delivery release
// (F1-Q32): withTx (tenant audit lock) -> withIdempotency -> the sales order lock -> checks -> the release row, so
// two releases of one order wait for each other and the second finds the first one's row.
import {
  trimPercent,
  type ConfirmSalesOrderBody,
  type EvidenceKind,
  type EvidencePolicy,
  type MarkBillableBody,
  type Permission,
  type ReleaseDeliveryBody,
  type SalesOrderDeliveryRelease,
  type SalesOrderDetail,
  type SalesOrderDraftState,
  type SalesOrderListItem,
  SALES_ORDER_STATUSES,
  type SalesOrderStatus,
  type ScheduleLineInvoice,
} from '@bos/contracts';
import {
  billingScheduleLines,
  customers,
  documents,
  invoices,
  openItems,
  opportunities,
  quotations,
  quotationVersions,
  salesOrderDeliveryReleases,
  salesOrderEvidence,
  salesOrderLines,
  salesOrders,
  scoped,
  users,
} from '@bos/db';
import {
  Dec,
  deliveryHoldReleaser,
  mayReleaseDeliveryHold,
  type DeliveryHoldReleaserRole,
} from '@bos/money-rules';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
  UnprocessableEntityException,
} from '@nestjs/common';
import { and, asc, count, desc, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm';

import { AuditService } from '../../platform/audit/audit.service';
import { scopeWhereFor } from '../../platform/authz/authz.service';
import { can } from '../../platform/authz/can';
import { type Decision, type Principal } from '../../platform/authz/principal';
import { liveGrantsOf } from '../../platform/authz/live-grants';
import { RoleCache } from '../../platform/authz/role-cache';
import { SqlUsersStore } from '../../platform/users/users.store';
import { isSoleEligible, otherEligibleUsers } from '../../platform/authz/sole-eligible';
import { DB, type Db, type DbTransaction } from '../../platform/db/db.module';
import { updateVersioned, withIdempotency } from '../../platform/db/idempotency';
import { withTx, type Actor, type TxScope, READ_ONLY } from '../../platform/db/tx';
import { assertNotInfected } from '../../platform/documents/documents.service';
import {
  assertEvidenceDocument,
  assertNoForeignEvidence,
  EVIDENCE_OWNER_TYPE,
} from '../../platform/documents/evidence-document';
import { searchPage, type SearchColumn } from '../../platform/list';
import { deliveryHoldThresholdNpr } from '../../platform/settings/delivery-hold';
import { NumberingService } from '../../platform/settings/numbering.service';
import { SettingsService } from '../../platform/settings/settings.service';
import { LedgerService } from '../ledger/ledger.service';
import { creditPosition } from '../opportunities/credit-hold';
import { missingEvidence } from '../quotations/outcome/evidence-policy';
import { readEvidenceState } from '../quotations/outcome/evidence-state';
import { insertDraftOrder, liveOrderOf, planDraftOrder } from './draft-order';
import { SalesOrdersCaller } from './sales-orders.caller';

/** Injection token for a test clock; production falls back to the system time. */
export const SALES_ORDERS_CLOCK = Symbol('SALES_ORDERS_CLOCK');

/** The numbering series of sales orders (plan A15): SO-2083/84-00001. */
const SO_SERIES = 'SO';
const AUDIT_ENTITY = 'sales_orders';

/** The list without `limit` returns every match (the quotation page and the confirm dialog never page). */
const NO_LIMIT = 2_147_483_647;

/** What `q` searches: the order number, the customer's name and the source quotation's number. */
const SEARCH_COLUMNS: readonly SearchColumn[] = [
  salesOrders.number,
  customers.legalName,
  quotations.number,
];

const customerOn = and(
  eq(customers.tenantId, salesOrders.tenantId),
  eq(customers.id, salesOrders.customerPartyId),
);
const quotationOn = and(
  eq(quotations.tenantId, salesOrders.tenantId),
  eq(quotations.id, salesOrders.quotationId),
);

/** The parsed `GET /v1/sales-orders` query (the controller's schema produces it). */
export interface SalesOrderListFilter {
  status?: SalesOrderStatus[] | undefined;
  customerId?: string[] | undefined;
  quotationVersionId?: string | undefined;
  q?: string | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
}

export interface SalesOrdersSummary {
  total: number;
  byStatus: Record<SalesOrderStatus, number>;
}

type OrderRow = typeof salesOrders.$inferSelect;
type LineRow = typeof billingScheduleLines.$inferSelect;
type EvidenceKindOfOrder = (typeof salesOrderEvidence.$inferInsert)['evidenceKind'];

const notFound = () =>
  new NotFoundException({ code: 'not_found', message: 'Sales order not found' });
const conflict = (code: string, message: string) => new ConflictException({ code, message });

/** Why the delivery-hold rule refuses a caller who holds `sales_order.delivery_release` (the 403's `reason`). */
type ReleaseRefusal = 'requester_cannot_release' | 'role_cannot_release_amount';
/** The detail's `can.releaseDeliveryBlockedBy`: the refusal above, or no permission at all. */
type ReleaseBlocker = 'requester' | 'amount' | 'permission';

/** An order and the owner of the quotation it was confirmed from: the two people `own` reaches it through. */
type OrderOwners = Pick<OrderRow, 'tenantId' | 'organizationId' | 'createdBy'> & {
  quotationOwnerUserId: string | null;
};

/**
 * The record twin of `readWhere`: `action` on the order is allowed when it reaches the order as the person who
 * confirmed it or as the quotation's owner. `all` passes on the first check; the denial reported is the first one.
 */
function canOnOrder(p: Principal, action: Permission, o: OrderOwners): Decision {
  const asOwner = (ownerUserId: string | null) =>
    can(p, action, { tenantId: o.tenantId, organizationId: o.organizationId, ownerUserId });
  const byCreator = asOwner(o.createdBy);
  if (byCreator.allowed) return byCreator;
  const byQuotation = asOwner(o.quotationOwnerUserId);
  return byQuotation.allowed ? byQuotation : byCreator;
}
const unprocessable = (code: string, message: string, extra: Record<string, unknown> = {}) =>
  new UnprocessableEntityException({ code, message, ...extra });
const iso = (d: Date): string => d.toISOString();

/** created_by and the like are uuid FKs to app.users; a system or seed actor is recorded as NULL. */
const userIdOf = (actor: Actor): string | null => (actor.kind === 'user' ? actor.id : null);

@Injectable()
export class SalesOrdersService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly settings: SettingsService,
    private readonly numbering: NumberingService,
    private readonly audit: AuditService,
    private readonly ledger: LedgerService,
    private readonly caller: SalesOrdersCaller,
    @Optional()
    @Inject(SALES_ORDERS_CLOCK)
    private readonly clock: () => Date = () => new Date(),
    // The small-team rule reads who else may release (F1-Q11 a). AuthzModule is global, so Nest injects the one
    // RoleCache; a test that builds the service by hand gets a fresh one on the same database.
    @Optional() private readonly roleCache: RoleCache = new RoleCache(db),
  ) {}

  // ------------------------------------------------------------------------------------------- reads

  /**
   * `GET /v1/sales-orders`: one page of the acting entity's orders, newest first (id breaks ties), and the number
   * of all matches. No `limit` returns every match: the quotation page and the confirm dialog ask for a few rows
   * and never page.
   */
  async list(filter: SalesOrderListFilter): Promise<{ rows: SalesOrderListItem[]; total: number }> {
    const { scope, actor, principal } = this.caller.current();
    this.assertStaff(principal);
    return withTx(
      this.db,
      scope,
      actor,
      async (tx) => {
        const { rows, total } = await searchPage(tx, {
          q: filter.q,
          columns: SEARCH_COLUMNS,
          where: this.listWhere(tx, scope, principal, filter),
          orderBy: [desc(salesOrders.createdAt), desc(salesOrders.id)],
          limit: filter.limit ?? NO_LIMIT,
          offset: filter.offset ?? 0,
          rows: (r, p) =>
            r
              .select({
                order: salesOrders,
                customerName: customers.legalName,
                quotationNumber: quotations.number,
              })
              .from(salesOrders)
              .innerJoin(customers, customerOn)
              .innerJoin(quotations, quotationOn)
              .where(p.where)
              .orderBy(...p.orderBy)
              .limit(p.limit)
              .offset(p.offset),
          count: async (r, where) => {
            const [row] = await r
              .select({ n: count() })
              .from(salesOrders)
              .innerJoin(customers, customerOn)
              .innerJoin(quotations, quotationOn)
              .where(where);
            return row?.n ?? 0;
          },
        });
        return {
          total,
          rows: rows.map(({ order, customerName, quotationNumber }) => ({
            id: order.id,
            number: order.number,
            customerId: order.customerPartyId ?? '',
            customerName,
            quotationNumber,
            status: order.status,
            currency: order.currency,
            total: order.total,
            confirmedAt: order.confirmedAt === null ? null : iso(order.confirmedAt),
          })),
        };
      },
      READ_ONLY,
    );
  }

  /**
   * `GET /v1/sales-orders/summary`: how many orders match `q` and `customerId` (not `status`), in total and per
   * status, so the stat cards stay right when the list is paged. Same scope and same search as `list`.
   */
  async summary(
    filter: Pick<SalesOrderListFilter, 'q' | 'customerId'>,
  ): Promise<SalesOrdersSummary> {
    const { scope, actor, principal } = this.caller.current();
    this.assertStaff(principal);
    return withTx(
      this.db,
      scope,
      actor,
      async (tx) => {
        // searchPage decides exact vs close matches from the total; the per-status counts ride on its count
        // callback so they always describe the same match set. Its last call is the one it settled on.
        let groups: { status: SalesOrderStatus; n: number }[] = [];
        const { total } = await searchPage(tx, {
          q: filter.q,
          columns: SEARCH_COLUMNS,
          where: this.listWhere(tx, scope, principal, filter),
          orderBy: [desc(salesOrders.id)],
          limit: 1,
          offset: 0,
          rows: () => Promise.resolve([]),
          count: async (r, where) => {
            groups = await r
              .select({ status: salesOrders.status, n: count() })
              .from(salesOrders)
              .innerJoin(customers, customerOn)
              .innerJoin(quotations, quotationOn)
              .where(where)
              .groupBy(salesOrders.status);
            return groups.reduce((sum, g) => sum + g.n, 0);
          },
        });
        const byStatus = Object.fromEntries(SALES_ORDER_STATUSES.map((s) => [s, 0])) as Record<
          SalesOrderStatus,
          number
        >;
        for (const g of groups) byStatus[g.status] = g.n;
        return { total, byStatus };
      },
      READ_ONLY,
    );
  }

  /** Scope, then filters. A filter only ever narrows what `readWhere` lets through. */
  private listWhere(
    tx: DbTransaction,
    scope: TxScope,
    principal: Principal,
    filter: SalesOrderListFilter,
  ): SQL {
    const conditions = [this.readWhere(principal)];
    if (filter.status !== undefined && filter.status.length > 0) {
      conditions.push(inArray(salesOrders.status, filter.status));
    }
    if (filter.customerId !== undefined && filter.customerId.length > 0) {
      conditions.push(inArray(salesOrders.customerPartyId, filter.customerId));
    }
    if (filter.quotationVersionId !== undefined) {
      conditions.push(eq(salesOrders.quotationVersionId, filter.quotationVersionId));
    }
    return scoped(scope).where(salesOrders, and(...conditions));
  }

  /** `GET /v1/sales-orders/:id`. 404 for an order of another entity. */
  async detail(id: string): Promise<SalesOrderDetail> {
    const { scope, actor, principal } = this.caller.current();
    this.assertStaff(principal);
    return withTx(
      this.db,
      scope,
      actor,
      (tx) => this.loadDetail(tx, scope, id, this.readWhere(principal)),
      READ_ONLY,
    );
  }

  /**
   * The orders the caller may read: the registered reach (record-reach.ts), which for `own` and `department` is
   * the orders the caller confirmed or whose quotation they own now, and the entity for `all`.
   */
  private readWhere(principal: Principal): SQL {
    return scopeWhereFor(principal, salesOrders, 'sales_order.read');
  }

  /** The current owner of the order's quotation, in the acting entity; null when it has none. */
  private async quotationOwnerOf(
    tx: DbTransaction,
    scope: TxScope,
    quotationId: string,
  ): Promise<string | null> {
    const [row] = await tx
      .select({ ownerUserId: quotations.ownerUserId })
      .from(quotations)
      .where(scoped(scope).where(quotations, eq(quotations.id, quotationId)))
      .limit(1);
    return row?.ownerUserId ?? null;
  }

  // ---------------------------------------------------------------------------------------- confirm

  /**
   * `POST /v1/sales-orders`: confirms the accepted quotation version as a sales order. 404 for a version outside
   * the entity; 409 `quotation_not_accepted`; 422 `evidence_not_confirmed` while a portal acceptance's evidence
   * waits for staff, `evidence_policy_unmet` when the accepted evidence does not meet the entity's policy now, `invalid_evidence_document` for a document of another entity or one removed, and
   * `invalid_payment_schedule` for a schedule that cannot be split. A second confirm of the same quotation
   * returns the existing order.
   */
  async confirmFromQuotation(
    body: ConfirmSalesOrderBody,
    idempotencyKey: string,
  ): Promise<SalesOrderDetail> {
    const { scope, actor, principal } = this.caller.current();
    this.assertStaff(principal);
    const done = await withTx(this.db, scope, actor, (tx) =>
      withIdempotency(
        tx,
        { command: 'sales_order.confirm', key: idempotencyKey, body },
        async () => ({ status: 201, response: await this.confirm(tx, scope, actor, body) }),
      ),
    );
    return done.response;
  }

  private async confirm(
    tx: DbTransaction,
    scope: TxScope,
    actor: Actor,
    body: ConfirmSalesOrderBody,
  ): Promise<SalesOrderDetail> {
    // Same lock order as QuotationOutcomeService.lockSent: the quotation, then the version.
    const [peek] = await tx
      .select({ quotationId: quotationVersions.quotationId })
      .from(quotationVersions)
      .where(
        scoped(scope).where(quotationVersions, eq(quotationVersions.id, body.quotationVersionId)),
      );
    if (peek === undefined) throw notFound();
    const [quotation] = await tx
      .select()
      .from(quotations)
      .where(scoped(scope).where(quotations, eq(quotations.id, peek.quotationId)))
      .for('update');
    if (quotation === undefined) throw notFound();
    const [version] = await tx
      .select()
      .from(quotationVersions)
      .where(
        scoped(scope).where(quotationVersions, eq(quotationVersions.id, body.quotationVersionId)),
      )
      .for('update');
    if (version === undefined) throw notFound();

    // The quotation lock serialises two confirms: the second one finds the first one's order here. A draft (made
    // when the quotation was accepted, F1-Q25) is confirmed below, through every check a new order passes.
    const live = await liveOrderOf(tx, scope, quotation.id);
    if (live !== undefined && live.status !== 'draft') return this.loadDetail(tx, scope, live.id);

    if (version.status !== 'accepted') {
      throw conflict(
        'quotation_not_accepted',
        `A ${version.status} quotation cannot be confirmed; only an accepted one can`,
      );
    }
    const customerPartyId = quotation.customerPartyId;
    if (customerPartyId === null) throw new Error(`quotation ${quotation.number} has no customer`);

    // F1-Q20/F1-Q26 (Kuu R4a Q1b): a customer whose open receivables plus this order's gross NPR value are over its
    // credit limit with this entity holds the deal here, the hand-over to a sales order, until a holder of
    // credit.override overrides the hold on the deal with a reason. The refusal names the deal only: the limit and
    // the balance are for holders of credit.override (GET /v1/opportunities/:id/credit-hold, the same rule).
    const credit = await creditPosition(tx, scope, customerPartyId, { version });
    if (credit.held) {
      const [deal] = await tx
        .select({ creditOverrideAt: opportunities.creditOverrideAt })
        .from(opportunities)
        .where(scoped(scope).where(opportunities, eq(opportunities.id, quotation.opportunityId)));
      if (deal?.creditOverrideAt == null) {
        throw new ConflictException({
          code: 'credit_hold',
          message:
            'The customer is over its credit limit; someone with credit override access must override the credit hold on the deal first',
          details: { opportunityId: quotation.opportunityId },
        });
      }
    }

    if (live !== undefined && live.quotationVersionId !== version.id) {
      throw conflict(
        'draft_of_other_revision',
        'This quotation already has a draft sales order of another revision',
      );
    }

    const {
      policy,
      kinds: acceptedKinds,
      documentIds: acceptedDocuments,
    } = await this.assertEvidenceReady(tx, scope, version.id);
    const documentIds = await this.evidenceDocuments(
      tx,
      scope,
      body.evidenceDocumentIds,
      acceptedDocuments,
      live?.id ?? null,
    );

    const now = this.clock();
    const userId = userIdOf(actor);
    let orderId: string;
    if (live !== undefined) {
      orderId = live.id;
    } else {
      const planned = await planDraftOrder(tx, scope, this.settings, quotation, version);
      if (!planned.ok) {
        // Data the accepted version should always carry (no customer, no NPR snapshot) is a server error.
        if (planned.refusal.code !== 'invalid_payment_schedule') {
          throw new Error(`quotation version ${version.id}: ${planned.refusal.message}`);
        }
        throw unprocessable(planned.refusal.code, planned.refusal.message);
      }
      orderId = await insertDraftOrder(tx, scope, quotation, version, planned.plan, userId);
    }
    // The order before its schedule lines (the UPDATE below locks the advance line), the order draftFromSchedule
    // takes them in.
    await this.ledger.lockForMoneyCommand(tx, scope, [
      { rank: 'sales_order', ids: [orderId], table: salesOrders },
    ]);

    if (documentIds.length > 0) {
      // The accepted evidence says which kinds exist, not which file is which: every file is filed under the first
      // kind the policy asks for that the acceptance carries (else the first kind it carries).
      const kind = this.kindToFileUnder(policy, acceptedKinds);
      await tx.insert(salesOrderEvidence).values(
        documentIds.map((documentId) => ({
          tenantId: scope.tenantId,
          organizationId: scope.organizationId,
          salesOrderId: orderId,
          evidenceKind: kind,
          documentId,
          createdBy: userId,
        })),
      );
    }
    // An advance line is billable from the moment the order is confirmed (never on a draft).
    await tx
      .update(billingScheduleLines)
      .set({ status: 'billable', billableMarkedBy: userId, billableMarkedAt: now, updatedAt: now })
      .where(
        scoped(scope).where(
          billingScheduleLines,
          and(
            eq(billingScheduleLines.salesOrderId, orderId),
            eq(billingScheduleLines.trigger, 'advance'),
            eq(billingScheduleLines.status, 'planned'),
          ),
        ),
      );

    // The number is the last lock of the transaction (plan section 2): nothing is locked after this.
    const issued = await this.numbering.issue(tx, SO_SERIES, now);
    const confirmed = await tx
      .update(salesOrders)
      .set({
        status: 'confirmed',
        number: issued.number,
        seq: issued.seq,
        fiscalYear: issued.fiscalYear,
        confirmedAt: now,
        confirmedBy: userId,
        // A drafted order was made by the acceptance; whoever confirms it is its creator for `own` reach.
        createdBy: sql`coalesce(${salesOrders.createdBy}, ${userId}::uuid)`,
        updatedAt: now,
      })
      .where(
        scoped(scope).where(
          salesOrders,
          and(eq(salesOrders.id, orderId), eq(salesOrders.status, 'draft')),
        ),
      )
      .returning({ id: salesOrders.id });
    if (confirmed.length === 0) throw new Error(`sales order ${orderId} left draft during confirm`);

    const schedule = await tx
      .select()
      .from(billingScheduleLines)
      .where(
        scoped(scope).where(billingScheduleLines, eq(billingScheduleLines.salesOrderId, orderId)),
      )
      .orderBy(asc(billingScheduleLines.seq));
    await this.audit.record(tx, {
      action: 'sales_order.confirmed',
      entityType: AUDIT_ENTITY,
      entityId: orderId,
      before: live === undefined ? null : { status: 'draft' },
      after: {
        number: issued.number,
        quotationId: quotation.id,
        quotationVersionId: version.id,
        total: version.total,
        evidencePolicy: policy,
        evidenceDocumentIds: documentIds,
        schedule: schedule.map((l) => ({ label: l.label, trigger: l.trigger, amount: l.amount })),
      },
    });
    return this.loadDetail(tx, scope, orderId);
  }

  /**
   * The evidence gate of confirm (F1-Q28): a portal acceptance's evidence must be confirmed by staff (422
   * `evidence_not_confirmed`), and what the version stands on must meet the policy now (422 `evidence_policy_unmet`).
   */
  private async assertEvidenceReady(
    tx: DbTransaction,
    scope: TxScope,
    versionId: string,
  ): Promise<{ policy: EvidencePolicy; kinds: EvidenceKind[]; documentIds: string[] }> {
    const readiness = await this.draftReadiness(tx, scope, versionId);
    if (readiness.blocker === 'evidence_not_confirmed') {
      throw unprocessable(
        'evidence_not_confirmed',
        'The customer accepted in the portal; confirm the evidence on the quotation first',
      );
    }
    if (readiness.blocker === 'evidence_policy_unmet') {
      throw unprocessable(
        'evidence_policy_unmet',
        `This entity's evidence policy (${readiness.policy}) also needs: ${readiness.missing.join(', ')}`,
        { policy: readiness.policy, missing: readiness.missing },
      );
    }
    return {
      policy: readiness.policy,
      kinds: readiness.evidenceKinds,
      documentIds: readiness.evidenceDocumentIds,
    };
  }

  /** What stands between an accepted version and its order: the confirm gate and a draft's detail read this. */
  private async draftReadiness(
    tx: DbTransaction,
    scope: TxScope,
    versionId: string,
  ): Promise<SalesOrderDraftState> {
    const evidence = await readEvidenceState(tx, scope, versionId);
    const kinds: EvidenceKind[] = evidence?.kinds ?? [];
    const policy = await this.settings.get(scope, 'sales.evidence_policy');
    const missing = missingEvidence(policy, kinds);
    const evidenceStatus = evidence?.status ?? 'pending';
    return {
      evidenceStatus,
      policy,
      missing,
      evidenceKinds: kinds,
      evidenceDocumentIds: evidence?.documentIds ?? [],
      blocker:
        evidenceStatus === 'pending' && evidence !== undefined
          ? 'evidence_not_confirmed'
          : missing.length > 0
            ? 'evidence_policy_unmet'
            : null,
    };
  }

  // ----------------------------------------------------------------------------------- mark billable

  /**
   * `POST /v1/sales-orders/:id/schedule-lines/:lineId/mark-billable`: a milestone or UAT fired. Only a planned
   * line moves; a line other than an advance needs an evidence document: one uploaded to this order (owner type
   * `evidence`) or one already filed as the order's evidence. `expectedVersion` is the order's version (schedule
   * lines have none in the DTO) and the command bumps it. 404 for an order or line outside the entity, 409 for a
   * stale version, a closed order or a line that is not planned, 422 `evidence_required` or
   * `invalid_evidence_document`, 409 `document_infected`.
   */
  async markBillable(
    orderId: string,
    lineId: string,
    body: MarkBillableBody,
    idempotencyKey: string,
  ): Promise<SalesOrderDetail> {
    const { scope, actor, principal } = this.caller.current();
    this.assertStaff(principal);
    const done = await withTx(this.db, scope, actor, (tx) =>
      withIdempotency(
        tx,
        {
          command: 'sales_order.mark_billable',
          key: idempotencyKey,
          body: { orderId, lineId, ...body },
        },
        async () => ({
          status: 201,
          response: await this.markLineBillable(tx, scope, actor, principal, orderId, lineId, body),
        }),
      ),
    );
    return done.response;
  }

  private async markLineBillable(
    tx: DbTransaction,
    scope: TxScope,
    actor: Actor,
    principal: Principal,
    orderId: string,
    lineId: string,
    body: MarkBillableBody,
  ): Promise<SalesOrderDetail> {
    const [peek] = await tx
      .select({ id: billingScheduleLines.id })
      .from(billingScheduleLines)
      .where(
        scoped(scope).where(
          billingScheduleLines,
          and(eq(billingScheduleLines.id, lineId), eq(billingScheduleLines.salesOrderId, orderId)),
        ),
      );
    if (peek === undefined) throw notFound();
    // Plan section 2 lock order: the sales order, then its schedule line.
    await this.ledger.lockForMoneyCommand(tx, scope, [
      { rank: 'sales_order', ids: [orderId], table: salesOrders },
      { rank: 'schedule_line', ids: [lineId], table: billingScheduleLines },
    ]);
    const [order] = await tx
      .select()
      .from(salesOrders)
      .where(scoped(scope).where(salesOrders, eq(salesOrders.id, orderId)));
    const [line] = await tx
      .select()
      .from(billingScheduleLines)
      .where(scoped(scope).where(billingScheduleLines, eq(billingScheduleLines.id, lineId)));
    if (order === undefined || line === undefined) throw notFound();
    // An order outside the caller's read is a 404, as on GET; one they may read but not mark is a 403.
    const owners = {
      ...order,
      quotationOwnerUserId: await this.quotationOwnerOf(tx, scope, order.quotationId),
    };
    if (!canOnOrder(principal, 'sales_order.read', owners).allowed) throw notFound();
    const decision = canOnOrder(principal, 'sales_order.mark_billable', owners);
    if (!decision.allowed) {
      throw new ForbiddenException({
        code: 'forbidden',
        message: 'Forbidden',
        reason: decision.reason,
      });
    }
    if (order.status !== 'confirmed') {
      throw conflict(
        'sales_order_not_open',
        `A ${order.status} sales order has no schedule line to mark`,
      );
    }
    if (line.status !== 'planned') {
      throw conflict(
        'schedule_line_not_planned',
        `This schedule line is ${line.status}; only a planned line can be marked billable`,
      );
    }
    if (line.trigger !== 'advance' && body.evidenceDocumentId === undefined) {
      throw unprocessable(
        'evidence_required',
        `A ${line.trigger} line needs an evidence document to become billable`,
      );
    }
    if (body.evidenceDocumentId !== undefined) {
      // Round 5 P2: evidence uploaded to this order, or a file already filed as the order's evidence (the dialog's
      // list). Never a picture, a payment proof or a file of another record (422 invalid_evidence_document).
      const recorded = await tx
        .select({ documentId: salesOrderEvidence.documentId })
        .from(salesOrderEvidence)
        .where(
          scoped(scope).where(salesOrderEvidence, eq(salesOrderEvidence.salesOrderId, orderId)),
        );
      await assertEvidenceDocument(
        tx,
        scope,
        body.evidenceDocumentId,
        orderId,
        recorded.map((r) => r.documentId),
      );
    }

    const now = this.clock();
    await updateVersioned(tx, salesOrders, orderId, body.expectedVersion, { updatedAt: now });
    const moved = await tx
      .update(billingScheduleLines)
      .set({
        status: 'billable',
        billableEvidenceDocumentId: body.evidenceDocumentId ?? null,
        billableMarkedBy: userIdOf(actor),
        billableMarkedAt: now,
        updatedAt: now,
        version: line.version + 1,
      })
      .where(
        scoped(scope).where(
          billingScheduleLines,
          and(
            eq(billingScheduleLines.id, lineId),
            eq(billingScheduleLines.status, 'planned'),
            eq(billingScheduleLines.version, line.version),
          ),
        ),
      )
      .returning({ id: billingScheduleLines.id });
    if (moved.length === 0) {
      throw conflict('schedule_line_not_planned', 'This schedule line was changed by someone else');
    }
    await this.audit.record(tx, {
      action: 'sales_order.line_billable',
      entityType: AUDIT_ENTITY,
      entityId: orderId,
      before: { lineId, status: 'planned' },
      after: {
        lineId,
        status: 'billable',
        trigger: line.trigger,
        evidenceDocumentId: body.evidenceDocumentId ?? null,
      },
    });
    return this.loadDetail(tx, scope, orderId);
  }

  // -------------------------------------------------------------------------------- delivery release

  /**
   * `POST /v1/sales-orders/:id/delivery-release`: lets a confirmed order's delivery go before its advance is paid
   * (F1-Q32, D56). 404 for an order outside the entity or the caller's read; 403 without
   * `sales_order.delivery_release`, or with reason `requester_cannot_release` (the order's creator) or
   * `role_cannot_release_amount` (no role of the caller's may release this amount under the live threshold:
   * Finance above it, Management at or below it; the detail's `can.releaseDeliveryAllowedRoles` names who may); 409
   * `sales_order_not_open` for an order that is not confirmed, `delivery_already_released` when the advance is paid
   * or a release exists. A retry with the same key replays. The small-team rule (F1-Q11 a) lifts
   * `requester_cannot_release` for a Founder whom nobody else could stand in for: the release then needs a reason
   * (400 `sole_eligible_reason_required`) and is audited as `sales_order.delivery_released_sole_eligible`.
   */
  async releaseDelivery(
    orderId: string,
    body: ReleaseDeliveryBody,
    idempotencyKey: string,
  ): Promise<SalesOrderDetail> {
    const { scope, actor, principal } = this.caller.current();
    this.assertStaff(principal);
    const done = await withTx(this.db, scope, actor, (tx) =>
      withIdempotency(
        tx,
        {
          command: 'sales_order.delivery_release',
          key: idempotencyKey,
          body: { orderId, ...body },
        },
        async () => ({
          status: 201,
          response: await this.recordRelease(tx, scope, principal, orderId, body),
        }),
      ),
    );
    return done.response;
  }

  private async recordRelease(
    tx: DbTransaction,
    scope: TxScope,
    principal: Principal,
    orderId: string,
    body: ReleaseDeliveryBody,
  ): Promise<SalesOrderDetail> {
    const [peek] = await tx
      .select({ id: salesOrders.id })
      .from(salesOrders)
      .where(scoped(scope).where(salesOrders, eq(salesOrders.id, orderId)));
    if (peek === undefined) throw notFound();
    await this.ledger.lockForMoneyCommand(tx, scope, [
      { rank: 'sales_order', ids: [orderId], table: salesOrders },
    ]);
    const [order] = await tx
      .select()
      .from(salesOrders)
      .where(scoped(scope).where(salesOrders, eq(salesOrders.id, orderId)));
    if (order === undefined) throw notFound();
    const owners = {
      ...order,
      quotationOwnerUserId: await this.quotationOwnerOf(tx, scope, order.quotationId),
    };
    if (!canOnOrder(principal, 'sales_order.read', owners).allowed) throw notFound();
    const decision = canOnOrder(principal, 'sales_order.delivery_release', owners);
    if (!decision.allowed) {
      throw new ForbiddenException({
        code: 'forbidden',
        message: 'Forbidden',
        reason: decision.reason,
      });
    }
    if (order.status !== 'confirmed') {
      throw conflict(
        'sales_order_not_open',
        `A ${order.status} sales order has no delivery to release`,
      );
    }
    const schedule = await tx
      .select()
      .from(billingScheduleLines)
      .where(
        scoped(scope).where(billingScheduleLines, eq(billingScheduleLines.salesOrderId, orderId)),
      );
    const released = await this.deliveryState(tx, scope, orderId, order.status, schedule);
    if (released !== null) {
      throw conflict(
        'delivery_already_released',
        released.kind === 'advance_paid'
          ? 'The advance is paid, so this delivery is already released'
          : released.kind === 'no_advance'
            ? 'This order has no advance, so its delivery is not held'
            : 'This delivery was already released',
      );
    }
    // The threshold is read now, not from the page the caller loaded: a Founder's edit applies at once.
    const thresholdNpr = await deliveryHoldThresholdNpr(tx, scope);
    const refusal = this.releaseRefusal(principal, order, thresholdNpr);
    // The small-team rule (F1-Q11 a): a Founder who created the order may release it alone when nobody else may,
    // read now on this transaction. Anyone else, or a Founder with a second releaser (even one away), keeps the 403.
    const soleEligible =
      refusal === 'requester_cannot_release' &&
      (await this.soleEligibleToRelease(tx, scope, principal, order, thresholdNpr, true));
    if (refusal !== null && !soleEligible) {
      const allowedRoles = deliveryHoldReleaser(new Dec(order.amountNpr), thresholdNpr);
      throw new ForbiddenException({
        code: 'forbidden',
        message:
          refusal === 'requester_cannot_release'
            ? 'The person who created this order cannot release its delivery'
            : `Only ${allowedRoles.join(' or ')} may release the delivery of an order of this amount`,
        reason: refusal,
      });
    }
    // The body schema already demands a reason; the sole-eligible release checks it again, since the reason is
    // what stands in for the second person.
    const reason = body.reason.trim();
    if (soleEligible && reason.length === 0) {
      throw new BadRequestException({
        code: 'bad_request',
        reason: 'sole_eligible_reason_required',
        message: 'Nobody else may release this delivery; give a reason to release it yourself',
      });
    }

    const now = this.clock();
    await tx.insert(salesOrderDeliveryReleases).values({
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      salesOrderId: orderId,
      releasedByUserId: principal.userId,
      reason,
      orderAmountNpr: order.amountNpr,
      thresholdNpr,
      releasedAt: now,
    });
    await this.audit.record(tx, {
      action: soleEligible
        ? 'sales_order.delivery_released_sole_eligible'
        : 'sales_order.delivery_released',
      entityType: AUDIT_ENTITY,
      entityId: orderId,
      before: { deliveryReleased: false },
      after: {
        deliveryReleased: true,
        reason,
        amountNpr: order.amountNpr,
        thresholdNpr,
        releaserRoles: [...principal.roles],
        allowedRoles: [...deliveryHoldReleaser(new Dec(order.amountNpr), thresholdNpr)],
        ...(soleEligible ? { soleEligible: true } : {}),
      },
    });
    return this.loadDetail(tx, scope, orderId);
  }

  /**
   * The delivery-hold rule for this caller on this order (money-rules `mayReleaseDeliveryHold`), or null when it
   * lets them release. The requester is `sales_orders.created_by`: the person who confirmed the accepted quotation
   * as the order, so the one who asked for it to be delivered. The command and `can.releaseDelivery` both ask this.
   */
  private releaseRefusal(
    principal: Principal,
    order: Pick<OrderRow, 'amountNpr' | 'createdBy'>,
    thresholdNpr: string,
  ): ReleaseRefusal | null {
    const allowed = mayReleaseDeliveryHold({
      amountNpr: new Dec(order.amountNpr),
      thresholdNpr,
      requestedByUserId: order.createdBy,
      releaser: { userId: principal.userId, roles: principal.roles },
    });
    if (allowed) return null;
    return order.createdBy !== null && order.createdBy === principal.userId
      ? 'requester_cannot_release'
      : 'role_cannot_release_amount';
  }

  /**
   * The small-team rule (F1-Q11 a) for a caller `releaseRefusal` refuses as the order's creator: true when they are
   * a Founder and no other active, unlocked member of the entity holds `sales_order.delivery_release` and a role
   * `deliveryHoldReleaser` allows at this amount. The creator counts as nobody else. Run on the caller's
   * transaction, one read after another (it shares the transaction's single connection).
   */
  private async soleEligibleToRelease(
    tx: DbTransaction,
    scope: TxScope,
    principal: Principal,
    order: Pick<OrderRow, 'amountNpr' | 'createdBy'>,
    thresholdNpr: string,
    /** True on the command: read the caller's roles live, not from the token. */
    live = false,
  ): Promise<boolean> {
    if (!principal.roles.includes('founder')) return false;
    if (live) {
      const now = await liveGrantsOf(
        tx,
        { users: new SqlUsersStore(this.db), grants: this.roleCache },
        scope,
        principal.userId,
      );
      if (now.status !== 'active' || !now.roles.includes('founder')) return false;
    }
    const allowed: readonly string[] = deliveryHoldReleaser(new Dec(order.amountNpr), thresholdNpr);
    const others = await otherEligibleUsers(
      tx,
      { grants: this.roleCache },
      scope,
      'sales_order.delivery_release',
      {
        excludeUserIds:
          order.createdBy === null ? [principal.userId] : [principal.userId, order.createdBy],
        entityScoped: true,
        roleOk: (roles) => roles.some((r) => allowed.includes(r)),
      },
    );
    return isSoleEligible(principal.roles, others);
  }

  // ----------------------------------------------------------------------------------------- helpers

  /** Sales orders are a staff surface; a portal caller learns nothing, not even that the route exists. */
  private assertStaff(principal: Principal): void {
    if (principal.orgKind !== 'staff') {
      throw new ForbiddenException({
        code: 'forbidden',
        message: 'Forbidden',
        reason: 'no_permission',
      });
    }
  }

  private kindToFileUnder(
    policy: Parameters<typeof missingEvidence>[0],
    accepted: readonly EvidenceKind[],
  ): EvidenceKindOfOrder {
    const required = policy === 'both' ? (['contract', 'purchase_order'] as const) : [policy];
    return required.find((k) => accepted.includes(k)) ?? accepted[0] ?? 'signed_quote';
  }

  /**
   * The documents filed as the order's evidence: the files the caller names (each must be a live document of
   * this entity, else 422) plus the ones recorded with the acceptance that are still live. Distinct, in order.
   * Round 5 P2: Mark billable takes what the order filed, so a file uploaded as the evidence of another record (an
   * order, a bill, an RFQ) is never filed here: named, it is 422 invalid_evidence_document; recorded with the
   * acceptance, it is left out. `orderId` is the order being confirmed, when it already exists as a draft.
   */
  private async evidenceDocuments(
    tx: DbTransaction,
    scope: TxScope,
    named: readonly string[],
    accepted: readonly string[],
    orderId: string | null,
  ): Promise<string[]> {
    const namedIds = [...new Set(named)];
    await this.assertDocumentsUsable(tx, scope, namedIds);
    await assertNoForeignEvidence(tx, scope, namedIds, orderId);
    const acceptedIds = [...new Set(accepted)].filter((id) => !namedIds.includes(id));
    const live = await this.liveDocuments(tx, scope, acceptedIds, orderId);
    // A file that passed the acceptance while still scanning may have been found infected since (TR-Q12e).
    await assertNotInfected(tx, scope, [...live]);
    return [...namedIds, ...acceptedIds.filter((id) => live.has(id))];
  }

  /** The ids still live in this entity; with `exceptForeignEvidenceOf`, minus evidence of any other record. */
  private async liveDocuments(
    tx: DbTransaction,
    scope: TxScope,
    ids: readonly string[],
    exceptForeignEvidenceOf?: string | null,
  ): Promise<Set<string>> {
    if (ids.length === 0) return new Set();
    const rows = await tx
      .select({ id: documents.id, ownerType: documents.ownerType, ownerId: documents.ownerId })
      .from(documents)
      .where(
        scoped(scope).where(
          documents,
          and(inArray(documents.id, [...ids]), isNull(documents.removedAt)),
        ),
      );
    return new Set(
      rows
        .filter(
          (r) =>
            exceptForeignEvidenceOf === undefined ||
            r.ownerType !== EVIDENCE_OWNER_TYPE ||
            r.ownerId === exceptForeignEvidenceOf,
        )
        .map((r) => r.id),
    );
  }

  /**
   * A foreign or removed document id would otherwise surface as a composite-FK 500. An infected file is refused
   * (409 document_infected, TR-Q12e).
   */
  private async assertDocumentsUsable(
    tx: DbTransaction,
    scope: TxScope,
    ids: readonly string[],
  ): Promise<void> {
    const live = await this.liveDocuments(tx, scope, ids);
    const bad = ids.filter((id) => !live.has(id));
    if (bad.length > 0) {
      throw unprocessable(
        'invalid_evidence_document',
        'An evidence document does not exist in this entity or was removed',
        { documentIds: bad },
      );
    }
    await assertNotInfected(tx, scope, ids);
  }

  /** The order, its lines, schedule and evidence, as the workspace parses them. 404 outside the entity. */
  private async loadDetail(
    tx: DbTransaction,
    scope: TxScope,
    id: string,
    readWhere?: SQL,
  ): Promise<SalesOrderDetail> {
    const [order] = await tx
      .select()
      .from(salesOrders)
      .where(scoped(scope).where(salesOrders, and(eq(salesOrders.id, id), readWhere)));
    if (order === undefined) throw notFound();
    const [lines, schedule, evidence] = await Promise.all([
      tx
        .select()
        .from(salesOrderLines)
        .where(scoped(scope).where(salesOrderLines, eq(salesOrderLines.salesOrderId, id)))
        .orderBy(asc(salesOrderLines.lineNo)),
      tx
        .select()
        .from(billingScheduleLines)
        .where(scoped(scope).where(billingScheduleLines, eq(billingScheduleLines.salesOrderId, id)))
        .orderBy(asc(billingScheduleLines.seq)),
      tx
        .select()
        .from(salesOrderEvidence)
        .where(scoped(scope).where(salesOrderEvidence, eq(salesOrderEvidence.salesOrderId, id)))
        .orderBy(asc(salesOrderEvidence.createdAt), asc(salesOrderEvidence.id)),
    ]);
    const { principal } = this.caller.current();
    const held = await this.heldInvoices(tx, scope, principal, schedule);
    const staff = principal.orgKind === 'staff';
    const draft =
      order.status === 'draft'
        ? await this.draftReadiness(tx, scope, order.quotationVersionId)
        : null;
    const owners = {
      ...order,
      quotationOwnerUserId: await this.quotationOwnerOf(tx, scope, order.quotationId),
    };
    const deliveryRelease = await this.deliveryState(tx, scope, order.id, order.status, schedule);
    // The same checks, in the same order, as `recordRelease`: the permission, then the money rule. The threshold
    // is read only for a caller with the permission on a held order, so most detail reads skip it.
    let releaseDeliveryBlockedBy: ReleaseBlocker | null = null;
    let releaseDeliveryAllowedRoles: DeliveryHoldReleaserRole[] = [];
    let releaseSoleEligible = false;
    if (staff && order.status === 'confirmed' && deliveryRelease === null) {
      if (!canOnOrder(principal, 'sales_order.delivery_release', owners).allowed) {
        releaseDeliveryBlockedBy = 'permission';
      } else {
        const thresholdNpr = await deliveryHoldThresholdNpr(tx, scope);
        releaseDeliveryAllowedRoles = [
          ...deliveryHoldReleaser(new Dec(order.amountNpr), thresholdNpr),
        ];
        const refusal = this.releaseRefusal(principal, order, thresholdNpr);
        // The same small-team rule the command applies: a sole-eligible Founder creator is not blocked.
        releaseSoleEligible =
          refusal === 'requester_cannot_release' &&
          (await this.soleEligibleToRelease(tx, scope, principal, order, thresholdNpr));
        releaseDeliveryBlockedBy =
          refusal === null || releaseSoleEligible
            ? null
            : refusal === 'requester_cannot_release'
              ? 'requester'
              : 'amount';
      }
    }
    const releaseDelivery =
      staff &&
      order.status === 'confirmed' &&
      deliveryRelease === null &&
      releaseDeliveryBlockedBy === null;
    return {
      order: {
        id: order.id,
        number: order.number,
        fiscalYear: order.fiscalYear,
        customerId: order.customerPartyId ?? '',
        quotationId: order.quotationId,
        quotationVersionId: order.quotationVersionId,
        status: order.status,
        currency: order.currency,
        totals: {
          subtotal: order.subtotal,
          discountAmount: order.discountAmount,
          taxableAmount: order.taxableAmount,
          taxAmount: order.taxAmount,
          total: order.total,
        },
        npr: {
          amountNpr: order.amountNpr,
          // numeric(18,6) comes back as '1.600000'; drop the trailing zeros like MoneyService does.
          rate: new Dec(order.fxRate).toFixed(),
          rateSource: order.fxSource ?? 'NPR',
          rateDate: order.fxDate ?? iso(order.createdAt).slice(0, 10),
        },
        creditDays: order.creditDays,
        confirmedAt: order.confirmedAt === null ? null : iso(order.confirmedAt),
        version: order.version,
        createdAt: iso(order.createdAt),
        updatedAt: iso(order.updatedAt),
      },
      lines: lines.map((l) => ({
        lineNo: l.lineNo,
        // sales_order_lines keeps no catalogue reference (0020), so the DTO's nullable field is always null.
        catalogItemId: null,
        description: l.description,
        uom: l.uom,
        quantity: l.quantity,
        unitPrice: l.unitPrice,
        taxCodeId: l.taxCodeId,
        gross: l.gross,
        discountAlloc: l.discountAlloc,
        taxable: l.taxable,
      })),
      schedule: schedule.map((l) => ({
        id: l.id,
        salesOrderId: l.salesOrderId,
        seq: l.seq,
        label: l.label,
        trigger: l.trigger,
        percent: l.percent === null ? null : trimPercent(l.percent),
        amount: l.amount,
        status: l.status,
        billableEvidenceDocumentId: l.billableEvidenceDocumentId,
        billableMarkedAt: l.billableMarkedAt === null ? null : iso(l.billableMarkedAt),
        invoiceId: l.invoiceId,
        invoice: l.invoiceId === null ? null : (held.labels.get(l.invoiceId) ?? null),
        can: { openInvoice: l.invoiceId !== null && held.readable.has(l.invoiceId) },
      })),
      evidence: evidence.map((e) => ({ documentId: e.documentId, kind: e.evidenceKind })),
      deliveryReleased: deliveryRelease !== null,
      deliveryRelease,
      draft,
      can: {
        confirm:
          staff &&
          draft !== null &&
          draft.blocker === null &&
          can(principal, 'sales_order.confirm', { ...scope, ownerUserId: principal.userId })
            .allowed,
        // The same record checks the commands make: mark billable on this order, and a draft invoice that the
        // caller would own as its drafter.
        markBillable: staff && canOnOrder(principal, 'sales_order.mark_billable', owners).allowed,
        draftInvoice:
          staff &&
          can(principal, 'invoice.draft', { ...scope, ownerUserId: principal.userId }).allowed,
        releaseDelivery,
        releaseDeliveryBlockedBy,
        releaseDeliveryAllowedRoles,
        releaseSoleEligible,
      },
    };
  }

  /**
   * Audit #7: the invoices the schedule holds, named under the order's own read (number and status only), and
   * which of them the caller may open: the same `invoice.read` scope filter GET /v1/invoices/:id applies.
   */
  private async heldInvoices(
    tx: DbTransaction,
    scope: TxScope,
    principal: Principal,
    schedule: readonly { invoiceId: string | null }[],
  ): Promise<{ labels: Map<string, ScheduleLineInvoice>; readable: Set<string> }> {
    const ids = [...new Set(schedule.flatMap((l) => (l.invoiceId === null ? [] : [l.invoiceId])))];
    if (ids.length === 0) return { labels: new Map(), readable: new Set() };
    const [labels, readable] = await Promise.all([
      tx
        .select({ id: invoices.id, number: invoices.number, status: invoices.status })
        .from(invoices)
        .where(scoped(scope).where(invoices, inArray(invoices.id, ids))),
      principal.orgKind !== 'staff'
        ? Promise.resolve([])
        : tx
            .select({ id: invoices.id })
            .from(invoices)
            .where(
              and(inArray(invoices.id, ids), scopeWhereFor(principal, invoices, 'invoice.read')),
            ),
    ]);
    return {
      labels: new Map(labels.map((r) => [r.id, { number: r.number, status: r.status }])),
      readable: new Set(readable.map((r) => r.id)),
    };
  }

  /**
   * How the order's delivery is released, or null while it is held: a release row (F1-Q32) first, since it is
   * the record of who let it go before the advance was paid, else a confirmed order with no advance to wait for, else a paid
   * advance (plan A14). An order with no advance line is never held: there is nothing for the hold to wait on.
   */
  private async deliveryState(
    tx: DbTransaction,
    scope: TxScope,
    orderId: string,
    status: SalesOrderStatus,
    schedule: readonly LineRow[],
  ): Promise<SalesOrderDeliveryRelease | null> {
    const [release] = await tx
      .select({
        releasedAt: salesOrderDeliveryReleases.releasedAt,
        reason: salesOrderDeliveryReleases.reason,
        releasedByName: users.displayName,
      })
      .from(salesOrderDeliveryReleases)
      .leftJoin(
        users,
        and(
          eq(users.tenantId, salesOrderDeliveryReleases.tenantId),
          eq(users.id, salesOrderDeliveryReleases.releasedByUserId),
        ),
      )
      .where(
        scoped(scope).where(
          salesOrderDeliveryReleases,
          eq(salesOrderDeliveryReleases.salesOrderId, orderId),
        ),
      )
      .limit(1);
    if (release !== undefined) {
      return {
        kind: 'override',
        releasedAt: iso(release.releasedAt),
        releasedByName: release.releasedByName,
        reason: release.reason,
      };
    }
    // A draft or cancelled order has no delivery to release, so it is not "released" either.
    const open = status === 'confirmed' || status === 'completed';
    if (open && !schedule.some((l) => l.trigger === 'advance' && l.status !== 'cancelled')) {
      return { kind: 'no_advance', releasedAt: null, releasedByName: null, reason: null };
    }
    return (await this.advancePaid(tx, scope, schedule))
      ? { kind: 'advance_paid', releasedAt: null, releasedByName: null, reason: null }
      : null;
  }

  /**
   * Plan A14: the order's advance invoice has an open amount of 0. False while there is no advance line, a
   * line without an issued invoice, or an invoice with no open item yet. The open amount comes from the ledger
   * (never stored: A8).
   */
  private async advancePaid(
    tx: DbTransaction,
    scope: TxScope,
    schedule: readonly LineRow[],
  ): Promise<boolean> {
    const advance = schedule.filter((l) => l.trigger === 'advance' && l.status !== 'cancelled');
    if (advance.length === 0) return false;
    const invoiceIds: string[] = [];
    for (const line of advance) {
      if (line.status !== 'invoiced' || line.invoiceId === null) return false;
      invoiceIds.push(line.invoiceId);
    }
    const items = await tx
      .select({ id: openItems.id })
      .from(openItems)
      .where(
        scoped(scope).where(
          openItems,
          and(eq(openItems.sourceType, 'tax_invoice'), inArray(openItems.sourceId, invoiceIds)),
        ),
      );
    if (items.length !== invoiceIds.length) return false;
    const open = await this.ledger.openAmounts(
      tx,
      scope,
      items.map((i) => i.id),
    );
    return items.every((i) => {
      const amount = open.get(i.id);
      return amount !== undefined && new Dec(amount).isZero();
    });
  }
}
