'use client';

import { useEffect, useState } from 'react';

import type { FileView } from '@/components/p2/crm/verification-file';
import { needsPolling } from '@/lib/kernel-ui';

const SCAN_INTERVAL = 2_000;
const SCAN_WINDOW = 120_000;
const REQUEST_TIMEOUT = 8_000;

export function useFileScan(caseId: string, initial: FileView | null, enabled: boolean) {
  const [check, setCheck] = useState(0);
  const [observed, setObserved] = useState<{
    key: string;
    file?: FileView;
    stalled?: boolean;
  } | null>(null);
  const documentId = initial?.documentId;
  const versionId = initial?.versionId;
  const needsScan = initial !== null && needsPolling([initial.status]);
  const key = `${caseId}/${documentId}/${versionId}/${check}`;
  const observation = observed?.key === key ? observed : null;

  useEffect(() => {
    if (!enabled || !needsScan || !documentId || !versionId) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const deadline = Date.now() + SCAN_WINDOW;
    const query = new URLSearchParams({ documentId, versionId });
    async function poll() {
      try {
        const response = await fetch(`/verification/${caseId}/documents?${query}`, {
          cache: 'no-store',
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(REQUEST_TIMEOUT)]),
        });
        if (controller.signal.aborted) return;
        if (response.ok) {
          const result = (await response.json()) as FileView;
          if (controller.signal.aborted) return;
          if (result.documentId === documentId && result.versionId === versionId) {
            if (!needsPolling([result.status])) {
              setObserved({ key, file: result });
              return;
            }
          }
        } else if (response.status < 500 && response.status !== 429) {
          setObserved({ key, stalled: true });
          return;
        }
      } catch {
        if (controller.signal.aborted) return;
      }
      if (Date.now() < deadline) timer = setTimeout(() => void poll(), SCAN_INTERVAL);
      else setObserved({ key, stalled: true });
    }
    timer = setTimeout(() => void poll(), SCAN_INTERVAL);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [caseId, documentId, enabled, key, needsScan, versionId]);

  return {
    file: needsScan ? (observation?.file ?? initial) : initial,
    finished: observation?.file !== undefined,
    drewCheck: observation?.file?.status === 'clean',
    stalled: needsScan && observation?.stalled === true,
    retry: () => setCheck((value) => value + 1),
  };
}
