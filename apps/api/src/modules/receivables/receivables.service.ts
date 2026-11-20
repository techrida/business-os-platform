// ReceivablesService: the read side of receivables (P3 U8; decisions A6, A8, A10, A13; done checks 8 and 9). Serves
// the NFR "paid is derived" (A8): every figure here is computed on read from open_item_balances and
// open_item_allocations, never stored. "Today" is the Kathmandu calendar day of the server clock (A10).
// - statement: a customer's issued tax invoices and debit notes with their derived settlement;
// - aging: every open receivable debit of the acting entity, bucketed per customer and currency;
// - advance: a customer's unallocated credit on verified payments, per currency (A6: no cross-currency netting).
// Reads only; the acting entity scopes every query, so another entity's rows never appear.
import {
  type ArAgingReport,
  type Currency,
  type CustomerAdvance,
  type InvoiceSettlement,
} from '@bos/contracts';
import { invoices, openItemBalances, parties, paymentPromises, payments } from '@bos/db';
import { Inject, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { and, asc, eq, gt, inArray, sql } from 'drizzle-orm';

import { AuthzService } from '../../platform/authz/authz.service';
import { DB, type Db, type DbTransaction } from '../../platform/db/db.module';
import { withTx, type Actor, type TxScope } from '../../platform/db/tx';
import { agingReport, agingRowKey, kathmanduDay, settlementRow } from './receivables.rules';

/** Injection token for a test clock; production falls back to the system time. */
export const RECEIVABLES_CLOCK = Symbol('RECEIVABLES_CLOCK');

const STATEMENT_KINDS = ['tax_invoice', 'debit_note'] as const;

export interface StatementFilter {
  /** Only invoices with an open amount above zero. */
  open?: boolean;
  currency?: Currency;
}

@Injectable()
export class ReceivablesService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly authz: AuthzService,
    @Optional()
    @Inject(RECEIVABLES_CLOCK)
    private readonly clock: () => Date = () => new Date(),
  ) {}

  /** The customer's issued invoices and debit notes in the acting entity, oldest first. 404 for an unknown customer. */
  async statement(
    scope: TxScope,
    customerId: string,
    filter: StatementFilter,
  ): Promise<InvoiceSettlement[]> {
    return withTx(this.db, scope, this.readActor(), async (tx) => {
      await this.assertCustomer(tx, scope, customerId);
      // The net of allocations on the debit item whose credit item is a credit note (U12's), reversals included.
      const credited = sql<string>`(
        SELECT COALESCE(sum(a."amount"), 0)::text
          FROM "app"."open_item_allocations" a
          JOIN "app"."open_items" c ON c."tenant_id" = a."tenant_id" AND c."id" = a."credit_item_id"
         WHERE a."tenant_id" = ${openItemBalances.tenantId}
           AND a."organization_id" = ${openItemBalances.organizationId}
           AND a."debit_item_id" = ${openItemBalances.openItemId}
           AND c."source_type" = 'credit_note')`;
      const rows = await tx
        .select({
          invoiceId: invoices.id,
          number: invoices.number,
          kind: invoices.kind,
          currency: invoices.currency,
          issueDate: invoices.issueDate,
          dueDate: invoices.dueDate,
          total: openItemBalances.amount,
          allocated: openItemBalances.allocatedAmount,
          credited,
        })
        .from(invoices)
        .innerJoin(
          openItemBalances,
          and(
            eq(openItemBalances.tenantId, invoices.tenantId),
            eq(openItemBalances.organizationId, invoices.organizationId),
            eq(openItemBalances.sourceId, invoices.id),
            sql`${openItemBalances.sourceType} = ${invoices.kind}`,
          ),
        )
        .where(
          and(
            eq(invoices.tenantId, scope.tenantId),
            eq(invoices.organizationId, scope.organizationId),
            eq(invoices.customerPartyId, customerId),
            eq(invoices.status, 'issued'),
            inArray(invoices.kind, [...STATEMENT_KINDS]),
            filter.currency === undefined ? undefined : eq(invoices.currency, filter.currency),
            filter.open === true ? gt(openItemBalances.openAmount, '0') : undefined,
          ),
        )
        .orderBy(asc(invoices.issueDate), asc(invoices.number));
      const today = this.today();
      return rows.map((r) =>
        settlementRow(
          {
            invoiceId: r.invoiceId,
            number: r.number ?? '',
            kind: r.kind,
            customerId,
            currency: r.currency,
            issueDate: r.issueDate ?? '',
            dueDate: r.dueDate,
            total: r.total ?? '0',
            allocated: r.allocated ?? '0',
            credited: r.credited,
          },
          today,
        ),
      );
    });
  }

  /** Every open receivable debit of the acting entity, aged as of Kathmandu today. */
  async aging(scope: TxScope): Promise<ArAgingReport> {
    this.authz.assert('ar.read', {
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
    });
    return withTx(this.db, scope, this.readActor(), async (tx) => {
      const rows = await tx
        .select({
          customerId: openItemBalances.customerPartyId,
          customerName: parties.name,
          currency: openItemBalances.currency,
          openAmount: openItemBalances.openAmount,
          dueDate: openItemBalances.dueDate,
          documentDate: openItemBalances.documentDate,
        })
        .from(openItemBalances)
        .innerJoin(
          parties,
          and(
            eq(parties.tenantId, openItemBalances.tenantId),
            eq(parties.id, openItemBalances.customerPartyId),
          ),
        )
        .where(
          and(
            eq(openItemBalances.tenantId, scope.tenantId),
            eq(openItemBalances.organizationId, scope.organizationId),
            eq(openItemBalances.side, 'receivable'),
            eq(openItemBalances.direction, 'debit'),
            gt(openItemBalances.openAmount, '0'),
          ),
        );
      return agingReport(
        rows.map((r) => ({
          customerId: r.customerId ?? '',
          customerName: r.customerName,
          currency: r.currency,
          openAmount: r.openAmount ?? '0',
          dueDate: r.dueDate ?? r.documentDate ?? this.today(),
        })),
        this.today(),
        await this.missedPromises(tx, scope),
      );
    });
  }

  /** The customer's unallocated credit on verified payments, per currency; currencies with none are left out. */
  async advance(scope: TxScope, customerId: string): Promise<CustomerAdvance[]> {
    return withTx(this.db, scope, this.readActor(), async (tx) => {
      await this.assertCustomer(tx, scope, customerId);
      const total = sql<string>`sum(${openItemBalances.openAmount})`;
      const rows = await tx
        .select({
          currency: openItemBalances.currency,
          amount: sql<string>`${total}::numeric(18, 2)::text`,
        })
        .from(openItemBalances)
        .innerJoin(
          payments,
          and(
            eq(payments.tenantId, openItemBalances.tenantId),
            eq(payments.organizationId, openItemBalances.organizationId),
            eq(payments.id, openItemBalances.sourceId),
          ),
        )
        .where(
          and(
            eq(openItemBalances.tenantId, scope.tenantId),
            eq(openItemBalances.organizationId, scope.organizationId),
            eq(openItemBalances.side, 'receivable'),
            eq(openItemBalances.direction, 'credit'),
            eq(openItemBalances.sourceType, 'payment'),
            eq(openItemBalances.customerPartyId, customerId),
            eq(payments.status, 'verified'),
          ),
        )
        .groupBy(openItemBalances.currency)
        .having(sql`${total} > 0`)
        .orderBy(asc(openItemBalances.currency));
      return rows.map((r) => ({
        customerId,
        currency: r.currency,
        amount: r.amount,
      }));
    });
  }

  // -------------------------------------------------------------------------------------- internals

  /**
   * F1-Q33: per customer and currency, the latest promised day of a missed promise to pay whose invoice still has an
   * open amount. Paying the invoice (or crediting it to zero) clears the flag on the next read: nothing is stored.
   */
  private async missedPromises(tx: DbTransaction, scope: TxScope): Promise<Map<string, string>> {
    const latest = sql<string>`max(${paymentPromises.promisedDate})::text`;
    const rows = await tx
      .select({
        customerId: invoices.customerPartyId,
        currency: invoices.currency,
        promisedDate: latest,
      })
      .from(paymentPromises)
      .innerJoin(
        invoices,
        and(
          eq(invoices.tenantId, paymentPromises.tenantId),
          eq(invoices.organizationId, paymentPromises.organizationId),
          eq(invoices.id, paymentPromises.invoiceId),
        ),
      )
      .innerJoin(
        openItemBalances,
        and(
          eq(openItemBalances.tenantId, invoices.tenantId),
          eq(openItemBalances.organizationId, invoices.organizationId),
          eq(openItemBalances.sourceId, invoices.id),
          sql`${openItemBalances.sourceType} = ${invoices.kind}`,
          eq(openItemBalances.side, 'receivable'),
          eq(openItemBalances.direction, 'debit'),
        ),
      )
      .where(
        and(
          eq(paymentPromises.tenantId, scope.tenantId),
          eq(paymentPromises.organizationId, scope.organizationId),
          eq(paymentPromises.status, 'missed'),
          gt(openItemBalances.openAmount, '0'),
        ),
      )
      .groupBy(invoices.customerPartyId, invoices.currency);
    return new Map(
      rows.flatMap((r) =>
        r.customerId === null
          ? []
          : [[agingRowKey(r.customerId, r.currency), r.promisedDate] as const],
      ),
    );
  }

  private today(): string {
    return kathmanduDay(this.clock());
  }

  /** `ar.read` on the customer, which must be a customer party of this tenant (404 otherwise). */
  private async assertCustomer(tx: DbTransaction, scope: TxScope, customerId: string) {
    this.authz.assert('ar.read', {
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      customerPartyId: customerId,
    });
    const [party] = await tx
      .select({ id: parties.id })
      .from(parties)
      .where(
        and(
          eq(parties.tenantId, scope.tenantId),
          eq(parties.id, customerId),
          eq(parties.kind, 'customer'),
        ),
      )
      .limit(1);
    if (party === undefined) {
      throw new NotFoundException({ code: 'not_found', message: 'Customer not found' });
    }
  }

  /** A system read actor for read-only transactions (withTx needs one; nothing is written). */
  private readActor(): Actor {
    return { kind: 'system', id: 'system:receivables-read', correlationId: 'receivables-read' };
  }
}
