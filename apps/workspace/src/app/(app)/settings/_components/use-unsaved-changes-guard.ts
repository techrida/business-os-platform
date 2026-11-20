'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

export type PendingLeave = { kind: 'href'; href: string } | { kind: 'back' };

const GUARD_FLAG = '__bosUnsavedGuard';

function isGuardState(state: unknown): boolean {
  return (
    typeof state === 'object' &&
    state !== null &&
    GUARD_FLAG in state &&
    (state as Record<string, unknown>)[GUARD_FLAG] === true
  );
}

function pushGuardEntry(): void {
  const existing =
    typeof window.history.state === 'object' && window.history.state !== null
      ? (window.history.state as Record<string, unknown>)
      : {};
  window.history.pushState({ ...existing, [GUARD_FLAG]: true }, '', window.location.href);
}

/**
 * Unsaved-changes navigation guard for Next.js 16 App Router.
 *
 * Next.js 16 App Router has no global route-cancellation hook (`<Link onNavigate>` only intercepts
 * links whose JSX you directly own, not sidebar/header links outside the form). This hook combines:
 * 1. `window` `beforeunload` for tab close, reload and external URL-bar navigation.
 * 2. Capture-phase `document` click interception on internal `<a href>` elements (runs before
 *    Next `<Link>`'s React handler) so in-app link clicks open a confirmation dialog first.
 * 3. A `popstate` guard backed by one tagged history sentinel (`__bosUnsavedGuard`), pushed once
 *    when `dirty` turns true and re-pushed if browser Back fires while dirty. Confirming Back steps
 *    past both the sentinel and the settings page (`history.go(-2)`). If the user saves or discards
 *    and later presses Back, the inert sentinel steps straight through in one press.
 */
export function useUnsavedChangesGuard(dirty: boolean): {
  pendingLeave: PendingLeave | null;
  hasGuardEntry: () => boolean;
  cancelLeave: () => void;
  allowNavigation: () => void;
} {
  const [pendingLeave, setPendingLeave] = useState<PendingLeave | null>(null);
  const hasGuardRef = useRef(false);
  const bypassRef = useRef(false);

  // Push one sentinel history entry the first time the form becomes dirty on this page.
  useEffect(() => {
    if (!dirty) return;
    bypassRef.current = false;
    if (!hasGuardRef.current) {
      if (!isGuardState(window.history.state)) {
        pushGuardEntry();
      }
      hasGuardRef.current = true;
    }
  }, [dirty]);

  // Intercept browser close/reload and internal anchor clicks only while dirty.
  useEffect(() => {
    if (!dirty) return;

    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (bypassRef.current) return;
      event.preventDefault();
      event.returnValue = '';
    };

    const onClick = (event: MouseEvent) => {
      if (bypassRef.current || event.defaultPrevented || event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const link = event.target instanceof Element ? event.target.closest('a[href]') : null;
      if (!(link instanceof HTMLAnchorElement)) return;
      if ((link.target && link.target !== '_self') || link.hasAttribute('download')) return;
      if (link.closest('[role="dialog"]')) return;
      const url = new URL(link.href, window.location.href);
      if (url.origin !== window.location.origin) return;
      if (url.pathname === window.location.pathname && url.search === window.location.search) {
        return;
      }
      // Capture phase on document: runs before Next.js <Link>'s own click handler.
      event.preventDefault();
      event.stopPropagation();
      setPendingLeave({ kind: 'href', href: `${url.pathname}${url.search}${url.hash}` });
    };

    window.addEventListener('beforeunload', onBeforeUnload);
    document.addEventListener('click', onClick, true);
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
      document.removeEventListener('click', onClick, true);
    };
  }, [dirty]);

  // Listen to popstate while mounted so both dirty Back presses (intercepted) and post-save Back
  // presses over an inert sentinel (stepped through once) behave predictably.
  useEffect(() => {
    const onPopState = () => {
      if (bypassRef.current) return;
      if (dirty) {
        pushGuardEntry();
        hasGuardRef.current = true;
        setPendingLeave({ kind: 'back' });
        return;
      }
      if (hasGuardRef.current) {
        hasGuardRef.current = false;
        window.history.back();
      }
    };

    window.addEventListener('popstate', onPopState);
    return () => {
      window.removeEventListener('popstate', onPopState);
    };
  }, [dirty]);

  const hasGuardEntry = useCallback(() => hasGuardRef.current, []);

  const cancelLeave = useCallback(() => {
    setPendingLeave(null);
  }, []);

  const allowNavigation = useCallback(() => {
    bypassRef.current = true;
    hasGuardRef.current = false;
    setPendingLeave(null);
  }, []);

  return { pendingLeave, hasGuardEntry, cancelLeave, allowNavigation };
}
