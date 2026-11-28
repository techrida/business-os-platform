// PurchaseRequestsService: a need is drafted, edited, submitted to its department head and cancelled (P4 unit P1;
// AD10, AD11, AD12). Serves the NFRs:
// - "money moves only after the right people agree": submit opens an approval request whose route is the department
//   head only (Management too for an emergency), never Accountant or Finance (those run on the recommended quote);
// - "nothing is stuck unseen": submit previews the route first, and a blocked one (no head, no operations_head, or
//   everyone is a separation-of-duties person) writes nothing but the admins' notice and answers 422
//   NO_ELIGIBLE_APPROVER; no request row, no PR number is taken;
// - "no gaps in a numbered series": the PR number comes from the PR series inside the submit transaction, after
//   every other lock and only when the request has none yet (a resubmit after a return keeps its number);
// - "no double effects" and "no lost updates": every write runs in withIdempotency, the row is locked FOR UPDATE,
//   and an optional expectedVersion is compared to the row's version;
// - "amounts are exact": line amounts and the total are computed here with decimal.js; the NPR estimate and its
//   FX snapshot are written by the same UPDATE that moves the status to submitted (purchase_requests_snapshot_check);
// - "authorization is deny-by-default" and "one legal entity at a time": a request of another entity, or of
//   another requester under `own` scope, is a 404 on every route (never a 403 that would confirm the id).
import { type CreatePurchaseRequestBody, type Permission } from '@bos/contracts';
import {
  costCenters,
  departments,
  purchaseOrderLines,
  purchaseOrders,
  purchaseRequestLines,
  purchaseRequests,
  receiptLines,
  receipts,
  rfqs,
  scoped,
  vendors,
} from '@bos/db';
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
import Decimal from 'decimal.js';
import { and, asc, desc, eq, inArray, ne, sql, type SQL } from 'drizzle-orm';

import { AuditService } from '../../../platform/audit/audit.service';
import { AuthzService, scopeWhereFor } from '../../../platform/authz/authz.service';
import { can } from '../../../platform/authz/can';
import type { Principal, ResourceRef } from '../../../platform/authz/principal';
import { DB, type Db, type DbTransaction } from '../../../platform/db/db.module';
import { updateVersioned, withIdempotency } from '../../../platform/db/idempotency';
import { searchPage } from '../../../platform/list';
import { withTx, type TxScope } from '../../../platform/db/tx';
import { CurrencyEnabledService } from '../../../platform/settings/currency-enabled';
import { MoneyService } from '../../../platform/settings/money.service';
import { NumberingService } from '../../../platform/settings/numbering.service';
import { SettingsService } from '../../../platform/settings/settings.service';
import { ApprovalsNotify } from '../../approvals/ports';
import { ApprovalsService } from '../../approvals/requests.service';
import { RECEIVING_PO_STATUSES } from '../receipts/receipt.rules';
import {
  PURCHASE_REQUEST_AUDIT_ENTITY,
  PURCHASE_REQUEST_DOCUMENT_TYPE,
  PURCHASE_REQUEST_EDIT_ACTIONS,
  PURCHASE_REQUEST_SERIES,
  approvalFactsOf,
  buildApprovalSnapshot,
  headerColumnsOf,
  isPrEditable,
  lineRowsOf,
  sumAmounts,
  toDto,
  toListItem,
  type LinkedPurchaseOrderDto,
  type ListPurchaseRequestsQuery,
  type PurchaseRequestDto,
  type PurchaseRequestLineRow,
  type PurchaseRequestListItem,
  type PurchaseRequestRow,
} from './purchase-request.rules';
import { PurchaseRequestsCaller } from './purchase-requests.caller';

/** Injection token for a test clock; production falls back to the system time. */
export const PURCHASE_REQUESTS_CLOCK = Symbol('PURCHASE_REQUESTS_CLOCK');

const CREATE_ACTION: Permission = 'procurement.pr.create';
const READ_ACTION: Permission = 'procurement.pr.read';
/** approval.blocked links may only open the inbox or memos (notify/templates.ts), so the notice opens the inbox. */
const BLOCKED_NOTICE_LINK = '/inbox/';
const NOTHING: SQL = sql`false`;

