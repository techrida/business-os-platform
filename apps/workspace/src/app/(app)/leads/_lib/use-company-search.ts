'use client';
// The search behind the New lead company field (BOS-UI-002, replacing the F1-Q54 a duplicate box): waits until typing
// pauses, asks the BFF for the customers and open leads the user may read that look like the text, and drops every
// answer but the latest. A failed or refused search is "no suggestions", never an error: the list still offers
// Create "<text>", so the lead stays quick to create.
import {
  LEAD_DUPLICATE_MIN_LENGTH,
  type LeadDuplicateMatch,
  LeadDuplicatesResponseSchema,
} from '@bos/contracts';
import { useEffect, useState } from 'react';

const NO_MATCHES: LeadDuplicateMatch[] = [];

/** How long typing must pause before a search. */
export const COMPANY_SEARCH_DELAY_MS = 250;

export type CompanySearcher = (
  company: string,
  signal: AbortSignal,
) => Promise<LeadDuplicateMatch[]>;

/** The BFF route of the new-lead page; throws on any failure (the hook turns that into no suggestions). */
export const searchCompanies: CompanySearcher = async (company, signal) => {
  const res = await fetch(`/leads/new/duplicates?${new URLSearchParams({ company }).toString()}`, {
    cache: 'no-store',
    signal,
  });
  if (!res.ok) throw new Error(`Company search failed with ${res.status}`);
  return LeadDuplicatesResponseSchema.parse(await res.json()).matches;
};

/** The text worth searching (3+ characters, trimmed), or null. */
export function companyQuery(text: string): string | null {
  const t = text.trim().replace(/\s+/g, ' ');
  return t.length >= LEAD_DUPLICATE_MIN_LENGTH ? t : null;
}

/**
 * The matches for `text`: empty while it is too short, after a failure, or when nothing matched. `search` undefined
 * turns the search off (a form without a data source is a plain field).
 */
export function useCompanySearch(
  text: string,
  search: CompanySearcher | undefined,
  delayMs: number = COMPANY_SEARCH_DELAY_MS,
): LeadDuplicateMatch[] {
  const [found, setFound] = useState<{ query: string; matches: LeadDuplicateMatch[] } | null>(null);
  const query = search === undefined ? null : companyQuery(text);

  useEffect(() => {
    if (query === null || search === undefined) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      search(query, controller.signal).then(
        (matches) => {
          if (!controller.signal.aborted) setFound({ query, matches });
        },
        () => {
          if (!controller.signal.aborted) setFound({ query, matches: [] });
        },
      );
    }, delayMs);
    // A new keystroke (or unmount) cancels the wait and the request in flight, so a slow old answer never lands.
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, search, delayMs]);

  // The last answer is only shown for the text it answered, so an old list never sits under new text.
  return query !== null && found?.query === query ? found.matches : NO_MATCHES;
}
