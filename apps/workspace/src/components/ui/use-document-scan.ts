'use client';

import { useEffect, useState } from 'react';

import type { FileView } from '@/components/p2/crm/verification-file';
import { needsPolling } from '@/lib/kernel-ui';

/** The pauses before the checks: 500 ms, 1 s, then every 2 s. A small file is scanned within a second or two. */
const SCAN_PAUSES_MS = [500, 1_000] as const;
const SCAN_INTERVAL = 2_000;
const SCAN_WINDOW = 120_000;
const REQUEST_TIMEOUT = 8_000;

/**
 * Watches the virus scan of one uploaded file version until it is clean, infected or rejected.
 * `endpoint` answers `GET ?documentId&versionId` with the version's `FileView` (the verification
 * case route and the evidence route both do), and checks the file belongs to its owner.
 */
export function useDocumentScan(endpoint: string, initial: FileView | null, enabled: boolean) {
  const [check, setCheck] = useState(0);
  const [observed, setObserved] = useState<{
    key: string;
    file?: FileView;
    stalled?: boolean;
  } | null>(null);
  const documentId = initial?.documentId;
  const versionId = initial?.versionId;
  const needsScan = initial !== null && needsPolling([initial.status]);
  const key = `${endpoint}/${documentId}/${versionId}/${check}`;
  const observation = observed?.key === key ? observed : null;

  useEffect(() => {
    if (!enabled || !needsScan || !documentId || !versionId) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const deadline = Date.now() + SCAN_WINDOW;
    let checks = 0;
    const query = new URLSearchParams({ documentId, versionId });
    const nextPause = () => SCAN_PAUSES_MS[checks++] ?? SCAN_INTERVAL;
    async function poll() {
      try {
        const response = await fetch(`${endpoint}?${query}`, {
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
      if (Date.now() < deadline) timer = setTimeout(() => void poll(), nextPause());
      else setObserved({ key, stalled: true });
    }
    timer = setTimeout(() => void poll(), nextPause());
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [documentId, enabled, endpoint, key, needsScan, versionId]);

  return {
    file: needsScan ? (observation?.file ?? initial) : initial,
    finished: observation?.file !== undefined,
    drewCheck: observation?.file?.status === 'clean',
    stalled: needsScan && observation?.stalled === true,
    retry: () => setCheck((value) => value + 1),
  };
}