const notFound = () =>
  new NotFoundException({ code: 'not_found', message: 'Purchase request not found' });
const conflict = (message: string) => new ConflictException({ code: 'conflict', message });
const badRequest = (message: string) => new BadRequestException({ code: 'bad_request', message });

/** What the admins are told when a step has nobody who may decide it. */
interface BlockedNotice {
  requestId: string;
  reference: string;
  rowVersion: number;
  reason: string;
}

/** Thrown inside the submit transaction so it rolls back (idempotency claim included); never leaves the service. */
class NoEligibleApprover extends Error {
  constructor(readonly notice: BlockedNotice) {
    super('no eligible approver');
  }
}

/** The record the authz check reads: a request is owned by its requester and belongs to its department. */
export function purchaseRequestRef(row: {
  tenantId: string;
  organizationId: string;
  requesterUserId: string;
  departmentId: string;
}): ResourceRef {
  return {
    tenantId: row.tenantId,
    organizationId: row.organizationId,
    ownerUserId: row.requesterUserId,
    departmentId: row.departmentId,
    sodUserIds: [],
  };
}

/**
 * The SQL twin of can(p, action, purchaseRequestRef(row)) for the rows of purchase_requests. record-reach.ts names
 * the requester as the owner and `department_id` as the department, so this is the shared scopeWhereFor and the
 * list and the record check cannot drift: `department` is cumulative (audit #11, D51), a head reaches every request
 * of their department and their own requests filed in any other. Staff only (a portal user raises no request); an
 * inactive user, a missing grant or an unknown scope matches no row (deny by default).
 */
export function purchaseRequestScopeWhere(p: Principal, action: Permission): SQL {
  if (p.orgKind !== 'staff') return NOTHING;
  return scopeWhereFor(p, purchaseRequests, action);
}

