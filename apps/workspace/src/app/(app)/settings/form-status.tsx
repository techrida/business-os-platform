'use client';

import { useEffect, useRef } from 'react';

import { Alert } from '@/components/ui/alert';
import { toast } from '@/components/ui/toast';
import styles from './admin.module.css';
import type { ActionState } from './action-state';

/**
 * Success is a toast only (UIP-FEED-001). A refusal is also a toast, but it blocks the form, so it
 * stays on screen inline unless the fields already show it. `inline={false}` hides it when the form
 * it belongs to is closed.
 */
export function FormStatus({
  state,
  pending,
  inline = true,
}: {
  state: ActionState;
  pending: boolean;
  inline?: boolean;
}) {
  const announced = useRef<ActionState | null>(null);
  useEffect(() => {
    if (pending || state.status === 'idle' || announced.current === state) return;
    announced.current = state;
    if (state.status === 'error') toast.error(state.message.split('\n')[0] ?? state.message);
    else toast.success(state.message);
  }, [state, pending]);
  if (pending) {
    return (
      <span className="sr-only" role="status">
        Saving…
      </span>
    );
  }
  const fieldsShowIt = Object.keys(state.fieldErrors ?? {}).length > 0;
  if (!inline || state.status !== 'error' || fieldsShowIt) return null;
  return (
    <Alert tone="error">
      {/* Messages can carry line breaks (a list of field problems). */}
      <span className={styles.status}>{state.message}</span>
    </Alert>
  );
}
