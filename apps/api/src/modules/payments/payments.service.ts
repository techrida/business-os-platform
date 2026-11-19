// PaymentsService: customer receipts of P3 (unit U7; decisions A8, A9, A13, A15, D09). Serves the NFRs:
// - "paid is derived" (A8): verifying a payment opens one credit open item for `amount + tds` and allocates
//   nothing, so an invoice stays unpaid until U8 allocates;
// - "segregation of duties": the verifier is never the submitter (403 `self_verification`, and the DB CHECK
//   payments_verifier_check behind it);
// - "amounts are exact and traceable": the NPR snapshot is frozen at verify from a rate at most
//   `fx.max_rate_age_days` old on the verify day (409 `fx_rate_stale`), and the RCPT number is taken last;
// - "no double effects": every command runs in withTx -> withIdempotency, the ledger writes are idempotent per
//   source, and the status moves through a conditional (versioned) UPDATE.
// Money commands follow plan section 2: lock the payment, then open items in ascending id, number_series last.
// The subledger is written only through LedgerService; this file reads open_items / allocations, never writes them.
//
// Proofs: documents uploaded under owner type `payment_intake` (owner id = the customer) are linked to the payment
// at submit, in `payment_proofs`. Each must be clean, in this entity, for this customer, and not linked before.
import { createHash } from 'node:crypto';

import {
  type AllocationDto,
  type PaymentChannel,
  type PaymentDto,
  type PaymentListItem,
  type PaymentMethod,
  PAYMENT_STATUSES,
  type PaymentStatus,
  type RejectPaymentBody,
  type ReversePaymentBody,
  type SubmitPaymentBody,
  type VerifyPaymentBody,
  type WithdrawPaymentBody,
} from '@bos/contracts';
import {
  documents,
  documentVersions,
  openItemAllocations,
  openItemBalances,
  openItems,
  parties,
  paymentProofs,
  payments,
  withholdingCodes,
} from '@bos/db';
import { kathmanduDate } from '@bos/locale';
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
import { and, asc, count, desc, eq, inArray, isNull, lte, or, type SQL } from 'drizzle-orm';

import { AuditService } from '../../platform/audit/audit.service';
import { AuthzService } from '../../platform/authz/authz.service';
import { DB, type Db, type DbTransaction } from '../../platform/db/db.module';
import { updateVersioned, withIdempotency } from '../../platform/db/idempotency';
import { withTx, type Actor, type TxScope } from '../../platform/db/tx';
import { CurrencyEnabledService } from '../../platform/settings/currency-enabled';
import { NO_LIMIT, searchPage } from '../../platform/list';
import { MoneyService } from '../../platform/settings/money.service';
import { NumberingService } from '../../platform/settings/numbering.service';
import { LedgerService } from '../ledger/ledger.service';
import { PAYMENT_INTAKE_OWNER_TYPE, paymentRef } from './payment-owner.policy';

/** Injection token for a test clock; production falls back to the system time. */
export const PAYMENTS_CLOCK = Symbol('PAYMENTS_CLOCK');

export const RECEIPT_SERIES = 'RCPT';
const AUDIT_ENTITY = 'payments';

type PaymentRow = typeof payments.$inferSelect;

/** Every field narrows; an empty or missing list means no filter. `limit` unset returns every match. */
export interface PaymentListFilter {
  status?: readonly PaymentStatus[] | undefined;
  method?: readonly PaymentMethod[] | undefined;
  q?: string | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
}

export interface PaymentsSummary {
  total: number;
  byStatus: Record<PaymentStatus, number>;
}

const SEARCH_COLUMNS = [payments.number, parties.name, payments.bankReference] as const;

const customerJoin = () =>
  and(eq(parties.tenantId, payments.tenantId), eq(parties.id, payments.customerPartyId));

const notFound = () => new NotFoundException({ code: 'not_found', message: 'Payment not found' });
const conflict = (code: string, message: string) => new ConflictException({ code, message });
const unprocessable = (code: string, message: string) =>
  new UnprocessableEntityException({ code, message });
const staleVersion = () =>
  conflict('conflict', 'This payment was changed by someone else; reload it and try again');

