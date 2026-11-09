// The customer portal's payments (P3 unit U13, part 3; plan A16). Serves the NFR "a customer sees only what we meant
// to show" and "a customer acts only for its own party":
// - only a customer principal with a party gets in (assertCustomerCaller, 403 before any query or write);
// - the list is `forCounterparty(payments, 'customer', partyId)` in the acting entity, and only when that entity is the
//   tenant's default one (the rule of the invoice reads, PortalBillingService): another entity shows nothing;
// - a submit never takes the customer from the body (the strict portal schema refuses a `customerId`): this service
//   sets it to the principal's party and the channel to `portal`, then calls U7's PaymentsService.submit, which asserts
//   `portal.payment.submit` on that party and answers 422 `invalid_proof` for a proof that was not uploaded for it;
// - a submit outside the default entity is refused with the same 403 as a non-customer, so no payment lands in an
//   entity the list would never show;
// - the answers are built field by field and parsed with the strict PortalPaymentListItemSchema: the staff PaymentDto
//   (submitter, verifier, NPR value, withholding, rejection reason, version) never reaches the customer.
import {
  PortalPaymentListItemSchema,
  type PortalPaymentListItem,
  type PortalSubmitPaymentBody,
} from '@bos/contracts';
import { organizations, payments, scoped } from '@bos/db';
import { ForbiddenException, Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, sql, type SQL } from 'drizzle-orm';

import type { Principal } from '../../platform/authz/principal';
import { DB, type Db } from '../../platform/db/db.module';
import type { TxScope } from '../../platform/db/tx';
import { PaymentsService } from '../payments/payments.service';
import { assertCustomerCaller, PortalCaller, PortalTxActor } from '../portal/portal.caller';

/** The strict portal view of one payment, field by field. Throws on a row off the contract (a bug, never data). */
export function toPortalPayment(p: {
  id: string;
  status: string;
  number: string | null;
  method: string;
  currency: string;
  amount: string;
  receivedOn: string;
  bankReference: string | null;
}): PortalPaymentListItem {
  return PortalPaymentListItemSchema.parse({
    id: p.id,
    status: p.status,
    number: p.number,
    method: p.method,
    currency: p.currency,
    amount: p.amount,
    receivedOn: p.receivedOn,
    bankReference: p.bankReference,
  });
}

@Injectable()
export class PortalPaymentsService {
  constructor(
    private readonly caller: PortalCaller,
    private readonly txActor: PortalTxActor,
    @Inject(DB) private readonly db: Db,
    private readonly staffPayments: PaymentsService,
  ) {}

  /** The caller's own payments, newest first. Empty outside the tenant's default entity. */
  async list(): Promise<PortalPaymentListItem[]> {
    const p = this.customer();
    const rows = await this.db
      .select({
        id: payments.id,
        status: payments.status,
        number: payments.number,
        method: payments.method,
        currency: payments.currency,
        amount: payments.amount,
        receivedOn: payments.receivedOn,
        bankReference: payments.bankReference,
      })
      .from(payments)
      .where(visibleTo(p))
      .orderBy(desc(payments.createdAt), desc(payments.id));
    return rows.map(toPortalPayment);
  }

  /**
   * Records a payment the caller says it sent (status `submitted`, channel `portal`) for the caller's own party.
   * 422 `invalid_proof` unless every proof is a clean file uploaded for this party and not yet used; replaying the
   * Idempotency-Key answers the first result.
   */
  async submit(
    body: PortalSubmitPaymentBody,
    idempotencyKey: string,
  ): Promise<PortalPaymentListItem> {
    const p = this.customer();
    if (!(await this.inDefaultEntity(p))) throw forbidden();
    const done = await this.staffPayments.submit(
      scopeOf(p),
      this.txActor.current(),
      // assertCustomerCaller ran first, so partyId is a non-empty string here.
      { ...body, customerId: p.partyId ?? '' },
      'portal',
      idempotencyKey,
    );
    return toPortalPayment(done);
  }

  // ------------------------------------------------------------------------------------------- internals

  private customer(): Principal {
    const p = this.caller.current();
    assertCustomerCaller(p);
    return p;
  }

  private async inDefaultEntity(p: Principal): Promise<boolean> {
    const [row] = await this.db
      .select({ id: organizations.id })
      .from(organizations)
      .where(
        and(
          eq(organizations.tenantId, p.tenantId),
          eq(organizations.id, p.organizationId),
          eq(organizations.isDefault, true),
        ),
      )
      .limit(1);
    return row !== undefined;
  }
}

/** Same body as AuthzService.assert and assertCustomerCaller. */
const forbidden = () =>
  new ForbiddenException({ code: 'forbidden', message: 'Forbidden', reason: 'no_permission' });

/** The acting entity: the only one any read touches. */
const scopeOf = (p: Principal): TxScope => ({
  tenantId: p.tenantId,
  organizationId: p.organizationId,
});

/** The caller's party in the acting entity (forCounterparty, ADR 0027 §5), only when that entity is the default. */
function visibleTo(p: Principal): SQL {
  const defaultEntity = sql`EXISTS (SELECT 1 FROM ${organizations}
      WHERE ${organizations.tenantId} = ${payments.tenantId}
        AND ${organizations.id} = ${payments.organizationId}
        AND ${organizations.isDefault})`;
  // assertCustomerCaller ran first, so partyId is a non-empty string here.
  return scoped(scopeOf(p)).forCounterparty(payments, 'customer', p.partyId ?? '', defaultEntity);
}
