import { z } from 'zod';

/**
 * What the caller may do with one customer, decided by the API on that record (scope included), so the workspace
 * never shows a control the API would refuse. Staff readers only.
 */
export const CustomerCanSchema = z.object({
  /** Edit the customer and add contacts (customer.write on this record). */
  write: z.boolean(),
  /** Read this customer's verification case (verification.read on this record). */
  readVerification: z.boolean(),
  /** Start or reopen this customer's verification case: write and verification read on it, and not merged away. */
  openVerification: z.boolean(),
});
export type CustomerCan = z.infer<typeof CustomerCanSchema>;

/**
 * Whether this customer has a verification case at all. Existence only: the case itself (status, files) is read
 * through the verification routes under verification.read, so a caller who may not read it learns nothing more.
 */
export const CustomerVerificationPresenceSchema = z.object({ exists: z.boolean() });
export type CustomerVerificationPresence = z.infer<typeof CustomerVerificationPresenceSchema>;

/**
 * Why a caller who may change the customer cannot invite a portal admin now, in the grant route's order:
 * `owner_only` (no portal user yet and the caller is not the account owner), `owner_missing` (no portal user yet and
 * no account owner), `kyb_not_verified` (the customer's KYB case is not approved).
 */
export const PORTAL_INVITE_BLOCKS = ['owner_only', 'owner_missing', 'kyb_not_verified'] as const;
export const PortalInviteBlockSchema = z.enum(PORTAL_INVITE_BLOCKS);
export type PortalInviteBlock = z.infer<typeof PortalInviteBlockSchema>;

/**
 * The customer's portal access as staff see it (F1-Q31). `hasUser`: its portal org already has a user (the first
 * admin was invited; an invited user counts). `canInvite`: this caller may invite a portal admin now, by the rules the
 * grant route applies before it reads the contact: customer.write on the record, not merged away, the first admin
 * invited by the account owner, and an approved KYB case. `blocked` names the rule that stops a caller who may change
 * the customer; null when they may invite, or when they may not change the customer at all. The contact's email is
 * still checked by the grant itself.
 */
export const CustomerPortalAccessSchema = z.object({
  hasUser: z.boolean(),
  canInvite: z.boolean(),
  blocked: PortalInviteBlockSchema.nullable(),
});
export type CustomerPortalAccess = z.infer<typeof CustomerPortalAccessSchema>;
