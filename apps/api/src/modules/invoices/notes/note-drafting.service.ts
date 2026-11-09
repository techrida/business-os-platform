// NoteDraftingService (P3 unit U12 part B): drafts a credit note or a debit note against an issued tax invoice of the
// acting entity. Both then go through the shared submit (Accountant -> Finance approval) and issue routes. Serves the NFRs:
// - "amounts are exact": a credit note is priced from the original's own lines (unit price, pro-rata discount) and its
//   VAT with `creditNoteSlice`; a debit note with `priceInvoice`. Nothing priced comes from the client;
// - "a credit never exceeds the invoice" (done check 7): the original is locked first (lock order: invoice), then the
//   live credit notes on it are summed, so two concurrent credits serialise and the second sees the first. Over the
//   remaining total answers 409 CREDIT_EXCEEDS_INVOICE; the deferred `invoices_notes` trigger (0021) is the backstop
//   and its 23514 at commit maps to the same code;
// - "no double effects": every command runs inside withIdempotency;
// - "every change is audited": all writes run in withTx() and record `invoice.drafted`;
// - "authorization is deny-by-default": staff only, `invoice.credit_note` (debit notes share it), and the original is
//   read through scoped(), so an invoice of another entity is a 404.
// A note copies the original's customer, currency and sales order (the trigger requires the first two; the order gives
// the due date at issue). It has no number, issue date or NPR value until issue.
import { type CreditNoteBody, type DebitNoteBody, type InvoiceDetail } from '@bos/contracts';
import { invoiceLines, invoices, invoiceTaxSummary, scoped } from '@bos/db';
import {
  CALC_VERSION,
  creditNoteSlice,
  Dec,
  roundMoney,
  type TaxBucket,
  type TaxCode,
} from '@bos/money-rules';
import { ConflictException, Inject, Injectable, Optional } from '@nestjs/common';
import { and, asc, eq, ne, sql } from 'drizzle-orm';

import { AuditService } from '../../../platform/audit/audit.service';
import { AuthzService } from '../../../platform/authz/authz.service';
import { DB, type Db, type DbTransaction } from '../../../platform/db/db.module';
import { withIdempotency } from '../../../platform/db/idempotency';
import { withTx, type Actor, type TxScope } from '../../../platform/db/tx';
import { LedgerService } from '../../ledger/ledger.service';
import { loadTaxCodePeriods } from '../../quotations/pricing/tax-codes.resolver';
import { InvoiceDraftingService } from '../invoice-drafting.service';
import {
  priceInvoice,
  type InvoiceColumns,
  type InvoiceTaxCodeRow,
  type PricedInvoice,
  type PricedInvoiceLine,
  type PricedInvoiceTaxRow,
} from '../invoice-pricing';
import {
  assertStaff,
  badRequest,
  conflict,
  INVOICE_CLOCK,
  InvoiceCaller,
  invoiceNotFound,
  kathmanduDay,
  pgError,
} from '../invoice-support';

const AUDIT_ENTITY = 'invoices';
const CREDIT_CAP_CONSTRAINT = 'invoices_credit_cap_check';
const NOTE_ORIGINAL_CONSTRAINT = 'invoices_note_original_issued_check';

type InvoiceRow = typeof invoices.$inferSelect;
type InvoiceLineRow = typeof invoiceLines.$inferSelect;
type InvoiceTaxSummaryRow = typeof invoiceTaxSummary.$inferSelect;
type NoteKind = 'credit_note' | 'debit_note';

/** 409 CREDIT_EXCEEDS_INVOICE: the live credit notes of an invoice would total more than the invoice (done check 7). */
export const creditExceedsInvoice = (remaining?: string) =>
  new ConflictException({
    code: 'CREDIT_EXCEEDS_INVOICE',
    message:
      remaining === undefined
        ? 'The credit notes of this invoice would total more than the invoice'
        : `This credit is more than the ${remaining} of the invoice not yet credited`,
  });

const ZERO = new Dec(0);
const money = (v: Dec): string => v.toFixed(2);
const sum = (values: readonly Dec[]): Dec => values.reduce((a, b) => a.plus(b), ZERO);

