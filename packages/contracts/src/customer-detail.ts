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
