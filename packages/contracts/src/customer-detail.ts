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
 * The customer's portal access as staff see it (F1-Q31). `hasUser`: its portal org already has a user (the first
 * admin was invited). `canInvite`: this caller may invite a portal admin now, by the same rule the grant route
 * applies: customer.write on the record, not merged away, and, for the first admin, being the account owner.
 * KYB and the contact's email are still checked by the grant itself.
 */
export const CustomerPortalAccessSchema = z.object({
  hasUser: z.boolean(),
  canInvite: z.boolean(),
});
export type CustomerPortalAccess = z.infer<typeof CustomerPortalAccessSchema>;