/** `YYYY-MM-DD` of the Kathmandu day containing `at`. */
function kathmanduDay(at: Date): string {
  const { y, m, d } = kathmanduDate(at);
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/**
 * The source id of the debit item that undoes a payment's credit item on reversal. open_items is unique per
 * (source_type, source_id), so it cannot reuse the payment id; a name-based (v5-style) uuid of the payment id keeps
 * the reversal item findable and idempotent without a new source type.
 */
export function reversalSourceId(paymentId: string): string {
  const hex = createHash('sha1')
    .update(`payment_reversal:${paymentId.toLowerCase()}`)
    .digest('hex');
  const variant = ((parseInt(hex.slice(16, 18), 16) & 0x3f) | 0x80).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(18, 20)}-${hex.slice(20, 32)}`;
}

function money2(value: string | Decimal): string {
  return new Decimal(value).toFixed(2);
}

@Injectable()
export class PaymentsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly authz: AuthzService,
    private readonly money: MoneyService,
    private readonly numbering: NumberingService,
    private readonly audit: AuditService,
    private readonly ledger: LedgerService,
    private readonly currencies: CurrencyEnabledService,
    @Optional()
    @Inject(PAYMENTS_CLOCK)
    private readonly clock: () => Date = () => new Date(),
  ) {}

  // ------------------------------------------------------------------------------------------ reads

  /**
   * One page of the acting entity's payments, newest first (id breaks ties), and the number of all matches.
   * The entity is part of every query, so a filter can only narrow it.
   */
  async list(
    scope: TxScope,
    filter: PaymentListFilter = {},
  ): Promise<{ rows: PaymentListItem[]; total: number }> {
    this.authz.assert('payment.read', {
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
    });
    const { rows, total } = await searchPage(this.db, {
      q: filter.q,
      columns: SEARCH_COLUMNS,
      where: this.listWhere(scope, filter, true),
      orderBy: [desc(payments.createdAt), desc(payments.id)],
      limit: filter.limit ?? NO_LIMIT,
      offset: filter.offset ?? 0,
      rows: (r, p) =>
        r
          .select({
            p: payments,
            customerName: parties.name,
            openAmount: openItemBalances.openAmount,
          })
          .from(payments)
          .innerJoin(parties, customerJoin())
          .leftJoin(
            openItemBalances,
            and(
              eq(openItemBalances.tenantId, payments.tenantId),
              eq(openItemBalances.organizationId, payments.organizationId),
              eq(openItemBalances.sourceType, 'payment'),
              eq(openItemBalances.sourceId, payments.id),
            ),
          )
          .where(p.where)
          .orderBy(...p.orderBy)
          .limit(p.limit)
          .offset(p.offset),
      count: async (r, where) => {
        const [row] = await r
          .select({ n: count() })
          .from(payments)
          .innerJoin(parties, customerJoin())
          .where(where);
        return row?.n ?? 0;
      },
    });
    return {
      total,
      rows: rows.map(({ p, customerName, openAmount }) => ({
        id: p.id,
        customerId: p.customerPartyId ?? '',
        customerName,
        status: p.status,
        number: p.number,
        method: p.method,
        currency: p.currency,
        amount: money2(p.amount),
        receivedOn: p.receivedOn,
        unallocatedAmount: money2(openAmount ?? '0'),
      })),
    };
  }

  /**
   * How many payments match `q` and `method` (not `status`), in total and per status, so the stat cards stay right
   * when the list is paged. Same entity and search as `list`.
   */
  async summary(
    scope: TxScope,
    filter: Pick<PaymentListFilter, 'q' | 'method'> = {},
  ): Promise<PaymentsSummary> {
    this.authz.assert('payment.read', {
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
    });
    // searchPage settles exact vs close matches from the total; the per-status counts ride on its count
    // callback so they describe the same match set. Its last call is the one it settled on.
    let groups: { status: PaymentStatus; n: number }[] = [];
    const { total } = await searchPage(this.db, {
      q: filter.q,
      columns: SEARCH_COLUMNS,
      where: this.listWhere(scope, filter, false),
      orderBy: [desc(payments.id)],
      limit: 1,
      offset: 0,
      rows: () => Promise.resolve([]),
      count: async (r, where) => {
        groups = await r
          .select({ status: payments.status, n: count() })
          .from(payments)
          .innerJoin(parties, customerJoin())
          .where(where)
          .groupBy(payments.status);
        return groups.reduce((sum, g) => sum + g.n, 0);
      },
    });
    const byStatus = Object.fromEntries(PAYMENT_STATUSES.map((st) => [st, 0])) as Record<
      PaymentStatus,
      number
    >;
    for (const g of groups) byStatus[g.status] = g.n;
    return { total, byStatus };
  }

  /** The entity first, then the filters; a filter only ever narrows what the entity allows. */
  private listWhere(
    scope: TxScope,
    filter: PaymentListFilter,
    withStatus: boolean,
  ): SQL | undefined {
    return and(
      eq(payments.tenantId, scope.tenantId),
      eq(payments.organizationId, scope.organizationId),
      withStatus && filter.status !== undefined && filter.status.length > 0
        ? inArray(payments.status, [...filter.status])
        : undefined,
      filter.method !== undefined && filter.method.length > 0
        ? inArray(payments.method, [...filter.method])
        : undefined,
    );
  }

  /** One payment of the acting entity; 404 for another entity's or an unknown id. */
  async get(scope: TxScope, paymentId: string): Promise<PaymentDto> {
    return withTx(this.db, scope, this.readActor(), async (tx) => {
      const row = await this.load(tx, scope, paymentId);
      this.authz.assert('payment.read', paymentRef(this.head(row)));
      return this.toDto(tx, scope, row);
    });
  }

  /**
   * The allocation rows of the payment's credit item against invoices and debit notes, reversals included, oldest
   * first. Empty before the payment is verified. The auto-allocation of a reversal is not an invoice allocation and
   * is left out.
   */
  async allocations(scope: TxScope, paymentId: string): Promise<AllocationDto[]> {
    return withTx(this.db, scope, this.readActor(), async (tx) => {
      const row = await this.load(tx, scope, paymentId);
      this.authz.assert('payment.read', paymentRef(this.head(row)));
      const credit = await this.creditItem(tx, scope, paymentId);
      if (credit === undefined) return [];
      const rows = await tx
        .select({ a: openItemAllocations, debitSource: openItems.sourceId })
        .from(openItemAllocations)
        .innerJoin(
          openItems,
          and(
            eq(openItems.tenantId, openItemAllocations.tenantId),
            eq(openItems.id, openItemAllocations.debitItemId),
          ),
        )
        .where(
          and(
            eq(openItemAllocations.tenantId, scope.tenantId),
            eq(openItemAllocations.organizationId, scope.organizationId),
            eq(openItemAllocations.creditItemId, credit.id),
            inArray(openItems.sourceType, ['tax_invoice', 'debit_note']),
          ),
        )
        .orderBy(asc(openItemAllocations.createdAt), asc(openItemAllocations.id));
      return rows.map(({ a, debitSource }) => ({
        id: a.id,
        invoiceId: debitSource,
        paymentId,
        creditNoteId: null,
        amount: money2(a.amount),
        reversesAllocationId: a.reversesAllocationId,
        reason: a.reason,
        createdBy: a.createdBy ?? '',
        createdAt: a.createdAt.toISOString(),
      }));
    });
  }

  // --------------------------------------------------------------------------------------- commands

  /**
   * Records a payment the customer says it sent (status submitted). Staff call it with `channel: 'staff'` and need
   * `payment.record`; the portal (U13) calls it with `channel: 'portal'` and `body.customerId` set to the
   * principal's party, and needs `portal.payment.submit` on that customer. 422 for an unknown customer, withholding
   * code or proof document, and 422 CURRENCY_NOT_ENABLED for a currency the company switched off (D44).
   */
  async submit(
    scope: TxScope,
    actor: Actor,
    body: SubmitPaymentBody,
    channel: PaymentChannel,
    idempotencyKey: string,
  ): Promise<PaymentDto> {
    this.assertMaySubmit(scope, body, channel);
    // 422 CURRENCY_NOT_ENABLED for a currency the company switched off (D44). A pool read, so it runs before the
    // transaction opens. Staff and portal submits both come through here.
    await this.currencies.assertEnabled(scope, body.currency);
    return withTx(this.db, scope, actor, async (tx) => {
      const done = await withIdempotency(
        tx,
        { command: `payment.submit.${channel}`, key: idempotencyKey, body },
        async () => ({
          status: 201,
          response: await this.submitInTx(tx, scope, actor, body, channel),
        }),
      );
      return done.response;
    });
  }

  /**
   * `submit` inside a caller's transaction (opened with withTx), for a caller with its own idempotency. It does not
   * check that the currency is enabled (a pool read does not belong inside the transaction): a caller must call
   * CurrencyEnabledService.assertEnabled first, as `submit` does.
   */
  async submitInTx(
    tx: DbTransaction,
    scope: TxScope,
    actor: Actor,
    body: SubmitPaymentBody,
    channel: PaymentChannel,
  ): Promise<PaymentDto> {
    const userId = this.userOf(actor);
    this.assertMaySubmit(scope, body, channel);
    const [customer] = await tx
      .select({ id: parties.id })
      .from(parties)
      .where(
        and(
          eq(parties.tenantId, scope.tenantId),
          eq(parties.id, body.customerId),
          eq(parties.kind, 'customer'),
        ),
      )
      .limit(1);
    if (customer === undefined) throw unprocessable('unknown_customer', 'No such customer');

    const now = this.clock();
    const withholdingCodeId =
      body.withholdingCode === undefined
        ? null
        : await this.withholdingCodeId(tx, scope, body.withholdingCode, kathmanduDay(now));
    await this.assertIntakeProofs(tx, scope, body.customerId, body.proofDocumentIds);

    const [row] = await tx
      .insert(payments)
      .values({
        tenantId: scope.tenantId,
        organizationId: scope.organizationId,
        customerPartyId: body.customerId,
        method: body.method,
        currency: body.currency,
        amount: money2(body.amount),
        tdsWithheld: money2(body.tdsWithheld),
        withholdingCodeId,
        receivedOn: body.receivedOn,
        bankReference: body.bankReference ?? null,
        submittedBy: userId,
        channel,
      })
      .returning();
    if (row === undefined) throw new Error('payment insert returned no row');
    await tx.insert(paymentProofs).values(
      [...new Set(body.proofDocumentIds)].map((documentId) => ({
        tenantId: scope.tenantId,
        organizationId: scope.organizationId,
        paymentId: row.id,
        documentId,
        createdBy: userId,
      })),
    );
    await this.audit.record(tx, {
      action: 'payment.submitted',
      entityType: AUDIT_ENTITY,
      entityId: row.id,
      after: { status: row.status, amount: row.amount, currency: row.currency, channel },
    });
    return this.toDto(tx, scope, row);
  }

  /**
   * Finance verifies a submitted payment: freezes the NPR snapshot, opens the credit item for `amount + tds`,
   * records `payment_verified` and takes the RCPT number, in one transaction. 403 `self_verification` for the
   * submitter, 409 `fx_rate_stale`, 409 `payment_not_submitted`, 409 `proof_not_clean`, 409 `conflict` for a stale
   * expectedVersion.
   */
  async verify(
    scope: TxScope,
    actor: Actor,
    paymentId: string,
    body: VerifyPaymentBody,
    idempotencyKey: string,
  ): Promise<PaymentDto> {
    return this.command(scope, actor, 'payment.verify', paymentId, body, idempotencyKey, (tx) =>
      this.verifyInTx(tx, scope, actor, paymentId, body),
    );
  }

  async reject(
    scope: TxScope,
    actor: Actor,
    paymentId: string,
    body: RejectPaymentBody,
    idempotencyKey: string,
  ): Promise<PaymentDto> {
    return this.command(scope, actor, 'payment.reject', paymentId, body, idempotencyKey, (tx) =>
      this.decideInTx(tx, scope, actor, paymentId, body.expectedVersion, (row) => {
        this.authz.assert('payment.verify', paymentRef(this.head(row)));
        const reason = body.reason.trim();
        if (reason === '') throw unprocessable('reason_required', 'A rejection needs a reason');
        return { status: 'rejected' as const, rejectionReason: reason };
      }),
    );
  }

  /** The submitter takes back its own submitted payment (staff here, the customer through U13). */
  async withdraw(
    scope: TxScope,
    actor: Actor,
    paymentId: string,
    body: WithdrawPaymentBody,
    idempotencyKey: string,
  ): Promise<PaymentDto> {
    return this.command(scope, actor, 'payment.withdraw', paymentId, body, idempotencyKey, (tx) =>
      this.decideInTx(tx, scope, actor, paymentId, body.expectedVersion, (row) => {
        if (actor.kind !== 'user' || actor.id !== row.submittedBy) {
          throw new ForbiddenException({
            code: 'forbidden',
            reason: 'no_permission',
            message: 'Only the person who submitted a payment may withdraw it',
          });
        }
        return { status: 'withdrawn' as const };
      }),
    );
  }

  /**
   * A verified payment bounced or was wrong: every live allocation of its credit item is reversed, then a debit
   * reversal item for the same amount is opened and allocated against the credit item, so both net to zero and the
   * invoices are open again. Records `payment_reversed`. The reason goes to the ledger rows, the event and the
   * audit trail: payments_guard freezes every payment column except status once verified.
   */
  async reverseVerified(
    scope: TxScope,
    actor: Actor,
    paymentId: string,
    body: ReversePaymentBody,
    idempotencyKey: string,
  ): Promise<PaymentDto> {
    return this.command(scope, actor, 'payment.reverse', paymentId, body, idempotencyKey, (tx) =>
      this.reverseInTx(tx, scope, actor, paymentId, body),
    );
  }

  // -------------------------------------------------------------------------------------- internals

  private async command<B extends object>(
    scope: TxScope,
    actor: Actor,
    command: string,
    paymentId: string,
    body: B,
    idempotencyKey: string,
    run: (tx: DbTransaction) => Promise<PaymentDto>,
  ): Promise<PaymentDto> {
    return withTx(this.db, scope, actor, async (tx) => {
      const done = await withIdempotency(
        tx,
        // The id is part of the hashed body: one key cannot replay onto another payment.
        { command, key: idempotencyKey, body: { paymentId, ...body } },
        async () => ({ status: 200, response: await run(tx) }),
      );
      return done.response;
    });
  }

  private async verifyInTx(
    tx: DbTransaction,
    scope: TxScope,
    actor: Actor,
    paymentId: string,
    body: VerifyPaymentBody,
  ): Promise<PaymentDto> {
    const row = await this.lockPayment(tx, scope, paymentId);
    this.authz.assert('payment.verify', paymentRef(this.head(row)));
    if (row.status !== 'submitted') {
      throw conflict('payment_not_submitted', `A ${row.status} payment cannot be verified`);
    }
    if (row.version !== body.expectedVersion) throw staleVersion();
    const verifier = this.userOf(actor);
    if (verifier === row.submittedBy) {
      throw new ForbiddenException({
        code: 'self_verification',
        reason: 'separation_of_duties',
        message: 'The person who recorded a payment cannot verify it',
      });
    }
    await this.assertProofsClean(tx, scope, paymentId);

    const now = this.clock();
    const snapshot = await this.money.toNprSnapshot(
      tx,
      scope,
      { currency: row.currency, amount: money2(row.amount) },
      now,
    );
    const tdsNpr = new Decimal(row.tdsWithheld).times(snapshot.rate).toDecimalPlaces(2);
    const settles = new Decimal(row.amount).plus(row.tdsWithheld);
    const settlesNpr = new Decimal(snapshot.amountNpr).plus(tdsNpr);
    const npr = row.currency === 'NPR';

    const { item } = await this.ledger.openItem(tx, scope, actor, {
      side: 'receivable',
      direction: 'credit',
      partyId: row.customerPartyId ?? '',
      sourceType: 'payment',
      sourceId: row.id,
      currency: row.currency,
      amount: money2(settles),
      amountNpr: money2(settlesNpr),
      fxRate: snapshot.rate,
      fxSource: npr ? null : snapshot.rateSource,
      fxDate: npr ? null : snapshot.rateDate,
      documentDate: row.receivedOn,
    });
    await this.ledger.recordEvent(tx, scope, actor, {
      sourceType: 'payment',
      sourceId: row.id,
      event: 'payment_verified',
      payload: {
        openItemId: item.id,
        currency: row.currency,
        amount: money2(row.amount),
        tdsWithheld: money2(row.tdsWithheld),
        settles: money2(settles),
        settlesNpr: money2(settlesNpr),
        fxRate: snapshot.rate,
      },
    });
    // The last row lock of the command (plan section 2).
    const receipt = await this.numbering.issue(tx, RECEIPT_SERIES, now);
    const updated = await updateVersioned(tx, payments, row.id, body.expectedVersion, {
      status: 'verified',
      verifiedBy: verifier,
      verifiedAt: now,
      fxRate: snapshot.rate,
      fxSource: snapshot.rateSource,
      fxDate: snapshot.rateDate,
      amountNpr: snapshot.amountNpr,
      tdsNpr: money2(tdsNpr),
      number: receipt.number,
      seq: receipt.seq,
      fiscalYear: receipt.fiscalYear,
      updatedAt: now,
    });
    await this.audit.record(tx, {
      action: 'payment.verified',
      entityType: AUDIT_ENTITY,
      entityId: row.id,
      before: { status: row.status },
      after: { status: updated.status, number: updated.number, openItemId: item.id },
    });
    return this.toDto(tx, scope, updated);
  }

  /** Reject or withdraw: a submitted payment moves to a terminal status through a versioned UPDATE. */
  private async decideInTx(
    tx: DbTransaction,
    scope: TxScope,
    _actor: Actor,
    paymentId: string,
    expectedVersion: number,
    decide: (row: PaymentRow) => { status: 'rejected' | 'withdrawn'; rejectionReason?: string },
  ): Promise<PaymentDto> {
    const row = await this.lockPayment(tx, scope, paymentId);
    const change = decide(row);
    if (row.status !== 'submitted') {
      throw conflict('payment_not_submitted', `A ${row.status} payment cannot be ${change.status}`);
    }
    if (row.version !== expectedVersion) throw staleVersion();
    const updated = await updateVersioned(tx, payments, row.id, expectedVersion, {
      ...change,
      updatedAt: this.clock(),
    });
    await this.audit.record(tx, {
      action: `payment.${change.status}`,
      entityType: AUDIT_ENTITY,
      entityId: row.id,
      before: { status: row.status },
      after: { status: updated.status, rejectionReason: updated.rejectionReason },
    });
    return this.toDto(tx, scope, updated);
  }

  private async reverseInTx(
    tx: DbTransaction,
    scope: TxScope,
    actor: Actor,
    paymentId: string,
    body: ReversePaymentBody,
  ): Promise<PaymentDto> {
    const row = await this.lockPayment(tx, scope, paymentId);
    this.authz.assert('payment.verify', paymentRef(this.head(row)));
    if (row.status !== 'verified') {
      throw conflict('payment_not_verified', `A ${row.status} payment cannot be reversed`);
    }
    if (row.version !== body.expectedVersion) throw staleVersion();
    const reason = body.reason.trim();
    if (reason === '') throw unprocessable('reason_required', 'A reversal needs a reason');
    const credit = await this.creditItem(tx, scope, paymentId);
    if (credit === undefined) throw new Error(`verified payment ${paymentId} has no open item`);

    // Every forward allocation of the credit item that has no reversal yet.
    const forward = await tx
      .select()
      .from(openItemAllocations)
      .where(
        and(
          eq(openItemAllocations.tenantId, scope.tenantId),
          eq(openItemAllocations.organizationId, scope.organizationId),
          eq(openItemAllocations.creditItemId, credit.id),
          isNull(openItemAllocations.reversesAllocationId),
        ),
      )
      .orderBy(asc(openItemAllocations.id));
    const reversed = await tx
      .select({ id: openItemAllocations.reversesAllocationId })
      .from(openItemAllocations)
      .where(
        and(
          eq(openItemAllocations.tenantId, scope.tenantId),
          eq(openItemAllocations.organizationId, scope.organizationId),
          eq(openItemAllocations.creditItemId, credit.id),
        ),
      );
    const alreadyReversed = new Set(reversed.map((r) => r.id).filter((id) => id !== null));
    const live = forward.filter((a) => !alreadyReversed.has(a.id));

    // Payment (above), then every open item involved in one ascending step, before any ledger call locks per pair.
    await this.ledger.lockForMoneyCommand(tx, scope, [
      { rank: 'open_item', ids: [credit.id, ...live.map((a) => a.debitItemId)] },
    ]);
    const reversals: string[] = [];
    for (const allocation of live) {
      const { allocation: reversal } = await this.ledger.reverseAllocation(tx, scope, actor, {
        allocationId: allocation.id,
        reason,
      });
      reversals.push(reversal.id);
    }

    const now = this.clock();
    const { item: debit } = await this.ledger.openItem(tx, scope, actor, {
      side: 'receivable',
      direction: 'debit',
      partyId: row.customerPartyId ?? '',
      sourceType: 'payment',
      sourceId: reversalSourceId(row.id),
      currency: credit.currency,
      amount: money2(credit.amount),
      amountNpr: money2(credit.amountNpr),
      fxRate: credit.fxRate,
      fxSource: credit.fxSource,
      fxDate: credit.fxDate,
      documentDate: kathmanduDay(now),
    });
    const offset = await this.ledger.allocate(tx, scope, actor, {
      debitItemId: debit.id,
      creditItemId: credit.id,
      amount: money2(credit.amount),
    });
    await this.ledger.recordEvent(tx, scope, actor, {
      sourceType: 'payment',
      sourceId: row.id,
      event: 'payment_reversed',
      payload: {
        reason,
        creditItemId: credit.id,
        reversalItemId: debit.id,
        offsetAllocationId: offset.id,
        reversedAllocationIds: reversals,
        amount: money2(credit.amount),
        currency: credit.currency,
      },
    });
    const updated = await updateVersioned(tx, payments, row.id, body.expectedVersion, {
      status: 'reversed',
      updatedAt: now,
    });
    await this.audit.record(tx, {
      action: 'payment.reversed',
      entityType: AUDIT_ENTITY,
      entityId: row.id,
      before: { status: row.status },
      after: { status: updated.status },
      meta: { reason, reversedAllocationIds: reversals },
    });
    return this.toDto(tx, scope, updated);
  }

  /** 403 unless the caller may record (staff) or submit (portal) a payment for `body.customerId`. */
  private assertMaySubmit(scope: TxScope, body: SubmitPaymentBody, channel: PaymentChannel): void {
    this.authz.assert(channel === 'staff' ? 'payment.record' : 'portal.payment.submit', {
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      customerPartyId: body.customerId,
      sodUserIds: [],
    });
  }

  /** A system read actor for read-only transactions (withTx needs one; nothing is written). */
  private readActor(): Actor {
    return { kind: 'system', id: 'system:payments-read', correlationId: 'payments-read' };
  }

  private userOf(actor: Actor): string {
    if (actor.kind !== 'user') {
      throw new ForbiddenException({ code: 'forbidden', reason: 'no_permission' });
    }
    return actor.id;
  }

  private head(row: PaymentRow) {
    return {
      tenantId: row.tenantId,
      organizationId: row.organizationId,
      customerPartyId: row.customerPartyId,
      submittedBy: row.submittedBy,
    };
  }

  private async load(tx: DbTransaction, scope: TxScope, paymentId: string): Promise<PaymentRow> {
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
    if (row === undefined) throw notFound();
    return row;
  }

  /** The payment row lock (lock order rank `payment`), then the row as locked. 404 outside the entity. */
  private async lockPayment(
    tx: DbTransaction,
    scope: TxScope,
    paymentId: string,
  ): Promise<PaymentRow> {
    const locked = await this.ledger.lockForMoneyCommand(tx, scope, [
      { rank: 'payment', ids: [paymentId], table: payments },
    ]);
    if ((locked.payment ?? []).length === 0) throw notFound();
    return this.load(tx, scope, paymentId);
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
    return item;
  }

  private async withholdingCodeId(
    tx: DbTransaction,
    scope: TxScope,
    code: string,
    day: string,
  ): Promise<string> {
    const [row] = await tx
      .select({ id: withholdingCodes.id })
      .from(withholdingCodes)
      .where(
        and(
          eq(withholdingCodes.tenantId, scope.tenantId),
          eq(withholdingCodes.code, code),
          or(eq(withholdingCodes.appliesTo, 'receivable'), eq(withholdingCodes.appliesTo, 'both')),
          lte(withholdingCodes.effectiveFrom, day),
        ),
      )
      .orderBy(desc(withholdingCodes.effectiveFrom))
      .limit(1);
    if (row === undefined) {
      throw unprocessable('unknown_withholding_code', `No receivable withholding code ${code}`);
    }
    return row.id;
  }

  /**
   * Each proof is a live document of this entity uploaded for this customer (owner `payment_intake`), its newest
   * non-rejected version is clean, and no payment links it yet. Any failure is one 422 that does not say which
   * rule failed, so another customer's document ids leak nothing.
   */
  private async assertIntakeProofs(
    tx: DbTransaction,
    scope: TxScope,
    customerId: string,
    documentIds: readonly string[],
  ): Promise<void> {
    const ids = [...new Set(documentIds)];
    const refuse = () =>
      unprocessable(
        'invalid_proof',
        'Every proof must be a clean file uploaded for this customer and not used by another payment',
      );
    const docs = await tx
      .select({ id: documents.id })
      .from(documents)
      .where(
        and(
          eq(documents.tenantId, scope.tenantId),
          eq(documents.organizationId, scope.organizationId),
          inArray(documents.id, ids),
          eq(documents.ownerType, PAYMENT_INTAKE_OWNER_TYPE),
          eq(documents.ownerId, customerId),
          isNull(documents.removedAt),
        ),
      );
    if (docs.length !== ids.length) throw refuse();
    const linked = await tx
      .select({ id: paymentProofs.documentId })
      .from(paymentProofs)
      .where(
        and(
          eq(paymentProofs.tenantId, scope.tenantId),
          eq(paymentProofs.organizationId, scope.organizationId),
          inArray(paymentProofs.documentId, ids),
        ),
      )
      .limit(1);
    if (linked.length > 0) throw refuse();
    if (!(await this.allClean(tx, scope, ids))) throw refuse();
  }

  /** 409 `proof_not_clean` unless every proof of the payment is clean (re-checked at verify). */
  private async assertProofsClean(
    tx: DbTransaction,
    scope: TxScope,
    paymentId: string,
  ): Promise<void> {
    const ids = await this.proofIds(tx, scope, paymentId);
    if (ids.length === 0 || !(await this.allClean(tx, scope, ids))) {
      throw conflict('proof_not_clean', 'Every proof must pass the virus scan before verifying');
    }
  }

  /** For each document, the newest version that was not rejected must be clean (DocumentsService.allClean's rule). */
  private async allClean(
    tx: DbTransaction,
    scope: TxScope,
    documentIds: readonly string[],
  ): Promise<boolean> {
    const versions = await tx
      .select({
        documentId: documentVersions.documentId,
        version: documentVersions.version,
        status: documentVersions.status,
      })
      .from(documentVersions)
      .where(
        and(
          eq(documentVersions.tenantId, scope.tenantId),
          eq(documentVersions.organizationId, scope.organizationId),
          inArray(documentVersions.documentId, [...documentIds]),
        ),
      );
    const latest = new Map<string, { version: number; status: string }>();
    for (const v of versions) {
      if (v.status === 'rejected') continue;
      const seen = latest.get(v.documentId);
      if (seen === undefined || v.version > seen.version) latest.set(v.documentId, v);
    }
    return documentIds.every((id) => latest.get(id)?.status === 'clean');
  }

  private async proofIds(tx: DbTransaction, scope: TxScope, paymentId: string): Promise<string[]> {
    const rows = await tx
      .select({ id: paymentProofs.documentId })
      .from(paymentProofs)
      .where(
        and(
          eq(paymentProofs.tenantId, scope.tenantId),
          eq(paymentProofs.organizationId, scope.organizationId),
          eq(paymentProofs.paymentId, paymentId),
        ),
      )
      .orderBy(asc(paymentProofs.createdAt), asc(paymentProofs.documentId));
    return rows.map((r) => r.id);
  }

  private async toDto(tx: DbTransaction, scope: TxScope, row: PaymentRow): Promise<PaymentDto> {
    const [code] =
      row.withholdingCodeId === null
        ? []
        : await tx
            .select({ code: withholdingCodes.code })
            .from(withholdingCodes)
            .where(
              and(
                eq(withholdingCodes.tenantId, scope.tenantId),
                eq(withholdingCodes.id, row.withholdingCodeId),
              ),
            );
    const credit = await this.creditItem(tx, scope, row.id);
    const open =
      credit === undefined
        ? undefined
        : (await this.ledger.openAmounts(tx, scope, [credit.id])).get(credit.id);
    const snapshot =
      row.fxRate === null || row.amountNpr === null
        ? null
        : {
            amountNpr: money2(row.amountNpr),
            rate: new Decimal(row.fxRate).toFixed(),
            rateSource: row.fxSource ?? row.currency,
            rateDate:
              row.fxDate ?? (row.verifiedAt ? kathmanduDay(row.verifiedAt) : row.receivedOn),
          };
    return {
      id: row.id,
      customerId: row.customerPartyId ?? '',
      status: row.status,
      method: row.method,
      currency: row.currency,
      amount: money2(row.amount),
      tdsWithheld: money2(row.tdsWithheld),
      withholdingCode: code?.code ?? null,
      settles: money2(new Decimal(row.amount).plus(row.tdsWithheld)),
      receivedOn: row.receivedOn,
      bankReference: row.bankReference,
      npr: snapshot,
      submittedBy: row.submittedBy,
      submittedVia: row.channel,
      verifiedBy: row.verifiedBy,
      verifiedAt: row.verifiedAt?.toISOString() ?? null,
      rejectionReason: row.rejectionReason,
      number: row.number,
      fiscalYear: row.fiscalYear,
      proofDocumentIds: await this.proofIds(tx, scope, row.id),
      unallocatedAmount: money2(open ?? '0'),
      version: row.version,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}
