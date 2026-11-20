// PaymentPromisesService: records a customer's promise to pay an issued invoice by a date (F1-Q33, decision D56).
// The hourly payment-promise job (payment-promise.sweeper.ts) later marks a promise whose day has passed with the
// invoice still open as missed and plans the collection call; this file only records. Serves the NFRs:
// - "authorization is deny-by-default": the route needs `payment.record` (Finance and the Accountant hold it, D56 says
//   they record promises), asserted again on the invoice's customer; another entity's invoice is a 404;
// - "a promise is about money owed": only an issued tax invoice or debit note with an open amount above zero takes
//   one (409 invoice_not_open otherwise), and the day is today or later in Asia/Kathmandu (400);
// - "one promise at a time": a second open promise on the same invoice is 409 promise_open (also held by the partial
//   unique index payment_promises_one_open_idx under concurrency);
// - "who did it": the recorder is the calling user; a system actor gets 403. Commands carry an Idempotency-Key.
import { type PaymentPromiseDto, type RecordPaymentPromiseBody } from '@bos/contracts';
import { invoices, openItemBalances, paymentPromises } from '@bos/db';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { and, eq, gt, sql } from 'drizzle-orm';

import { AuditService } from '../../../platform/audit/audit.service';
import { AuthzService } from '../../../platform/authz/authz.service';
import { DB, type Db, type DbTransaction } from '../../../platform/db/db.module';
import { withIdempotency } from '../../../platform/db/idempotency';
import { withTx, type Actor, type TxScope } from '../../../platform/db/tx';
import { kathmanduDay } from '../receivables.rules';
import { RECEIVABLES_CLOCK } from '../receivables.service';

/** Invoice kinds a customer owes money on: the ones a payment may settle (AllocationsService). */
export const PROMISABLE_KINDS = ['tax_invoice', 'debit_note'] as const;

type PromiseRow = typeof paymentPromises.$inferSelect;

const invoiceNotFound = () =>
  new NotFoundException({ code: 'not_found', message: 'Invoice not found' });

/** The DTO of a stored promise. */
export function toPaymentPromiseDto(row: PromiseRow): PaymentPromiseDto {
  return {
    id: row.id,
    invoiceId: row.invoiceId,
    promisedDate: row.promisedDate,
    note: row.note,
    status: row.status,
    recordedByUserId: row.recordedByUserId,
    missedAt: row.missedAt?.toISOString() ?? null,
    collectionActivityId: row.collectionActivityId,
    createdAt: row.createdAt.toISOString(),
  };
}

/** True for a Postgres unique violation on the one-open-promise index (a concurrent second promise). */
function isOneOpenViolation(error: unknown): boolean {
  const e = error as { code?: unknown; constraint?: unknown; cause?: unknown } | null;
  if (e?.code === '23505' && e.constraint === 'payment_promises_one_open_idx') return true;
  return e?.cause !== undefined && e.cause !== error && isOneOpenViolation(e.cause);
}

const promiseOpen = () =>
  new ConflictException({
    code: 'promise_open',
    message: 'This invoice already has an open promise to pay. Wait until its date has passed.',
  });

