'use client';

import { useEffect, useRef } from 'react';

import { toast } from '@/components/ui/toast';
import type { ActionState } from './action-state';

export function FormStatus({ state, pending }: { state: ActionState; pending: boolean }) {
  const announced = useRef<ActionState | null>(null);
  useEffect(() => {
    if (pending || state.status === 'idle' || announced.current === state) return;
    announced.current = state;
    if (state.status === 'error') toast.error(state.message);
    else toast.success(state.message);
  }, [state, pending]);
  return pending ? (
    <span className="sr-only" role="status">
      Saving…
    </span>
  ) : null;
}
