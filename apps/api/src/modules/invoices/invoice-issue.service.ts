// InvoiceIssueService: THE issue entry point of an invoice (P3 units U10 and U6). The route is
// `POST /v1/invoices/:id/issue` and needs `invoice.issue`. It locks the invoice, then switches on its kind:
// - `proforma` (U10, plan A12): draft -> issued with a PI number, no approval, no open item, no posting event;
// - `tax_invoice`, `debit_note` (U6, plan A5): approved -> issued after Accountant -> Finance approval. Locks sales
//   order -> schedule line -> invoice, then FX snapshot (409 fx_rate_stale), BS date, snapshots, hash, the INV / DN
//   number as the LAST lock, the receivable debit and its posting event through LedgerService, and schedule line ->
//   invoiced. Anything not approved answers NOT_APPROVED;
// - `credit_note` (U12 part C): approved -> issued by CreditNoteIssueService, which takes its own locks (sales order ->
//   the original's schedule line -> the original and the note -> open items), releases payment allocations the credit
//   needs, opens and allocates the receivable credit and, on a full credit, gives the schedule line back.
// Serves the NFRs "an issued invoice never changes" (one UPDATE sets every issue field at once: invoices_guard freezes
// the row afterwards) and "no gaps in a numbered series" (NumberingService.issue is the last row lock).
import {
  CountryCodeSchema,
  type IssueInvoiceBody,
  type IssueInvoiceResult,
  PrintAddressSchema,
} from '@bos/contracts';
import {
  billingScheduleLines,
  customers,
  invoiceLines,
  invoices,
  invoiceTaxSummary,
  organizations,
  partyAccounts,
  paymentTerms,
  salesOrders,
  scoped,
} from '@bos/db';
import { formatBs } from '@bos/locale';
import { Inject, Injectable, Optional, UnprocessableEntityException } from '@nestjs/common';
import { and, asc, eq, sql } from 'drizzle-orm';

import { AuditService } from '../../platform/audit/audit.service';
import { AuthzService, scopeWhereFor } from '../../platform/authz/authz.service';
import { DB, type Db, type DbTransaction } from '../../platform/db/db.module';
import { updateVersioned, withIdempotency } from '../../platform/db/idempotency';
import { withTx, type Actor, type TxScope } from '../../platform/db/tx';
import { canonicalSha256 } from '../../platform/hashing/canonical-json';
import { MoneyService } from '../../platform/settings/money.service';
import { NumberingService } from '../../platform/settings/numbering.service';
import { SettingsService } from '../../platform/settings/settings.service';
import { LedgerService } from '../ledger/ledger.service';
import { buildIssuer, IssuerIncompleteError } from '../quotations/render/issuer';
import { CreditNoteIssueService } from './notes/credit-note-issue.service';
import { InvoiceRenderNudge } from './render/invoice-render.nudge';
import { creditExceedsInvoice } from './notes/note-drafting.service';
import {
  assertStaff,
  conflict,
  createdThisNote,
  dueDateBeforeIssue,
  formatAddress,
  INVOICE_CLOCK,
  InvoiceCaller,
  invoiceNotFound,
  kathmanduDay,
  notApproved,
  noteIssuerIsCreator,
  pgError,
} from './invoice-support';

/** The numbering series of a proforma: PI-2083/84-00001 (plan A15). */
export const PROFORMA_SERIES = 'PI';
/** The numbering series of a tax invoice and a debit note: INV-2083/84-00001, DN-2083/84-00001 (plan A15). */
export const TAX_INVOICE_SERIES = 'INV';
export const DEBIT_NOTE_SERIES = 'DN';

/** `YYYY-MM-DD` plus `days` calendar days (UTC arithmetic on a date with no time, so no zone shift). */
export function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Whole calendar days from one `YYYY-MM-DD` to a later one (UTC arithmetic, so no zone shift). */
function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

type InvoiceRow = typeof invoices.$inferSelect;

