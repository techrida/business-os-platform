'use client';

import Link from 'next/link';
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type FocusEvent,
  type MouseEvent,
} from 'react';

import { signInHref, useShellCounts } from '@/components/shell/shell-counts';
import {
  BELL_AFTER_DOT_MS,
  createBellRing,
  popDot,
  type BellRing,
} from '@/components/ui/bell-ring';
import { linkKind } from '@/components/ui/link-kind';
import { safeLocalPath } from '@/lib/kernel-ui';

import styles from './notifications-bell.module.css';

/**
 * The notifications bell, in the header. Its unread count comes from the shell's one counts poll
 * (components/shell/shell-counts.tsx: every 15 s, on focus and on page change, never in a hidden
 * tab); it opens a list from `/api/notifications`. Outside that provider it shows `initialCount`
 * and makes no reads of its own. The browser only ever talks to this app's own routes: the API
 * token stays on the server. Serves the NFR "an approver learns about waiting work without
 * reloading".
 *
 * It is a disclosure, not a menu: a button that shows or hides a region of links, so Tab walks
 * through the rows. Escape closes it and returns focus to the bell; so does tabbing out or a
 * click outside.
 *
 * Motion (components/ui/bell-ring.ts): when the count rises, the dot pops in and the bell rings;
 * opening the panel with a pointer rings it too. Page load, polls with no rise and keyboard opening
 * stay still. Opening never marks anything read.
 */

interface Item {
  id: string;
  title: string;
  body: string;
  link: string;
  readAt: string | null;
  createdLabel: string;
}

type Load = 'idle' | 'loading' | 'error';

