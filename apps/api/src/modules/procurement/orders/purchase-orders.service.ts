// PurchaseOrdersService: list, detail and versions of purchase orders, and issue, amend, short-close and cancel
// (P4 unit P3; AD4, AD7, done checks 2 and 15). Serves the NFRs:
// - "only vetted vendors": issuing needs an `approved` vendor with an active account in the acting entity (409);
// - "money moves only after the right people agree": an amendment whose grand total incl. VAT in NPR falls in a
//   higher band than approved_band goes to the `po_amendment` route and is written only on approval (AD7);
// - "history is never rewritten": every issued state is an immutable version row (trigger + revoked privileges);
// - "no double effects" and "no lost updates": every write runs in withIdempotency and locks PO → lines FOR UPDATE,
//   then a conditional UPDATE on the status it read;
// - "one legal entity at a time": every read and write is scoped(); another entity's PO is a 404.
// A change of vendor is not an amendment (the body has no vendor field): cancel and raise a new PO.
import { WorkflowSpecSchema, canTransitionPo, type PoStatus } from '@bos/contracts';
import {
  purchaseOrderLines,
  purchaseOrderVersions,
  purchaseOrders,
  purchaseRequestLines,
  purchaseRequests,
  scoped,
  taxCodes,
  vendorAccounts,
  vendorQuotationLines,
  vendors,
} from '@bos/db';
import { Inject, Injectable, Optional, UnprocessableEntityException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';

import { AuditService } from '../../../platform/audit/audit.service';
import { DB, type Db, type DbTransaction } from '../../../platform/db/db.module';
import { withIdempotency } from '../../../platform/db/idempotency';
import { withTx, type TxScope } from '../../../platform/db/tx';
import { searchPage } from '../../../platform/list';
import { ApprovalsService } from '../../approvals/requests.service';
import { PurchaseOrdersCaller } from './purchase-orders.caller';
import {
  PO_AMENDMENT_DOCUMENT_TYPE,
  PO_AUDIT_ENTITY,
  amendLines,
  bandRises,
  shortCloseCancelled,
  versionTotals,
  type AmendPurchaseOrderBody,
  type AmendmentFacts,
  type CancelPurchaseOrderBody,
  type ListPurchaseOrdersQuery,
  type ShortClosePurchaseOrderBody,
} from './purchase-order.rules';
import {
  applyAmendment,
  conflict,
  insertVersion,
  linesOf,
  lockPo,
  notFound,
  receivedOf,
  type AmendmentProposal,
  type PoLineRow,
  type PoRow,
} from './purchase-order.writes';

/** Injection token for a test clock; production falls back to the system time. */
export const PURCHASE_ORDERS_CLOCK = Symbol('PURCHASE_ORDERS_CLOCK');

/** Thrown inside the amendment transaction so it rolls back (idempotency claim included). */
class NoEligibleApprover extends Error {
  constructor(readonly reason: string) {
    super('no eligible approver');
  }
}

export interface PurchaseOrderLineDto {
  id: string;
  lineNo: number;
  prLineId: string | null;
  kind: string;
  description: string;
  uom: string;
  orderedQuantity: string;
  cancelledQuantity: string;
  unitPrice: string;
  taxCodeId: string;
  gross: string;
  taxAmount: string;
  lineTotal: string;
  requiresSerials: boolean;
}

export interface PurchaseOrderDto {
  id: string;
  number: string;
  status: PoStatus;
  purchaseRequestId: string;
  rfqId: string | null;
  vendorQuotationId: string | null;
  vendorId: string;
  /** `vendors.legalName`. Set by the list and get routes; the write routes leave it out. */
  vendorName?: string;
  currency: string;
  paymentTermsDays: number;
  advancePercent: string;
  approvedTotal: string;
  fxRate: string;
  approvedTotalNpr: string;
  approvedBand: string;
  currentVersion: number;
  issuedAt: string | null;
  closedReason: string | null;
  version: number;
  lines: PurchaseOrderLineDto[];
  /**
   * Detail of a draft with no lines yet: the lines issue will copy from the approved quotation (ids are the
   * quotation's line ids). Read-only; absent otherwise.
   */
  proposedLines?: PurchaseOrderLineDto[];
}

/** A row of the list: the detail without its lines, and always with the vendor's name. */
export type PurchaseOrderListItemDto = Omit<PurchaseOrderDto, 'lines' | 'vendorName'> & {
  vendorName: string;
};

export interface PurchaseOrderVersionDto {
  id: string;
  version: number;
  reason: string | null;
  total: string;
  totalNpr: string;
  band: string;
  approvalRequestId: string | null;
  createdBy: string;
  createdAt: string;
  snapshot: unknown;
}

export interface AmendResultDto {
  /** `applied`: version N+1 is written. `pending_approval`: the PO waits in amendment_pending. */
  outcome: 'applied' | 'pending_approval';
  approvalRequestId: string | null;
  purchaseOrder: PurchaseOrderDto;
}

const toLineDto = (l: PoLineRow): PurchaseOrderLineDto => ({
  id: l.id,
  lineNo: l.lineNo,
  prLineId: l.prLineId,
  kind: l.kind,
  description: l.description,
  uom: l.uom,
  orderedQuantity: l.orderedQuantity,
  cancelledQuantity: l.cancelledQuantity,
  unitPrice: l.unitPrice,
  taxCodeId: l.taxCodeId,
  gross: l.gross,
  taxAmount: l.taxAmount,
  lineTotal: l.lineTotal,
  requiresSerials: l.requiresSerials,
});

const toDto = (po: PoRow, lines: readonly PoLineRow[]): PurchaseOrderDto => ({
  id: po.id,
  number: po.number,
  status: po.status,
  purchaseRequestId: po.purchaseRequestId,
  rfqId: po.rfqId,
  vendorQuotationId: po.vendorQuotationId,
  vendorId: po.vendorId,
  currency: po.currency,
  paymentTermsDays: po.paymentTermsDays,
  advancePercent: po.advancePercent,
  approvedTotal: po.approvedTotal,
  fxRate: po.fxRate,
  approvedTotalNpr: po.approvedTotalNpr,
  approvedBand: po.approvedBand,
  currentVersion: po.currentVersion,
  issuedAt: po.issuedAt?.toISOString() ?? null,
  closedReason: po.closedReason,
  version: po.version,
  lines: lines.map(toLineDto),
});

/** Joins a PO to its vendor; vendors are tenant level, so the join is on (tenantId, id) only. */
const vendorOf = (po: typeof purchaseOrders) =>
  and(eq(vendors.tenantId, po.tenantId), eq(vendors.id, po.vendorId));

/**
 * The lines a draft PO from the commitment route gets at issue: one per line of its recommended quotation, with the
 * request line's description, unit and serial rule. Read-only; issue() writes them, and the detail of a draft that
 * has none yet shows them as the lines it will be issued with.
 */
async function quotationLinesOf(q: Db | DbTransaction, scope: TxScope, po: PoRow) {
  if (po.vendorQuotationId === null) return [];
  const [pr] = await q
    .select({ requestType: purchaseRequests.requestType })
    .from(purchaseRequests)
    .where(scoped(scope).where(purchaseRequests, eq(purchaseRequests.id, po.purchaseRequestId)));
  const rows = await q
    .select({ q: vendorQuotationLines, pr: purchaseRequestLines })
    .from(vendorQuotationLines)
    .innerJoin(
      purchaseRequestLines,
      and(
        eq(purchaseRequestLines.tenantId, vendorQuotationLines.tenantId),
        eq(purchaseRequestLines.organizationId, vendorQuotationLines.organizationId),
        eq(purchaseRequestLines.id, vendorQuotationLines.prLineId),
      ),
    )
    .where(
      scoped(scope).where(
        vendorQuotationLines,
        eq(vendorQuotationLines.vendorQuotationId, po.vendorQuotationId),
      ),
    )
    .orderBy(asc(purchaseRequestLines.lineNo));
  // A request line has no kind of its own: a service request gives service lines, any other gives goods.
  const kind: 'goods' | 'service' = pr?.requestType === 'service' ? 'service' : 'goods';
  return rows.map((r, i) => ({
    quotationLineId: r.q.id,
    lineNo: i + 1,
    prLineId: r.pr.id,
    kind,
    requiresSerials: kind === 'goods' && r.pr.requiresSerials,
    description: r.pr.description,
    uom: r.pr.uom,
    orderedQuantity: r.q.quantity,
    unitPrice: r.q.unitPrice,
    taxCodeId: r.q.taxCodeId,
    gross: r.q.gross,
    taxAmount: r.q.taxAmount,
    lineTotal: r.q.lineTotal,
  }));
}

@Injectable()
export class PurchaseOrdersService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly approvals: ApprovalsService,
    private readonly audit: AuditService,
    private readonly caller: PurchaseOrdersCaller,
    @Optional()
    @Inject(PURCHASE_ORDERS_CLOCK)
    private readonly clock: () => Date = () => new Date(),
  ) {}

  // ------------------------------------------------------------------------------------------------- reads

  /**
   * One page of the entity's purchase orders, newest first, optionally of some statuses and a search over the number
   * and the vendor name, with the total of all matches. Lines are left to the detail. The id closes the order so
   * two orders created in the same instant never swap between pages.
   */
  async list(
    query: ListPurchaseOrdersQuery,
  ): Promise<{ rows: PurchaseOrderListItemDto[]; total: number }> {
    const { scope, actor } = this.caller.current();
    return withTx(this.db, scope, actor, async (tx) => {
      const page = await searchPage(tx, {
        q: query.q,
        columns: [purchaseOrders.number, vendors.legalName],
        where: scoped(scope).where(
          purchaseOrders,
          query.status === undefined || query.status.length === 0
            ? undefined
            : inArray(purchaseOrders.status, query.status),
        ),
        orderBy: [
          desc(purchaseOrders.createdAt),
          desc(purchaseOrders.number),
          desc(purchaseOrders.id),
        ],
        limit: query.limit,
        offset: query.offset,
        rows: (reader, p) =>
          reader
            .select({ po: purchaseOrders, vendorName: vendors.legalName })
            .from(purchaseOrders)
            .innerJoin(vendors, vendorOf(purchaseOrders))
            .where(p.where)
            .orderBy(...p.orderBy)
            .limit(p.limit)
            .offset(p.offset),
        count: async (reader, where) => {
          const [row] = await reader
            .select({ n: sql<number>`count(*)::int` })
            .from(purchaseOrders)
            .innerJoin(vendors, vendorOf(purchaseOrders))
            .where(where);
          return row?.n ?? 0;
        },
      });
      return {
        rows: page.rows.map((r) => {
          const { lines: _lines, ...dto } = toDto(r.po, []);
          return { ...dto, vendorName: r.vendorName };
        }),
        total: page.total,
      };
    });
  }

  /** 404 outside the acting entity. */
  async get(id: string): Promise<PurchaseOrderDto> {
    const { scope, actor } = this.caller.current();
    return withTx(this.db, scope, actor, async (tx) => {
      const [row] = await tx
        .select({ po: purchaseOrders, vendorName: vendors.legalName })
        .from(purchaseOrders)
        .innerJoin(vendors, vendorOf(purchaseOrders))
        .where(scoped(scope).where(purchaseOrders, eq(purchaseOrders.id, id)));
      if (row === undefined) throw notFound();
      const lines = await linesOf(tx, scope, id, false);
      // A draft from the commitment route has no lines until issue copies them from the approved quotation:
      // show those as the lines it will be issued with, from the same source issue() reads.
      const proposed =
        row.po.status === 'draft' && lines.length === 0
          ? (await quotationLinesOf(tx, scope, row.po)).map(
              ({ quotationLineId, ...l }): PurchaseOrderLineDto => ({
                ...l,
                id: quotationLineId,
                cancelledQuantity: '0.0000',
              }),
            )
          : undefined;
      return {
        ...toDto(row.po, lines),
        vendorName: row.vendorName,
        ...(proposed !== undefined ? { proposedLines: proposed } : {}),
      };
    });
  }

  /** Every issued version, oldest first. 404 outside the acting entity. */
  async versions(id: string): Promise<PurchaseOrderVersionDto[]> {
    const { scope, actor } = this.caller.current();
    return withTx(this.db, scope, actor, async (tx) => {
      const [po] = await tx
        .select({ id: purchaseOrders.id })
        .from(purchaseOrders)
        .where(scoped(scope).where(purchaseOrders, eq(purchaseOrders.id, id)));
      if (po === undefined) throw notFound();
      const rows = await tx
        .select()
        .from(purchaseOrderVersions)
        .where(
          scoped(scope).where(purchaseOrderVersions, eq(purchaseOrderVersions.purchaseOrderId, id)),
        )
        .orderBy(asc(purchaseOrderVersions.version));
      return rows.map((v) => ({
        id: v.id,
        version: v.version,
        reason: v.reason,
        total: v.total,
        totalNpr: v.totalNpr,
        band: v.band,
        approvalRequestId: v.approvalRequestId,
        createdBy: v.createdBy,
        createdAt: v.createdAt.toISOString(),
        snapshot: v.snapshot,
      }));
    });
  }

  // ------------------------------------------------------------------------------------------------- issue

  /**
   * Issues a draft PO: 409 VENDOR_NOT_APPROVED unless the vendor is `approved`, 409 VENDOR_NOT_IN_ENTITY unless
   * its account in the entity is active, 409 unless a draft. The draft keeps the number P2 gave it (number is NOT
   * NULL, so a draft always has one). A draft from the commitment route has no lines yet: they are copied from the
   * recommended quotation. Writes version 1, moves the request approved → po_issued.
   */
  async issue(id: string, idempotencyKey: string): Promise<PurchaseOrderDto> {
    const { scope, actor, principal } = this.caller.current();
    const now = this.clock();
    return withTx(this.db, scope, actor, async (tx) => {
      const done = await withIdempotency(
        tx,
        { command: 'procurement.po.issue', key: idempotencyKey, body: { id } },
        async () => {
          const po = await lockPo(tx, scope, id);
          if (po.status !== 'draft')
            throw conflict(`A ${po.status} purchase order cannot be issued`);
          await this.assertVendorIssuable(tx, scope, po.vendorId);
          let lines = await linesOf(tx, scope, id, true);
          if (lines.length === 0) lines = await this.copyQuotationLines(tx, scope, po, now);
          if (lines.length === 0)
            throw conflict('The purchase order has no lines', 'PO_HAS_NO_LINES');
          const totals = versionTotals(
            lines.map((l) => l.lineTotal),
            po.fxRate,
          );
          const [row] = await tx
            .update(purchaseOrders)
            .set({
              status: 'issued',
              issuedAt: now,
              issuedBy: principal.userId,
              currentVersion: 1,
              version: sql`${purchaseOrders.version} + 1`,
              updatedAt: now,
            })
            .where(and(eq(purchaseOrders.id, id), eq(purchaseOrders.status, 'draft')))
            .returning();
          if (row === undefined) throw conflict('The purchase order changed while it was issued');
          await insertVersion(tx, scope, {
            po: row,
            lines,
            version: 1,
            reason: null,
            ...totals,
            approvalRequestId: null,
            createdBy: principal.userId,
          });
          await tx
            .update(purchaseRequests)
            .set({
              status: 'po_issued',
              version: sql`${purchaseRequests.version} + 1`,
              updatedAt: now,
            })
            .where(
              scoped(scope).where(
                purchaseRequests,
                and(
                  eq(purchaseRequests.id, po.purchaseRequestId),
                  eq(purchaseRequests.status, 'approved'),
                ),
              ),
            );
          await this.audit.record(tx, {
            action: 'procurement.po.issued',
            entityType: PO_AUDIT_ENTITY,
            entityId: id,
            before: { status: 'draft' },
            after: { status: 'issued', version: 1, ...totals },
          });
          return { status: 200, response: toDto(row, lines) };
        },
      );
      return done.response;
    });
  }

  // ------------------------------------------------------------------------------------------------- amend

  /**
   * Amends an issued or partially received PO (AD7). The amended grand total incl. VAT in NPR gives a band: not
   * higher than approved_band → version N+1 now, with an audit row; higher → the `po_amendment` route (facts
   * amountNpr, approvedBand, requesterIsFounder; the amender is excluded by SoD) and the PO waits in
   * amendment_pending until the decision. 422 PO_AMENDMENT_INVALID for a line of another PO, a no-op or a quantity
   * below received plus cancelled; 422 NO_ELIGIBLE_APPROVER (nothing written) when the route cannot be staffed.
   */
  async amend(
    id: string,
    body: AmendPurchaseOrderBody,
    idempotencyKey: string,
  ): Promise<AmendResultDto> {
    const { scope, actor, principal } = this.caller.current();
    const now = this.clock();
    try {
      return await withTx(this.db, scope, actor, async (tx) => {
        const done = await withIdempotency<AmendResultDto>(
          tx,
          { command: 'procurement.po.amend', key: idempotencyKey, body: { id, ...body } },
          async () => {
            const po = await lockPo(tx, scope, id);
            if (!canTransitionPo(po.status, 'amendment_pending')) {
              throw conflict(`A ${po.status} purchase order cannot be amended`);
            }
            const lines = await linesOf(tx, scope, id, true);
            const received = await receivedOf(tx, scope, id);
            const rates = await this.ratesOf(
              tx,
              scope,
              lines.map((l) => l.taxCodeId),
            );
            const verdict = amendLines(
              lines.map((l) => ({
                id: l.id,
                orderedQuantity: l.orderedQuantity,
                cancelledQuantity: l.cancelledQuantity,
                unitPrice: l.unitPrice,
                taxCodeId: l.taxCodeId,
                receivedQuantity: received.all.get(l.id) ?? '0',
              })),
              body.lines,
              (taxCodeId) => rates.get(taxCodeId) ?? 0,
            );
            if (!verdict.ok) {
              throw new UnprocessableEntityException({
                code: 'PO_AMENDMENT_INVALID',
                message: verdict.message,
              });
            }
            const totals = versionTotals(
              verdict.lines.map((l) => l.lineTotal),
              po.fxRate,
            );
            const proposal: AmendmentProposal = {
              purchaseOrderId: id,
              purchaseOrderNumber: po.number,
              fromVersion: po.currentVersion,
              reason: body.reason,
              paymentTermsDays: body.paymentTermsDays ?? po.paymentTermsDays,
              currency: po.currency,
              lines: verdict.lines,
              ...totals,
            };

            if (!bandRises(totals.band, po.approvedBand)) {
              const row = await applyAmendment(tx, scope, this.audit, po, proposal, {
                approvalRequestId: null,
                createdBy: principal.userId,
                now,
              });
              return {
                status: 200,
                response: {
                  outcome: 'applied' as const,
                  approvalRequestId: null,
                  purchaseOrder: toDto(row, await linesOf(tx, scope, id, false)),
                },
              };
            }

            const facts: AmendmentFacts = {
              amountNpr: totals.totalNpr,
              approvedBand: po.approvedBand,
              requesterIsFounder: await this.holdsRole(tx, scope, principal.userId, 'founder'),
            };
            const amendmentId = randomUUID();
            const nextVersion = po.currentVersion + 1;
            const request = await this.approvals.submit(tx, {
              documentType: PO_AMENDMENT_DOCUMENT_TYPE,
              documentId: amendmentId,
              documentNumber: `${po.number} v${nextVersion}`,
              title: `Amendment of ${po.number} to version ${nextVersion}`,
              snapshot: {
                amendment: proposal,
                before: {
                  version: po.currentVersion,
                  approvedTotal: po.approvedTotal,
                  approvedTotalNpr: po.approvedTotalNpr,
                  approvedBand: po.approvedBand,
                },
              },
              facts,
              requesterUserId: principal.userId,
              submittedByUserId: principal.userId,
              sodUserIds: [principal.userId],
            });
            if (request.status === 'blocked') throw new NoEligibleApprover('No eligible approver');
            const [row] = await tx
              .update(purchaseOrders)
              .set({
                status: 'amendment_pending',
                version: sql`${purchaseOrders.version} + 1`,
                updatedAt: now,
              })
              .where(and(eq(purchaseOrders.id, id), eq(purchaseOrders.status, po.status)))
              .returning();
            if (row === undefined)
              throw conflict('The purchase order changed while it was amended');
            await this.audit.record(tx, {
              action: 'procurement.po.amendment_submitted',
              entityType: PO_AUDIT_ENTITY,
              entityId: id,
              before: { status: po.status, approvedBand: po.approvedBand },
              after: {
                status: 'amendment_pending',
                approvalRequestId: request.requestId,
                amendmentId,
                totalNpr: totals.totalNpr,
                band: totals.band,
              },
            });
            return {
              status: 200,
              response: {
                outcome: 'pending_approval' as const,
                approvalRequestId: request.requestId,
                purchaseOrder: toDto(row, lines),
              },
            };
          },
        );
        return done.response;
      });
    } catch (error) {
      if (!(error instanceof NoEligibleApprover)) throw error;
      throw new UnprocessableEntityException({
        code: 'NO_ELIGIBLE_APPROVER',
        message: `This amendment cannot be submitted: ${error.reason}`,
      });
    }
  }

  // ------------------------------------------------------------------------------------------------- close

  /**
   * Short-closes a partially received PO: each line's open remainder becomes cancelled_quantity, the PO becomes
   * short_closed with the reason. 409 unless partially received, or while a draft receipt is open on it.
   */
  async shortClose(
    id: string,
    body: ShortClosePurchaseOrderBody,
    idempotencyKey: string,
  ): Promise<PurchaseOrderDto> {
    return this.close(id, body.reason, idempotencyKey, 'short_closed');
  }

  /**
   * Cancels an issued PO on which nothing was received (no non-discarded receipt line): every line is
   * cancelled in full. 409 PO_HAS_RECEIPTS otherwise, 409 unless issued.
   */
  async cancel(
    id: string,
    body: CancelPurchaseOrderBody,
    idempotencyKey: string,
  ): Promise<PurchaseOrderDto> {
    return this.close(id, body.reason, idempotencyKey, 'cancelled');
  }

  private async close(
    id: string,
    reason: string,
    idempotencyKey: string,
    to: 'short_closed' | 'cancelled',
  ): Promise<PurchaseOrderDto> {
    const { scope, actor } = this.caller.current();
    const now = this.clock();
    const command = to === 'cancelled' ? 'procurement.po.cancel' : 'procurement.po.short_close';
    return withTx(this.db, scope, actor, async (tx) => {
      const done = await withIdempotency(
        tx,
        { command, key: idempotencyKey, body: { id, reason } },
        async () => {
          const po = await lockPo(tx, scope, id);
          if (!canTransitionPo(po.status, to)) {
            throw conflict(`A ${po.status} purchase order cannot be ${to.replace('_', '-')}`);
          }
          const lines = await linesOf(tx, scope, id, true);
          const received = await receivedOf(tx, scope, id);
          let cancelled: { id: string; cancelledQuantity: string }[];
          if (to === 'cancelled') {
            if (received.any) {
              throw conflict('Goods or services were received on this order', 'PO_HAS_RECEIPTS');
            }
            cancelled = lines.map((l) => ({ id: l.id, cancelledQuantity: l.orderedQuantity }));
          } else {
            if (received.hasDraft) {
              throw conflict('A draft receipt is open on this order; confirm or discard it first');
            }
            cancelled = shortCloseCancelled(
              lines.map((l) => ({
                id: l.id,
                orderedQuantity: l.orderedQuantity,
                receivedQuantity: received.all.get(l.id) ?? '0',
              })),
            );
          }
          for (const c of cancelled) {
            await tx
              .update(purchaseOrderLines)
              .set({ cancelledQuantity: c.cancelledQuantity, updatedAt: now })
              .where(
                scoped(scope).where(
                  purchaseOrderLines,
                  and(eq(purchaseOrderLines.id, c.id), eq(purchaseOrderLines.purchaseOrderId, id)),
                ),
              );
          }
          const [row] = await tx
            .update(purchaseOrders)
            .set({
              status: to,
              closedReason: reason,
              version: sql`${purchaseOrders.version} + 1`,
              updatedAt: now,
            })
            .where(and(eq(purchaseOrders.id, id), eq(purchaseOrders.status, po.status)))
            .returning();
          if (row === undefined) throw conflict('The purchase order changed while it was closed');
          await this.audit.record(tx, {
            action: to === 'cancelled' ? 'procurement.po.cancelled' : 'procurement.po.short_closed',
            entityType: PO_AUDIT_ENTITY,
            entityId: id,
            before: { status: po.status },
            after: { status: to, reason, cancelled },
          });
          return { status: 200, response: toDto(row, await linesOf(tx, scope, id, false)) };
        },
      );
      return done.response;
    });
  }

  // ------------------------------------------------------------------------------------------------- helpers

  /** 409 unless the vendor is `approved` and has an active account in the acting entity. */
  private async assertVendorIssuable(
    tx: DbTransaction,
    scope: TxScope,
    vendorId: string,
  ): Promise<void> {
    const [vendor] = await tx
      .select({ status: vendors.status })
      .from(vendors)
      .where(and(eq(vendors.tenantId, scope.tenantId), eq(vendors.id, vendorId)));
    if (vendor?.status !== 'approved') {
      throw conflict(
        `The vendor is ${vendor?.status ?? 'missing'}; only an approved vendor takes a purchase order`,
        'VENDOR_NOT_APPROVED',
      );
    }
    const [account] = await tx
      .select({ active: vendorAccounts.active })
      .from(vendorAccounts)
      .where(scoped(scope).where(vendorAccounts, eq(vendorAccounts.vendorId, vendorId)));
    if (account?.active !== true) {
      throw conflict('The vendor has no active account in this entity', 'VENDOR_NOT_IN_ENTITY');
    }
  }

  /** The lines of a commitment draft, from its quotation: price and tax from the quote, text from the request. */
  private async copyQuotationLines(
    tx: DbTransaction,
    scope: TxScope,
    po: PoRow,
    now: Date,
  ): Promise<PoLineRow[]> {
    const lines = await quotationLinesOf(tx, scope, po);
    if (lines.length === 0) return [];
    return tx
      .insert(purchaseOrderLines)
      .values(
        lines.map(({ quotationLineId: _q, ...l }) => ({
          ...scope,
          ...l,
          purchaseOrderId: po.id,
          purchaseRequestId: po.purchaseRequestId,
          createdAt: now,
          updatedAt: now,
        })),
      )
      .returning();
  }

  private async ratesOf(
    tx: DbTransaction,
    scope: TxScope,
    ids: string[],
  ): Promise<Map<string, number>> {
    const rows = await tx
      .select({ id: taxCodes.id, rateBp: taxCodes.rateBp })
      .from(taxCodes)
      .where(and(eq(taxCodes.tenantId, scope.tenantId), inArray(taxCodes.id, [...new Set(ids)])));
    return new Map(rows.map((r) => [r.id, r.rateBp]));
  }

  /** Whether the user holds `role` in the acting entity, read from the engine's own directory. */
  private async holdsRole(
    tx: DbTransaction,
    scope: TxScope,
    userId: string,
    role: 'founder',
  ): Promise<boolean> {
    const probe = WorkflowSpecSchema.parse({
      documentType: PO_AMENDMENT_DOCUMENT_TYPE,
      steps: [{ id: 'probe', kind: 'role', role, reason: 'role lookup' }],
    });
    const data = await this.approvals.loadDirectory(tx, scope, probe);
    return (data.roleMembers.get(role) ?? []).includes(userId);
  }
}