/** What every kind freezes at issue: the NPR value and the seller and buyer snapshots. */
export interface IssueSnapshot {
  fxRate: string;
  fxSource: string | null;
  fxDate: string | null;
  amountNpr: string;
  sellerSnapshot: { legalName: string; panVatNo: string | null; address: string | null };
  buyerSnapshot: { legalName: string; panVatNo: string | null; address: string | null };
}

@Injectable()
export class InvoiceIssueService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly authz: AuthzService,
    private readonly audit: AuditService,
    private readonly caller: InvoiceCaller,
    private readonly ledger: LedgerService,
    private readonly numbering: NumberingService,
    private readonly money: MoneyService,
    private readonly settings: SettingsService,
    @Optional() @Inject(INVOICE_CLOCK) private readonly clock: () => Date = () => new Date(),
    // Optional so callers that build this service by hand (tests) keep their argument list.
    @Optional() creditNotes?: CreditNoteIssueService,
    // Optional for the same reason: a hand-built service renders on the sweep alone.
    @Optional() private readonly renderNudge?: InvoiceRenderNudge,
  ) {
    this.creditNotes = creditNotes ?? new CreditNoteIssueService(audit, ledger, numbering);
  }

  private readonly creditNotes: CreditNoteIssueService;

  /**
   * `issued` the first time, `already_issued` (with the same number) for a replay or a second click. 404 outside the
   * entity, 403 without `invoice.issue`, 409 for a stale `expectedVersion`, a status that is not draft or a kind that
   * needs approval first (NOT_APPROVED), 422 DUE_DATE_BEFORE_ISSUE for a due date before today.
   */
  async issue(
    id: string,
    body: IssueInvoiceBody,
    idempotencyKey: string,
  ): Promise<IssueInvoiceResult> {
    const { scope, actor, principal } = this.caller.current();
    assertStaff(principal);
    this.authz.assert('invoice.issue', scope);
    const now = this.clock();
    let result: IssueInvoiceResult;
    try {
      result = await withTx(this.db, scope, actor, async (tx) => {
        // The route check carries no owner, so a grant narrowed to own or department is judged here against the
        // drafter; an invoice outside the caller's read is a 404.
        const [owned] = await tx
          .select({ createdBy: invoices.createdBy })
          .from(invoices)
          .where(and(scopeWhereFor(principal, invoices, 'invoice.read'), eq(invoices.id, id)))
          .limit(1);
        if (owned === undefined) throw invoiceNotFound();
        this.authz.assert('invoice.issue', { ...scope, ownerUserId: owned.createdBy });
        const done = await withIdempotency(
          tx,
          { command: 'invoice.issue', key: idempotencyKey, body: { id, ...body } },
          async () => ({
            status: 200,
            response: await this.issueInTx(tx, scope, actor, id, body, now),
          }),
        );
        return done.response;
      });
    } catch (error) {
      // invoices_due_date_check: a draft whose due date has passed since it was drafted.
      const pg = pgError(error);
      // invoices_notes (deferred, at commit): the credit notes of an invoice would total more than it.
      if (pg?.code === '23514' && pg.constraint === 'invoices_credit_cap_check') {
        throw creditExceedsInvoice();
      }
      if (pg?.code === '23514' && pg.constraint === 'invoices_due_date_check') {
        throw dueDateBeforeIssue();
      }
      throw error;
    }
    // After the commit, so the worker sees the issued row: render the PDF now rather than on the next sweep. A replay
    // answers `issued` again and nudges again; the worker skips an invoice whose PDF is already live.
    if (result.kind === 'issued') await this.renderNudge?.nudge(scope, result.invoiceId);
    return result;
  }

  private async issueInTx(
    tx: DbTransaction,
    scope: TxScope,
    actor: Actor,
    id: string,
    body: IssueInvoiceBody,
    now: Date,
  ): Promise<IssueInvoiceResult> {
    // Read the head without a lock to learn which order and schedule line to lock, then take every lock in one call
    // in the plan's order (sales order -> schedule line -> invoice), the same order as discard, so the two never
    // deadlock. A proforma has neither and locks the invoice alone.
    const [head] = await tx
      .select({
        kind: invoices.kind,
        originalInvoiceId: invoices.originalInvoiceId,
        salesOrderId: invoices.salesOrderId,
        scheduleLineId: invoices.scheduleLineId,
      })
      .from(invoices)
      .where(scoped(scope).where(invoices, eq(invoices.id, id)))
      .limit(1);
    if (head === undefined) throw invoiceNotFound();
    // A credit note also locks its original (and the original's schedule line, which ranks before invoices), so it
    // takes all its locks in its own service. The kind never changes (invoices_identity_check), so this unlocked read
    // is safe.
    if (head.kind === 'credit_note') {
      if (head.originalInvoiceId === null) throw new Error('a credit note has no original invoice');
      return this.creditNotes.issueInTx(
        tx,
        scope,
        actor,
        id,
        head.originalInvoiceId,
        body,
        now,
        (t, s, invoice, issued, parties) =>
          this.contentHashOf(
            t,
            s,
            invoice,
            issued,
            parties as Pick<IssueSnapshot, 'sellerSnapshot' | 'buyerSnapshot'>,
          ),
      );
    }
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
    switch (invoice.kind) {
      case 'proforma':
        return this.issueProforma(tx, scope, actor, invoice, body, now);
      case 'tax_invoice':
      case 'debit_note':
        return this.issueApproved(tx, scope, actor, invoice, body, now);
      case 'credit_note':
        // Handed to CreditNoteIssueService above, before any lock.
        throw new Error('a credit note is issued by CreditNoteIssueService');
    }
  }

  /**
   * A tax invoice or debit note that Accountant -> Finance approved (plan A5): approved -> issued in one transaction.
   * The FX snapshot comes before the number so a stale rate (409 fx_rate_stale) consumes nothing. The number is the
   * last row lock: the open item, the posting event and the schedule line follow it in the same transaction (inserts,
   * and an UPDATE of the schedule line this transaction already holds, so no new row lock is waited on), and a
   * failure after numbering rolls the number back with everything else.
   */
  private async issueApproved(
    tx: DbTransaction,
    scope: TxScope,
    actor: Actor,
    invoice: InvoiceRow,
    body: IssueInvoiceBody,
    now: Date,
  ): Promise<IssueInvoiceResult> {
    // Replay, second caller or double click: the number it has, before looking at the version the caller held.
    if (invoice.status === 'issued' && invoice.number !== null) {
      return { kind: 'already_issued', invoiceId: invoice.id, number: invoice.number };
    }
    if (invoice.status !== 'approved') throw notApproved();
    if (createdThisNote(invoice, actor.kind === 'user' ? actor.id : null)) {
      throw noteIssuerIsCreator();
    }
    if (invoice.version !== body.expectedVersion) {
      throw conflict('This invoice was changed by someone else; reload it and try again');
    }
    if (invoice.customerPartyId === null) throw new Error('the invoice has no customer');
    const issueDate = kathmanduDay(now);
    const dueDate = await this.dueDateOf(tx, scope, invoice, issueDate);
    const snapshot = await this.issueSnapshot(tx, scope, invoice, now);
    // The series is the last row lock of the transaction (plan section 2).
    const sourceType = invoice.kind === 'debit_note' ? 'debit_note' : 'tax_invoice';
    const series = sourceType === 'debit_note' ? DEBIT_NOTE_SERIES : TAX_INVOICE_SERIES;
    const { number, seq, fiscalYear } = await this.numbering.issue(tx, series, now);
    const contentHash = await this.contentHashOf(
      tx,
      scope,
      invoice,
      { number, issueDate },
      snapshot,
    );
    // Conditional approved -> issued: updateVersioned matches the version read under the lock, and this one UPDATE
    // sets every issue field (invoices_issued_check ties the status to the number).
    await updateVersioned(tx, invoices, invoice.id, body.expectedVersion, {
      status: 'issued',
      number,
      seq,
      fiscalYear,
      issueDate,
      issueDateBs: formatBs(now, 'YYYY-MM-DD'),
      dueDate,
      issuedAt: now,
      issuedBy: actor.kind === 'user' ? actor.id : null,
      ...snapshot,
      contentHash,
    });
    // What the customer owes: a receivable debit (plan A1), through the ledger only.
    const { item } = await this.ledger.openItem(tx, scope, actor, {
      side: 'receivable',
      direction: 'debit',
      partyId: invoice.customerPartyId,
      sourceType,
      sourceId: invoice.id,
      currency: invoice.currency,
      amount: invoice.total,
      amountNpr: snapshot.amountNpr,
      fxRate: snapshot.fxRate,
      fxSource: snapshot.fxSource,
      fxDate: snapshot.fxDate,
      documentDate: issueDate,
      dueDate,
    });
    await this.ledger.recordEvent(tx, scope, actor, {
      sourceType,
      sourceId: invoice.id,
      event: invoice.kind === 'debit_note' ? 'debit_note_issued' : 'invoice_issued',
      payload: {
        openItemId: item.id,
        number,
        currency: invoice.currency,
        total: invoice.total,
        taxAmount: invoice.taxAmount,
        amountNpr: snapshot.amountNpr,
        fxRate: snapshot.fxRate,
        issueDate,
        dueDate,
      },
    });
    if (invoice.scheduleLineId !== null) {
      // The line was locked above; billing_schedule_lines_invoice_check keeps invoice_id while invoiced.
      const moved = await tx
        .update(billingScheduleLines)
        .set({
          status: 'invoiced',
          version: sql`${billingScheduleLines.version} + 1`,
          updatedAt: sql`now()`,
        })
        .where(
          scoped(scope).where(
            billingScheduleLines,
            and(
              eq(billingScheduleLines.id, invoice.scheduleLineId),
              eq(billingScheduleLines.invoiceId, invoice.id),
              eq(billingScheduleLines.status, 'drafted'),
            ),
          ),
        )
        .returning({ id: billingScheduleLines.id });
      if (moved.length === 0) throw conflict('The schedule line of this invoice is not drafted');
    }
    // No render row is written here: app.outbox carries email only and invoices have no render state yet. The PDF
    // job (U11) finds issued invoices without a rendered document, as the quotation render sweeper does.
    await this.audit.record(tx, {
      action: invoice.kind === 'debit_note' ? 'invoice.debit_note_issued' : 'invoice.issued',
      entityType: 'invoices',
      entityId: invoice.id,
      before: { status: 'approved', version: invoice.version },
      after: { status: 'issued', number, issueDate, dueDate, total: invoice.total },
    });
    return { kind: 'issued', invoiceId: invoice.id, number };
  }

  /**
   * The due date at issue. A debit note is a further charge, so it follows the customer's payment terms with this entity
   * (TR-Q12c): issue date + the term's net days. A customer with no term here gets the credit period of the original
   * invoice (its due date less its issue date), and an original due on receipt makes the note due on issue.
   *
   * Any other kind: issue date + the order's credit days when the invoice has a sales order; otherwise the
   * drafted due date (422 DUE_DATE_BEFORE_ISSUE when it is already past), or the issue date when none was drafted (due
   * on receipt).
   */
  private async dueDateOf(
    tx: DbTransaction,
    scope: TxScope,
    invoice: InvoiceRow,
    issueDate: string,
  ): Promise<string> {
    if (invoice.kind === 'debit_note' && invoice.customerPartyId !== null) {
      const [term] = await tx
        .select({ netDays: paymentTerms.netDays })
        .from(partyAccounts)
        .innerJoin(
          paymentTerms,
          and(
            eq(paymentTerms.tenantId, partyAccounts.tenantId),
            eq(paymentTerms.id, partyAccounts.paymentTermId),
          ),
        )
        .where(
          scoped(scope).where(partyAccounts, eq(partyAccounts.partyId, invoice.customerPartyId)),
        )
        .limit(1);
      if (term !== undefined) return addDays(issueDate, term.netDays);
      // No term with this entity: the credit period the customer was given on the invoice this note adds to.
      if (invoice.originalInvoiceId !== null) {
        const [original] = await tx
          .select({ issueDate: invoices.issueDate, dueDate: invoices.dueDate })
          .from(invoices)
          .where(scoped(scope).where(invoices, eq(invoices.id, invoice.originalInvoiceId)))
          .limit(1);
        if (original?.issueDate && original.dueDate) {
          return addDays(issueDate, daysBetween(original.issueDate, original.dueDate));
        }
      }
      return issueDate;
    }
    if (invoice.salesOrderId !== null) {
      const [order] = await tx
        .select({ creditDays: salesOrders.creditDays })
        .from(salesOrders)
        .where(scoped(scope).where(salesOrders, eq(salesOrders.id, invoice.salesOrderId)))
        .limit(1);
      if (order === undefined) throw new Error('the invoice names a sales order that is missing');
      return addDays(issueDate, order.creditDays);
    }
    if (invoice.dueDate === null) return issueDate;
    if (invoice.dueDate < issueDate)
      throw dueDateBeforeIssue({ dueDate: invoice.dueDate, issueDate });
    return invoice.dueDate;
  }

  private async issueProforma(
    tx: DbTransaction,
    scope: TxScope,
    actor: Actor,
    invoice: InvoiceRow,
    body: IssueInvoiceBody,
    now: Date,
  ): Promise<IssueInvoiceResult> {
    // Replay or double click: answer with the number it has, before looking at the version the caller held.
    if (invoice.status === 'issued' && invoice.number !== null) {
      return { kind: 'already_issued', invoiceId: invoice.id, number: invoice.number };
    }
    if (invoice.status !== 'draft') throw conflict(`A ${invoice.status} proforma cannot be issued`);
    if (invoice.version !== body.expectedVersion) {
      throw conflict('This invoice was changed by someone else; reload it and try again');
    }
    const snapshot = await this.issueSnapshot(tx, scope, invoice, now);
    // The series is the last row lock of the transaction (plan section 2).
    const { number, seq, fiscalYear } = await this.numbering.issue(tx, PROFORMA_SERIES, now);
    const issueDate = kathmanduDay(now);
    const contentHash = await this.contentHashOf(
      tx,
      scope,
      invoice,
      { number, issueDate },
      snapshot,
    );
    await updateVersioned(tx, invoices, invoice.id, body.expectedVersion, {
      status: 'issued',
      number,
      seq,
      fiscalYear,
      issueDate,
      issueDateBs: formatBs(now, 'YYYY-MM-DD'),
      issuedAt: now,
      issuedBy: actor.kind === 'user' ? actor.id : null,
      ...snapshot,
      contentHash,
    });
    await this.audit.record(tx, {
      action: 'invoice.proforma_issued',
      entityType: 'invoices',
      entityId: invoice.id,
      before: { status: 'draft', version: invoice.version },
      after: { status: 'issued', number, issueDate, total: invoice.total },
    });
    return { kind: 'issued', invoiceId: invoice.id, number };
  }

  /** The NPR value (409 fx_rate_stale when the rate is old) and the seller and buyer as they are today. */
  async issueSnapshot(
    tx: DbTransaction,
    scope: TxScope,
    invoice: Pick<InvoiceRow, 'total' | 'currency' | 'customerPartyId'>,
    now: Date,
  ): Promise<IssueSnapshot> {
    const fx = await this.money.toNprSnapshot(
      tx,
      scope,
      { amount: invoice.total, currency: invoice.currency },
      now,
    );
    const [org] = await tx
      .select({ legalName: organizations.legalName })
      .from(organizations)
      .where(
        and(eq(organizations.tenantId, scope.tenantId), eq(organizations.id, scope.organizationId)),
      )
      .limit(1);
    if (org === undefined) throw new Error('the acting entity has no organizations row');
    let issuer;
    try {
      issuer = await buildIssuer(this.settings, scope, org.legalName);
    } catch (error) {
      if (error instanceof IssuerIncompleteError) {
        throw new UnprocessableEntityException({
          code: 'unprocessable',
          message: `The issuing entity has no ${error.missing} set`,
        });
      }
      throw error;
    }
    const [customer] =
      invoice.customerPartyId === null
        ? []
        : await tx
            .select({
              legalName: customers.legalName,
              panVatNo: customers.panVatNo,
              country: customers.country,
              addressLine: customers.addressLine,
              addressCity: customers.addressCity,
            })
            .from(customers)
            .where(
              and(
                eq(customers.tenantId, scope.tenantId),
                eq(customers.id, invoice.customerPartyId),
              ),
            )
            .limit(1);
    if (customer === undefined) throw new Error('the invoice has no customer record');
    const nprIsBooks = invoice.currency === 'NPR';
    // Both snapshots print the address as the PDF does: the country is left out when it is the entity's own.
    const sellerAddress = PrintAddressSchema.parse(issuer.address);
    const ownCountry = sellerAddress.country;
    const buyerAddress = {
      line: customer.addressLine,
      city: customer.addressCity,
      country: CountryCodeSchema.parse(customer.country),
    };
    return {
      fxRate: fx.rate,
      fxSource: nprIsBooks ? null : fx.rateSource,
      fxDate: nprIsBooks ? null : fx.rateDate,
      amountNpr: fx.amountNpr,
      sellerSnapshot: {
        legalName: issuer.legalName,
        panVatNo: issuer.panVatNo,
        address: formatAddress(sellerAddress, ownCountry),
      },
      buyerSnapshot: {
        legalName: customer.legalName,
        panVatNo: customer.panVatNo,
        address: formatAddress(buyerAddress, ownCountry),
      },
    };
  }

  /** SHA-256 over the canonical content the customer is shown: number, date, parties, lines, tax and totals. */
  async contentHashOf(
    tx: DbTransaction,
    scope: TxScope,
    invoice: InvoiceRow,
    issued: { number: string; issueDate: string },
    snapshot: Pick<IssueSnapshot, 'sellerSnapshot' | 'buyerSnapshot'>,
  ): Promise<Buffer> {
    const child = (t: typeof invoiceLines | typeof invoiceTaxSummary) =>
      and(
        eq(t.tenantId, scope.tenantId),
        eq(t.organizationId, scope.organizationId),
        eq(t.invoiceId, invoice.id),
      );
    const lines = await tx
      .select()
      .from(invoiceLines)
      .where(child(invoiceLines))
      .orderBy(asc(invoiceLines.lineNo));
    const tax = await tx.select().from(invoiceTaxSummary).where(child(invoiceTaxSummary));
    return canonicalSha256({
      kind: invoice.kind,
      number: issued.number,
      issueDate: issued.issueDate,
      currency: invoice.currency,
      customerPartyId: invoice.customerPartyId,
      seller: snapshot.sellerSnapshot,
      buyer: snapshot.buyerSnapshot,
      lines: lines.map((l) => [
        l.lineNo,
        l.description,
        l.uom,
        l.quantity,
        l.unitPrice,
        l.taxCodeId,
        l.gross,
        l.discountAlloc,
        l.taxable,
      ]),
      taxSummary: tax
        .map((t) => [t.taxCodeId, t.label, t.rate, t.base, t.tax])
        .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
      totals: [
        invoice.subtotal,
        invoice.discountAmount,
        invoice.taxableVatAmount,
        invoice.exemptAmount,
        invoice.zeroRatedAmount,
        invoice.taxAmount,
        invoice.total,
      ],
      calcVersion: invoice.calcVersion,
    });
  }
}
