// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { click, mountForm } from '@/test/form-interactions';

import { ActivityFilters } from './filters';

let params = new URLSearchParams();
const router = { push: vi.fn(), replace: vi.fn() };

vi.mock('next/navigation', () => ({
  useRouter: () => router,
  usePathname: () => '/activities',
  useSearchParams: () => params,
}));

let mounted: Awaited<ReturnType<typeof mountForm>>;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  router.push.mockReset();
  router.replace.mockReset();
});
afterEach(async () => {
  await mounted?.unmount();
  document.body.innerHTML = '';
});

const KINDS = [
  { value: 'call', label: 'Call' },
  { value: 'note', label: 'Note' },
];

const show = (url: string, rows = 25) => {
  params = new URLSearchParams(url);
  return mountForm(
    <ActivityFilters rows={rows} kinds={params.getAll('kind')} kindOptions={KINDS} />,
  );
};

const buttons = () =>
  Array.from(mounted.container.querySelectorAll('button')).map((b) => b.textContent?.trim());
const option = (label: string) =>
  Array.from(document.querySelectorAll<HTMLElement>('[role="option"]')).find(
    (o) => o.textContent?.trim() === label,
  )!;

it('has a search box and a type dropdown, and no Apply or Search button', async () => {
  mounted = await show('');
  expect(mounted.container.querySelector('input[name="q"]')).not.toBeNull();
  expect(buttons()).toContain('All types');
  expect(buttons()).not.toContain('Apply');
  expect(buttons()).not.toContain('Search');
  expect(mounted.container.querySelector('button[type="submit"]')).toBeNull();
});

it('submits repeated kind params and keeps rows without JavaScript', async () => {
  mounted = await show('kind=call&kind=note', 50);
  const data = new FormData(mounted.container.querySelector('form')!);
  expect(data.getAll('kind')).toEqual(['call', 'note']);
  expect(data.get('rows')).toBe('50');
  expect(buttons()).toContain('2 types');
});

it('writes the type selection to the URL and drops the page', async () => {
  mounted = await show('rows=50&page=3');
  await click(
    Array.from(mounted.container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('All types'),
    ) ?? null,
  );
  await click(option('Call'));
  expect(router.push).toHaveBeenLastCalledWith('/activities?rows=50&kind=call', { scroll: false });
});

it('has due-from and due-to date pickers that carry the URL days without JavaScript', async () => {
  params = new URLSearchParams('dueFrom=2030-01-01&dueTo=2030-01-31');
  mounted = await mountForm(
    <ActivityFilters
      rows={25}
      kinds={[]}
      kindOptions={KINDS}
      dueFrom="2030-01-01"
      dueTo="2030-01-31"
    />,
  );
  // React Aria puts the name on the field group; the exact element is its choice.
  expect(mounted.container.innerHTML).toContain('aria-label="Due from"');
  expect(mounted.container.innerHTML).toContain('aria-label="Due to"');
  const data = new FormData(mounted.container.querySelector('form')!);
  expect(data.get('dueFrom')).toBe('2030-01-01');
  expect(data.get('dueTo')).toBe('2030-01-31');
  expect(mounted.container.querySelector('button[type="submit"]')).toBeNull();
});
