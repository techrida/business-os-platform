// The vendor_bill and match_exception approval subjects (P4 units A1 and A1b; AD5, AD14): what a decision does to its
// bill, in the deciding transaction (ApprovalsService.act), so the decision and its effects commit or roll back
// together.
// match_exception (document id = the exception id):
// - approved: the exception names its decider; the bill (still exception_pending) gets match_status
//   exception_approved, so submit lets it through;
// - returned or rejected: the exception is rejected and the bill goes back to variance (a new exception or a corrected
//   match may follow). BILL_TRANSITIONS has no exception_pending → variance move; the bill cannot stay blocked in
//   exception_pending with nothing pending, so this subject makes that move.
// vendor_bill (document id = the bill id):
// - returned: back to draft (match again before a new submit); rejected: rejected;
// - approved: the bill is posted to the payables subledger. TDS is computed now, on each line's net excluding VAT
//   (AD14), at the rate of the line's withholding code, else the bill's, else the vendor account's default in this
//   entity (none, or a code that is not a payable code: zero). The bill stores TDS, payable = net + VAT - TDS and its
//   NPR snapshot, then LedgerService opens the payable credit item for the vendor and records `vendor_bill_posted`
//   (net, VAT, TDS, payable), all in this transaction.
// - approved again on a bill that is already approved (a replayed decision): openItem and recordEvent run again from
//   the stored totals. Both are idempotent, so the bill keeps one item and one event and nothing is recomputed.
// A bill or exception that is not waiting for this decision is refused (409), never silently skipped.
import type { ApprovalContext } from '@bos/contracts';
import {
  matchExceptions,
  scoped,
  vendorAccounts,
  vendorBillLines,
  vendorBills,
  withholdingCodes,
} from '@bos/db';
import { parseDecimal, payableTotal, roundMoney, tdsFor, toNpr } from '@bos/money-rules';
import { ConflictException, Logger } from '@nestjs/common';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';

import type { AuditService } from '../../../platform/audit/audit.service';
import type { Principal } from '../../../platform/authz/principal';
import type { Db, DbTransaction } from '../../../platform/db/db.module';
import type { Actor, TxScope } from '../../../platform/db/tx';
import { actorUuid, readTxContext, type TxContext } from '../../../platform/documents/tx-context';
import { fact, readableDocuments } from '../../approvals/context';
import type { ApprovalSubject } from '../../approvals/requests.service';
import { evidenceOwnerPolicyFor } from '../../evidence/evidence-owner.policy';
import { LedgerService } from '../../ledger/ledger.service';
import { idAt, procurementReferenceNames } from '../../procurement/reference-names';
import { billContext } from './bill-approval-context';
import {
  BILL_AUDIT_ENTITY,
  MATCH_EXCEPTION_AUDIT_ENTITY,
  MATCH_EXCEPTION_DOCUMENT_TYPE,
  VENDOR_BILL_DOCUMENT_TYPE,
} from './vendor-bill.rules';

type Outcome = 'approved' | 'returned' | 'rejected';

const conflict = (code: string, message: string) => new ConflictException({ code, message });

type Bill = typeof vendorBills.$inferSelect;

/** The actor withTx set for this transaction; the ledger reads only its kind and id (created_by). */
function actorOf(ctx: TxContext, billId: string): Actor {
  return {
    kind: ctx.actorKind as Actor['kind'],
    id: ctx.actorId,
    correlationId: `vendor_bill:${billId}`,
  };
}

export class VendorBillSubject implements ApprovalSubject {
  readonly documentType = VENDOR_BILL_DOCUMENT_TYPE;
  private readonly log = new Logger(VendorBillSubject.name);

  constructor(
    private readonly audit: AuditService,
    private readonly clock: () => Date = () => new Date(),
    private readonly ledger: LedgerService = new LedgerService(),
  ) {}

  /** The vendor and the order the submitted bill names, by name and number. */
  referenceNames(q: Db, scope: TxScope, snapshot: unknown) {
    return procurementReferenceNames(q, scope, {
      vendorIds: [idAt(snapshot, 'vendorPartyId')],
      purchaseOrderIds: [idAt(snapshot, 'purchaseOrderId')],
    });
  }

