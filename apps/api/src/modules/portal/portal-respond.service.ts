// The customer's accept and reject in the portal (P2 unit PA-3). Serves the NFRs:
// - "deny-by-default" and "a customer sees only what we meant to show": only a customer principal with a party gets
//   in (403 before the key, the body or any read); the version is read through the respond store, scoped to the
//   caller's tenant, acting entity and party by `portal.quotation.respond`, and anything out of reach or not
//   customer-visible is a 404, so existence never leaks. QuotationOutcomeService does no authorization: this class
//   is the only gate before it, and it also passes the version's quotation so the core re-binds the two;
// - "no double effects": the Idempotency-Key is required and the claim, the answer and its effects share one
//   transaction, so a retry after a timeout replays the stored answer;
// - "every change is audited": the core writes the acceptance, history, audit and the opportunity's Won in the same
//   transaction, stamped with the portal user.
//
// A visible version that is no longer Sent (accepted, rejected by the customer, superseded, expired) answers 409,
// not 404: the customer can already see that version, so its existence is no secret, and a 409 lets the portal say
// "already answered, reload" instead of "not found". `expired` keeps the core's own `quotation_expired` code.
// The answer is a narrow strict shape: AcceptanceDto is an internal DTO and never goes to the portal.
import {
  AcceptQuotationBodySchema,
  RejectQuotationBodySchema,
  type AcceptQuotationBody,
  type RejectQuotationBody,
} from '@bos/contracts';
import { ConflictException, Inject, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { z } from 'zod';

import type { Principal } from '../../platform/authz/principal';
import { DB, type Db } from '../../platform/db/db.module';
import { withIdempotency } from '../../platform/db/idempotency';
import { withTx, type TxScope } from '../../platform/db/tx';
import { NotifyService } from '../../platform/notify/notify.service';
import { parseOr400 } from '../approvals/approvals.controller';
import { requireIdempotencyKey } from '../customers/customers.types';
import {
  QUOTATION_OUTCOME_CLOCK,
  QuotationOutcomeService,
} from '../quotations/outcome/quotation-outcome.service';
import { kathmanduDay } from '../quotations/reference/reference.types';
import { assertCustomerCaller, PortalCaller, PortalTxActor } from './portal.caller';
import { isClosedToCustomer, isPortalVisible, quotationClosed } from './portal.service';
import {
  PORTAL_RESPOND_STORE,
  type PortalRespondStore,
  type PortalVersionHead,
} from './portal.store';

/** What the customer gets back: the version answered, the outcome and the day it counts for. Nothing internal. */
export const PortalDecisionSchema = z.strictObject({
  id: z.guid(),
  status: z.enum(['accepted', 'rejected']),
  decidedOn: z.string(),
});
export type PortalDecision = z.infer<typeof PortalDecisionSchema>;

type Decision =
  | { outcome: 'accepted'; body: AcceptQuotationBody }
  | { outcome: 'rejected'; body: RejectQuotationBody };

const notFound = () => new NotFoundException({ code: 'not_found', message: 'Quotation not found' });

/** A visible version that can no longer be answered. */
function notAnswerable(status: PortalVersionHead['status']): ConflictException {
  return status === 'expired'
    ? new ConflictException({ code: 'quotation_expired', message: 'This quotation has expired' })
    : new ConflictException({
        code: 'quotation_not_sent',
        message: 'This quotation has already been answered or is no longer open',
      });
}

@Injectable()
export class PortalRespondService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly caller: PortalCaller,
    private readonly txActor: PortalTxActor,
    @Inject(PORTAL_RESPOND_STORE) private readonly store: PortalRespondStore,
    private readonly outcomes: QuotationOutcomeService,
    private readonly notify: NotifyService,
    // The core's clock, so the day passed here and the day the core checks against never disagree.
    @Optional()
    @Inject(QUOTATION_OUTCOME_CLOCK)
    private readonly clock: () => Date = () => new Date(),
  ) {}

  /** `POST /v1/portal/quotations/:id/accept`. 201 with the decision; 400, 403, 404, 409 or 422 otherwise. */
  async accept(
    versionId: string,
    idempotencyKey: string | undefined,
    body: unknown,
  ): Promise<PortalDecision> {
    const p = this.gate();
    const key = requireIdempotencyKey(idempotencyKey);
    return this.decide(p, versionId, key, {
      outcome: 'accepted',
      body: parseOr400(AcceptQuotationBodySchema, body),
    });
  }

  /** `POST /v1/portal/quotations/:id/reject`. A comment is required. */
  async reject(
    versionId: string,
    idempotencyKey: string | undefined,
    body: unknown,
  ): Promise<PortalDecision> {
    const p = this.gate();
    const key = requireIdempotencyKey(idempotencyKey);
    return this.decide(p, versionId, key, {
      outcome: 'rejected',
      body: parseOr400(RejectQuotationBodySchema, body),
    });
  }

  /** The caller, checked before anything else: a customer principal with a party, or 403. */
  private gate(): Principal {
    const p = this.caller.current();
    assertCustomerCaller(p);
    return p;
  }

  private async decide(
    p: Principal,
    versionId: string,
    key: string,
    decision: Decision,
  ): Promise<PortalDecision> {
    const done = await withTx(this.db, scopeOf(p), this.txActor.current(), (tx) =>
      withIdempotency(
        tx,
        {
          command:
            decision.outcome === 'accepted' ? 'portal.quotation.accept' : 'portal.quotation.reject',
          key,
          body: { id: versionId, ...decision.body },
        },
        async () => {
          const head = await this.store.findHead(tx, p, versionId);
          // A sent version the company cancelled (a Lost deal) is no secret to the customer who holds its link: the page
          // they left open says "no longer open", like the page itself does (R6D, EF2 Q2).
          if (head !== undefined && isClosedToCustomer(head)) throw quotationClosed();
          // Visibility first, so a hidden version answers exactly like an unknown one.
          if (head === undefined || !isPortalVisible(head)) throw notFound();
          if (head.status !== 'sent') throw notAnswerable(head.status);
          const common = {
            versionId,
            quotationId: head.quotationId,
            actorKind: 'customer_user' as const,
            actorUserId: p.userId,
            decidedOn: kathmanduDay(this.clock()),
          };
          const acceptance =
            decision.outcome === 'accepted'
              ? await this.outcomes.accept(tx, {
                  ...common,
                  acceptedByName: decision.body.acceptedByName,
                  // The typed name and the ticked box are the customer's signature (AcceptQuotationBodySchema).
                  evidenceKinds: ['signed_quote'],
                })
              : await this.outcomes.reject(tx, {
                  ...common,
                  comment: decision.body.comment,
                  rejectionSource: 'customer',
                });
          const response = PortalDecisionSchema.parse({
            id: acceptance.versionId,
            status: acceptance.outcome,
            decidedOn: acceptance.decidedOn,
          });
          return { status: 201, response };
        },
      ),
    );
    // The owner's notice was queued in the transaction; wake the drainer now that it committed.
    if (!done.replayed && decision.outcome === 'accepted') await this.notify.nudge();
    return done.response;
  }
}

/** The acting entity: the respond store reads only there, so the answer is written there too. */
const scopeOf = (p: Principal): TxScope => ({
  tenantId: p.tenantId,
  organizationId: p.organizationId,
});
