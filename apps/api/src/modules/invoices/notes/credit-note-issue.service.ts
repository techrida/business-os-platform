// CreditNoteIssueService (P3 unit U12 part C): the issue of a credit note, reached through the shared
// `POST /v1/invoices/:id/issue` (InvoiceIssueService hands every `credit_note` here, inside its withTx and
// withIdempotency). Approved -> issued in one transaction (plan A5), and a second call answers `already_issued`.
// Serves the NFRs:
// - "a credit never exceeds the invoice" (done check 7): the original is locked with the note, the issued credit notes
//   on it are summed again and anything over its total answers 409 CREDIT_EXCEEDS_INVOICE; so does anything over one
//   of its lines (quantity or taxable) or tax codes (base or VAT), summed over the live notes with this one (U12D);
// - "open amounts never go below 0" and "paid is derived" (done check 8): the credit is an open item allocated against
//   the original's debit item. When the original has too little open for it, payment allocations on the original are
//   released newest first through LedgerService.reverseAllocation, and the part of the last one released that is not
//   needed is allocated back, so a paid invoice stays paid and only the credited part becomes customer advance;
// - "a full credit gives the schedule line back": once the issued credit notes cover every line of the original in
//   full (not merely its total), the original gets `credited_in_full_at` (the one change 0023 allows on an issued
//   invoice, which also takes it out of G4) and its schedule line goes back to `billable` with no invoice, so a new
//   tax invoice can be drafted on it;
// - "no gaps in a numbered series": every lock is taken first, in the plan's order (sales order -> the original's
//   schedule line -> the original and the note -> the open items, each ascending), and NumberingService.issue is the
//   last row lock; everything after it inserts or changes rows this transaction already holds.
// The ledger is written only through LedgerService (ledger-writers.test.ts).
import type { IssueInvoiceBody, IssueInvoiceResult } from '@bos/contracts';
import {
  billingScheduleLines,
  invoiceLines,
  invoices,
  invoiceTaxSummary,
  openItemAllocations,
  openItems,
  salesOrders,
  scoped,
} from '@bos/db';
import { Dec } from '@bos/money-rules';
import { Injectable } from '@nestjs/common';
import { formatBs } from '@bos/locale';
import { and, asc, desc, eq, isNull, ne, notExists, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';

import { AuditService } from '../../../platform/audit/audit.service';
import type { DbTransaction } from '../../../platform/db/db.module';
import { updateVersioned } from '../../../platform/db/idempotency';
import type { Actor, TxScope } from '../../../platform/db/tx';
import { NumberingService } from '../../../platform/settings/numbering.service';
import { LedgerService } from '../../ledger/ledger.service';
import {
  conflict,
  createdThisNote,
  invoiceNotFound,
  kathmanduDay,
  notApproved,
  noteIssuerIsCreator,
} from '../invoice-support';
import {
  creditCapExcess,
  creditExceedsInvoice,
  creditsEveryLine,
  loadCredited,
  withNote,
  type StoredParts,
} from './note-drafting.service';
import { creditNoteNpr } from './credit-note-npr';

/** The numbering series of a credit note: CN-2083/84-00001 (plan A15). */
export const CREDIT_NOTE_SERIES = 'CN';

type InvoiceRow = typeof invoices.$inferSelect;

/** InvoiceIssueService.contentHashOf, passed in so the two services do not depend on each other. */
export type ContentHasher = (
  tx: DbTransaction,
  scope: TxScope,
  invoice: InvoiceRow,
  issued: { number: string; issueDate: string },
  snapshot: { sellerSnapshot: unknown; buyerSnapshot: unknown },
) => Promise<Buffer>;

/** A forward payment allocation on the original's debit item that no reversal names yet. */
interface Releasable {
  id: string;
  creditItemId: string;
  amount: string;
}

const ZERO = new Dec(0);

@Injectable()
export class CreditNoteIssueService {
  constructor(
    private readonly audit: AuditService,
    private readonly ledger: LedgerService,
    private readonly numbering: NumberingService,
  ) {}

  /**
   * Issues the approved credit note `noteId` on `originalId`. Runs in the caller's transaction (withTx ->
   * withIdempotency). `issued` the first time, `already_issued` with the same number afterwards; 409 NOT_APPROVED,
   * 409 for a stale `expectedVersion`, 409 CREDIT_EXCEEDS_INVOICE over the original's total.
   */
  async issueInTx(
    tx: DbTransaction,
    scope: TxScope,
    actor: Actor,
    noteId: string,
    originalId: string,
    body: IssueInvoiceBody,
    now: Date,
    contentHashOf: ContentHasher,
  ): Promise<IssueInvoiceResult> {
    // Unlocked reads of what to lock. The original is issued, so its order, schedule line and debit item cannot
    // change; the allocations are read again under the locks.
    const [head] = await tx
      .select({ salesOrderId: invoices.salesOrderId, scheduleLineId: invoices.scheduleLineId })
      .from(invoices)
      .where(scoped(scope).where(invoices, eq(invoices.id, originalId)))
      .limit(1);
    if (head === undefined) throw invoiceNotFound();
    const debitItemId = await this.debitItemOf(tx, scope, originalId);
    const before = debitItemId === null ? [] : await this.releasable(tx, scope, debitItemId);
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
      // The original and the note are one rank: locked together in ascending id order.
      { rank: 'invoice' as const, ids: [originalId, noteId], table: invoices },
      ...(debitItemId === null
        ? []
        : [
            {
              rank: 'open_item' as const,
              ids: [debitItemId, ...before.map((a) => a.creditItemId)],
            },
          ]),
    ]);
    const note = await this.invoiceById(tx, scope, noteId);
    const original = await this.invoiceById(tx, scope, originalId);

    // Replay, second caller or double click: the number it has, before looking at the version the caller held.
    if (note.status === 'issued' && note.number !== null) {
      return { kind: 'already_issued', invoiceId: note.id, number: note.number };
    }
    if (note.status !== 'approved') throw notApproved();
    if (createdThisNote(note, actor.kind === 'user' ? actor.id : null)) throw noteIssuerIsCreator();
    if (note.version !== body.expectedVersion) {
      throw conflict('This invoice was changed by someone else; reload it and try again');
    }
    if (
      original.kind !== 'tax_invoice' ||
      original.status !== 'issued' ||
      original.fxRate === null ||
      original.amountNpr === null ||
      debitItemId === null
    ) {
      throw conflict('A credit note is issued only against an issued tax invoice');
    }
    if (original.customerPartyId === null) throw new Error('the original invoice has no customer');

    // The cap, again under the lock: issued credit notes so far plus this one stay within the original's total.
    const [prior] = await tx
      .select({
        total: sql<string>`COALESCE(sum(${invoices.total}), 0)::text`,
        amountNpr: sql<string>`COALESCE(sum(${invoices.amountNpr}), 0)::text`,
      })
      .from(invoices)
      .where(
        and(
          eq(invoices.tenantId, scope.tenantId),
          eq(invoices.organizationId, scope.organizationId),
          eq(invoices.originalInvoiceId, original.id),
          eq(invoices.kind, 'credit_note'),
          eq(invoices.status, 'issued'),
          ne(invoices.id, note.id),
        ),
      );
    const total = new Dec(note.total);
    const creditedBefore = new Dec(prior?.total ?? '0');
    const originalTotal = new Dec(original.total);
    if (creditedBefore.plus(total).gt(originalTotal)) {
      const left = originalTotal.minus(creditedBefore);
      throw creditExceedsInvoice((left.isNegative() ? ZERO : left).toFixed(2));
    }
    // The cap per original line and per tax code, again under the lock: the live credit notes besides this one, plus
    // this one, stay within every line and every code of the original.
    const originalParts = await this.partsOf(tx, scope, original.id);
    const noteParts = await this.partsOf(tx, scope, note.id);
    const live = await loadCredited(tx, scope, original.id, {
      issuedOnly: false,
      excludeNoteId: note.id,
    });
    const excess = creditCapExcess(originalParts, live, noteParts);
    if (excess !== null) throw excess;
    // Credited in full means every line of the original is credited in full by the issued notes, this one included. A
    // total that happens to match while a line is uncredited is not.
    const issued = await loadCredited(tx, scope, original.id, {
      issuedOnly: true,
      excludeNoteId: note.id,
    });
    const fullyCredited = creditsEveryLine(originalParts.lines, withNote(issued, noteParts));

    // FX: the note reverses part of the original, so it takes the original's rate (no new rate, no stale check). Its NPR
    // is the original's NPR times the share credited so far, less what earlier notes took, so the credit that completes
    // the original takes exactly what is left and the NPR values net to 0 (credit-note-npr.ts).
    const nprIsBooks = note.currency === 'NPR';
    const amountNpr = nprIsBooks
      ? total.toFixed(2)
      : fullyCredited
        ? new Dec(original.amountNpr).minus(new Dec(prior?.amountNpr ?? '0')).toFixed(2)
        : creditNoteNpr({
            originalTotal,
            originalNpr: new Dec(original.amountNpr),
            creditedBefore,
            creditedNprBefore: new Dec(prior?.amountNpr ?? '0'),
            noteTotal: total,
          }).toFixed(2);
    const fx = {
      fxRate: nprIsBooks ? '1' : original.fxRate,
      fxSource: nprIsBooks ? null : original.fxSource,
      fxDate: nprIsBooks ? null : original.fxDate,
    };

    // How much of the original must be freed: the note's total less what is open on it now. Read under the locks.
    const open = new Dec(
      (await this.ledger.openAmounts(tx, scope, [debitItemId])).get(debitItemId) ?? '0',
    );
    const releasable = await this.releasable(tx, scope, debitItemId);
    const needed = total.minus(open);
    // A payment allocated between the unlocked read and the lock: take its item now, still before the number.
    const seen = new Set(before.map((a) => a.creditItemId));
    const late = releasable.map((a) => a.creditItemId).filter((id) => !seen.has(id));
    if (late.length > 0) {
      await this.ledger.lockForMoneyCommand(tx, scope, [{ rank: 'open_item', ids: late }]);
    }

    const issueDate = kathmanduDay(now);
    // The series is the last row lock of the transaction (plan section 2).
    const { number, seq, fiscalYear } = await this.numbering.issue(tx, CREDIT_NOTE_SERIES, now);
    // The parties as the original froze them: the note corrects that invoice.
    const parties = {
      sellerSnapshot: original.sellerSnapshot,
      buyerSnapshot: original.buyerSnapshot,
    };
    const contentHash = await contentHashOf(tx, scope, note, { number, issueDate }, parties);
    await updateVersioned(tx, invoices, note.id, body.expectedVersion, {
      status: 'issued',
      number,
      seq,
      fiscalYear,
      issueDate,
      issueDateBs: formatBs(now, 'YYYY-MM-DD'),
      issuedAt: now,
      issuedBy: actor.kind === 'user' ? actor.id : null,
      ...fx,
      amountNpr,
      ...parties,
      contentHash,
    });

    // Release payment allocations on the original, newest first, until it has room for the credit. Each locks open
    // items this transaction holds already.
    const released: string[] = [];
    if (needed.gt(ZERO)) {
      let freed = ZERO;
      let last: Releasable | undefined;
      for (const allocation of releasable) {
        if (freed.gte(needed)) break;
        await this.ledger.reverseAllocation(tx, scope, actor, {
          allocationId: allocation.id,
          reason: `credit note ${number}`,
        });
        released.push(allocation.id);
        freed = freed.plus(allocation.amount);
        last = allocation;
      }
      if (freed.lt(needed) || last === undefined) {
        throw new Error(
          `invoice ${original.id}: the allocations do not cover credit note ${number}`,
        );
      }
      // A reversal is whole-row: what the last one freed beyond the need goes back on the original.
      const kept = freed.minus(needed);
      if (kept.gt(ZERO)) {
        await this.ledger.allocate(tx, scope, actor, {
          debitItemId,
          creditItemId: last.creditItemId,
          amount: kept.toFixed(2),
        });
      }
    }

    // The credit the customer is given: a receivable credit, allocated in full against the original.
    const { item } = await this.ledger.openItem(tx, scope, actor, {
      side: 'receivable',
      direction: 'credit',
      partyId: original.customerPartyId,
      sourceType: 'credit_note',
      sourceId: note.id,
      currency: note.currency,
      amount: note.total,
      amountNpr,
      ...fx,
      documentDate: issueDate,
      dueDate: null,
    });
    await this.ledger.recordEvent(tx, scope, actor, {
      sourceType: 'credit_note',
      sourceId: note.id,
      event: 'credit_note_issued',
      payload: {
        openItemId: item.id,
        number,
        originalInvoiceId: original.id,
        currency: note.currency,
        total: note.total,
        taxAmount: note.taxAmount,
        amountNpr,
        fxRate: fx.fxRate,
        issueDate,
        releasedAllocationIds: released,
      },
    });
    await this.ledger.allocate(tx, scope, actor, {
      debitItemId,
      creditItemId: item.id,
      amount: note.total,
    });

    if (fullyCredited) await this.releaseScheduleLine(tx, scope, original, now);

    await this.audit.record(tx, {
      action: 'invoice.credit_note_issued',
      entityType: 'invoices',
      entityId: note.id,
      before: { status: 'approved', version: note.version },
      after: {
        status: 'issued',
        number,
        issueDate,
        total: note.total,
        originalInvoiceId: original.id,
        releasedAllocationIds: released,
        creditedInFull: fullyCredited,
      },
    });
    return { kind: 'issued', invoiceId: note.id, number };
  }

  /**
   * The original is credited in full: mark it (credited_in_full_at, once; 0023 allows nothing else on an issued
   * invoice and drops it from G4) and give its schedule line back as billable with no invoice. Both rows are locked.
   */
  private async releaseScheduleLine(
    tx: DbTransaction,
    scope: TxScope,
    original: InvoiceRow,
    now: Date,
  ): Promise<void> {
    const marked = await tx
      .update(invoices)
      .set({
        creditedInFullAt: now,
        version: sql`${invoices.version} + 1`,
        updatedAt: sql`now()`,
      })
      .where(
        scoped(scope).where(
          invoices,
          and(
            eq(invoices.id, original.id),
            eq(invoices.status, 'issued'),
            isNull(invoices.creditedInFullAt),
          ),
        ),
      )
      .returning({ id: invoices.id });
    if (marked.length === 0) throw conflict('This invoice is already credited in full');
    if (original.scheduleLineId === null) return;
    const freed = await tx
      .update(billingScheduleLines)
      .set({
        status: 'billable',
        invoiceId: null,
        version: sql`${billingScheduleLines.version} + 1`,
        updatedAt: sql`now()`,
      })
      .where(
        scoped(scope).where(
          billingScheduleLines,
          and(
            eq(billingScheduleLines.id, original.scheduleLineId),
            eq(billingScheduleLines.invoiceId, original.id),
            eq(billingScheduleLines.status, 'invoiced'),
          ),
        ),
      )
      .returning({ id: billingScheduleLines.id });
    if (freed.length === 0) throw conflict('The schedule line of this invoice is not invoiced');
  }

  /** The stored lines and tax summary rows of one invoice or note of the entity. */
  private async partsOf(
    tx: DbTransaction,
    scope: TxScope,
    invoiceId: string,
  ): Promise<StoredParts> {
    const owned = (t: typeof invoiceLines | typeof invoiceTaxSummary) =>
      and(
        eq(t.tenantId, scope.tenantId),
        eq(t.organizationId, scope.organizationId),
        eq(t.invoiceId, invoiceId),
      );
    const lines = await tx
      .select({
        id: invoiceLines.id,
        lineNo: invoiceLines.lineNo,
        quantity: invoiceLines.quantity,
        taxable: invoiceLines.taxable,
        originalLineId: invoiceLines.originalLineId,
      })
      .from(invoiceLines)
      .where(owned(invoiceLines))
      .orderBy(asc(invoiceLines.lineNo));
    const taxSummary = await tx
      .select({
        taxCodeId: invoiceTaxSummary.taxCodeId,
        label: invoiceTaxSummary.label,
        base: invoiceTaxSummary.base,
        tax: invoiceTaxSummary.tax,
      })
      .from(invoiceTaxSummary)
      .where(owned(invoiceTaxSummary));
    return { lines, taxSummary };
  }

  private async invoiceById(tx: DbTransaction, scope: TxScope, id: string): Promise<InvoiceRow> {
    const [row] = await tx
      .select()
      .from(invoices)
      .where(scoped(scope).where(invoices, eq(invoices.id, id)))
      .limit(1);
    if (row === undefined) throw invoiceNotFound();
    return row;
  }

  /** The receivable debit item the original's issue opened, or null when there is none. */
  private async debitItemOf(
    tx: DbTransaction,
    scope: TxScope,
    originalId: string,
  ): Promise<string | null> {
    const [row] = await tx
      .select({ id: openItems.id })
      .from(openItems)
      .where(
        and(
          eq(openItems.tenantId, scope.tenantId),
          eq(openItems.organizationId, scope.organizationId),
          eq(openItems.sourceType, 'tax_invoice'),
          eq(openItems.sourceId, originalId),
        ),
      )
      .limit(1);
    return row?.id ?? null;
  }

  /**
   * Forward payment allocations on the debit item that no reversal names, newest first. Credit-note allocations are
   * never released: they are the credits already given.
   */
  private async releasable(
    tx: DbTransaction,
    scope: TxScope,
    debitItemId: string,
  ): Promise<Releasable[]> {
    const reversal = alias(openItemAllocations, 'reversal');
    return tx
      .select({
        id: openItemAllocations.id,
        creditItemId: openItemAllocations.creditItemId,
        amount: openItemAllocations.amount,
      })
      .from(openItemAllocations)
      .innerJoin(
        openItems,
        and(
          eq(openItems.tenantId, openItemAllocations.tenantId),
          eq(openItems.id, openItemAllocations.creditItemId),
        ),
      )
      .where(
        and(
          eq(openItemAllocations.tenantId, scope.tenantId),
          eq(openItemAllocations.organizationId, scope.organizationId),
          eq(openItemAllocations.debitItemId, debitItemId),
          isNull(openItemAllocations.reversesAllocationId),
          eq(openItems.sourceType, 'payment'),
          notExists(
            tx
              .select({ id: reversal.id })
              .from(reversal)
              .where(
                and(
                  eq(reversal.tenantId, openItemAllocations.tenantId),
                  eq(reversal.reversesAllocationId, openItemAllocations.id),
                ),
              ),
          ),
        ),
      )
      .orderBy(desc(openItemAllocations.createdAt), desc(openItemAllocations.id));
  }
}
