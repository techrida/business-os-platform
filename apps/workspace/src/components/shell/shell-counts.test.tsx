// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Drives the real poller through a consumer that prints what the bell and the badge would see. Only the
// router's path, the browser's fetch and the tab's visibility are scripted.
const nav = vi.hoisted(() => ({ pathname: '/' }));
vi.mock('next/navigation', () => ({ usePathname: () => nav.pathname }));

import { ShellCountsProvider, signInHref, useShellCounts } from './shell-counts';

const fetchMock = vi.fn<(input: string, init?: RequestInit) => Promise<Response>>();
const answer = (inbox: number | null, notifications: number | null) => () =>
  Promise.resolve(new Response(JSON.stringify({ inbox, notifications }), { status: 200 }));

function Probe() {
  const counts = useShellCounts();
  if (!counts) return <p>no provider</p>;
  const show = (n: number | undefined) => (n === undefined ? '-' : String(n));
  return (
    <p>{`inbox=${show(counts.inbox)} unread=${show(counts.notifications)} signedOut=${String(counts.signedOut)}`}</p>
  );
}

let container: HTMLDivElement;
let root: Root | undefined;
let hidden = false;

async function render(initial: { inbox?: number; notifications?: number }) {
  await act(() =>
    Promise.resolve(
      root?.render(
        <ShellCountsProvider
          initialInbox={initial.inbox}
          initialNotifications={initial.notifications}
        >
          <Probe />
        </ShellCountsProvider>,
      ),
    ),
  );
  await act(() => vi.advanceTimersByTimeAsync(0));
}

const shown = () => container.textContent;
const reads = () => fetchMock.mock.calls.filter(([url]) => url === '/api/shell/counts').length;

async function tick(ms: number) {
  await act(() => vi.advanceTimersByTimeAsync(ms));
}

async function dispatch(target: EventTarget, type: string) {
  await act(async () => {
    target.dispatchEvent(new Event(type));
    await vi.advanceTimersByTimeAsync(0);
  });
}

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'Date'],
  });
  nav.pathname = '/';
  hidden = false;
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
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

