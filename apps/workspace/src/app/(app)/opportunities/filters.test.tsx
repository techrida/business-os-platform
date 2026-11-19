// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { click, mountForm } from '@/test/form-interactions';

import { OpportunityFilters } from './filters';

let params = new URLSearchParams();
const router = { push: vi.fn(), replace: vi.fn() };

vi.mock('next/navigation', () => ({
  useRouter: () => router,
  usePathname: () => '/opportunities',
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

const STAGES = [
  { value: 'qualified', label: 'Qualified' },
  { value: 'negotiation', label: 'Negotiation' },
];
const OWNERS = [{ value: '9b2c1d3e-5f60-4a7b-8c9d-0e1f2a3b4c5d', label: 'Sita Rai' }];

const show = (url: string, props: Partial<Parameters<typeof OpportunityFilters>[0]> = {}) => {
  params = new URLSearchParams(url);
  return mountForm(
    <OpportunityFilters
      view="table"
      rows={25}
      stages={params.getAll('stage')}
      owners={params.getAll('owner')}
      stageOptions={STAGES}
      ownerOptions={OWNERS}
      {...props}
    />,
  );
};

const buttons = () =>
  Array.from(mounted.container.querySelectorAll('button')).map((b) => b.textContent?.trim());
const option = (label: string) =>
  Array.from(document.querySelectorAll<HTMLElement>('[role="option"]')).find(
    (o) => o.textContent?.trim() === label,
  )!;
const trigger = (label: string) =>
  mounted.container.querySelector<HTMLButtonElement>(`button[aria-label^="${label}"]`) ??
  Array.from(mounted.container.querySelectorAll<HTMLButtonElement>('button')).find((b) =>
    b.textContent?.includes(label),
  )!;

it('has a search box and the two dropdowns, and no Apply or Search button', async () => {
  mounted = await show('');
  expect(mounted.container.querySelector('input[type="search"], input[name="q"]')).not.toBeNull();
  expect(buttons()).toEqual(expect.arrayContaining(['All stages', 'All owners']));
  expect(buttons()).not.toContain('Search');
  expect(buttons()).not.toContain('Apply');
  expect(mounted.container.querySelector('button[type="submit"]')).toBeNull();
});

it('submits repeated stage and owner params and keeps rows and view without JavaScript', async () => {
  mounted = await show('stage=qualified&stage=negotiation&owner=' + OWNERS[0]!.value, {
    view: 'table',
    rows: 50,
  });
  const form = mounted.container.querySelector('form')!;
  const data = new FormData(form);
  expect(data.getAll('stage')).toEqual(['qualified', 'negotiation']);
  expect(data.getAll('owner')).toEqual([OWNERS[0]!.value]);
  expect(data.get('rows')).toBe('50');
  expect(buttons()).toEqual(expect.arrayContaining(['2 stages', 'Sita Rai']));
});

it('writes the stage selection to the URL as repeated params without touching view or rows', async () => {
  mounted = await show('view=board&rows=50&page=3', { view: 'table' });
  await click(trigger('All stages'));
  await click(option('Negotiation'));
  expect(router.push).toHaveBeenLastCalledWith(
    '/opportunities?view=board&rows=50&stage=negotiation',
    {
      scroll: false,
    },
  );
  await act(() => Promise.resolve());
});

it('hides the stage dropdown on the board, and the owner dropdown without owner options', async () => {
  mounted = await show('', { view: 'board', ownerOptions: [] });
  expect(buttons().some((b) => b?.includes('stage'))).toBe(false);
  expect(buttons().some((b) => b?.includes('owner'))).toBe(false);
  expect(new FormData(mounted.container.querySelector('form')!).get('view')).toBe('board');
});
