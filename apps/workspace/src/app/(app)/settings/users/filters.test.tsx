// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { choose, click, mountForm } from '@/test/form-interactions';

import { UsersFilters } from './filters';

let params = new URLSearchParams();
const router = { push: vi.fn(), replace: vi.fn() };

vi.mock('next/navigation', () => ({
  useRouter: () => router,
  usePathname: () => '/settings/users',
  useSearchParams: () => params,
}));

const DEPARTMENT = '00000000-0000-4000-8000-000000000002';
let mounted: Awaited<ReturnType<typeof mountForm>>;

async function mount(url: string, props: Partial<Parameters<typeof UsersFilters>[0]> = {}) {
  params = new URLSearchParams(url);
  mounted = await mountForm(
    <UsersFilters
      rows={50}
      statuses={[]}
      roles={[]}
      departmentId=""
      sort="name"
      departments={[{ id: DEPARTMENT, name: 'Operations' }]}
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

it('has search, role and status multi-selects and no Apply button', async () => {
  await mount('');
  const search = mounted.container.querySelector<HTMLInputElement>('input[type="search"]');
  expect(search?.getAttribute('aria-label')).toBe('Search users');
  expect(triggerWith('All roles')).toBeTruthy();
  expect(triggerWith('All statuses')).toBeTruthy();
  expect(mounted.container.querySelector('button[type="submit"]')).toBeNull();
  expect(mounted.container.textContent).not.toContain('Apply');
});

it('writes two statuses as repeated params and drops the page, keeping rows and search', async () => {
  await mount('q=ana&rows=25&page=3', { rows: 25 });
  await click(triggerWith('All statuses'));
  await click(option('Active'));
  await click(option('Invited'));
  expect(router.push).toHaveBeenLastCalledWith(
    '/settings/users?q=ana&rows=25&status=invited&status=active',
    { scroll: false },
  );
});

it('writes a role, a department and a non-default sort on top of each other', async () => {
  await mount('status=active', { statuses: ['active'] });
  await click(triggerWith('All roles'));
  await click(option('Finance'));
  expect(router.push).toHaveBeenLastCalledWith('/settings/users?status=active&role=finance', {
    scroll: false,
  });
  await choose(mounted.container, 'departmentId', 'Operations');
  expect(router.push).toHaveBeenLastCalledWith(
    `/settings/users?status=active&role=finance&departmentId=${DEPARTMENT}`,
    { scroll: false },
  );
  await choose(mounted.container, 'sort', 'Last active');
  expect(router.push).toHaveBeenLastCalledWith(
    `/settings/users?status=active&role=finance&departmentId=${DEPARTMENT}&sort=lastActive`,
    { scroll: false },
  );
});

it('shows the values the URL carries', async () => {
  await mount('status=active&status=invited', { statuses: ['active', 'invited'] });
  expect(triggerWith('2 statuses')).toBeTruthy();
});