  /** The bill as it stands now, with its own file (bill-approval-context.ts). */
  context(q: Db, scope: TxScope, request: { documentId: string }, viewer: Principal) {
    return billContext(q, scope, request.documentId, viewer);
  }

  async onDecided(tx: DbTransaction, billId: string, outcome: Outcome): Promise<void> {
    const ctx = await readTxContext(tx);
    const { scope } = ctx;
    const [bill] = await tx
      .select()
      .from(vendorBills)
      .where(scoped(scope).where(vendorBills, eq(vendorBills.id, billId)))
      .for('update');
    if (bill === undefined) throw conflict('not_found', 'The bill was not found');
    if (bill.status === 'approved' && outcome === 'approved') {
      this.log.warn(`bill ${bill.id} is already approved; posting again from the stored totals`);
      await this.post(tx, scope, actorOf(ctx, bill.id), bill);
      return;
    }
    if (bill.status !== 'pending_approval') {
      this.log.error(`bill ${bill.id} is ${bill.status}; refusing outcome ${outcome}`);
      throw conflict('invalid_transition', 'The bill is not waiting for an approval decision');
    }
    if (outcome === 'approved') {
      await this.approve(tx, scope, actorOf(ctx, bill.id), bill);
      return;
    }
    const status = outcome === 'returned' ? 'draft' : 'rejected';
    await tx
      .update(vendorBills)
      .set({ status, version: sql`${vendorBills.version} + 1`, updatedAt: this.clock() })
      .where(
        scoped(scope).where(
          vendorBills,
          and(eq(vendorBills.id, bill.id), eq(vendorBills.status, 'pending_approval')),
        ),
      );
    await this.audit.record(tx, {
      action: `payables.bill.${outcome}`,
      entityType: BILL_AUDIT_ENTITY,
      entityId: bill.id,
      before: { status: bill.status },
      after: { status },
    });
  }

