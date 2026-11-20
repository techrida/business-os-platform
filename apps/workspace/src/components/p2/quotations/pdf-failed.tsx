'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { requestPdfRetry } from '@/components/ui/pdf-retry';
import { toast } from '@/components/ui/toast';

import styles from './detail.module.css';

/**
 * A quotation PDF whose render was given up after its last try (round 4, R4c2: F1-Q13): the words say so, never
 * "Preparing PDF" for ever. With `retryHref` (a viewer who may send, as the retry route requires `quotation.send`),
 * Retry asks for a fresh set of tries and re-renders the page, which then reads "Preparing PDF" again. A refused or
 * failed request is a toast; the page stays as it was.
 */
export function PdfFailed({ retryHref }: { retryHref?: string | undefined }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const retry = async (href: string) => {
    if (busy) return;
    setBusy(true);
    const outcome = await requestPdfRetry(href);
    setBusy(false);
    if (outcome === 'failed') {
      toast.error('Could not request a retry', { id: 'pdf-retry' });
      return;
    }
    // 409: it no longer needs one (someone else asked); the refresh shows what it is now.
    if (outcome === 'queued') toast.success('Retry requested', { id: 'pdf-retry' });
    router.refresh();
  };
  return (
    <span className={styles.pdfState}>
      <span>The PDF could not be prepared.</span>
      {retryHref !== undefined ? (
        <Button
          variant="tertiary"
          size="small"
          disabled={busy}
          aria-busy={busy || undefined}
          onClick={() => void retry(retryHref)}
        >
          Retry
        </Button>
      ) : null}
    </span>
  );
}