export function NotificationsBell({ initialCount = 0 }: { initialCount?: number }) {
  const shell = useShellCounts();
  const shared = shell?.notifications;
  // Used until the shell knows a number, and always outside the provider.
  const [ownCount, setOwnCount] = useState(initialCount);
  const count = shared ?? ownCount;
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<Item[]>([]);
  const [load, setLoad] = useState<Load>('idle');
  const [announce, setAnnounce] = useState('');
  const wrapRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const swingRef = useRef<HTMLSpanElement>(null);
  const clapperRef = useRef<HTMLSpanElement>(null);
  const dotRef = useRef<HTMLSpanElement>(null);
  const ring = useRef<BellRing | null>(null);
  // Bumped when the unread count rises, so the layout effect below plays the arrival.
  const [arrival, setArrival] = useState<{ seq: number; fromZero: boolean }>({
    seq: 0,
    fromZero: false,
  });

  // The last shared count this bell has seen. Compared during render (React's adjust-state-on-change
  // pattern, no refs): the first known number, including the one on page load, stays quiet; after
  // that only a rise is announced and rings. A fall (items marked read) stays still.
  const [seen, setSeen] = useState(shared);
  if (seen !== shared) {
    setSeen(shared);
    if (seen !== undefined && shared !== undefined && shared > seen) {
      setAnnounce(`${shared} unread notification${shared === 1 ? '' : 's'}`);
      const fromZero = seen === 0;
      setArrival((a) => ({ seq: a.seq + 1, fromZero }));
    }
  }

  const signedOut = shell?.signedOut === true;
  useEffect(() => {
    if (!signedOut) return;
    // The session ended while the tab was open: send the person to sign in and back here.
    // /auth/login is a Route Handler, not a page: it needs a real navigation.
    window.location.href = signInHref(window.location);
  }, [signedOut]);

  const loadItems = useCallback(async () => {
    setLoad('loading');
    try {
      const res = await fetch('/api/notifications', { cache: 'no-store' });
      if (!res.ok) throw new Error(String(res.status));
      const data = (await res.json()) as { items?: Item[] };
      setItems(data.items ?? []);
      setLoad('idle');
    } catch {
      setLoad('error');
    }
  }, []);

  useEffect(() => {
    if (!swingRef.current || !clapperRef.current) return;
    const bellRing = createBellRing(swingRef.current, clapperRef.current);
    ring.current = bellRing;
    return () => bellRing.cancel();
  }, []);

  // A layout effect, so a newly mounted dot never paints at full size before its pop starts.
  useLayoutEffect(() => {
    if (arrival.seq === 0) return;
    if (arrival.fromZero && dotRef.current) popDot(dotRef.current);
    // As in the reference: the dot lands first and the bell rings after it.
    ring.current?.kick(arrival.fromZero ? BELL_AFTER_DOT_MS : 100);
  }, [arrival]);

  // Close on Escape (and give focus back to the bell) or on a click outside.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    const onPointer = (e: PointerEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPointer);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPointer);
    };
  }, [open]);

  // Tabbing out of the panel closes it. A blur with no target (clicking plain text, switching
  // windows) is left alone.
  const onBlur = (e: FocusEvent<HTMLDivElement>) => {
    const next = e.relatedTarget;
    if (open && next instanceof Node && !e.currentTarget.contains(next)) setOpen(false);
  };

  const toggle = (e: MouseEvent<HTMLButtonElement>) => {
    const next = !open;
    setOpen(next);
    if (next) void loadItems();
    // detail is 0 for keyboard and assistive-technology activation: no flourish there.
    if (next && e.detail > 0) ring.current?.kick(0);
  };

  /** `keepalive` lets the request finish even when the click navigates away. */
  const markRead = useCallback((id: string): Promise<unknown> => {
    return fetch(`/api/notifications/${encodeURIComponent(id)}/read`, {
      method: 'POST',
      keepalive: true,
    }).catch(() => undefined);
  }, []);

  // Marking items read lowers the count at once; the next shared read replaces it with the server's. `settled` is
  // the mark requests finishing: the shell starts no read before then, so a poll cannot count the unrecorded
  // marks as unread again and ring the bell for a rise that never happened.
  const lowerCount = (by: number, settled: Promise<unknown>) => {
    if (shell && shared !== undefined) shell.lowerNotifications(by, settled);
    else setOwnCount((c) => Math.max(0, c - by));
  };

  const onItemClick = (item: Item) => {
    if (item.readAt !== null) return;
    const settled = markRead(item.id);
    setItems((prev) =>
      prev.map((i) => (i.id === item.id ? { ...i, readAt: new Date().toISOString() } : i)),
    );
    lowerCount(1, settled);
    setOpen(false);
  };

  const unreadItems = items.filter((i) => i.readAt === null);
  const markAll = () => {
    const settled = Promise.all(unreadItems.map((item) => markRead(item.id)));
    const stamp = new Date().toISOString();
    setItems((prev) => prev.map((i) => (i.readAt === null ? { ...i, readAt: stamp } : i)));
    lowerCount(unreadItems.length, settled);
  };

  return (
    <div className={styles.wrap} ref={wrapRef} onBlur={onBlur}>
      <button
        type="button"
        ref={buttonRef}
        className={styles.button}
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-label={count > 0 ? `Notifications, ${count} unread` : 'Notifications'}
        onClick={toggle}
      >
        {/* The bell drawn in two layers so the clapper can swing inside the body. */}
        <span className={styles.bell} aria-hidden="true">
          <span className={styles.swing} ref={swingRef}>
            <svg viewBox="0 0 24 24" focusable="false">
              <path d="M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326" />
            </svg>
            <span className={styles.clapper} ref={clapperRef}>
              <svg viewBox="0 0 24 24" focusable="false">
                <path d="M10.268 21a2 2 0 0 0 3.464 0" />
              </svg>
            </span>
          </span>
        </span>
        {count > 0 ? <span className={styles.dot} ref={dotRef} aria-hidden="true" /> : null}
      </button>
      {/* Announces only when the count rises. */}
      <span role="status" aria-live="polite" className="sr-only">
        {announce}
      </span>
      {open ? (
        <div id={panelId} className={styles.panel} role="region" aria-label="Notifications panel">
          <div className={styles.head}>
            <p className={styles.title}>Notifications</p>
            <button
              type="button"
              className={styles.action}
              onClick={markAll}
              disabled={unreadItems.length === 0}
            >
              Mark all read
            </button>
          </div>
          <div className={styles.list}>
            {load === 'loading' && items.length === 0 ? (
              <p className={styles.empty} role="status">
                Loading notifications
              </p>
            ) : load === 'error' ? (
              <p className={styles.empty} role="alert">
                Notifications did not load.{' '}
                <button type="button" className={styles.action} onClick={() => void loadItems()}>
                  Try again
                </button>
              </p>
            ) : items.length === 0 ? (
              <p className={styles.empty}>You are all caught up.</p>
            ) : (
              <ul>
                {items.map((item) => {
                  const href = safeLocalPath(item.link);
                  const unread = item.readAt === null;
                  const content = (
                    <>
                      <span className={styles.mark} aria-hidden="true" />
                      <span className={styles.text}>
                        <span className={styles.itemTitle}>
                          {unread ? <span className="sr-only">Unread: </span> : null}
                          {item.title}
                        </span>
                        <span className={styles.itemBody}>{item.body}</span>
                        <span className={styles.itemTime}>{item.createdLabel}</span>
                      </span>
                    </>
                  );
                  const cls = `${styles.item} ${unread ? styles.unread : ''}`;
                  return (
                    <li key={item.id} className={unread ? styles.unread : undefined}>
                      {href !== null ? (
                        // Dynamic server page: the router refetches it on click, after onItemClick
                        // has marked the item read. A route-handler link stays a plain anchor.
                        linkKind({ href }) === 'router' ? (
                          <Link
                            href={href}
                            prefetch={false}
                            className={cls}
                            onClick={() => onItemClick(item)}
                          >
                            {content}
                          </Link>
                        ) : (
                          <a href={href} className={cls} onClick={() => onItemClick(item)}>
                            {content}
                          </a>
                        )
                      ) : (
                        <div className={cls}>{content}</div>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
