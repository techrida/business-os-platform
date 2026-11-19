// InvoiceDraftingService (P3 unit U10): list, detail, the three ways to start a draft (a billable schedule line, a
// manual tax invoice, a proforma) and discard. Serves the NFRs:
// - "amounts are exact": every figure comes from @bos/money-rules (`priceInvoice`, `priceSlice`), never from the client;
// - "no double effects": every command runs inside withIdempotency, and a schedule line has one live invoice: the line
//   is locked (sales order, then schedule line: the P3 lock order) and flipped billable -> drafted in the same
//   transaction as the insert, so two drafts of one line give one invoice and a SCHEDULE_LINE_TAKEN (done check 6);
//   the partial unique index of 0021 (G4) is the backstop;
// - "every change is audited": all writes run in withTx(), and each command records an audit event;
// - "authorization is deny-by-default": staff only, `invoice.read` / `invoice.draft`, and every row is read through
//   scoped() or scopeWhereFor(), so an invoice, order or line of another entity is a 404.
// A draft has no number, issue date or NPR value: those are set at issue. Paid is never stored (plan A8).
import {
  type CreateManualInvoiceBody,
  type CreateProformaBody,
  type Currency,
  type Discount,
  type InvoiceDetail,
  type InvoiceKind,
  type InvoiceListItem,
  type InvoiceStatus,
  canTransitionInvoice,
} from '@bos/contracts';
import {
  billingScheduleLines,
  customers,
  invoiceLines,
  invoicePrintLog,
  invoices,
  invoiceTaxSummary,
  salesOrders,
  salesOrderTaxSummary,
  scoped,
} from '@bos/db';
import { Inject, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { and, asc, desc, eq, ne, sql } from 'drizzle-orm';

import { AuditService } from '../../platform/audit/audit.service';
import { AuthzService, scopeWhereFor } from '../../platform/authz/authz.service';
import { DB, type Db, type DbTransaction } from '../../platform/db/db.module';
import { updateVersioned, withIdempotency } from '../../platform/db/idempotency';
import { withTx, type Actor, type TxScope } from '../../platform/db/tx';
import { CurrencyEnabledService } from '../../platform/settings/currency-enabled';
import { LedgerService } from '../ledger/ledger.service';
import { loadTaxCodePeriods } from '../quotations/pricing/tax-codes.resolver';
import { toInvoiceDetail, toInvoiceListItem } from './invoice-mapping';
import { priceInvoice, priceSlice, type PricedInvoice } from './invoice-pricing';
import {
  assertStaff,
  badRequest,
  conflict,
  INVOICE_CLOCK,
  InvoiceCaller,
  invoiceNotFound,
  kathmanduDay,
  pgError,
  scheduleLineNotFound,
  scheduleLineTaken,
} from './invoice-support';

const AUDIT_ENTITY = 'invoices';
const G4_INDEX = 'invoices_one_live_tax_invoice_per_schedule_line';

/** A manual invoice body; the optional `discount` is one document discount, part of the contract body. */
export type ManualInvoiceInput = CreateManualInvoiceBody;
export type FromScheduleInput = { scheduleLineId: string; salesOrderId?: string | undefined };

export interface InvoiceListFilter {
  kind?: InvoiceKind | undefined;
  status?: InvoiceStatus | undefined;
  customerId?: string | undefined;
}

interface TypedDraft {
  kind: 'tax_invoice' | 'proforma';
  customerId: string;
  currency: Currency;
  dueDate?: string | undefined;
  manualReason?: string | undefined;
  salesOrderId?: string | undefined;
  discount?: Discount | undefined;
  lines: CreateManualInvoiceBody['lines'];
}

@Injectable()
export class InvoiceDraftingService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly authz: AuthzService,
    private readonly audit: AuditService,
    private readonly caller: InvoiceCaller,
    private readonly ledger: LedgerService,
    private readonly currencies: CurrencyEnabledService,
    @Optional() @Inject(INVOICE_CLOCK) private readonly clock: () => Date = () => new Date(),
  ) {}

  // -------------------------------------------------------------------------------------------------- reads

  /** The invoices of the acting entity the caller may read, newest first. */
  async list(filter: InvoiceListFilter = {}): Promise<InvoiceListItem[]> {
    const { scope, actor, principal } = this.caller.current();
    assertStaff(principal);
    const visible = scopeWhereFor(principal, invoices, 'invoice.read');
    return withTx(this.db, scope, actor, async (tx) => {
      const rows = await tx
        .select({ invoice: invoices, customerName: customers.legalName })
        .from(invoices)
        .innerJoin(
          customers,
          and(
            eq(customers.tenantId, invoices.tenantId),
            eq(customers.id, invoices.customerPartyId),
          ),
        )
        .where(
          and(
            visible,
            filter.kind === undefined ? undefined : eq(invoices.kind, filter.kind),
            filter.status === undefined ? undefined : eq(invoices.status, filter.status),
            filter.customerId === undefined
              ? undefined
              : eq(invoices.customerPartyId, filter.customerId),
          ),
        )
        .orderBy(desc(invoices.createdAt), desc(invoices.id));
      return rows.map((r) => toInvoiceListItem(r.invoice, r.customerName));
    });
  }

  /** 200 with the detail; 404 for an invoice of another entity or outside the caller's read scope. */
  async detail(id: string): Promise<InvoiceDetail> {
    const { scope, actor, principal } = this.caller.current();
    assertStaff(principal);
    const visible = scopeWhereFor(principal, invoices, 'invoice.read');
    return withTx(this.db, scope, actor, async (tx) => {
      const [row] = await tx
        .select({ id: invoices.id })
        .from(invoices)
        .where(and(visible, eq(invoices.id, id)))
        .limit(1);
      if (row === undefined) throw invoiceNotFound();
      return this.loadDetail(tx, scope, id);
    });
  }

  // ------------------------------------------------------------------------------------------------ commands

  /** A manual tax invoice (plan A11): no sales order, `manualReason` required by the body schema. */
  async draftManual(body: ManualInvoiceInput, idempotencyKey: string): Promise<InvoiceDetail> {
    return this.draftTyped('invoice.create_manual', 'tax_invoice', body, body, idempotencyKey);
  }

  /** A proforma (plan A12): priced like an invoice, issued later with a PI number, never posted. */
  async draftProforma(body: CreateProformaBody, idempotencyKey: string): Promise<InvoiceDetail> {
    return this.draftTyped('invoice.create_proforma', 'proforma', body, body, idempotencyKey);
  }

  private async draftTyped(
    command: string,
    kind: 'tax_invoice' | 'proforma',
    body: object,
    typed: Omit<TypedDraft, 'kind'>,
    idempotencyKey: string,
  ): Promise<InvoiceDetail> {
    const { scope, actor, principal } = this.caller.current();
    assertStaff(principal);
    this.authz.assert('invoice.draft', scope);
    // 422 CURRENCY_NOT_ENABLED for a currency the company switched off (D44). A pool read, so it runs before the
    // transaction opens. A draft cut from a sales order copies the order's currency and is not checked again.
    await this.currencies.assertEnabled(scope, typed.currency);
    const now = this.clock();
    return withTx(this.db, scope, actor, async (tx) => {
      const done = await withIdempotency(tx, { command, key: idempotencyKey, body }, async () => ({
        status: 201,
        response: await this.createTypedInTx(tx, scope, actor, { ...typed, kind }, now),
      }));
      return done.response;
    });
  }

  /**
   * The next invoice of a sales order, cut from a billable schedule line. Locks the order and then the line (plan
   * section 2 lock order), requires the line to be billable, prices the slice with `invoiceSlice` (the last slice
   * absorbs the remainder), inserts the draft and flips the line to drafted with its invoice id, all in one transaction.
   * 404 for a line of another entity, 409 SCHEDULE_LINE_TAKEN when the line is drafted or invoiced, 409 when it is
   * not billable yet or the order is not confirmed.
   */
  async draftFromSchedule(body: FromScheduleInput, idempotencyKey: string): Promise<InvoiceDetail> {
    const { scope, actor, principal } = this.caller.current();
    assertStaff(principal);
    this.authz.assert('invoice.draft', scope);
    const now = this.clock();
    try {
      return await withTx(this.db, scope, actor, async (tx) => {
        const done = await withIdempotency(
          tx,
          { command: 'invoice.from_schedule', key: idempotencyKey, body },
          async () => ({
            status: 201,
            response: await this.fromScheduleInTx(tx, scope, actor, body, now),
          }),
        );
        return done.response;
      });
    } catch (error) {
      const pg = pgError(error);
      if (pg?.code === '23505' && pg.constraint === G4_INDEX) throw scheduleLineTaken();
      throw error;
    }
  }

  /**
   * Discards a draft (or a returned invoice): the invoice becomes `discarded`, and the schedule line it held goes back
   * to billable with no invoice, so it can be drafted again. `reason` goes to the audit log (the table has no column
   * for it). 404 outside the entity; 409 for a status that cannot be discarded or a stale `expectedVersion`.
   */
  async discard(
    id: string,
    body: { expectedVersion: number; reason: string },
    idempotencyKey: string,
  ): Promise<InvoiceDetail> {
    const { scope, actor, principal } = this.caller.current();
    assertStaff(principal);
    this.authz.assert('invoice.draft', scope);
    const now = this.clock();
    return withTx(this.db, scope, actor, async (tx) => {
      const done = await withIdempotency(
        tx,
        { command: 'invoice.discard', key: idempotencyKey, body: { id, ...body } },
        async () => ({ status: 200, response: await this.discardInTx(tx, scope, id, body, now) }),
      );
      return done.response;
    });
  }

  // ---------------------------------------------------------------------------------------------- internals

  private async createTypedInTx(
    tx: DbTransaction,
    scope: TxScope,
    actor: Actor,
    draft: TypedDraft,
    now: Date,
  ): Promise<InvoiceDetail> {
    const [customer] = await tx
      .select({ id: customers.id })
      .from(customers)
      .where(and(eq(customers.tenantId, scope.tenantId), eq(customers.id, draft.customerId)))
      .limit(1);
    if (customer === undefined) throw badRequest('customerId is not a customer');
    if (draft.salesOrderId !== undefined) {
      const [order] = await tx
        .select({ customerPartyId: salesOrders.customerPartyId })
        .from(salesOrders)
        .where(scoped(scope).where(salesOrders, eq(salesOrders.id, draft.salesOrderId)))
        .limit(1);
      if (order === undefined) {
        throw invoiceNotFoundOrder();
      }
      if (order.customerPartyId !== draft.customerId) {
        throw badRequest('The sales order belongs to another customer');
      }
    }
    const periods = await loadTaxCodePeriods(
      tx,
      scope.tenantId,
      draft.lines.map((l) => l.taxCodeId),
    );
    const priced = rangeAs400(() =>
      priceInvoice(
        {
          currency: draft.currency,
          asOf: kathmanduDay(now),
          lines: draft.lines,
          discount: draft.discount ?? null,
        },
        periods,
      ),
    );
    const id = await this.insertInvoice(tx, scope, actor, priced, {
      kind: draft.kind,
      customerPartyId: draft.customerId,
      salesOrderId: draft.salesOrderId ?? null,
      scheduleLineId: null,
      manualReason: draft.manualReason ?? null,
      dueDate: draft.dueDate ?? null,
      currency: draft.currency,
    });
    return this.loadDetail(tx, scope, id);
  }

  private async fromScheduleInTx(
    tx: DbTransaction,
    scope: TxScope,
    actor: Actor,
    body: FromScheduleInput,
    now: Date,
  ): Promise<InvoiceDetail> {
    void now;
    const own = (table: typeof billingScheduleLines | typeof salesOrderTaxSummary) =>
      and(eq(table.tenantId, scope.tenantId), eq(table.organizationId, scope.organizationId));
    // Which order the line belongs to, read before any lock (the order is the first lock).
    const [probe] = await tx
      .select({ salesOrderId: billingScheduleLines.salesOrderId })
      .from(billingScheduleLines)
      .where(and(own(billingScheduleLines), eq(billingScheduleLines.id, body.scheduleLineId)))
      .limit(1);
    if (
      probe === undefined ||
      (body.salesOrderId !== undefined && body.salesOrderId !== probe.salesOrderId)
    ) {
      throw scheduleLineNotFound();
    }
    await this.ledger.lockForMoneyCommand(tx, scope, [
      { rank: 'sales_order', ids: [probe.salesOrderId], table: salesOrders },
      { rank: 'schedule_line', ids: [body.scheduleLineId], table: billingScheduleLines },
    ]);
    const [order] = await tx
      .select()
      .from(salesOrders)
      .where(scoped(scope).where(salesOrders, eq(salesOrders.id, probe.salesOrderId)))
      .limit(1);
    const lines = await tx
      .select()
      .from(billingScheduleLines)
      .where(
        and(own(billingScheduleLines), eq(billingScheduleLines.salesOrderId, probe.salesOrderId)),
      );
    const line = lines.find((l) => l.id === body.scheduleLineId);
    if (order === undefined || line === undefined) throw scheduleLineNotFound();
    if (line.status === 'drafted' || line.status === 'invoiced') throw scheduleLineTaken();
    if (line.status !== 'billable') {
      throw conflict(`The schedule line is ${line.status}, not billable yet`);
    }
    if (order.status !== 'confirmed') throw conflict(`The sales order is ${order.status}`);
    if (order.customerPartyId === null) throw new Error(`sales order ${order.id} has no customer`);

    const isLast = lines.every(
      (l) => l.id === line.id || (l.status !== 'planned' && l.status !== 'billable'),
    );
    const soSummary = await tx
      .select({
        taxCodeId: salesOrderTaxSummary.taxCodeId,
        base: salesOrderTaxSummary.base,
        tax: salesOrderTaxSummary.tax,
      })
      .from(salesOrderTaxSummary)
      .where(and(own(salesOrderTaxSummary), eq(salesOrderTaxSummary.salesOrderId, order.id)));
    // Every live (not discarded) tax invoice already cut from this order: the order is locked, so none can appear.
    const billed = await tx
      .select({
        taxCodeId: invoiceTaxSummary.taxCodeId,
        base: invoiceTaxSummary.base,
        tax: invoiceTaxSummary.tax,
      })
      .from(invoiceTaxSummary)
      .innerJoin(
        invoices,
        and(
          eq(invoices.tenantId, invoiceTaxSummary.tenantId),
          eq(invoices.organizationId, invoiceTaxSummary.organizationId),
          eq(invoices.id, invoiceTaxSummary.invoiceId),
        ),
      )
      .where(
        and(
          eq(invoices.tenantId, scope.tenantId),
          eq(invoices.organizationId, scope.organizationId),
          eq(invoices.salesOrderId, order.id),
          eq(invoices.kind, 'tax_invoice'),
          ne(invoices.status, 'discarded'),
        ),
      );
    const periods = await loadTaxCodePeriods(tx, scope.tenantId, [
      ...soSummary.map((s) => s.taxCodeId),
      ...billed.map((s) => s.taxCodeId),
    ]);
    const priced = rangeAs400(() =>
      priceSlice(
        { label: line.label, sliceTotal: line.amount, isLast, soSummary, billed },
        periods,
      ),
    );
    const invoiceId = await this.insertInvoice(tx, scope, actor, priced, {
      kind: 'tax_invoice',
      customerPartyId: order.customerPartyId,
      salesOrderId: order.id,
      scheduleLineId: line.id,
      manualReason: null,
      // The due date is the sales order's credit days after the issue date; it is set at issue, not at draft.
      dueDate: null,
      currency: order.currency,
    });
    const taken = await tx
      .update(billingScheduleLines)
      .set({
        status: 'drafted',
        invoiceId,
        version: sql`${billingScheduleLines.version} + 1`,
        updatedAt: sql`now()`,
      })
      .where(
        and(
          own(billingScheduleLines),
          eq(billingScheduleLines.id, line.id),
          eq(billingScheduleLines.status, 'billable'),
        ),
      )
      .returning({ id: billingScheduleLines.id });
    if (taken.length === 0) throw scheduleLineTaken();
    return this.loadDetail(tx, scope, invoiceId);
  }

  private async discardInTx(
    tx: DbTransaction,
    scope: TxScope,
    id: string,
    body: { expectedVersion: number; reason: string },
    now: Date,
  ): Promise<InvoiceDetail> {
    const [head] = await tx
      .select({ salesOrderId: invoices.salesOrderId, scheduleLineId: invoices.scheduleLineId })
      .from(invoices)
      .where(scoped(scope).where(invoices, eq(invoices.id, id)))
      .limit(1);
    if (head === undefined) throw invoiceNotFound();
    // Lock order: sales order, schedule line, then the invoice.
    await this.ledger.lockForMoneyCommand(tx, scope, [
      ...(head.salesOrderId === null
        ? []
        : [{ rank: 'sales_order' as const, ids: [head.salesOrderId], table: salesOrders }]),
      ...(head.scheduleLineId === null
        ? []
        : [
            {
              rank: 'schedule_line' as const,
              ids: [head.scheduleLineId],
              table: billingScheduleLines,
            },
          ]),
      { rank: 'invoice' as const, ids: [id], table: invoices },
    ]);
    const [invoice] = await tx
      .select()
      .from(invoices)
      .where(scoped(scope).where(invoices, eq(invoices.id, id)))
      .limit(1);
    if (invoice === undefined) throw invoiceNotFound();
    if (!canTransitionInvoice(invoice.kind, invoice.status, 'discarded')) {
      throw conflict(`A ${invoice.status} ${invoice.kind.replace('_', ' ')} cannot be discarded`);
    }
    if (invoice.scheduleLineId !== null) {
      // One UPDATE: billing_schedule_lines_invoice_check ties invoice_id to the drafted and invoiced statuses.
      await tx
        .update(billingScheduleLines)
        .set({
          status: 'billable',
          invoiceId: null,
          version: sql`${billingScheduleLines.version} + 1`,
          updatedAt: sql`now()`,
        })
        .where(
          and(
            eq(billingScheduleLines.tenantId, scope.tenantId),
            eq(billingScheduleLines.organizationId, scope.organizationId),
            eq(billingScheduleLines.id, invoice.scheduleLineId),
            eq(billingScheduleLines.invoiceId, invoice.id),
            eq(billingScheduleLines.status, 'drafted'),
          ),
        );
    }
    await updateVersioned(tx, invoices, id, body.expectedVersion, {
      status: 'discarded',
      discardedAt: now,
    });
    await this.audit.record(tx, {
      action: 'invoice.discarded',
      entityType: AUDIT_ENTITY,
      entityId: id,
      before: { status: invoice.status, version: invoice.version },
      after: { status: 'discarded', reason: body.reason, scheduleLineId: invoice.scheduleLineId },
    });
    return this.loadDetail(tx, scope, id);
  }

  private async insertInvoice(
    tx: DbTransaction,
    scope: TxScope,
    actor: Actor,
    priced: PricedInvoice,
    head: {
      kind: 'tax_invoice' | 'proforma';
      customerPartyId: string;
      salesOrderId: string | null;
      scheduleLineId: string | null;
      manualReason: string | null;
      dueDate: string | null;
      currency: Currency;
    },
  ): Promise<string> {
    const owned = { tenantId: scope.tenantId, organizationId: scope.organizationId };
    const [row] = await tx
      .insert(invoices)
      .values({
        ...owned,
        ...head,
        status: 'draft',
        ...priced.columns,
        createdBy: actor.kind === 'user' ? actor.id : null,
      })
      .returning({ id: invoices.id });
    const invoiceId = row!.id;
    await tx.insert(invoiceLines).values(
      priced.lines.map(({ catalogItemId: _catalogItemId, ...line }) => ({
        ...owned,
        invoiceId,
        ...line,
      })),
    );
    if (priced.taxSummary.length > 0) {
      await tx
        .insert(invoiceTaxSummary)
        .values(priced.taxSummary.map((t) => ({ ...owned, invoiceId, ...t })));
    }
    await this.audit.record(tx, {
      action: 'invoice.drafted',
      entityType: AUDIT_ENTITY,
      entityId: invoiceId,
      after: {
        kind: head.kind,
        customerPartyId: head.customerPartyId,
        salesOrderId: head.salesOrderId,
        scheduleLineId: head.scheduleLineId,
        currency: head.currency,
        total: priced.columns.total,
      },
    });
    return invoiceId;
  }

  /** The invoice with its lines, tax summary and print log, read in `tx` in the acting entity. */
  async loadDetail(tx: DbTransaction, scope: TxScope, id: string): Promise<InvoiceDetail> {
    const [invoice] = await tx
      .select()
      .from(invoices)
      .where(scoped(scope).where(invoices, eq(invoices.id, id)))
      .limit(1);
    if (invoice === undefined) throw invoiceNotFound();
    const child = <
      T extends typeof invoiceLines | typeof invoiceTaxSummary | typeof invoicePrintLog,
    >(
      t: T,
    ) =>
      and(
        eq(t.tenantId, scope.tenantId),
        eq(t.organizationId, scope.organizationId),
        eq(t.invoiceId, id),
      );
    const lines = await tx
      .select()
      .from(invoiceLines)
      .where(child(invoiceLines))
      .orderBy(asc(invoiceLines.lineNo));
    const taxSummary = await tx.select().from(invoiceTaxSummary).where(child(invoiceTaxSummary));
    const prints = await tx.select().from(invoicePrintLog).where(child(invoicePrintLog));
    // The name a draft shows before the buyer is frozen at issue; the caller may read the invoice, which names it.
    const [customer] =
      invoice.customerPartyId === null
        ? []
        : await tx
            .select({ legalName: customers.legalName })
            .from(customers)
            .where(
              and(
                eq(customers.tenantId, scope.tenantId),
                eq(customers.id, invoice.customerPartyId),
              ),
            )
            .limit(1);
    return toInvoiceDetail({
      invoice,
      lines,
      taxSummary,
      prints,
      customerName: customer?.legalName,
    });
  }
}

/** Runs pure pricing and answers a RangeError (an out-of-range discount, an unknown code) as 400, never 500. */
function rangeAs400<T>(fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    if (error instanceof RangeError) throw badRequest(error.message);
    throw error;
  }
}

function invoiceNotFoundOrder() {
  return new NotFoundException({ code: 'not_found', message: 'Sales order not found' });
}
