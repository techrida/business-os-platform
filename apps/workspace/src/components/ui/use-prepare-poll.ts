'use client';

// How a screen waits on a generated PDF that is being prepared (round 4, R4c2: TR-Q4). One schedule for the quotation,
// invoice and purchase order screens: a check after 1 s, then pauses of 2 s, 4 s, 8 s, 15 s and 30 s each, for at least
// PDF_PREPARE_WITHIN_MS, the time within which every render sweeper either stores the PDF or gives up. A hidden tab is
// not checked; it is checked as soon as it is shown again. When the time is up the screen stops by itself and offers
// "Check again", which starts a fresh round: a backlog or a worker that died can take longer than the usual bound.
import { PDF_PREPARE_WITHIN_MS } from '@bos/contracts';
import { useCallback, useEffect, useRef, useState } from 'react';

export const PREPARE_POLL_STEPS_MS = [1_000, 2_000, 4_000, 8_000, 15_000] as const;
export const PREPARE_POLL_MAX_MS = 30_000;

/** The pause before check number `n` (0 for the first): 1 s, 2 s, 4 s, 8 s, 15 s, then 30 s each. */
export function preparePollDelayMs(n: number): number {
  return PREPARE_POLL_STEPS_MS[n] ?? PREPARE_POLL_MAX_MS;
}

/**
 * Calls `check` on the schedule above while `active`. Returns `expired` once a round has run for PDF_PREPARE_WITHIN_MS
 * without the caller going inactive, and `restart` to start a fresh round. Stops on unmount and when `active` turns
 * false; `check` may change between renders without restarting the round.
 */
export function usePreparePoll(
  active: boolean,
  check: () => void,
): { expired: boolean; restart: () => void } {
  const [round, setRound] = useState(0);
  const [expiredRound, setExpiredRound] = useState<number | null>(null);
  const checkRef = useRef(check);
  useEffect(() => {
    checkRef.current = check;
  }, [check]);

  useEffect(() => {
    if (!active) return;
    const started = Date.now();
    let n = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let waitingForTab = false;
    const tick = () => {
      timer = undefined;
      if (document.hidden) {
        waitingForTab = true;
        return;
      }
      waitingForTab = false;
      checkRef.current();
      if (Date.now() - started >= PDF_PREPARE_WITHIN_MS) {
        setExpiredRound(round);
        return;
      }
      timer = setTimeout(tick, preparePollDelayMs(n));
      n += 1;
    };
    const onVisibility = () => {
      if (!document.hidden && waitingForTab) tick();
    };
    timer = setTimeout(tick, preparePollDelayMs(n));
    n += 1;
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      if (timer !== undefined) clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [active, round]);

  const restart = useCallback(() => setRound((r) => r + 1), []);
  return { expired: active && expiredRound === round, restart };
}
