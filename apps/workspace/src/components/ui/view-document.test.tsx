// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi, type Mock } from 'vitest';

import { click, mountForm } from '@/test/form-interactions';

vi.mock('@bos/pdf-viewer', () => ({
  PdfPages: () => <div data-testid="pdf-pages" />,
}));

import { ViewDocument } from './view-document';

let mounted: Awaited<ReturnType<typeof mountForm>> | undefined;
let fetchMock: Mock<(url: string, init?: RequestInit) => Promise<Response>>;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  fetchMock = vi.fn((_url: string, _init?: RequestInit) =>
    Promise.resolve(new Response('%PDF-1.7', { status: 200 })),
  );
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

const PROPS = {
  name: 'Q-1.pdf',
  previewUrl: '/api/q/1/pdf',
  downloadUrl: '/api/q/1/pdf?download=1',
};

it('defaults to a "View PDF" button and requests nothing until it is clicked', async () => {
  mounted = await mountForm(<ViewDocument {...PROPS} />);
  const trigger = mounted.container.querySelector('button');
  expect(trigger?.textContent).toBe('View PDF');
  expect(trigger?.querySelector('svg')).not.toBeNull();
  expect(mounted.container.querySelector('a')).toBeNull();
  expect(fetchMock).not.toHaveBeenCalled();

  await click(trigger);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Q-1.pdf');
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it('uses the given label, for non-PDF callers', async () => {
  mounted = await mountForm(
    <ViewDocument {...PROPS} label="View" mimeType="image/png" previewUrl="/api/q/1/img" />,
  );
  expect(mounted.container.querySelector('button')?.textContent).toBe('View');
  await click(mounted.container.querySelector('button'));
  expect(document.querySelector('[role="dialog"] img')?.getAttribute('src')).toBe('/api/q/1/img');
  expect(fetchMock).not.toHaveBeenCalled();
});

it('renders the link variant as an inline text button and others as Buttons', async () => {
  mounted = await mountForm(
    <>
      <ViewDocument {...PROPS} variant="link" />
      <ViewDocument {...PROPS} variant="primary" size="small" />
    </>,
  );
  const [link, primary] = [...mounted.container.querySelectorAll('button')];
  expect(link?.className).toMatch(/linkTrigger/);
  expect(primary?.className).toMatch(/primary/);
  expect(primary?.className).toMatch(/small/);
  expect(link?.className).not.toMatch(/primary/);
});

it('withDownload adds a plain download anchor that is never fetched or prefetched', async () => {
  const onDownload = vi.fn();
  mounted = await mountForm(<ViewDocument {...PROPS} withDownload onDownload={onDownload} />);
  const anchor = mounted.container.querySelector<HTMLAnchorElement>('a');
  expect(anchor?.textContent).toBe('Download');
  expect(anchor?.getAttribute('href')).toBe(PROPS.downloadUrl);
  expect(anchor?.hasAttribute('download')).toBe(false);
  expect(anchor?.getAttribute('rel')).not.toBe('prefetch');
  expect(fetchMock).not.toHaveBeenCalled();
  anchor?.addEventListener('click', (event) => event.preventDefault());
  await click(anchor ?? null);
  expect(onDownload).toHaveBeenCalledTimes(1);
  expect(fetchMock).not.toHaveBeenCalled();
});
