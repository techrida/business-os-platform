// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fill } from '@/test/form-interactions';

import { InboxFilters } from './inbox-filters';

const router = { push: vi.fn(), replace: vi.fn() };
let params = new URLSearchParams();
vi.mock('next/navigation', () => ({
  useRouter: () => router,
  usePathname: () => '/payables/inbox',
  useSearchParams: () => params,
}));

let root: Root;
let container: HTMLDivElement;

async function mount(url: string, rows?: string) {
  params = new URLSearchParams(url);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(() => Promise.resolve(root.render(<InboxFilters rows={rows} />)));
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

describe('InboxFilters', () => {
  it('offers a search and no status control or submit button, and keeps rows for no-JS submit', async () => {
    await mount('', '50');
    expect(container.querySelector('input[type="search"]')).not.toBeNull();
    expect(container.querySelector('input[name="status"]')).toBeNull();
    expect(container.querySelector('button[type="submit"]')).toBeNull();
    expect(container.querySelector<HTMLInputElement>('input[name="rows"]')?.value).toBe('50');
  });

  it('searches by writing q to the URL after the debounce, dropping the page', async () => {
    await mount('page=3&rows=50');
    const search = container.querySelector<HTMLInputElement>('input[type="search"]')!;
    expect(search.getAttribute('aria-label')).toBe('Search the inbox');
    await fill(search, 'Himal');
    await act(() => {
      vi.advanceTimersByTime(300);
      return Promise.resolve();
    });
    expect(router.replace).toHaveBeenCalledWith('/payables/inbox?rows=50&q=Himal', {
      scroll: false,
    });
  });
});
