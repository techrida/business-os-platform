// @vitest-environment jsdom
import { StrictMode, act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi, type Mock } from 'vitest';

vi.mock('@bos/pdf-viewer', () => ({
  PdfPages: ({ data, title }: { data: Uint8Array; title: string }) => (
    <div data-testid="pdf-pages" data-bytes={data.byteLength} data-title={title} />
  ),
}));

import { isSameOriginUrl, ViewDocument } from './document-viewer';

const PROPS = {
  name: 'QT-1.pdf',
  previewUrl: '/quotations/1/document/preview',
  downloadUrl: '/quotations/1/document',
};

let fetchMock: Mock<(url: string, init?: RequestInit) => Promise<Response>>;
let root: Root | undefined;
let container: HTMLElement;

/** jsdom has no <dialog> behaviour: model open state, the `close` event and top-layer focus enough to drive it. */
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) {
    this.setAttribute('open', '');
  });
  HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) {
    this.removeAttribute('open');
    this.dispatchEvent(new Event('close'));
  });
  fetchMock = vi.fn((_url: string, _init?: RequestInit) =>
    Promise.resolve(new Response('%PDF-1.7', { status: 200 })),
  );
  vi.stubGlobal('fetch', fetchMock);
  container = document.createElement('div');
  document.body.append(container);
});

afterEach(async () => {
  await act(() => Promise.resolve(root?.unmount()));
  root = undefined;
  container.remove();
  vi.unstubAllGlobals();
});

async function mount(node: ReactNode) {
  root = createRoot(container);
  await act(() => Promise.resolve(root!.render(node)));
}

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function trigger(): HTMLButtonElement {
  const button = [...container.querySelectorAll('button')].find(
    (b) => b.textContent === 'View PDF',
  );
  if (!button) throw new Error('Missing View PDF button');
  return button;
}

async function open() {
  await act(() => Promise.resolve(trigger().click()));
  await settle();
}

function dialog(): HTMLDialogElement {
  const el = container.querySelector('dialog');
  if (!el) throw new Error('Missing dialog');
  return el;
}

function byText(text: string, selector = 'button'): HTMLElement | undefined {
  return [...dialog().querySelectorAll<HTMLElement>(selector)].find(
    (el) => el.textContent === text,
  );
}

it('renders a View PDF button and a Download button, and fetches nothing before open', async () => {
  await mount(<ViewDocument {...PROPS} size="small" withDownload />);
  expect(trigger().querySelector('svg')).not.toBeNull();
  // No link: a refused download must not replace the page (R4c2, TR-Q4).
  expect(container.querySelectorAll('a')).toHaveLength(0);
  expect(downloadButtons()).toHaveLength(1);
  expect(dialog().hasAttribute('open')).toBe(false);
  expect(dialog().children).toHaveLength(0);
  expect(fetchMock).not.toHaveBeenCalled();
});

it('fetches exactly once on open with same-origin credentials, no-store, then draws the pages', async () => {
  await mount(<ViewDocument {...PROPS} />);
  await open();
  expect(HTMLDialogElement.prototype.showModal).toHaveBeenCalledTimes(1);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const [url, init] = fetchMock.mock.calls[0]!;
  expect(url).toBe(PROPS.previewUrl);
  expect(init).toMatchObject({ credentials: 'same-origin', cache: 'no-store' });
  const pages = dialog().querySelector('[data-testid="pdf-pages"]');
  expect(pages?.getAttribute('data-bytes')).toBe('8');
  expect(pages?.getAttribute('data-title')).toBe('Preview of QT-1.pdf');
});

it('still fetches once on open under StrictMode', async () => {
  await mount(
    <StrictMode>
      <ViewDocument {...PROPS} />
    </StrictMode>,
  );
  expect(fetchMock).not.toHaveBeenCalled();
  await open();
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(dialog().querySelector('[data-testid="pdf-pages"]')).not.toBeNull();
});

it('is labelled by its title, and Close restores focus to the trigger and fetches again on reopen', async () => {
  await mount(<ViewDocument {...PROPS} />);
  const button = trigger();
  button.focus();
  await open();
  const title = dialog().querySelector('h2');
  expect(dialog().getAttribute('aria-labelledby')).toBe(title?.id);
  expect(title?.textContent).toBe('QT-1.pdf');

  await act(() => Promise.resolve(byText('Close')?.click()));
  expect(dialog().hasAttribute('open')).toBe(false);
  expect(dialog().children).toHaveLength(0);
  expect(document.activeElement).toBe(button);

  await open();
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

it('closes on a backdrop click and on the native close event (Esc)', async () => {
  await mount(<ViewDocument {...PROPS} />);
  await open();
  await act(() => Promise.resolve(dialog().click()));
  expect(dialog().children).toHaveLength(0);

  await open();
  expect(dialog().children).toHaveLength(1);
  await act(() => Promise.resolve(dialog().dispatchEvent(new Event('close'))));
  expect(dialog().children).toHaveLength(0);
});

it.each([409, 425])(
  'shows Preparing on %i and Retry makes one request per click, never polling',
  async (status) => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      fetchMock.mockImplementationOnce(() => Promise.resolve(new Response('', { status })));
      await mount(<ViewDocument {...PROPS} />);
      await open();
      expect(dialog().textContent).toContain('Preparing…');
      expect(dialog().textContent).toContain(
        'Your document is being prepared. Please check again shortly.',
      );
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);

      await act(() => Promise.resolve(byText('Retry')?.click()));
      await settle();
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(dialog().querySelector('[data-testid="pdf-pages"]')).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  },
);

