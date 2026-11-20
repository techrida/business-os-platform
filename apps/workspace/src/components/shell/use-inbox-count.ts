'use client';

import { usePathname } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';

export const INBOX_HREF = '/inbox';

const POLL_MS = 15_000;

/**
 * The live Inbox badge count. The app layout reads the count once on the server, but layouts
 * persist across client navigation, so that number goes stale as requests are decided. This reads
 * `/api/inbox/count` again on every page change, when the window regains focus and every 15 s, as
 * the notifications bell does for its own count.
 *
 * A failed or refused read keeps the last number (or no badge at all); it never shows a zero in its
 * place. A new count from the layout (after `router.refresh()`) replaces the live one.
 */
export function useInboxCount(fromLayout: number | undefined, enabled = true): number | undefined {
  const pathname = usePathname();
  const [state, setState] = useState<{ fromLayout: number | undefined; live?: number }>({
    fromLayout,
  });
  // Adjust state when the prop changes (React's documented pattern): compare the number, not the
  // counts object, which is a new object on every render.
  if (state.fromLayout !== fromLayout) setState({ fromLayout });

  // Only the newest request may write: an older response that lands late is dropped.
  const latest = useRef(0);
  const seenPath = useRef(pathname);

  const refresh = useCallback(async () => {
    if (document.hidden) return;
    const seq = ++latest.current;
    try {
      const res = await fetch('/api/inbox/count', { cache: 'no-store' });
      if (!res.ok) return;
      const data = (await res.json()) as { count?: unknown };
      const count = data.count;
      if (seq !== latest.current || typeof count !== 'number') return;
      setState((s) => ({ ...s, live: count }));
    } catch {
      // Offline or API restarting: keep the last count and try again at the next tick.
    }
  }, []);

  // The layout has just read the count for the first page, so only later pages read it again.
  useEffect(() => {
    if (!enabled || seenPath.current === pathname) return;
    seenPath.current = pathname;
    const read = window.setTimeout(() => void refresh(), 0);
    return () => window.clearTimeout(read);
  }, [enabled, pathname, refresh]);

  useEffect(() => {
    if (!enabled) return;
    const timer = window.setInterval(() => void refresh(), POLL_MS);
    const onFocus = () => void refresh();
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onFocus);
      // Drop any read still in flight.
      latest.current += 1;
    };
  }, [enabled, refresh]);

  return state.live ?? state.fromLayout;
}
