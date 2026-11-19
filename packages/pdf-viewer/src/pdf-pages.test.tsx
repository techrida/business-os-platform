// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const pdf = vi.hoisted(() => {
  const renders: { viewport: { width: number; height: number }; cancel: () => void }[] = [];
  const destroy = vi.fn(() => Promise.resolve());
  const state = {
    pages: 6,
    fail: null as Error | null,
    lastData: null as Uint8Array | null,
    gate: null as Promise<void> | null,
  };
  const getDocument = vi.fn((params: { data: Uint8Array }) => {
    state.lastData = params.data;
    if (state.fail) return { promise: Promise.reject(state.fail), destroy };
    const doc = {
      numPages: state.pages,
      getPage: (n: number) =>
        Promise.resolve({
          pageNumber: n,
          getViewport: ({ scale }: { scale: number }) => ({
            width: 600 * scale,
            height: 800 * scale,
          }),
          render: ({ viewport }: { viewport: { width: number; height: number } }) => {
            const task = { viewport, cancel: vi.fn(), promise: Promise.resolve() };
            renders.push(task);
            return task;
          },
        }),
    };
    return { promise: Promise.resolve(doc), destroy };
  });
  return { renders, destroy, state, getDocument };
});

vi.mock('./load-pdfjs', () => ({
  loadPdfjs: () =>
    (pdf.state.gate ?? Promise.resolve()).then(() => ({ getDocument: pdf.getDocument })),
}));

import { PdfPages } from './pdf-pages';

let container: HTMLElement;
let root: Root;

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function mount(node: React.ReactNode) {
  await act(() => Promise.resolve(root.render(node)));
  await settle();
}

function button(label: string): HTMLButtonElement {
  const found = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  if (!found) throw new Error(`Missing button ${label}`);
  return found;
}

async function press(key: string) {
  const target = container.querySelector('[role="document"]');
  await act(() =>
    Promise.resolve(target?.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))),
  );
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.clearAllMocks();
  pdf.renders.length = 0;
  pdf.state.pages = 6;
  pdf.state.fail = null;
  pdf.state.gate = null;
  vi.stubGlobal('devicePixelRatio', 3);
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe = vi.fn();
      disconnect = vi.fn();
    },
  );
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      observe = vi.fn();
      disconnect = vi.fn();
    },
  );
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(390);
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({} as never);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(() => Promise.resolve(root.unmount()));
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('shows Loading, then the document region, page count and labelled controls', async () => {
  let open = () => {};
  pdf.state.gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  const bytes = new Uint8Array([1, 2, 3]);
  await act(() => Promise.resolve(root.render(<PdfPages data={bytes} title="Invoice INV-7" />)));
  expect(container.querySelector('[role="status"]')?.textContent).toBe('Loading…');
  expect(container.querySelector('[role="document"]')?.getAttribute('aria-busy')).toBe('true');
  open();
  await settle();

  const region = container.querySelector('[role="document"]');
  expect(region?.getAttribute('aria-label')).toBe('Invoice INV-7');
  expect(container.querySelector('.pdf-pages__status')?.textContent).toBe('Page 1 of 6');
  expect(container.querySelector('[aria-live="polite"]')?.textContent).toBe('Page 1 of 6');
  for (const label of ['Previous page', 'Next page', 'Zoom out', 'Zoom in', 'Fit to width']) {
    expect(button(label)).toBeTruthy();
  }
  expect(button('Previous page').disabled).toBe(true);
  expect(button('Fit to width').disabled).toBe(true);
  expect(container.textContent).not.toContain('Loading…');
});

it('hands pdf.js a copy of the bytes so the caller buffer is never detached', async () => {
  const bytes = new Uint8Array([9, 8, 7]);
  await mount(<PdfPages data={bytes} title="Doc" />);
  expect(pdf.state.lastData).toEqual(bytes);
  expect(pdf.state.lastData).not.toBe(bytes);
  expect(pdf.state.lastData?.buffer).not.toBe(bytes.buffer);
});