describe('ShellCountsProvider', () => {
  it('reads once on arrival when the layout has no unread count, and serves both counts from it', async () => {
    fetchMock.mockImplementation(answer(4, 3));
    await render({ inbox: 4 });

    expect(reads()).toBe(1);
    expect(shown()).toBe('inbox=4 unread=3 signedOut=false');
  });

  it('makes no arrival read when the layout gave both counts', async () => {
    fetchMock.mockImplementation(answer(9, 9));
    await render({ inbox: 4, notifications: 1 });

    expect(reads()).toBe(0);
    expect(shown()).toBe('inbox=4 unread=1 signedOut=false');
  });

  it('makes one read per poll for both consumers, every 15 s', async () => {
    fetchMock.mockImplementation(answer(1, 1));
    await render({ inbox: 1, notifications: 1 });

    fetchMock.mockImplementation(answer(2, 5));
    await tick(15_000);
    expect(reads()).toBe(1);
    expect(shown()).toBe('inbox=2 unread=5 signedOut=false');

    await tick(15_000);
    expect(reads()).toBe(2);
  });

  it('does not poll a hidden tab, and reads when it becomes visible again', async () => {
    fetchMock.mockImplementation(answer(1, 1));
    await render({ inbox: 1, notifications: 1 });

    hidden = true;
    await dispatch(document, 'visibilitychange');
    await tick(45_000);
    await dispatch(window, 'focus');
    expect(reads()).toBe(0);

    fetchMock.mockImplementation(answer(3, 2));
    hidden = false;
    await dispatch(document, 'visibilitychange');
    expect(reads()).toBe(1);
    expect(shown()).toBe('inbox=3 unread=2 signedOut=false');
  });

  it('reads again on a page change', async () => {
    fetchMock.mockImplementation(answer(7, 2));
    await render({ inbox: 1, notifications: 1 });
    expect(reads()).toBe(0);

    nav.pathname = '/sales';
    await render({ inbox: 1, notifications: 1 });
    expect(reads()).toBe(1);
    expect(shown()).toBe('inbox=7 unread=2 signedOut=false');
  });

  it('makes one read for two page changes within 5 s, and reads again after that', async () => {
    fetchMock.mockImplementation(answer(7, 2));
    await render({ inbox: 1, notifications: 1 });

    nav.pathname = '/sales';
    await render({ inbox: 1, notifications: 1 });
    expect(reads()).toBe(1);

    await tick(2_000);
    nav.pathname = '/quotations';
    await render({ inbox: 1, notifications: 1 });
    expect(reads()).toBe(1);

    await tick(4_000);
    nav.pathname = '/inbox';
    await render({ inbox: 1, notifications: 1 });
    expect(reads()).toBe(2);
  });

  it('keeps the last unread count when that read comes back unknown, never showing a zero', async () => {
    fetchMock.mockImplementation(answer(null, 3));
    await render({});
    expect(shown()).toBe('inbox=- unread=3 signedOut=false');

    fetchMock.mockImplementation(answer(2, null));
    await tick(15_000);
    expect(shown()).toBe('inbox=2 unread=3 signedOut=false');
  });

  it('signals a signed-out session on 401 and stops polling', async () => {
    fetchMock.mockImplementation(answer(1, 1));
    await render({ inbox: 1, notifications: 1 });

    fetchMock.mockImplementation(() =>
      Promise.resolve(new Response('{"error":{"message":"Sign in"}}', { status: 401 })),
    );
    await tick(15_000);
    expect(shown()).toBe('inbox=1 unread=1 signedOut=true');

    const after = reads();
    await tick(45_000);
    await dispatch(window, 'focus');
    expect(reads()).toBe(after);
  });

  it('ignores a 401 that lands after a newer layout number outranked its read', async () => {
    fetchMock.mockImplementation(answer(1, 1));
    await render({ inbox: 1, notifications: 1 });

    let land: (res: Response) => void = () => undefined;
    fetchMock.mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          land = resolve;
        }),
    );
    await tick(15_000);
    expect(reads()).toBe(1);

    // The layout re-renders with fresher numbers while that read is still on the wire.
    await render({ inbox: 2, notifications: 1 });
    await act(async () => {
      land(new Response('{"error":{"message":"Sign in"}}', { status: 401 }));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(shown()).toBe('inbox=2 unread=1 signedOut=false');
  });

  it('does not start a second read while one is still on the wire, so a slow answer can land', async () => {
    fetchMock.mockImplementation(answer(1, 1));
    await render({ inbox: 1, notifications: 1 });

    let land: (res: Response) => void = () => undefined;
    fetchMock.mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          land = resolve;
        }),
    );
    await tick(15_000);
    await tick(15_000);
    await tick(15_000);
    expect(reads()).toBe(1);

    await act(async () => {
      land(new Response(JSON.stringify({ inbox: 4, notifications: 2 }), { status: 200 }));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(shown()).toBe('inbox=4 unread=2 signedOut=false');
  });

  it('lowers the unread count when items are marked read, and drops a read that started before', async () => {
    // Stands in for the bell's "mark read" controls.
    function Lowerer() {
      const counts = useShellCounts();
      return (
        <>
          <button type="button" onClick={() => counts?.lowerNotifications(2)}>
            read2
          </button>
          <button type="button" onClick={() => counts?.lowerNotifications(5)}>
            read5
          </button>
        </>
      );
    }
    const press = (label: string) =>
      act(() =>
        Promise.resolve(
          Array.from(container.querySelectorAll('button'))
            .find((b) => b.textContent === label)
            ?.click(),
        ),
      );
    const probe = () => container.querySelector('p')?.textContent;
    fetchMock.mockImplementation(answer(1, 3));
    await act(() =>
      Promise.resolve(
        root?.render(
          <ShellCountsProvider initialInbox={1} initialNotifications={3}>
            <Probe />
            <Lowerer />
          </ShellCountsProvider>,
        ),
      ),
    );

    // A poll is on the wire, still counting the three unread items.
    let land: (res: Response) => void = () => undefined;
    fetchMock.mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          land = resolve;
        }),
    );
    await tick(15_000);
    expect(reads()).toBe(1);

    await press('read2');
    expect(probe()).toBe('inbox=1 unread=1 signedOut=false');

    await act(async () => {
      land(new Response(JSON.stringify({ inbox: 1, notifications: 3 }), { status: 200 }));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(probe()).toBe('inbox=1 unread=1 signedOut=false');

    await press('read5');
    expect(probe()).toBe('inbox=1 unread=0 signedOut=false');
  });

  it('starts no read while mark-as-read requests are out, then reads once so a late poll cannot ring the bell', async () => {
    let finish: () => void = () => undefined;
    const marks = new Promise<void>((resolve) => {
      finish = resolve;
    });
    function Marker() {
      const counts = useShellCounts();
      return (
        <button type="button" onClick={() => counts?.lowerNotifications(3, marks)}>
          mark3
        </button>
      );
    }
    fetchMock.mockImplementation(answer(1, 3));
    await act(() =>
      Promise.resolve(
        root?.render(
          <ShellCountsProvider initialInbox={1} initialNotifications={3}>
            <Probe />
            <Marker />
          </ShellCountsProvider>,
        ),
      ),
    );
    await act(async () => {
      container.querySelector('button')?.click();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(shown()).toContain('unread=0');

    // The server has not recorded every mark yet, so a read now would answer 3 again: none starts.
    fetchMock.mockImplementation(answer(1, 3));
    await tick(15_000);
    await tick(15_000);
    expect(reads()).toBe(0);
    expect(shown()).toContain('unread=0');

    // The marks landed: one read gives the server's number.
    fetchMock.mockImplementation(answer(1, 0));
    await act(async () => {
      finish();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(reads()).toBe(1);
    expect(shown()).toContain('unread=0');
  });

  it('is absent outside the provider, so consumers keep their own numbers', async () => {
    await act(() => Promise.resolve(root?.render(<Probe />)));
    expect(shown()).toBe('no provider');
  });
});

describe('signInHref', () => {
  it('returns to the same page and query after sign-in', () => {
    expect(signInHref({ pathname: '/inbox/abc', search: '?tab=open' })).toBe(
      '/auth/login?returnTo=%2Finbox%2Fabc%3Ftab%3Dopen',
    );
  });
});
