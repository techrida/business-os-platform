'use client';

import { useEffect } from 'react';

/**
 * While `active`, a click on a link that leaves this page (a tab, another role, the Settings menu) is
 * held back and handed to `onAttempt` with its address, so the screen can ask "Discard your
 * changes?" first (spec 4, "Dirty card, leaving"). Closing or reloading the tab gets the browser's
 * own prompt. Links inside a dialog, new-tab clicks and links to another site are left alone.
 */
export function useLeaveGuard(active: boolean, onAttempt: (href: string) => void): void {
  useEffect(() => {
    if (!active) return;

    const onClick = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0) return;
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
      // Capture phase on the document: runs before the router's own link handler sees the click.
      event.preventDefault();
      event.stopPropagation();
      onAttempt(`${url.pathname}${url.search}${url.hash}`);
    };
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };

    document.addEventListener('click', onClick, true);
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => {
      document.removeEventListener('click', onClick, true);
      window.removeEventListener('beforeunload', onBeforeUnload);
    };
  }, [active, onAttempt]);
}
