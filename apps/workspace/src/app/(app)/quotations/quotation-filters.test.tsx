// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { STATUS_FILTER_OPTIONS } from '@/components/p2/quotations/status';
import { click, mountForm } from '@/test/form-interactions';

import { QuotationFilters } from './quotation-filters';

let params = new URLSearchParams();
const router = { push: vi.fn(), replace: vi.fn() };

vi.mock('next/navigation', () => ({
  useRouter: () => router,
  usePathname: () => '/quotations',
  useSearchParams: () => params,
}));

const CUSTOMER = '33333333-3333-4333-8333-333333333333';
const OTHER = '44444444-4444-4444-8444-444444444444';
const OPP = '11111111-1111-4111-8111-111111111111';
let mounted: Awaited<ReturnType<typeof mountForm>>;

async function mount(url: string, props: Partial<Parameters<typeof QuotationFilters>[0]> = {}) {
  params = new URLSearchParams(url);
  mounted = await mountForm(
    <QuotationFilters
      opportunityId={undefined}
      rows={5}
      statuses={[]}
      customerIds={[]}
      statusOptions={STATUS_FILTER_OPTIONS}
      customerOptions={[
        { value: CUSTOMER, label: 'Himal Traders' },
        { value: OTHER, label: 'Terai Supplies' },
      ]}
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

it('has search, status and customer filters and no Apply button', async () => {
  await mount('');
  const search = mounted.container.querySelector<HTMLInputElement>('input[type="search"]');
  expect(search?.getAttribute('aria-label')).toBe('Search quotations');
  expect(triggerWith('All statuses')).toBeTruthy();
  expect(triggerWith('All customers')).toBeTruthy();
  expect(mounted.container.querySelector('button[type="submit"]')).toBeNull();
  expect(mounted.container.textContent).not.toContain('Apply');
});

it('writes two statuses as repeated params, dropping the page and keeping the search and scope', async () => {
  await mount(`opportunityId=${OPP}&q=himal&page=3`, { opportunityId: OPP });
  await click(triggerWith('All statuses'));
  await click(option('Draft'));
  await click(option('Sent'));
  expect(router.push).toHaveBeenLastCalledWith(
    `/quotations?opportunityId=${OPP}&q=himal&status=draft&status=sent`,
    { scroll: false },
  );
});

it('writes customers on top of the statuses already in the URL', async () => {
  await mount('status=draft&rows=10', { statuses: ['draft'], rows: 10 });
  await click(triggerWith('All customers'));
  await click(option('Terai Supplies'));
  expect(router.push).toHaveBeenLastCalledWith(
    `/quotations?status=draft&rows=10&customerId=${OTHER}`,
    { scroll: false },
  );
});

it('keeps the scope and the rows for a form submitted without JavaScript', async () => {
  await mount('', { opportunityId: OPP, rows: 10 });
  const hidden = (name: string) =>
    mounted.container.querySelector<HTMLInputElement>(`input[type="hidden"][name="${name}"]`);
  expect(hidden('opportunityId')?.value).toBe(OPP);
  expect(hidden('rows')?.value).toBe('10');
});

it('leaves the customer filter out when the customers could not be read', async () => {
  await mount('', { customerOptions: null });
  expect(triggerWith('All statuses')).toBeTruthy();
  expect(mounted.container.querySelector('[name="customerId"]')).toBeNull();
});
