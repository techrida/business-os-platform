// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { click, mountForm } from '@/test/form-interactions';

import { CustomerFilters } from './customer-filters';

let params = new URLSearchParams();
const router = { push: vi.fn(), replace: vi.fn() };

vi.mock('next/navigation', () => ({
  useRouter: () => router,
  usePathname: () => '/customers',
  useSearchParams: () => params,
}));

let mounted: Awaited<ReturnType<typeof mountForm>>;

async function mount(url: string, props: Partial<Parameters<typeof CustomerFilters>[0]> = {}) {
  params = new URLSearchParams(url);
  mounted = await mountForm(
    <CustomerFilters
      relationship={[]}
      industry={[]}
      industries={['Construction', 'Retail']}
      rows={undefined}
      {...props}
    />,
  );
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

it('has search, relationship and industry multi-selects and no Apply button', async () => {
  await mount('');
  const search = mounted.container.querySelector<HTMLInputElement>('input[type="search"]');
  expect(search?.getAttribute('aria-label')).toBe('Search organizations');
  expect(triggerWith('All relationships')).toBeTruthy();
  expect(triggerWith('All industries')).toBeTruthy();
  expect(mounted.container.querySelector('button[type="submit"]')).toBeNull();
});

// The select is controlled by the URL's values, so adding a second one starts from the first.
it('adds a relationship to the ones in the URL as repeated params, dropping the page', async () => {
  await mount('q=hima&page=4&relationship=active', { relationship: ['active'] });
  await click(triggerWith('Active'));
  await click(option('Prospect'));
  expect(router.push).toHaveBeenLastCalledWith(
    '/customers?q=hima&relationship=prospect&relationship=active',
    { scroll: false },
  );
});

it('writes an industry from the list the API reported', async () => {
  await mount('relationship=active', { relationship: ['active'] });
  await click(triggerWith('All industries'));
  await click(option('Retail'));
  expect(router.push).toHaveBeenLastCalledWith('/customers?relationship=active&industry=Retail', {
    scroll: false,
  });
});

it('keeps a chosen industry in the list even when no customer uses it now', async () => {
  await mount('industry=Mining', { industry: ['Mining'], industries: [] });
  expect(triggerWith('Mining')).toBeTruthy();
});

it('hides the industry filter when there is nothing to choose', async () => {
  await mount('', { industries: [] });
  expect(triggerWith('All industries')).toBeUndefined();
});
