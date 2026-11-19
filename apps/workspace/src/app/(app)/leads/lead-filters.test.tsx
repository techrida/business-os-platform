// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { click, mountForm } from '@/test/form-interactions';

import { LeadFilters } from './lead-filters';

let params = new URLSearchParams();
const router = { push: vi.fn(), replace: vi.fn() };

vi.mock('next/navigation', () => ({
  useRouter: () => router,
  usePathname: () => '/leads',
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
  { value: 'new', label: 'New' },
  { value: 'contacted', label: 'Contacted' },
];
const SOURCES = [
  { value: 'website', label: 'Website' },
  { value: 'referral', label: 'Referral' },
];
const SITA = '9b2c1d3e-5f60-4a7b-8c9d-0e1f2a3b4c5d';
const RAM = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5e';
const OWNERS = [
  { value: SITA, label: 'Sita Rai' },
  { value: RAM, label: 'Ram Thapa' },
];

const show = (url: string, props: Partial<Parameters<typeof LeadFilters>[0]> = {}) => {
  params = new URLSearchParams(url);
  return mountForm(
    <LeadFilters
      view="table"
      rows={5}
      stages={params.getAll('stage')}
      sources={params.getAll('source')}
      owners={params.getAll('ownerUserId')}
      stageOptions={STAGES}
      sourceOptions={SOURCES}
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
  Array.from(mounted.container.querySelectorAll<HTMLButtonElement>('button')).find((b) =>
    b.textContent?.includes(label),
  )!;

it('has search and three dropdowns and no Apply or Search button', async () => {
  mounted = await show('');
  expect(mounted.container.querySelector('input[type="search"]')).not.toBeNull();
  expect(buttons()).toEqual(expect.arrayContaining(['All sources', 'All statuses', 'All owners']));
  expect(mounted.container.querySelector('button[type="submit"]')).toBeNull();
  expect(buttons()).not.toContain('Apply');
});

it('writes two owners as repeated ownerUserId params and keeps rows, view and search', async () => {
  mounted = await show('q=himalayan&view=board&rows=10&page=3', { view: 'board', rows: 10 });
  await click(trigger('All owners'));
  await click(option('Sita Rai'));
  await click(option('Ram Thapa'));
  expect(router.push).toHaveBeenLastCalledWith(
    `/leads?q=himalayan&view=board&rows=10&ownerUserId=${SITA}&ownerUserId=${RAM}`,
    { scroll: false },
  );
});

it('writes a source on top of an existing status filter and drops the page', async () => {
  mounted = await show('stage=new&page=2');
  await click(trigger('All sources'));
  await click(option('Website'));
  expect(router.push).toHaveBeenLastCalledWith('/leads?stage=new&source=website', {
    scroll: false,
  });
});

it('has no status control on the board', async () => {
  mounted = await show('view=board', { view: 'board' });
  expect(buttons().some((text) => text?.includes('statuses'))).toBe(false);
  expect(buttons()).toEqual(expect.arrayContaining(['All sources', 'All owners']));
});

it('hides the owner control when there are no owners to pick from', async () => {
  mounted = await show('', { ownerOptions: [] });
  expect(buttons().some((text) => text?.includes('owners'))).toBe(false);
  expect(buttons()).toEqual(expect.arrayContaining(['All sources', 'All statuses']));
});

it('submits repeated params and keeps rows without JavaScript', async () => {
  mounted = await show('stage=new&stage=contacted', { rows: 10 });
  const data = new FormData(mounted.container.querySelector('form')!);
  expect(data.getAll('stage')).toEqual(['new', 'contacted']);
  expect(data.get('rows')).toBe('10');
  expect(data.has('view')).toBe(false);
});

it('keeps the board view when the form submits without JavaScript', async () => {
  mounted = await show('view=board', { view: 'board' });
  const data = new FormData(mounted.container.querySelector('form')!);
  expect(data.get('view')).toBe('board');
});
