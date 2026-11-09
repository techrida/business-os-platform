// AllocationsService: spreads a verified payment over issued invoices and debit notes, and reverses one allocation
// (P3 U8; decisions A1, A8, A12, A13; done checks 5, 7/G5 and 8). Serves the NFRs:
// - "paid is derived" (A8): an allocation is an append-only ledger row; nothing on the invoice changes, and the
//   settlement status is computed on read (ReceivablesService);
// - "no over-allocation under concurrency" (check 5): every command locks in the plan's order, payment row (rank
//   `payment`) -> invoice rows (rank `invoice`) -> the credit item and every debit item in one ascending step
//   (rank `open_item`), then re-reads the open amounts in a fresh statement before writing, so a loser waits and
//   gets 409 OVER_ALLOCATION; a concurrent payment reversal (U7, which also locks the payment first) cannot race;
// - "never against a proforma" (G5 at runtime, A12): the target must be an issued tax invoice or debit note with a
//   debit open item of that source type, of the payment's customer and currency (A13), else 409 MISMATCHED_ITEMS;
// - "who did it": allocations are made by the calling user (created_by is a user uuid; a system actor gets 403).
// Every command runs in withTx -> withIdempotency. The subledger is written only through LedgerService.
import { type AllocatePaymentBody, type AllocationDto, type DeallocateBody } from '@bos/contracts';
import { invoices, openItemAllocations, openItemBalances, openItems, payments } from '@bos/db';
import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import Decimal from 'decimal.js';
import { and, eq, inArray } from 'drizzle-orm';

import { AuditService } from '../../platform/audit/audit.service';
import { AuthzService } from '../../platform/authz/authz.service';
import { DB, type Db, type DbTransaction } from '../../platform/db/db.module';
import { withIdempotency } from '../../platform/db/idempotency';
import { withTx, type Actor, type TxScope } from '../../platform/db/tx';
import { LedgerService, type OpenItemAllocation } from '../ledger/ledger.service';
import { paymentRef } from '../payments/payment-owner.policy';

const AUDIT_ENTITY = 'payments';
/** Invoice kinds a payment may settle. A proforma opens no item (A12); a credit note is itself a credit. */
const ALLOCATABLE_KINDS = ['tax_invoice', 'debit_note'] as const;

type PaymentRow = typeof payments.$inferSelect;

const notFound = (what: string) =>
  new NotFoundException({ code: 'not_found', message: `${what} not found` });
const conflict = (code: string, message: string, details?: Record<string, string>) =>
  new ConflictException({ code, message, ...(details ? { details } : {}) });

function money2(value: string | Decimal): string {
  return new Decimal(value).toFixed(2);
}

