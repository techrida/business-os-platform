// PaymentPromisesService: records a customer's promise to pay an issued invoice by a date (F1-Q33, decision D56) and
// lists an invoice's promises. The hourly payment-promise job (payment-promise.sweeper.ts) later marks a promise whose
// day has passed with the invoice still open as missed and plans the collection call. Serves the NFRs:
// - "authorization is deny-by-default": the route needs `payment.record` (Finance and the Accountant hold it, D56 says
//   they record promises), asserted again on the invoice's customer; another entity's invoice is a 404;
// - "a promise is about money owed": only an issued tax invoice or debit note with an open amount above zero takes
//   one (409 invoice_not_open otherwise), and the day is today or later in Asia/Kathmandu (400);
// - "one promise at a time": a new promise replaces the open one (decision R4c1 Q6): the old one becomes `replaced`,
//   audited, in the same transaction. The partial unique index payment_promises_one_open_idx still holds under
//   concurrency: of two promises recorded at once, the second is 409 promise_open;
// - "the screen shows what the caller may do": the list carries `can.record` with the reason it is false;
// - "who did it": the recorder is the calling user; a system actor gets 403. Commands carry an Idempotency-Key.
import {
  type PaymentPromiseDto,
  type PaymentPromiseList,
  type PaymentPromiseRecordBlock,
  type RecordPaymentPromiseBody,
} from '@bos/contracts';
import { invoices, openItemBalances, paymentPromises, users } from '@bos/db';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { and, desc, eq, gt, sql } from 'drizzle-orm';

import { AuditService } from '../../../platform/audit/audit.service';
import { AuthzService } from '../../../platform/authz/authz.service';
import { DB, type Db, type DbTransaction } from '../../../platform/db/db.module';
import { withIdempotency } from '../../../platform/db/idempotency';
import { READ_ONLY, withTx, type Actor, type TxScope } from '../../../platform/db/tx';
import { kathmanduDay } from '../receivables.rules';
import { RECEIVABLES_CLOCK } from '../receivables.service';

/** Invoice kinds a customer owes money on: the ones a payment may settle (AllocationsService). */
export const PROMISABLE_KINDS = ['tax_invoice', 'debit_note'] as const;

type PromiseRow = typeof paymentPromises.$inferSelect;

/** The invoice fields the promise rules read. */
interface PromiseInvoice {
  id: string;
  kind: string;
  status: string;
  customerPartyId: string | null;
}

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
    message:
      'Another promise to pay was recorded on this invoice at the same time. Reload to see it.',
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
   * Records the promise and returns it (201); an open promise on the invoice becomes `replaced`. 404 for an invoice
   * outside the acting entity; 409 invoice_not_open for a draft, a proforma, a credit note or a settled invoice; 409
   * promise_open when another promise was recorded concurrently; 400 for a day before today (Kathmandu). A retry with
   * the same key replays the stored promise, even after midnight, and replaces nothing more.
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

  /**
   * Every promise on the invoice, newest first, with `can.record`. Needs `ar.read` on the invoice's customer (the
   * route checks it too); 404 for an invoice outside the acting entity. Read-only.
   */
  async list(scope: TxScope, actor: Actor, invoiceId: string): Promise<PaymentPromiseList> {
    return withTx(
      this.db,
      scope,
      actor,
      async (tx) => {
        const [invoice] = await tx
          .select({
            id: invoices.id,
            kind: invoices.kind,
            status: invoices.status,
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
          .limit(1);
        if (invoice === undefined) throw invoiceNotFound();
        this.authz.assert('ar.read', this.customerRef(scope, invoice));

        const rows = await tx
          .select({ promise: paymentPromises, recordedByName: users.displayName })
          .from(paymentPromises)
          .leftJoin(
            users,
            and(
              eq(users.tenantId, paymentPromises.tenantId),
              eq(users.id, paymentPromises.recordedByUserId),
            ),
          )
          .where(
            and(
              eq(paymentPromises.tenantId, scope.tenantId),
              eq(paymentPromises.organizationId, scope.organizationId),
              eq(paymentPromises.invoiceId, invoice.id),
            ),
          )
          .orderBy(desc(paymentPromises.createdAt), desc(paymentPromises.id));

        let reason: PaymentPromiseRecordBlock | null = null;
        if (!this.allowed('payment.record', scope, invoice)) reason = 'no_permission';
        else if (!(await this.promisable(tx, scope, invoice))) reason = 'invoice_not_open';
        return {
          items: rows.map((r) => ({
            ...toPaymentPromiseDto(r.promise),
            recordedByName: r.recordedByName ?? null,
            updatedAt: r.promise.updatedAt.toISOString(),
          })),
          can: { record: reason === null, reason },
        };
      },
      READ_ONLY,
    );
  }

  /** The resource the receivables permissions judge: the invoice's customer in the acting entity. */
  private customerRef(scope: TxScope, invoice: Pick<PromiseInvoice, 'customerPartyId'>) {
    return {
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      ...(invoice.customerPartyId === null ? {} : { customerPartyId: invoice.customerPartyId }),
    };
  }

  /**
   * Whether the caller may `action` on the invoice's customer, by the same check the command makes. AuthzService
   * only exposes assert(), so a refusal is read from its 403.
   */
  private allowed(
    action: 'payment.record',
    scope: TxScope,
    invoice: Pick<PromiseInvoice, 'customerPartyId'>,
  ): boolean {
    if (invoice.customerPartyId === null) return false;
    try {
      this.authz.assert(action, this.customerRef(scope, invoice));
      return true;
    } catch (error) {
      if (error instanceof ForbiddenException) return false;
      throw error;
    }
  }

  /** True for an issued tax invoice or debit note with an amount still owed on its receivable debit. */
  private async promisable(
    tx: DbTransaction,
    scope: TxScope,
    invoice: PromiseInvoice,
  ): Promise<boolean> {
    if (invoice.status !== 'issued') return false;
    if (!(PROMISABLE_KINDS as readonly string[]).includes(invoice.kind)) return false;
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
    return open !== undefined;
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

    if (!(await this.promisable(tx, scope, invoice))) {
      throw new ConflictException({
        code: 'invoice_not_open',
        message:
          'Only an issued invoice or debit note with an amount still owed can take a promise to pay.',
      });
    }

    // The open promise this one replaces (decision R4c1 Q6). Closed before the insert: the partial unique index allows
    // one open promise per invoice. The row lock makes a concurrent recorder wait; it then finds no open row, and its
    // insert hits the index (409 promise_open) instead of replacing this one unseen.
    const [replaced] = await tx
      .update(paymentPromises)
      .set({
        status: 'replaced',
        version: sql`${paymentPromises.version} + 1`,
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(paymentPromises.tenantId, scope.tenantId),
          eq(paymentPromises.organizationId, scope.organizationId),
          eq(paymentPromises.invoiceId, invoice.id),
          eq(paymentPromises.status, 'open'),
        ),
      )
      .returning({ id: paymentPromises.id, promisedDate: paymentPromises.promisedDate });

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
    if (replaced !== undefined) {
      await this.audit.record(tx, {
        action: 'payment_promise.replaced',
        entityType: 'payment_promises',
        entityId: replaced.id,
        before: { status: 'open', promisedDate: replaced.promisedDate },
        after: { status: 'replaced', replacedByPromiseId: row.id },
      });
    }
    await this.audit.record(tx, {
      action: 'payment_promise.recorded',
      entityType: 'payment_promises',
      entityId: row.id,
      after: { invoiceId: invoice.id, promisedDate: body.promisedDate },
    });
    return toPaymentPromiseDto(row);
  }
}
