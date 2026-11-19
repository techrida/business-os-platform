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

it('renders a View PDF button and a plain Download link, and fetches nothing before open', async () => {
  await mount(<ViewDocument {...PROPS} size="small" withDownload />);
  expect(trigger().querySelector('svg')).not.toBeNull();
  const links = container.querySelectorAll('a');
  expect(links).toHaveLength(1);
  expect(links[0]?.getAttribute('href')).toBe(PROPS.downloadUrl);
  expect(links[0]?.hasAttribute('download')).toBe(false);
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

it.each([404, 409, 425])(
  'shows Preparing on %i and Retry makes one request per click, never polling',
  async (status) => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      fetchMock.mockImplementationOnce(() => Promise.resolve(new Response('', { status })));
      await mount(<ViewDocument {...PROPS} />);
      await open();
      expect(dialog().textContent).toContain('Preparing…');
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

it('keeps Download a plain anchor to the download URL, in the footer and beside the button', async () => {
  const onDownload = vi.fn();
  await mount(<ViewDocument {...PROPS} withDownload onDownload={onDownload} />);
  await open();
  const footer = byText('Download', 'a');
  expect(footer?.getAttribute('href')).toBe(PROPS.downloadUrl);
  expect(footer?.hasAttribute('download')).toBe(false);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const outside = [...container.querySelectorAll('a')].filter((a) => !dialog().contains(a));
  expect(outside).toHaveLength(1);
  expect(outside[0]?.getAttribute('href')).toBe(PROPS.downloadUrl);
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
