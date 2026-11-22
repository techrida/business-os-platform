// CancelService: ends a quotation that has not been approved yet (Kuu, F1-Q27: Cancel only, no Recall). Serves the NFRs:
// - "every change is audited": one withTx() holds the approval cancel, the version update, the status-history row
//   (with the reason) and the audit event, so they commit or roll back together;
// - "no double effects": cancel runs inside withIdempotency, so a retried POST returns the first answer;
// - "authorization is deny-by-default": staff only, `quotation.draft` on the quotation itself (own scope means the
//   quotation's owner, the same rule as editing it), and the quotation is read through scoped(), so another
//   entity's quotation is a 404.
//
// Which versions: the current one, while it is Draft, Returned or Submitted (canCancelQuotation). A Submitted
// version's open approval request is cancelled first, with the same reason, so it leaves every inbox. An Approved
// or Sent version is not cancelled here: it has been, or may be, shown to the customer.
//
// Lost opportunity: cancelOnLost() ends the opportunity's one live version per quotation inside the transaction that
// marks the deal Lost (QuotationLostHandler, the OpportunityLostHandler the module registers at start). It reuses the
// same write as the route (applyCancel: approval request, version, quotation row, history, audit) but, being a
// consequence of the loss and not a user's Cancel, it also ends an Approved or Sent version (the customer must stop
// being able to accept; QUOTATION_TRANSITIONS `cancel_on_lost`). Accepted, rejected, expired, superseded and
// already-cancelled versions are final and stay as they are. No record-level authz runs: the user's right to mark
// the deal Lost was checked by the opportunity route; the actor is that user. Any error rolls the loss back.
//
// Lock order: the tenant audit lock (withTx takes it first), then the quotation row, the approval request
// (ApprovalsService.cancel) and the version (the final UPDATE). ApprovalsService.act also starts with the tenant audit
// lock, so an approver deciding while the owner cancels waits for it instead of deadlocking on the request; whichever
// commits second gets 409.
import {
  canCancelOnLost,
  canCancelQuotation,
  type CancelQuotationBody,
  type Permission,
  type QuotationVersionDto,
} from '@bos/contracts';
import {
  approvalRequests,
  quotationLines,
  quotations,
  quotationStatusHistory,
  quotationTaxSummary,
  quotationVersions,
  scoped,
} from '@bos/db';
import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { and, asc, eq, sql } from 'drizzle-orm';

import { AuditService } from '../../../platform/audit/audit.service';
import { AuthzService } from '../../../platform/authz/authz.service';
import { DB, type Db, type DbTransaction } from '../../../platform/db/db.module';
import { withIdempotency } from '../../../platform/db/idempotency';
import { withTx, type Actor, type TxScope } from '../../../platform/db/tx';
import { ApprovalsService } from '../../approvals/requests.service';
import { versionVisibleTo } from './cost-visibility';
import { DraftingCaller } from './drafting.caller';
import { draftRefOf } from './drafting.service';
import { toQuotationVersionDto } from './mapping';

/** Injection token for a test clock; production falls back to the system time. */
export const CANCEL_CLOCK = Symbol('CANCEL_CLOCK');

const CANCEL_ACTION: Permission = 'quotation.draft';
const AUDIT_ENTITY = 'quotations';
/** Approval request statuses that are still open, so a cancel must cancel them (ApprovalsService.cancel). */
const OPEN_REQUEST = ['pending', 'blocked'];

const notFound = () => new NotFoundException({ code: 'not_found', message: 'Quotation not found' });
const conflict = (message: string) => new ConflictException({ code: 'conflict', message });
const changed = () =>
  conflict('This quotation was changed by someone else; reload it and try again');

