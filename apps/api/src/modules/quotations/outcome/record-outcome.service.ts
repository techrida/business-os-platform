// RecordOutcomeService: staff record the customer's answer to a Sent quotation version (P2 unit Q3b). The rules are
// QuotationOutcomeService's; this class adds what only the staff route has: a staff principal, the
// `quotation.record_acceptance` permission on the quotation itself (own scope means the quotation's owner), the
// Idempotency-Key, and the nudge after commit. A quotation outside the acting entity or the caller's scope is a 404.
import { type AcceptanceDto, type Permission, type RecordOutcomeBody } from '@bos/contracts';
import { quotations, scoped } from '@bos/db';
import { ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { eq } from 'drizzle-orm';

import { AuthzService } from '../../../platform/authz/authz.service';
import { DB, type Db } from '../../../platform/db/db.module';
import { withIdempotency } from '../../../platform/db/idempotency';
import { withTx } from '../../../platform/db/tx';
import { NotifyService } from '../../../platform/notify/notify.service';
import { DraftingCaller } from '../drafting/drafting.caller';
import { quotationRef } from '../preview/quotation-preview.service';
import { QuotationOutcomeService } from './quotation-outcome.service';

const RECORD_ACTION: Permission = 'quotation.record_acceptance';

const notFound = () => new NotFoundException({ code: 'not_found', message: 'Quotation not found' });

@Injectable()
export class RecordOutcomeService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly outcomes: QuotationOutcomeService,
    private readonly authz: AuthzService,
    private readonly notify: NotifyService,
    private readonly caller: DraftingCaller,
  ) {}

  /**
   * `POST /v1/quotations/:id/versions/:vid/outcome`. 404 for a quotation outside the entity or the caller's scope,
   * or a version of another quotation; 409 for a stale expectedVersion, a version that is not Sent, or one past
   * its validity; 422 for evidence the policy does not accept or a decision dated after today.
   */
  async record(
    quotationId: string,
    versionId: string,
    body: RecordOutcomeBody,
    idempotencyKey: string,
  ): Promise<AcceptanceDto> {
    const { scope, actor, principal } = this.caller.current();
    // Decided before any read: a portal caller holding the key by mistake learns nothing.
    if (principal.orgKind !== 'staff' || actor.kind !== 'user') {
      throw new ForbiddenException({
        code: 'forbidden',
        message: 'Forbidden',
        reason: 'no_permission',
      });
    }
    const actorUserId = actor.id;
    const done = await withTx(this.db, scope, actor, (tx) =>
      withIdempotency(
        tx,
        {
          command: 'quotation.record_outcome',
          key: idempotencyKey,
          body: { id: quotationId, vid: versionId, ...body },
        },
        async () => {
          const [quotation] = await tx
            .select()
            .from(quotations)
            .where(scoped(scope).where(quotations, eq(quotations.id, quotationId)))
            .for('update');
          if (quotation === undefined) throw notFound();
          this.assertMayRecord(quotation);
          const common = {
            quotationId,
            versionId,
            actorKind: 'staff' as const,
            actorUserId,
            decidedOn: body.decidedOn,
            expectedVersion: body.expectedVersion,
            evidenceKinds: body.evidenceKinds,
            evidenceDocumentIds: body.evidenceDocumentIds ?? [],
          };
          const response =
            body.outcome === 'accepted'
              ? await this.outcomes.accept(tx, { ...common, comment: body.comment ?? null })
              : await this.outcomes.reject(tx, {
                  ...common,
                  // RecordOutcomeBodySchema requires a comment to reject; checked again for a caller that skips it.
                  comment: body.comment ?? '',
                  rejectionSource: 'customer',
                });
          return { status: 201, response };
        },
      ),
    );
    if (!done.replayed && body.outcome === 'accepted') await this.notify.nudge();
    return done.response;
  }

  /**
   * Record-level authz that answers 404, not 403, for a quotation outside the caller's scope: a 403 would confirm
   * that a guessed id exists. Other denials (no grant at all, inactive user) stay 403.
   */
  private assertMayRecord(row: typeof quotations.$inferSelect): void {
    try {
      this.authz.assert(RECORD_ACTION, quotationRef(row));
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
