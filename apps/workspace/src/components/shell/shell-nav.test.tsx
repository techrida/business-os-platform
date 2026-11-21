// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The app layout is a server component that persists across client navigation, so the inbox count
// it reads once goes stale. These tests drive the real ShellNav and NavLink inside the real shell
// state and the real counts poller; only the router's current path and the browser's fetch are scripted.
const nav = vi.hoisted(() => ({ pathname: '/' }));
vi.mock('next/navigation', () => ({ usePathname: () => nav.pathname }));

import type { NavGroup } from '@/lib/nav';

import { ShellCountsProvider } from './shell-counts';
import { ShellNav } from './shell-nav';
import { ShellFrame } from './shell-state';

const GROUPS = [
  {
    label: 'Work',
    items: [
      { label: 'Dashboard', href: '/', icon: 'home', phase: 'P0' },
      { label: 'Inbox', href: '/inbox', icon: 'inbox', phase: 'P1' },
    ],
  },
] as unknown as NavGroup[];

const fetchMock = vi.fn<(input: string, init?: RequestInit) => Promise<Response>>();
const body = (inbox: number | null, notifications: number | null = 0) =>
  new Response(JSON.stringify({ inbox, notifications }), { status: 200 });
const answer =
  (inbox: number | null, notifications: number | null = 0) =>
  () =>
    Promise.resolve(body(inbox, notifications));

/** A read that stays in flight until the test answers it. */
function deferred() {
  let resolve!: (res: Response) => void;
  const promise = new Promise<Response>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

let container: HTMLDivElement;
let root: Root | undefined;

/** Renders the shell as the app layout does: its first-paint inbox number feeds both the poller and the nav. */
async function render(inbox: number | undefined) {
  const counts: Record<string, number> = inbox === undefined ? {} : { '/inbox': inbox };
  await act(() =>
    Promise.resolve(
      root?.render(
        <ShellFrame>
          {/* The bell's number is given so the poller makes no arrival read; these tests count reads. */}
          <ShellCountsProvider initialInbox={inbox} initialNotifications={0}>
            <ShellNav groups={GROUPS} counts={counts} />
          </ShellCountsProvider>
        </ShellFrame>,
      ),
    ),
  );
  // Let any read started by the render (and its response) settle.
  await act(() => vi.advanceTimersByTimeAsync(0));
}

/** The number shown on the Inbox link, or null when there is no badge. */
function inboxBadge(): string | null {
  const link = container.querySelector('a[href="/inbox"]');
  const last = link?.lastElementChild;
  return last && /^\d+$/.test(last.textContent ?? '') ? last.textContent : null;
}

const countReads = () =>
  fetchMock.mock.calls.filter(([input]) => input === '/api/shell/counts').length;

async function focusWindow() {
  await act(async () => {
    window.dispatchEvent(new Event('focus'));
    await vi.advanceTimersByTimeAsync(0);
  });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval'] });
  nav.pathname = '/';
  fetchMock.mockReset();
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

describe('ShellNav inbox badge', () => {
  it('shows the layout count on the first page without reading it again', async () => {
    fetchMock.mockImplementation(answer(9));
    await render(3);

    expect(countReads()).toBe(0);
    expect(inboxBadge()).toBe('3');
  });

  it('reads the count again when the page changes, so the badge does not go stale', async () => {
    fetchMock.mockImplementation(answer(3));
    await render(3);
    expect(inboxBadge()).toBe('3');

    // Two requests were decided elsewhere; the person moves to another page. The layout persists,
    // so its prop still says 3.
    fetchMock.mockImplementation(answer(1));
    nav.pathname = '/inbox/abc';
    await render(3);

    expect(countReads()).toBe(1);
    expect(inboxBadge()).toBe('1');
  });

  it('refetches when the window regains focus', async () => {
    fetchMock.mockImplementation(answer(2));
    await render(2);
    const before = countReads();

    fetchMock.mockImplementation(answer(5));
    await focusWindow();

    expect(countReads()).toBe(before + 1);
    expect(inboxBadge()).toBe('5');
  });

  it('refetches on a timer', async () => {
    fetchMock.mockImplementation(answer(2));
    await render(2);

    fetchMock.mockImplementation(answer(4));
    await act(() => vi.advanceTimersByTimeAsync(15_000));

    expect(inboxBadge()).toBe('4');
  });

  it('keeps a fresh layout count when a read started before it lands late', async () => {
    fetchMock.mockImplementation(answer(6));
    await render(6);
    expect(inboxBadge()).toBe('6');

    // A read leaves while 6 is still true...
    const late = deferred();
    fetchMock.mockImplementation(() => late.promise);
    await focusWindow();

    // ...then requests are decided and router.refresh() re-renders the layout with 2; no read is needed to show it.
    await render(2);
    expect(inboxBadge()).toBe('2');

    // The read that left first answers with what was true when it left. It must not undo the newer number.
    await act(async () => {
      late.resolve(body(6));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(inboxBadge()).toBe('2');
  });

  it('shows the newest read when two reads answer out of order', async () => {
    fetchMock.mockImplementation(answer(1));
    await render(1);

    const older = deferred();
    const newer = deferred();
    fetchMock.mockImplementationOnce(() => older.promise);
    fetchMock.mockImplementationOnce(() => newer.promise);
    await focusWindow();
    await focusWindow();

    await act(async () => {
      newer.resolve(body(4));
      await vi.advanceTimersByTimeAsync(0);
    });
    await act(async () => {
      older.resolve(body(9));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(inboxBadge()).toBe('4');
  });

  it('keeps the last live count when the inbox comes back unknown, refused or unreachable', async () => {
    fetchMock.mockImplementation(answer(5));
    await render(3);
    await focusWindow();
    expect(inboxBadge()).toBe('5');

    // The route could not read the inbox this time, though it still read the bell's count.
    fetchMock.mockImplementation(answer(null, 2));
    await act(() => vi.advanceTimersByTimeAsync(15_000));
    expect(inboxBadge()).toBe('5');

    fetchMock.mockImplementation(() =>
      Promise.resolve(new Response('{"error":{"message":"Down"}}', { status: 500 })),
    );
    await act(() => vi.advanceTimersByTimeAsync(15_000));
    expect(inboxBadge()).toBe('5');

    fetchMock.mockImplementation(() => Promise.reject(new TypeError('offline')));
    await focusWindow();
    expect(inboxBadge()).toBe('5');

    // A refreshed layout that could not read the inbox either does not erase the live count.
    await render(undefined);
    expect(inboxBadge()).toBe('5');
  });

  it('never turns a missing badge into a zero, and shows one once a read succeeds', async () => {
    // The layout's read failed or was refused (a non-approver), so it passed no count.
    fetchMock.mockImplementation(answer(null, 0));
    await render(undefined);
    expect(inboxBadge()).toBeNull();
    await focusWindow();
    expect(countReads()).toBe(1);
    expect(inboxBadge()).toBeNull();

    fetchMock.mockImplementation(answer(2));
    await act(() => vi.advanceTimersByTimeAsync(15_000));
    expect(inboxBadge()).toBe('2');
  });
});