@Injectable()
export class PurchaseRequestsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly authz: AuthzService,
    private readonly approvals: ApprovalsService,
    private readonly notify: ApprovalsNotify,
    private readonly audit: AuditService,
    private readonly numbering: NumberingService,
    private readonly money: MoneyService,
    private readonly caller: PurchaseRequestsCaller,
    @Optional()
    @Inject(PURCHASE_REQUESTS_CLOCK)
    private readonly clock: () => Date = () => new Date(),
    // Last and defaulted like the clock, so a hand-built service still checks currencies (D44); Nest injects it.
    private readonly currencies: CurrencyEnabledService = new CurrencyEnabledService(
      new SettingsService(db),
    ),
  ) {}

  // ------------------------------------------------------------------------------------------------- reads

  /**
   * One page of the requests the caller may read in the acting entity, newest first, with the total of all matches.
   * The scope is part of `where`, so neither a filter nor a search can reach a request the caller may not read.
   */
  async list(
    query: ListPurchaseRequestsQuery,
  ): Promise<{ rows: PurchaseRequestListItem[]; total: number }> {
    const { principal, scope } = this.caller.current();
    const filters: SQL[] = [purchaseRequestScopeWhere(principal, READ_ACTION)];
    if (query.status !== undefined && query.status.length > 0) {
      filters.push(inArray(purchaseRequests.status, query.status));
    }
    const page = await searchPage(this.db, {
      q: query.q,
      columns: [purchaseRequests.number, purchaseRequests.justification],
      where: and(...filters),
      orderBy: [desc(purchaseRequests.createdAt), desc(purchaseRequests.id)],
      limit: query.limit,
      offset: query.offset,
      rows: (tx, p) =>
        tx
          .select()
          .from(purchaseRequests)
          .where(p.where)
          .orderBy(...p.orderBy)
          .limit(p.limit)
          .offset(p.offset),
      count: (tx, where) => tx.$count(purchaseRequests, where),
    });
    const rfqIds = await this.liveRfqIds(
      this.db,
      scope,
      page.rows.map((r) => r.id),
    );
    const names = await this.namesOf(scope, page.rows);
    return {
      rows: page.rows.map((r) => ({ ...toListItem(r, rfqIds.get(r.id) ?? null), ...names(r) })),
      total: page.total,
    };
  }

  /** One request with its lines; 404 outside the caller's entity or scope. */
  async get(id: string): Promise<PurchaseRequestDto> {
    const { principal, scope } = this.caller.current();
    const [row] = await this.db
      .select()
      .from(purchaseRequests)
      .where(and(purchaseRequestScopeWhere(principal, READ_ACTION), eq(purchaseRequests.id, id)))
      .limit(1);
    if (row === undefined) throw notFound();
    const rfqId = (await this.liveRfqIds(this.db, scope, [row.id])).get(row.id) ?? null;
    const names = await this.namesOf(scope, [row]);
    return {
      ...toDto(row, await this.linesOf(this.db, row.tenantId, row.id), rfqId, principal),
      ...names(row),
      purchaseOrders: await this.linkedOrdersOf(scope, principal, row),
    };
  }

  /**
   * The request's purchase orders (not drafts), read with the request it was already allowed to read: number,
   * status and vendor legal name only, from the acting entity (scoped()). Nothing else of the order or the vendor
   * is selected, so the request's reader gains no purchase order or vendor read (U18 #4).
   */
  private async linkedOrdersOf(
    scope: TxScope,
    principal: Principal,
    row: PurchaseRequestRow,
  ): Promise<LinkedPurchaseOrderDto[]> {
    const orders = await this.db
      .select({
        id: purchaseOrders.id,
        number: purchaseOrders.number,
        status: purchaseOrders.status,
        vendorName: vendors.legalName,
      })
      .from(purchaseOrders)
      .innerJoin(
        vendors,
        and(eq(vendors.tenantId, purchaseOrders.tenantId), eq(vendors.id, purchaseOrders.vendorId)),
      )
      .where(
        scoped(scope).where(
          purchaseOrders,
          and(eq(purchaseOrders.purchaseRequestId, row.id), ne(purchaseOrders.status, 'draft')),
        ),
      )
      .orderBy(asc(purchaseOrders.number));
    const serviceRoom = await this.serviceRoomOf(
      scope,
      orders.map((o) => o.id),
    );
    // Mirrors ReceiptsService.assertMayReceive for a service receipt: the requester themselves, or the receipt
    // confirm grant on this request.
    const mayReceive =
      (principal.status === 'active' &&
        principal.orgKind === 'staff' &&
        principal.organizationId === row.organizationId &&
        principal.userId === row.requesterUserId) ||
      can(principal, 'procurement.receipt.confirm', {
        tenantId: row.tenantId,
        organizationId: row.organizationId,
        ownerUserId: row.requesterUserId,
        departmentId: row.departmentId,
        sodUserIds: [],
      }).allowed;
    return orders.map((o) => ({
      id: o.id,
      number: o.number,
      status: o.status,
      vendorName: o.vendorName,
      can: {
        receiveService:
          mayReceive && RECEIVING_PO_STATUSES.includes(o.status) && serviceRoom.has(o.id),
      },
    }));
  }

  /**
   * The orders (of `orderIds`) with a service line that still has room for a receipt: ordered - cancelled - every
   * non-discarded receipt line on it, so confirmed receipts, reversals and drafts count as the receipt routes and
   * the new receipt page count them (ReceiptsService.quantitiesOf, a draft holds its quantity). Read for the flag
   * only; no quantity is returned.
   */
  private async serviceRoomOf(scope: TxScope, orderIds: readonly string[]): Promise<Set<string>> {
    if (orderIds.length === 0) return new Set();
    const [lines, taken] = await Promise.all([
      this.db
        .select({
          id: purchaseOrderLines.id,
          purchaseOrderId: purchaseOrderLines.purchaseOrderId,
          orderedQuantity: purchaseOrderLines.orderedQuantity,
          cancelledQuantity: purchaseOrderLines.cancelledQuantity,
        })
        .from(purchaseOrderLines)
        .where(
          scoped(scope).where(
            purchaseOrderLines,
            and(
              inArray(purchaseOrderLines.purchaseOrderId, [...orderIds]),
              eq(purchaseOrderLines.kind, 'service'),
            ),
          ),
        ),
      this.db
        .select({ poLineId: receiptLines.poLineId, quantity: receiptLines.quantity })
        .from(receiptLines)
        .innerJoin(
          receipts,
          and(
            eq(receipts.tenantId, receiptLines.tenantId),
            eq(receipts.id, receiptLines.receiptId),
          ),
        )
        .where(
          scoped(scope).where(
            receiptLines,
            and(
              inArray(receiptLines.purchaseOrderId, [...orderIds]),
              ne(receipts.status, 'discarded'),
            ),
          ),
        ),
    ]);
    const takenByLine = new Map<string, Decimal>();
    for (const t of taken) {
      takenByLine.set(t.poLineId, (takenByLine.get(t.poLineId) ?? new Decimal(0)).plus(t.quantity));
    }
    const withRoom = new Set<string>();
    for (const l of lines) {
      const room = new Decimal(l.orderedQuantity)
        .minus(l.cancelledQuantity)
        .minus(takenByLine.get(l.id) ?? 0);
      if (room.greaterThan(0)) withRoom.add(l.purchaseOrderId);
    }
    return withRoom;
  }

  /**
   * The names of the departments and cost centres the given requests (already read under the caller's scope)
   * name, from the acting tenant and entity only. A request's department and cost centre are labelled with the
   * request itself, so Procurement or a requester needs no department or cost-centre directory read.
   */
  private async namesOf(
    scope: TxScope,
    rows: readonly Pick<PurchaseRequestRow, 'departmentId' | 'costCenterId'>[],
  ): Promise<
    (r: Pick<PurchaseRequestRow, 'departmentId' | 'costCenterId'>) => {
      departmentName: string | null;
      costCenterName: string | null;
    }
  > {
    const deptIds = [...new Set(rows.map((r) => r.departmentId))];
    const ccIds = [...new Set(rows.map((r) => r.costCenterId))];
    const [depts, ccs] = await Promise.all([
      deptIds.length === 0
        ? []
        : this.db
            .select({ id: departments.id, name: departments.name })
            .from(departments)
            .where(scoped(scope).where(departments, inArray(departments.id, deptIds))),
      ccIds.length === 0
        ? []
        : this.db
            .select({ id: costCenters.id, name: costCenters.name })
            .from(costCenters)
            .where(scoped(scope).where(costCenters, inArray(costCenters.id, ccIds))),
    ]);
    const dept = new Map(depts.map((d) => [d.id, d.name]));
    const cc = new Map(ccs.map((c) => [c.id, c.name]));
    return (r) => ({
      departmentName: dept.get(r.departmentId) ?? null,
      costCenterName: cc.get(r.costCenterId) ?? null,
    });
  }

  // ------------------------------------------------------------------------------------------------- create

  /**
   * A draft request raised by the caller. 400 for a department outside the acting entity, 422
   * CURRENCY_NOT_ENABLED for a currency the company has not switched on (D44).
   */
  async create(
    body: CreatePurchaseRequestBody,
    idempotencyKey: string,
  ): Promise<PurchaseRequestDto> {
    const { scope, actor, principal } = this.caller.current();
    // Decided before any read: a caller who may not raise requests learns nothing.
    this.authz.assert(CREATE_ACTION);
    const now = this.clock();
    return withTx(this.db, scope, actor, async (tx) => {
      const done = await withIdempotency(
        tx,
        { command: 'procurement.pr.create', key: idempotencyKey, body },
        async () => ({
          status: 201,
          response: await this.createInTx(tx, scope, principal, body, now),
        }),
      );
      return done.response;
    });
  }

  private async createInTx(
    tx: DbTransaction,
    scope: TxScope,
    principal: Principal,
    body: CreatePurchaseRequestBody,
    now: Date,
  ): Promise<PurchaseRequestDto> {
    await this.currencies.assertEnabled(scope, body.currency);
    await this.assertDepartment(tx, scope, body.departmentId);
    await this.assertCostCenter(tx, scope, body.costCenterId);
    const lineRows = lineRowsOf(body.lines, body.requestType);
    const total = sumAmounts(lineRows.map((l) => l.estimatedAmount));
    const [row] = await tx
      .insert(purchaseRequests)
      .values({
        ...scope,
        ...headerColumnsOf(body),
        requesterUserId: principal.userId,
        status: 'draft',
        estimatedTotal: total,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    const lines = await tx
      .insert(purchaseRequestLines)
      .values(lineRows.map((l) => ({ ...scope, purchaseRequestId: row!.id, ...l })))
      .returning();
    await this.audit.record(tx, {
      action: 'procurement.pr.created',
      entityType: PURCHASE_REQUEST_AUDIT_ENTITY,
      entityId: row!.id,
      after: { status: 'draft', departmentId: row!.departmentId, estimatedTotal: total },
    });
    // A request that was just created has no RFQ.
    return toDto(row!, lines, null, principal);
  }

  // ------------------------------------------------------------------------------------------------- update

  /**
   * Replaces the content of a draft or returned request (a full replace: the body is the create body, so the
   * lines are the lines now). 404 outside the caller's scope, 409 once submitted or when expectedVersion is stale,
   * 422 CURRENCY_NOT_ENABLED when the body moves it to a currency the company has not switched on (D44).
   */
  async update(
    id: string,
    body: CreatePurchaseRequestBody,
    expectedVersion: number | undefined,
    idempotencyKey: string,
  ): Promise<PurchaseRequestDto> {
    const { scope, actor, principal } = this.caller.current();
    const now = this.clock();
    return withTx(this.db, scope, actor, async (tx) => {
      const done = await withIdempotency(
        tx,
        // The id and version are part of the hashed body: one key cannot replay onto another request.
        {
          command: 'procurement.pr.update',
          key: idempotencyKey,
          body: { id, expectedVersion, body },
        },
        async () => ({
          status: 200,
          response: await this.updateInTx(tx, scope, principal, id, body, expectedVersion, now),
        }),
      );
      return done.response;
    });
  }

  private async updateInTx(
    tx: DbTransaction,
    scope: TxScope,
    principal: Principal,
    id: string,
    body: CreatePurchaseRequestBody,
    expectedVersion: number | undefined,
    now: Date,
  ): Promise<PurchaseRequestDto> {
    const pr = await this.lockEditable(tx, scope, id, expectedVersion, 'edited');
    // Only a change is checked: a request may keep a currency the company switched off after it was raised.
    if (body.currency !== pr.currency) {
      await this.currencies.assertEnabled(scope, body.currency);
    }
    if (body.costCenterId !== pr.costCenterId) {
      await this.assertCostCenter(tx, scope, body.costCenterId);
    }
    if (body.departmentId !== pr.departmentId) {
      await this.assertDepartment(tx, scope, body.departmentId);
    }
    const lineRows = lineRowsOf(body.lines, body.requestType);
    const total = sumAmounts(lineRows.map((l) => l.estimatedAmount));

    // The lines first: the trigger lets this through only while the request is a draft or returned.
    await tx
      .delete(purchaseRequestLines)
      .where(
        and(
          eq(purchaseRequestLines.tenantId, scope.tenantId),
          eq(purchaseRequestLines.purchaseRequestId, id),
        ),
      );
    const lines = await tx
      .insert(purchaseRequestLines)
      .values(lineRows.map((l) => ({ ...scope, purchaseRequestId: id, ...l })))
      .returning();
    // An edit voids the FX snapshot of an earlier submit: it describes lines that no longer exist.
    const row = await updateVersioned(tx, purchaseRequests, id, pr.version, {
      ...headerColumnsOf(body),
      estimatedTotal: total,
      fxRate: null,
      fxSource: null,
      fxDate: null,
      estimatedTotalNpr: null,
      updatedAt: now,
    });
    await this.audit.record(tx, {
      action: 'procurement.pr.updated',
      entityType: PURCHASE_REQUEST_AUDIT_ENTITY,
      entityId: id,
      before: { status: pr.status, estimatedTotal: pr.estimatedTotal },
      after: { status: row.status, estimatedTotal: total },
    });
    return toDto(row, lines, await this.liveRfqIdOf(tx, scope, id), principal);
  }

  // ------------------------------------------------------------------------------------------------- cancel

  /** Cancels a draft (PR_TRANSITIONS allows no other status to cancel). 404 outside scope, 409 otherwise. */
  async cancel(
    id: string,
    expectedVersion: number | undefined,
    idempotencyKey: string,
  ): Promise<PurchaseRequestDto> {
    const { scope, actor, principal } = this.caller.current();
    const now = this.clock();
    return withTx(this.db, scope, actor, async (tx) => {
      const done = await withIdempotency(
        tx,
        { command: 'procurement.pr.cancel', key: idempotencyKey, body: { id, expectedVersion } },
        async () => {
          const pr = await this.lockForWrite(tx, scope, id, expectedVersion);
          if (pr.status !== 'draft') {
            throw conflict(`A ${pr.status} purchase request cannot be cancelled; only a draft can`);
          }
          const row = await updateVersioned(tx, purchaseRequests, id, pr.version, {
            status: 'cancelled',
            updatedAt: now,
          });
          await this.audit.record(tx, {
            action: 'procurement.pr.cancelled',
            entityType: PURCHASE_REQUEST_AUDIT_ENTITY,
            entityId: id,
            before: { status: 'draft' },
            after: { status: 'cancelled' },
          });
          return {
            status: 200,
            response: toDto(
              row,
              await this.linesOf(tx, scope.tenantId, id),
              await this.liveRfqIdOf(tx, scope, id),
              principal,
            ),
          };
        },
      );
      return done.response;
    });
  }

  // ------------------------------------------------------------------------------------------------- submit

  /**
   * Submits a draft or returned request to its department head and returns it (status submitted). 404 outside the
   * caller's scope, 409 unless draft or returned or when expectedVersion is stale, 422 NO_ELIGIBLE_APPROVER when
   * a step has nobody who may decide it (nothing is written but the admins' notice).
   */
  async submit(
    id: string,
    expectedVersion: number | undefined,
    idempotencyKey: string,
  ): Promise<PurchaseRequestDto> {
    const { scope, actor, principal } = this.caller.current();
    const now = this.clock();
    try {
      return await withTx(this.db, scope, actor, async (tx) => {
        const done = await withIdempotency(
          tx,
          { command: 'procurement.pr.submit', key: idempotencyKey, body: { id, expectedVersion } },
          async () => ({
            status: 200,
            response: await this.submitInTx(tx, scope, principal, id, expectedVersion, now),
          }),
        );
        return done.response;
      });
    } catch (error) {
      if (!(error instanceof NoEligibleApprover)) throw error;
      // The submit transaction rolled back; the notice gets a transaction of its own so it is kept.
      await withTx(this.db, scope, actor, (tx) =>
        this.notifyBlocked(tx, scope.tenantId, error.notice),
      );
      throw new UnprocessableEntityException({
        code: 'NO_ELIGIBLE_APPROVER',
        message: `This purchase request cannot be submitted: ${error.notice.reason}. An administrator has been told.`,
      });
    }
  }

  private async submitInTx(
    tx: DbTransaction,
    scope: TxScope,
    principal: Principal,
    id: string,
    expectedVersion: number | undefined,
    now: Date,
  ): Promise<PurchaseRequestDto> {
    const callerUserId = principal.userId;
    const pr = await this.lockEditable(tx, scope, id, expectedVersion, 'submitted');
    const lines = await this.linesOf(tx, scope.tenantId, id);
    if (lines.length === 0) throw conflict('A purchase request without lines cannot be submitted');

    // The estimate is the sum of the stored lines, never a client figure; the NPR value uses the FX snapshot.
    const total = sumAmounts(lines.map((l) => l.estimatedAmount));
    const fx = await this.money.toNprSnapshot(
      tx,
      scope,
      { amount: total, currency: pr.currency as 'NPR' | 'INR' | 'USD' },
      now,
    );
    const facts = approvalFactsOf({
      departmentId: pr.departmentId,
      isEmergency: pr.isEmergency,
      amountNpr: fx.amountNpr,
    });
    // The requester, whoever presses submit and everyone who edited the request never approve it.
    const editors = await this.audit.entityUserActors(
      tx,
      PURCHASE_REQUEST_AUDIT_ENTITY,
      id,
      PURCHASE_REQUEST_EDIT_ACTIONS,
    );
    const sodUserIds = [...new Set([pr.requesterUserId, callerUserId, ...editors])];
    const draftReference = pr.number ?? `Draft purchase request ${id.slice(0, 8)}`;
    const blocked = (reason: string) =>
      new NoEligibleApprover({
        requestId: id,
        reference: draftReference,
        rowVersion: pr.version,
        reason,
      });

    // First, before any write: a route with a blocked step is refused instead of opening a stuck request (M4).
    const plan = await this.approvals.preview(
      scope,
      PURCHASE_REQUEST_DOCUMENT_TYPE,
      facts,
      sodUserIds,
    );
    if (plan.blocked) throw blocked(plan.blockReason ?? 'No eligible approver');

    // The number is taken after every other lock, and only the first time (a resubmit keeps it).
    const number =
      pr.number ?? (await this.numbering.issue(tx, PURCHASE_REQUEST_SERIES, now)).number;

    const request = await this.approvals.submit(tx, {
      documentType: PURCHASE_REQUEST_DOCUMENT_TYPE,
      documentId: id,
      documentNumber: number,
      title: `Purchase request ${number}`,
      snapshot: buildApprovalSnapshot({
        number,
        pr,
        estimatedTotal: total,
        estimatedTotalNpr: fx.amountNpr,
        lines,
      }),
      facts,
      requesterUserId: pr.requesterUserId,
      submittedByUserId: callerUserId,
      sodUserIds,
    });
    if (request.status === 'blocked') {
      // The engine re-plans inside the transaction: an approver lost since the preview. Same answer as a blocked
      // preview; the rollback removes the request row and gives the number back.
      throw blocked('No eligible approver');
    }

    const isNpr = pr.currency === 'NPR';
    const row = await updateVersioned(tx, purchaseRequests, id, pr.version, {
      status: 'submitted',
      number,
      estimatedTotal: total,
      fxRate: fx.rate,
      fxSource: isNpr ? null : fx.rateSource,
      fxDate: isNpr ? null : fx.rateDate,
      estimatedTotalNpr: fx.amountNpr,
      approvalRequestId: request.requestId,
      submittedAt: now,
      updatedAt: now,
    });
    await this.audit.record(tx, {
      action: 'procurement.pr.submitted',
      entityType: PURCHASE_REQUEST_AUDIT_ENTITY,
      entityId: id,
      before: { status: pr.status },
      after: {
        status: 'submitted',
        number,
        approvalRequestId: request.requestId,
        approvalStatus: request.status,
        estimatedTotalNpr: fx.amountNpr,
        isEmergency: pr.isEmergency,
      },
    });
    return toDto(row, lines, await this.liveRfqIdOf(tx, scope, id), principal);
  }

  // ------------------------------------------------------------------------------------------------- helpers

  /** Locks the request in the acting entity and checks the caller's own-scope write grant; 404 when not theirs. */
  private async lockForWrite(
    tx: DbTransaction,
    scope: TxScope,
    id: string,
    expectedVersion: number | undefined,
  ): Promise<PurchaseRequestRow> {
    const [pr] = await tx
      .select()
      .from(purchaseRequests)
      .where(scoped(scope).where(purchaseRequests, eq(purchaseRequests.id, id)))
      .for('update');
    if (pr === undefined) throw notFound();
    this.assertVisible(purchaseRequestRef(pr));
    if (expectedVersion !== undefined && pr.version !== expectedVersion) {
      throw conflict('This record was changed by someone else; reload it and try again');
    }
    return pr;
  }

  /** `lockForWrite`, then 409 unless the request is a draft or returned. `verb` reads "cannot be <verb>". */
  private async lockEditable(
    tx: DbTransaction,
    scope: TxScope,
    id: string,
    expectedVersion: number | undefined,
    verb: string,
  ): Promise<PurchaseRequestRow> {
    const pr = await this.lockForWrite(tx, scope, id, expectedVersion);
    if (!isPrEditable(pr.status)) {
      throw conflict(
        `A ${pr.status} purchase request cannot be ${verb}; only a draft or returned one can`,
      );
    }
    return pr;
  }

  /**
   * The live RFQ (status other than cancelled; the partial unique index allows one per request) of each request
   * id, in the acting entity. Requests with none are absent from the map.
   */
  private async liveRfqIds(
    q: Pick<Db, 'select'>,
    scope: TxScope,
    requestIds: readonly string[],
  ): Promise<Map<string, string>> {
    if (requestIds.length === 0) return new Map();
    const rows = await q
      .select({ id: rfqs.id, purchaseRequestId: rfqs.purchaseRequestId })
      .from(rfqs)
      .where(
        scoped(scope).where(
          rfqs,
          and(inArray(rfqs.purchaseRequestId, [...requestIds]), ne(rfqs.status, 'cancelled')),
        ),
      );
    return new Map(rows.map((r) => [r.purchaseRequestId, r.id]));
  }

  private async liveRfqIdOf(
    q: Pick<Db, 'select'>,
    scope: TxScope,
    requestId: string,
  ): Promise<string | null> {
    return (await this.liveRfqIds(q, scope, [requestId])).get(requestId) ?? null;
  }

  private async linesOf(
    q: Pick<Db, 'select'>,
    tenantId: string,
    id: string,
  ): Promise<PurchaseRequestLineRow[]> {
    return q
      .select()
      .from(purchaseRequestLines)
      .where(
        and(
          eq(purchaseRequestLines.tenantId, tenantId),
          eq(purchaseRequestLines.purchaseRequestId, id),
        ),
      )
      .orderBy(asc(purchaseRequestLines.lineNo));
  }

  private async assertCostCenter(
    tx: DbTransaction,
    scope: TxScope,
    costCenterId: string,
  ): Promise<void> {
    const [row] = await tx
      .select({ id: costCenters.id })
      .from(costCenters)
      .where(
        scoped(scope).where(
          costCenters,
          and(eq(costCenters.id, costCenterId), eq(costCenters.active, true)),
        ),
      )
      .limit(1);
    if (row === undefined) throw badRequest('Unknown or inactive cost centre');
  }

  /** The department must be one of the acting entity's (a cross-entity id is a 400, not an FK error). */
  private async assertDepartment(
    tx: DbTransaction,
    scope: TxScope,
    departmentId: string,
  ): Promise<void> {
    const [row] = await tx
      .select({ id: departments.id })
      .from(departments)
      .where(scoped(scope).where(departments, eq(departments.id, departmentId)))
      .limit(1);
    if (row === undefined) throw badRequest('Unknown department');
  }

  /** P1-PLAN 6.2 "Blocked", without a request row: whoever may fix role assignments (admin.roles.write) is told. */
  private async notifyBlocked(
    tx: DbTransaction,
    tenantId: string,
    n: BlockedNotice,
  ): Promise<void> {
    for (const role of await this.approvals.blockedNoticeRoles(tenantId)) {
      await this.notify.notifyRole(tx, role, {
        title: `Approval blocked: ${n.reference}`,
        body: `${n.reference} cannot be submitted: ${n.reason}`,
        link: BLOCKED_NOTICE_LINK,
        email: {
          template: 'approval.blocked',
          vars: {
            documentNumber: n.reference,
            documentType: PURCHASE_REQUEST_DOCUMENT_TYPE,
            reason: n.reason,
            linkPath: BLOCKED_NOTICE_LINK,
          },
        },
        // One notice per attempt on this row version; a retry of the same blocked submit is deduped.
        dedupeKey: `purchase_request:${n.requestId}:blocked:${n.rowVersion}`,
      });
    }
  }

  /**
   * Record-level authz that answers 404, not 403, for a request outside the caller's scope: a 403 would confirm
   * that a guessed id exists. Other denials (no grant at all, inactive user) stay 403.
   */
  private assertVisible(ref: ResourceRef): void {
    try {
      this.authz.assert(CREATE_ACTION, ref);
    } catch (error) {
      const reason =
        error instanceof ForbiddenException
          ? (error.getResponse() as { reason?: unknown }).reason
          : undefined;
      if (reason === 'out_of_scope') throw notFound();
      throw error;
    }
  }
}
