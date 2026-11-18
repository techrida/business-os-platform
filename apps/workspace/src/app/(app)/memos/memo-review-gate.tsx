'use client';

import { createContext, useContext, useState, type ReactNode } from 'react';

const ReviewNeeded = createContext(false);
const SetReviewNeeded = createContext<((needed: boolean) => void) | undefined>(undefined);

export function MemoReviewGate({ children }: { children: ReactNode }) {
  const [needed, setNeeded] = useState(false);
  return (
    <SetReviewNeeded.Provider value={setNeeded}>
      <ReviewNeeded.Provider value={needed}>{children}</ReviewNeeded.Provider>
    </SetReviewNeeded.Provider>
  );
}

export function useMemoReviewGate() {
  return useContext(SetReviewNeeded);
}

export function useMemoReviewNeeded() {
  return useContext(ReviewNeeded);
}
