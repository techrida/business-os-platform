// The purchase_request approval subject (P4 unit P1): what a decided approval does to the request it was about.
// Serves the NFR "approvals are auditable": the status moves in the deciding transaction, so the decision and the
// request's new status commit or roll back together, and a request that is not waiting for a decision is refused
// (409) instead of silently skipped, which would leave the two tables disagreeing forever.
// No `link` hook: the approval.decided email allows only the inbox, memos and quotations areas, so the requester
// is sent to the request in the inbox. Registered by PurchaseRequestsModule in the API only.
import { purchaseRequests, scoped } from '@bos/db';
import { ConflictException, Logger } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';

import type { Db, DbTransaction } from '../../../platform/db/db.module';
import type { TxScope } from '../../../platform/db/tx';
import { readTxContext } from '../../../platform/documents/tx-context';
import type { ApprovalSubject } from '../../approvals/requests.service';
import { idAt, procurementReferenceNames } from '../reference-names';
import { PR_STATUS_AFTER_DECISION, PURCHASE_REQUEST_DOCUMENT_TYPE } from './purchase-request.rules';

type Outcome = keyof typeof PR_STATUS_AFTER_DECISION;

const conflict = (message: string) => new ConflictException({ code: 'conflict', message });

export class PurchaseRequestSubject implements ApprovalSubject {
  readonly documentType = PURCHASE_REQUEST_DOCUMENT_TYPE;
  private readonly log = new Logger(PurchaseRequestSubject.name);

  constructor(private readonly clock: () => Date = () => new Date()) {}

  /** The request's department and cost centre by name (the requester is among the request's people). */
  referenceNames(q: Db, scope: TxScope, snapshot: unknown) {
    return procurementReferenceNames(q, scope, {
      departmentIds: [idAt(snapshot, 'purchaseRequest', 'departmentId')],
      costCenterIds: [idAt(snapshot, 'purchaseRequest', 'costCenterId')],
    });
  }

  /** Runs in the deciding transaction (ApprovalsService.act); scope and actor come from its bos.* settings. */
  async onDecided(tx: DbTransaction, requestId: string, outcome: Outcome): Promise<void> {
    const { scope } = await readTxContext(tx);
    const [pr] = await tx
      .select({ id: purchaseRequests.id, status: purchaseRequests.status })
      .from(purchaseRequests)
      .where(scoped(scope).where(purchaseRequests, eq(purchaseRequests.id, requestId)))
      .for('update');
    if (pr === undefined) {
      this.log.error(`purchase request ${requestId} not found; refusing outcome ${outcome}`);
      throw conflict('The purchase request is not waiting for a decision');
    }
    if (pr.status !== 'submitted') {
      this.log.error(
        `purchase request ${requestId} is ${pr.status}, not submitted; refusing outcome ${outcome}`,
      );
      throw conflict('The purchase request is not waiting for a decision');
    }
    const updated = await tx
      .update(purchaseRequests)
      .set({
        status: PR_STATUS_AFTER_DECISION[outcome],
        version: sql`${purchaseRequests.version} + 1`,
        updatedAt: this.clock(),
      })
      .where(
        scoped(scope).where(
          purchaseRequests,
          and(eq(purchaseRequests.id, requestId), eq(purchaseRequests.status, 'submitted')),
        ),
      )
      .returning({ id: purchaseRequests.id });
    if (updated.length === 0) throw conflict('The purchase request is not waiting for a decision');
  }

  /** A request is cancelled only while a draft (no approval request exists then), so there is nothing to undo. */
  onCancelled(_tx: DbTransaction, _requestId: string, _reason: string): Promise<void> {
    return Promise.resolve();
  }
}