  /** Computes TDS, stores the payable totals, approves the bill (still locked by onDecided) and posts it. */
  private async approve(
    tx: DbTransaction,
    scope: TxScope,
    actor: Actor,
    bill: Bill,
  ): Promise<void> {
    const now = this.clock();
    const lines = await tx
      .select()
      .from(vendorBillLines)
      .where(scoped(scope).where(vendorBillLines, eq(vendorBillLines.vendorBillId, bill.id)))
      .orderBy(asc(vendorBillLines.lineNo));
    const [account] = await tx
      .select({ defaultWithholdingCodeId: vendorAccounts.defaultWithholdingCodeId })
      .from(vendorAccounts)
      .where(scoped(scope).where(vendorAccounts, eq(vendorAccounts.vendorId, bill.vendorId)));
    const fallbackCodeId = bill.withholdingCodeId ?? account?.defaultWithholdingCodeId ?? null;
    const codeIds = [
      ...new Set(
        [...lines.map((l) => l.withholdingCodeId), fallbackCodeId].filter(
          (id): id is string => id !== null,
        ),
      ),
    ];
    // withholding_codes is tenant-level (no organization_id), so it is filtered by tenant, not scoped().
    const rates = new Map<string, number>();
    if (codeIds.length > 0) {
      const rows = await tx
        .select({ id: withholdingCodes.id, rateBp: withholdingCodes.rateBp })
        .from(withholdingCodes)
        .where(
          and(
            eq(withholdingCodes.tenantId, scope.tenantId),
            inArray(withholdingCodes.id, codeIds),
            inArray(withholdingCodes.appliesTo, ['payable', 'both']),
          ),
        );
      for (const row of rows) rates.set(row.id, row.rateBp);
    }

    let tds = parseDecimal('0');
    let firstLineCodeId: string | null = null;
    for (const line of lines) {
      const codeId = line.withholdingCodeId ?? fallbackCodeId;
      const rateBp = codeId === null ? undefined : rates.get(codeId);
      const lineTds = rateBp === undefined ? parseDecimal('0') : tdsFor(line.netAmount, rateBp);
      const withheld = codeId !== null && lineTds.gt(0);
      if (withheld) firstLineCodeId ??= codeId;
      tds = tds.plus(lineTds);
      await tx
        .update(vendorBillLines)
        .set({
          tdsAmount: lineTds.toFixed(2),
          // vendor_bill_lines_tds_amount_check: a line that withholds names its code.
          ...(withheld ? { withholdingCodeId: codeId } : {}),
          updatedAt: now,
        })
        .where(scoped(scope).where(vendorBillLines, eq(vendorBillLines.id, line.id)));
    }
    const tdsTotal = roundMoney(tds);
    const payable = payableTotal({ net: bill.netTotal, vat: bill.vatTotal, tds: tdsTotal });
    const payableNpr = toNpr(payable, bill.currency, bill.fxRate);
    // vendor_bills_tds_code_check: a bill that withholds names a code, the first one that withheld.
    const withholdingCodeId = tdsTotal.gt(0) ? firstLineCodeId : bill.withholdingCodeId;
    const [approved] = await tx
      .update(vendorBills)
      .set({
        status: 'approved',
        tdsTotal: tdsTotal.toFixed(2),
        payableTotal: payable.toFixed(2),
        payableTotalNpr: payableNpr.toFixed(2),
        withholdingCodeId,
        version: sql`${vendorBills.version} + 1`,
        updatedAt: now,
      })
      .where(
        scoped(scope).where(
          vendorBills,
          and(eq(vendorBills.id, bill.id), eq(vendorBills.status, 'pending_approval')),
        ),
      )
      .returning();
    if (approved === undefined) throw new Error(`bill ${bill.id} changed under its row lock`);
    await this.post(tx, scope, actor, approved);
    await this.audit.record(tx, {
      action: 'payables.bill.approved',
      entityType: BILL_AUDIT_ENTITY,
      entityId: bill.id,
      before: { status: bill.status, tdsTotal: bill.tdsTotal, payableTotal: bill.payableTotal },
      after: {
        status: approved.status,
        tdsTotal: approved.tdsTotal,
        payableTotal: approved.payableTotal,
        payableTotalNpr: approved.payableTotalNpr,
        withholdingCodeId: approved.withholdingCodeId,
      },
    });
  }

  /** The payable credit item and `vendor_bill_posted`, from the bill's stored totals. Both calls are idempotent. */
  private async post(tx: DbTransaction, scope: TxScope, actor: Actor, bill: Bill): Promise<void> {
    const { item } = await this.ledger.openItem(tx, scope, actor, {
      side: 'payable',
      direction: 'credit',
      partyId: bill.vendorId,
      sourceType: 'vendor_bill',
      sourceId: bill.id,
      currency: bill.currency,
      amount: bill.payableTotal,
      amountNpr: bill.payableTotalNpr,
      fxRate: bill.fxRate,
      fxSource: bill.fxSource,
      fxDate: bill.fxDate,
      documentDate: bill.invoiceDate,
      dueDate: bill.dueDate,
    });
    await this.ledger.recordEvent(tx, scope, actor, {
      sourceType: 'vendor_bill',
      sourceId: bill.id,
      event: 'vendor_bill_posted',
      payload: {
        vendorPartyId: bill.vendorId,
        currency: bill.currency,
        netTotal: bill.netTotal,
        vatTotal: bill.vatTotal,
        tdsTotal: bill.tdsTotal,
        payableTotal: bill.payableTotal,
        payableTotalNpr: bill.payableTotalNpr,
        fxRate: bill.fxRate,
        withholdingCodeId: bill.withholdingCodeId,
        openItemId: item.id,
      },
    });
  }
}

export class MatchExceptionSubject implements ApprovalSubject {
  readonly documentType = MATCH_EXCEPTION_DOCUMENT_TYPE;
  private readonly log = new Logger(MatchExceptionSubject.name);

