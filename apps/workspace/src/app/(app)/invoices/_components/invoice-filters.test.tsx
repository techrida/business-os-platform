// @vitest-environment jsdom
// The invoice toolbar's wiring: each control writes its own repeated or single param through the FilterBar.
// Debounce, search and URL sync belong to filter-bar.test.tsx.
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { click, fill, mountForm } from '@/test/form-interactions';

import { InvoiceFilters } from './invoice-filters';

const router = { push: vi.fn(), replace: vi.fn() };
let params = new URLSearchParams();
vi.mock('next/navigation', () => ({
  useRouter: () => router,
  usePathname: () => '/invoices',
  useSearchParams: () => params,
}));

const ACME = '33333333-3333-4333-8333-333333333333';
const EVEREST = '44444444-4444-4444-8444-444444444444';
const CUSTOMERS = [
  { id: ACME, name: 'Acme Traders' },
  { id: EVEREST, name: 'Everest Foods' },
];

let mounted: Awaited<ReturnType<typeof mountForm>>;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  router.push.mockReset();
  params = new URLSearchParams();
});
afterEach(async () => {
  await mounted?.unmount();
  document.body.innerHTML = '';
});

const filters = (over: Partial<Parameters<typeof InvoiceFilters>[0]> = {}) => (
  <InvoiceFilters
    status={[]}
    kind={[]}
    settlement={[]}
    customerId={[]}
    issuedFrom={undefined}
    issuedTo={undefined}
    customers={CUSTOMERS}
    preserve={{}}
    {...over}
  />
);

const trigger = (label: string) =>
  mounted.container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
const option = (label: string) =>
  Array.from(document.querySelectorAll<HTMLElement>('[role="option"]')).find(
    (o) => o.textContent?.trim() === label,
  )!;
const lastHref = () => router.push.mock.calls.at(-1)?.[0] as string;

it('has no Apply button and keeps the rows choice for a no-JavaScript submit', async () => {
  mounted = await mountForm(filters({ preserve: { rows: '50' } }));
  expect(mounted.container.textContent).not.toContain('Apply');
  expect(mounted.container.querySelector('input[type="hidden"][name="rows"]')).toHaveProperty(
    'value',
    '50',
  );
});

it('writes a second status as a repeated param, and the settlement and customer as their own', async () => {
  mounted = await mountForm(filters());
  await click(trigger('Status'));
  await click(option('Draft'));
  expect(lastHref()).toBe('/invoices?status=draft');
  params = new URLSearchParams('status=draft');
  await click(option('Issued'));
  expect(lastHref()).toBe('/invoices?status=draft&status=issued');

  await click(trigger('Payment'));
  await click(option('Overdue'));
  expect(lastHref()).toContain('settlement=overdue');

  await click(trigger('Customer'));
  await click(option('Everest Foods'));
  expect(lastHref()).toContain(`customerId=${EVEREST}`);
}, 30_000);

it('shows the chosen values on the triggers and keeps a chosen customer that is not in the choices', async () => {
  mounted = await mountForm(
    filters({ status: ['draft', 'issued'], customerId: ['99999999-9999-4999-8999-999999999999'] }),
  );
  expect(trigger('Status').textContent).toContain('2 statuses');
  expect(trigger('Customer').textContent).toContain('Selected customer');
});

it('writes the issue date range as single params and clears one with an empty value', async () => {
  mounted = await mountForm(filters({ issuedFrom: '2026-11-01' }));
  const to = mounted.container.querySelector<HTMLInputElement>('input[name="issuedTo"]')!;
  await fill(to, '2026-11-30');
  expect(lastHref()).toContain('issuedTo=2026-11-30');
  const from = mounted.container.querySelector<HTMLInputElement>('input[name="issuedFrom"]')!;
  expect(from.value).toBe('2026-11-01');
  expect(to.min).toBe('2026-11-01');
  await fill(from, '');
  expect(lastHref()).not.toContain('issuedFrom');
});
