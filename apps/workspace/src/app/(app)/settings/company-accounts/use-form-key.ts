'use client';

import { useState } from 'react';

import type { ActionState } from '../action-state';

/**
 * The one Idempotency-Key a form submits. It stays the same across clicks and failed saves, so a double submit
 * cannot write twice, and it is replaced after a save succeeds, because the API refuses one key for a second,
 * different body. The first key comes from the server render so server and browser markup agree.
 *
 * The replacement is made while rendering, when the action's answer changes (React's adjust-state-on-change
 * pattern, as the bell does), never in an effect.
 */
export function useFormKey(initial: string, state: ActionState): string {
  const [key, setKey] = useState(initial);
  const [handled, setHandled] = useState(state);
  if (handled !== state) {
    setHandled(state);
    if (state.status === 'ok') setKey(crypto.randomUUID());
  }
  return key;
}
