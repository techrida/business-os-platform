import { z } from 'zod';

/** Same shape the API accepts for `x-request-id` (see the API correlation middleware). */
export const CorrelationIdSchema = z.string().regex(/^[A-Za-z0-9-]{8,64}$/);

export const OrgKindSchema = z.enum(['staff', 'customer', 'vendor']);
export type OrgKind = z.infer<typeof OrgKindSchema>;

/** Response body of `GET /v1/me`. */
export const MeResponseSchema = z.object({
  /** ZITADEL `sub`. */
  userId: z.string().min(1),
  tenantId: z.guid(),
  organizationId: z.guid(),
  orgKind: OrgKindSchema,
  /** The customer or vendor party of a portal caller (ADR 0027); null for staff. */
  partyId: z.guid().nullable(),
  roles: z.array(z.string()),
  correlationId: CorrelationIdSchema,
  /** The caller's picture (`app.users.avatar_document_id`); null or absent shows initials. */
  avatarDocumentId: z.guid().nullable().optional(),
});
export type MeResponse = z.infer<typeof MeResponseSchema>;