  constructor(
    private readonly audit: AuditService,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  /** The bill the exception is about, by its number. */
  referenceNames(q: Db, scope: TxScope, snapshot: unknown) {
    return procurementReferenceNames(q, scope, { vendorBillIds: [idAt(snapshot, 'vendorBillId')] });
  }

  /**
   * The bill the exception is about as it stands now, with the exception's reason and status, and after the bill's own
   * file the exception's evidence, when it is evidence uploaded to that bill and the reader could open it.
   */
  async context(
    q: Db,
    scope: TxScope,
    request: { documentId: string },
    viewer: Principal,
  ): Promise<ApprovalContext | null> {
    const [exception] = await q
      .select({
        vendorBillId: matchExceptions.vendorBillId,
        reason: matchExceptions.reason,
        status: matchExceptions.status,
        evidenceDocumentId: matchExceptions.evidenceDocumentId,
      })
      .from(matchExceptions)
      .where(scoped(scope).where(matchExceptions, eq(matchExceptions.id, request.documentId)));
    if (exception === undefined) return null;
    const bill = await billContext(q, scope, exception.vendorBillId, viewer);
    if (bill === null) return null;
    const evidence = await readableDocuments(
      q,
      scope,
      viewer,
      [exception.evidenceDocumentId],
      [evidenceOwnerPolicyFor(q, exception.vendorBillId)],
    );
    return {
      ...bill,
      title: `Match exception on ${bill.title.charAt(0).toLowerCase()}${bill.title.slice(1)}`,
      fields: [
        ...fact.text('exceptionReason', 'Exception reason', exception.reason),
        ...fact.status(exception.status, 'exceptionStatus', 'Exception status'),
        ...bill.fields,
      ],
      documents: [...bill.documents, ...evidence],
    };
  }

  async onDecided(tx: DbTransaction, exceptionId: string, outcome: Outcome): Promise<void> {
    const ctx = await readTxContext(tx);
    const { scope } = ctx;
    const now = this.clock();
    const deciderId = actorUuid(ctx);
    if (deciderId === null) throw new Error('a match exception is decided by a user');
    const [exception] = await tx
      .select()
      .from(matchExceptions)
      .where(scoped(scope).where(matchExceptions, eq(matchExceptions.id, exceptionId)))
      .for('update');
    if (exception === undefined) throw conflict('not_found', 'The match exception was not found');
    if (exception.status !== 'pending') {
      this.log.error(`exception ${exception.id} is ${exception.status}; refusing ${outcome}`);
      throw conflict('invalid_transition', 'The match exception is not waiting for a decision');
    }
    const [bill] = await tx
      .select()
      .from(vendorBills)
      .where(scoped(scope).where(vendorBills, eq(vendorBills.id, exception.vendorBillId)))
      .for('update');
    if (bill?.status !== 'exception_pending') {
      throw conflict('invalid_transition', 'The bill is not waiting for a match exception');
    }
    const approved = outcome === 'approved';
    await tx
      .update(matchExceptions)
      .set({
        status: approved ? 'approved' : 'rejected',
        decidedBy: deciderId,
        decidedAt: now,
        version: sql`${matchExceptions.version} + 1`,
        updatedAt: now,
      })
      .where(scoped(scope).where(matchExceptions, eq(matchExceptions.id, exception.id)));
    const next = approved
      ? { status: 'exception_pending' as const, matchStatus: 'exception_approved' as const }
      : { status: 'variance' as const, matchStatus: 'variance' as const };
    await tx
      .update(vendorBills)
      .set({ ...next, version: sql`${vendorBills.version} + 1`, updatedAt: now })
      .where(
        scoped(scope).where(
          vendorBills,
          and(eq(vendorBills.id, bill.id), eq(vendorBills.status, 'exception_pending')),
        ),
      );
    await this.audit.record(tx, {
      action: `payables.match_exception.${approved ? 'approved' : 'rejected'}`,
      entityType: MATCH_EXCEPTION_AUDIT_ENTITY,
      entityId: exception.id,
      before: { status: 'pending', bill: { status: bill.status, matchStatus: bill.matchStatus } },
      after: { status: approved ? 'approved' : 'rejected', bill: next, outcome },
    });
  }
}
