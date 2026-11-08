// Shapes of the portal-access route (K8). @bos/contracts has no portal-access body or response yet, so they
// live here; move them to contracts/src/portal.ts when the workspace UI needs them.
import type { customers } from '@bos/db';
import { z } from 'zod';

import type { Actor, TxScope } from '../../platform/db/tx';

/** `POST /v1/customers/:id/portal-access` body: the customer contact who becomes the portal admin. */
export const GrantPortalAccessBodySchema = z.strictObject({ contactId: z.uuid() });
export type GrantPortalAccessBody = z.infer<typeof GrantPortalAccessBodySchema>;

/** The answer (201, and the same body on an Idempotency-Key replay). */
export interface PortalAccessDto {
  customerId: string;
  contactId: string;
  /** `app.users.id` of the portal admin. */
  userId: string;
  /** `app.idp_orgs.id` of the customer's portal org. */
  idpOrgId: string;
  email: string;
  /** `invited` until the contact accepts the invite (then the first login turns it `active`). */
  status: 'invited' | 'active' | 'inactive';
  /** Whether this call asked ZITADEL to mail the invite. */
  inviteSent: boolean;
}

export type CustomerRow = typeof customers.$inferSelect;

/** What the route needs to know before it touches ZITADEL. */
export interface PortalTarget {
  customer: CustomerRow;
  /** Null when the contact does not exist or belongs to another customer. */
  contact: { id: string; fullName: string; emailNorm: string | null } | null;
  /** The status of the customer's KYB verification case, or null when there is none. */
  kybStatus: string | null;
  /** The customer's portal org (`idp_orgs` row of kind customer), or null before the first grant. */
  idpOrg: { idpOrgId: string; zitadelOrgId: string } | null;
}

/** An `idp_orgs` row found by its ZITADEL org id (any tenant: the column is unique across tenants). */
export interface IdpOrgOwner {
  idpOrgId: string;
  tenantId: string;
  kind: string;
  partyId: string | null;
}

/** One step done in ZITADEL, written to the audit log by `finish`. */
export interface PortalAccessStep {
  action: string;
  meta: Record<string, unknown>;
}

export interface FinishInput {
  idempotencyKey: string;
  customerId: string;
  contactId: string;
  idpOrgId: string;
  zitadelUserId: string;
  email: string;
  displayName: string;
  inviteSent: boolean;
  steps: PortalAccessStep[];
}

/**
 * The database side of portal access, behind a port so the service's order of steps can be unit-tested with
 * fakes. SqlPortalAccessStore is the real one. Every write runs in `withTx` with the staff caller as actor.
 */
export abstract class PortalAccessStore {
  /** Null when the customer is not in the caller's tenant. */
  abstract loadTarget(
    tenantId: string,
    customerId: string,
    contactId: string,
  ): Promise<PortalTarget | null>;

  abstract idpOrgByZitadelId(zitadelOrgId: string): Promise<IdpOrgOwner | null>;

  /** Whether `app.users` already mirrors this ZITADEL user (a previous attempt finished). */
  abstract isMirrored(zitadelUserId: string): Promise<boolean>;

  /** Audits the attempt before any external call, so a half-done grant still leaves a trace. */
  abstract recordRequested(
    scope: TxScope,
    actor: Actor,
    customerId: string,
    contactId: string,
  ): Promise<void>;

  /** Inserts the customer's `idp_orgs` row, or returns the one already there. Audited when inserted. */
  abstract linkOrg(
    scope: TxScope,
    actor: Actor,
    i: { partyId: string; zitadelOrgId: string; name: string },
  ): Promise<{ idpOrgId: string; created: boolean }>;

  /**
   * Under the Idempotency-Key: mirrors the user into `app.users` (status invited, or the row already there)
   * with the role customer_user, writes one audit row per step, and stores the answer for replays.
   */
  abstract finish(
    scope: TxScope,
    actor: Actor,
    i: FinishInput,
  ): Promise<{ status: number; response: PortalAccessDto; replayed: boolean }>;
}
