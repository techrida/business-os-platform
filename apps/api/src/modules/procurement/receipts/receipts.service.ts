// ReceiptsService: goods receipts and service confirmations against an issued purchase order (P4 unit P4r; AD16).
// Serves the NFRs:
// - "money moves only after the right people agree": confirming goods needs procurement.receipt.confirm (the
//   warehouse, Kuu D03: no receiver role); a service may also be confirmed by the purchase request's requester;
//   everyone else, an accountant included, gets 403 and nothing is written;
// - "amounts are exact": quantities are numeric(18,4) strings compared with decimal.js; a draft may take no more
//   than ordered - cancelled - received (6 against 5 is refused) and the DB trigger receipt_lines_guard backs it up;
// - "no gaps in a numbered series": the GRN number comes from the GRN series when the draft is created, after
//   every other lock, so a refused draft gives its number back;
// - "no double effects" and "no lost updates": every write runs in withIdempotency and locks in one order,
//   PO -> PO lines (by id) -> receipt -> number series, so two receivers of one line queue instead of racing;
// - "nothing is edited after the fact": a reversal is a new confirmed receipt of negative lines naming the lines it
//   reverses; the original moves to `reversed` and the PO status is derived again from what stays received;
// - "one legal entity at a time": a PO or receipt of another entity is a 404 on every route, never a 403.
// The PO status is derived from the received quantities (issued, partially_received, fully_received); PO_TRANSITIONS
// allows each of those moves, reversals included. Any other PO status is left alone and refuses receipts.
// F1-Q41: the confirmation that first brings an emergency purchase's order to fully_received asks Management to
// review it (emergency-review.ts), in the same transaction.
import { type Permission, type PoStatus, type ReverseReceiptBody } from '@bos/contracts';
import {
  purchaseOrderLines,
  purchaseOrders,
  purchaseRequests,
  receiptLines,
  receiptSerials,
  receipts,
  scoped,
  vendors,
} from '@bos/db';
import { kathmanduDate, kathmanduDateString } from '@bos/locale';
import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
  UnprocessableEntityException,
} from '@nestjs/common';
import Decimal from 'decimal.js';
import { and, asc, desc, eq, inArray, ne } from 'drizzle-orm';

import { AuditService } from '../../../platform/audit/audit.service';
import { AuthzService } from '../../../platform/authz/authz.service';
import type { ResourceRef } from '../../../platform/authz/principal';
import { DB, type Db, type DbTransaction } from '../../../platform/db/db.module';
import { updateVersioned, withIdempotency } from '../../../platform/db/idempotency';
import { withTx, type TxScope } from '../../../platform/db/tx';
import { NumberingService } from '../../../platform/settings/numbering.service';
import { ApprovalsService } from '../../approvals/requests.service';
import { holdsPoRead, mayReadPo, mayReceiveKind } from '../orders/po-read-access';
import { emergencyReviewDue, requestEmergencyReview } from './emergency-review';
import {
  RECEIPT_AUDIT_ENTITY,
  RECEIPT_DERIVED_PO_STATUSES,
  RECEIPT_SERIES,
  RECEIVING_PO_STATUSES,
  derivePoStatus,
  openQuantity,
  overReceiptMessage,
  progressRowsOf,
  receiptCan,
  repeatedSerialAcrossLines,
  reversalLinesOf,
  serialOnTwoLines,
  serialViolation,
  toReceiptDto,
  validateDraftLines,
  type CreateReceiptBody,
  type LineQuantities,
  type PoLineFacts,
  type PoProgress,
  type ReceiptDto,
  type ReceiptLineRow,
  type ReceiptRow,
  type ReceiptViolation,
} from './receipt.rules';
import { ReceiptsCaller } from './receipts.caller';

/** Injection token for a test clock; production falls back to the system time. */
export const RECEIPTS_CLOCK = Symbol('RECEIPTS_CLOCK');

const CONFIRM_ACTION: Permission = 'procurement.receipt.confirm';
const READ_ACTION: Permission = 'procurement.pr.read';
const BILL_ENTER_ACTION: Permission = 'payables.bill.enter';
/** The grants this module works with: holding none of them is a 403 before any read. */
const MODULE_ACTIONS: readonly Permission[] = [
  CONFIRM_ACTION,
  READ_ACTION,
  'procurement.pr.create',
];

const notFound = (what: string) =>
  new NotFoundException({ code: 'not_found', message: `${what} not found` });
const invalidTransition = (message: string) =>
  new ConflictException({ code: 'invalid_transition', message });
