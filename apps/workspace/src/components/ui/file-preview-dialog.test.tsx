// @vitest-environment jsdom
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import { click, mountForm } from '@/test/form-interactions';

const pdf = vi.hoisted(() => ({ props: [] as Array<Record<string, unknown>> }));
vi.mock('@bos/pdf-viewer', () => ({
  PdfPages: (props: { data: Uint8Array; title: string; onError?: (e: Error) => void }) => {
    pdf.props.push(props);
    return <div data-testid="pdf-pages" data-bytes={props.data.byteLength} />;
  },
}));

const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('./toast', () => ({ toast: toasts }));

import { PDF_PREPARE_WITHIN_MS } from '@bos/contracts';

import { FilePreviewDialog } from './file-preview-dialog';

const PREVIEW = '/api/files/7/preview';
const DOWNLOAD = '/api/files/7/download';
const RETRY = '/api/files/7/retry';
let mounted: Awaited<ReturnType<typeof mountForm>> | undefined;
let fetchMock: Mock<(url: string, init?: RequestInit) => Promise<Response>>;

function respond(status: number, body = '%PDF-1.7'): Promise<Response> {
  return Promise.resolve(new Response(status === 200 ? body : null, { status }));
}

beforeEach(() => {
  pdf.props = [];
  toasts.success.mockReset();
  toasts.error.mockReset();
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  fetchMock = vi.fn((_url: string, _init?: RequestInit) => respond(200));
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe = vi.fn();
      disconnect = vi.fn();
    },
  );
});
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

