// PurchaseOrdersService: list, detail and versions of purchase orders, and issue, amend, short-close and cancel
// (P4 unit P3; AD4, AD7, done checks 2 and 15). Serves the NFRs:
// - "only vetted vendors": issuing needs an `approved` vendor with an active account in the acting entity (409);
// - "money moves only after the right people agree": an amendment that raises the order's total or changes its
//   payment terms goes to the `po_amendment` route and is written only on approval (F1-Q40, replacing AD7's band
//   rule); any other amendment is written at once with an audit row;
// - "history is never rewritten": every issued state is an immutable version row (trigger + revoked privileges);
// - "no double effects" and "no lost updates": every write runs in withIdempotency and locks PO → lines FOR UPDATE,
//   then a conditional UPDATE on the status it read;
// - "one legal entity at a time": every read and write is scoped(); another entity's PO is a 404;
// - "deny by default": the reads are open to issuers and, read-only, to bill and receipt roles on the orders their
//   grant reaches (F1-Q52, po-read-access.ts), and the detail to an approver of an approval about the order
//   (R4f Q1 b); the writes need procurement.po.issue at route level.
// A change of vendor is not an amendment (the body has no vendor field): a draft changes vendor through
// changeVendor() (F1-Q40 a); an issued order is cancelled and raised again (cancelAndRecreate(), one transaction).
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
import { can } from '../../../platform/authz/can';
import type { Principal } from '../../../platform/authz/principal';
import { DB, type Db, type DbTransaction } from '../../../platform/db/db.module';
import { withIdempotency } from '../../../platform/db/idempotency';
import { withTx, type TxScope, READ_ONLY } from '../../../platform/db/tx';
import { searchPage } from '../../../platform/list';
import { NumberingService } from '../../../platform/settings/numbering.service';
import { ApprovalsNotify } from '../../approvals/ports';
import { ApprovalsService } from '../../approvals/requests.service';
import { BILLABLE_PO_STATUSES } from '../../payables/bills/vendor-bill.rules';
import { emergencyReviewDue, requestEmergencyReview } from '../receipts/emergency-review';
import { purchaseRequestRef } from '../requests/purchase-requests.service';
import {
  approvesPo,
  assertHoldsPoRead,
  holdsPoRead,
  mayReadPo,
  mayReceivePo,
  poReadWhere,
  requestFactsColumns,
  requestOf,
  type PoRequestFacts,
} from './po-read-access';
import { PurchaseOrdersCaller } from './purchase-orders.caller';
import { PurchaseOrderRenderNudge } from './render/purchase-order-render.nudge';
import {
  PO_AMENDMENT_DOCUMENT_TYPE,
  PO_AUDIT_ENTITY,
  amendLines,
  amendmentApprovalReasons,
  shortCloseCancelled,
  vendorChangePatch,
  vendorChangeRefusal,
  versionTotals,
  type AmendPurchaseOrderBody,
  type AmendmentFacts,
  type CancelAndRecreatePurchaseOrderBody,
  type CancelPurchaseOrderBody,
  type ChangePurchaseOrderVendorBody,
  type ListPurchaseOrdersQuery,
  type ShortClosePurchaseOrderBody,
} from './purchase-order.rules';
import {
  applyAmendment,
  assertPoNotReferenced,
  assertVerifiedBankAccount,
  conflict,
  insertRecreatedDraft,
  insertVersion,
  linesOf,
  lockPo,
  notFound,
  receivedOf,
  vendorTermsDays,
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
  /**
   * What the caller may do from this order outside the PO routes, from the caller's live grants (detail only):
   * `enterBill` is payables.bill.enter on the order's purchase request (the check the order's progress read makes
   * for the bill form) on an order a bill can be entered against (BILLABLE_PO_STATUSES); `receive` is the receipts
   * unit's rule (mayReceivePo) on an order that still takes receipts. A read-only reader (F1-Q52) gets false for both
   * unless their own grants allow it.
   */
  can?: { enterBill: boolean; receive: boolean };
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

/**
 * May `p` enter a bill against an order in `status` raised from `request`? payables.bill.enter on the purchase
 * request, the record check the order's progress read (the bill form's source) and the bill picker make, so an `own`
 * grant offers Enter bill only on orders from the caller's own requests.
 */
export function mayEnterBill(
  p: Principal,
  status: PoStatus,
  request: Parameters<typeof purchaseRequestRef>[0],
): boolean {
  return (
    p.orgKind === 'staff' &&
    can(p, 'payables.bill.enter', purchaseRequestRef(request)).allowed &&
    (BILLABLE_PO_STATUSES as readonly string[]).includes(status)
  );
}

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
    /** Tells the requester their order was issued (in-app only); absent in tests that do not look. */
    @Optional() private readonly notify?: ApprovalsNotify,
    /** Renders a new version's PDF once its command commits; absent in tests that build the service by hand. */
    @Optional() private readonly renderNudge?: PurchaseOrderRenderNudge,
    // Numbers the draft of cancel-and-recreate. Optional and defaulted so callers that build the service by hand
    // keep working and the module needs no SettingsModule: NumberingService holds no state (as in VendorBillsService).
    @Optional()
    private readonly numbering: NumberingService = new NumberingService(),
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
    const { scope, actor, principal } = this.caller.current();
    assertHoldsPoRead(principal);
    // A read-only reader (F1-Q52) sees the orders their grant reaches through the purchase request.
    const reach = poReadWhere(principal);
    return withTx(
      this.db,
      scope,
      actor,
      async (tx) => {
        const page = await searchPage(tx, {
          q: query.q,
          columns: [purchaseOrders.number, vendors.legalName],
          where: scoped(scope).where(
            purchaseOrders,
            and(
              query.status === undefined || query.status.length === 0
                ? undefined
                : inArray(purchaseOrders.status, query.status),
              reach,
            ),
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
              .innerJoin(purchaseRequests, requestOf(purchaseOrders))
              .where(p.where)
              .orderBy(...p.orderBy)
              .limit(p.limit)
              .offset(p.offset),
          count: async (reader, where) => {
            const [row] = await reader
              .select({ n: sql<number>`count(*)::int` })
              .from(purchaseOrders)
              .innerJoin(vendors, vendorOf(purchaseOrders))
              .innerJoin(purchaseRequests, requestOf(purchaseOrders))
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
      },
      READ_ONLY,
    );
  }

  /**
   * 404 outside the acting entity, and for staff whose grant does not reach the order (F1-Q52) unless they approve
   * an approval about it (approvesPo, R4f Q1 b): that opens this detail only, with the `can` flags of their own
   * grants. Staff with no grant and no such approval get a 404 here too, so the answer never says whether the order
   * exists; a portal or inactive caller is still a 403.
   */
  async get(id: string): Promise<PurchaseOrderDto> {
    const { scope, principal } = this.caller.current();
    if (holdsPoRead(principal)) {
      const dto = await this.detail(id, (request) => mayReadPo(principal, request));
      if (dto !== undefined) return dto;
    } else if (principal.status !== 'active' || principal.orgKind !== 'staff') {
      assertHoldsPoRead(principal);
    }
    if (await approvesPo(this.db, scope, principal, id, () => this.approvals.inbox())) {
      const dto = await this.detail(id, () => true);
      if (dto !== undefined) return dto;
    }
    throw notFound();
  }

  /** The detail of order `id` in the acting entity, or undefined when it is not there or `reads` refuses its request. */
  private async detail(
    id: string,
    reads: (request: PoRequestFacts) => boolean,
  ): Promise<PurchaseOrderDto | undefined> {
    const { scope, actor, principal } = this.caller.current();
    return withTx(
      this.db,
      scope,
      actor,
      async (tx) => {
        // The request's owner and department decide who reads the order and the `can` flags; neither is returned.
        const [row] = await tx
          .select({
            po: purchaseOrders,
            vendorName: vendors.legalName,
            request: requestFactsColumns,
          })
          .from(purchaseOrders)
          .innerJoin(vendors, vendorOf(purchaseOrders))
          .innerJoin(purchaseRequests, requestOf(purchaseOrders))
          .where(scoped(scope).where(purchaseOrders, eq(purchaseOrders.id, id)));
        if (row === undefined || !reads(row.request)) return undefined;
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
          can: {
            enterBill: mayEnterBill(principal, row.po.status, row.request),
            receive: mayReceivePo(
              principal,
              row.po.status,
              row.request,
              lines.some((l) => l.kind === 'service'),
            ),
          },
        };
      },
      READ_ONLY,
    );
  }

  /** Every issued version, oldest first. 404 outside the acting entity, and where get() is a 404. */
  async versions(id: string): Promise<PurchaseOrderVersionDto[]> {
    const { scope, actor, principal } = this.caller.current();
    assertHoldsPoRead(principal);
    return withTx(
      this.db,
      scope,
      actor,
      async (tx) => {
        const [po] = await tx
          .select({ id: purchaseOrders.id, request: requestFactsColumns })
          .from(purchaseOrders)
          .innerJoin(purchaseRequests, requestOf(purchaseOrders))
          .where(scoped(scope).where(purchaseOrders, eq(purchaseOrders.id, id)));
        if (po === undefined || !mayReadPo(principal, po.request)) throw notFound();
        const rows = await tx
          .select()
          .from(purchaseOrderVersions)
          .where(
            scoped(scope).where(
              purchaseOrderVersions,
              eq(purchaseOrderVersions.purchaseOrderId, id),
            ),
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
      },
      READ_ONLY,
    );
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
    const issued = await withTx(this.db, scope, actor, async (tx) => {
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
          await this.notifyRequester(tx, scope, row, principal.userId);
          return { status: 200, response: toDto(row, lines) };
        },
      );
      return done.response;
    });
    // After the commit, so the worker sees version 1: render its PDF now rather than on the next sweep.
    await this.renderNudge?.nudge(scope, issued.id, issued.currentVersion);
    return issued;
  }

  // ------------------------------------------------------------------------------------------- change vendor

  /**
   * Changes the vendor of a draft PO (F1-Q40 a). 409 PO_VENDOR_CHANGE_NOT_DRAFT ("Cancel this order and create a new
   * one") unless a draft, 409 PO_VENDOR_UNCHANGED for the same vendor, 409 PO_REFERENCED when a payment request, bill
   * or portal bill submission names the draft (each holds a foreign key on the PO and its vendor), and for the new
   * vendor the issue checks (VENDOR_NOT_APPROVED, which an unknown vendor or one of another tenant also gets, and
   * VENDOR_NOT_IN_ENTITY) plus 409 VENDOR_NO_VERIFIED_BANK_ACCOUNT. 409 PO_HAS_NO_LINES, writing nothing, when the
   * draft has no lines and no quotation lines to copy. A commitment draft without lines first gets its quotation's
   * lines written, so the lines, prices, total, currency, rate and approved band stay as the commitment approved
   * them; then the vendor, its account's payment terms and a zero advance are set and the RFQ and quotation link is
   * cleared.
   */
  async changeVendor(
    id: string,
    body: ChangePurchaseOrderVendorBody,
    idempotencyKey: string,
  ): Promise<PurchaseOrderDto> {
    const { scope, actor } = this.caller.current();
    const now = this.clock();
    return withTx(this.db, scope, actor, async (tx) => {
      const done = await withIdempotency(
        tx,
        {
          command: 'procurement.po.change_vendor',
          key: idempotencyKey,
          body: { id, vendorId: body.vendorId },
        },
        async () => {
          const po = await lockPo(tx, scope, id);
          const refusal = vendorChangeRefusal({
            status: po.status,
            vendorId: po.vendorId,
            nextVendorId: body.vendorId,
          });
          if (refusal !== null) throw conflict(refusal.message, refusal.code);
          await assertPoNotReferenced(tx, scope, id);
          await this.assertVendorIssuable(tx, scope, body.vendorId);
          await assertVerifiedBankAccount(tx, scope, body.vendorId);
          // Before the link to the old vendor's quotation is cleared: write the lines it approved.
          let lines = await linesOf(tx, scope, id, true);
          const linesCopied = lines.length === 0;
          if (linesCopied) lines = await this.copyQuotationLines(tx, scope, po, now);
          // Nothing was written: the quotation it could copy from would be unlinked, leaving a draft that can never
          // get lines or issue.
          if (lines.length === 0)
            throw conflict('The purchase order has no lines', 'PO_HAS_NO_LINES');
          const patch = vendorChangePatch(po, {
            vendorId: body.vendorId,
            paymentTermsDays: await vendorTermsDays(tx, scope, body.vendorId),
          });
          const [row] = await tx
            .update(purchaseOrders)
            .set({
              ...patch.set,
              version: sql`${purchaseOrders.version} + 1`,
              updatedAt: now,
            })
            .where(
              scoped(scope).where(
                purchaseOrders,
                and(eq(purchaseOrders.id, id), eq(purchaseOrders.status, 'draft')),
              ),
            )
            .returning();
          if (row === undefined)
            throw conflict('The purchase order changed while its vendor was changed');
          await this.audit.record(tx, {
            action: 'procurement.po.vendor_changed',
            entityType: PO_AUDIT_ENTITY,
            entityId: id,
            before: patch.before,
            after: {
              ...patch.set,
              cleared: patch.cleared,
              linesCopied: linesCopied ? lines.length : 0,
            },
          });
          return { status: 200, response: toDto(row, lines) };
        },
      );
      return done.response;
    });
  }

  /**
   * An in-app notice to the purchase request's requester that its order was issued (U18 #4), so they know there is
   * an order to receive a service against. In the issue transaction; one notice per order (dedupeKey). Not sent
   * when the requester issued it themselves.
   */
  private async notifyRequester(
    tx: DbTransaction,
    scope: TxScope,
    po: PoRow,
    issuedBy: string,
  ): Promise<void> {
    if (this.notify === undefined) return;
    const [pr] = await tx
      .select({
        requesterUserId: purchaseRequests.requesterUserId,
        number: purchaseRequests.number,
      })
      .from(purchaseRequests)
      .where(scoped(scope).where(purchaseRequests, eq(purchaseRequests.id, po.purchaseRequestId)))
      .limit(1);
    if (pr === undefined || pr.requesterUserId === issuedBy) return;
    const request = pr.number ?? 'your purchase request';
    await this.notify.notifyUser(tx, {
      userId: pr.requesterUserId,
      title: `Purchase order ${po.number} issued`,
      body: `Purchase order ${po.number} was issued for ${request}.`,
      link: `/procurement/requests/${po.purchaseRequestId}`,
      dedupeKey: `purchase_order:${po.id}:issued`,
    });
  }

  // ------------------------------------------------------------------------------------------------- amend

  /**
   * Amends an issued, partially or fully received PO (F1-Q39, F1-Q40). The amended grand total incl. VAT above the
   * order's current total, or a change of payment terms, sends it to the `po_amendment` route (facts amountNpr,
   * approvedBand, requesterIsFounder; the amender is excluded by SoD) and the PO waits in amendment_pending until
   * the decision; any other change is version N+1 now, with an audit row. 422 PO_AMENDMENT_INVALID for a line of
   * another PO, a change of nothing or a quantity below received plus cancelled; 422 NO_ELIGIBLE_APPROVER (nothing
   * written) when the route cannot be staffed.
   */
  async amend(
    id: string,
    body: AmendPurchaseOrderBody,
    idempotencyKey: string,
  ): Promise<AmendResultDto> {
    const { scope, actor, principal } = this.caller.current();
    const now = this.clock();
    let amended: AmendResultDto;
    try {
      amended = await withTx(this.db, scope, actor, async (tx) => {
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
            const paymentTermsDays = body.paymentTermsDays ?? po.paymentTermsDays;
            if (!verdict.changed && paymentTermsDays === po.paymentTermsDays) {
              throw new UnprocessableEntityException({
                code: 'PO_AMENDMENT_INVALID',
                message: 'The amendment changes no quantity, price or payment terms',
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
              paymentTermsDays,
              currency: po.currency,
              lines: verdict.lines,
              ...totals,
            };
            const approvalReasons = amendmentApprovalReasons({
              currentTotal: versionTotals(
                lines.map((l) => l.lineTotal),
                po.fxRate,
              ).total,
              nextTotal: totals.total,
              currentTermsDays: po.paymentTermsDays,
              nextTermsDays: paymentTermsDays,
            });

            if (approvalReasons.length === 0) {
              const row = await applyAmendment(
                tx,
                scope,
                { audit: this.audit, approvals: this.approvals },
                po,
                proposal,
                {
                  approvalRequestId: null,
                  createdBy: principal.userId,
                  amendedBy: principal.userId,
                  now,
                },
              );
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
            // The vendor is frozen by id and name with the order's number, so the approver reads them as names.
            const [vendor] = await tx
              .select({ legalName: vendors.legalName })
              .from(vendors)
              .where(and(eq(vendors.tenantId, po.tenantId), eq(vendors.id, po.vendorId)));
            const request = await this.approvals.submit(tx, {
              documentType: PO_AMENDMENT_DOCUMENT_TYPE,
              documentId: amendmentId,
              documentNumber: `${po.number} v${nextVersion}`,
              title: `Amendment of ${po.number} to version ${nextVersion}`,
              snapshot: {
                purchaseOrderNumber: po.number,
                vendorPartyId: po.vendorId,
                vendorName: vendor?.legalName ?? null,
                amendment: proposal,
                before: {
                  version: po.currentVersion,
                  approvedTotal: po.approvedTotal,
                  approvedTotalNpr: po.approvedTotalNpr,
                  approvedBand: po.approvedBand,
                  paymentTermsDays: po.paymentTermsDays,
                },
                approvalReasons,
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
                paymentTermsDays,
                approvalReasons,
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
    // An amendment applied at once made a new version: render it now. One that waits for approval renders when the
    // approval commits (PoAmendmentSubject.afterDecided).
    if (amended.outcome === 'applied') {
      await this.renderNudge?.nudge(scope, id, amended.purchaseOrder.currentVersion);
    }
    return amended;
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

  /**
   * Cancels an issued PO (exactly cancel()'s rules and audit row) and raises a new draft from it in the same
   * transaction: same request, RFQ, quotation, vendor, terms, approved total, rate and band, the same lines with their
   * ordered quantities and nothing cancelled, a new number, created by the caller. The cancel runs first, so the
   * one-live-PO-per-quotation index admits the clone; any failure rolls back both. 409 unless issued, 409
   * PO_HAS_RECEIPTS once anything was received. The request stays po_issued (the first issue moved it there and a
   * cancel leaves it), so issuing the clone later writes its version 1 and leaves the request as it is.
   */
  async cancelAndRecreate(
    id: string,
    body: CancelAndRecreatePurchaseOrderBody,
    idempotencyKey: string,
  ): Promise<PurchaseOrderDto> {
    const { scope, actor, principal } = this.caller.current();
    const now = this.clock();
    return withTx(this.db, scope, actor, async (tx) => {
      const done = await withIdempotency(
        tx,
        {
          command: 'procurement.po.cancel_and_recreate',
          key: idempotencyKey,
          body: { id, reason: body.reason },
        },
        async () => {
          const closed = await this.closeInTx(
            tx,
            scope,
            principal,
            id,
            body.reason,
            'cancelled',
            now,
          );
          const recreated = await insertRecreatedDraft(
            tx,
            scope,
            this.numbering,
            closed.row,
            closed.lines,
            principal.userId,
            now,
          );
          await this.audit.record(tx, {
            action: 'procurement.po.recreated',
            entityType: PO_AUDIT_ENTITY,
            entityId: recreated.po.id,
            before: { from: id, number: closed.row.number },
            after: {
              status: recreated.po.status,
              number: recreated.po.number,
              lines: recreated.lines.length,
              approvedTotal: recreated.po.approvedTotal,
            },
          });
          return { status: 200, response: toDto(recreated.po, recreated.lines) };
        },
      );
      return done.response;
    });
  }

  private async close(
    id: string,
    reason: string,
    idempotencyKey: string,
    to: 'short_closed' | 'cancelled',
  ): Promise<PurchaseOrderDto> {
    const { scope, actor, principal } = this.caller.current();
    const now = this.clock();
    const command = to === 'cancelled' ? 'procurement.po.cancel' : 'procurement.po.short_close';
    return withTx(this.db, scope, actor, async (tx) => {
      const done = await withIdempotency(
        tx,
        { command, key: idempotencyKey, body: { id, reason } },
        async () => {
          const { row, lines } = await this.closeInTx(tx, scope, principal, id, reason, to, now);
          return { status: 200, response: toDto(row, lines) };
        },
      );
      return done.response;
    });
  }

  /**
   * The close step inside the caller's transaction (shared by short-close, cancel and cancel-and-recreate): locks the
   * PO and its lines, refuses what the status or the receipts forbid, writes the cancelled quantities, the status and
   * the reason, the audit row and (short-close) the emergency review. Returns the closed row and its lines as they
   * now stand, in line order.
   */
  private async closeInTx(
    tx: DbTransaction,
    scope: TxScope,
    principal: Principal,
    id: string,
    reason: string,
    to: 'short_closed' | 'cancelled',
    now: Date,
  ): Promise<{ row: PoRow; lines: PoLineRow[] }> {
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
    // A short-close ends the receiving of the order: an emergency purchase is now reviewed (F1-Q41).
    if (emergencyReviewDue(po.status, to)) {
      await requestEmergencyReview(
        tx,
        scope,
        { approvals: this.approvals, audit: this.audit },
        row,
        principal.userId,
      );
    }
    return { row, lines: await linesOf(tx, scope, id, false) };
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
