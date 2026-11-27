// @vitest-environment jsdom
// PreparingRefresh on the shared schedule (round 4, R4c2: TR-Q4): it re-renders the page while the PDF is on its way,
// for at least PDF_PREPARE_WITHIN_MS (the time a render sweeper takes to store the PDF or give up), skips a hidden tab,
// and then offers "Check again" instead of saying "Preparing PDF" for ever. It asks one small status route and never fetches the document route.
import { PDF_PREPARE_WITHIN_MS } from '@bos/contracts';
import { act } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { click, mountForm } from '@/test/form-interactions';

const router = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => router }));

import type { PdfWords } from './document-link';
import { PreparingRefresh, shouldAutoRefresh } from './preparing-refresh';

const QUOTATION = '11111111-1111-4111-8111-111111111111';
const VERSION = '22222222-2222-4222-8222-222222222222';
const fetchMock = vi.fn();
let answer: { preparing: boolean } = { preparing: true };
let answerStatus = 200;
let mounted: Awaited<ReturnType<typeof mountForm>> | undefined;
let hidden = false;

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  hidden = false;
  answer = { preparing: true };
  answerStatus = 200;
  fetchMock
    .mockReset()
    .mockImplementation(() =>
      Promise.resolve(new Response(JSON.stringify(answer), { status: answerStatus })),
    );
  vi.stubGlobal('fetch', fetchMock);
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
});
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

async function mount(text: PdfWords) {
  mounted = await mountForm(
    <PreparingRefresh text={text} quotationId={QUOTATION} versionId={VERSION} />,
  );
  return mounted;
}

it('auto-refreshes only while a job is about to change the words', () => {
  expect(shouldAutoRefresh('Preparing PDF')).toBe(true);
  expect(shouldAutoRefresh('Not available')).toBe(false);
  expect(shouldAutoRefresh('PDF available after approval')).toBe(false);
});

it('checks the status route at 1, 3, 7, 15 and 30 seconds and refreshes only when it says ready', async () => {
  const { container } = await mount('Preparing PDF');
  expect(container.textContent).toBe('Preparing PDF');
  await advance(999);
  expect(fetchMock).not.toHaveBeenCalled();
  await advance(1);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
    `/api/documents/status?quotationId=${QUOTATION}&versionId=${VERSION}`,
  );
  await advance(2_000);
  expect(fetchMock).toHaveBeenCalledTimes(2);
  await advance(4_000);
  expect(fetchMock).toHaveBeenCalledTimes(3);
  await advance(8_000);
  expect(fetchMock).toHaveBeenCalledTimes(4);
  expect(router.refresh).not.toHaveBeenCalled();

  answer = { preparing: false };
  await advance(15_000);
  expect(fetchMock).toHaveBeenCalledTimes(5);
  expect(router.refresh).toHaveBeenCalledTimes(1);
});

it('does not refresh when the status route fails', async () => {
  answerStatus = 500;
  await mount('Preparing PDF');
  await advance(10_000);
  expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
  expect(router.refresh).not.toHaveBeenCalled();
});

it('keeps checking for as long as a render may take, then offers "Check again" and stops', async () => {
  const { container } = await mount('Preparing PDF');
  // The old screen gave up after a minute; a render that is retried can take up to PDF_PREPARE_WITHIN_MS.
  await advance(PDF_PREPARE_WITHIN_MS - 60_000);
  const before = fetchMock.mock.calls.length;
  expect(container.textContent).toBe('Preparing PDF');
  await advance(60_000);
  expect(fetchMock.mock.calls.length).toBeGreaterThan(before);
  await advance(30_000);
  expect(container.textContent).toContain('Still preparing the PDF.');
  const stopped = fetchMock.mock.calls.length;
  await advance(10 * 60_000);
  expect(fetchMock).toHaveBeenCalledTimes(stopped);
  expect(router.refresh).not.toHaveBeenCalled();

  // "Check again" refreshes at once and starts a fresh round.
  const button = [...container.querySelectorAll('button')].find(
    (b) => b.textContent === 'Check again',
  );
  await click(button ?? null);
  expect(router.refresh).toHaveBeenCalledTimes(1);
  expect(container.textContent).toBe('Preparing PDF');
  await advance(1_000);
  expect(fetchMock).toHaveBeenCalledTimes(stopped + 1);
});

it('does not refresh a hidden tab, and refreshes as soon as it is shown again', async () => {
  await mount('Preparing PDF');
  hidden = true;
  await advance(120_000);
  expect(fetchMock).not.toHaveBeenCalled();
  hidden = false;
  await act(() => {
    document.dispatchEvent(new Event('visibilitychange'));
    return Promise.resolve();
  });
  expect(fetchMock).toHaveBeenCalledTimes(1);
  await advance(2_000);
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

it('stops when unmounted', async () => {
  const view = await mount('Preparing PDF');
  await advance(1000);
  await view.unmount();
  mounted = undefined;
  await advance(60_000);
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it.each(['Not available', 'PDF available after approval'] as const)(
  'never refreshes for "%s"',
  async (text) => {
    const { container } = await mount(text);
    await advance(PDF_PREPARE_WITHIN_MS * 2);
    expect(container.textContent).toBe(text);
    expect(router.refresh).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  },
);

it('never calls the document route, which issues a signed link on every call', async () => {
  await mount('Preparing PDF');
  await advance(PDF_PREPARE_WITHIN_MS * 2);
  expect(
    fetchMock.mock.calls.every(([url]) => String(url).startsWith('/api/documents/status')),
  ).toBe(true);
});