const toTaxCode = (row: InvoiceTaxCodeRow): TaxCode => ({
  code: row.code,
  kind: row.kind,
  rateBp: row.rateBp,
  creditable: row.creditable,
  effectiveFrom: row.effectiveFrom,
  effectiveTo: row.effectiveTo,
});

/**
 * Prices a credit note from the issued original (pure). Each credited line keeps the original's description, uom, unit
 * price and tax code; gross = round(qty x price, 2); the discount is the original line's discount x qty / original qty,
 * half up (crediting a whole line gives back exactly its discount); taxable = gross - discount. VAT per tax code comes
 * from `creditNoteSlice` against the original's tax summary, so crediting a whole bucket returns exactly the VAT charged.
 * Throws RangeError for an unknown line, a quantity above the original's, or a bucket over-credited.
 */
export function priceCreditNote(
  original: { lines: readonly InvoiceLineRow[]; taxSummary: readonly InvoiceTaxSummaryRow[] },
  periods: readonly InvoiceTaxCodeRow[],
  requested: CreditNoteBody['lines'],
): PricedInvoice {
  const periodById = new Map(periods.map((p) => [p.id, p]));
  const periodOf = (id: string): InvoiceTaxCodeRow => {
    const found = periodById.get(id);
    if (found === undefined) throw new RangeError(`Unknown tax code id: ${id}`);
    return found;
  };
  const byLineNo = new Map(original.lines.map((l) => [l.lineNo, l]));
  const ordered = [...requested].sort((a, b) => a.originalLineNo - b.originalLineNo);

  const lines: PricedInvoiceLine[] = ordered.map((req, i) => {
    const src = byLineNo.get(req.originalLineNo);
    if (src === undefined) {
      throw new RangeError(`Line ${req.originalLineNo} is not on the original invoice.`);
    }
    const qty = new Dec(req.quantity);
    const srcQty = new Dec(src.quantity);
    if (qty.lte(0)) throw new RangeError(`Line ${req.originalLineNo}: the quantity must be above 0.`);
    if (qty.gt(srcQty)) {
      throw new RangeError(
        `Line ${req.originalLineNo}: credits ${qty.toFixed(4)} of the ${srcQty.toFixed(4)} invoiced.`,
      );
    }
    const unitPrice = new Dec(src.unitPrice);
    const gross = roundMoney(qty.times(unitPrice));
    const discount = qty.eq(srcQty)
      ? new Dec(src.discountAlloc)
      : roundMoney(new Dec(src.discountAlloc).times(qty).div(srcQty));
    const discountAlloc = Dec.min(discount, gross);
    return {
      lineNo: i + 1,
      catalogItemId: null,
      description: src.description,
      uom: src.uom,
      quantity: qty.toFixed(4),
      unitPrice: money(unitPrice),
      taxCodeId: src.taxCodeId,
      gross: money(gross),
      discountAlloc: money(discountAlloc),
      taxable: money(gross.minus(discountAlloc)),
    };
  });

  const originalBuckets: TaxBucket[] = original.taxSummary.map((s) => ({
    taxCode: toTaxCode(periodOf(s.taxCodeId)),
    taxable: new Dec(s.base),
    vat: new Dec(s.tax),
    reverseChargeVat: ZERO,
  }));
  const slice = creditNoteSlice(originalBuckets, {
    kind: 'lines',
    lines: lines.map((l) => ({ taxCode: periodOf(l.taxCodeId).code, taxable: new Dec(l.taxable) })),
  });

  const taxSummary: PricedInvoiceTaxRow[] = [];
  slice.buckets.forEach((bucket, i) => {
    if (bucket.taxable.isZero() && bucket.vat.isZero()) return;
    const src = original.taxSummary[i]!;
    taxSummary.push({
      taxCodeId: src.taxCodeId,
      label: src.label,
      rate: src.rate,
      base: money(bucket.taxable),
      tax: money(bucket.vat),
    });
  });

  const of = (...kinds: TaxCode['kind'][]) =>
    sum(slice.buckets.filter((b) => kinds.includes(b.taxCode.kind)).map((b) => b.taxable));
  const columns: InvoiceColumns = {
    subtotal: money(sum(lines.map((l) => new Dec(l.gross)))),
    discountAmount: money(sum(lines.map((l) => new Dec(l.discountAlloc)))),
    taxableVatAmount: money(of('vat')),
    // Reverse charge is booked as exempt, as on the invoice: no VAT is charged.
    exemptAmount: money(of('exempt', 'reverse_charge')),
    zeroRatedAmount: money(of('zero')),
    taxAmount: money(slice.vatTotal),
    total: money(slice.total),
    calcVersion: CALC_VERSION,
  };
  return { lines, taxSummary, columns };
}

