// The wire contract of the memo working-draft autosave, shared by the browser form and the Route Handler. Kept apart
// from the store (which imports server-only code) so a client component can import these types and limits freely.
import { z } from 'zod';

/**
 * Hard limits. The form's own validation limits (title 200, body 10,000) are the contract's; the rest bound what a
 * half-typed form can carry. `template` is the form's signer-row state serialised as JSON by the form agent; the
 * server treats it as an opaque bounded string and never parses it.
 */
export const MEMO_DRAFT_LIMITS = {
  title: 200,
  body: 10_000,
  amount: 40,
  currency: 8,
  template: 16_000,
  /** The request body, in bytes. Generous for the fields above (UTF-8, JSON escaping) and still a bound. */
  requestBytes: 96 * 1024,
} as const;

export const MemoDraftValuesSchema = z.strictObject({
  title: z.string().max(MEMO_DRAFT_LIMITS.title),
  body: z.string().max(MEMO_DRAFT_LIMITS.body),
  amount: z.string().max(MEMO_DRAFT_LIMITS.amount),
  currency: z.string().max(MEMO_DRAFT_LIMITS.currency),
  template: z.string().max(MEMO_DRAFT_LIMITS.template).optional(),
});
export type MemoDraftValues = z.infer<typeof MemoDraftValuesSchema>;

/** 9 random bytes in base64url: exactly 12 characters. Opaque; compare only for equality. */
export const REVISION_PATTERN = /^[A-Za-z0-9_-]{12}$/;
export const MemoDraftRevisionSchema = z.string().regex(REVISION_PATTERN).nullable();

/** `PUT` body. */
export const MemoDraftPutBodySchema = z.strictObject({
  revision: MemoDraftRevisionSchema,
  values: MemoDraftValuesSchema,
});

/** `DELETE` body. */
export const MemoDraftDeleteBodySchema = z.strictObject({ revision: MemoDraftRevisionSchema });

/**
 * What GET, PUT and DELETE answer with.
 *
 * - `revision` null: the server has nothing (never written, or expired). Send `revision: null` with the first PUT.
 * - `revision` set and `values` null: the draft was deleted; `revision` names the tombstone. Send it as the
 *   expected revision to start a new draft over it.
 * - `revision` set and `values` set: a live draft.
 *
 * `updatedAt` (ISO 8601) is additive: when the server last changed the record, for a "changed in another tab" hint.
 */
export interface MemoDraftSnapshot {
  revision: string | null;
  values: MemoDraftValues | null;
  updatedAt: string | null;
}

/** The 409 body: the server's current snapshot, so the client can adopt it or retry on top of it. */
export interface MemoDraftConflictBody {
  error: { message: string; code: 'conflict' };
  current: MemoDraftSnapshot;
}

/** The scope a draft is stored under: `memoId` omitted/null is the new-memo draft. */
export type MemoDraftScopeId = string | null;
