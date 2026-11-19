// The payment_request approval subject (P4 unit A2; AD1): what a decision does to its request, in the deciding
// transaction (ApprovalsService.act), so the decision and its effect commit or roll back together.
// - approved: the request is approved. That is terminal in Stage 1: no payout, no allocation, nothing posted to the
//   ledger. The bill keeps its `approved` status, which the vendor portal already shows as approved_for_payment.
// - returned or rejected: the request is rejected (PAYMENT_REQUEST_TRANSITIONS has no way back to draft); its lines
//   stop claiming their open items, so a new request may ask for the amount again.
// - approved again on a request that is already approved (a replayed decision): nothing to do, so it returns.
// A request that is not waiting for this decision is refused (409), never silently skipped.
import type { ApprovalContext, ReferenceName } from '@bos/contracts';
import { openItems, paymentRequestLines, paymentRequests, scoped, vendors } from '@bos/db';
import { ConflictException, Logger } from '@nestjs/common';
import { and, asc, eq, sql } from 'drizzle-orm';

import type { AuditService } from '../../../platform/audit/audit.service';
import type { Principal } from '../../../platform/authz/principal';
import type { Db, DbTransaction } from '../../../platform/db/db.module';
import type { TxScope } from '../../../platform/db/tx';
import { readTxContext } from '../../../platform/documents/tx-context';
import { fact, hrefFor, readableDocuments } from '../../approvals/context';
import type { ApprovalSubject } from '../../approvals/requests.service';
import { idAt, procurementReferenceNames } from '../../procurement/reference-names';
import { billFileOwners, billHeads, billLabel } from '../bills/bill-approval-context';
import {
  PAYMENT_REQUEST_AUDIT_ENTITY,
  PAYMENT_REQUEST_DOCUMENT_TYPE,
  statusAfter,
} from './payment-request.rules';

type Outcome = 'approved' | 'returned' | 'rejected';

const conflict = (code: string, message: string) => new ConflictException({ code, message });

/** The snapshot's `lines`, or none when it has no array there. */
function linesOf(snapshot: unknown): unknown[] {
  const lines = (snapshot as { lines?: unknown } | null)?.lines;
  return Array.isArray(lines) ? lines : [];
}

export class PaymentRequestSubject implements ApprovalSubject {
  readonly documentType = PAYMENT_REQUEST_DOCUMENT_TYPE;
  private readonly log = new Logger(PaymentRequestSubject.name);

