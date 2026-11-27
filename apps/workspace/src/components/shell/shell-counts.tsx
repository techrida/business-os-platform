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
/** A page change within this long of the last read waits for the end of it before reading, so a run of page changes makes one read. */
const PATH_READ_MIN_MS = 5_000;
const READ_TIMEOUT_MS = 10_000;

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
   *
   * `settled` is the marks' own requests finishing (it must not reject). While they are out, no new read starts:
   * the server has not recorded every mark yet, so a read now would still count items the person just read and
   * ring the bell for a rise that never happened. When they finish, one read corrects the number.
   */
  lowerNotifications: (by: number, settled?: Promise<unknown>) => void;
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
 * header bell from a single read of `/api/shell/counts`: on page changes (at most one per 5 s, the last one is not dropped),
 * when the window regains focus or the tab becomes visible, and every 15 s. A hidden tab does not poll. When
 * the layout has no unread count (it no longer waits for one) it reads once on arrival.
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
  // A read is waiting for its answer: a tick does not start another, or a slow answer would be superseded
  // by every following tick and never land.
  const inFlight = useRef(false);
  // Marks-as-read still on the wire (`lowerNotifications`): no read starts while any are.
  const marksOut = useRef(0);
  const seenPath = useRef(pathname);
  // When the last read started (null: none yet), so a quick run of page changes makes one read.
  const lastReadAt = useRef<number | null>(null);

  // A fresh layout number outranks any read already in flight: that read started before it.
  useLayoutEffect(() => {
    latest.current += 1;
  }, [initialInbox, initialNotifications]);

  const refresh = useCallback(async () => {
    if (document.hidden || signedOut.current || inFlight.current || marksOut.current > 0) return;
    inFlight.current = true;
    lastReadAt.current = Date.now();
    const generation = ++latest.current;
    try {
      const res = await fetch(SHELL_COUNTS_URL, {
        cache: 'no-store',
        signal: AbortSignal.timeout(READ_TIMEOUT_MS),
      });
      // An answer that a newer read or a fresher layout number outranks is dropped, a 401 included.
      if (generation !== latest.current) return;
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
    } finally {
      inFlight.current = false;
    }
  }, []);

  const lowerNotifications = useCallback(
    (by: number, settled?: Promise<unknown>) => {
      latest.current += 1;
      setState((s) =>
        s.notifications === undefined
          ? s
          : { ...s, notifications: Math.max(0, s.notifications - by) },
      );
      if (settled === undefined) return;
      marksOut.current += 1;
      void settled
        .then(
          () => undefined,
          () => undefined,
        )
        .then(() => {
          marksOut.current -= 1;
          // A read that started while the marks were out is outranked, then one read gives the server's number.
          latest.current += 1;
          void refresh();
        });
    },
    [refresh],
  );

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
    // Within 5 s of the last read the read is delayed to the end of that window, not dropped: a page change
    // that follows an action (an approval, then the redirect to the list) still gets a fresh number.
    const last = lastReadAt.current;
    const wait = last === null ? 0 : Math.max(0, PATH_READ_MIN_MS - (Date.now() - last));
    const read = window.setTimeout(() => void refresh(), wait);
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
