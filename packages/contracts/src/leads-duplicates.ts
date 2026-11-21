// The duplicate hint of the new-lead form (F1-Q54 a): while a lead's company, person, email or phone is typed, the
// workspace asks GET /v1/leads/duplicates for leads and customers that look like the same party. A hint only: it
// never blocks a save. The API answers only records the caller may read (an out-of-scope record is not even
// counted), so a kind the caller cannot read is simply absent.
import { z } from 'zod';

/** A field shorter than this (trimmed) is not looked up: two characters match too much. */
export const LEAD_DUPLICATE_MIN_LENGTH = 3;
/** A phone needs at least this many digits; the last 7 to 10 digits are compared. */
export const LEAD_DUPLICATE_MIN_PHONE_DIGITS = 7;
/** The most matches one answer holds. */
export const LEAD_DUPLICATE_LIMIT = 5;

export const LEAD_DUPLICATE_FIELDS = ['company', 'name', 'email', 'phone'] as const;
export const LeadDuplicateFieldSchema = z.enum(LEAD_DUPLICATE_FIELDS);
export type LeadDuplicateField = z.infer<typeof LeadDuplicateFieldSchema>;

const typed = z.string().trim().max(200).optional();

/** `?company=&name=&email=&phone=`; every field optional, blank or short ones are ignored. */
export const LeadDuplicatesQuerySchema = z.strictObject({
  company: typed,
  name: typed,
  email: typed,
  phone: z.string().trim().max(40).optional(),
});
export type LeadDuplicatesQuery = z.infer<typeof LeadDuplicatesQuerySchema>;

/** One readable record that looks like the lead being typed; `label` is what the hint links. */
export const LeadDuplicateMatchSchema = z.object({
  kind: z.enum(['lead', 'customer']),
  id: z.guid(),
  label: z.string(),
  matchedOn: z.array(LeadDuplicateFieldSchema).min(1),
});
export type LeadDuplicateMatch = z.infer<typeof LeadDuplicateMatchSchema>;

export const LeadDuplicatesResponseSchema = z.object({
  matches: z.array(LeadDuplicateMatchSchema).max(LEAD_DUPLICATE_LIMIT),
});
export type LeadDuplicatesResponse = z.infer<typeof LeadDuplicatesResponseSchema>;