it('shows a plain "not available" message on a 404, with no Retry and no technical reason', async () => {
  fetchMock.mockImplementationOnce(() =>
    Promise.resolve(new Response('Quotation not found.', { status: 404 })),
  );
  await mount(<ViewDocument {...PROPS} />);
  await open();
  const text = dialog().textContent ?? '';
  expect(text).toContain('This document is not available.');
  expect(text).not.toContain('Preparing');
  expect(text).not.toMatch(/retry|render|scan|quarantine|virus/i);
  expect(byText('Retry')).toBeUndefined();
  await settle();
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it('shows "delayed" on a 424 (failed or refused PDF), with no Retry, no code and no polling', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    // What signed-file-route.ts answers for a customer 424.
    fetchMock.mockImplementationOnce(() =>
      Promise.resolve(
        new Response('This PDF is delayed. Our team has been told.', {
          status: 424,
          headers: { 'content-type': 'text/plain; charset=utf-8' },
        }),
      ),
    );
    await mount(<ViewDocument {...PROPS} />);
    await open();
    const text = dialog().textContent ?? '';
    expect(text).toContain('This PDF is delayed. Our team has been told.');
    expect(text).not.toContain('Preparing');
    expect(text).not.toContain('Could not load');
    expect(text).not.toMatch(/424|render|scan|quarantine|virus|failed/i);
    expect(byText('Retry')).toBeUndefined();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  } finally {
    vi.useRealTimers();
  }
});

it('shows an error with Retry on a 500 and on a network failure', async () => {
  fetchMock.mockImplementationOnce(() => Promise.resolve(new Response('', { status: 500 })));
  await mount(<ViewDocument {...PROPS} />);
  await open();
  expect(dialog().textContent).toContain('Could not load the PDF');
  expect(byText('Retry')).toBeDefined();

  fetchMock.mockImplementationOnce(() => Promise.reject(new TypeError('network')));
  await act(() => Promise.resolve(byText('Retry')?.click()));
  await settle();
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(dialog().textContent).toContain('Could not load the PDF');
});

it.each([401, 403])('shows No access on %i with no Retry', async (status) => {
  fetchMock.mockImplementationOnce(() => Promise.resolve(new Response('', { status })));
  await mount(<ViewDocument {...PROPS} />);
  await open();
  expect(dialog().textContent).toContain('No access');
  expect(byText('Retry')).toBeUndefined();
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

function downloadButtons(): HTMLButtonElement[] {
  return [...container.querySelectorAll('button')].filter((b) => b.textContent === 'Download');
}

/** The browser's save: an object URL and a click on a hidden `download` anchor. */
function stubSave() {
  const saved: { href: string; download: string }[] = [];
  // jsdom has no object URLs; add them for this test only.
  const urls = URL as unknown as Record<string, unknown>;
  const before = { create: urls.createObjectURL, revoke: urls.revokeObjectURL };
  urls.createObjectURL = vi.fn(() => 'blob:saved');
  urls.revokeObjectURL = vi.fn();
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    saved.push({ href: this.getAttribute('href') ?? '', download: this.download });
  });
  const restore = () => {
    click.mockRestore();
    urls.createObjectURL = before.create;
    urls.revokeObjectURL = before.revoke;
  };
  return { saved, restore };
}

const pdfAttachment = () =>
  new Response('%PDF-1.7', {
    status: 200,
    headers: {
      'content-type': 'application/pdf',
      'content-disposition': 'attachment; filename="INV-0001.pdf"',
    },
  });

