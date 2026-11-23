// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { click, fill, mountForm } from '@/test/form-interactions';

import { MemoFilters } from './memo-filters';

let params = new URLSearchParams();
const router = { push: vi.fn(), replace: vi.fn() };

vi.mock('next/navigation', () => ({
  useRouter: () => router,
  usePathname: () => '/memos',
  useSearchParams: () => params,
}));

let mounted: Awaited<ReturnType<typeof mountForm>>;

async function mount(url: string, status: string[] = []) {
  params = new URLSearchParams(url);
  mounted = await mountForm(<MemoFilters status={status} />);
}

const trigger = () =>
  mounted.container.querySelector<HTMLButtonElement>(
    'form button:not([aria-label="Clear search"])',
  )!;
const option = (label: string) =>
  Array.from(document.querySelectorAll<HTMLElement>('[role="option"]')).find(
    (o) => o.textContent?.trim() === label,
  )!;
const input = () => mounted.container.querySelector<HTMLInputElement>('input[type="search"]')!;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  vi.useFakeTimers();
  router.push.mockClear();
  router.replace.mockClear();
});
afterEach(async () => {
  await mounted?.unmount();
  document.body.innerHTML = '';
  vi.useRealTimers();
});

it('has a search box and a status multi-select and no Apply button', async () => {
  await mount('');
  expect(input().getAttribute('aria-label')).toBe('Search memos');
  expect(trigger().textContent).toContain('All statuses');
  expect(mounted.container.querySelector('button[type="submit"]')).toBeNull();
});

it('writes a chosen status to the URL and drops the cursor, keeping the search', async () => {
  await mount('page=abc_-1&q=budget');
  await click(trigger());
  await click(option('Draft'));
  expect(router.push).toHaveBeenLastCalledWith('/memos?q=budget&status=draft', { scroll: false });
});

it('adds a second status as a repeated param', async () => {
  await mount('status=draft', ['draft']);
  await click(trigger());
  await click(option('Approved'));
  expect(router.push).toHaveBeenLastCalledWith('/memos?status=draft&status=approved', {
    scroll: false,
  });
});

it('shows the statuses the URL carries and clears them with one URL change', async () => {
  await mount('status=draft&status=approved', ['draft', 'approved']);
  expect(trigger().textContent).toContain('2 statuses');
  await click(trigger());
  const clear = Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find(
    (b) => b.textContent?.trim() === 'Clear',
  )!;
  await click(clear);
  expect(router.push).toHaveBeenLastCalledWith('/memos', { scroll: false });
});

it('searches as the user types, keeping the chosen statuses and dropping the cursor', async () => {
  await mount('status=draft&page=abc_-1', ['draft']);
  await fill(input(), 'budget');
  await act(() => {
    vi.advanceTimersByTime(260);
    return Promise.resolve();
  });
  expect(router.replace).toHaveBeenCalledTimes(1);
  expect(router.replace).toHaveBeenCalledWith('/memos?status=draft&q=budget', { scroll: false });
});
