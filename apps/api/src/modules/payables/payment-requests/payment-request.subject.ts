// The payment_request approval subject (P4 unit A2; AD1): what a decision does to its request, in the deciding
// transaction (ApprovalsService.act), so the decision and its effect commit or roll back together.
// - approved: the request is approved. That is terminal in Stage 1: no payout, no allocation, nothing posted to the
//   ledger. The bill keeps its `approved` status, which the vendor portal already shows as approved_for_payment.
// - returned or rejected: the request is rejected (PAYMENT_REQUEST_TRANSITIONS has no way back to draft); its lines
//   stop claiming their open items, so a new request may ask for the amount again.
// - approved again on a request that is already approved (a replayed decision): nothing to do, so it returns.
// A request that is not waiting for this decision is refused (409), never silently skipped.
import { paymentRequests, scoped } from '@bos/db';
import { ConflictException, Logger } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';

import type { AuditService } from '../../../platform/audit/audit.service';
import type { DbTransaction } from '../../../platform/db/db.module';
import { readTxContext } from '../../../platform/documents/tx-context';
import type { ApprovalSubject } from '../../approvals/requests.service';
import {
  PAYMENT_REQUEST_AUDIT_ENTITY,
  PAYMENT_REQUEST_DOCUMENT_TYPE,
  statusAfter,
} from './payment-request.rules';

type Outcome = 'approved' | 'returned' | 'rejected';

const conflict = (code: string, message: string) => new ConflictException({ code, message });

export class PaymentRequestSubject implements ApprovalSubject {
  readonly documentType = PAYMENT_REQUEST_DOCUMENT_TYPE;
  private readonly log = new Logger(PaymentRequestSubject.name);

  constructor(
    private readonly audit: AuditService,
    private readonly clock: () => Date = () => new Date(),
  ) {}

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
