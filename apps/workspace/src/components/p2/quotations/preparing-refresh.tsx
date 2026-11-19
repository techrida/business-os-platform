'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

import type { PdfWords } from './document-link';

/** How often, and at most how many times, the page asks the server for fresh data. */
export const REFRESH_INTERVAL_MS = 5000;
export const MAX_REFRESHES = 12;

/** Only the words that a background job will soon replace are worth waiting on. */
export function shouldAutoRefresh(words: PdfWords): boolean {
  return words === 'Being prepared' || words === 'Being scanned';
}

/**
 * Shows the words for a PDF that is on its way and re-renders the server page a few times so the
 * link appears by itself. It only calls `router.refresh()`: it never fetches or links to the
 * document route, because that route issues a single-use signed link on every call.
 */
export function PreparingRefresh({ text }: { text: PdfWords }) {
  const router = useRouter();
  const auto = shouldAutoRefresh(text);

  useEffect(() => {
    if (!auto) return;
    let count = 0;
    const timer = setInterval(() => {
      count += 1;
      router.refresh();
      if (count >= MAX_REFRESHES) clearInterval(timer);
    }, REFRESH_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [auto, router]);

  return <span>{text}</span>;
}
