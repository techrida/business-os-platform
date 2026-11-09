// InvoiceIssueService: THE issue entry point of an invoice (P3 units U10 and U6). The route is
// `POST /v1/invoices/:id/issue` and needs `invoice.issue`. It locks the invoice, then switches on its kind:
// - `proforma` (U10, plan A12): draft -> issued with a PI number, no approval, no open item, no posting event;
// - `tax_invoice`, `credit_note`, `debit_note`: NOT_APPROVED for now. **U6 extends the `switch (invoice.kind)` in
//   `issueInTx` below**: add a case that locks sales order -> schedule line first (before the invoice lock, which this
//   method takes first for a proforma, a kind with no order lock to take), requires status `approved`, then does the
//   plan's steps (FX snapshot, BS date, snapshots, hash, number as the LAST lock, open item and event through
//   LedgerService, schedule line -> invoiced, outbox render). `issueSnapshot` and `contentHashOf` below are reusable.
// Serves the NFRs "an issued invoice never changes" (one UPDATE sets every issue field at once: invoices_guard freezes
// the row afterwards) and "no gaps in a numbered series" (NumberingService.issue is the last row lock).
import { AddressSchema, type IssueInvoiceBody, type IssueInvoiceResult } from '@bos/contracts';
import {
  customers,
  invoiceLines,
  invoices,
  invoiceTaxSummary,
  organizations,
  scoped,
} from '@bos/db';
import { formatBs } from '@bos/locale';
import { Inject, Injectable, Optional, UnprocessableEntityException } from '@nestjs/common';
import { and, asc, eq } from 'drizzle-orm';

import { AuditService } from '../../platform/audit/audit.service';
import { AuthzService } from '../../platform/authz/authz.service';
import { DB, type Db, type DbTransaction } from '../../platform/db/db.module';
import { updateVersioned, withIdempotency } from '../../platform/db/idempotency';
import { withTx, type Actor, type TxScope } from '../../platform/db/tx';
import { canonicalSha256 } from '../../platform/hashing/canonical-json';
import { MoneyService } from '../../platform/settings/money.service';
import { NumberingService } from '../../platform/settings/numbering.service';
import { SettingsService } from '../../platform/settings/settings.service';
import { LedgerService } from '../ledger/ledger.service';
import { buildIssuer, IssuerIncompleteError } from '../quotations/render/issuer';
import {
  assertStaff,
  conflict,
  formatAddress,
  INVOICE_CLOCK,
  InvoiceCaller,
  invoiceNotFound,
  kathmanduDay,
  notApproved,
  pgError,
} from './invoice-support';

/** The numbering series of a proforma: PI-2083/84-00001 (plan A15). */
export const PROFORMA_SERIES = 'PI';

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
  ) {}

  /**
   * `issued` the first time, `already_issued` (with the same number) for a replay or a second click. 404 outside the
   * entity, 403 without `invoice.issue`, 409 for a stale `expectedVersion`, a status that is not draft, a due date
   * before today, or a kind that needs approval first (NOT_APPROVED).
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
    try {
      return await withTx(this.db, scope, actor, async (tx) => {
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
      if (pg?.code === '23514' && pg.constraint === 'invoices_due_date_check') {
        throw conflict(
          'The due date is before the issue date; correct the due date and issue again',
        );
      }
      throw error;
    }
  }

  private async issueInTx(
    tx: DbTransaction,
    scope: TxScope,
    actor: Actor,
    id: string,
    body: IssueInvoiceBody,
    now: Date,
  ): Promise<IssueInvoiceResult> {
    const [seen] = await tx
      .select({ id: invoices.id })
      .from(invoices)
      .where(scoped(scope).where(invoices, eq(invoices.id, id)))
      .limit(1);
    if (seen === undefined) throw invoiceNotFound();
    await this.ledger.lockForMoneyCommand(tx, scope, [
      { rank: 'invoice', ids: [id], table: invoices },
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
      case 'credit_note':
      case 'debit_note':
        // U6: replace this refusal with the approved-invoice issue (see the file header).
        throw notApproved();
    }
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
              address: customers.address,
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
    return {
      fxRate: fx.rate,
      fxSource: nprIsBooks ? null : fx.rateSource,
      fxDate: nprIsBooks ? null : fx.rateDate,
      amountNpr: fx.amountNpr,
      sellerSnapshot: {
        legalName: issuer.legalName,
        panVatNo: issuer.panVatNo,
        address: formatAddress(AddressSchema.parse(issuer.address)),
      },
      buyerSnapshot: {
        legalName: customer.legalName,
        panVatNo: customer.panVatNo,
        address: formatAddress(AddressSchema.parse(customer.address)),
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
