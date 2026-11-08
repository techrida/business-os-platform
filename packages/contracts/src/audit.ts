// What the audit read API returns. Fields follow audit.audit_events in section 4.
// Serves the NFR "the audit trail is tamper-evident": hashes are exposed so a verifier can recompute them.
import { z } from 'zod';

export const AUDIT_ACTOR_KINDS = ['user', 'system', 'zitadel', 'seed'] as const;
export const AuditActorKindSchema = z.enum(AUDIT_ACTOR_KINDS);

const hex = z.string().regex(/^[0-9a-f]+$/);

export const AuditEventDtoSchema = z.object({
  /** bigint in the database, so a string here: JSON numbers lose precision above 2^53. */
  id: z.string().regex(/^\d+$/),
  tenantId: z.guid(),
  organizationId: z.guid(),
  /** First day of the UTC month the event's hash chain belongs to (YYYY-MM-DD). */
  chainMonth: z.iso.date(),
  seq: z.number().int().min(1),
  occurredAt: z.iso.datetime({ offset: true }),
  actorKind: AuditActorKindSchema,
  actorId: z.string(),
  action: z.string(),
  entityType: z.string(),
  entityId: z.string(),
  before: z.unknown(),
  after: z.unknown(),
  meta: z.unknown(),
  ip: z.string().nullable(),
  userAgent: z.string().nullable(),
  correlationId: z.string(),
  /** Lowercase hex of the SHA-256 bytes. */
  prevHash: hex,
  hash: hex,
});
export type AuditEventDto = z.infer<typeof AuditEventDtoSchema>;

/** Result of `GET /v1/audit/verify?month=`: did recomputing the chain reproduce every stored hash? */
export const ChainVerifyDtoSchema = z.object({
  tenantId: z.guid(),
  /** YYYY-MM */
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
  ok: z.boolean(),
  rows: z.number().int().nonnegative(),
  /** The first sequence number whose hash did not match; null when ok. */
  firstBadSeq: z.number().int().nullable(),
});
export type ChainVerifyDto = z.infer<typeof ChainVerifyDtoSchema>;
