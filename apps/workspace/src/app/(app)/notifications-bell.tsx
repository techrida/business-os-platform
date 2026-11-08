'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';

import { safeLocalPath } from '@/lib/kernel-ui';

import styles from './shell.module.css';

/**
 * The notifications bell. It polls a BFF route for the unread count every 15 s and whenever the
 * window regains focus, and opens a list from `/api/notifications`. The browser only ever talks
 * to this app's own routes: the API token stays on the server. Serves the NFR "an approver
 * learns about waiting work without reloading".
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

export function NotificationsBell({ initialCount }: { initialCount: number }) {
  const [count, setCount] = useState(initialCount);
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<Item[]>([]);
  const [load, setLoad] = useState<Load>('idle');
  const [announce, setAnnounce] = useState('');
  const wrapRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const lastCount = useRef(initialCount);
  const panelId = useId();

  const refreshCount = useCallback(async () => {
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
      // Tell screen readers only about new items, not on every poll.
      if (data.count > lastCount.current) {
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
    const timer = window.setInterval(() => void refreshCount(), POLL_MS);
    const onFocus = () => void refreshCount();
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);
    return () => {
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
    <div className={styles.bellWrap} ref={wrapRef}>
      <button
        type="button"
        ref={buttonRef}
        className={styles.bellButton}
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={count > 0 ? `Notifications, ${count} unread` : 'Notifications'}
        onClick={toggle}
      >
        <svg
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          focusable="false"
        >
          <path d="M6 9a6 6 0 1 1 12 0c0 4.5 1.5 6 2 7H4c.5-1 2-2.5 2-7Z" />
          <path d="M10 20a2 2 0 0 0 4 0" />
        </svg>
        {count > 0 ? (
          <span className={styles.bellCount} aria-hidden="true">
            {count > 99 ? '99+' : count}
          </span>
        ) : null}
      </button>
      {/* Announces only when the count rises; visually hidden by the inline clip. */}
      <span
        role="status"
        aria-live="polite"
        style={{
          position: 'absolute',
          width: 1,
          height: 1,
          overflow: 'hidden',
          clip: 'rect(0 0 0 0)',
          whiteSpace: 'nowrap',
        }}
      >
        {announce}
      </span>
      {open ? (
        <div id={panelId} className={styles.bellPanel} role="region" aria-label="Notifications">
          <div className={styles.bellHead}>
            <h2 className={styles.bellTitle}>Notifications</h2>
            <button
              type="button"
              className={styles.bellAction}
              onClick={markAll}
              disabled={unreadItems.length === 0}
            >
              Mark all read
            </button>
          </div>
          {load === 'loading' && items.length === 0 ? (
            <p className={styles.bellEmpty} role="status">
              Loading notifications
            </p>
          ) : load === 'error' ? (
            <p className={styles.bellEmpty} role="alert">
              Notifications did not load.{' '}
              <button type="button" className={styles.bellAction} onClick={() => void loadItems()}>
                Try again
              </button>
            </p>
          ) : items.length === 0 ? (
            <p className={styles.bellEmpty}>You are all caught up.</p>
          ) : (
            <ul className={styles.bellList}>
              {items.map((item) => {
                const href = safeLocalPath(item.link);
                const content = (
                  <>
                    <span className={styles.bellItemTitle}>{item.title}</span>
                    <span className={styles.bellItemBody}>{item.body}</span>
                    <span className={styles.bellItemTime}>{item.createdLabel}</span>
                  </>
                );
                const cls = `${styles.bellItem} ${item.readAt === null ? styles.unread : styles.read}`;
                return (
                  <li key={item.id}>
                    {href !== null ? (
                      // A plain link, not router.push: the page it opens is server-rendered and
                      // must see the freshest data after the click marks the item read.
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
      ) : null}
    </div>
  );
}
