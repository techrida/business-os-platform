// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { choose, click, mountForm } from '@/test/form-interactions';

vi.mock('server-only', () => ({}));
const mocks = vi.hoisted(() => ({ retire: vi.fn(), success: vi.fn(), error: vi.fn() }));
vi.mock('@/app/(app)/settings/departments/actions', () => ({
  createDepartmentAction: vi.fn(),
  renameDepartmentAction: vi.fn(),
  retireDepartmentAction: mocks.retire,
  restoreDepartmentAction: vi.fn(),
}));
vi.mock('@/components/ui/toast', () => ({ toast: { success: mocks.success, error: mocks.error } }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

import { RetireDepartmentDialog } from './record-dialogs';

const SALES = '00000000-0000-4000-8000-0000000000d1';
const MARKETING = '00000000-0000-4000-8000-0000000000d2';

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.clearAllMocks();
  mocks.retire.mockResolvedValue({ ok: true, id: SALES, name: 'Sales' });
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe = vi.fn();
      unobserve = vi.fn();
      disconnect = vi.fn();
    },
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

const retireButton = () =>
  [...document.querySelectorAll('button')].find((b) => b.textContent === 'Retire') ?? null;

function mount(members: number) {
  return mountForm(
    <RetireDepartmentDialog
      department={{ id: SALES, name: 'Sales', version: 3, status: 'active', members }}
      destinations={[
        { id: SALES, name: 'Sales' },
        { id: MARKETING, name: 'Marketing' },
      ]}
      open
      onOpenChange={vi.fn()}
    />,
  );
}

it('keeps Retire disabled until a destination is chosen for the members', async () => {
  await mount(9);
  expect(document.body.textContent).toContain('Move 9 people to');
  expect(retireButton()?.disabled).toBe(true);
  await choose(document.body, 'moveMembersTo', 'No department');
  expect(retireButton()?.disabled).toBe(false);
  await click(retireButton());
  await act(() => Promise.resolve());
  expect(mocks.retire).toHaveBeenCalledExactlyOnceWith(SALES, 3, null);
});
