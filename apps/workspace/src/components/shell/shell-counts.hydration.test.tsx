// @vitest-environment jsdom
import { Writable } from 'node:stream';

import { act, Suspense, use } from 'react';
import { hydrateRoot, type Root } from 'react-dom/client';
import { renderToPipeableStream } from 'react-dom/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({ usePathname: () => '/payments/new' }));

import { ShellCountsProvider, useShellCounts } from './shell-counts';

// The page below the shell is still streaming when the badge numbers arrive: on a direct load the app layout's
// shell reaches the browser first and the page segment follows later. Its Suspense boundary is "pending" in the
// server HTML until that segment lands.
const pageStillStreaming = new Promise<never>(() => {});

function StreamingPage() {
  use(pageStillStreaming);
  return null;
}

function Bell() {
  const unread = useShellCounts()?.notifications;
  return <span data-testid="bell">{unread === undefined ? '-' : String(unread)}</span>;
}

function Shell() {
  return (
    <ShellCountsProvider>
      <header>
        <Bell />
      </header>
      <main>
        <Suspense fallback={<p>Loading</p>}>
          <StreamingPage />
        </Suspense>
      </main>
    </ShellCountsProvider>
  );
}

/** The HTML a direct load sends before the page segment: the shell, with the page boundary still pending. */
async function serverShell(): Promise<string> {
  let html = '';
  const sink = new Writable({
    write(chunk: Buffer, _encoding, done) {
      html += chunk.toString();
      done();
    },
  });
  await new Promise<void>((resolve, reject) => {
    const stream = renderToPipeableStream(<Shell />, {
      onShellReady() {
        stream.pipe(sink);
        // pipe() writes the shell synchronously; the page segment would come later, so stop here.
        setTimeout(() => {
          stream.abort();
          resolve();
        }, 0);
      },
      onShellError: reject,
      onError: () => undefined,
    });
  });
  return html;
}

let container: HTMLDivElement;
let root: Root | undefined;

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ inbox: 4, notifications: 7 }), { status: 200 }),
      ),
    ),
  );
  // The document is still loading while its page segment streams; once it is not, React treats a pending
  // boundary as failed and renders it on the client anyway.
  Object.defineProperty(document, 'readyState', { configurable: true, get: () => 'loading' });
  container = document.createElement('div');
  document.body.append(container);
});

afterEach(async () => {
  await act(() => Promise.resolve(root?.unmount()));
  root = undefined;
  container.remove();
  Reflect.deleteProperty(document, 'readyState');
  vi.unstubAllGlobals();
});

it('numbers that arrive while the page is still streaming do not make React throw away the server HTML', async () => {
  const html = await serverShell();
  // The pending boundary: a template the streamed segment is swapped into, and the server's fallback.
  expect(html).toContain('<template id="B:0"></template>');
  container.innerHTML = html;

  act(() => {
    root = hydrateRoot(container, <Shell />, { onRecoverableError: () => undefined });
  });
  // The read on arrival lands.
  await vi.waitFor(async () => {
    await act(() => Promise.resolve());
    expect(container.querySelector('[data-testid="bell"]')?.textContent).toBe('7');
  });

  // The boundary is still the server's, waiting for its segment. Had the arrival changed a context around it,
  // React would have given up hydrating it and rendered the page again on the client, leaving the streamed
  // server copy of the page with no place to go (two copies of every field in the DOM).
  expect(container.querySelector('template#B\\:0')).not.toBeNull();
});
