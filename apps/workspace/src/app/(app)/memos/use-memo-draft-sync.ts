'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { toast } from '@/components/ui/toast';
import type { MemoDraftValues } from '@/lib/memo-working-draft-types';

import { createDraftSync, keyOf, type DraftSync, type SyncState } from './draft-sync';
import { createDraftTransport } from './draft-transport';

const TOAST_ID = 'memo-draft-sync';
const IDLE: SyncState = { status: 'idle', conflict: null, message: null, hasSaved: false };
/** From the first render until the stored draft has been read: a saved copy may exist that the page has not shown. */
const LOADING: SyncState = { ...IDLE, status: 'loading' };

/** The sign-out form posts to /auth/logout; the session is gone by the time the page unloads, so flush before. */
export function isLogoutForm(target: EventTarget | null): target is HTMLFormElement {
  if (!(target instanceof HTMLFormElement)) return false;
  try {
    return new URL(target.action, window.location.href).pathname === '/auth/logout';
  } catch {
    return false;
  }
}

export interface MemoDraftSyncApi {
  state: SyncState;
  /** Writes now (a field lost focus). */
  flush: () => void;
  /** Waits (bounded) until pending text is saved: call before submitting or signing out. */
  settle: () => Promise<void>;
  freeze: () => void;
  resume: () => void;
  discard: () => Promise<boolean>;
  resolveConflict: (choice: 'mine' | 'theirs') => void;
  revision: () => string | null;
}

/**
 * Connects the form's current values to the autosave engine and to the browser's lifecycle. The unsaved text lives in
 * memory; the durable copy is the server's, kept per account. `account` is the opaque binding the page was rendered
 * with: an engine belongs to one `account` and `memoId`, and a changed pair starts a fresh one (never flushing the old
 * text under the new identity). Without `account` there is no autosave at all.
 */
export function useMemoDraftSync(options: {
  account: string | undefined;
  memoId: string | undefined;
  baseline: MemoDraftValues;
  values: MemoDraftValues;
  onRestore: (values: MemoDraftValues) => void;
}): MemoDraftSyncApi {
  const { account, memoId } = options;
  const [engine, setEngine] = useState<DraftSync | null>(null);
  const [state, setState] = useState<SyncState>(account ? LOADING : IDLE);
  const [baseline] = useState(options.baseline);
  // "Latest value" refs, written after each render so event handlers and timers never read a stale closure.
  const stateRef = useRef(state);
  const restoreRef = useRef(options.onRestore);
  const valuesRef = useRef(options.values);
  useEffect(() => {
    stateRef.current = state;
    restoreRef.current = options.onRestore;
    valuesRef.current = options.values;
  });

  useEffect(() => {
    if (!account) return;
    const next = createDraftSync({
      transport: createDraftTransport({ account, memoId }),
      baseline,
      onState: setState,
      onRestore: (values, reason) => {
        restoreRef.current(values);
        if (reason === 'loaded')
          toast.info('Restored your unsaved draft', { id: 'memo-draft-restored' });
      },
    });
    next.start();
    setEngine(next);
    return () => {
      next.dispose();
      setEngine(null);
      setState(LOADING);
    };
  }, [account, memoId, baseline]);

  const valuesKey = keyOf(options.values);
  useEffect(() => {
    engine?.update(valuesRef.current);
    // The key stands for the values: depending on the object itself would re-run on every render.
  }, [engine, valuesKey]);

  // Failures need a person; routine saves stay quiet (the footer shows "Saved").
  const previous = useRef(state.status);
  useEffect(() => {
    const was = previous.current;
    previous.current = state.status;
    if (state.status === 'blocked') {
      toast.error('Draft not saved', {
        id: TOAST_ID,
        description: state.message ?? 'Your text is still on this page.',
      });
    } else if (state.status === 'offline' && was !== 'offline') {
      toast.warning('Saving paused', {
        id: TOAST_ID,
        description: 'Your text stays on this page. Saving retries by itself.',
      });
    } else if (state.status === 'saved' && (was === 'offline' || was === 'blocked')) {
      toast.dismiss(TOAST_ID);
    }
  }, [state.status, state.message]);

  // Flush when the page is being hidden or left, and refuse to show another account's page from the back-forward cache.
  useEffect(() => {
    if (!engine) return;
    const flush = () => void engine.flush();
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') flush();
      else engine.retryNow();
    };
    const onPageShow = (event: PageTransitionEvent) => {
      // A page restored from the back-forward cache may belong to an account that has since signed out.
      if (event.persisted) window.location.reload();
    };
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      const { status } = stateRef.current;
      if (
        engine.hasUnsaved() &&
        (engine.hasQueuedWrite() ||
          status === 'loading' ||
          status === 'offline' ||
          status === 'blocked' ||
          status === 'conflict')
      ) {
        event.preventDefault();
        event.returnValue = true;
      }
    };
    const onSubmit = (event: SubmitEvent) => {
      const form = event.target;
      if (!isLogoutForm(form) || !engine.hasUnsaved()) return;
      event.preventDefault();
      void engine.settle(3000).finally(() => form.submit());
    };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', flush);
    window.addEventListener('blur', flush);
    const onOnline = () => engine.retryNow();
    window.addEventListener('online', onOnline);
    window.addEventListener('pageshow', onPageShow);
    window.addEventListener('beforeunload', onBeforeUnload);
    document.addEventListener('submit', onSubmit, true);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', flush);
      window.removeEventListener('blur', flush);
      window.removeEventListener('online', onOnline);
      window.removeEventListener('pageshow', onPageShow);
      window.removeEventListener('beforeunload', onBeforeUnload);
      document.removeEventListener('submit', onSubmit, true);
    };
  }, [engine]);

  const flush = useCallback(() => void engine?.flush(), [engine]);
  const settle = useCallback(() => engine?.settle() ?? Promise.resolve(), [engine]);
  const freeze = useCallback(() => engine?.freeze(), [engine]);
  const resume = useCallback(() => engine?.resume(), [engine]);
  const discard = useCallback(() => engine?.discard() ?? Promise.resolve(true), [engine]);
  const resolveConflict = useCallback(
    (choice: 'mine' | 'theirs') => engine?.resolveConflict(choice),
    [engine],
  );
  const revision = useCallback(() => engine?.revision() ?? null, [engine]);

  return useMemo(
    () => ({ state, flush, settle, freeze, resume, discard, resolveConflict, revision }),
    [state, flush, settle, freeze, resume, discard, resolveConflict, revision],
  );
}
