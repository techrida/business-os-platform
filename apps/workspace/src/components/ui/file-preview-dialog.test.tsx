// @vitest-environment jsdom
import { StrictMode } from 'react';
import { afterEach, beforeEach, expect, it, vi, type Mock } from 'vitest';

import { click, mountForm } from '@/test/form-interactions';

const pdf = vi.hoisted(() => ({ props: [] as Array<Record<string, unknown>> }));
vi.mock('@bos/pdf-viewer', () => ({
  PdfPages: (props: { data: Uint8Array; title: string; onError?: (e: Error) => void }) => {
    pdf.props.push(props);
    return <div data-testid="pdf-pages" data-bytes={props.data.byteLength} />;
  },
}));

import { FilePreviewDialog } from './file-preview-dialog';

const PREVIEW = '/api/files/7/preview';
const DOWNLOAD = '/api/files/7/download';
let mounted: Awaited<ReturnType<typeof mountForm>> | undefined;
let fetchMock: Mock<(url: string, init?: RequestInit) => Promise<Response>>;

function respond(status: number, body = '%PDF-1.7'): Promise<Response> {
  return Promise.resolve(new Response(status === 200 ? body : null, { status }));
}

beforeEach(() => {
  pdf.props = [];
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
  const download = document.querySelector<HTMLAnchorElement>('a[download]');
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

it.each([404, 425])('treats %i as still preparing', async (status) => {
  fetchMock.mockImplementation(() => respond(status));
  mounted = await mountForm(viewer({ defaultOpen: true }));
  await flush();
  expect(document.body.textContent).toContain('This PDF is still being prepared.');
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
  expect(document.querySelector('a[download]')?.getAttribute('href')).toBe(DOWNLOAD);
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
