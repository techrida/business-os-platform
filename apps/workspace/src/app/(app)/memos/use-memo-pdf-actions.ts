'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import { toast } from '@/components/ui/toast';

import { downloadMemoPdf, printMemoPaper, type PdfSource } from './memo-pdf-client';

/**
 * Download and Print for one memo paper, with the result shown as a toast (never as text beside a button).
 * `source` may change on every keystroke; the latest one is read when the action runs.
 */
export function useMemoPdfActions(source: PdfSource, paperId: string) {
  const [busy, setBusy] = useState(false);
  const sourceRef = useRef(source);
  useEffect(() => {
    sourceRef.current = source;
  });
  const running = useRef(false);

  const download = useCallback(async () => {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    try {
      const outcome = await downloadMemoPdf(sourceRef.current);
      if (outcome.ok) {
        toast.success(outcome.message, outcome.detail ? { description: outcome.detail } : {});
      } else {
        toast.error(outcome.message);
      }
    } finally {
      running.current = false;
      setBusy(false);
    }
  }, []);

  const print = useCallback(async () => {
    const ok = await printMemoPaper(paperId);
    if (!ok) toast.error('The memo could not be printed. Try again.');
  }, [paperId]);

  return { busy, download, print };
}
