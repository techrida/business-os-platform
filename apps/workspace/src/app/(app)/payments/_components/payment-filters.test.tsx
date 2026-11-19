// @vitest-environment jsdom
// The payment toolbar's wiring: status and method write repeated params through the FilterBar.
// Debounce, search and URL sync belong to filter-bar.test.tsx.
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { click, mountForm } from '@/test/form-interactions';

import { PaymentFilters } from './payment-filters';

const router = { push: vi.fn(), replace: vi.fn() };
let params = new URLSearchParams();
vi.mock('next/navigation', () => ({
  useRouter: () => router,
  usePathname: () => '/payments',
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
  params = new URLSearchParams();
});
afterEach(async () => {
  await mounted?.unmount();
  document.body.innerHTML = '';
});

const trigger = (label: string) =>
  mounted.container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
const option = (label: string) =>
  Array.from(document.querySelectorAll<HTMLElement>('[role="option"]')).find(
    (o) => o.textContent?.trim() === label,
  )!;
const lastHref = () => router.push.mock.calls.at(-1)?.[0] as string;

it('has no Apply button and keeps the rows choice for a no-JavaScript submit', async () => {
  mounted = await mountForm(<PaymentFilters status={[]} method={[]} preserve={{ rows: '50' }} />);
  expect(mounted.container.textContent).not.toContain('Apply');
  expect(mounted.container.querySelector('input[type="hidden"][name="rows"]')).toHaveProperty(
    'value',
    '50',
  );
});

it('writes statuses as a repeated param and the method as its own', async () => {
  mounted = await mountForm(<PaymentFilters status={[]} method={[]} preserve={{}} />);
  await click(trigger('Status'));
  await click(option('Verified'));
  expect(lastHref()).toBe('/payments?status=verified');
  params = new URLSearchParams('status=verified');
  await click(option('Rejected'));
  expect(lastHref()).toBe('/payments?status=verified&status=rejected');

  await click(trigger('Method'));
  await click(option('QR payment'));
  expect(lastHref()).toContain('method=qr');
});

it('shows the chosen values on the triggers', async () => {
  mounted = await mountForm(
    <PaymentFilters status={['verified', 'rejected']} method={['cash']} preserve={{}} />,
  );
  expect(trigger('Status').textContent).toContain('2 statuses');
  expect(trigger('Method').textContent).toContain('Cash');
});
