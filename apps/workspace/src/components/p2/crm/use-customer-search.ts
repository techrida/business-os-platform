'use client';
// The live search of the convert wizard: waits until typing pauses, asks the server for the customers that look like
// the typed name and for those with exactly the entered PAN, and drops every answer but the latest. A failed search
// is "no suggestions" plus one error message; it never blocks the form.
import { useEffect, useRef, useState } from 'react';

import { searchConversionCustomers, type ConversionCustomer } from './record-lookups';

export const CUSTOMER_SEARCH_DELAY_MS = 250;
/** Shorter text is too vague to search; a PAN or number of two characters is not either. */
export const CUSTOMER_SEARCH_MIN_LENGTH = 2;
const NONE: ConversionCustomer[] = [];

export interface CustomerSearchResult {
  customers: ConversionCustomer[];
  panMatches: ConversionCustomer[];
}

/**
 * `text` is the typed name or number; `pan`, when set, is looked up exactly. Results belong to the (text, pan) pair
 * that asked, so an old list never sits under new text.
 */
export function useCustomerSearch(
  text: string,
  pan: string | undefined,
  {
    delayMs = CUSTOMER_SEARCH_DELAY_MS,
    onError,
  }: { delayMs?: number | undefined; onError?: ((m: string) => void) | undefined } = {},
): CustomerSearchResult {
  const query = text.trim().length >= CUSTOMER_SEARCH_MIN_LENGTH ? text.trim() : '';
  const key = `${query}\u0000${pan ?? ''}`;
  const [found, setFound] = useState<{ key: string } & CustomerSearchResult>({
    key: '',
    customers: NONE,
    panMatches: NONE,
  });
  const report = useRef(onError);
  useEffect(() => {
    report.current = onError;
  });

  useEffect(() => {
    if (query === '' && pan === undefined) return;
    let active = true;
    const timer = setTimeout(() => {
      searchConversionCustomers(query, pan).then(
        (r) => {
          if (!active) return;
          if (r.error) report.current?.(r.error);
          setFound({ key, customers: r.customers, panMatches: r.panMatches });
        },
        () => {
          if (!active) return;
          report.current?.('Organisations could not be loaded. Try again.');
          setFound({ key, customers: NONE, panMatches: NONE });
        },
      );
    }, delayMs);
    // A new keystroke (or unmount) cancels the wait and marks the answer stale, so a slow old one never lands.
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [query, pan, key, delayMs]);

  return found.key === key ? found : { customers: NONE, panMatches: NONE };
}
