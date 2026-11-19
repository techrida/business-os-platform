// PaymentRequestsService: requests to pay a vendor's approved bills, and their approval (P4 unit A2; AD1, AD4, AD5,
// AD8). No payout: an approved request is the end of the road in Stage 1. Serves the NFRs:
// - "a payment goes only to a verified account": the vendor's active verified bank account is snapshotted
//   (vendor_bank_account_id + bank_last4) when the draft is made, because both columns are NOT NULL, and read again
//   at submit (refreshed if the vendor's account changed); with none, 409 `no_verified_bank_account` (check 14);
// - "amounts are exact" and "never more than is owed": each line is one payable open item of the vendor's approved
//   bill, in the request's currency, for at most its derived open amount (LedgerService.openAmounts) less what the
//   other pending or approved requests already claim on it; more is 409 OVER_ALLOCATION;
// - "no double effects" and "no lost updates": every write runs in withIdempotency; submit locks the request, then
//   the vendor row, then the open items (LedgerService.lockForMoneyCommand), so two requests on one bill are
//   submitted one after the other and the second sees the first's claim;
// - "money moves only after the right people agree": the `payment_request` route is Finance only when every bill
//   was matched against its PO, else Finance plus the AD4 bands (AD8 for a Founder requester); sod_user_ids holds
//   the requester, the submitter, each bill's enterer and each person who approved one of the bills (check 4);
// - "one legal entity at a time": every read is scoped to the acting entity; a request or an open item of another
//   entity is a 404, never a 403.
// What a decision does is the subject's (payment-request.subject.ts).
import { randomUUID } from 'node:crypto';

import {
  WorkflowSpecSchema,
  type PaymentRequestStatus,
  type RequestPaymentBody,
} from '@bos/contracts';
import {
  approvalActions,
  approvalRequests,
  openItems,
  paymentRequestLines,
  paymentRequests,
  purchaseOrders,
  scoped,
  vendorAccounts,
  vendorBankAccounts,
  vendorBills,
  vendors,
} from '@bos/db';
import { moneyToString, parseDecimal } from '@bos/money-rules';
import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
  UnprocessableEntityException,
} from '@nestjs/common';
import { and, asc, desc, eq, inArray, ne, sql } from 'drizzle-orm';

import { AuditService } from '../../../platform/audit/audit.service';
import { can } from '../../../platform/authz/can';
import { DB, type Db, type DbTransaction } from '../../../platform/db/db.module';
import { withIdempotency } from '../../../platform/db/idempotency';
import { withTx, type TxScope } from '../../../platform/db/tx';
import { searchPage } from '../../../platform/list';
import { ApprovalsService } from '../../approvals/requests.service';
import { LedgerError, LedgerService } from '../../ledger/ledger.service';
import { VENDOR_BILL_DOCUMENT_TYPE } from '../bills/vendor-bill.rules';
import { VendorBankService } from '../../vendors/bank/bank.service';
import { vendorRef } from '../../vendors/vendors.service';
import {
  CLAIMING_REQUEST_STATUSES,
  PAYABLE_BILL_STATUSES,
  PAYMENT_REQUEST_AUDIT_ENTITY,
  PAYMENT_REQUEST_DOCUMENT_TYPE,
  allPoMatchedOf,
  amountNprOf,
  canCancel,
  exceedsOpen,
  paymentRequestFactsOf,
  repeatedOpenItem,
  separatedUsers,
  totalOf,
  type CancelPaymentRequestBody,
  type ListPaymentRequestsQuery,
} from './payment-request.rules';
import { PaymentRequestsCaller } from './payment-requests.caller';

/** Injection token for a test clock; production falls back to the system time. */
export const PAYMENT_REQUESTS_CLOCK = Symbol('PAYMENT_REQUESTS_CLOCK');

type RequestRow = typeof paymentRequests.$inferSelect;
type LineRow = typeof paymentRequestLines.$inferSelect;
type BillRow = typeof vendorBills.$inferSelect;