/** What is left to credit on an invoice: its total less the live (not discarded) credit notes, never below 0. */
export function remainingToCredit(originalTotal: string, liveCredits: string): Dec {
  const left = new Dec(originalTotal).minus(new Dec(liveCredits));
  return left.isNegative() ? ZERO : left;
}

@Injectable()
export class NoteDraftingService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly authz: AuthzService,
    private readonly audit: AuditService,
    private readonly caller: InvoiceCaller,
    private readonly ledger: LedgerService,
    private readonly drafting: InvoiceDraftingService,
    @Optional() @Inject(INVOICE_CLOCK) private readonly clock: () => Date = () => new Date(),
  ) {}

  /**
   * 201 with the InvoiceDetail of a credit-note draft. 404 for an original outside the entity, 409 when the original is
   * not an issued tax invoice, 409 CREDIT_EXCEEDS_INVOICE over the remaining total, 400 for an unknown line or a
   * quantity above the original's.
   */
  async draftCreditNote(body: CreditNoteBody, idempotencyKey: string): Promise<InvoiceDetail> {
    return this.run('invoice.credit_note', body, idempotencyKey, (tx, scope, actor) =>
      this.creditInTx(tx, scope, actor, body),
    );
  }

  /** 201 with the InvoiceDetail of a debit-note draft priced from typed lines; 404 / 409 as for a credit note. */
  async draftDebitNote(body: DebitNoteBody, idempotencyKey: string): Promise<InvoiceDetail> {
    return this.run('invoice.debit_note', body, idempotencyKey, (tx, scope, actor) =>
      this.debitInTx(tx, scope, actor, body),
    );
  }

  private async run(
    command: string,
    body: object,
    idempotencyKey: string,
    work: (tx: DbTransaction, scope: TxScope, actor: Actor) => Promise<InvoiceDetail>,
  ): Promise<InvoiceDetail> {
    const { scope, actor, principal } = this.caller.current();
    assertStaff(principal);
    this.authz.assert('invoice.credit_note', scope);
    try {
      return await withTx(this.db, scope, actor, async (tx) => {
        const done = await withIdempotency(
          tx,
          { command, key: idempotencyKey, body },
          async () => ({ status: 201, response: await work(tx, scope, actor) }),
        );
        return done.response;
      });
    } catch (error) {
      // The deferred invoices_notes trigger fires at commit: map its check violations to the service's answers.
      const pg = pgError(error);
      if (pg?.code === '23514' && pg.constraint === CREDIT_CAP_CONSTRAINT) {
        throw creditExceedsInvoice();
      }
      if (pg?.code === '23514' && pg.constraint === NOTE_ORIGINAL_CONSTRAINT) {
        throw notIssuedTaxInvoice();
      }
      throw error;
    }
  }

  private async creditInTx(
    tx: DbTransaction,
    scope: TxScope,
    actor: Actor,
    body: CreditNoteBody,
  ): Promise<InvoiceDetail> {
    const original = await this.lockOriginal(tx, scope, body.originalInvoiceId);
    const owned = (t: typeof invoiceLines | typeof invoiceTaxSummary) =>
      and(
        eq(t.tenantId, scope.tenantId),
        eq(t.organizationId, scope.organizationId),
        eq(t.invoiceId, original.id),
      );
    const lines = await tx
      .select()
      .from(invoiceLines)
      .where(owned(invoiceLines))
      .orderBy(asc(invoiceLines.lineNo));
    const taxSummary = await tx.select().from(invoiceTaxSummary).where(owned(invoiceTaxSummary));
    const periods = await loadTaxCodePeriods(tx, scope.tenantId, [
      ...lines.map((l) => l.taxCodeId),
      ...taxSummary.map((s) => s.taxCodeId),
    ]);
    const priced = rangeAs400(() => priceCreditNote({ lines, taxSummary }, periods, body.lines));

    // The original is locked, so no credit note on it can appear or change until this transaction ends.
    const [credited] = await tx
      .select({ total: sql<string>`COALESCE(sum(${invoices.total}), 0)::text` })
      .from(invoices)
      .where(
        and(
          eq(invoices.tenantId, scope.tenantId),
          eq(invoices.organizationId, scope.organizationId),
          eq(invoices.originalInvoiceId, original.id),
          eq(invoices.kind, 'credit_note'),
          ne(invoices.status, 'discarded'),
        ),
      );
    const remaining = remainingToCredit(original.total, credited?.total ?? '0');
    if (new Dec(priced.columns.total).gt(remaining)) throw creditExceedsInvoice(money(remaining));

    const id = await this.insertNote(tx, scope, actor, priced, original, 'credit_note', body.reason);
    return this.drafting.loadDetail(tx, scope, id);
  }

  private async debitInTx(
    tx: DbTransaction,
    scope: TxScope,
    actor: Actor,
    body: DebitNoteBody,
  ): Promise<InvoiceDetail> {
    const original = await this.lockOriginal(tx, scope, body.originalInvoiceId);
    const periods = await loadTaxCodePeriods(
      tx,
      scope.tenantId,
      body.lines.map((l) => l.taxCodeId),
    );
    const priced = rangeAs400(() =>
      priceInvoice(
        {
          currency: original.currency,
          asOf: kathmanduDay(this.clock()),
          lines: body.lines,
          discount: null,
        },
        periods,
      ),
    );
    const id = await this.insertNote(tx, scope, actor, priced, original, 'debit_note', body.reason);
    return this.drafting.loadDetail(tx, scope, id);
  }

  /** Reads the original in the acting entity (404 otherwise), locks it (rank invoice) and requires an issued tax invoice. */
  private async lockOriginal(
    tx: DbTransaction,
    scope: TxScope,
    originalId: string,
  ): Promise<InvoiceRow> {
    const [probe] = await tx
      .select({ id: invoices.id })
      .from(invoices)
      .where(scoped(scope).where(invoices, eq(invoices.id, originalId)))
      .limit(1);
    if (probe === undefined) throw invoiceNotFound();
    await this.ledger.lockForMoneyCommand(tx, scope, [
      { rank: 'invoice', ids: [originalId], table: invoices },
    ]);
    const [original] = await tx
      .select()
      .from(invoices)
      .where(scoped(scope).where(invoices, eq(invoices.id, originalId)))
      .limit(1);
    if (original === undefined) throw invoiceNotFound();
    if (original.kind !== 'tax_invoice' || original.status !== 'issued') {
      throw notIssuedTaxInvoice();
    }
    return original;
  }

  private async insertNote(
    tx: DbTransaction,
    scope: TxScope,
    actor: Actor,
    priced: PricedInvoice,
    original: InvoiceRow,
    kind: NoteKind,
    reason: string,
  ): Promise<string> {
    if (original.customerPartyId === null) throw new Error(`invoice ${original.id} has no customer`);
    const owned = { tenantId: scope.tenantId, organizationId: scope.organizationId };
    const [row] = await tx
      .insert(invoices)
      .values({
        ...owned,
        kind,
        status: 'draft',
        customerPartyId: original.customerPartyId,
        salesOrderId: original.salesOrderId,
        scheduleLineId: null,
        originalInvoiceId: original.id,
        noteReason: reason,
        currency: original.currency,
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
        kind,
        customerPartyId: original.customerPartyId,
        originalInvoiceId: original.id,
        reason,
        currency: original.currency,
        total: priced.columns.total,
      },
    });
    return invoiceId;
  }
}

function notIssuedTaxInvoice() {
  return conflict('A credit or debit note is drafted only against an issued tax invoice');
}

/** Runs pure pricing and answers a RangeError (unknown line, over-quantity, unknown code) as 400, never 500. */
function rangeAs400<T>(fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    if (error instanceof RangeError) throw badRequest(error.message);
    throw error;
  }
}
