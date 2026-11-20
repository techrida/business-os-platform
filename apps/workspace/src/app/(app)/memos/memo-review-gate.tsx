'use client';

import { createContext, useContext, useState, type ReactNode } from 'react';

/**
 * Where the edit form's Done save stands, for the header's Submit: `saving` from the click until the saved memo
 * has arrived on the page (or the save was refused), then `saved` or `failed`. Submit pressed while it is `saving`
 * waits for the outcome instead of racing the save (R2-019).
 */
export type MemoSaveStatus = 'idle' | 'saving' | 'saved' | 'failed';

/** The pill (and popover line) shown on Submit while the edit form holds changes that Done has not saved. */
export const UNSAVED_CHANGES_PILL = 'Unsaved changes: press Done';

const ReviewNeeded = createContext(false);
const SetReviewNeeded = createContext<((needed: boolean) => void) | undefined>(undefined);
const SaveStatus = createContext<MemoSaveStatus>('idle');
const SetSaveStatus = createContext<((status: MemoSaveStatus) => void) | undefined>(undefined);

export function MemoReviewGate({ children }: { children: ReactNode }) {
  const [needed, setNeeded] = useState(false);
  const [save, setSave] = useState<MemoSaveStatus>('idle');
  return (
    <SetReviewNeeded.Provider value={setNeeded}>
      <SetSaveStatus.Provider value={setSave}>
        <SaveStatus.Provider value={save}>
          <ReviewNeeded.Provider value={needed}>{children}</ReviewNeeded.Provider>
        </SaveStatus.Provider>
      </SetSaveStatus.Provider>
    </SetReviewNeeded.Provider>
  );
}

export function useMemoReviewGate() {
  return useContext(SetReviewNeeded);
}

export function useMemoReviewNeeded() {
  return useContext(ReviewNeeded);
}

/** For the edit form: report where its Done save stands. Undefined outside a gate (the new-memo page). */
export function useMemoSaveReporter() {
  return useContext(SetSaveStatus);
}

export function useMemoSaveStatus() {
  return useContext(SaveStatus);
}