export interface PaymentRequestLineDto {
  id: string;
  lineNo: number;
  openItemId: string;
  amount: string;
}

export interface PaymentRequestDto {
  id: string;
  number: string | null;
  vendorPartyId: string;
  paymentType: RequestRow['paymentType'];
  purchaseOrderId: string | null;
  currency: RequestRow['currency'];
  totalAmount: string;
  fromBankAccountId: string;
  vendorBankAccountId: string;
  bankLast4: string;
  status: PaymentRequestStatus;
  requestedBy: string;
  approvalRequestId: string | null;
  cancelReason: string | null;
  version: number;
  lines: PaymentRequestLineDto[];
}

/** One request as its page reads it: the vendor named under the request's own read, and what the caller may open. */
export interface PaymentRequestDetailDto extends PaymentRequestDto {
  /** The vendor's legal name, and nothing else of the vendor record. */
  vendorName: string | null;
  /** From the caller's live grants: `readVendor` is false when the vendor page would refuse them. */
  can: { readVendor: boolean };
}

export interface PaymentRequestItemDto {
  openItemId: string;
  vendorPartyId: string;
  vendorName: string;
  vendorBillId: string;
  billNumber: string | null;
  vendorInvoiceNo: string;
  currency: RequestRow['currency'];
  openAmount: string;
  claimedAmount: string;
  availableAmount: string;
}

/** A checked line: the item, the bill it pays and the amount asked for. */
interface CheckedLine {
  openItemId: string;
  amount: string;
  bill: BillRow;
}

const notFound = (what: string) =>
  new NotFoundException({ code: 'not_found', message: `${what} not found` });
const conflict = (code: string, message: string) => new ConflictException({ code, message });
const unprocessable = (code: string, message: string) =>
  new UnprocessableEntityException({ code, message });

/** Thrown inside the transaction so it rolls back (idempotency claim included). */
class NoEligibleApprover extends Error {
  constructor(readonly reason: string) {
    super('no eligible approver');
  }
}

function toDto(row: RequestRow, lines: readonly LineRow[]): PaymentRequestDto {
  return {
    id: row.id,
    number: row.number,
    vendorPartyId: row.vendorId,
    paymentType: row.paymentType,
    purchaseOrderId: row.purchaseOrderId,
    currency: row.currency,
    totalAmount: row.totalAmount,
    fromBankAccountId: row.fromBankAccountId,
    vendorBankAccountId: row.vendorBankAccountId,
    bankLast4: row.bankLast4,
    status: row.status,
    requestedBy: row.requestedBy,
    approvalRequestId: row.approvalRequestId,
    cancelReason: row.cancelReason,
    version: row.version,
    lines: lines.map((l) => ({
      id: l.id,
      lineNo: l.lineNo,
      openItemId: l.openItemId,
      amount: l.amount,
    })),
  };
}

