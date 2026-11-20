// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The app layout is a server component that persists across client navigation, so the inbox count
// it reads once goes stale. These tests drive the real ShellNav and NavLink inside the real shell
// state; only the router's current path and the browser's fetch are scripted.
const nav = vi.hoisted(() => ({ pathname: '/' }));
vi.mock('next/navigation', () => ({ usePathname: () => nav.pathname }));

import type { NavGroup } from '@/lib/nav';

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
const answer = (count: number) => () =>
  Promise.resolve(new Response(JSON.stringify({ count }), { status: 200 }));

let container: HTMLDivElement;
let root: Root | undefined;

async function render(counts: Record<string, number>) {
  await act(() =>
    Promise.resolve(
      root?.render(
        <ShellFrame>
          <ShellNav groups={GROUPS} counts={counts} />
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

const inboxReads = () =>
  fetchMock.mock.calls.filter(([input]) => input === '/api/inbox/count').length;

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
  it('reads the count again when the page changes, so the badge does not go stale', async () => {
    fetchMock.mockImplementation(answer(3));
    await render({ '/inbox': 3 });
    expect(inboxBadge()).toBe('3');

    // Two requests were decided elsewhere; the person moves to another page. The layout persists,
    // so its prop still says 3.
    fetchMock.mockImplementation(answer(1));
    nav.pathname = '/inbox/abc';
    await render({ '/inbox': 3 });

    expect(inboxReads()).toBeGreaterThan(0);
    expect(inboxBadge()).toBe('1');
  });

  it('refetches when the window regains focus', async () => {
    fetchMock.mockImplementation(answer(2));
    await render({ '/inbox': 2 });
    const before = inboxReads();

    fetchMock.mockImplementation(answer(5));
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(inboxReads()).toBe(before + 1);
    expect(inboxBadge()).toBe('5');
  });

  it('refetches on a timer', async () => {
    fetchMock.mockImplementation(answer(2));
    await render({ '/inbox': 2 });

    fetchMock.mockImplementation(answer(4));
    await act(() => vi.advanceTimersByTimeAsync(15_000));

    expect(inboxBadge()).toBe('4');
  });

  it('takes a fresh count from the layout after a router refresh', async () => {
    fetchMock.mockImplementation(answer(6));
    await render({ '/inbox': 6 });
    expect(inboxBadge()).toBe('6');

    // router.refresh() re-renders the layout with a new count; no fetch is needed to show it.
    fetchMock.mockImplementation(() => new Promise<Response>(() => {}));
    await render({ '/inbox': 2 });
    expect(inboxBadge()).toBe('2');
  });

  it('keeps the last count when a read fails', async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(new Response('{"error":{"message":"Down"}}', { status: 500 })),
    );
    await render({ '/inbox': 3 });
    await act(() => vi.advanceTimersByTimeAsync(15_000));
    expect(inboxBadge()).toBe('3');

    fetchMock.mockImplementation(() => Promise.reject(new TypeError('offline')));
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(inboxBadge()).toBe('3');
  });

  it('never turns a missing badge into a zero, and shows one once a read succeeds', async () => {
    // The layout's read failed or was refused, so it passed no count.
    fetchMock.mockImplementation(() =>
      Promise.resolve(new Response('{"error":{"message":"No"}}', { status: 403 })),
    );
    await render({});
    expect(inboxBadge()).toBeNull();
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(inboxReads()).toBe(1);
    expect(inboxBadge()).toBeNull();

    fetchMock.mockImplementation(answer(2));
    await act(() => vi.advanceTimersByTimeAsync(15_000));
    expect(inboxBadge()).toBe('2');
  });
});
