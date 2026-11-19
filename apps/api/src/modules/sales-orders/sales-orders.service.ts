// SalesOrdersService: the confirmed sale and its billing schedule (P3 unit U9; plan decisions A7, A14, A15).
// Serves the NFRs:
// - "no double effects": confirm runs under the quotation's row lock and inside withIdempotency, so a retry
//   (same key) replays and a second confirm of the same quotation (another key) finds the live order and returns
//   it instead of making a second one; the one-live-order unique index is the backstop, not the check;
// - "amounts are exact": totals, lines and tax are copied from the accepted version, the schedule is cut by
//   money-rules' splitSchedule so it adds up to the total to the paisa (the database re-checks at commit);
// - "no gaps in a numbered series": the SO number is taken last, in the same transaction;
// - "deny-by-default": every read goes through scoped(), so an order of another entity is a 404.
//
// Confirm, in one transaction (plan section 2, money command shape): withTx -> withIdempotency -> lock the
// quotation, then its version (the order QuotationOutcomeService.lockSent uses) -> checks -> insert the order as a
// draft with lines, tax summary, evidence and schedule -> NumberingService.issue (last row lock) -> draft to
// confirmed. Mark billable: withTx -> withIdempotency -> sales order, then schedule line locks
// (LedgerService.lockForMoneyCommand) -> conditional updates.
import {
  trimPercent,
  type ConfirmSalesOrderBody,
  type EvidenceKind,
  type MarkBillableBody,
  type SalesOrderDetail,
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
  paymentTerms,
  quotationAcceptances,
  quotationLines,
  quotations,
  quotationTaxSummary,
  quotationVersions,
  salesOrderEvidence,
  salesOrderLines,
  salesOrders,
  salesOrderTaxSummary,
  scoped,
} from '@bos/db';
import { Dec } from '@bos/money-rules';
import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
  UnprocessableEntityException,
} from '@nestjs/common';
import { and, asc, count, desc, eq, exists, inArray, isNull, ne, type SQL } from 'drizzle-orm';