it('renders only pages near the viewport at fit width, with the pixel ratio capped at 2', async () => {
  await mount(<PdfPages data={new Uint8Array([1])} title="Doc" />);
  // Pages 1-2 are near at the start; one page of buffer adds page 3. Pages 4-6 stay unrendered.
  expect(pdf.renders).toHaveLength(3);
  const fit = (390 - 16) / 600;
  for (const task of pdf.renders) {
    expect(task.viewport.width).toBeCloseTo(600 * fit * 2, 5);
  }
  expect(container.querySelectorAll('.pdf-pages__page canvas')).toHaveLength(3);
});

it('moves between pages with the buttons, announces the change and disables the ends', async () => {
  await mount(<PdfPages data={new Uint8Array([1])} title="Doc" />);
  await act(() => Promise.resolve(button('Next page').click()));
  expect(container.querySelector('.pdf-pages__status')?.textContent).toBe('Page 2 of 6');
  expect(container.querySelector('[aria-live="polite"]')?.textContent).toBe('Page 2 of 6');
  expect(button('Previous page').disabled).toBe(false);
  await act(() => Promise.resolve(button('Previous page').click()));
  expect(container.querySelector('.pdf-pages__status')?.textContent).toBe('Page 1 of 6');
});

it('answers the keyboard: arrows and Page keys change page, plus and minus zoom', async () => {
  await mount(<PdfPages data={new Uint8Array([1])} title="Doc" />);
  await press('ArrowRight');
  await press('PageDown');
  expect(container.querySelector('.pdf-pages__status')?.textContent).toBe('Page 3 of 6');
  await press('ArrowLeft');
  await press('PageUp');
  expect(container.querySelector('.pdf-pages__status')?.textContent).toBe('Page 1 of 6');
  await press('+');
  expect(button('Fit to width').textContent).toBe('125%');
  expect(button('Fit to width').disabled).toBe(false);
  await press('-');
  await press('-');
  expect(button('Zoom out').disabled).toBe(false);
  expect(button('Fit to width').textContent).toBe('75%');
  await act(() => Promise.resolve(button('Fit to width').click()));
  expect(button('Fit to width').textContent).toBe('100%');
});

it('shows an error message and calls onError when the document cannot be read', async () => {
  pdf.state.fail = new Error('Invalid PDF structure');
  const onError = vi.fn();
  await mount(<PdfPages data={new Uint8Array([1])} title="Doc" onError={onError} />);
  expect(container.querySelector('[role="alert"]')?.textContent).toContain(
    'could not be displayed',
  );
  expect(onError).toHaveBeenCalledTimes(1);
  expect(onError.mock.calls[0]?.[0]).toBeInstanceOf(Error);
  expect(container.querySelector('[role="document"]')).toBeNull();
});

it('destroys the document on unmount and cancels what was still rendering', async () => {
  await mount(<PdfPages data={new Uint8Array([1])} title="Doc" />);
  await act(() => Promise.resolve(root.render(null)));
  expect(pdf.destroy).toHaveBeenCalledTimes(1);
  expect(pdf.renders.every((task) => vi.mocked(task.cancel).mock.calls.length > 0)).toBe(true);
  // afterEach unmounts again; render the tree back so that call has something harmless to do.
  await act(() => Promise.resolve(root.render(<div />)));
});

it('destroys the old document and loads the new one when the bytes change', async () => {
  const first = new Uint8Array([1]);
  const second = new Uint8Array([2]);
  await mount(<PdfPages data={first} title="Doc" />);
  await mount(<PdfPages data={second} title="Doc" />);
  expect(pdf.destroy).toHaveBeenCalledTimes(1);
  expect(pdf.getDocument).toHaveBeenCalledTimes(2);
  expect(pdf.state.lastData).toEqual(second);
});
