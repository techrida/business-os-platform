// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { click, mountForm } from '@/test/form-interactions';

import { VendorFilters } from './vendor-filters';

let params = new URLSearchParams();
const router = { push: vi.fn(), replace: vi.fn() };

vi.mock('next/navigation', () => ({
  useRouter: () => router,
  usePathname: () => '/vendors',
  useSearchParams: () => params,
}));

let mounted: Awaited<ReturnType<typeof mountForm>>;

async function mount(url: string, props: Partial<Parameters<typeof VendorFilters>[0]> = {}) {
  params = new URLSearchParams(url);
  mounted = await mountForm(<VendorFilters status={[]} kind={[]} rows={undefined} {...props} />);
}

const triggerWith = (text: string) =>
  Array.from(mounted.container.querySelectorAll<HTMLButtonElement>('form button')).find((b) =>
    b.textContent?.includes(text),
  )!;
const option = (label: string) =>
  Array.from(document.querySelectorAll<HTMLElement>('[role="option"]')).find(
    (o) => o.textContent?.trim() === label,
  )!;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  router.push.mockClear();
  router.replace.mockClear();
});
afterEach(async () => {
  await mounted?.unmount();
  document.body.innerHTML = '';
});

it('has search, status and kind multi-selects and no Apply button', async () => {
  await mount('');
  const search = mounted.container.querySelector<HTMLInputElement>('input[type="search"]');
  expect(search?.getAttribute('aria-label')).toBe('Search vendors');
  expect(triggerWith('All statuses')).toBeTruthy();
  expect(triggerWith('All kinds')).toBeTruthy();
  expect(mounted.container.querySelector('button[type="submit"]')).toBeNull();
  expect(mounted.container.textContent).not.toContain('Apply');
});

// The select is controlled by the URL's values, so adding a second one starts from the first.
it('adds a status to the ones in the URL as repeated params, dropping the page', async () => {
  await mount('q=himal&rows=50&page=3&status=approved', { rows: 50, status: ['approved'] });
  await click(triggerWith('Approved'));
  await click(option('Draft'));
  expect(router.push).toHaveBeenLastCalledWith(
    '/vendors?q=himal&rows=50&status=draft&status=approved',
    { scroll: false },
  );
});

it('writes a kind on top of a status', async () => {
  await mount('status=approved', { status: ['approved'] });
  await click(triggerWith('All kinds'));
  await click(option('Sole proprietor'));
  expect(router.push).toHaveBeenLastCalledWith('/vendors?status=approved&kind=sole_proprietor', {
    scroll: false,
  });
});

it('shows the values the URL carries', async () => {
  await mount('status=approved&status=blocked&kind=foreign', {
    status: ['approved', 'blocked'],
    kind: ['foreign'],
  });
  expect(triggerWith('2 statuses')).toBeTruthy();
  expect(triggerWith('Foreign vendor')).toBeTruthy();
});