it("downloads in the page, beside the button and in the footer: one request each, saved under the route's name", async () => {
  const onDownload = vi.fn();
  const save = stubSave();
  await mount(<ViewDocument {...PROPS} withDownload onDownload={onDownload} />);
  fetchMock.mockImplementation(() => Promise.resolve(pdfAttachment()));
  await act(() => Promise.resolve(downloadButtons()[0]?.click()));
  await settle();
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(fetchMock.mock.calls[0]?.[0]).toBe(PROPS.downloadUrl);
  expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
    credentials: 'same-origin',
    cache: 'no-store',
  });
  expect(save.saved).toEqual([{ href: 'blob:saved', download: 'INV-0001.pdf' }]);
  expect(onDownload).toHaveBeenCalledTimes(1);

  await open();
  const inDialog = byText('Download');
  expect(inDialog?.tagName).toBe('BUTTON');
  await act(() => Promise.resolve(inDialog?.click()));
  await settle();
  // The preview fetch on open, then the footer download.
  expect(fetchMock).toHaveBeenCalledTimes(3);
  expect(fetchMock.mock.calls[2]?.[0]).toBe(PROPS.downloadUrl);
  expect(save.saved).toHaveLength(2);
  expect(onDownload).toHaveBeenCalledTimes(2);
  save.restore();
});

it("keeps a refused download in the page: the route's sentence beside the button, nothing saved", async () => {
  const onDownload = vi.fn();
  const save = stubSave();
  await mount(<ViewDocument {...PROPS} withDownload onDownload={onDownload} />);
  // What signed-file-route.ts answers while the PDF is not ready.
  fetchMock.mockImplementation(() =>
    Promise.resolve(
      new Response(
        'This PDF is not available to download yet. Please try again in a few minutes.',
        {
          status: 409,
          headers: { 'content-type': 'text/plain; charset=utf-8' },
        },
      ),
    ),
  );
  await act(() => Promise.resolve(downloadButtons()[0]?.click()));
  await settle();
  expect(container.querySelector('[role="alert"]')?.textContent).toBe(
    'This PDF is not available to download yet. Please try again in a few minutes.',
  );
  expect(save.saved).toHaveLength(0);
  expect(onDownload).not.toHaveBeenCalled();

  // A network failure, and an answer that is not a PDF, get fixed sentences.
  fetchMock.mockImplementation(() => Promise.reject(new TypeError('offline')));
  await act(() => Promise.resolve(downloadButtons()[0]?.click()));
  await settle();
  expect(container.querySelector('[role="alert"]')?.textContent).toMatch(/did not start/);
  fetchMock.mockImplementation(() =>
    Promise.resolve(
      new Response('<html>', { status: 200, headers: { 'content-type': 'text/html' } }),
    ),
  );
  await act(() => Promise.resolve(downloadButtons()[0]?.click()));
  await settle();
  expect(container.querySelector('[role="alert"]')?.textContent).toBe(
    'The file could not be downloaded.',
  );
  expect(save.saved).toHaveLength(0);
  save.restore();
});

it('keeps a delayed (424) download in the page: the delayed sentence beside the button, nothing saved', async () => {
  const onDownload = vi.fn();
  const save = stubSave();
  await mount(<ViewDocument {...PROPS} withDownload onDownload={onDownload} />);
  fetchMock.mockImplementation(() =>
    Promise.resolve(
      new Response('This PDF is delayed. Our team has been told.', {
        status: 424,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      }),
    ),
  );
  await act(() => Promise.resolve(downloadButtons()[0]?.click()));
  await settle();
  expect(container.querySelector('[role="alert"]')?.textContent).toBe(
    'This PDF is delayed. Our team has been told.',
  );
  expect(container.querySelector('dialog')).not.toBeNull();
  expect(save.saved).toHaveLength(0);
  expect(onDownload).not.toHaveBeenCalled();
  save.restore();
});

it('refuses a cross-origin preview URL: no request, a fallback message instead', async () => {
  await mount(<ViewDocument {...PROPS} previewUrl="https://evil.test/x.pdf" />);
  await open();
  expect(fetchMock).not.toHaveBeenCalled();
  expect(dialog().textContent).toContain('No preview');
});

it('honours label, variant, ariaLabel and describedBy on the trigger', async () => {
  await mount(
    <ViewDocument
      {...PROPS}
      label="Open"
      variant="primary"
      ariaLabel="Open the quotation"
      describedBy="caption"
    />,
  );
  const button = container.querySelector('button');
  expect(button?.textContent).toBe('Open');
  expect(button?.getAttribute('aria-label')).toBe('Open the quotation');
  expect(button?.getAttribute('aria-describedby')).toBe('caption');
  expect(button?.getAttribute('aria-haspopup')).toBe('dialog');
});

it('isSameOriginUrl accepts own-origin paths only', () => {
  const origin = 'http://localhost:3000';
  expect(isSameOriginUrl('/a/b', origin)).toBe(true);
  expect(isSameOriginUrl('http://localhost:3000/a', origin)).toBe(true);
  expect(isSameOriginUrl('//evil.test/a', origin)).toBe(false);
  expect(isSameOriginUrl('https://evil.test/a', origin)).toBe(false);
  expect(isSameOriginUrl('javascript:alert(1)', origin)).toBe(false);
  expect(isSameOriginUrl('', origin)).toBe(false);
});
