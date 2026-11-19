// NoteDraftingService (P3 unit U12 part B): drafts a credit note or a debit note against an issued tax invoice of the
// acting entity. Both then go through the shared submit (Accountant -> Finance approval) and issue routes. Serves the NFRs:
// - "amounts are exact": a credit note is priced from the original's own lines (unit price, pro-rata discount) and its
//   VAT with `creditNoteSlice`; a debit note with `priceInvoice`. Nothing priced comes from the client;
// - "a credit never exceeds the invoice" (done check 7): the original is locked first (lock order: invoice), then the
//   live credit notes on it are summed, so two concurrent credits serialise and the second sees the first. Over the
//   remaining total answers 409 CREDIT_EXCEEDS_INVOICE; the deferred `invoices_notes` trigger (0021) is the backstop
//   and its 23514 at commit maps to the same code. Under the same lock the live notes are also summed per original line
//   (quantity and taxable, through `invoice_lines.original_line_id`, 0024) and per tax code (base and VAT), so no line
//   and no code is credited twice even while the total stays under the cap (U12 part D); the 409 names the line or code;
// - "no double effects": every command runs inside withIdempotency;
// - "every change is audited": all writes run in withTx() and record `invoice.drafted`;
// - "authorization is deny-by-default": staff only, `invoice.credit_note` (debit notes share it), and the original is
//   read through the caller's `invoice.read` scope, so an invoice of another entity, or one outside that scope, is a
//   404. A note acts on its original, so `invoice.credit_note` is checked on the original's drafter (`created_by`,
//   U20a phase 2): under `own` or `department` (invoices carry no department) only on invoices the caller drafted.
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
import { and, asc, eq, isNotNull, ne, sql } from 'drizzle-orm';

import { AuditService } from '../../../platform/audit/audit.service';
import { AuthzService, scopeWhereFor } from '../../../platform/authz/authz.service';
import type { Principal } from '../../../platform/authz/principal';
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

/** 409 CREDIT_EXCEEDS_INVOICE naming the original line whose quantity or taxable the credit notes would pass. */
export const creditExceedsLine = (originalLineNo: number, leftQuantity: Dec, leftTaxable: Dec) =>
  new ConflictException({
    code: 'CREDIT_EXCEEDS_INVOICE',
    message: `Line ${originalLineNo} of the invoice has ${leftQuantity.toFixed(4)} (${money(leftTaxable)} taxable) left to credit`,
    details: {
      originalLineNo,
      remainingQuantity: leftQuantity.toFixed(4),
      remainingTaxable: money(leftTaxable),
    },
  });

/** 409 CREDIT_EXCEEDS_INVOICE naming the tax code whose base or VAT the credit notes would pass. */
export const creditExceedsTaxCode = (
  taxCodeId: string,
  label: string,
  leftBase: Dec,
  leftVat: Dec,
) =>
  new ConflictException({
    code: 'CREDIT_EXCEEDS_INVOICE',
    message: `Tax code ${label} of the invoice has ${money(leftBase)} of base and ${money(leftVat)} of VAT left to credit`,
    details: {
      taxCodeId,
      taxCode: label,
      remainingBase: money(leftBase),
      remainingVat: money(leftVat),
    },
  });

const ZERO = new Dec(0);
const money = (v: Dec): string => v.toFixed(2);
const sum = (values: readonly Dec[]): Dec => values.reduce((a, b) => a.plus(b), ZERO);
const nonNegative = (v: Dec): Dec => (v.isNegative() ? ZERO : v);

/**
 * What the credit notes of one invoice have credited so far: per original line id (quantity and taxable) and per tax
 * code id of the original's tax summary (base and VAT). Built by `loadCredited`.
 */
export interface CreditedSoFar {
  byLine: ReadonlyMap<string, { quantity: Dec; taxable: Dec }>;
  byTaxCode: ReadonlyMap<string, { base: Dec; tax: Dec }>;
}
export const NOTHING_CREDITED: CreditedSoFar = { byLine: new Map(), byTaxCode: new Map() };

/** A credit-note line: an invoice line that names the original line it credits. */
export type PricedCreditNoteLine = PricedInvoiceLine & { originalLineId: string };
export interface PricedCreditNote extends PricedInvoice {
  lines: PricedCreditNoteLine[];
}

/** The lines and tax rows of an issued invoice or of one note, as stored. */
export interface StoredParts {
  lines: readonly Pick<
    InvoiceLineRow,
    'id' | 'lineNo' | 'quantity' | 'taxable' | 'originalLineId'
  >[];
  taxSummary: readonly Pick<InvoiceTaxSummaryRow, 'taxCodeId' | 'label' | 'base' | 'tax'>[];
}

