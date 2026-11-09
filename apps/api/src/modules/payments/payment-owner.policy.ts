// The document owner policies of customer payments (P3 U7). Two owner types, because the proof of a payment is
// uploaded before the payment exists (SubmitPaymentBody and PortalSubmitPaymentBody both require
// `proofDocumentIds`, min 1):
// - `payment_intake` (owner id = the customer party id): a bank slip uploaded for a payment that is about to be
//   submitted. Staff need `payment.record` (`uploadPermission`, whoever records payments uploads their proof) on
//   that customer, not `documents.upload`; a portal customer may upload only to its own party
//   (`allowsCounterparty`). Submit then links these documents to the new payment in `payment_proofs`.
// - `payment` (owner id = the payment id): a further proof added while the payment is still submitted. A portal
//   customer may attach to its own payment only (`allowsCounterparty`).
// Serves the NFR "deny by default": no background job may add files to either owner except the receipt job on a
// verified or reversed payment (`allowsSystemActor`), and nothing attaches to a payment once it left submitted.
// The policies decide on loaded heads, so the unit tests need no database; the drizzle loaders are what
// PaymentsModule registers.
import type { Permission } from '@bos/contracts';
import { parties, payments } from '@bos/db';
import { and, eq } from 'drizzle-orm';

import type { ResourceRef } from '../../platform/authz/can';
import type { Db, DbTransaction } from '../../platform/db/db.module';
import type { Actor, TxScope } from '../../platform/db/tx';
import type {
  CounterpartyPrincipal,
  DocumentOwnerPolicy,
} from '../../platform/documents/documents.ports';

export const PAYMENT_OWNER_TYPE = 'payment';
export const PAYMENT_INTAKE_OWNER_TYPE = 'payment_intake';

/** The job name (after `system:`) that may add a generated receipt to a verified or reversed payment. */
export const PAYMENT_RECEIPT_JOB_PREFIX = 'payment-receipt';

type PaymentStatus = typeof payments.$inferSelect.status;

export interface PaymentOwnerHead {
  status: PaymentStatus;
  tenantId: string;
  organizationId: string;
  customerPartyId: string | null;
  submittedBy: string;
}

/** With `tx`, the payment row is locked FOR SHARE, so an attach cannot interleave with verify or reject. */
export type PaymentHeadLoader = (
  scope: TxScope,
  paymentId: string,
  tx?: DbTransaction,
) => Promise<PaymentOwnerHead | undefined>;

/** True when `partyId` is a customer party of the tenant. */
export type CustomerPartyLoader = (tenantId: string, partyId: string) => Promise<boolean>;

export function paymentRef(head: Omit<PaymentOwnerHead, 'status'>): ResourceRef {
  return {
    tenantId: head.tenantId,
    organizationId: head.organizationId,
    ownerUserId: head.submittedBy,
    customerPartyId: head.customerPartyId,
    sodUserIds: [],
  };
}

export class PaymentOwnerPolicy implements DocumentOwnerPolicy {
  readonly ownerType = PAYMENT_OWNER_TYPE;

  constructor(private readonly load: PaymentHeadLoader) {}

  async resource(scope: TxScope, ownerId: string): Promise<ResourceRef | null> {
    const head = await this.load(scope, ownerId);
    return head === undefined ? null : paymentRef(head);
  }

  /** Proof may be added while the payment waits for Finance, never after it was decided. */
  async canAttach(scope: TxScope, ownerId: string, tx?: DbTransaction): Promise<boolean> {
    const head = await this.load(scope, ownerId, tx);
    return head !== undefined && head.status === 'submitted';
  }

  /** Only the receipt job, and only on a numbered (verified or reversed) payment. */
  async allowsSystemActor(
    scope: TxScope,
    ownerId: string,
    actor: Pick<Actor, 'kind' | 'id'>,
    tx?: DbTransaction,
  ): Promise<boolean> {
    if (actor.kind !== 'system' || !actor.id.startsWith(`system:${PAYMENT_RECEIPT_JOB_PREFIX}`)) {
      return false;
    }
    const head = await this.load(scope, ownerId, tx);
    return head !== undefined && (head.status === 'verified' || head.status === 'reversed');
  }

  /** A customer attaches proof to its own submitted payment, in the entity it is acting in. */
  async allowsCounterparty(
    principal: CounterpartyPrincipal,
    ownerId: string,
    tx: DbTransaction,
  ): Promise<boolean> {
    if (principal.kind !== 'customer') return false;
    const scope = { tenantId: principal.tenantId, organizationId: principal.organizationId };
    const head = await this.load(scope, ownerId, tx);
    return (
      head !== undefined &&
      head.status === 'submitted' &&
      head.customerPartyId !== null &&
      head.customerPartyId === principal.partyId
    );
  }
}

export class PaymentIntakeOwnerPolicy implements DocumentOwnerPolicy {
  readonly ownerType = PAYMENT_INTAKE_OWNER_TYPE;
  /** Staff upload proof with the grant that records the payment it backs. */
  readonly uploadPermission: Permission = 'payment.record';

  constructor(private readonly isCustomer: CustomerPartyLoader) {}

  /** The customer the proof is for, as a record of the acting entity (its `customer_org` scope). */
  async resource(scope: TxScope, ownerId: string): Promise<ResourceRef | null> {
    if (!(await this.isCustomer(scope.tenantId, ownerId))) return null;
    return {
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      customerPartyId: ownerId,
      sodUserIds: [],
    };
  }

  /** No job uploads payment proof. */
  allowsSystemActor(): Promise<boolean> {
    return Promise.resolve(false);
  }

  /** A customer uploads proof for itself only. */
  allowsCounterparty(principal: CounterpartyPrincipal, ownerId: string): Promise<boolean> {
    return Promise.resolve(principal.kind === 'customer' && principal.partyId === ownerId);
  }
}

/** The payment in this tenant and acting entity. */
export function drizzlePaymentHeadLoader(db: Db): PaymentHeadLoader {
  return async (scope, paymentId, tx) => {
    const query = (tx ?? db)
      .select({
        status: payments.status,
        tenantId: payments.tenantId,
        organizationId: payments.organizationId,
        customerPartyId: payments.customerPartyId,
        submittedBy: payments.submittedBy,
      })
      .from(payments)
      .where(
        and(
          eq(payments.tenantId, scope.tenantId),
          eq(payments.organizationId, scope.organizationId),
          eq(payments.id, paymentId),
        ),
      )
      .limit(1);
    const [found] = tx === undefined ? await query : await query.for('share');
    return found;
  };
}

export function drizzleCustomerPartyLoader(db: Db): CustomerPartyLoader {
  return async (tenantId, partyId) => {
    const [found] = await db
      .select({ id: parties.id })
      .from(parties)
      .where(
        and(eq(parties.tenantId, tenantId), eq(parties.id, partyId), eq(parties.kind, 'customer')),
      )
      .limit(1);
    return found !== undefined;
  };
}
