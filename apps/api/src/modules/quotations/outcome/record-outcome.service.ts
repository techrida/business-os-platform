// RecordOutcomeService: staff record the customer's answer to a Sent quotation version (P2 unit Q3b). The rules are
// QuotationOutcomeService's; this class adds what only the staff route has: a staff principal, the
// `quotation.record_acceptance` permission on the quotation itself (own scope means the quotation's owner), the
// Idempotency-Key, and the nudge after commit. A quotation outside the acting entity or the caller's scope is a 404.
// F1-Q28 adds the staff confirmation of a portal acceptance's evidence (same permission: staff record what the
// customer gave them) and its read, which follows `quotation.read` like the quotation itself.
import {
  type AcceptanceDto,
  type ConfirmEvidenceBody,
  type Permission,
  type QuotationEvidenceDto,
  type RecordOutcomeBody,
} from '@bos/contracts';
import { quotations, quotationVersions, scoped } from '@bos/db';
import { ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';

import { AuthzService, scopeWhereFor } from '../../../platform/authz/authz.service';
import { can } from '../../../platform/authz/can';
import { type Principal } from '../../../platform/authz/principal';
import { DB, type Db } from '../../../platform/db/db.module';
import { withIdempotency } from '../../../platform/db/idempotency';
import { withTx } from '../../../platform/db/tx';
import { NotifyService } from '../../../platform/notify/notify.service';
import { DraftingCaller } from '../drafting/drafting.caller';
import { quotationRef } from '../preview/quotation-preview.service';
import { readEvidenceState } from './evidence-state';
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
    const actorUserId = this.staffUserId(principal, actor);
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
   * `POST /v1/quotations/:id/versions/:vid/evidence-confirmation` (F1-Q28): staff confirm the evidence they hold
   * for a portal acceptance. 404 outside the entity or scope; 409 `quotation_not_accepted` or
   * `evidence_already_confirmed`; 422 `evidence_policy_unmet` or `invalid_evidence_document`.
   */
  async confirmEvidence(
    quotationId: string,
    versionId: string,
    body: ConfirmEvidenceBody,
    idempotencyKey: string,
  ): Promise<QuotationEvidenceDto> {
    const { scope, actor, principal } = this.caller.current();
    const actorUserId = this.staffUserId(principal, actor);
    const done = await withTx(this.db, scope, actor, (tx) =>
      withIdempotency(
        tx,
        {
          command: 'quotation.confirm_evidence',
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
          const state = await this.outcomes.confirmEvidence(tx, {
            quotationId,
            versionId,
            actorUserId,
            evidenceKinds: body.evidenceKinds,
            evidenceDocumentIds: body.evidenceDocumentIds,
            comment: body.comment,
          });
          return {
            status: 201,
            response: await this.outcomes.evidenceView(tx, quotationId, state, false),
          };
        },
      ),
    );
    return done.response;
  }

  /**
   * `GET /v1/quotations/:id/versions/:vid/evidence`: where the evidence of an accepted version stands. 404 for a
   * quotation the caller may not read, a version of another quotation, or one with no acceptance.
   */
  async evidence(quotationId: string, versionId: string): Promise<QuotationEvidenceDto> {
    const { scope, actor, principal } = this.caller.current();
    this.staffUserId(principal, actor);
    return withTx(this.db, scope, actor, async (tx) => {
      const [quotation] = await tx
        .select()
        .from(quotations)
        .where(
          and(
            scopeWhereFor(principal, quotations, 'quotation.read'),
            eq(quotations.id, quotationId),
          ),
        );
      if (quotation === undefined) throw notFound();
      const [version] = await tx
        .select({ status: quotationVersions.status })
        .from(quotationVersions)
        .where(
          scoped(scope).where(
            quotationVersions,
            and(
              eq(quotationVersions.id, versionId),
              eq(quotationVersions.quotationId, quotationId),
            ),
          ),
        );
      const state =
        version === undefined ? undefined : await readEvidenceState(tx, scope, versionId);
      if (version === undefined || state === undefined) throw notFound();
      const mayConfirm =
        version.status === 'accepted' &&
        can(principal, RECORD_ACTION, quotationRef(quotation)).allowed;
      return this.outcomes.evidenceView(tx, quotationId, state, mayConfirm);
    });
  }

  /** The staff user behind the call, or 403 before any read: a portal caller holding the key learns nothing. */
  private staffUserId(principal: Principal, actor: { kind: string; id?: string }): string {
    if (principal.orgKind !== 'staff' || actor.kind !== 'user' || actor.id === undefined) {
      throw new ForbiddenException({
        code: 'forbidden',
        message: 'Forbidden',
        reason: 'no_permission',
      });
    }
    return actor.id;
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