@Injectable()
export class CancelService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly approvals: ApprovalsService,
    private readonly authz: AuthzService,
    private readonly audit: AuditService,
    private readonly caller: DraftingCaller,
    @Optional() @Inject(CANCEL_CLOCK) private readonly clock: () => Date = () => new Date(),
  ) {}

  /**
   * `POST /v1/quotations/:id/cancel`. 404 for a quotation outside the acting entity or the caller's scope; 409 for
   * a stale expectedVersion (the current version row's `version`), a current version that is not Draft, Returned
   * or Submitted, or an approval decided meanwhile. Returns the cancelled version.
   */
  async cancel(
    quotationId: string,
    body: CancelQuotationBody,
    idempotencyKey: string,
  ): Promise<QuotationVersionDto> {
    const { scope, actor, principal } = this.caller.current();
    // Decided before any read: a portal caller holding the key by mistake learns nothing.
    if (principal.orgKind !== 'staff') {
      throw new ForbiddenException({
        code: 'forbidden',
        message: 'Forbidden',
        reason: 'no_permission',
      });
    }
    const now = this.clock();
    // The stored answer (replayed on a retry) is the full DTO; the cost figures are dropped for this caller per reply.
    const dto = await withTx(this.db, scope, actor, async (tx) => {
      const done = await withIdempotency(
        tx,
        { command: 'quotation.cancel', key: idempotencyKey, body: { id: quotationId, ...body } },
        async () => ({
          status: 200,
          response: await this.cancelInTx(tx, scope, actor, quotationId, body, now),
        }),
      );
      return done.response;
    });
    return versionVisibleTo(principal, dto);
  }

  /**
   * The Lost cascade: ends the live version of every quotation of `opportunityId` (see the header). Runs in the
   * opportunity's transaction, as the user who marked it Lost. Returns the ids of the quotations it cancelled.
   */
  async cancelOnLost(
    tx: DbTransaction,
    scope: TxScope,
    actor: Actor,
    opportunityId: string,
    lostReason: string,
  ): Promise<string[]> {
    const now = this.clock();
    const reason =
      lostReason.trim() === ''
        ? 'Opportunity marked lost'
        : `Opportunity marked lost: ${lostReason}`;
    // In id order, so two cascades never take the rows in opposite orders.
    const rows = await tx
      .select()
      .from(quotations)
      .where(scoped(scope).where(quotations, eq(quotations.opportunityId, opportunityId)))
      .orderBy(asc(quotations.id))
      .for('update');
    const cancelledIds: string[] = [];
    for (const quotation of rows) {
      if (quotation.currentVersionId === null) continue;
      const [old] = await tx
        .select()
        .from(quotationVersions)
        .where(
          scoped(scope).where(
            quotationVersions,
            and(
              eq(quotationVersions.id, quotation.currentVersionId),
              eq(quotationVersions.quotationId, quotation.id),
            ),
          ),
        );
      if (old === undefined) {
        throw new Error(`quotation ${quotation.number}: current version is missing`);
      }
      if (!canCancelOnLost(old.status)) continue;
      await this.applyCancel(tx, scope, actor, quotation, old, reason, now, {
        cause: 'opportunity_lost',
        opportunityId,
      });
      cancelledIds.push(quotation.id);
    }
    return cancelledIds;
  }

  private async cancelInTx(
    tx: DbTransaction,
    scope: TxScope,
    actor: Actor,
    quotationId: string,
    body: CancelQuotationBody,
    now: Date,
  ): Promise<QuotationVersionDto> {
    const [quotation] = await tx
      .select()
      .from(quotations)
      .where(scoped(scope).where(quotations, eq(quotations.id, quotationId)))
      .for('update');
    if (quotation === undefined) throw notFound();
    this.assertMayCancel(quotation);
    if (quotation.currentVersionId === null) {
      throw new Error(`quotation ${quotation.number} has no current version`);
    }
    const [old] = await tx
      .select()
      .from(quotationVersions)
      .where(
        scoped(scope).where(
          quotationVersions,
          and(
            eq(quotationVersions.id, quotation.currentVersionId),
            eq(quotationVersions.quotationId, quotation.id),
          ),
        ),
      );
    if (old === undefined) {
      throw new Error(`quotation ${quotation.number}: current version is missing`);
    }
    // Checked before any write, so a stale caller changes nothing.
    if (old.version !== body.expectedVersion) throw changed();
    // Revision 1 and revision 2 both start at row version 1: the id says which one the caller meant.
    if (body.versionId !== undefined && body.versionId !== old.id) throw changed();
    if (!canCancelQuotation(old.status)) {
      throw conflict(
        `A ${old.status} quotation cannot be cancelled; only a draft, returned or submitted one can`,
      );
    }
    const { cancelled } = await this.applyCancel(
      tx,
      scope,
      actor,
      quotation,
      old,
      body.reason,
      now,
    );

    const lines = await tx
      .select()
      .from(quotationLines)
      .where(and(eq(quotationLines.tenantId, scope.tenantId), eq(quotationLines.versionId, old.id)))
      .orderBy(asc(quotationLines.lineNo));
    const taxSummary = await tx
      .select()
      .from(quotationTaxSummary)
      .where(
        and(
          eq(quotationTaxSummary.tenantId, scope.tenantId),
          eq(quotationTaxSummary.versionId, old.id),
        ),
      );
    return toQuotationVersionDto({
      quotation: { number: quotation.number, customerPartyId: quotation.customerPartyId },
      version: cancelled,
      lines,
      taxSummary,
      renderedScanStatus: null,
    });
  }

  /**
   * The one write of a cancel, shared by the route and the Lost cascade: the open approval request of a Submitted
   * version, the version (guarded on the status and row version the caller read), the quotation row, one history
   * row and one audit event. `meta` goes onto the audit event.
   */
  private async applyCancel(
    tx: DbTransaction,
    scope: TxScope,
    actor: Actor,
    quotation: typeof quotations.$inferSelect,
    old: typeof quotationVersions.$inferSelect,
    reason: string,
    now: Date,
    meta?: Record<string, unknown>,
  ): Promise<{ cancelled: typeof quotationVersions.$inferSelect }> {
    const actorId = actor.kind === 'user' ? actor.id : null;

    // (1) A Submitted version's open approval request is cancelled with the same reason (it locks the request).
    let cancelledRequestId: string | null = null;
    if (old.status === 'submitted' && old.approvalRequestId !== null) {
      const [request] = await tx
        .select({ status: approvalRequests.status })
        .from(approvalRequests)
        .where(
          and(
            eq(approvalRequests.tenantId, scope.tenantId),
            eq(approvalRequests.id, old.approvalRequestId),
          ),
        )
        .limit(1);
      if (request !== undefined && OPEN_REQUEST.includes(request.status)) {
        try {
          await this.approvals.cancel(tx, old.approvalRequestId, reason, actor);
        } catch (error) {
          // Decided between the read above and the request lock: the version is about to leave Submitted.
          if (error instanceof ConflictException) throw changed();
          throw error;
        }
        cancelledRequestId = old.approvalRequestId;
      }
    }

    // (2) The version, on the id, status and row version read above: a change made since is a 409.
    const [cancelled] = await tx
      .update(quotationVersions)
      .set({
        status: 'cancelled',
        cancelReason: reason,
        cancelledAt: now,
        updatedAt: now,
        version: sql`${quotationVersions.version} + 1`,
      })
      .where(
        and(
          eq(quotationVersions.tenantId, scope.tenantId),
          eq(quotationVersions.id, old.id),
          eq(quotationVersions.status, old.status),
          eq(quotationVersions.version, old.version),
        ),
      )
      .returning();
    if (cancelled === undefined) throw changed();

    // (3) The quotation's derived status changed: its row moves too.
    await tx
      .update(quotations)
      .set({ updatedAt: now, version: sql`${quotations.version} + 1` })
      .where(and(eq(quotations.tenantId, scope.tenantId), eq(quotations.id, quotation.id)));

    // (4) History with the reason, and one audit event.
    await tx.insert(quotationStatusHistory).values({
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      versionId: old.id,
      fromStatus: old.status,
      toStatus: 'cancelled',
      actorId,
      reason,
      at: now,
    });
    await this.audit.record(tx, {
      action: 'quotation.cancelled',
      entityType: AUDIT_ENTITY,
      entityId: quotation.id,
      before: { versionId: old.id, revisionNo: old.revisionNo, status: old.status },
      after: {
        versionId: old.id,
        status: 'cancelled',
        reason,
        cancelledApprovalRequestId: cancelledRequestId,
      },
      ...(meta === undefined ? {} : { meta }),
    });
    return { cancelled };
  }

  /**
   * Record-level authz that answers 404, not 403, for a quotation outside the caller's scope: a 403 would confirm
   * that a guessed id exists. Other denials (no grant at all, inactive user) stay 403.
   */
  private assertMayCancel(row: typeof quotations.$inferSelect): void {
    try {
      this.authz.assert(CANCEL_ACTION, draftRefOf(row));
    } catch (error) {
      const reason =
        error instanceof ForbiddenException
          ? (error.getResponse() as { reason?: unknown }).reason
          : undefined;
      if (reason === 'out_of_scope') throw notFound();
      throw error;
    }
  }
}