@Injectable()
export class PaymentPromisesService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly authz: AuthzService,
    private readonly audit: AuditService,
    @Optional()
    @Inject(RECEIVABLES_CLOCK)
    private readonly clock: () => Date = () => new Date(),
  ) {}

  /**
   * Records the promise and returns it (201). 404 for an invoice outside the acting entity; 409 invoice_not_open for
   * a draft, a proforma, a credit note or a settled invoice; 409 promise_open when one is already open; 400 for a
   * day before today (Kathmandu). A retry with the same key replays the stored promise, even after midnight.
   */
  async record(
    scope: TxScope,
    actor: Actor,
    invoiceId: string,
    body: RecordPaymentPromiseBody,
    idempotencyKey: string,
  ): Promise<PaymentPromiseDto> {
    if (actor.kind !== 'user') {
      throw new ForbiddenException({ code: 'forbidden', reason: 'no_permission' });
    }
    try {
      return await withTx(this.db, scope, actor, async (tx) => {
        const done = await withIdempotency(
          tx,
          // The id is part of the hashed body: one key cannot replay onto another invoice.
          { command: 'payment_promise.record', key: idempotencyKey, body: { invoiceId, ...body } },
          // The day is checked here, inside the command, so a retry of a committed promise after Kathmandu midnight
          // replays the stored answer instead of refusing a day that was valid when it was recorded.
          async () => {
            this.assertNotPast(body.promisedDate);
            return {
              status: 201,
              response: await this.recordInTx(tx, scope, actor.id, invoiceId, body),
            };
          },
        );
        return done.response;
      });
    } catch (error) {
      if (isOneOpenViolation(error)) throw promiseOpen();
      throw error;
    }
  }

  /** 400 for a promised day before today in Kathmandu. */
  private assertNotPast(promisedDate: string): void {
    const today = kathmanduDay(this.clock());
    if (promisedDate < today) {
      throw new BadRequestException({
        code: 'bad_request',
        message: 'The promised date cannot be before today.',
        details: { promisedDate, today },
      });
    }
  }

  private async recordInTx(
    tx: DbTransaction,
    scope: TxScope,
    userId: string,
    invoiceId: string,
    body: RecordPaymentPromiseBody,
  ): Promise<PaymentPromiseDto> {
    // Shared lock: an allocation or a credit note on this invoice waits, so the open amount read below holds.
    const [invoice] = await tx
      .select({
        id: invoices.id,
        kind: invoices.kind,
        status: invoices.status,
        number: invoices.number,
        customerPartyId: invoices.customerPartyId,
      })
      .from(invoices)
      .where(
        and(
          eq(invoices.tenantId, scope.tenantId),
          eq(invoices.organizationId, scope.organizationId),
          eq(invoices.id, invoiceId),
        ),
      )
      .limit(1)
      .for('share');
    if (invoice === undefined) throw invoiceNotFound();
    this.authz.assert('payment.record', {
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      customerPartyId: invoice.customerPartyId,
    });

    const [open] = await tx
      .select({ openAmount: openItemBalances.openAmount })
      .from(openItemBalances)
      .where(
        and(
          eq(openItemBalances.tenantId, scope.tenantId),
          eq(openItemBalances.organizationId, scope.organizationId),
          eq(openItemBalances.sourceId, invoice.id),
          sql`${openItemBalances.sourceType} = ${invoice.kind}`,
          eq(openItemBalances.side, 'receivable'),
          eq(openItemBalances.direction, 'debit'),
          gt(openItemBalances.openAmount, '0'),
        ),
      )
      .limit(1);
    const promisable =
      invoice.status === 'issued' &&
      (PROMISABLE_KINDS as readonly string[]).includes(invoice.kind) &&
      open !== undefined;
    if (!promisable) {
      throw new ConflictException({
        code: 'invoice_not_open',
        message:
          'Only an issued invoice or debit note with an amount still owed can take a promise to pay.',
      });
    }

    const [existing] = await tx
      .select({ id: paymentPromises.id })
      .from(paymentPromises)
      .where(
        and(
          eq(paymentPromises.tenantId, scope.tenantId),
          eq(paymentPromises.organizationId, scope.organizationId),
          eq(paymentPromises.invoiceId, invoice.id),
          eq(paymentPromises.status, 'open'),
        ),
      )
      .limit(1);
    if (existing !== undefined) throw promiseOpen();

    const [row] = await tx
      .insert(paymentPromises)
      .values({
        tenantId: scope.tenantId,
        organizationId: scope.organizationId,
        invoiceId: invoice.id,
        promisedDate: body.promisedDate,
        note: body.note ?? null,
        recordedByUserId: userId,
      })
      .returning();
    if (row === undefined) throw new Error('payment promise insert returned no row');
    await this.audit.record(tx, {
      action: 'payment_promise.recorded',
      entityType: 'payment_promises',
      entityId: row.id,
      after: { invoiceId: invoice.id, promisedDate: body.promisedDate },
    });
    return toPaymentPromiseDto(row);
  }
}
