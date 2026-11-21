'use client';

import { usePathname } from 'next/navigation';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

/** The BFF route both shell counts come from (app/api/shell/counts/route.ts). */
export const SHELL_COUNTS_URL = '/api/shell/counts';

const POLL_MS = 15_000;

/**
 * The live shell counts. `undefined` means not known yet (or never readable, such as a non-approver's inbox):
 * show no badge, never a zero. `signedOut` turns true once the counts route answers 401; polling stops then and
 * the bell sends the person to sign in (see `signInHref`).
 */
export interface ShellCounts {
  inbox: number | undefined;
  notifications: number | undefined;
  signedOut: boolean;
  /**
   * The bell marked `by` items read: lower the unread count now (never below zero; nothing while it is
   * unknown). A read already in flight started before the marks, so its answer is dropped.
   */
  lowerNotifications: (by: number) => void;
}

const ShellCountsContext = createContext<ShellCounts | null>(null);

/** The shell's live counts, or `null` outside a `ShellCountsProvider` (the caller keeps its own numbers). */
export function useShellCounts(): ShellCounts | null {
  return useContext(ShellCountsContext);
}

/** Where to send a person whose session ended: sign in, then come back to this page. */
export function signInHref(location: Pick<Location, 'pathname' | 'search'>): string {
  return `/auth/login?returnTo=${encodeURIComponent(location.pathname + location.search)}`;
}

interface State {
  inbox: number | undefined;
  notifications: number | undefined;
  signedOut: boolean;
  // The layout's numbers as last seen, to notice a new one after router.refresh().
  fromLayout: { inbox: number | undefined; notifications: number | undefined };
}

const knownCount = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;

/**
 * The one counts poller per tab, mounted once by the app layout. It feeds the sidebar's Inbox badge and the
 * header bell from a single read of `/api/shell/counts`: on every page change after the first (the layout has
 * just read the first page's numbers), when the window regains focus or the tab becomes visible, and every 15 s.
 * A hidden tab does not poll. When the layout has no unread count it reads once on arrival.
 *
 * A field the route returns as `null` (refused or failed) keeps its last known value. Only the newest read may
 * write: a read overtaken by a newer read, or by a fresh number from the layout, is dropped when it lands.
 */
export function ShellCountsProvider({
  initialInbox,
  initialNotifications,
  children,
}: {
  initialInbox?: number | undefined;
  initialNotifications?: number | undefined;
  children: ReactNode;
}) {
  const pathname = usePathname();
  const [state, setState] = useState<State>({
    inbox: initialInbox,
    notifications: initialNotifications,
    signedOut: false,
    fromLayout: { inbox: initialInbox, notifications: initialNotifications },
  });
  // A new number from the layout (router.refresh()) replaces the live one; a missing one keeps it. This is
  // React's documented adjust-state-on-prop-change pattern: it compares numbers, never objects.
  if (
    state.fromLayout.inbox !== initialInbox ||
    state.fromLayout.notifications !== initialNotifications
  ) {
    setState({
      ...state,
      inbox: initialInbox ?? state.inbox,
      notifications: initialNotifications ?? state.notifications,
      fromLayout: { inbox: initialInbox, notifications: initialNotifications },
    });
  }

  // Generation of the newest read; refs are touched only in callbacks and effects, never during render.
  const latest = useRef(0);
  const signedOut = useRef(false);
  const seenPath = useRef(pathname);

  // A fresh layout number outranks any read already in flight: that read started before it.
  useLayoutEffect(() => {
    latest.current += 1;
  }, [initialInbox, initialNotifications]);

  const refresh = useCallback(async () => {
    if (document.hidden || signedOut.current) return;
    const generation = ++latest.current;
    try {
      const res = await fetch(SHELL_COUNTS_URL, { cache: 'no-store' });
      if (res.status === 401) {
        signedOut.current = true;
        setState((s) => ({ ...s, signedOut: true }));
        return;
      }
      if (!res.ok) return;
      const data = (await res.json()) as { inbox?: unknown; notifications?: unknown };
      if (generation !== latest.current) return;
      const inbox = knownCount(data.inbox);
      const notifications = knownCount(data.notifications);
      setState((s) => ({
        ...s,
        inbox: inbox ?? s.inbox,
        notifications: notifications ?? s.notifications,
      }));
    } catch {
      // Offline or API restarting: keep the last counts and try again at the next tick.
    }
  }, []);

  const lowerNotifications = useCallback((by: number) => {
    latest.current += 1;
    setState((s) =>
      s.notifications === undefined
        ? s
        : { ...s, notifications: Math.max(0, s.notifications - by) },
    );
  }, []);

  // The bell has no number from the layout, so read once on arrival.
  const readOnArrival = initialNotifications === undefined;
  useEffect(() => {
    if (!readOnArrival) return;
    const read = window.setTimeout(() => void refresh(), 0);
    return () => window.clearTimeout(read);
  }, [readOnArrival, refresh]);

  useEffect(() => {
    if (seenPath.current === pathname) return;
    seenPath.current = pathname;
    const read = window.setTimeout(() => void refresh(), 0);
    return () => window.clearTimeout(read);
  }, [pathname, refresh]);

  useEffect(() => {
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
  }, [refresh]);

  const value = useMemo<ShellCounts>(
    () => ({
      inbox: state.inbox,
      notifications: state.notifications,
      signedOut: state.signedOut,
      lowerNotifications,
    }),
    [state.inbox, state.notifications, state.signedOut, lowerNotifications],
  );
  return <ShellCountsContext.Provider value={value}>{children}</ShellCountsContext.Provider>;
}