@Injectable()
export class AllocationsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly authz: AuthzService,
    private readonly audit: AuditService,
    private readonly ledger: LedgerService,
  ) {}

  /**
   * Allocates `body.lines` from the payment's credit item. 404 for a payment or invoice outside the acting entity;
   * 409 payment_not_verified; 409 MISMATCHED_ITEMS for a proforma, a credit note, an unissued invoice, another
   * customer or another currency; 409 OVER_ALLOCATION when a line exceeds the invoice's open amount or the lines
   * together exceed the payment's. All lines land or none do.
   */
  async allocate(
    scope: TxScope,
    actor: Actor,
    paymentId: string,
    body: AllocatePaymentBody,
    idempotencyKey: string,
  ): Promise<AllocationDto[]> {
    const userId = this.userOf(actor);
    return withTx(this.db, scope, actor, async (tx) => {
      const done = await withIdempotency(
        tx,
        // The id is part of the hashed body: one key cannot replay onto another payment.
        { command: 'payment.allocate', key: idempotencyKey, body: { paymentId, ...body } },
        async () => ({
          status: 201,
          response: await this.allocateInTx(tx, scope, actor, userId, paymentId, body),
        }),
      );
      return done.response;
    });
  }

  /**
   * Reverses one live allocation of this payment with a negated row and a reason (LedgerService.reverseAllocation;
   * a second reversal of the same row returns the first). 404 unless the allocation is this payment's against an
   * invoice or debit note in the acting entity; 409 payment_not_verified.
   */
  async reverse(
    scope: TxScope,
    actor: Actor,
    paymentId: string,
    allocationId: string,
    body: DeallocateBody,
    idempotencyKey: string,
  ): Promise<AllocationDto> {
    this.userOf(actor);
    return withTx(this.db, scope, actor, async (tx) => {
      const done = await withIdempotency(
        tx,
        {
          command: 'payment.allocation.reverse',
          key: idempotencyKey,
          body: { paymentId, allocationId, ...body },
        },
        async () => ({
          status: 200,
          response: await this.reverseInTx(tx, scope, actor, paymentId, allocationId, body),
        }),
      );
      return done.response;
    });
  }

  // -------------------------------------------------------------------------------------- internals

  private async allocateInTx(
    tx: DbTransaction,
    scope: TxScope,
    actor: Actor,
    userId: string,
    paymentId: string,
    body: AllocatePaymentBody,
  ): Promise<AllocationDto[]> {
    const payment = await this.lockVerifiedPayment(tx, scope, paymentId);
    const invoiceIds = body.lines.map((l) => l.invoiceId);
    const lockedInvoices = await this.ledger.lockForMoneyCommand(tx, scope, [
      { rank: 'invoice', ids: invoiceIds, table: invoices },
    ]);
    if ((lockedInvoices.invoice ?? []).length !== invoiceIds.length) throw notFound('Invoice');

    const credit = await this.creditItem(tx, scope, paymentId);
    const rows = await tx
      .select({
        id: invoices.id,
        kind: invoices.kind,
        status: invoices.status,
        customerPartyId: invoices.customerPartyId,
        currency: invoices.currency,
      })
      .from(invoices)
      .where(
        and(
          eq(invoices.tenantId, scope.tenantId),
          eq(invoices.organizationId, scope.organizationId),
          inArray(invoices.id, invoiceIds),
        ),
      );
    const byId = new Map(rows.map((r) => [r.id, r]));
    const debitItems = await tx
      .select({ id: openItems.id, sourceType: openItems.sourceType, sourceId: openItems.sourceId })
      .from(openItems)
      .where(
        and(
          eq(openItems.tenantId, scope.tenantId),
          eq(openItems.organizationId, scope.organizationId),
          eq(openItems.side, 'receivable'),
          eq(openItems.direction, 'debit'),
          inArray(openItems.sourceType, [...ALLOCATABLE_KINDS]),
          inArray(openItems.sourceId, invoiceIds),
        ),
      );
    const debitOf = new Map<string, string>();
    for (const line of body.lines) {
      const invoice = byId.get(line.invoiceId);
      if (invoice === undefined) throw notFound('Invoice');
      const item = debitItems.find(
        (d) => d.sourceId === invoice.id && d.sourceType === invoice.kind,
      );
      if (
        !(ALLOCATABLE_KINDS as readonly string[]).includes(invoice.kind) ||
        invoice.status !== 'issued' ||
        item === undefined ||
        invoice.customerPartyId !== payment.customerPartyId ||
        invoice.currency !== payment.currency ||
        invoice.currency !== credit.currency
      ) {
        throw conflict(
          'MISMATCHED_ITEMS',
          'A payment settles only issued tax invoices and debit notes of the same customer and currency',
          { invoiceId: invoice.id },
        );
      }
      debitOf.set(line.invoiceId, item.id);
    }

    // Credit item and every debit item in one ascending step, then a fresh read of what is still open.
    await this.ledger.lockForMoneyCommand(tx, scope, [
      { rank: 'open_item', ids: [credit.id, ...debitOf.values()] },
    ]);
    const open = await this.openAmounts(tx, scope, [credit.id, ...debitOf.values()]);
    const creditOpen = open.get(credit.id) ?? new Decimal(0);
    const wanted = body.lines.reduce((sum, l) => sum.plus(l.amount), new Decimal(0));
    if (wanted.gt(creditOpen)) {
      throw conflict('OVER_ALLOCATION', 'The allocation is more than the payment has left', {
        amount: money2(wanted),
        paymentOpenAmount: money2(creditOpen),
      });
    }
    for (const line of body.lines) {
      const debitOpen = open.get(debitOf.get(line.invoiceId) ?? '') ?? new Decimal(0);
      if (new Decimal(line.amount).gt(debitOpen)) {
        throw conflict('OVER_ALLOCATION', 'The allocation is more than the invoice has open', {
          invoiceId: line.invoiceId,
          amount: money2(line.amount),
          invoiceOpenAmount: money2(debitOpen),
        });
      }
    }

    const written: AllocationDto[] = [];
    for (const line of body.lines) {
      const allocation = await this.ledger.allocate(tx, scope, actor, {
        debitItemId: debitOf.get(line.invoiceId) ?? '',
        creditItemId: credit.id,
        amount: money2(line.amount),
      });
      written.push(this.toDto(allocation, line.invoiceId, paymentId, userId));
    }
    await this.audit.record(tx, {
      action: 'payment.allocated',
      entityType: AUDIT_ENTITY,
      entityId: paymentId,
      after: {
        allocations: written.map((a) => ({ id: a.id, invoiceId: a.invoiceId, amount: a.amount })),
      },
    });
    return written;
  }

  private async reverseInTx(
    tx: DbTransaction,
    scope: TxScope,
    actor: Actor,
    paymentId: string,
    allocationId: string,
    body: DeallocateBody,
  ): Promise<AllocationDto> {
    await this.lockVerifiedPayment(tx, scope, paymentId);
    const credit = await this.creditItem(tx, scope, paymentId);
    const [found] = await tx
      .select({ a: openItemAllocations, debitSource: openItems.sourceId })
      .from(openItemAllocations)
      .innerJoin(
        openItems,
        and(
          eq(openItems.tenantId, openItemAllocations.tenantId),
          eq(openItems.organizationId, openItemAllocations.organizationId),
          eq(openItems.id, openItemAllocations.debitItemId),
        ),
      )
      .where(
        and(
          eq(openItemAllocations.tenantId, scope.tenantId),
          eq(openItemAllocations.organizationId, scope.organizationId),
          eq(openItemAllocations.id, allocationId),
          eq(openItemAllocations.creditItemId, credit.id),
          inArray(openItems.sourceType, [...ALLOCATABLE_KINDS]),
        ),
      )
      .limit(1);
    if (found === undefined) throw notFound('Allocation');
    await this.ledger.lockForMoneyCommand(tx, scope, [
      { rank: 'open_item', ids: [found.a.creditItemId, found.a.debitItemId] },
    ]);
    const { allocation, created } = await this.ledger.reverseAllocation(tx, scope, actor, {
      allocationId,
      reason: body.reason,
    });
    if (created) {
      await this.audit.record(tx, {
        action: 'payment.allocation_reversed',
        entityType: AUDIT_ENTITY,
        entityId: paymentId,
        before: { allocationId, amount: money2(found.a.amount) },
        after: { reversalId: allocation.id, amount: money2(allocation.amount) },
        meta: { reason: body.reason.trim() },
      });
    }
    return this.toDto(allocation, found.debitSource, paymentId, allocation.createdBy ?? '');
  }

  /** Payment row lock (rank `payment`) first; 404 outside the entity, 409 unless verified. */
  private async lockVerifiedPayment(
    tx: DbTransaction,
    scope: TxScope,
    paymentId: string,
  ): Promise<PaymentRow> {
    const locked = await this.ledger.lockForMoneyCommand(tx, scope, [
      { rank: 'payment', ids: [paymentId], table: payments },
    ]);
    if ((locked.payment ?? []).length === 0) throw notFound('Payment');
    const [row] = await tx
      .select()
      .from(payments)
      .where(
        and(
          eq(payments.tenantId, scope.tenantId),
          eq(payments.organizationId, scope.organizationId),
          eq(payments.id, paymentId),
        ),
      )
      .limit(1);
    if (row === undefined) throw notFound('Payment');
    this.authz.assert(
      'payment.allocate',
      paymentRef({
        tenantId: row.tenantId,
        organizationId: row.organizationId,
        customerPartyId: row.customerPartyId,
        submittedBy: row.submittedBy,
      }),
    );
    if (row.status !== 'verified') {
      throw conflict('payment_not_verified', `A ${row.status} payment cannot be allocated`);
    }
    return row;
  }

  private async creditItem(tx: DbTransaction, scope: TxScope, paymentId: string) {
    const [item] = await tx
      .select()
      .from(openItems)
      .where(
        and(
          eq(openItems.tenantId, scope.tenantId),
          eq(openItems.organizationId, scope.organizationId),
          eq(openItems.sourceType, 'payment'),
          eq(openItems.sourceId, paymentId),
        ),
      )
      .limit(1);
    if (item === undefined) throw new Error(`verified payment ${paymentId} has no open item`);
    return item;
  }

  private async openAmounts(
    tx: DbTransaction,
    scope: TxScope,
    ids: string[],
  ): Promise<Map<string, Decimal>> {
    const rows = await tx
      .select({ id: openItemBalances.openItemId, open: openItemBalances.openAmount })
      .from(openItemBalances)
      .where(
        and(
          eq(openItemBalances.tenantId, scope.tenantId),
          eq(openItemBalances.organizationId, scope.organizationId),
          inArray(openItemBalances.openItemId, ids),
        ),
      );
    return new Map(rows.map((r) => [r.id, new Decimal(r.open ?? '0')]));
  }

  private toDto(
    a: OpenItemAllocation,
    invoiceId: string,
    paymentId: string,
    createdBy: string,
  ): AllocationDto {
    return {
      id: a.id,
      invoiceId,
      paymentId,
      creditNoteId: null,
      amount: money2(a.amount),
      reversesAllocationId: a.reversesAllocationId,
      reason: a.reason,
      createdBy: a.createdBy ?? createdBy,
      createdAt: a.createdAt.toISOString(),
    };
  }

  private userOf(actor: Actor): string {
    if (actor.kind !== 'user') {
      throw new ForbiddenException({ code: 'forbidden', reason: 'no_permission' });
    }
    return actor.id;
  }
}
