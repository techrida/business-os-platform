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
  /**
   * The actor's display name, looked up at read time from app.users in the caller's tenant. It is not part of
   * the stored row or the hash. null when the actor is not a person (system, zitadel, seed), the id is not a
   * user of this tenant, or the person has no name; optional so older API responses still parse.
   */
  actorDisplayName: z.string().nullable().optional(),
  action: z.string(),
  entityType: z.string(),
  entityId: z.string(),
  before: z.unknown(),
  after: z.unknown(),
  meta: z.unknown(),
  /**
   * before/after/meta exactly as Postgres prints them (jsonb::text), or null when the column is null.
   * This is the text the hash covers: `before`/`after`/`meta` above are parsed JSON, which has lost the key
   * order and number formatting (1.50 becomes 1.5), so a verifier must hash these strings, not those values.
   */
  canonical: z.object({
    before: z.string().nullable(),
    after: z.string().nullable(),
    meta: z.string().nullable(),
  }),
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
  /**
   * Why the chain failed, from audit.verify_chain; null when ok. Optional so older API responses still parse.
   * Known values: hash_mismatch, prev_hash_mismatch, seal_count_mismatch, seal_hash_mismatch.
   */
  reason: z.string().nullable().optional(),
});
export type ChainVerifyDto = z.infer<typeof ChainVerifyDtoSchema>;
