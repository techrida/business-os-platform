// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fill } from '@/test/form-interactions';

import { PaymentRequestsFilters } from './payment-requests-filters';

const router = { push: vi.fn(), replace: vi.fn() };
let params = new URLSearchParams();
vi.mock('next/navigation', () => ({
  useRouter: () => router,
  usePathname: () => '/payables/payment-requests',
  useSearchParams: () => params,
}));

const OPTIONS = [
  { value: 'draft', label: 'Draft' },
  { value: 'approved', label: 'Approved' },
  { value: 'rejected', label: 'Rejected' },
];

let root: Root;
let container: HTMLDivElement;

async function mount(url: string, status: string[], rows?: string) {
  params = new URLSearchParams(url);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(() =>
    Promise.resolve(
      root.render(<PaymentRequestsFilters statusOptions={OPTIONS} status={status} rows={rows} />),
    ),
  );
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.useFakeTimers();
  router.push.mockClear();
  router.replace.mockClear();
});

afterEach(async () => {
  await act(() => Promise.resolve(root.unmount()));
  container.remove();
  vi.useRealTimers();
});

describe('PaymentRequestsFilters', () => {
  it('shows the chosen statuses as repeated hidden inputs and the count on the trigger', async () => {
    await mount('status=draft&status=rejected', ['draft', 'rejected'], '50');
    const hidden = Array.from(container.querySelectorAll<HTMLInputElement>('input[name="status"]'));
    expect(hidden.map((el) => el.value)).toEqual(['draft', 'rejected']);
    expect(container.textContent).toContain('2 statuses');
    expect(container.querySelector<HTMLInputElement>('input[name="rows"]')?.value).toBe('50');
    expect(container.querySelector('button[type="submit"]')).toBeNull();
  });

  it('searches by writing q to the URL after the debounce, keeping the other params and dropping the page', async () => {
    await mount('status=draft&page=3&rows=50', ['draft']);
    const search = container.querySelector<HTMLInputElement>('input[type="search"]')!;
    expect(search.getAttribute('aria-label')).toBe('Search payment requests');
    await fill(search, 'Himal');
    await act(() => {
      vi.advanceTimersByTime(300);
      return Promise.resolve();
    });
    expect(router.replace).toHaveBeenCalledWith(
      '/payables/payment-requests?status=draft&rows=50&q=Himal',
      { scroll: false },
    );
  });
});
