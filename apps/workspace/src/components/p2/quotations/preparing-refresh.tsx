'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef } from 'react';

import { Button } from '@/components/ui/button';
import { usePreparePoll } from '@/components/ui/use-prepare-poll';

import type { PdfWords } from './document-link';
import styles from './detail.module.css';

/** Only the words that a background job will soon replace are worth waiting on. */
export function shouldAutoRefresh(words: PdfWords): boolean {
  return words === 'Preparing PDF';
}

const CHECK_TIMEOUT_MS = 8_000;

/**
 * Shows the words for a PDF that is on its way and, on the shared schedule (use-prepare-poll.ts: 1 s, 2 s, 4 s, 8 s,
 * 15 s, then 30 s), asks the small status route (one API read) whether it is still being prepared. The server page is
 * re-rendered with `router.refresh()` once, when the status says the PDF is no longer being prepared, so the link, or the
 * "could not be prepared" state, appears by itself (round 4, R4c2: TR-Q4; round 7, U1-18). The schedule outlasts the time
 * the render sweeper takes to store the PDF or give up; if it runs out first, "Check again" starts a fresh round. It never
 * fetches or links to the document route, because that route issues a single-use signed link on every call.
 */
export function PreparingRefresh({
  text,
  quotationId,
  versionId,
}: {
  text: PdfWords;
  quotationId: string;
  versionId: string;
}) {
  const router = useRouter();
  const auto = shouldAutoRefresh(text);
  const inFlight = useRef<AbortController | null>(null);
  useEffect(() => () => inFlight.current?.abort(), []);

  const check = useCallback(() => {
    if (inFlight.current !== null) return;
    const own = new AbortController();
    inFlight.current = own;
    const query = new URLSearchParams({ quotationId, versionId });
    void fetch(`/api/documents/status?${query}`, {
      cache: 'no-store',
      credentials: 'same-origin',
      signal: AbortSignal.any([own.signal, AbortSignal.timeout(CHECK_TIMEOUT_MS)]),
    })
      .then(async (response) => {
        if (!response.ok) return;
        const body = (await response.json()) as { preparing?: unknown };
        if (!own.signal.aborted && body.preparing === false) router.refresh();
      })
      .catch(() => undefined)
      .finally(() => {
        if (inFlight.current === own) inFlight.current = null;
      });
  }, [quotationId, versionId, router]);

  const { expired, restart } = usePreparePoll(auto, check);

  if (!expired) return <span>{text}</span>;
  return (
    <span className={styles.pdfState}>
      <span>Still preparing the PDF.</span>
      <Button
        variant="tertiary"
        size="small"
        onClick={() => {
          router.refresh();
          restart();
        }}
      >
        Check again
      </Button>
    </span>
  );
}