const unprocessable = (v: ReceiptViolation) =>
  new UnprocessableEntityException({ code: v.code, message: v.message });

/** 422 RECEIPT_DATE_IN_FUTURE: goods cannot be received after today in Kathmandu (the client's `max` is advisory). */
function assertReceivedByToday(receivedAt: string, now: Date): void {
  const today = kathmanduDateString(now);
  if (receivedAt <= today) return;
  throw new UnprocessableEntityException({
    code: 'RECEIPT_DATE_IN_FUTURE',
    message: `The receipt date ${receivedAt} is after today (${today}); use today or an earlier date`,
    details: { receivedAt, today },
  });
}

type PoRow = typeof purchaseOrders.$inferSelect;
type PoLineRow = typeof purchaseOrderLines.$inferSelect;
type Reader = Pick<Db, 'select'>;

/** What the record-level checks read of the PO's purchase request: who raised it and for which department. */
interface RequestFacts {
  tenantId: string;
  organizationId: string;
  requesterUserId: string;
  departmentId: string;
}

const refOf = (r: RequestFacts): ResourceRef => ({
  tenantId: r.tenantId,
  organizationId: r.organizationId,
  ownerUserId: r.requesterUserId,
  departmentId: r.departmentId,
  sodUserIds: [],
});

/** The Postgres error behind `error`, also when drizzle wraps it (`cause`). */
function pgErrorOf(error: unknown): { code: string; constraint: string | undefined } | undefined {
  let e: unknown = error;
  for (let depth = 0; depth < 4 && typeof e === 'object' && e !== null; depth += 1) {
    const { code, constraint, cause } = e as {
      code?: unknown;
      constraint?: unknown;
      cause?: unknown;
    };
    if (typeof code === 'string') {
      return {
        code,
        constraint: typeof constraint === 'string' ? constraint : undefined,
      };
    }
    e = cause;
  }
  return undefined;
}

const poFacts = (l: PoLineRow): PoLineFacts => ({
  id: l.id,
  lineNo: l.lineNo,
  kind: l.kind,
  description: l.description,
  uom: l.uom,
  orderedQuantity: l.orderedQuantity,
  cancelledQuantity: l.cancelledQuantity,
  requiresSerials: l.requiresSerials,
});

