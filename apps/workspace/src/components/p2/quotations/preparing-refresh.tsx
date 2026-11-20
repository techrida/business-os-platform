'use client';

import { useRouter } from 'next/navigation';

import { Button } from '@/components/ui/button';
import { usePreparePoll } from '@/components/ui/use-prepare-poll';

import type { PdfWords } from './document-link';
import styles from './detail.module.css';

/** Only the words that a background job will soon replace are worth waiting on. */
export function shouldAutoRefresh(words: PdfWords): boolean {
  return words === 'Preparing PDF';
}

/**
 * Shows the words for a PDF that is on its way and re-renders the server page on the shared schedule
 * (use-prepare-poll.ts) until the link, or the "could not be prepared" state, appears by itself
 * (round 4, R4c2: TR-Q4). The schedule outlasts the time the render sweeper takes to store the PDF or
 * give up; if it runs out first, "Check again" starts a fresh round. It only calls `router.refresh()`:
 * it never fetches or links to the document route, because that route issues a single-use signed
 * link on every call.
 */
export function PreparingRefresh({ text }: { text: PdfWords }) {
  const router = useRouter();
  const auto = shouldAutoRefresh(text);
  const { expired, restart } = usePreparePoll(auto, () => router.refresh());

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
