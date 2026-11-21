'use client';
// The lookup behind the new-lead form's duplicate hint (F1-Q54 a): waits until typing pauses, asks the BFF for
// readable leads and customers that look like the one being typed, and drops every answer but the latest. A failed or
// refused lookup is "no hint", never an error: the hint must not stand between the user and Save.
import {
  LEAD_DUPLICATE_MIN_LENGTH,
  LEAD_DUPLICATE_MIN_PHONE_DIGITS,
  type LeadDuplicateMatch,
  LeadDuplicatesResponseSchema,
} from '@bos/contracts';
import { useEffect, useState } from 'react';

const NO_MATCHES: LeadDuplicateMatch[] = [];

/** How long typing must pause before a lookup. */
export const DUPLICATE_HINT_DELAY_MS = 400;

export interface DuplicateFields {
  company: string;
  name: string;
  email: string;
  phone: string;
}

export type DuplicateFetcher = (
  query: URLSearchParams,
  signal: AbortSignal,
) => Promise<LeadDuplicateMatch[]>;

/** The BFF route of the new-lead page; throws on any failure (the hook turns that into no hint). */
export const fetchLeadDuplicates: DuplicateFetcher = async (query, signal) => {
  const res = await fetch(`/leads/new/duplicates?${query.toString()}`, {
    cache: 'no-store',
    signal,
  });
  if (!res.ok) throw new Error(`Duplicate lookup failed with ${res.status}`);
  return LeadDuplicatesResponseSchema.parse(await res.json()).matches;
};

/** The fields worth looking up (3+ characters, phone 7+ digits); null when none is. */
export function duplicateQuery(fields: DuplicateFields): URLSearchParams | null {
  const query = new URLSearchParams();
  for (const key of ['company', 'name', 'email'] as const) {
    const value = fields[key].trim();
    if (value.length >= LEAD_DUPLICATE_MIN_LENGTH) query.set(key, value);
  }
  if (fields.phone.replace(/\D/g, '').length >= LEAD_DUPLICATE_MIN_PHONE_DIGITS) {
    query.set('phone', fields.phone.trim());
  }
  return query.size === 0 ? null : query;
}

/** The current matches for `fields`; empty while nothing qualifies, after a failure, or when nothing matched. */
export function useDuplicateHint(
  fields: DuplicateFields,
  fetcher: DuplicateFetcher = fetchLeadDuplicates,
  delayMs: number = DUPLICATE_HINT_DELAY_MS,
): LeadDuplicateMatch[] {
  const [matches, setMatches] = useState<LeadDuplicateMatch[]>([]);
  const key = duplicateQuery(fields)?.toString() ?? '';

  useEffect(() => {
    if (key === '') return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      fetcher(new URLSearchParams(key), controller.signal).then(
        (found) => {
          if (!controller.signal.aborted) setMatches(found);
        },
        () => {
          if (!controller.signal.aborted) setMatches([]);
        },
      );
    }, delayMs);
    // A new keystroke (or unmount) cancels the wait and the request in flight, so a slow old answer never lands.
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [key, fetcher, delayMs]);

  // Nothing worth looking up hides the hint at once; otherwise the last answer stays until the next one lands.
  return key === '' ? NO_MATCHES : matches;
}