async function flush() {
  const { act } = await import('react');
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function viewer(props: Partial<Parameters<typeof FilePreviewDialog>[0]> = {}) {
  return (
    <FilePreviewDialog
      name="Quote.pdf"
      mimeType="application/pdf"
      previewUrl={PREVIEW}
      downloadUrl={DOWNLOAD}
      trigger={<button type="button">Open</button>}
      {...props}
    />
  );
}

function button(label: string): HTMLElement {
  const found = [...document.querySelectorAll<HTMLElement>('button')].find(
    (element) => element.textContent?.trim() === label,
  );
  if (!found) throw new Error(`No button "${label}"`);
  return found;
}

it('requests nothing while closed and exactly once when opened', async () => {
  mounted = await mountForm(viewer());
  await flush();
  expect(fetchMock).not.toHaveBeenCalled();

  await click(button('Open'));
  await flush();

  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(fetchMock).toHaveBeenCalledWith(
    PREVIEW,
    expect.objectContaining({ credentials: 'same-origin', cache: 'no-store' }),
  );
  expect(document.querySelector('iframe')).toBeNull();
  expect(document.querySelector('[data-testid="pdf-pages"]')?.getAttribute('data-bytes')).toBe('8');
  expect(pdf.props.at(-1)?.title).toBe('Preview of Quote.pdf');
});

it('requests exactly once under StrictMode and again for a second open', async () => {
  mounted = await mountForm(<StrictMode>{viewer()}</StrictMode>);
  await click(button('Open'));
  await flush();
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(document.querySelector('[data-testid="pdf-pages"]')).not.toBeNull();

  await click(button('Close'));
  await click(button('Open'));
  await flush();
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

it('does not fetch a dialog that is not open and keeps Download a plain unfetched link', async () => {
  mounted = await mountForm(viewer({ defaultOpen: true }));
  await flush();
  const download = document.querySelector<HTMLAnchorElement>('a[href="/api/files/7/download"]');
  expect(download?.getAttribute('href')).toBe(DOWNLOAD);
  expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([PREVIEW]);
});

it('shows Preparing on 409 and fetches once more per Retry click, never on its own', async () => {
  fetchMock.mockImplementation(() => respond(409));
  mounted = await mountForm(viewer({ defaultOpen: true }));
  await flush();
  expect(document.body.textContent).toContain('Preparing…');
  expect(document.body.textContent).toContain('This PDF is still being prepared.');
  expect(fetchMock).toHaveBeenCalledTimes(1);

  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(fetchMock).toHaveBeenCalledTimes(1);

  await click(button('Retry'));
  await flush();
  expect(fetchMock).toHaveBeenCalledTimes(2);
  await click(button('Retry'));
  await flush();
  expect(fetchMock).toHaveBeenCalledTimes(3);

  fetchMock.mockImplementation(() => respond(200));
  await click(button('Retry'));
  await flush();
  expect(fetchMock).toHaveBeenCalledTimes(4);
  expect(document.querySelector('[data-testid="pdf-pages"]')).not.toBeNull();
});

it('treats 425 as still preparing', async () => {
  fetchMock.mockImplementation(() => respond(425));
  mounted = await mountForm(viewer({ defaultOpen: true }));
  await flush();
  expect(document.body.textContent).toContain('This PDF is still being prepared.');
});

it.each([404, 410])('says %i is not available and offers no Retry', async (status) => {
  fetchMock.mockImplementation(() => respond(status));
  mounted = await mountForm(viewer({ defaultOpen: true, retryUrl: RETRY }));
  await flush();
  expect(document.body.textContent).toContain('Not available');
  expect(document.body.textContent).toContain('This PDF is not available.');
  expect(document.body.textContent).not.toContain('still being prepared');
  expect(() => button('Retry')).toThrow();
});

it('shows Could not prepare on 424 and offers no Retry without a retry route', async () => {
  fetchMock.mockImplementation(() => respond(424));
  mounted = await mountForm(viewer({ defaultOpen: true }));
  await flush();
  expect(document.body.textContent).toContain('Could not prepare');
  expect(document.body.textContent).toContain('The PDF could not be prepared.');
  expect(() => button('Retry')).toThrow();
});

it('on 424 Retry asks the retry route first, toasts, then loads the file again', async () => {
  fetchMock.mockImplementation((url) => (url === RETRY ? respond(202, 'x') : respond(424)));
  mounted = await mountForm(viewer({ defaultOpen: true, retryUrl: RETRY }));
  await flush();
  expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([PREVIEW]);

  fetchMock.mockImplementation((url) => (url === RETRY ? respond(202, 'x') : respond(200)));
  await click(button('Retry'));
  await flush();
  expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([PREVIEW, RETRY, PREVIEW]);
  expect(fetchMock.mock.calls[1]?.[1]).toEqual(
    expect.objectContaining({ method: 'POST', credentials: 'same-origin' }),
  );
  expect(toasts.success).toHaveBeenCalledWith('Retry requested', expect.anything());
  expect(document.querySelector('[data-testid="pdf-pages"]')).not.toBeNull();
});

it('ignores a second click while the retry request is in flight', async () => {
  fetchMock.mockImplementation(() => respond(424));
  mounted = await mountForm(viewer({ defaultOpen: true, retryUrl: RETRY }));
  await flush();
  let release: (response: Response) => void = () => undefined;
  fetchMock.mockImplementation((url) =>
    url === RETRY
      ? new Promise<Response>((resolve) => {
          release = resolve;
        })
      : respond(424),
  );
  const retry = button('Retry');
  await click(retry);
  await click(retry);
  expect(fetchMock.mock.calls.filter((call) => call[0] === RETRY)).toHaveLength(1);
  const { act } = await import('react');
  await act(async () => {
    release(new Response('{}', { status: 202 }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  await flush();
  expect(fetchMock.mock.calls.filter((call) => call[0] === RETRY)).toHaveLength(1);
});

it('toasts a failed retry request and does not load the file again', async () => {
  fetchMock.mockImplementation(() => respond(424));
  mounted = await mountForm(viewer({ defaultOpen: true, retryUrl: RETRY }));
  await flush();
  fetchMock.mockImplementation((url) => (url === RETRY ? respond(502) : respond(424)));
  await click(button('Retry'));
  await flush();
  expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([PREVIEW, RETRY]);
  expect(toasts.error).toHaveBeenCalledWith('Could not request a retry', expect.anything());
  expect(toasts.success).not.toHaveBeenCalled();
  expect(document.body.textContent).toContain('Could not prepare');
});

it('loads the file again when the retry route says no retry is needed (409)', async () => {
  fetchMock.mockImplementation(() => respond(424));
  mounted = await mountForm(viewer({ defaultOpen: true, retryUrl: RETRY }));
  await flush();
  fetchMock.mockImplementation((url) => (url === RETRY ? respond(409) : respond(200)));
  await click(button('Retry'));
  await flush();
  expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([PREVIEW, RETRY, PREVIEW]);
  expect(toasts.error).not.toHaveBeenCalled();
  expect(document.querySelector('[data-testid="pdf-pages"]')).not.toBeNull();
});

it('shows an error with Retry on a server failure and on a network failure', async () => {
  fetchMock.mockImplementationOnce(() => respond(500));
  mounted = await mountForm(viewer({ defaultOpen: true }));
  await flush();
  expect(document.body.textContent).toContain('Could not load the PDF');

  fetchMock.mockImplementationOnce(() => Promise.reject(new TypeError('offline')));
  await click(button('Retry'));
  await flush();
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(document.body.textContent).toContain('Could not load the PDF');

  await click(button('Retry'));
  await flush();
  expect(document.querySelector('[data-testid="pdf-pages"]')).not.toBeNull();
});

it.each([401, 403])('says access is gone on %i and offers no Retry', async (status) => {
  fetchMock.mockImplementation(() => respond(status));
  mounted = await mountForm(viewer({ defaultOpen: true }));
  await flush();
  expect(document.body.textContent).toContain('You no longer have access to this file.');
  expect(() => button('Retry')).toThrow();
});

it('shows an error when PdfPages reports a render failure', async () => {
  mounted = await mountForm(viewer({ defaultOpen: true }));
  await flush();
  const { act } = await import('react');
  await act(() => {
    (pdf.props.at(-1)?.onError as (e: Error) => void)(new Error('bad pdf'));
    return Promise.resolve();
  });
  expect(document.body.textContent).toContain('Could not load the PDF');
  expect(document.querySelector('[data-testid="pdf-pages"]')).toBeNull();
});

it('draws an image with an img tag and no request from the dialog', async () => {
  mounted = await mountForm(
    viewer({
      name: 'Scan.png',
      mimeType: 'image/png',
      previewUrl: '/api/files/8/preview',
      defaultOpen: true,
    }),
  );
  await flush();
  const img = document.querySelector('img');
  expect(img?.getAttribute('src')).toBe('/api/files/8/preview');
  expect(fetchMock).not.toHaveBeenCalled();
});

it('shows the fallback and Download as the main action for an unknown type', async () => {
  mounted = await mountForm(
    viewer({ name: 'Sheet.xlsx', mimeType: 'application/vnd.ms-excel', defaultOpen: true }),
  );
  await flush();
  expect(document.body.textContent).toContain('No preview');
  expect(document.querySelector('iframe, img')).toBeNull();
  expect(fetchMock).not.toHaveBeenCalled();
  expect(document.querySelector('a[href="' + DOWNLOAD + '"]')?.getAttribute('href')).toBe(DOWNLOAD);
});

it.each(['https://evil.test/x.pdf', '//evil.test/x.pdf', 'javascript:alert(1)'])(
  'refuses a non same-origin preview URL %s without a request',
  async (previewUrl) => {
    mounted = await mountForm(viewer({ previewUrl, defaultOpen: true }));
    await flush();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('No preview');
    expect(document.querySelector('iframe')).toBeNull();
  },
);

it('never frames SVG or HTML', async () => {
  mounted = await mountForm(viewer({ mimeType: 'image/svg+xml', defaultOpen: true }));
  await flush();
  expect(fetchMock).not.toHaveBeenCalled();
  expect(document.querySelector('iframe, img, object, embed')).toBeNull();
});

// ---- R4c2 (TR-Q4): a generated PDF that is being prepared is checked again by itself, and Download stays in the app.

async function advance(ms: number) {
  const { act } = await import('react');
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

it('with pollWhilePreparing, checks a 409 again by itself and draws the PDF once it is there', async () => {
  vi.useFakeTimers();
  try {
    fetchMock.mockImplementation(() => respond(409));
    mounted = await mountForm(viewer({ defaultOpen: true, pollWhilePreparing: true }));
    await advance(0);
    expect(document.body.textContent).toContain('Preparing PDF');
    expect(document.body.textContent).toContain('It opens here as soon as it is ready.');
    expect([...document.querySelectorAll('button')].map((b) => b.textContent)).not.toContain(
      'Retry',
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await advance(1_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    fetchMock.mockImplementation(() => respond(200));
    await advance(2_000);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(document.querySelector('[data-testid="pdf-pages"]')).not.toBeNull();

    // Ready: no more checks.
    await advance(5 * 60_000);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  } finally {
    vi.useRealTimers();
  }
});

it('stops checking after the time a render may take and offers Check again', async () => {
  vi.useFakeTimers();
  try {
    fetchMock.mockImplementation(() => respond(409));
    mounted = await mountForm(viewer({ defaultOpen: true, pollWhilePreparing: true }));
    await advance(PDF_PREPARE_WITHIN_MS + 60_000);
    expect(document.body.textContent).toContain('This PDF is taking longer than usual.');
    const calls = fetchMock.mock.calls.length;
    await advance(10 * 60_000);
    expect(fetchMock).toHaveBeenCalledTimes(calls);

    await click(button('Check again'));
    await advance(0);
    expect(fetchMock).toHaveBeenCalledTimes(calls + 1);
    await advance(1_000);
    expect(fetchMock).toHaveBeenCalledTimes(calls + 2);
  } finally {
    vi.useRealTimers();
  }
});

it('without pollWhilePreparing still never checks a 409 on its own', async () => {
  vi.useFakeTimers();
  try {
    fetchMock.mockImplementation(() => respond(409));
    mounted = await mountForm(viewer({ defaultOpen: true }));
    await advance(PDF_PREPARE_WITHIN_MS);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  } finally {
    vi.useRealTimers();
  }
});

describe('Download with downloadInApp', () => {
  const clicked: string[] = [];
  beforeEach(() => {
    clicked.length = 0;
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clicked.push(this.download);
    });
    vi.stubGlobal(
      'URL',
      Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:x'), revokeObjectURL: vi.fn() }),
    );
  });
  afterEach(() => vi.restoreAllMocks());

  it("keeps a refusal in the app as a toast, with the route's own words, and no link in the tab", async () => {
    fetchMock.mockImplementation((url: string) =>
      url === DOWNLOAD
        ? Promise.resolve(
            new Response('This PDF is still being prepared.', {
              status: 409,
              headers: { 'content-type': 'text/plain; charset=utf-8' },
            }),
          )
        : respond(200),
    );
    mounted = await mountForm(viewer({ defaultOpen: true, downloadInApp: true }));
    await flush();
    expect(document.querySelector(`a[href="${DOWNLOAD}"]`)).toBeNull();
    await click(button('Download'));
    await flush();
    expect(fetchMock.mock.calls.filter((call) => call[0] === DOWNLOAD)).toHaveLength(1);
    expect(toasts.error).toHaveBeenCalledWith('This PDF is still being prepared.', {
      id: 'file-download',
    });
    expect(clicked).toEqual([]);
  });

  it('saves the PDF under the name the route gives, and refuses an answer that is not a PDF', async () => {
    const onDownload = vi.fn();
    fetchMock.mockImplementation((url: string) =>
      url === DOWNLOAD
        ? Promise.resolve(
            new Response('%PDF-1.7', {
              status: 200,
              headers: {
                'content-type': 'application/pdf',
                'content-disposition': 'attachment; filename="QT-2083-84-00001-R1.pdf"',
              },
            }),
          )
        : respond(200),
    );
    mounted = await mountForm(viewer({ defaultOpen: true, downloadInApp: true, onDownload }));
    await flush();
    await click(button('Download'));
    await flush();
    expect(clicked).toEqual(['QT-2083-84-00001-R1.pdf']);
    expect(onDownload).toHaveBeenCalledTimes(1);

    fetchMock.mockImplementation((url: string) =>
      url === DOWNLOAD
        ? Promise.resolve(
            new Response('<html>sign in</html>', {
              status: 200,
              headers: { 'content-type': 'text/html' },
            }),
          )
        : respond(200),
    );
    await click(button('Download'));
    await flush();
    expect(clicked).toEqual(['QT-2083-84-00001-R1.pdf']);
    expect(toasts.error).toHaveBeenCalledWith('The file could not be downloaded.', {
      id: 'file-download',
    });
  });
});
