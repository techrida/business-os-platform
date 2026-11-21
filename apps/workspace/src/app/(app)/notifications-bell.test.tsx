// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ShellCountsProvider } from '@/components/shell/shell-counts';

// The real bell under the real shell counts poller. Only the router's path, the browser's fetch, the
// tab's visibility and the bell's animation are scripted.
const nav = vi.hoisted(() => ({ pathname: '/' }));
vi.mock('next/navigation', () => ({ usePathname: () => nav.pathname }));
const motion = vi.hoisted(() => ({ kick: vi.fn<(delay: number) => void>(), popDot: vi.fn() }));
vi.mock('@/components/ui/bell-ring', () => ({
  BELL_AFTER_DOT_MS: 0,
  createBellRing: () => ({ kick: motion.kick, cancel: vi.fn() }),
  popDot: motion.popDot,
}));

import { NotificationsBell } from './notifications-bell';

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;
const fetchMock = vi.fn<Fetch>();
const json = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status }));

const ITEMS = [
  {
    id: 'n1',
    title: 'Lead assigned',
    body: 'Acme',
    link: '/leads/1',
    readAt: null,
    createdLabel: 'Now',
  },
  {
    id: 'n2',
    title: 'Quote approved',
    body: 'Q-7',
    link: '/quotations/7',
    readAt: null,
    createdLabel: 'Now',
  },
];

/** The server's unread count, and the items marked read so far. */
let unread: number | 'signed-out' = 0;
const readIds = new Set<string>();
/** While set, a mark-as-read answers only when `releaseMarks()` runs: the server records it late. */
let lateMarks: Array<() => void> | null = null;
const releaseMarks = async () => {
  const waiting = lateMarks ?? [];
  lateMarks = null;
  await act(async () => {
    for (const record of waiting) record();
    await vi.advanceTimersByTimeAsync(0);
  });
};
function recordRead(id: string) {
  if (readIds.has(id)) return;
  readIds.add(id);
  if (typeof unread === 'number') unread = Math.max(0, unread - 1);
}
function server(): Fetch {
  return (input, init) => {
    if (input === '/api/shell/counts') {
      return unread === 'signed-out'
        ? json({ error: { message: 'Sign in' } }, 401)
        : json({ inbox: null, notifications: unread });
    }
    if (input === '/api/notifications') {
      return json({
        items: ITEMS.map((i) => (readIds.has(i.id) ? { ...i, readAt: '2026-11-21T00:00:00Z' } : i)),
      });
    }
    const read = /^\/api\/notifications\/(.+)\/read$/.exec(input);
    if (read?.[1] && init?.method === 'POST') {
      const id = read[1];
      if (lateMarks === null) recordRead(id);
      else
        return new Promise((resolve) =>
          lateMarks?.push(() => (recordRead(id), resolve(new Response('{}')))),
        );
    }
    return json({});
  };
}

let container: HTMLDivElement;
let root: Root | undefined;

async function mount(node: ReactNode) {
  await act(() => Promise.resolve(root?.render(node)));
  await act(() => vi.advanceTimersByTimeAsync(0));
}
const inShell = () => (
  <ShellCountsProvider initialInbox={undefined}>
    <NotificationsBell />
  </ShellCountsProvider>
);

const bell = () =>
  container.querySelector<HTMLButtonElement>('button[aria-label^="Notifications"]');
const label = () => bell()?.getAttribute('aria-label');
const announced = () => container.querySelector('span[role="status"]')?.textContent;
const readPosts = () =>
  fetchMock.mock.calls
    .filter(([, init]) => init?.method === 'POST')
    .map(([url]) => url)
    .sort();