  constructor(
    private readonly audit: AuditService,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  /**
   * The vendor by legal name and each bill by its number (or the vendor's invoice number before one). An open item is
   * named by the bill it pays and the vendor's bank account by its last four digits, both from the snapshot itself.
   */
  async referenceNames(q: Db, scope: TxScope, snapshot: unknown): Promise<ReferenceName[]> {
    const lines = linesOf(snapshot);
    const names = await procurementReferenceNames(q, scope, {
      vendorIds: [idAt(snapshot, 'vendorPartyId')],
      vendorBillIds: lines.map((line) => idAt(line, 'vendorBillId')),
    });
    const byId = new Map(names.map((n) => [n.id, n.name]));
    const items: ReferenceName[] = lines.flatMap((line) => {
      const item = idAt(line, 'openItemId');
      const bill = byId.get(idAt(line, 'vendorBillId') ?? '');
      return item === undefined || bill === undefined ? [] : [{ id: item, name: bill }];
    });
    const account = idAt(snapshot, 'vendorBankAccountId');
    const last4 = (snapshot as { bankLast4?: unknown } | null)?.bankLast4;
    const bank: ReferenceName[] =
      account !== undefined && typeof last4 === 'string' && last4 !== ''
        ? [{ id: account, name: `Account ending ${last4}` }]
        : [];
    return [...names, ...items, ...bank];
  }

  /**
   * The request as it stands now: vendor, total, status and the bills it pays by number, with each bill's own file.
   * The request page is linked only for a holder of `payables.payment.request`, which its routes ask for.
   */
  async context(
    q: Db,
    scope: TxScope,
    request: { documentId: string },
    viewer: Principal,
  ): Promise<ApprovalContext | null> {
    const [row] = await q
      .select({
        id: paymentRequests.id,
        number: paymentRequests.number,
        currency: paymentRequests.currency,
        totalAmount: paymentRequests.totalAmount,
        status: paymentRequests.status,
        requestedBy: paymentRequests.requestedBy,
        vendorName: vendors.legalName,
      })
      .from(paymentRequests)
      .leftJoin(
        vendors,
        and(
          eq(vendors.tenantId, paymentRequests.tenantId),
          eq(vendors.id, paymentRequests.vendorId),
        ),
      )
      .where(scoped(scope).where(paymentRequests, eq(paymentRequests.id, request.documentId)));
    if (row === undefined) return null;
    const billIds = await q
      .select({ id: openItems.sourceId })
      .from(paymentRequestLines)
      .innerJoin(
        openItems,
        and(
          eq(openItems.tenantId, paymentRequestLines.tenantId),
          eq(openItems.organizationId, paymentRequestLines.organizationId),
          eq(openItems.id, paymentRequestLines.openItemId),
        ),
      )
      .where(
        scoped(scope).where(paymentRequestLines, eq(paymentRequestLines.paymentRequestId, row.id)),
      )
      .orderBy(asc(paymentRequestLines.lineNo));
    const order = [...new Set(billIds.map((b) => b.id))];
    const bills = (await billHeads(q, scope, order)).sort(
      (a, b) => order.indexOf(a.id) - order.indexOf(b.id),
    );
    return {
      title: `Payment request ${row.number ?? ''}`.trim(),
      fields: [
        ...fact.text('vendor', 'Vendor', row.vendorName),
        ...fact.money('totalAmount', 'Total requested', row.totalAmount, row.currency),
        ...fact.text('bills', 'Bills', bills.map(billLabel).join(', ')),
        ...fact.status(row.status),
      ],
      documents: await readableDocuments(
        q,
        scope,
        viewer,
        bills.map((b) => b.documentId),
        billFileOwners(q),
      ),
      // The detail page reads through the caller's own scope, where the requester owns the request.
      href: hrefFor(viewer, `/payables/payment-requests/${row.id}`, 'payables.payment.request', {
        ...scope,
        ownerUserId: row.requestedBy,
      }),
    };
  }

  async onDecided(tx: DbTransaction, requestId: string, outcome: Outcome): Promise<void> {
    const { scope } = await readTxContext(tx);
    const [request] = await tx
      .select()
      .from(paymentRequests)
      .where(scoped(scope).where(paymentRequests, eq(paymentRequests.id, requestId)))
      .for('update');
    if (request === undefined) throw conflict('not_found', 'The payment request was not found');
    if (request.status === 'approved' && outcome === 'approved') {
      this.log.warn(`payment request ${request.id} is already approved; nothing to do`);
      return;
    }
    if (request.status !== 'pending_approval') {
      this.log.error(`payment request ${request.id} is ${request.status}; refusing ${outcome}`);
      throw conflict('invalid_transition', 'The payment request is not waiting for a decision');
    }
    const status = statusAfter(outcome);
    await tx
      .update(paymentRequests)
      .set({ status, version: sql`${paymentRequests.version} + 1`, updatedAt: this.clock() })
      .where(
        scoped(scope).where(
          paymentRequests,
          and(eq(paymentRequests.id, request.id), eq(paymentRequests.status, 'pending_approval')),
        ),
      );
    await this.audit.record(tx, {
      action: `payables.payment_request.${outcome}`,
      entityType: PAYMENT_REQUEST_AUDIT_ENTITY,
      entityId: request.id,
      before: { status: request.status },
      after: { status, outcome },
    });
  }
}
