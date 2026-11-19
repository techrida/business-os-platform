'use client';

import { DEFAULT_NUMBER_SYSTEM, type NumberSystem } from '@bos/locale';
import { createContext, useContext, type ReactNode } from 'react';

// The tenant's number system for Client Components that show money. The (app) layout reads the
// setting on the server and provides it here; without a provider (tests, isolated renders) the
// default grouping applies.

const NumberSystemContext = createContext<NumberSystem>(DEFAULT_NUMBER_SYSTEM);

export function NumberSystemProvider({
  value,
  children,
}: {
  value: NumberSystem;
  children: ReactNode;
}) {
  return <NumberSystemContext.Provider value={value}>{children}</NumberSystemContext.Provider>;
}

/** Pass to `formatMoney(amount, currency, { numberSystem })`. */
export function useNumberSystem(): NumberSystem {
  return useContext(NumberSystemContext);
}
