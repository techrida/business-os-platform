// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { click, mountForm } from '@/test/form-interactions';

import { VerificationFilters } from './verification-filters';

let params = new URLSearchParams();
const router = { push: vi.fn(), replace: vi.fn() };

vi.mock('next/navigation', () => ({
  useRouter: () => router,
  usePathname: () => '/verification',
  useSearchParams: () => params,
}));

let mounted: Awaited<ReturnType<typeof mountForm>>;

async function mount(url: string, props: Partial<Parameters<typeof VerificationFilters>[0]> = {}) {
  params = new URLSearchParams(url);
  mounted = await mountForm(<VerificationFilters status={[]} rows={undefined} {...props} />);
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

it('has search and a status multi-select, and no tabs or Apply button', async () => {
  await mount('');
  const search = mounted.container.querySelector<HTMLInputElement>('input[type="search"]');
  expect(search?.getAttribute('aria-label')).toBe('Search cases');
  expect(triggerWith('All statuses')).toBeTruthy();
  expect(mounted.container.querySelector('button[type="submit"]')).toBeNull();
  expect(mounted.container.textContent).not.toContain('Apply');
});

// The select is controlled by the URL's values, so adding a second one starts from the first.
it('adds a status to the ones in the URL as repeated params and drops the page', async () => {
  await mount('page=2&rows=50&status=submitted', { rows: 50, status: ['submitted'] });
  await click(triggerWith('Awaiting review'));
  await click(option('Verified'));
  expect(router.push).toHaveBeenLastCalledWith(
    '/verification?rows=50&status=submitted&status=approved',
    { scroll: false },
  );
});

it('shows the statuses the URL carries and clears one back to the rest', async () => {
  await mount('status=submitted', { status: ['submitted'] });
  expect(triggerWith('Awaiting review')).toBeTruthy();
  await click(triggerWith('Awaiting review'));
  await click(option('Awaiting review'));
  expect(router.push).toHaveBeenLastCalledWith('/verification', { scroll: false });
});