/** `credited` with one more note's lines and tax rows added. */
export function withNote(credited: CreditedSoFar, note: StoredParts): CreditedSoFar {
  const byLine = new Map(credited.byLine);
  for (const l of note.lines) {
    if (l.originalLineId === null) continue;
    const had = byLine.get(l.originalLineId);
    byLine.set(l.originalLineId, {
      quantity: (had?.quantity ?? ZERO).plus(l.quantity),
      taxable: (had?.taxable ?? ZERO).plus(l.taxable),
    });
  }
  const byTaxCode = new Map(credited.byTaxCode);
  for (const t of note.taxSummary) {
    const had = byTaxCode.get(t.taxCodeId);
    byTaxCode.set(t.taxCodeId, {
      base: (had?.base ?? ZERO).plus(t.base),
      tax: (had?.tax ?? ZERO).plus(t.tax),
    });
  }
  return { byLine, byTaxCode };
}

/**
 * The 409 to answer when `before` plus `note` credits more of an original line (quantity or taxable) or of a tax code
 * (base or VAT) than the original has, naming the first such line or code; null when every line and code holds. The
 * remaining amounts in the answer are what `before` leaves.
 */
export function creditCapExcess(
  original: StoredParts,
  before: CreditedSoFar,
  note: StoredParts,
): ConflictException | null {
  const after = withNote(before, note);
  for (const l of original.lines) {
    const done = after.byLine.get(l.id);
    if (done === undefined) continue;
    if (done.quantity.gt(l.quantity) || done.taxable.gt(l.taxable)) {
      const had = before.byLine.get(l.id);
      return creditExceedsLine(
        l.lineNo,
        nonNegative(new Dec(l.quantity).minus(had?.quantity ?? ZERO)),
        nonNegative(new Dec(l.taxable).minus(had?.taxable ?? ZERO)),
      );
    }
  }
  for (const t of original.taxSummary) {
    const done = after.byTaxCode.get(t.taxCodeId);
    if (done === undefined) continue;
    if (done.base.gt(t.base) || done.tax.gt(t.tax)) {
      const had = before.byTaxCode.get(t.taxCodeId);
      return creditExceedsTaxCode(
        t.taxCodeId,
        t.label,
        nonNegative(new Dec(t.base).minus(had?.base ?? ZERO)),
        nonNegative(new Dec(t.tax).minus(had?.tax ?? ZERO)),
      );
    }
  }
  return null;
}

/** True when `credited` covers the whole quantity of every line of the original: the invoice is credited in full. */
export function creditsEveryLine(
  originalLines: StoredParts['lines'],
  credited: CreditedSoFar,
): boolean {
  return (
    originalLines.length > 0 &&
    originalLines.every((l) => (credited.byLine.get(l.id)?.quantity ?? ZERO).gte(l.quantity))
  );
}

/**
 * Sums what the credit notes of `originalId` have credited, per original line and per tax code: the live (not
 * discarded) notes, or only the issued ones, never `excludeNoteId`. Credit-note lines drafted before 0024 name no
 * original line and count only toward the total cap. Call it with the original locked, so the sums cannot move.
 */
export async function loadCredited(
  tx: DbTransaction,
  scope: TxScope,
  originalId: string,
  options: { issuedOnly: boolean; excludeNoteId?: string },
): Promise<CreditedSoFar> {
  const notesOfOriginal = and(
    eq(invoices.tenantId, scope.tenantId),
    eq(invoices.organizationId, scope.organizationId),
    eq(invoices.originalInvoiceId, originalId),
    eq(invoices.kind, 'credit_note'),
    options.issuedOnly ? eq(invoices.status, 'issued') : ne(invoices.status, 'discarded'),
    options.excludeNoteId === undefined ? undefined : ne(invoices.id, options.excludeNoteId),
  );
  const ofNote = (t: typeof invoiceLines | typeof invoiceTaxSummary) =>
    and(
      eq(invoices.tenantId, t.tenantId),
      eq(invoices.organizationId, t.organizationId),
      eq(invoices.id, t.invoiceId),
    );
  const lineRows = await tx
    .select({
      originalLineId: invoiceLines.originalLineId,
      quantity: sql<string>`sum(${invoiceLines.quantity})::text`,
      taxable: sql<string>`sum(${invoiceLines.taxable})::text`,
    })
    .from(invoiceLines)
    .innerJoin(invoices, ofNote(invoiceLines))
    .where(and(notesOfOriginal, isNotNull(invoiceLines.originalLineId)))
    .groupBy(invoiceLines.originalLineId);
  const taxRows = await tx
    .select({
      taxCodeId: invoiceTaxSummary.taxCodeId,
      base: sql<string>`sum(${invoiceTaxSummary.base})::text`,
      tax: sql<string>`sum(${invoiceTaxSummary.tax})::text`,
    })
    .from(invoiceTaxSummary)
    .innerJoin(invoices, ofNote(invoiceTaxSummary))
    .where(notesOfOriginal)
    .groupBy(invoiceTaxSummary.taxCodeId);
  return {
    byLine: new Map(
      lineRows.map((r) => [
        r.originalLineId!,
        { quantity: new Dec(r.quantity), taxable: new Dec(r.taxable) },
      ]),
    ),
    byTaxCode: new Map(
      taxRows.map((r) => [r.taxCodeId, { base: new Dec(r.base), tax: new Dec(r.tax) }]),
    ),
  };
}

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
 * Earlier credit notes (`credited`) are taken into account: a line or a tax code is never credited past what is left on
 * it (409 CREDIT_EXCEEDS_INVOICE naming it), and the credit that completes a line takes exactly the taxable left on it
 * (the one that completes a code exactly the VAT left on it), so the notes add up to the invoice to the paisa however
 * the earlier ones rounded. Each line names the original line it credits.
 * Throws RangeError for an unknown line, a quantity above the original's, or a bucket over-credited.
 */