@Injectable()
export class ReceiptsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly authz: AuthzService,
    private readonly audit: AuditService,
    private readonly numbering: NumberingService,
    private readonly caller: ReceiptsCaller,
    @Optional()
    @Inject(RECEIPTS_CLOCK)
    private readonly clock: () => Date = () => new Date(),
    /** Asks for the review of an emergency purchase (F1-Q41); absent in tests that do not look. */
    @Optional() private readonly approvals?: ApprovalsService,
  ) {}

  // ------------------------------------------------------------------------------------------------- reads

  /** The receipts of one PO, newest first, each with what the caller may do with it. 404 for another entity's PO. */
  async list(purchaseOrderId: string): Promise<ReceiptDto[]> {
    this.assertStaffWithAccess();
    const { scope, principal } = this.caller.current();
    const po = await this.readPo(this.db, scope, purchaseOrderId);
    const request = await this.requestOf(this.db, scope, po);
    this.assertMayRead(request);
    const rows = await this.db
      .select()
      .from(receipts)
      .where(scoped(scope).where(receipts, eq(receipts.purchaseOrderId, po.id)))
      .orderBy(desc(receipts.createdAt), desc(receipts.id));
    const lines = await this.db
      .select()
      .from(receiptLines)
      .where(scoped(scope).where(receiptLines, eq(receiptLines.purchaseOrderId, po.id)));
    const serials = await this.serialsOf(this.db, scope, lines);
    return rows.map((r) => ({
      ...toReceiptDto(
        r,
        lines.filter((l) => l.receiptId === r.id),
        serials,
      ),
      can: receiptCan(mayReceiveKind(principal, r.kind, request), r, po.status),
    }));
  }

  /** One receipt with its lines and serials; 404 outside the caller's entity or reach. */
  async get(id: string): Promise<ReceiptDto> {
    this.assertStaffWithAccess();
    const { scope, principal } = this.caller.current();
    const row = await this.readReceipt(this.db, scope, id);
    const po = await this.readPo(this.db, scope, row.purchaseOrderId);
    const request = await this.requestOf(this.db, scope, po);
    this.assertMayRead(request);
    return {
      ...(await this.dtoOf(this.db, scope, row)),
      can: receiptCan(mayReceiveKind(principal, row.kind, request), row, po.status),
    };
  }

  /**
   * Ordered, received (confirmed, net of reversals), still open and billed per PO line. Also open to whoever may read
   * the order itself (F1-Q52: the read-only purchase order page shows it to finance, who reads bills).
   */
  async progress(purchaseOrderId: string): Promise<PoProgress> {
    const { scope, principal } = this.caller.current();
    const readsOrders = holdsPoRead(principal);
    if (!readsOrders) this.assertStaffWithAccess(true);
    const [row] = await this.db
      .select({ po: purchaseOrders, vendorName: vendors.legalName })
      .from(purchaseOrders)
      .innerJoin(
        vendors,
        and(eq(vendors.tenantId, purchaseOrders.tenantId), eq(vendors.id, purchaseOrders.vendorId)),
      )
      .where(scoped(scope).where(purchaseOrders, eq(purchaseOrders.id, purchaseOrderId)))
      .limit(1);
    if (row === undefined) throw notFound('Purchase order');
    const { po, vendorName } = row;
    const request = await this.requestOf(this.db, scope, po);
    if (!readsOrders || !mayReadPo(principal, request)) this.assertMayRead(request, true);
    const lines = await this.db
      .select()
      .from(purchaseOrderLines)
      .where(scoped(scope).where(purchaseOrderLines, eq(purchaseOrderLines.purchaseOrderId, po.id)))
      .orderBy(asc(purchaseOrderLines.lineNo));
    const quantities = await this.quantitiesOf(this.db, scope, po.id);
    return {
      purchaseOrderId: po.id,
      vendorId: po.vendorId,
      vendorName,
      number: po.number,
      status: po.status,
      lines: progressRowsOf(lines.map(poFacts), quantities),
      can: {
        goods: mayReceiveKind(principal, 'goods', request),
        service: mayReceiveKind(principal, 'service', request),
      },
    };
  }

  // ------------------------------------------------------------------------------------------------- create

  /** A draft receipt with its GRN number. See the controller for the answers. */
  async create(body: CreateReceiptBody, idempotencyKey: string): Promise<ReceiptDto> {
    this.assertStaffWithAccess();
    const { scope, actor, principal } = this.caller.current();
    const now = this.clock();
    try {
      return await withTx(this.db, scope, actor, async (tx) => {
        const done = await withIdempotency(
          tx,
          { command: 'procurement.receipt.create', key: idempotencyKey, body },
          async () => ({
            status: 201,
            response: await this.createInTx(tx, scope, principal.userId, body, now),
          }),
        );
        return done.response;
      });
    } catch (error) {
      throw this.refineDbError(error);
    }
  }

  private async createInTx(
    tx: DbTransaction,
    scope: TxScope,
    userId: string,
    body: CreateReceiptBody,
    now: Date,
  ): Promise<ReceiptDto> {
    const po = await this.lockPo(tx, scope, body.purchaseOrderId);
    this.assertMayReceive(body.kind, await this.requestOf(tx, scope, po));
    assertReceivedByToday(body.receivedAt, now);
    if (po.status === 'fully_received') {
      // F1-Q39: more than was ordered needs an amendment first.
      throw invalidTransition(
        'Everything ordered on this purchase order has been received. To receive more, ask Procurement to amend the purchase order first.',
      );
    }
    if (!RECEIVING_PO_STATUSES.includes(po.status)) {
      throw invalidTransition(
        `A ${po.status} purchase order cannot take a receipt; it must be issued`,
      );
    }
    const poLines = await this.lockPoLines(tx, scope, po.id);
    const quantities = await this.quantitiesOf(tx, scope, po.id);
    const net = new Map([...quantities].map(([id, q]) => [id, q.net]));
    const violation = validateDraftLines(
      body.kind,
      body.lines,
      new Map(poLines.map((l) => [l.id, poFacts(l)])),
      net,
    );
    if (violation !== null) throw unprocessable(violation);
    await this.assertSerialsFree(tx, scope, body);

    // The number is the last lock: nothing above can be refused after it is taken.
    const grn = await this.numbering.issue(tx, RECEIPT_SERIES, now);
    const [row] = await tx
      .insert(receipts)
      .values({
        ...scope,
        number: grn.number,
        numberSeq: grn.seq,
        fiscalYear: grn.fiscalYear,
        purchaseOrderId: po.id,
        kind: body.kind,
        receivedAt: body.receivedAt,
        location: body.location ?? null,
        status: 'draft',
        createdBy: userId,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    const lines = await tx
      .insert(receiptLines)
      .values(
        body.lines.map((l, i) => ({
          ...scope,
          receiptId: row!.id,
          purchaseOrderId: po.id,
          poLineId: l.poLineId,
          lineNo: i + 1,
          quantity: new Decimal(l.quantity).toFixed(4),
          inspection: l.inspection ?? null,
          discrepancyNote: l.discrepancyNote ?? null,
          overReceiptExceptionId: null,
          createdAt: now,
          updatedAt: now,
        })),
      )
      .returning();
    const serialRows = body.lines.flatMap((l, i) =>
      (l.serials ?? []).map((s) => ({
        ...scope,
        receiptLineId: lines[i]!.id,
        serialNo: s.serialNo,
        batchNo: s.batchNo ?? null,
        warrantyUntil: s.warrantyUntil ?? null,
        createdAt: now,
      })),
    );
    const serials =
      serialRows.length === 0 ? [] : await tx.insert(receiptSerials).values(serialRows).returning();
    await this.audit.record(tx, {
      action: 'procurement.receipt.created',
      entityType: RECEIPT_AUDIT_ENTITY,
      entityId: row!.id,
      after: { number: row!.number, purchaseOrderId: po.id, kind: body.kind, lines: lines.length },
    });
    return toReceiptDto(row!, lines, serials);
  }

  /** Discards a draft while holding the same PO, line and receipt locks as confirmation. */
  async discard(id: string, idempotencyKey: string): Promise<ReceiptDto> {
    this.assertStaffWithAccess();
    const { scope, actor } = this.caller.current();
    return withTx(this.db, scope, actor, async (tx) => {
      const done = await withIdempotency(
        tx,
        { command: 'procurement.receipt.discard', key: idempotencyKey, body: { id } },
        async () => {
          const head = await this.readReceipt(tx, scope, id);
          const po = await this.lockPo(tx, scope, head.purchaseOrderId);
          this.assertMayReceive(head.kind, await this.requestOf(tx, scope, po));
          await this.lockPoLines(tx, scope, po.id);
          const receipt = await this.lockReceipt(tx, scope, id);
          if (receipt.status === 'discarded') {
            return { status: 200, response: await this.dtoOf(tx, scope, receipt) };
          }
          if (receipt.status !== 'draft') {
            throw invalidTransition(
              `A ${receipt.status} receipt cannot be discarded; only a draft can`,
            );
          }
          const row = await updateVersioned(tx, receipts, id, receipt.version, {
            status: 'discarded',
            updatedAt: this.clock(),
          });
          await this.audit.record(tx, {
            action: 'procurement.receipt.discarded',
            entityType: RECEIPT_AUDIT_ENTITY,
            entityId: id,
            before: { status: 'draft' },
            after: { status: 'discarded', number: receipt.number, purchaseOrderId: po.id },
          });
          return { status: 200, response: await this.dtoOf(tx, scope, row) };
        },
      );
      return done.response;
    });
  }

  // ------------------------------------------------------------------------------------------------- confirm

  /** Confirms a draft. See the controller for the answers. */
  async confirm(id: string, idempotencyKey: string): Promise<ReceiptDto> {
    this.assertStaffWithAccess();
    const { scope, actor, principal } = this.caller.current();
    const now = this.clock();
    try {
      return await withTx(this.db, scope, actor, async (tx) => {
        const done = await withIdempotency(
          tx,
          { command: 'procurement.receipt.confirm', key: idempotencyKey, body: { id } },
          async () => ({
            status: 200,
            response: await this.confirmInTx(tx, scope, principal.userId, id, now),
          }),
        );
        return done.response;
      });
    } catch (error) {
      throw this.refineDbError(error);
    }
  }

  private async confirmInTx(
    tx: DbTransaction,
    scope: TxScope,
    userId: string,
    id: string,
    now: Date,
  ): Promise<ReceiptDto> {
    const head = await this.readReceipt(tx, scope, id);
    const po = await this.lockPo(tx, scope, head.purchaseOrderId);
    this.assertMayReceive(head.kind, await this.requestOf(tx, scope, po));
    const poLines = await this.lockPoLines(tx, scope, po.id);
    const receipt = await this.lockReceipt(tx, scope, id);
    if (receipt.status !== 'draft') {
      throw invalidTransition(`A ${receipt.status} receipt cannot be confirmed; only a draft can`);
    }
    // A draft dated later than the day it is confirmed (or saved before this rule) is refused too.
    assertReceivedByToday(receipt.receivedAt, now);
    if (!RECEIVING_PO_STATUSES.includes(po.status)) {
      throw invalidTransition(
        `A ${po.status} purchase order cannot take a receipt; it must be issued`,
      );
    }

    // The draft was checked when it was made; what it checked can have moved (a short-close shrank the open
    // quantity), so check again with the PO locked.
    const lines = await this.linesOf(tx, scope, id);
    const serials = await this.serialsOf(tx, scope, lines);
    const quantities = await this.quantitiesOf(tx, scope, po.id);
    for (const line of lines) {
      const poLine = poLines.find((p) => p.id === line.poLineId)!;
      const open = openQuantity(poFacts(poLine), quantities.get(poLine.id)?.net);
      if (open.isNegative()) {
        // `net` already counts this draft, so what it may take is what is open plus its own quantity.
        throw unprocessable({
          code: 'over_receipt',
          message: overReceiptMessage(poLine.lineNo, Decimal.max(open.plus(line.quantity), 0)),
        });
      }
      const mine = serials.filter((s) => s.receiptLineId === line.id);
      const bad = serialViolation(
        poLine.requiresSerials,
        line.quantity,
        mine.length,
        mine.map((s) => s.serialNo),
      );
      if (bad !== null)
        throw unprocessable({ ...bad, message: `PO line ${poLine.lineNo}: ${bad.message}` });
    }
    const repeated = repeatedSerialAcrossLines(
      lines.map((l) => ({
        serialNos: serials.filter((s) => s.receiptLineId === l.id).map((s) => s.serialNo),
      })),
    );
    if (repeated !== null) throw unprocessable(serialOnTwoLines(repeated));

    const row = await updateVersioned(tx, receipts, id, receipt.version, {
      status: 'confirmed',
      confirmedBy: userId,
      confirmedAt: now,
      updatedAt: now,
    });
    const poStatus = await this.syncPoStatus(tx, scope, po, poLines, now);
    if (emergencyReviewDue(po.status, poStatus) && this.approvals) {
      await requestEmergencyReview(
        tx,
        scope,
        { approvals: this.approvals, audit: this.audit },
        po,
        userId,
      );
    }
    await this.audit.record(tx, {
      action: 'procurement.receipt.confirmed',
      entityType: RECEIPT_AUDIT_ENTITY,
      entityId: id,
      before: { status: 'draft' },
      after: { status: 'confirmed', number: row.number, purchaseOrderStatus: poStatus },
    });
    return toReceiptDto(row, lines, serials);
  }

  // ------------------------------------------------------------------------------------------------- reverse

  /** Reverses a confirmed receipt with a new negative one. See the controller for the answers. */
  async reverse(id: string, body: ReverseReceiptBody, idempotencyKey: string): Promise<ReceiptDto> {
    this.assertStaffWithAccess();
    const { scope, actor, principal } = this.caller.current();
    const now = this.clock();
    try {
      return await withTx(this.db, scope, actor, async (tx) => {
        const done = await withIdempotency(
          tx,
          { command: 'procurement.receipt.reverse', key: idempotencyKey, body: { id, body } },
          async () => ({
            status: 200,
            response: await this.reverseInTx(tx, scope, principal.userId, id, body.reason, now),
          }),
        );
        return done.response;
      });
    } catch (error) {
      throw this.refineDbError(error);
    }
  }

  private async reverseInTx(
    tx: DbTransaction,
    scope: TxScope,
    userId: string,
    id: string,
    reason: string,
    now: Date,
  ): Promise<ReceiptDto> {
    const head = await this.readReceipt(tx, scope, id);
    const po = await this.lockPo(tx, scope, head.purchaseOrderId);
    this.assertMayReceive(head.kind, await this.requestOf(tx, scope, po));
    const poLines = await this.lockPoLines(tx, scope, po.id);
    const original = await this.lockReceipt(tx, scope, id);
    if (original.status !== 'confirmed' || original.reversesReceiptId !== null) {
      throw invalidTransition(
        original.reversesReceiptId !== null
          ? 'A reversal cannot be reversed'
          : `A ${original.status} receipt cannot be reversed; only a confirmed one can`,
      );
    }
    if (!RECEIPT_DERIVED_PO_STATUSES.includes(po.status)) {
      throw invalidTransition(`A receipt of a ${po.status} purchase order cannot be reversed`);
    }

    // The number is the last lock.
    const grn = await this.numbering.issue(tx, RECEIPT_SERIES, now);
    const today = kathmanduDate(now);
    const [reversal] = await tx
      .insert(receipts)
      .values({
        ...scope,
        number: grn.number,
        numberSeq: grn.seq,
        fiscalYear: grn.fiscalYear,
        purchaseOrderId: po.id,
        kind: original.kind,
        receivedAt: `${today.y}-${String(today.m).padStart(2, '0')}-${String(today.d).padStart(2, '0')}`,
        location: original.location,
        status: 'confirmed',
        createdBy: userId,
        confirmedBy: userId,
        confirmedAt: now,
        reversesReceiptId: original.id,
        reversalReason: reason,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    const originalLines = await this.linesOf(tx, scope, id);
    const lines = await tx
      .insert(receiptLines)
      .values(
        reversalLinesOf(originalLines).map((l) => ({
          ...scope,
          receiptId: reversal!.id,
          purchaseOrderId: po.id,
          ...l,
          createdAt: now,
          updatedAt: now,
        })),
      )
      .returning();
    await updateVersioned(tx, receipts, id, original.version, {
      status: 'reversed',
      updatedAt: now,
    });
    const poStatus = await this.syncPoStatus(tx, scope, po, poLines, now);
    await this.audit.record(tx, {
      action: 'procurement.receipt.reversed',
      entityType: RECEIPT_AUDIT_ENTITY,
      entityId: id,
      before: { status: 'confirmed' },
      after: {
        status: 'reversed',
        reversalReceiptId: reversal!.id,
        reversalNumber: reversal!.number,
        reason,
        purchaseOrderStatus: poStatus,
      },
    });
    return toReceiptDto(reversal!, lines, []);
  }

  // ------------------------------------------------------------------------------------------------- helpers

  /** Locks the PO of the acting entity (the first lock); 404 for another entity's. */
  private async lockPo(tx: DbTransaction, scope: TxScope, id: string): Promise<PoRow> {
    const [po] = await tx
      .select()
      .from(purchaseOrders)
      .where(scoped(scope).where(purchaseOrders, eq(purchaseOrders.id, id)))
      .for('update');
    if (po === undefined) throw notFound('Purchase order');
    return po;
  }

  private async readPo(q: Reader, scope: TxScope, id: string): Promise<PoRow> {
    const [po] = await q
      .select()
      .from(purchaseOrders)
      .where(scoped(scope).where(purchaseOrders, eq(purchaseOrders.id, id)))
      .limit(1);
    if (po === undefined) throw notFound('Purchase order');
    return po;
  }

  /** Locks every line of the PO, in id order (the second lock; the same order for every writer). */
  private lockPoLines(tx: DbTransaction, scope: TxScope, poId: string): Promise<PoLineRow[]> {
    return tx
      .select()
      .from(purchaseOrderLines)
      .where(scoped(scope).where(purchaseOrderLines, eq(purchaseOrderLines.purchaseOrderId, poId)))
      .orderBy(asc(purchaseOrderLines.id))
      .for('update');
  }

  /** Locks the receipt (the third lock). */
  private async lockReceipt(tx: DbTransaction, scope: TxScope, id: string): Promise<ReceiptRow> {
    const [row] = await tx
      .select()
      .from(receipts)
      .where(scoped(scope).where(receipts, eq(receipts.id, id)))
      .for('update');
    if (row === undefined) throw notFound('Receipt');
    return row;
  }

  private async readReceipt(q: Reader, scope: TxScope, id: string): Promise<ReceiptRow> {
    const [row] = await q
      .select()
      .from(receipts)
      .where(scoped(scope).where(receipts, eq(receipts.id, id)))
      .limit(1);
    if (row === undefined) throw notFound('Receipt');
    return row;
  }

  private linesOf(q: Reader, scope: TxScope, receiptId: string): Promise<ReceiptLineRow[]> {
    return q
      .select()
      .from(receiptLines)
      .where(scoped(scope).where(receiptLines, eq(receiptLines.receiptId, receiptId)))
      .orderBy(asc(receiptLines.lineNo));
  }

  private async serialsOf(q: Reader, scope: TxScope, lines: readonly ReceiptLineRow[]) {
    if (lines.length === 0) return [];
    return q
      .select()
      .from(receiptSerials)
      .where(
        scoped(scope).where(
          receiptSerials,
          inArray(
            receiptSerials.receiptLineId,
            lines.map((l) => l.id),
          ),
        ),
      )
      .orderBy(asc(receiptSerials.serialNo));
  }

  private async dtoOf(q: Reader, scope: TxScope, row: ReceiptRow): Promise<ReceiptDto> {
    const lines = await this.linesOf(q, scope, row.id);
    return toReceiptDto(row, lines, await this.serialsOf(q, scope, lines));
  }

  /** The purchase request the PO was raised from: its requester decides who may confirm a service. */
  private async requestOf(q: Reader, scope: TxScope, po: PoRow): Promise<RequestFacts> {
    const [pr] = await q
      .select({
        tenantId: purchaseRequests.tenantId,
        organizationId: purchaseRequests.organizationId,
        requesterUserId: purchaseRequests.requesterUserId,
        departmentId: purchaseRequests.departmentId,
      })
      .from(purchaseRequests)
      .where(scoped(scope).where(purchaseRequests, eq(purchaseRequests.id, po.purchaseRequestId)))
      .limit(1);
    // The PO's own foreign key makes this unreachable; a missing row is a 404 rather than an open door.
    if (pr === undefined) throw notFound('Purchase order');
    return pr;
  }

  /**
   * Quantities received per PO line: `net` is every non-discarded receipt line (what the DB guard
   * sums, so a draft reserves its units), `confirmed` those of confirmed and reversed receipts (a reversal nets
   * its original to zero) and `draft` the rest.
   */
  private async quantitiesOf(
    q: Reader,
    scope: TxScope,
    poId: string,
  ): Promise<Map<string, LineQuantities>> {
    const rows = await q
      .select({
        poLineId: receiptLines.poLineId,
        quantity: receiptLines.quantity,
        status: receipts.status,
      })
      .from(receiptLines)
      .innerJoin(
        receipts,
        and(eq(receipts.tenantId, receiptLines.tenantId), eq(receipts.id, receiptLines.receiptId)),
      )
      .where(scoped(scope).where(receiptLines, eq(receiptLines.purchaseOrderId, poId)));
    const sums = new Map<string, { net: Decimal; confirmed: Decimal; draft: Decimal }>();
    for (const r of rows) {
      if (r.status === 'discarded') continue;
      const s = sums.get(r.poLineId) ?? {
        net: new Decimal(0),
        confirmed: new Decimal(0),
        draft: new Decimal(0),
      };
      s.net = s.net.plus(r.quantity);
      if (r.status === 'draft') s.draft = s.draft.plus(r.quantity);
      else s.confirmed = s.confirmed.plus(r.quantity);
      sums.set(r.poLineId, s);
    }
    return new Map(
      [...sums].map(([id, s]) => [
        id,
        { net: s.net.toFixed(4), confirmed: s.confirmed.toFixed(4), draft: s.draft.toFixed(4) },
      ]),
    );
  }

  /** Moves the PO to the status its confirmed quantities give (see the header). Returns the status it has now. */
  private async syncPoStatus(
    tx: DbTransaction,
    scope: TxScope,
    po: PoRow,
    poLines: readonly PoLineRow[],
    now: Date,
  ): Promise<PoStatus> {
    if (!RECEIPT_DERIVED_PO_STATUSES.includes(po.status)) return po.status;
    const quantities = await this.quantitiesOf(tx, scope, po.id);
    const next = derivePoStatus(
      poLines.map((l) => ({
        orderedQuantity: l.orderedQuantity,
        cancelledQuantity: l.cancelledQuantity,
        receivedQuantity: quantities.get(l.id)?.confirmed ?? '0',
      })),
    );
    if (next === po.status) return next;
    await updateVersioned(tx, purchaseOrders, po.id, po.version, { status: next, updatedAt: now });
    await this.audit.record(tx, {
      action: 'procurement.po.receipt_status_changed',
      entityType: 'purchase_orders',
      entityId: po.id,
      before: { status: po.status },
      after: { status: next },
    });
    return next;
  }

  /** A serial already taken in by another live receipt of the same PO line cannot come in again. */
  private async assertSerialsFree(
    tx: DbTransaction,
    scope: TxScope,
    body: CreateReceiptBody,
  ): Promise<void> {
    for (const line of body.lines) {
      const serialNos = (line.serials ?? []).map((s) => s.serialNo);
      if (serialNos.length === 0) continue;
      const taken = await tx
        .select({ serialNo: receiptSerials.serialNo })
        .from(receiptSerials)
        .innerJoin(
          receiptLines,
          and(
            eq(receiptLines.tenantId, receiptSerials.tenantId),
            eq(receiptLines.id, receiptSerials.receiptLineId),
          ),
        )
        .innerJoin(
          receipts,
          and(
            eq(receipts.tenantId, receiptLines.tenantId),
            eq(receipts.id, receiptLines.receiptId),
          ),
        )
        .where(
          scoped(scope).where(
            receiptSerials,
            and(
              eq(receiptLines.poLineId, line.poLineId),
              ne(receipts.status, 'reversed'),
              ne(receipts.status, 'discarded'),
              inArray(receiptSerials.serialNo, serialNos),
            ),
          ),
        )
        .limit(1);
      if (taken[0] !== undefined) {
        throw unprocessable({
          code: 'serial_duplicate',
          message: `Serial number ${taken[0].serialNo} was already received on this PO line`,
        });
      }
    }
  }

  /**
   * The database guards that slipped past the service's own checks (a writer outside this service, say) answer
   * with the same codes: receipt_lines_guard's over-receipt and the per-line serial key.
   */
  private refineDbError(error: unknown): unknown {
    const pg = pgErrorOf(error);
    if (pg?.code === '23514' && pg.constraint === 'receipt_lines_over_receipt_check') {
      return unprocessable({
        code: 'over_receipt',
        message:
          'This receipt takes more than is still open on a purchase order line. To receive more, ask Procurement to amend the purchase order first.',
      });
    }
    if (pg?.code === '23505' && pg.constraint === 'receipt_serials_tenant_line_serial_unique') {
      return unprocessable({
        code: 'serial_duplicate',
        message: 'A serial number appears twice on one line',
      });
    }
    return error;
  }

  // ------------------------------------------------------------------------------------------------- authz

  /**
   * First check of every public method, before any read: an active staff caller who holds at least one of the
   * grants this module works with. Only the progress read also accepts payables.bill.enter. A portal user, an
   * inactive user or a role with none of the applicable grants is 403 whatever id they guess.
   */
  private assertStaffWithAccess(allowBillEnter = false): void {
    const { principal } = this.caller.current();
    const holds =
      MODULE_ACTIONS.some((a) => principal.grants.has(a)) ||
      (allowBillEnter && principal.grants.has(BILL_ENTER_ACTION));
    if (principal.status !== 'active' || principal.orgKind !== 'staff' || !holds) {
      throw new ForbiddenException({
        code: 'forbidden',
        message: 'Forbidden',
        reason: principal.status === 'active' ? 'no_permission' : 'inactive_user',
      });
    }
  }

  /**
   * Who may receive or confirm a receipt of `kind` (a draft, a confirmation or a reversal): goods need
   * procurement.receipt.confirm (the warehouse); a service also lets the purchase request's requester do it.
   * Deny by default: 403 for anyone else, an inactive user and a portal caller included.
   */
  private assertMayReceive(kind: 'goods' | 'service', pr: RequestFacts): void {
    const { principal } = this.caller.current();
    if (
      kind === 'service' &&
      principal.status === 'active' &&
      principal.orgKind === 'staff' &&
      principal.organizationId === pr.organizationId &&
      principal.userId === pr.requesterUserId
    ) {
      return;
    }
    this.authz.assert(CONFIRM_ACTION, refOf(pr));
  }

  /**
   * Who may read a PO's receipts and progress: whoever may confirm receipts, or may read the purchase request
   * (procurement, or the requester under `own` scope). The progress read also accepts payables.bill.enter on this
   * record. A caller outside the applicable grants is 403 without any grant and 404 when a grant does not reach it.
   */
  private assertMayRead(pr: RequestFacts, allowBillEnter = false): void {
    let billEnterOutOfScope = false;
    if (allowBillEnter) {
      try {
        this.authz.assert(BILL_ENTER_ACTION, refOf(pr));
        return;
      } catch (error) {
        if (!(error instanceof ForbiddenException)) throw error;
        billEnterOutOfScope =
          (error.getResponse() as { reason?: unknown }).reason === 'out_of_scope';
      }
    }
    try {
      this.authz.assert(CONFIRM_ACTION, refOf(pr));
      return;
    } catch (error) {
      if (!(error instanceof ForbiddenException)) throw error;
    }
    try {
      this.authz.assert(READ_ACTION, refOf(pr));
    } catch (error) {
      const reason =
        error instanceof ForbiddenException
          ? (error.getResponse() as { reason?: unknown }).reason
          : undefined;
      if (reason === 'out_of_scope' || billEnterOutOfScope) throw notFound('Purchase order');
      throw error;
    }
  }
}