async function tick(ms: number) {
  await act(() => vi.advanceTimersByTimeAsync(ms));
}
async function press(element: HTMLElement | null | undefined) {
  if (!element) throw new Error('Missing control');
  await act(async () => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    await vi.advanceTimersByTimeAsync(0);
  });
}
const openPanel = () => press(bell());
const button = (text: string) =>
  Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.trim() === text);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval'] });
  nav.pathname = '/';
  unread = 0;
  readIds.clear();
  lateMarks = null;
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
  motion.kick.mockReset();
  motion.popDot.mockReset();
  fetchMock.mockReset();
  fetchMock.mockImplementation(server());
  vi.stubGlobal('fetch', fetchMock);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(() => Promise.resolve(root?.unmount()));
  root = undefined;
  container.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('NotificationsBell in the shell', () => {
  it('stays quiet on the first count, then announces and rings when the count rises', async () => {
    unread = 0;
    await mount(inShell());
    expect(label()).toBe('Notifications');
    expect(announced()).toBe('');
    expect(motion.kick).not.toHaveBeenCalled();

    unread = 1;
    await tick(15_000);
    expect(label()).toBe('Notifications, 1 unread');
    expect(announced()).toBe('1 unread notification');
    expect(motion.popDot).toHaveBeenCalledTimes(1);
    expect(motion.kick).toHaveBeenCalledTimes(1);

    // It reads only the shell's one counts route: no poll of its own.
    await tick(15_000);
    await act(() => Promise.resolve(window.dispatchEvent(new Event('focus'))));
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(
      expect.arrayContaining(['/api/shell/counts']),
    );
    expect(fetchMock.mock.calls.every(([url]) => url === '/api/shell/counts')).toBe(true);
  });

  it('stays still when a read brings the same or a lower count', async () => {
    unread = 3;
    await mount(inShell());
    expect(label()).toBe('Notifications, 3 unread');

    await tick(15_000);
    unread = 2;
    await tick(15_000);
    expect(label()).toBe('Notifications, 2 unread');
    expect(announced()).toBe('');
    expect(motion.kick).not.toHaveBeenCalled();
  });

  it('sends a signed-out person to sign in', async () => {
    type Listener = (e: Error) => void;
    type Console = {
      on(event: string, fn: Listener): void;
      off(event: string, fn: Listener): void;
    };
    const jsdom = (window as unknown as { jsdom: { virtualConsole: Console } }).jsdom;
    const navigations: string[] = [];
    // jsdom cannot load another document; it reports the attempt instead.
    const onError: Listener = (e) => {
      if (e.message.includes('navigation')) navigations.push(e.message);
    };
    jsdom.virtualConsole.on('jsdomError', onError);

    unread = 2;
    await mount(inShell());
    expect(navigations).toHaveLength(0);

    unread = 'signed-out';
    await tick(15_000);
    expect(navigations).toHaveLength(1);
    jsdom.virtualConsole.off('jsdomError', onError);
  });

  it('opens the list without marking anything read', async () => {
    unread = 2;
    await mount(inShell());
    await openPanel();

    expect(fetchMock.mock.calls.some(([url]) => url === '/api/notifications')).toBe(true);
    expect(container.querySelector('a[href="/leads/1"]')).not.toBeNull();
    expect(readPosts()).toEqual([]);
    expect(label()).toBe('Notifications, 2 unread');
  });

  it('lowers its count when one item is opened, and again when the rest are marked read', async () => {
    unread = 2;
    await mount(inShell());
    await openPanel();
    await press(container.querySelector<HTMLAnchorElement>('a[href="/leads/1"]'));
    expect(readPosts()).toEqual(['/api/notifications/n1/read']);
    expect(label()).toBe('Notifications, 1 unread');

    await openPanel();
    await press(button('Mark all read'));
    expect(readPosts()).toEqual(['/api/notifications/n1/read', '/api/notifications/n2/read']);
    expect(label()).toBe('Notifications');
    expect(motion.kick).not.toHaveBeenCalled();
  });
});

describe('NotificationsBell after Mark all read', () => {
  it('does not ring again when a poll would have counted marks the server has not recorded yet', async () => {
    unread = 2;
    await mount(inShell());
    await openPanel();
    lateMarks = [];
    await press(button('Mark all read'));
    expect(label()).toBe('Notifications');

    // The marks are still on the wire. A poll now would read 2 unread and look like a rise: none is made.
    const readsBefore = fetchMock.mock.calls.filter(([url]) => url === '/api/shell/counts').length;
    await tick(15_000);
    await tick(15_000);
    expect(fetchMock.mock.calls.filter(([url]) => url === '/api/shell/counts')).toHaveLength(
      readsBefore,
    );
    expect(label()).toBe('Notifications');

    // They land: one read confirms zero, and the bell never rang or announced.
    await releaseMarks();
    expect(label()).toBe('Notifications');
    expect(motion.kick).not.toHaveBeenCalled();
    expect(announced()).toBe('');
  });
});

describe('NotificationsBell outside the shell', () => {
  it('shows the count it was given, makes no reads of its own, and still lowers it', async () => {
    await mount(<NotificationsBell initialCount={2} />);
    await tick(45_000);
    await act(() => Promise.resolve(window.dispatchEvent(new Event('focus'))));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(label()).toBe('Notifications, 2 unread');

    await openPanel();
    await press(button('Mark all read'));
    expect(label()).toBe('Notifications');
  });
});
