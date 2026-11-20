// Shapes of the portal-access route (K8). @bos/contracts has no portal-access body or response yet, so they
// live here; move them to contracts/src/portal.ts when the workspace UI needs them.
import type { VendorPortalCapability } from '@bos/contracts';
import type { customers, vendors } from '@bos/db';
import { z } from 'zod';

import type { Actor, TxScope } from '../../platform/db/tx';

/** The party kinds a portal org can belong to (`app.idp_orgs.kind` minus staff, ADR 0027 section 2). */
export type PortalPartyKind = 'customer' | 'vendor';

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
  /** Whether that org already mirrors a portal user; false means this grant invites the first admin (F1-Q31). */
  hasPortalUser: boolean;
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

// ------------------------------------------------------------------------------------------------- vendors (K4)

/** `POST /v1/vendors/:id/portal-access` body: the vendor contact who becomes the portal admin. */
export const GrantVendorPortalAccessBodySchema = z.strictObject({ contactId: z.uuid() });
export type GrantVendorPortalAccessBody = z.infer<typeof GrantVendorPortalAccessBodySchema>;

/** The vendor grant's answer (201, and the same body on an Idempotency-Key replay). */
export interface VendorPortalAccessDto {
  vendorId: string;
  contactId: string;
  /** `app.users.id` of the portal admin. */
  userId: string;
  /** `app.idp_orgs.id` of the vendor's portal org (kind vendor). */
  idpOrgId: string;
  email: string;
  status: 'invited' | 'active' | 'inactive';
  inviteSent: boolean;
  /** What the vendor may do in the portal right now: `onboarding_only` while its KYC is pending. */
  capability: VendorPortalCapability;
}

export type VendorRow = typeof vendors.$inferSelect;

/** What the vendor grant needs to know before it touches ZITADEL. */
export interface VendorPortalTarget {
  vendor: VendorRow;
  /** Null when the contact does not exist or belongs to another vendor. */
  contact: { id: string; fullName: string; emailNorm: string | null } | null;
  /** The vendor's portal org (`idp_orgs` row of kind vendor), or null before the first grant. */
  idpOrg: { idpOrgId: string; zitadelOrgId: string } | null;
}

export interface VendorFinishInput extends Omit<FinishInput, 'customerId'> {
  vendorId: string;
  capability: VendorPortalCapability;
}

/**
 * The database side of the vendor grant, a port like PortalAccessStore (kept apart so the customer port and its
 * fakes stay as they are). SqlPortalAccessStore implements both on the same tables.
 */
export abstract class VendorPortalAccessStore {
  /** Null when the vendor is not in the caller's tenant. */
  abstract loadVendorTarget(
    tenantId: string,
    vendorId: string,
    contactId: string,
  ): Promise<VendorPortalTarget | null>;

  abstract idpOrgByZitadelId(zitadelOrgId: string): Promise<IdpOrgOwner | null>;

  abstract isMirrored(zitadelUserId: string): Promise<boolean>;

  abstract recordVendorRequested(
    scope: TxScope,
    actor: Actor,
    vendorId: string,
    contactId: string,
  ): Promise<void>;

  /** Inserts the vendor's `idp_orgs` row (kind vendor), or returns the one already there. */
  abstract linkVendorOrg(
    scope: TxScope,
    actor: Actor,
    i: { partyId: string; zitadelOrgId: string; name: string },
  ): Promise<{ idpOrgId: string; created: boolean }>;

  /** As PortalAccessStore.finish, with the role vendor_user and its own idempotency command. */
  abstract finishVendor(
    scope: TxScope,
    actor: Actor,
    i: VendorFinishInput,
  ): Promise<{ status: number; response: VendorPortalAccessDto; replayed: boolean }>;
}
