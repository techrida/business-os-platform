'use client';

import { useCallback, useEffect, useId, useRef, useState, type FocusEvent } from 'react';

import { Icon } from '@/components/ui/icon';
import { safeLocalPath } from '@/lib/kernel-ui';

import styles from './notifications-bell.module.css';

/**
 * The notifications bell, in the header. It polls a BFF route for the unread count every 15 s and
 * whenever the window regains focus, and opens a list from `/api/notifications`. The browser only
 * ever talks to this app's own routes: the API token stays on the server. Serves the NFR "an
 * approver learns about waiting work without reloading".
 *
 * It is a disclosure, not a menu: a button that shows or hides a region of links, so Tab walks
 * through the rows. Escape closes it and returns focus to the bell; so does tabbing out or a
 * click outside.
 */

const POLL_MS = 15_000;

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
  const [count, setCount] = useState(initialCount);
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<Item[]>([]);
  const [load, setLoad] = useState<Load>('idle');
  const [announce, setAnnounce] = useState('');
  const wrapRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const lastCount = useRef(initialCount);
  const panelId = useId();

  const refreshCount = useCallback(async (quiet = false) => {
    if (document.hidden) return;
    try {
      const res = await fetch('/api/notifications/unread-count', { cache: 'no-store' });
      if (res.status === 401) {
        // The session ended while the tab was open: send the person to sign in and back here.
        // /auth/login is a Route Handler, not a page: it needs a real navigation.
        // eslint-disable-next-line @next/next/no-location-assign-relative-destination
        window.location.href = `/auth/login?returnTo=${encodeURIComponent(window.location.pathname + window.location.search)}`;
        return;
      }
      if (!res.ok) return;
      const data = (await res.json()) as { count?: unknown };
      if (typeof data.count !== 'number') return;
      setCount(data.count);
      // Tell screen readers only about new items, not on every poll or on page load.
      if (!quiet && data.count > lastCount.current) {
        setAnnounce(`${data.count} unread notification${data.count === 1 ? '' : 's'}`);
      }
      lastCount.current = data.count;
    } catch {
      // Offline or API restarting: keep the last count and try again at the next tick.
    }
  }, []);

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
    // The layout does not know the count, so read it once on arrival (quietly), then poll.
    const first = window.setTimeout(() => void refreshCount(true), 0);
    const timer = window.setInterval(() => void refreshCount(), POLL_MS);
    const onFocus = () => void refreshCount();
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(timer);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onFocus);
    };
  }, [refreshCount]);

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

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next) void loadItems();
  };

  /** `keepalive` lets the request finish even when the click navigates away. */
  const markRead = useCallback((id: string) => {
    void fetch(`/api/notifications/${encodeURIComponent(id)}/read`, {
      method: 'POST',
      keepalive: true,
    }).catch(() => undefined);
  }, []);

  const onItemClick = (item: Item) => {
    if (item.readAt !== null) return;
    markRead(item.id);
    setItems((prev) =>
      prev.map((i) => (i.id === item.id ? { ...i, readAt: new Date().toISOString() } : i)),
    );
    setCount((c) => {
      const next = Math.max(0, c - 1);
      lastCount.current = next;
      return next;
    });
    setOpen(false);
  };

  const unreadItems = items.filter((i) => i.readAt === null);
  const markAll = () => {
    for (const item of unreadItems) markRead(item.id);
    const stamp = new Date().toISOString();
    setItems((prev) => prev.map((i) => (i.readAt === null ? { ...i, readAt: stamp } : i)));
    setCount((c) => {
      const next = Math.max(0, c - unreadItems.length);
      lastCount.current = next;
      return next;
    });
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
        <Icon name="bell" size={18} />
        {count > 0 ? <span className={styles.dot} aria-hidden="true" /> : null}
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
                        // A plain link, not router.push: the page it opens is server-rendered
                        // and must see the freshest data after the click marks the item read.
                        <a href={href} className={cls} onClick={() => onItemClick(item)}>
                          {content}
                        </a>
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