import { AuditService } from '../../platform/audit/audit.service';
import { scopeWhereFor } from '../../platform/authz/authz.service';
import { can } from '../../platform/authz/can';
import { type Principal } from '../../platform/authz/principal';
import { DB, type Db, type DbTransaction } from '../../platform/db/db.module';
import { updateVersioned, withIdempotency } from '../../platform/db/idempotency';
import { withTx, type Actor, type TxScope } from '../../platform/db/tx';
import { searchPage, type SearchColumn } from '../../platform/list';
import { NumberingService } from '../../platform/settings/numbering.service';
import { SettingsService } from '../../platform/settings/settings.service';
import { LedgerService } from '../ledger/ledger.service';
import { evidenceSatisfies, missingEvidence } from '../quotations/outcome/evidence-policy';
import { planSchedule, ScheduleRuleError, scheduleTemplateOf } from './rules';
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
    return withTx(this.db, scope, actor, async (tx) => {
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
    });
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
    return withTx(this.db, scope, actor, async (tx) => {
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
    });
  }

  /** Scope, then filters. A filter only ever narrows what `readWhere` lets through. */
  private listWhere(
    tx: DbTransaction,
    scope: TxScope,
    principal: Principal,
    filter: SalesOrderListFilter,
  ): SQL {
    const conditions = [this.readWhere(tx, scope, principal)];
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
    return withTx(this.db, scope, actor, (tx) =>
      this.loadDetail(tx, scope, id, this.readWhere(tx, scope, principal)),
    );
  }

  private readWhere(tx: DbTransaction, scope: TxScope, principal: Principal): SQL {
    const decision = can(principal, 'sales_order.read');
    if (!decision.allowed || decision.scope !== 'own') {
      return scopeWhereFor(principal, salesOrders, 'sales_order.read');
    }

    // Orders have no owner. Resolve the current quotation owner inside the same tenant and entity.
    return exists(
      tx
        .select({ id: quotations.id })
        .from(quotations)
        .where(
          scoped(scope).where(
            quotations,
            and(
              eq(quotations.id, salesOrders.quotationId),
              eq(quotations.ownerUserId, principal.userId),
            ),
          ),
        ),
    );
  }

  // ---------------------------------------------------------------------------------------- confirm

  /**
   * `POST /v1/sales-orders`: confirms the accepted quotation version as a sales order. 404 for a version outside
   * the entity; 409 `quotation_not_accepted`; 422 `evidence_policy_unmet` when the accepted evidence does not meet
   * the entity's policy now, `invalid_evidence_document` for a document of another entity or one removed, and
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

    // The quotation lock serialises two confirms: the second one finds the first one's order here.
    const [live] = await tx
      .select({ id: salesOrders.id })
      .from(salesOrders)
      .where(
        scoped(scope).where(
          salesOrders,
          and(eq(salesOrders.quotationId, quotation.id), ne(salesOrders.status, 'cancelled')),
        ),
      );
    if (live !== undefined) return this.loadDetail(tx, scope, live.id);

    if (version.status !== 'accepted') {
      throw conflict(
        'quotation_not_accepted',
        `A ${version.status} quotation cannot be confirmed; only an accepted one can`,
      );
    }
    const customerPartyId = quotation.customerPartyId;
    if (customerPartyId === null) throw new Error(`quotation ${quotation.number} has no customer`);

    const [acceptance] = await tx
      .select()
      .from(quotationAcceptances)
      .where(
        scoped(scope).where(
          quotationAcceptances,
          and(
            eq(quotationAcceptances.versionId, version.id),
            eq(quotationAcceptances.outcome, 'accepted'),
          ),
        ),
      );
    const acceptedKinds: EvidenceKind[] = acceptance?.evidenceKinds ?? [];
    const policy = await this.settings.get(scope, 'sales.evidence_policy');
    if (!evidenceSatisfies(policy, acceptedKinds)) {
      const missing = missingEvidence(policy, acceptedKinds);
      throw unprocessable(
        'evidence_policy_unmet',
        `This entity's evidence policy (${policy}) also needs: ${missing.join(', ')}`,
        { policy, missing },
      );
    }
    const documentIds = await this.evidenceDocuments(
      tx,
      scope,
      body.evidenceDocumentIds,
      acceptance?.evidenceDocumentIds ?? [],
    );

    // Totals, lines and tax are the accepted version's, copied as they are.
    const [lines, taxRows] = await Promise.all([
      tx
        .select()
        .from(quotationLines)
        .where(scoped(scope).where(quotationLines, eq(quotationLines.versionId, version.id)))
        .orderBy(asc(quotationLines.lineNo)),
      tx
        .select()
        .from(quotationTaxSummary)
        .where(
          scoped(scope).where(quotationTaxSummary, eq(quotationTaxSummary.versionId, version.id)),
        ),
    ]);
    const isNpr = version.currency === 'NPR';
    const fxRate = version.fxRate ?? (isNpr ? '1' : null);
    const amountNpr = version.amountNpr ?? (isNpr ? version.total : null);
    if (fxRate === null || amountNpr === null) {
      throw new Error(`accepted quotation version ${version.id} has no NPR snapshot`);
    }
    const defaultSchedule = await this.settings.get(scope, 'sales.default_schedule');
    let schedule;
    try {
      schedule = planSchedule(
        scheduleTemplateOf(version.paymentSchedule, defaultSchedule),
        version.total,
        amountNpr,
      );
    } catch (error) {
      if (error instanceof ScheduleRuleError) {
        throw unprocessable('invalid_payment_schedule', error.message);
      }
      throw error;
    }
    const creditDays = await this.creditDaysOf(tx, version.paymentTermId);

    const now = this.clock();
    const userId = userIdOf(actor);
    const [created] = await tx
      .insert(salesOrders)
      .values({
        tenantId: scope.tenantId,
        organizationId: scope.organizationId,
        customerPartyId,
        quotationId: quotation.id,
        quotationVersionId: version.id,
        status: 'draft',
        currency: version.currency as OrderRow['currency'],
        subtotal: version.subtotal,
        discountAmount: version.discountAmount,
        taxableAmount: version.taxableAmount,
        taxAmount: version.taxAmount,
        total: version.total,
        fxRate,
        fxSource: version.fxSource,
        fxDate: version.fxDate,
        amountNpr,
        calcVersion: version.calcVersion,
        creditDays,
        createdBy: userId,
      })
      .returning({ id: salesOrders.id });
    const orderId = created!.id;

    if (lines.length > 0) {
      await tx.insert(salesOrderLines).values(
        lines.map((l) => ({
          tenantId: scope.tenantId,
          organizationId: scope.organizationId,
          salesOrderId: orderId,
          lineNo: l.lineNo,
          description: l.description,
          uom: l.uom,
          quantity: l.quantity,
          unitPrice: l.unitPrice,
          taxCodeId: l.taxCodeId,
          gross: l.gross,
          discountAlloc: l.discountAlloc,
          taxable: l.taxable,
        })),
      );
    }
    if (taxRows.length > 0) {
      await tx.insert(salesOrderTaxSummary).values(
        taxRows.map((t) => ({
          tenantId: scope.tenantId,
          organizationId: scope.organizationId,
          salesOrderId: orderId,
          taxCodeId: t.taxCodeId,
          label: t.label,
          rate: t.rate,
          base: t.base,
          tax: t.tax,
        })),
      );
    }
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
    await tx.insert(billingScheduleLines).values(
      schedule.map((l) => ({
        tenantId: scope.tenantId,
        organizationId: scope.organizationId,
        salesOrderId: orderId,
        seq: l.seq,
        label: l.label,
        trigger: l.trigger,
        percent: l.percent,
        amount: l.amount,
        amountNpr: l.amountNpr,
        status: l.status,
        // An advance line is billable from the moment the order is confirmed.
        ...(l.status === 'billable' ? { billableMarkedBy: userId, billableMarkedAt: now } : {}),
      })),
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

    await this.audit.record(tx, {
      action: 'sales_order.confirmed',
      entityType: AUDIT_ENTITY,
      entityId: orderId,
      before: null,
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

  // ----------------------------------------------------------------------------------- mark billable

  /**
   * `POST /v1/sales-orders/:id/schedule-lines/:lineId/mark-billable`: a milestone or UAT fired. Only a planned
   * line moves; a line other than an advance needs an evidence document. `expectedVersion` is the order's
   * version (schedule lines have none in the DTO) and the command bumps it. 404 for an order or line outside the
   * entity, 409 for a stale version, a closed order or a line that is not planned, 422 `evidence_required`.
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
          response: await this.markLineBillable(tx, scope, actor, orderId, lineId, body),
        }),
      ),
    );
    return done.response;
  }

  private async markLineBillable(
    tx: DbTransaction,
    scope: TxScope,
    actor: Actor,
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
      await this.assertDocumentsUsable(tx, scope, [body.evidenceDocumentId]);
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
   */
  private async evidenceDocuments(
    tx: DbTransaction,
    scope: TxScope,
    named: readonly string[],
    accepted: readonly string[],
  ): Promise<string[]> {
    const namedIds = [...new Set(named)];
    await this.assertDocumentsUsable(tx, scope, namedIds);
    const acceptedIds = [...new Set(accepted)].filter((id) => !namedIds.includes(id));
    const live = await this.liveDocuments(tx, scope, acceptedIds);
    return [...namedIds, ...acceptedIds.filter((id) => live.has(id))];
  }

  private async liveDocuments(
    tx: DbTransaction,
    scope: TxScope,
    ids: readonly string[],
  ): Promise<Set<string>> {
    if (ids.length === 0) return new Set();
    const rows = await tx
      .select({ id: documents.id })
      .from(documents)
      .where(
        scoped(scope).where(
          documents,
          and(inArray(documents.id, [...ids]), isNull(documents.removedAt)),
        ),
      );
    return new Set(rows.map((r) => r.id));
  }

  /** A foreign or removed document id would otherwise surface as a composite-FK 500. */
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
  }

  private async creditDaysOf(tx: DbTransaction, paymentTermId: string | null): Promise<number> {
    if (paymentTermId === null) return 0;
    const [term] = await tx
      .select({ netDays: paymentTerms.netDays })
      .from(paymentTerms)
      .where(eq(paymentTerms.id, paymentTermId));
    return term?.netDays ?? 0;
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
      deliveryReleased: await this.deliveryReleased(tx, scope, schedule),
      can: {
        markBillable: staff && can(principal, 'sales_order.mark_billable').allowed,
        // The draft route asserts invoice.draft on the acting entity.
        draftInvoice: staff && can(principal, 'invoice.draft', scope).allowed,
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
   * Plan A14: the order's advance invoice has an open amount of 0. False while there is no advance line, a
   * line without an issued invoice, or an invoice with no open item yet. The open amount comes from the ledger
   * (never stored: A8).
   */
  private async deliveryReleased(
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
