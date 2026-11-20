// @vitest-environment jsdom
// PreparingRefresh on the shared schedule (round 4, R4c2: TR-Q4): it re-renders the page while the PDF is on its way,
// for at least PDF_PREPARE_WITHIN_MS (the time a render sweeper takes to store the PDF or give up), skips a hidden tab,
// and then offers "Check again" instead of saying "Preparing PDF" for ever. It never fetches the document route.
import { PDF_PREPARE_WITHIN_MS } from '@bos/contracts';
import { act } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { click, mountForm } from '@/test/form-interactions';

const router = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => router }));

import type { PdfWords } from './document-link';
import { PreparingRefresh, shouldAutoRefresh } from './preparing-refresh';

let mounted: Awaited<ReturnType<typeof mountForm>> | undefined;
let hidden = false;

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  hidden = false;
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
});
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
  vi.useRealTimers();
});

async function advance(ms: number) {
  await act(() => {
    vi.advanceTimersByTime(ms);
    return Promise.resolve();
  });
}

async function mount(text: PdfWords) {
  mounted = await mountForm(<PreparingRefresh text={text} />);
  return mounted;
}

it('auto-refreshes only while a job is about to change the words', () => {
  expect(shouldAutoRefresh('Preparing PDF')).toBe(true);
  expect(shouldAutoRefresh('Not available')).toBe(false);
  expect(shouldAutoRefresh('PDF available after approval')).toBe(false);
});

it('shows the words and refreshes after 5, 10, 20 and then every 30 seconds', async () => {
  const { container } = await mount('Preparing PDF');
  expect(container.textContent).toBe('Preparing PDF');
  await advance(4999);
  expect(router.refresh).not.toHaveBeenCalled();
  await advance(1);
  expect(router.refresh).toHaveBeenCalledTimes(1);
  await advance(10_000);
  expect(router.refresh).toHaveBeenCalledTimes(2);
  await advance(20_000);
  expect(router.refresh).toHaveBeenCalledTimes(3);
  await advance(30_000);
  expect(router.refresh).toHaveBeenCalledTimes(4);
  await advance(30_000);
  expect(router.refresh).toHaveBeenCalledTimes(5);
});

it('keeps checking for as long as a render may take, then offers "Check again" and stops', async () => {
  const { container } = await mount('Preparing PDF');
  // The old screen gave up after a minute; a render that is retried can take up to PDF_PREPARE_WITHIN_MS.
  await advance(PDF_PREPARE_WITHIN_MS - 60_000);
  const before = router.refresh.mock.calls.length;
  expect(container.textContent).toBe('Preparing PDF');
  await advance(60_000);
  expect(router.refresh.mock.calls.length).toBeGreaterThan(before);
  await advance(30_000);
  expect(container.textContent).toContain('Still preparing the PDF.');
  const stopped = router.refresh.mock.calls.length;
  await advance(10 * 60_000);
  expect(router.refresh).toHaveBeenCalledTimes(stopped);

  // "Check again" refreshes at once and starts a fresh round.
  const button = [...container.querySelectorAll('button')].find(
    (b) => b.textContent === 'Check again',
  );
  await click(button ?? null);
  expect(router.refresh).toHaveBeenCalledTimes(stopped + 1);
  expect(container.textContent).toBe('Preparing PDF');
  await advance(5_000);
  expect(router.refresh).toHaveBeenCalledTimes(stopped + 2);
});

it('does not refresh a hidden tab, and refreshes as soon as it is shown again', async () => {
  await mount('Preparing PDF');
  hidden = true;
  await advance(120_000);
  expect(router.refresh).not.toHaveBeenCalled();
  hidden = false;
  await act(() => {
    document.dispatchEvent(new Event('visibilitychange'));
    return Promise.resolve();
  });
  expect(router.refresh).toHaveBeenCalledTimes(1);
  await advance(10_000);
  expect(router.refresh).toHaveBeenCalledTimes(2);
});

it('stops when unmounted', async () => {
  const view = await mount('Preparing PDF');
  await advance(5000);
  await view.unmount();
  mounted = undefined;
  await advance(60_000);
  expect(router.refresh).toHaveBeenCalledTimes(1);
});

it.each(['Not available', 'PDF available after approval'] as const)(
  'never refreshes for "%s"',
  async (text) => {
    const { container } = await mount(text);
    await advance(PDF_PREPARE_WITHIN_MS * 2);
    expect(container.textContent).toBe(text);
    expect(router.refresh).not.toHaveBeenCalled();
  },
);

it('never fetches', async () => {
  const fetchSpy = vi.fn();
  vi.stubGlobal('fetch', fetchSpy);
  await mount('Preparing PDF');
  await advance(PDF_PREPARE_WITHIN_MS * 2);
  expect(fetchSpy).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});
