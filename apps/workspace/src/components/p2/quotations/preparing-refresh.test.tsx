// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { mountForm } from '@/test/form-interactions';

const router = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => router }));

import type { PdfWords } from './document-link';
import { PreparingRefresh, shouldAutoRefresh } from './preparing-refresh';

let mounted: Awaited<ReturnType<typeof mountForm>> | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
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
  expect(shouldAutoRefresh('Being prepared')).toBe(true);
  expect(shouldAutoRefresh('Being scanned')).toBe(true);
  expect(shouldAutoRefresh('Not available')).toBe(false);
  expect(shouldAutoRefresh('PDF available after approval')).toBe(false);
});

it('shows the words and refreshes the route every 5 seconds', async () => {
  const { container } = await mount('Being prepared');
  expect(container.textContent).toBe('Being prepared');
  expect(router.refresh).not.toHaveBeenCalled();
  await advance(4999);
  expect(router.refresh).not.toHaveBeenCalled();
  await advance(1);
  expect(router.refresh).toHaveBeenCalledTimes(1);
  await advance(10_000);
  expect(router.refresh).toHaveBeenCalledTimes(3);
});

it('stops after 12 refreshes', async () => {
  await mount('Being scanned');
  await advance(5000 * 40);
  expect(router.refresh).toHaveBeenCalledTimes(12);
});

it('stops when unmounted', async () => {
  const view = await mount('Being prepared');
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
    await advance(120_000);
    expect(container.textContent).toBe(text);
    expect(router.refresh).not.toHaveBeenCalled();
  },
);

it('never fetches', async () => {
  const fetchSpy = vi.fn();
  vi.stubGlobal('fetch', fetchSpy);
  await mount('Being prepared');
  await advance(60_000);
  expect(fetchSpy).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});
