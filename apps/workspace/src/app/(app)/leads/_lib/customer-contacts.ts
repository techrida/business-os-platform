// The contacts of a linked customer, for the New lead contact field (BOS-UI-002). Shared by the page's BFF route and
// the form: the route answers `{ contacts }` in this shape and the form parses it.
import { z } from 'zod';

export const LeadContactOptionSchema = z.object({
  id: z.guid(),
  name: z.string(),
  /** Small text after the name in the list: the email, else the job title. */
  detail: z.string().nullable(),
});
export type LeadContactOption = z.infer<typeof LeadContactOptionSchema>;

export const LeadContactOptionsResponseSchema = z.object({
  contacts: z.array(LeadContactOptionSchema),
});

export type ContactLoader = (
  customerId: string,
  signal: AbortSignal,
) => Promise<LeadContactOption[]>;

/** The BFF route of the new-lead page; throws on any failure (the field then offers only Create "<text>"). */
export const loadCustomerContacts: ContactLoader = async (customerId, signal) => {
  const res = await fetch(`/leads/new/contacts?${new URLSearchParams({ customerId }).toString()}`, {
    cache: 'no-store',
    signal,
  });
  if (!res.ok) throw new Error(`Contacts lookup failed with ${res.status}`);
  return LeadContactOptionsResponseSchema.parse(await res.json()).contacts;
};
