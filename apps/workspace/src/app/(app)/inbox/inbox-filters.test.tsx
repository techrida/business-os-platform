// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { click, fill, mountForm } from '@/test/form-interactions';

import { InboxFilters } from './inbox-filters';

let params = new URLSearchParams();
const router = { push: vi.fn(), replace: vi.fn() };

vi.mock('next/navigation', () => ({
  useRouter: () => router,
  usePathname: () => '/inbox',
  useSearchParams: () => params,
}));

let mounted: Awaited<ReturnType<typeof mountForm>>;

async function mount(url: string, documentType: string[] = [], decided?: string) {
  params = new URLSearchParams(url);
  mounted = await mountForm(
    <InboxFilters documentType={documentType} rows={25} decided={decided} />,
  );
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

it('has a search box and a document-type multi-select and no Search or Apply button', async () => {
  await mount('');
  expect(input().getAttribute('aria-label')).toBe('Search approvals');
  expect(trigger().textContent).toContain('All document types');
  expect(mounted.container.querySelector('button[type="submit"]')).toBeNull();
});

it('keeps rows and the decision banner param for a no-JavaScript submit', async () => {
  await mount('rows=25&decided=approve', [], 'approve');
  const hidden = (name: string) =>
    mounted.container.querySelector<HTMLInputElement>(`input[type="hidden"][name="${name}"]`);
  expect(hidden('rows')?.value).toBe('25');
  expect(hidden('decided')?.value).toBe('approve');
});

it('writes each chosen type as a repeated param, drops the page and keeps the rest', async () => {
  await mount('page=3&rows=50&q=laptop');
  await click(trigger());
  await click(option('Memo'));
  expect(router.push).toHaveBeenLastCalledWith('/inbox?rows=50&q=laptop&documentType=test_memo', {
    scroll: false,
  });
  await click(option('Vendor bill'));
  expect(router.push).toHaveBeenLastCalledWith(
    '/inbox?rows=50&q=laptop&documentType=vendor_bill&documentType=test_memo',
    { scroll: false },
  );
});

it('shows the types the URL carries and clears them with one URL change', async () => {
  await mount('documentType=test_memo&documentType=vendor_bill', ['test_memo', 'vendor_bill']);
  expect(trigger().textContent).toContain('2 document types');
  await click(trigger());
  const clear = Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find(
    (b) => b.textContent?.trim() === 'Clear',
  )!;
  await click(clear);
  expect(router.push).toHaveBeenLastCalledWith('/inbox', { scroll: false });
});

it('searches as the user types, keeping the chosen types and dropping the page', async () => {
  await mount('documentType=test_memo&page=2', ['test_memo']);
  await fill(input(), 'laptop');
  await act(() => {
    vi.advanceTimersByTime(260);
    return Promise.resolve();
  });
  expect(router.replace).toHaveBeenCalledTimes(1);
  expect(router.replace).toHaveBeenCalledWith('/inbox?documentType=test_memo&q=laptop', {
    scroll: false,
  });
});
