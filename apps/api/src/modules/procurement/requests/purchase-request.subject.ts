// The purchase_request approval subject (P4 unit P1): what a decided approval does to the request it was about.
// Serves the NFR "approvals are auditable": the status moves in the deciding transaction, so the decision and the
// request's new status commit or roll back together, and a request that is not waiting for a decision is refused
// (409) instead of silently skipped, which would leave the two tables disagreeing forever.
// No `link` hook: the approval.decided email allows only the inbox, memos and quotations areas, so the requester
// is sent to the request in the inbox. Registered by PurchaseRequestsModule in the API only.
import type { ApprovalContext } from '@bos/contracts';
import { purchaseRequests, scoped } from '@bos/db';
import { ConflictException, Logger } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';

import type { Principal } from '../../../platform/authz/principal';
import type { Db, DbTransaction } from '../../../platform/db/db.module';
import type { TxScope } from '../../../platform/db/tx';
import { readTxContext } from '../../../platform/documents/tx-context';
import { fact, hrefFor } from '../../approvals/context';
import type { ApprovalSubject } from '../../approvals/requests.service';
import { idAt, procurementReferenceNames } from '../reference-names';
import { purchaseRequestRef } from './purchase-requests.service';
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

  /**
   * The request as it stands now. A request has no files of its own. Its page is linked only when the reader's
   * `procurement.pr.read` reaches it (the same ref the request routes check); a head without that read sees no link.
   */
  async context(
    q: Db,
    scope: TxScope,
    request: { documentId: string },
    viewer: Principal,
  ): Promise<ApprovalContext | null> {
    const [pr] = await q
      .select()
      .from(purchaseRequests)
      .where(scoped(scope).where(purchaseRequests, eq(purchaseRequests.id, request.documentId)));
    if (pr === undefined) return null;
    const names = new Map(
      (
        await procurementReferenceNames(q, scope, {
          departmentIds: [pr.departmentId],
          costCenterIds: [pr.costCenterId],
        })
      ).map((n) => [n.id, n.name]),
    );
    return {
      title: `Purchase request ${pr.number ?? ''}`.trim(),
      fields: [
        ...fact.text('requestType', 'Type', pr.requestType),
        ...fact.text('department', 'Department', names.get(pr.departmentId)),
        ...fact.text('costCenter', 'Cost centre', names.get(pr.costCenterId)),
        ...fact.date('requiredBy', 'Required by', pr.requiredBy),
        ...fact.money('estimatedTotal', 'Estimated total', pr.estimatedTotal, pr.currency),
        ...fact.status(pr.status),
      ],
      documents: [],
      href: hrefFor(
        viewer,
        `/procurement/requests/${pr.id}`,
        'procurement.pr.read',
        purchaseRequestRef(pr),
      ),
    };
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
