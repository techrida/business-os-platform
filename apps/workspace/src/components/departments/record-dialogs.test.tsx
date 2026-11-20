// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { choose, click, fill, mountForm, submit } from '@/test/form-interactions';

vi.mock('server-only', () => ({}));
const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  load: vi.fn(),
  retire: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
}));
vi.mock('@/app/(app)/settings/departments/actions', () => ({
  createDepartmentAction: mocks.create,
  loadRetireMembersAction: mocks.load,
  renameDepartmentAction: vi.fn(),
  retireDepartmentAction: mocks.retire,
  restoreDepartmentAction: vi.fn(),
}));
vi.mock('@/components/ui/toast', () => ({ toast: { success: mocks.success, error: mocks.error } }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

import { NewDepartmentDialog, RetireDepartmentDialog } from './record-dialogs';

const SALES = '00000000-0000-4000-8000-0000000000d1';
const MARKETING = '00000000-0000-4000-8000-0000000000d2';
const memberId = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ids = (count: number) => Array.from({ length: count }, (_, n) => memberId(n + 1));

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

/** Opens the dialog as the page would; the member list it loads has `members` people. */
async function mount(members: number) {
  mocks.load.mockResolvedValue({ ok: true, memberIds: ids(members) });
  const mounted = await mountForm(
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
  await act(() => Promise.resolve());
  expect(mocks.load).toHaveBeenCalledWith(SALES);
  return mounted;
}

it('keeps Retire disabled until a destination is chosen for the members', async () => {
  await mount(9);
  expect(document.body.textContent).toContain('Move 9 people to');
  expect(retireButton()?.disabled).toBe(true);
  await choose(document.body, 'moveMembersTo', 'No department');
  expect(retireButton()?.disabled).toBe(false);
  await click(retireButton());
  await act(() => Promise.resolve());
  expect(mocks.retire).toHaveBeenCalledExactlyOnceWith(SALES, 3, null, ids(9));
});

it('retires an empty department without asking where members go', async () => {
  await mount(0);
  expect(document.body.textContent).toContain('No one is in Sales.');
  expect(document.querySelector('input[name="moveMembersTo"]')).toBeNull();
  expect(retireButton()?.disabled).toBe(false);
  await click(retireButton());
  await act(() => Promise.resolve());
  expect(mocks.retire).toHaveBeenCalledExactlyOnceWith(SALES, 3, undefined, []);
});

it('shows a notice and reloads the members when someone joined after the dialog opened', async () => {
  const message = 'People in this department changed. Check the updated count and try again.';
  await mount(2);
  expect(document.body.textContent).toContain('Move 2 people to');
  mocks.retire.mockResolvedValueOnce({ ok: false, kind: 'membersChanged', message });
  mocks.load.mockResolvedValue({ ok: true, memberIds: ids(3) });
  await choose(document.body, 'moveMembersTo', 'Marketing');
  await click(retireButton());
  // The refusal, the reload it starts, then the reloaded list.
  await act(() => Promise.resolve());
  await act(() => Promise.resolve());
  await act(() => Promise.resolve());

  expect(mocks.retire).toHaveBeenCalledExactlyOnceWith(SALES, 3, MARKETING, ids(2));
  expect(document.querySelector('[role="alert"]')?.textContent).toContain(message);
  expect(mocks.error).not.toHaveBeenCalled();
  expect(mocks.success).not.toHaveBeenCalled();
  expect(mocks.load).toHaveBeenCalledTimes(2);
  expect(document.body.textContent).toContain('Move 3 people to');

  // Retrying sends the reloaded list.
  await click(retireButton());
  await act(() => Promise.resolve());
  expect(mocks.retire).toHaveBeenLastCalledWith(SALES, 3, MARKETING, ids(3));
  expect(mocks.success).toHaveBeenCalledWith('Sales retired.');
});

it('keeps Retire disabled when the member list could not be loaded', async () => {
  mocks.load.mockResolvedValue({ ok: false, message: 'Could not load.' });
  await mountForm(
    <RetireDepartmentDialog
      department={{ id: SALES, name: 'Sales', version: 3, status: 'active', members: 0 }}
      destinations={[{ id: MARKETING, name: 'Marketing' }]}
      open
      onOpenChange={vi.fn()}
    />,
  );
  await act(() => Promise.resolve());
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('Could not load.');
  expect(retireButton()?.disabled).toBe(true);
});

it('loads the member list again from Try again, which then allows Retire', async () => {
  mocks.load
    .mockResolvedValueOnce({ ok: false, message: 'Could not load.' })
    .mockResolvedValueOnce({ ok: true, memberIds: [] });
  await mountForm(
    <RetireDepartmentDialog
      department={{ id: SALES, name: 'Sales', version: 3, status: 'active', members: 0 }}
      destinations={[{ id: MARKETING, name: 'Marketing' }]}
      open
      onOpenChange={vi.fn()}
    />,
  );
  await act(() => Promise.resolve());
  expect(retireButton()?.disabled).toBe(true);
  const tryAgain = [...document.querySelectorAll('[role="alert"] button')].find(
    (b) => b.textContent === 'Try again',
  );
  expect(tryAgain).toBeDefined();

  await click(tryAgain ?? null);
  await act(() => Promise.resolve());
  expect(mocks.load).toHaveBeenCalledTimes(2);
  expect(document.querySelector('[role="alert"]')).toBeNull();
  expect(retireButton()?.disabled).toBe(false);
  await click(retireButton());
  await act(() => Promise.resolve());
  expect(mocks.retire).toHaveBeenCalledExactlyOnceWith(SALES, 3, undefined, []);
});

it('shows a duplicate name refusal at the Name field', async () => {
  const message = 'A department named "Sales" already exists.';
  mocks.create.mockResolvedValue({
    ok: false,
    kind: 'invalid',
    message,
    fieldErrors: { name: message },
  });
  await mountForm(<NewDepartmentDialog staff={[]} open onOpenChange={vi.fn()} />);
  const name = document.querySelector('input[name="name"]');
  await fill(name, 'sales');
  await submit(document.body);
  await act(() => Promise.resolve());
  expect(mocks.create).toHaveBeenCalledExactlyOnceWith({ name: 'sales', headUserId: null });
  expect(name?.getAttribute('aria-invalid')).toBe('true');
  const describedBy = name?.getAttribute('aria-describedby') ?? '';
  const described = describedBy.split(' ').map((id) => document.getElementById(id)?.textContent);
  expect(described).toContain(message);
  expect(mocks.error).not.toHaveBeenCalled();
});
