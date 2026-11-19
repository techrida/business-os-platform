// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { choose, click, mountForm } from '@/test/form-interactions';

import { SALES_ORDER_FILTER_OPTIONS } from './_lib/status';
import { SalesOrderFilters } from './sales-order-filters';

let params = new URLSearchParams();
const router = { push: vi.fn(), replace: vi.fn() };

vi.mock('next/navigation', () => ({
  useRouter: () => router,
  usePathname: () => '/sales-orders',
  useSearchParams: () => params,
}));

const CUSTOMER = '33333333-3333-4333-8333-333333333333';
const OTHER = '44444444-4444-4444-8444-444444444444';
let mounted: Awaited<ReturnType<typeof mountForm>>;

async function mount(url: string, props: Partial<Parameters<typeof SalesOrderFilters>[0]> = {}) {
  params = new URLSearchParams(url);
  mounted = await mountForm(
    <SalesOrderFilters
      statuses={[]}
      customerIds={[]}
      statusOptions={SALES_ORDER_FILTER_OPTIONS}
      customerOptions={[
        { value: CUSTOMER, label: 'Himal Traders' },
        { value: OTHER, label: 'Terai Supplies' },
      ]}
      rows={25}
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
  expect(search?.getAttribute('aria-label')).toBe('Search sales orders');
  expect(triggerWith('All statuses')).toBeTruthy();
  expect(triggerWith('All customers')).toBeTruthy();
  expect(mounted.container.querySelector('button[type="submit"]')).toBeNull();
  expect(mounted.container.textContent).not.toContain('Apply');
});

it('writes two statuses as repeated params and drops the page, keeping the search', async () => {
  await mount('q=himal&page=3');
  await click(triggerWith('All statuses'));
  await click(option('Draft'));
  await click(option('Confirmed'));
  expect(router.push).toHaveBeenLastCalledWith(
    '/sales-orders?q=himal&status=draft&status=confirmed',
    { scroll: false },
  );
});

it('writes customers on top of the statuses already in the URL', async () => {
  await mount('status=draft', { statuses: ['draft'] });
  await click(triggerWith('All customers'));
  await click(option('Terai Supplies'));
  expect(router.push).toHaveBeenLastCalledWith(`/sales-orders?status=draft&customerId=${OTHER}`, {
    scroll: false,
  });
});

it('keeps rows out of the URL at the default and in it otherwise', async () => {
  await mount('status=draft&rows=10', { statuses: ['draft'], rows: 10 });
  await choose(mounted.container, 'rows', '25 rows');
  expect(router.push).toHaveBeenLastCalledWith('/sales-orders?status=draft', { scroll: false });
  await choose(mounted.container, 'rows', '50 rows');
  expect(router.push).toHaveBeenLastCalledWith('/sales-orders?status=draft&rows=50', {
    scroll: false,
  });
});

it('leaves the customer filter out when the customers could not be read', async () => {
  await mount('', { customerOptions: null });
  expect(triggerWith('All statuses')).toBeTruthy();
  expect(mounted.container.querySelector('[name="customerId"]')).toBeNull();
});
