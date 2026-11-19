// @vitest-environment jsdom
import type { AdminDepartmentDetail } from '@bos/contracts';
import { act } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { DepartmentStaffOption } from '@/lib/api-departments';
import { choose, click, fill, mountForm } from '@/test/form-interactions';

vi.mock('server-only', () => ({}));
const dialogs = vi.hoisted(() => ({ props: [] as Record<string, unknown>[] }));
vi.mock('@/components/access/review-changes-dialog', () => ({
  ReviewChangesDialog: (props: Record<string, unknown>) => {
    dialogs.props.push(props);
    return null;
  },
}));
vi.mock('@/app/(app)/settings/departments/actions', () => ({
  previewDepartmentPeopleAction: vi.fn(),
  saveDepartmentPeopleAction: vi.fn(),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/settings/departments',
  useSearchParams: () => new URLSearchParams(),
}));

import { PEOPLE_STALE_MESSAGE, PeopleCard } from './people-card';

const SALES = '00000000-0000-4000-8000-0000000000d1';
const MARKETING = '00000000-0000-4000-8000-0000000000d2';
const ASHA = '00000000-0000-4000-8000-0000000000a1';
const BIBEK = '00000000-0000-4000-8000-0000000000a2';
const CHANDRA = '00000000-0000-4000-8000-0000000000a3';

const detail: AdminDepartmentDetail = {
  id: SALES,
  name: 'Sales',
  status: 'active',
  retiredAt: null,
  head: { id: ASHA, name: 'Asha K.' },
  managers: 0,
  memberCount: 2,
  members: [
    {
      userId: ASHA,
      name: 'Asha K.',
      email: 'asha@example.com',
      jobTitle: null,
      level: 'head',
      roles: [],
      since: '2026-01-05T00:00:00.000Z',
    },
    {
      userId: BIBEK,
      name: 'Bibek R.',
      email: 'bibek@example.com',
      jobTitle: 'Sales officer',
      level: 'staff',
      roles: [],
      since: '2026-02-10T00:00:00.000Z',
    },
  ],
  version: 2,
  revision: 'rev-1',
};

const staff: DepartmentStaffOption[] = [
  {
    id: CHANDRA,
    name: 'Chandra T.',
    email: 'chandra@example.com',
    roles: [],
    department: { id: MARKETING, name: 'Marketing' },
  },
];

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  dialogs.props.length = 0;
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe = vi.fn();
      unobserve = vi.fn();
      disconnect = vi.fn();
    },
  );
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

const button = (container: HTMLElement, text: string) =>
  [...container.querySelectorAll('button')].find((b) => b.textContent === text) ?? null;

function mount() {
  return mountForm(
    <PeopleCard
      detail={detail}
      staff={staff}
      destinations={[
        { id: SALES, name: 'Sales' },
        { id: MARKETING, name: 'Marketing' },
      ]}
      canWrite
    />,
  );
}

it('makes a second person Head and sends one head change for review', async () => {
  const { container } = await mount();
  expect(button(container, 'Review changes')?.disabled).toBe(true);
  await choose(container, `level-${BIBEK}`, 'Head');
  await click(button(container, 'Review changes'));
  const last = dialogs.props.at(-1);
  expect(last?.open).toBe(true);
  expect(last?.title).toBe('Review changes to Sales');
  expect(last?.expectedRevision).toBe('rev-1');
  expect(last?.changes).toEqual([{ kind: 'head', departmentId: SALES, userId: BIBEK }]);
});

it('says a person added from another department moves from it, and stages a memberAdd', async () => {
  const { container } = await mount();
  await fill(container.querySelector('input[placeholder="Search people"]'), 'chan');
  const option = [...document.querySelectorAll('[role="option"]')].find((el) =>
    el.textContent?.includes('Chandra T.'),
  );
  expect(option?.textContent).toContain('Moves from Marketing');
  await click(option ?? null);

  const row = [...container.querySelectorAll('tr')].find((tr) =>
    tr.textContent?.includes('Chandra T.'),
  );
  expect(row?.textContent).toContain('Moves from Marketing');
  expect(container.textContent).toContain(
    'Records Chandra T. owns stay with Marketing. Reassign them if Sales should have them.',
  );

  await click(button(container, 'Review changes'));
  expect(dialogs.props.at(-1)?.changes).toEqual([
    { kind: 'memberAdd', departmentId: SALES, userId: CHANDRA, level: 'staff' },
  ]);
});

it('keeps the staged changes and offers Reload when the save finds a newer revision', async () => {
  const { container } = await mount();
  await choose(container, `level-${BIBEK}`, 'Manager');
  await click(button(container, 'Review changes'));
  const onStale = dialogs.props.at(-1)?.onStale as () => void;
  await act(() => Promise.resolve(onStale()));
  expect(dialogs.props.at(-1)?.open).toBe(false);
  expect(container.querySelector('[role="alert"]')?.textContent).toContain(PEOPLE_STALE_MESSAGE);
  expect(button(container, 'Reload')).not.toBeNull();
  expect(button(container, 'Review changes')?.disabled).toBe(false);
});
