import { z } from 'zod';

/**
 * The duplicate warning a convert call answers with. ASSUMED SHAPE: the contracts name no response
 * for it (A2 only says the server "returns a duplicate warning naming that contact"), so this one
 * local schema is the single place to change when the API fixes it:
 * `409 { error: { code: 'duplicate_found', duplicates: [{ kind, id, label, matchedOn, customerId? }] } }`.
 */
const CandidateSchema = z.object({
  kind: z.enum(['customer', 'contact']),
  id: z.guid(),
  label: z.string(),
  /** What matched: email, phone or name. */
  matchedOn: z.string(),
  /** For a contact, the customer it belongs to (so "use existing" can link both). */
  customerId: z.guid().optional(),
});
export type DuplicateCandidate = z.infer<typeof CandidateSchema>;

const WarningSchema = z.object({
  error: z.object({
    code: z.literal('duplicate_found'),
    duplicates: z.array(CandidateSchema).min(1),
  }),
});

/** The candidates when `body` is a duplicate warning; null for every other body. */
export function duplicatesFrom(body: unknown): DuplicateCandidate[] | null {
  const parsed = WarningSchema.safeParse(body);
  return parsed.success ? parsed.data.error.duplicates : null;
}