@Injectable()
export class PaymentRequestsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly approvals: ApprovalsService,
    private readonly audit: AuditService,
    private readonly bank: VendorBankService,
    private readonly caller: PaymentRequestsCaller,
    @Optional()
    @Inject(PAYMENT_REQUESTS_CLOCK)
    private readonly clock: () => Date = () => new Date(),
    // LedgerService holds no state, so the fallback is the same service (as in VendorBillsService).
    @Optional()
    private readonly ledger: LedgerService = new LedgerService(),
  ) {}

  // ------------------------------------------------------------------------------------------------- reads

  /** Approved bill credits with a balance left after pending and approved payment requests. */
  async listItems(): Promise<PaymentRequestItemDto[]> {
    const { scope, actor } = this.caller.current();
    return withTx(this.db, scope, actor, async (tx) => {
      const rows = await tx
        .select({
          openItemId: openItems.id,
          vendorPartyId: vendorBills.vendorId,
          vendorName: vendors.legalName,
          vendorBillId: vendorBills.id,
          billNumber: vendorBills.number,
          vendorInvoiceNo: vendorBills.vendorInvoiceNo,
          currency: openItems.currency,
        })
        .from(openItems)
        .innerJoin(
          vendorBills,
          and(
            eq(vendorBills.tenantId, openItems.tenantId),
            eq(vendorBills.organizationId, openItems.organizationId),
            eq(vendorBills.id, openItems.sourceId),
            eq(vendorBills.vendorId, openItems.vendorPartyId),
            eq(vendorBills.currency, openItems.currency),
          ),
        )
        .innerJoin(
          vendors,
          and(eq(vendors.tenantId, vendorBills.tenantId), eq(vendors.id, vendorBills.vendorId)),
        )
        .innerJoin(
          vendorAccounts,
          and(
            eq(vendorAccounts.tenantId, vendorBills.tenantId),
            eq(vendorAccounts.organizationId, vendorBills.organizationId),
            eq(vendorAccounts.vendorId, vendorBills.vendorId),
            eq(vendorAccounts.active, true),
          ),
        )
        .innerJoin(
          vendorBankAccounts,
          and(
            eq(vendorBankAccounts.tenantId, vendorBills.tenantId),
            eq(vendorBankAccounts.vendorId, vendorBills.vendorId),
            eq(vendorBankAccounts.status, 'active'),
          ),
        )
        .where(
          scoped(scope).where(
            openItems,
            and(
              eq(openItems.side, 'payable'),
              eq(openItems.direction, 'credit'),
              eq(openItems.sourceType, 'vendor_bill'),
              eq(vendorBills.kind, 'bill'),
              inArray(vendorBills.status, [...PAYABLE_BILL_STATUSES]),
            ),
          ),
        )
        .orderBy(asc(vendors.legalName), asc(vendorBills.invoiceDate), asc(openItems.id));
      if (rows.length === 0) return [];
      const ids = rows.map((row) => row.openItemId);
      const open = await this.ledger.openAmounts(tx, scope, ids);
      const claimed = await this.claims(tx, scope, ids, null);
      return rows.flatMap((row) => {
        const openAmount = parseDecimal(open.get(row.openItemId) ?? '0');
        const claimedAmount = parseDecimal(claimed.get(row.openItemId) ?? '0');
        const availableAmount = openAmount.minus(claimedAmount);
        if (availableAmount.lte(0)) return [];
        return [
          {
            ...row,
            openAmount: moneyToString(openAmount),
            claimedAmount: moneyToString(claimedAmount),
            availableAmount: moneyToString(availableAmount),
          },
        ];
      });
    });
  }

  /**
   * One page of the entity's payment requests, newest first, optionally of some statuses and a search over the
   * request number and the vendor name, with the total of all matches. The id closes the order so requests created
   * in the same instant never swap between pages.
   */
  async list(
    query: ListPaymentRequestsQuery,
  ): Promise<{ rows: Omit<PaymentRequestDto, 'lines'>[]; total: number }> {
    const { scope, actor } = this.caller.current();
    return withTx(this.db, scope, actor, async (tx) => {
      const vendorJoin = and(
        eq(vendors.tenantId, paymentRequests.tenantId),
        eq(vendors.id, paymentRequests.vendorId),
      );
      const page = await searchPage(tx, {
        q: query.q,
        columns: [paymentRequests.number, vendors.legalName],
        where: scoped(scope).where(
          paymentRequests,
          query.status === undefined || query.status.length === 0
            ? undefined
            : inArray(paymentRequests.status, query.status),
        ),
        orderBy: [desc(paymentRequests.createdAt), desc(paymentRequests.id)],
        limit: query.limit,
        offset: query.offset,
        rows: (reader, p) =>
          reader
            .select({ request: paymentRequests })
            .from(paymentRequests)
            .innerJoin(vendors, vendorJoin)
            .where(p.where)
            .orderBy(...p.orderBy)
            .limit(p.limit)
            .offset(p.offset),
        count: async (reader, where) => {
          const [row] = await reader
            .select({ n: sql<number>`count(*)::int` })
            .from(paymentRequests)
            .innerJoin(vendors, vendorJoin)
            .where(where);
          return row?.n ?? 0;
        },
      });
      return {
        rows: page.rows.map(({ request }) => {
          const { lines: _lines, ...rest } = toDto(request, []);
          return rest;
        }),
        total: page.total,
      };
    });
  }

  /** 404 outside the acting entity. */
  async get(id: string): Promise<PaymentRequestDetailDto> {
    const { scope, actor, principal } = this.caller.current();
    return withTx(this.db, scope, actor, async (tx) => {
      const dto = await this.dto(tx, scope, id);
      const [vendor] = await tx
        .select()
        .from(vendors)
        .where(and(eq(vendors.tenantId, scope.tenantId), eq(vendors.id, dto.vendorPartyId)));
      return {
        ...dto,
        vendorName: vendor?.legalName ?? null,
        can: {
          readVendor:
            vendor !== undefined &&
            principal.orgKind === 'staff' &&
            can(principal, 'vendor.read', vendorRef(vendor, principal)).allowed,
        },
      };
    });
  }

  // ------------------------------------------------------------------------------------------------- create

  /**
   * A draft request to pay one vendor. 201 with the request. 404 for a vendor without an active account here or an
   * open item outside the acting entity; 409 `no_verified_bank_account` (check 14) or OVER_ALLOCATION (a line above
   * what is still open); 422 for an advance (no payout in Stage 1), an item named twice, an item that is not this
   * vendor's approved bill, another currency or a PO that is not the vendor's.
   */
  async create(input: RequestPaymentBody, idempotencyKey: string): Promise<PaymentRequestDto> {
    // Ids are compared with the stored (lowercase) uuids as text below, so an uppercase id is folded first.
    const body: RequestPaymentBody = {
      ...input,
      vendorPartyId: input.vendorPartyId.toLowerCase(),
      ...(input.purchaseOrderId === undefined
        ? {}
        : { purchaseOrderId: input.purchaseOrderId.toLowerCase() }),
      allocations: input.allocations.map((a) => ({
        openItemId: a.openItemId.toLowerCase(),
        amount: a.amount,
      })),
    };
    const { scope, actor, principal } = this.caller.current();
    const now = this.clock();
    return withTx(this.db, scope, actor, async (tx) => {
      const done = await withIdempotency(
        tx,
        { command: 'payables.payment_request.create', key: idempotencyKey, body },
        async () => {
          if (body.paymentType !== 'settlement') {
            throw unprocessable(
              'ADVANCE_NOT_SUPPORTED',
              'Only settlements of approved bills can be requested',
            );
          }
          const repeated = repeatedOpenItem(body.allocations);
          if (repeated !== undefined) {
            throw unprocessable('DUPLICATE_OPEN_ITEM', `Open item ${repeated} is named twice`);
          }
          const vendorId = body.vendorPartyId;
          const [account] = await tx
            .select({ vendorId: vendorAccounts.vendorId })
            .from(vendorAccounts)
            .where(
              scoped(scope).where(
                vendorAccounts,
                and(eq(vendorAccounts.vendorId, vendorId), eq(vendorAccounts.active, true)),
              ),
            );
          if (account === undefined) throw notFound('Vendor');
          if (body.purchaseOrderId !== undefined) {
            const [po] = await tx
              .select({ id: purchaseOrders.id })
              .from(purchaseOrders)
              .where(
                scoped(scope).where(
                  purchaseOrders,
                  and(
                    eq(purchaseOrders.id, body.purchaseOrderId),
                    eq(purchaseOrders.vendorId, vendorId),
                  ),
                ),
              );
            if (po === undefined) {
              throw unprocessable(
                'PURCHASE_ORDER_NOT_FOUND',
                'Not a purchase order of this vendor',
              );
            }
          }
          await this.lockVendor(tx, scope, vendorId);
          const snapshot = await this.bank.activeVerifiedAccount(scope, vendorId, tx);
          await this.checkLines(tx, scope, vendorId, body.currency, body.allocations, null);

          const id = randomUUID();
          const [row] = await tx
            .insert(paymentRequests)
            .values({
              id,
              tenantId: scope.tenantId,
              organizationId: scope.organizationId,
              vendorId,
              paymentType: body.paymentType,
              purchaseOrderId: body.purchaseOrderId ?? null,
              currency: body.currency,
              totalAmount: totalOf(body.allocations),
              fromBankAccountId: body.fromBankAccountId,
              vendorBankAccountId: snapshot.id,
              bankLast4: snapshot.accountLast4,
              requestedBy: principal.userId,
              createdAt: now,
              updatedAt: now,
            })
            .returning();
          await tx.insert(paymentRequestLines).values(
            body.allocations.map((a, i) => ({
              tenantId: scope.tenantId,
              organizationId: scope.organizationId,
              paymentRequestId: id,
              lineNo: i + 1,
              openItemId: a.openItemId,
              amount: a.amount,
              createdAt: now,
            })),
          );
          await this.audit.record(tx, {
            action: 'payables.payment_request.created',
            entityType: PAYMENT_REQUEST_AUDIT_ENTITY,
            entityId: id,
            after: {
              status: 'draft',
              vendorPartyId: vendorId,
              currency: body.currency,
              totalAmount: row!.totalAmount,
              vendorBankAccountId: snapshot.id,
              bankLast4: snapshot.accountLast4,
            },
          });
          return { status: 201, response: await this.dto(tx, scope, id) };
        },
      );
      return done.response;
    });
  }

  // ------------------------------------------------------------------------------------------------- submit

  /**
   * Sends a draft to the `payment_request` route. 200 with the request in pending_approval. 404 outside the acting
   * entity; 409 invalid_transition unless it is a draft, `no_verified_bank_account`, OVER_ALLOCATION when another
   * request claimed the balance first; 422 NO_ELIGIBLE_APPROVER (nothing written) when nobody outside the SoD set
   * can take a step.
   */
  async submit(id: string, idempotencyKey: string): Promise<PaymentRequestDto> {
    const { scope, actor, principal } = this.caller.current();
    const now = this.clock();
    try {
      return await withTx(this.db, scope, actor, async (tx) => {
        const done = await withIdempotency(
          tx,
          { command: 'payables.payment_request.submit', key: idempotencyKey, body: { id } },
          async () => {
            const request = await this.lockRequest(tx, scope, id);
            if (request.status !== 'draft') {
              throw conflict(
                'invalid_transition',
                `A ${request.status} payment request cannot be submitted`,
              );
            }
            const vendorName = await this.lockVendor(tx, scope, request.vendorId);
            const snapshot = await this.bank.activeVerifiedAccount(scope, request.vendorId, tx);
            const lines = await this.linesOf(tx, scope, request.id);
            await this.ledger.lockForMoneyCommand(tx, scope, [
              { rank: 'open_item', ids: lines.map((l) => l.openItemId) },
            ]);
            const checked = await this.checkLines(
              tx,
              scope,
              request.vendorId,
              request.currency,
              lines,
              request.id,
            );
            const bills = [...new Map(checked.map((c) => [c.bill.id, c.bill])).values()];
            const facts = paymentRequestFactsOf({
              amountNpr: amountNprOf(
                checked.map((c) => ({ amount: c.amount, fxRate: c.bill.fxRate })),
              ),
              allPoMatched: allPoMatchedOf(bills),
              requesterIsFounder: await this.holdsFounder(tx, scope, request.requestedBy),
            });
            const sodUserIds = separatedUsers({
              requester: request.requestedBy,
              submitter: principal.userId,
              billEnterers: bills.map((b) => b.enteredBy),
              billApprovers: await this.billApprovers(
                tx,
                scope,
                bills.map((b) => b.id),
              ),
            });
            const approval = await this.approvals.submit(tx, {
              documentType: PAYMENT_REQUEST_DOCUMENT_TYPE,
              documentId: request.id,
              ...(request.number === null ? {} : { documentNumber: request.number }),
              title: `Payment request ${request.currency} ${request.totalAmount}`,
              // The vendor's name and each bill's number are frozen with the ids, so the approver reads
              // them without a vendor or bill read of their own.
              snapshot: {
                vendorPartyId: request.vendorId,
                vendorName,
                currency: request.currency,
                totalAmount: request.totalAmount,
                vendorBankAccountId: snapshot.id,
                bankLast4: snapshot.accountLast4,
                lines: checked.map((c) => ({
                  openItemId: c.openItemId,
                  vendorBillId: c.bill.id,
                  billNumber: c.bill.number,
                  vendorInvoiceNo: c.bill.vendorInvoiceNo,
                  amount: c.amount,
                })),
              },
              facts,
              requesterUserId: request.requestedBy,
              submittedByUserId: principal.userId,
              sodUserIds,
            });
            if (approval.status === 'blocked') throw new NoEligibleApprover('No eligible approver');
            await tx
              .update(paymentRequests)
              .set({
                status: 'pending_approval',
                approvalRequestId: approval.requestId,
                vendorBankAccountId: snapshot.id,
                bankLast4: snapshot.accountLast4,
                version: sql`${paymentRequests.version} + 1`,
                updatedAt: now,
              })
              .where(
                scoped(scope).where(
                  paymentRequests,
                  and(eq(paymentRequests.id, request.id), eq(paymentRequests.status, 'draft')),
                ),
              );
            await this.audit.record(tx, {
              action: 'payables.payment_request.submitted',
              entityType: PAYMENT_REQUEST_AUDIT_ENTITY,
              entityId: request.id,
              before: {
                status: request.status,
                vendorBankAccountId: request.vendorBankAccountId,
              },
              after: {
                status: 'pending_approval',
                approvalRequestId: approval.requestId,
                vendorBankAccountId: snapshot.id,
                bankLast4: snapshot.accountLast4,
                ...facts,
              },
            });
            return { status: 200, response: await this.dto(tx, scope, request.id) };
          },
        );
        return done.response;
      });
    } catch (error) {
      if (!(error instanceof NoEligibleApprover)) throw error;
      throw unprocessable(
        'NO_ELIGIBLE_APPROVER',
        `This payment request cannot be submitted: ${error.reason}`,
      );
    }
  }

  // ------------------------------------------------------------------------------------------------- cancel

  /** Cancels a draft. 200 with the request. 404 outside the acting entity; 409 invalid_transition otherwise. */
  async cancel(
    id: string,
    body: CancelPaymentRequestBody,
    idempotencyKey: string,
  ): Promise<PaymentRequestDto> {
    const { scope, actor } = this.caller.current();
    const now = this.clock();
    return withTx(this.db, scope, actor, async (tx) => {
      const done = await withIdempotency(
        tx,
        { command: 'payables.payment_request.cancel', key: idempotencyKey, body: { id, ...body } },
        async () => {
          const request = await this.lockRequest(tx, scope, id);
          if (!canCancel(request.status)) {
            throw conflict(
              'invalid_transition',
              `A ${request.status} payment request cannot be cancelled`,
            );
          }
          await tx
            .update(paymentRequests)
            .set({
              status: 'cancelled',
              cancelReason: body.reason,
              version: sql`${paymentRequests.version} + 1`,
              updatedAt: now,
            })
            .where(
              scoped(scope).where(
                paymentRequests,
                and(eq(paymentRequests.id, request.id), eq(paymentRequests.status, 'draft')),
              ),
            );
          await this.audit.record(tx, {
            action: 'payables.payment_request.cancelled',
            entityType: PAYMENT_REQUEST_AUDIT_ENTITY,
            entityId: request.id,
            before: { status: request.status },
            after: { status: 'cancelled', reason: body.reason },
          });
          return { status: 200, response: await this.dto(tx, scope, request.id) };
        },
      );
      return done.response;
    });
  }

  // ------------------------------------------------------------------------------------------------- helpers

  /**
   * Checks every line against its open item: in this entity (404), a payable credit item of a bill of this vendor
   * in a payable status (422), in the request's currency (422), and at most the derived open amount less the other
   * live requests' claims (409 OVER_ALLOCATION). `requestId` is the request being checked, left out of the claims.
   */
  private async checkLines(
    tx: DbTransaction,
    scope: TxScope,
    vendorId: string,
    currency: string,
    lines: readonly { openItemId: string; amount: string }[],
    requestId: string | null,
  ): Promise<CheckedLine[]> {
    const ids = [...new Set(lines.map((l) => l.openItemId))];
    const items = await tx
      .select()
      .from(openItems)
      .where(scoped(scope).where(openItems, inArray(openItems.id, ids)));
    const itemById = new Map(items.map((i) => [i.id, i]));
    const billIds = [
      ...new Set(items.filter((i) => i.sourceType === 'vendor_bill').map((i) => i.sourceId)),
    ];
    const bills =
      billIds.length === 0
        ? []
        : await tx
            .select()
            .from(vendorBills)
            .where(scoped(scope).where(vendorBills, inArray(vendorBills.id, billIds)));
    const billById = new Map(bills.map((b) => [b.id, b]));
    const open = await this.ledger.openAmounts(tx, scope, ids);
    const claimed = await this.claims(tx, scope, ids, requestId);

    return lines.map((line) => {
      const item = itemById.get(line.openItemId);
      if (item === undefined) throw notFound('Open item');
      const bill = item.sourceType === 'vendor_bill' ? billById.get(item.sourceId) : undefined;
      if (
        item.side !== 'payable' ||
        item.direction !== 'credit' ||
        bill === undefined ||
        item.vendorPartyId !== vendorId ||
        bill.vendorId !== vendorId
      ) {
        throw unprocessable(
          'NOT_A_VENDOR_BILL_ITEM',
          `Open item ${item.id} is not a payable of this vendor's bill`,
        );
      }
      if (!(PAYABLE_BILL_STATUSES as readonly string[]).includes(bill.status)) {
        throw unprocessable('BILL_NOT_PAYABLE', `Bill ${bill.id} is ${bill.status}, not approved`);
      }
      if (item.currency !== currency) {
        throw unprocessable(
          'CURRENCY_MISMATCH',
          `Open item ${item.id} is in ${item.currency}, the request in ${currency}`,
        );
      }
      const openAmount = open.get(item.id) ?? '0';
      const other = claimed.get(item.id) ?? '0';
      if (exceedsOpen(line.amount, openAmount, other)) {
        throw new LedgerError(
          'OVER_ALLOCATION',
          `Open item ${item.id} has ${openAmount} open and ${other} already requested; ${line.amount} is too much`,
          { openItemId: item.id, openAmount, requested: other },
        );
      }
      return { openItemId: item.id, amount: line.amount, bill };
    });
  }

  /** What the other pending or approved requests of this entity ask of each item. */
  private async claims(
    tx: DbTransaction,
    scope: TxScope,
    ids: readonly string[],
    requestId: string | null,
  ): Promise<Map<string, string>> {
    if (ids.length === 0) return new Map();
    const rows = await tx
      .select({
        openItemId: paymentRequestLines.openItemId,
        claimed: sql<string>`sum(${paymentRequestLines.amount})::text`,
      })
      .from(paymentRequestLines)
      .innerJoin(
        paymentRequests,
        and(
          eq(paymentRequests.tenantId, paymentRequestLines.tenantId),
          eq(paymentRequests.organizationId, paymentRequestLines.organizationId),
          eq(paymentRequests.id, paymentRequestLines.paymentRequestId),
        ),
      )
      .where(
        scoped(scope).where(
          paymentRequestLines,
          and(
            inArray(paymentRequestLines.openItemId, [...ids]),
            inArray(paymentRequests.status, [...CLAIMING_REQUEST_STATUSES]),
            requestId === null ? undefined : ne(paymentRequests.id, requestId),
          ),
        ),
      )
      .groupBy(paymentRequestLines.openItemId);
    return new Map(rows.map((r) => [r.openItemId, r.claimed]));
  }

  /**
   * Everyone who approved one of these bills, or on whose behalf a delegate approved, across every `vendor_bill`
   * request of the bill (a returned and resubmitted bill has more than one).
   */
  private async billApprovers(
    tx: DbTransaction,
    scope: TxScope,
    billIds: readonly string[],
  ): Promise<(string | null)[]> {
    if (billIds.length === 0) return [];
    const rows = await tx
      .select({
        actorUserId: approvalActions.actorUserId,
        onBehalfOfUserId: approvalActions.onBehalfOfUserId,
      })
      .from(approvalActions)
      .innerJoin(
        approvalRequests,
        and(
          eq(approvalRequests.tenantId, approvalActions.tenantId),
          eq(approvalRequests.organizationId, approvalActions.organizationId),
          eq(approvalRequests.id, approvalActions.requestId),
        ),
      )
      .where(
        scoped(scope).where(
          approvalActions,
          and(
            eq(approvalActions.action, 'approve'),
            eq(approvalRequests.documentType, VENDOR_BILL_DOCUMENT_TYPE),
            inArray(approvalRequests.documentId, [...billIds]),
          ),
        ),
      );
    return rows.flatMap((r) => [r.actorUserId, r.onBehalfOfUserId]);
  }

  /** AD8: whether the requester holds the Founder role in this entity, from the approvals directory. */
  private async holdsFounder(tx: DbTransaction, scope: TxScope, userId: string): Promise<boolean> {
    const probe = WorkflowSpecSchema.parse({
      documentType: PAYMENT_REQUEST_DOCUMENT_TYPE,
      steps: [{ id: 'probe', kind: 'role', role: 'founder', reason: 'role lookup' }],
    });
    const data = await this.approvals.loadDirectory(tx, scope, probe);
    return (data.roleMembers.get('founder') ?? []).includes(userId);
  }

  /**
   * The vendor row (tenant-level) FOR UPDATE, before its bank account is read (VendorBankService's order). Returns its
   * legal name.
   */
  private async lockVendor(tx: DbTransaction, scope: TxScope, vendorId: string): Promise<string> {
    const [row] = await tx
      .select({ id: vendors.id, legalName: vendors.legalName })
      .from(vendors)
      .where(and(eq(vendors.tenantId, scope.tenantId), eq(vendors.id, vendorId)))
      .for('update');
    if (row === undefined) throw notFound('Vendor');
    return row.legalName;
  }

  private async lockRequest(tx: DbTransaction, scope: TxScope, id: string): Promise<RequestRow> {
    const [row] = await tx
      .select()
      .from(paymentRequests)
      .where(scoped(scope).where(paymentRequests, eq(paymentRequests.id, id)))
      .for('update');
    if (row === undefined) throw notFound('Payment request');
    return row;
  }

  private linesOf(tx: DbTransaction, scope: TxScope, requestId: string): Promise<LineRow[]> {
    return tx
      .select()
      .from(paymentRequestLines)
      .where(
        scoped(scope).where(
          paymentRequestLines,
          eq(paymentRequestLines.paymentRequestId, requestId),
        ),
      )
      .orderBy(asc(paymentRequestLines.lineNo));
  }

  private async dto(tx: DbTransaction, scope: TxScope, id: string): Promise<PaymentRequestDto> {
    const [row] = await tx
      .select()
      .from(paymentRequests)
      .where(scoped(scope).where(paymentRequests, eq(paymentRequests.id, id)));
    if (row === undefined) throw notFound('Payment request');
    return toDto(row, await this.linesOf(tx, scope, id));
  }
}
