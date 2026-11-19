// The pr_commitment approval subject (P4 unit P2): what a decided commitment does to its RFQ and request, in the
// deciding transaction (ApprovalsService.act), so the decision and its effects commit or roll back together.
// - approved: request commitment_pending → approved, and a draft PO is written with the approved total, its NPR
//   snapshot and its band (base / management / founder, CT). Issuing the PO belongs to the PO unit (P3).
// - returned: request back to sourcing and the RFQ reopened to re-source (RFQ_TRANSITIONS recommended → open).
// - rejected: request rejected and the RFQ cancelled.
// A request that is not waiting for this decision is refused (409), never silently skipped.
import {
  paymentTerms,
  purchaseOrders,
  purchaseRequests,
  rfqs,
  scoped,
  vendorAccounts,
  vendorQuotations,
} from '@bos/db';
import { ConflictException, Logger } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';

import type { Db, DbTransaction } from '../../../platform/db/db.module';
import type { TxScope } from '../../../platform/db/tx';
import { actorUuid, readTxContext } from '../../../platform/documents/tx-context';
import type { NumberingService } from '../../../platform/settings/numbering.service';
import type { ApprovalSubject } from '../../approvals/requests.service';
import { idAt, procurementReferenceNames } from '../reference-names';
import { PO_SERIES, PR_COMMITMENT_DOCUMENT_TYPE, poBandOf } from './sourcing.rules';

type Outcome = 'approved' | 'returned' | 'rejected';
type RfqRow = typeof rfqs.$inferSelect;

const conflict = (message: string) => new ConflictException({ code: 'conflict', message });

/**
 * Writes the draft PO of an approved commitment from its recommended quotation. The PO number is taken last (the
 * numbering row lock). Payment terms come from the vendor's account in the entity (0 days when it names none).
 */
export async function insertDraftPurchaseOrder(
  tx: DbTransaction,
  scope: TxScope,
  numbering: NumberingService,
  rfq: RfqRow,
  createdBy: string,
  now: Date,
): Promise<{ id: string; number: string; approvedBand: string }> {
  const [quote] = await tx
    .select()
    .from(vendorQuotations)
    .where(
      scoped(scope).where(vendorQuotations, eq(vendorQuotations.id, rfq.recommendedQuotationId!)),
    );
  if (quote === undefined) throw conflict('The recommended quotation is missing');
  const [terms] = await tx
    .select({ netDays: paymentTerms.netDays })
    .from(vendorAccounts)
    .leftJoin(
      paymentTerms,
      and(
        eq(paymentTerms.tenantId, vendorAccounts.tenantId),
        eq(paymentTerms.id, vendorAccounts.paymentTermId),
      ),
    )
    .where(scoped(scope).where(vendorAccounts, eq(vendorAccounts.vendorId, quote.vendorId)));
  const approvedBand = poBandOf(quote.totalNpr);
  const issued = await numbering.issue(tx, PO_SERIES, now);
  const [po] = await tx
    .insert(purchaseOrders)
    .values({
      ...scope,
      number: issued.number,
      numberSeq: issued.seq,
      fiscalYear: issued.fiscalYear,
      purchaseRequestId: rfq.purchaseRequestId,
      rfqId: rfq.id,
      vendorQuotationId: quote.id,
      vendorId: quote.vendorId,
      currency: quote.currency,
      paymentTermsDays: terms?.netDays ?? 0,
      approvedTotal: quote.total,
      fxRate: quote.fxRate,
      fxSource: quote.fxSource,
      fxDate: quote.fxDate,
      approvedTotalNpr: quote.totalNpr,
      approvedBand,
      createdBy,
    })
    .returning({ id: purchaseOrders.id });
  return { id: po!.id, number: issued.number, approvedBand };
}

export class PrCommitmentSubject implements ApprovalSubject {
  readonly documentType = PR_COMMITMENT_DOCUMENT_TYPE;
  private readonly log = new Logger(PrCommitmentSubject.name);

  constructor(
    private readonly numbering: NumberingService,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  /** The recommended vendor of the commitment, by name. */
  referenceNames(q: Db, scope: TxScope, snapshot: unknown) {
    return procurementReferenceNames(q, scope, {
      vendorIds: [idAt(snapshot, 'commitment', 'vendorId')],
    });
  }

  async onDecided(tx: DbTransaction, rfqId: string, outcome: Outcome): Promise<void> {
    const ctx = await readTxContext(tx);
    const { scope } = ctx;
    const now = this.clock();
    const [rfq] = await tx
      .select()
      .from(rfqs)
      .where(scoped(scope).where(rfqs, eq(rfqs.id, rfqId)))
      .for('update');
    if (rfq === undefined || rfq.status !== 'recommended') {
      this.log.error(`rfq ${rfqId} is ${rfq?.status ?? 'missing'}; refusing outcome ${outcome}`);
      throw conflict('The commitment is not waiting for a decision');
    }
    const prStatus = { approved: 'approved', returned: 'sourcing', rejected: 'rejected' } as const;
    const updated = await tx
      .update(purchaseRequests)
      .set({
        status: prStatus[outcome],
        version: sql`${purchaseRequests.version} + 1`,
        updatedAt: now,
      })
      .where(
        scoped(scope).where(
          purchaseRequests,
          and(
            eq(purchaseRequests.id, rfq.purchaseRequestId),
            eq(purchaseRequests.status, 'commitment_pending'),
          ),
        ),
      )
      .returning({ id: purchaseRequests.id });
    if (updated.length === 0)
      throw conflict('The purchase request is not waiting for a commitment');

    if (outcome === 'approved') {
      await insertDraftPurchaseOrder(
        tx,
        scope,
        this.numbering,
        rfq,
        actorUuid(ctx) ?? rfq.createdBy,
        now,
      );
      return;
    }
    await tx
      .update(rfqs)
      .set({
        status: outcome === 'returned' ? 'open' : 'cancelled',
        recommendedQuotationId: outcome === 'returned' ? null : rfq.recommendedQuotationId,
        version: sql`${rfqs.version} + 1`,
        updatedAt: now,
      })
      .where(eq(rfqs.id, rfqId));
  }

  /** The commitment is never cancelled through the engine by this module, so there is nothing to undo. */
  onCancelled(_tx: DbTransaction, _requestId: string, _reason: string): Promise<void> {
    return Promise.resolve();
  }
}