export function priceCreditNote(
  original: { lines: readonly InvoiceLineRow[]; taxSummary: readonly InvoiceTaxSummaryRow[] },
  periods: readonly InvoiceTaxCodeRow[],
  requested: CreditNoteBody['lines'],
  credited: CreditedSoFar = NOTHING_CREDITED,
): PricedCreditNote {
  const periodById = new Map(periods.map((p) => [p.id, p]));
  const periodOf = (id: string): InvoiceTaxCodeRow => {
    const found = periodById.get(id);
    if (found === undefined) throw new RangeError(`Unknown tax code id: ${id}`);
    return found;
  };
  const byLineNo = new Map(original.lines.map((l) => [l.lineNo, l]));
  const ordered = [...requested].sort((a, b) => a.originalLineNo - b.originalLineNo);

  const lines: PricedCreditNoteLine[] = ordered.map((req, i) => {
    const src = byLineNo.get(req.originalLineNo);
    if (src === undefined) {
      throw new RangeError(`Line ${req.originalLineNo} is not on the original invoice.`);
    }
    const qty = new Dec(req.quantity);
    const srcQty = new Dec(src.quantity);
    if (qty.lte(0))
      throw new RangeError(`Line ${req.originalLineNo}: the quantity must be above 0.`);
    if (qty.gt(srcQty)) {
      throw new RangeError(
        `Line ${req.originalLineNo}: credits ${qty.toFixed(4)} of the ${srcQty.toFixed(4)} invoiced.`,
      );
    }
    const prior = credited.byLine.get(src.id);
    const leftQty = nonNegative(srcQty.minus(prior?.quantity ?? ZERO));
    const leftTaxable = nonNegative(new Dec(src.taxable).minus(prior?.taxable ?? ZERO));
    if (qty.gt(leftQty)) throw creditExceedsLine(req.originalLineNo, leftQty, leftTaxable);
    const unitPrice = new Dec(src.unitPrice);
    const gross = roundMoney(qty.times(unitPrice));
    // The least discount that keeps the taxable within what is left on the line. The credit that completes the line
    // takes exactly that (on a first, whole-line credit it is the line's own discount); a partial one takes its
    // pro-rata share of the discount, raised to it if the earlier credits rounded up.
    const least = gross.minus(leftTaxable);
    const discount = qty.eq(leftQty)
      ? least
      : Dec.max(roundMoney(new Dec(src.discountAlloc).times(qty).div(srcQty)), least);
    const discountAlloc = Dec.min(nonNegative(discount), gross);
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
      originalLineId: src.id,
    };
  });

  // Per tax code: never more base than is left on the original's bucket after the earlier notes.
  const requestedByCode = new Map<string, Dec>();
  for (const l of lines) {
    const code = periodOf(l.taxCodeId).code;
    requestedByCode.set(code, (requestedByCode.get(code) ?? ZERO).plus(l.taxable));
  }
  const leftOf = (s: InvoiceTaxSummaryRow) => {
    const prior = credited.byTaxCode.get(s.taxCodeId);
    return {
      base: nonNegative(new Dec(s.base).minus(prior?.base ?? ZERO)),
      vat: nonNegative(new Dec(s.tax).minus(prior?.tax ?? ZERO)),
    };
  };
  for (const s of original.taxSummary) {
    const left = leftOf(s);
    if ((requestedByCode.get(periodOf(s.taxCodeId).code) ?? ZERO).gt(left.base)) {
      throw creditExceedsTaxCode(s.taxCodeId, s.label, left.base, left.vat);
    }
  }

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

  // The credit that completes a code takes exactly the VAT left on it; no credit takes more VAT than is left.
  const buckets: TaxBucket[] = slice.buckets.map((bucket, i) => {
    if (bucket.taxable.isZero()) return bucket;
    const left = leftOf(original.taxSummary[i]!);
    const vat = bucket.taxable.eq(left.base) ? left.vat : Dec.min(bucket.vat, left.vat);
    return { ...bucket, vat };
  });
  const taxableTotal = sum(buckets.map((b) => b.taxable));
  const vatTotal = sum(buckets.map((b) => b.vat));

  const taxSummary: PricedInvoiceTaxRow[] = [];
  buckets.forEach((bucket, i) => {
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
    sum(buckets.filter((b) => kinds.includes(b.taxCode.kind)).map((b) => b.taxable));
  const columns: InvoiceColumns = {
    subtotal: money(sum(lines.map((l) => new Dec(l.gross)))),
    discountAmount: money(sum(lines.map((l) => new Dec(l.discountAlloc)))),
    taxableVatAmount: money(of('vat')),
    // Reverse charge is booked as exempt, as on the invoice: no VAT is charged.
    exemptAmount: money(of('exempt', 'reverse_charge')),
    zeroRatedAmount: money(of('zero')),
    taxAmount: money(vatTotal),
    total: money(taxableTotal.plus(vatTotal)),
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
    return this.run('invoice.credit_note', body, idempotencyKey, (tx, scope, actor, principal) =>
      this.creditInTx(tx, scope, actor, principal, body),
    );
  }

  /** 201 with the InvoiceDetail of a debit-note draft priced from typed lines; 404 / 409 as for a credit note. */
  async draftDebitNote(body: DebitNoteBody, idempotencyKey: string): Promise<InvoiceDetail> {
    return this.run('invoice.debit_note', body, idempotencyKey, (tx, scope, actor, principal) =>
      this.debitInTx(tx, scope, actor, principal, body),
    );
  }

  private async run(
    command: string,
    body: object,
    idempotencyKey: string,
    work: (
      tx: DbTransaction,
      scope: TxScope,
      actor: Actor,
      principal: Principal,
    ) => Promise<InvoiceDetail>,
  ): Promise<InvoiceDetail> {
    const { scope, actor, principal } = this.caller.current();
    assertStaff(principal);
    // The grant alone here; the record check on the original runs once it is read (lockOriginal).
    this.authz.assert('invoice.credit_note');
    try {
      return await withTx(this.db, scope, actor, async (tx) => {
        const done = await withIdempotency(
          tx,
          { command, key: idempotencyKey, body },
          async () => ({ status: 201, response: await work(tx, scope, actor, principal) }),
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
    principal: Principal,
    body: CreditNoteBody,
  ): Promise<InvoiceDetail> {
    const original = await this.lockOriginal(tx, scope, principal, body.originalInvoiceId);
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
    // The original is locked, so no credit note on it can appear or change until this transaction ends.
    const creditedSoFar = await loadCredited(tx, scope, original.id, { issuedOnly: false });
    const priced = rangeAs400(() =>
      priceCreditNote({ lines, taxSummary }, periods, body.lines, creditedSoFar),
    );

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

    const id = await this.insertNote(
      tx,
      scope,
      actor,
      priced,
      original,
      'credit_note',
      body.reason,
    );
    return this.drafting.loadDetail(tx, scope, id);
  }

  private async debitInTx(
    tx: DbTransaction,
    scope: TxScope,
    actor: Actor,
    principal: Principal,
    body: DebitNoteBody,
  ): Promise<InvoiceDetail> {
    const original = await this.lockOriginal(tx, scope, principal, body.originalInvoiceId);
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

  /**
   * Reads the original under the caller's `invoice.read` scope (404 otherwise, as GET answers), checks
   * `invoice.credit_note` on its drafter (403), locks it (rank invoice) and requires an issued tax invoice.
   */
  private async lockOriginal(
    tx: DbTransaction,
    scope: TxScope,
    principal: Principal,
    originalId: string,
  ): Promise<InvoiceRow> {
    const [probe] = await tx
      .select({ id: invoices.id, createdBy: invoices.createdBy })
      .from(invoices)
      .where(and(scopeWhereFor(principal, invoices, 'invoice.read'), eq(invoices.id, originalId)))
      .limit(1);
    if (probe === undefined) throw invoiceNotFound();
    this.authz.assert('invoice.credit_note', { ...scope, ownerUserId: probe.createdBy });
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
    priced: PricedInvoice | PricedCreditNote,
    original: InvoiceRow,
    kind: NoteKind,
    reason: string,
  ): Promise<string> {
    if (original.customerPartyId === null)
      throw new Error(`invoice ${original.id} has no customer`);
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
    const lines: readonly (PricedInvoiceLine & { originalLineId?: string })[] = priced.lines;
    await tx.insert(invoiceLines).values(
      lines.map(({ catalogItemId: _catalogItemId, originalLineId, ...line }) => ({
        ...owned,
        invoiceId,
        ...line,
        originalLineId: originalLineId ?? null,
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
