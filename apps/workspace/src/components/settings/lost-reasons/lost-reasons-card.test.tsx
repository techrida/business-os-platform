// @vitest-environment jsdom
import { DEFAULT_LEAD_LOST_REASONS, type LeadLostReason } from '@bos/contracts';
import { act } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { click, fill, mountForm, submit } from '@/test/form-interactions';

const mocks = vi.hoisted(() => ({
  add: vi.fn(),
  rename: vi.fn(),
  retire: vi.fn(),
  move: vi.fn(),
  reset: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
}));
vi.mock('@/app/(app)/settings/sales/actions', () => ({
  addLostReasonAction: mocks.add,
  renameLostReasonAction: mocks.rename,
  setLostReasonRetiredAction: mocks.retire,
  moveLostReasonAction: mocks.move,
  resetLostReasonsAction: mocks.reset,
}));
vi.mock('@/app/(app)/settings/_components/actions', () => ({ resetSettingAction: vi.fn() }));
vi.mock('@/components/ui/toast', () => ({ toast: { success: mocks.success, error: mocks.error } }));

import { LostReasonsCard } from './lost-reasons-card';

const reason = (n: number, label: string, extra: Partial<LeadLostReason> = {}): LeadLostReason => ({
  id: `00000000-0000-4000-8000-00000000000${n}`,
  label,
  position: n,
  isDefault: true,
  retired: false,
  version: n + 1,
  ...extra,
});
const DEFAULTS = DEFAULT_LEAD_LOST_REASONS.map((d, i) => reason(i, d.label));
const ok = { status: 'ok', message: 'Done.' };

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.clearAllMocks();
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe = vi.fn();
      unobserve = vi.fn();
      disconnect = vi.fn();
    },
  );
  for (const m of [mocks.add, mocks.rename, mocks.retire, mocks.move, mocks.reset]) {
    m.mockResolvedValue(ok);
  }
});
afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

const rows = () => [...document.querySelectorAll('ol[aria-label="Lost reasons"] > li')];
const button = (name: string) =>
  [...document.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === name) ??
  null;
const settle = async () => {
  for (let i = 0; i < 3; i += 1) await act(() => Promise.resolve());
};

it('lists the reasons in order with an App default label, and offers no reset while they are the defaults', async () => {
  const m = await mountForm(<LostReasonsCard reasons={DEFAULTS} />);
  expect(rows().map((r) => r.textContent)).toEqual(
    DEFAULT_LEAD_LOST_REASONS.map((d) => expect.stringContaining(d.label)),
  );
  expect(rows()[0]?.textContent).toContain('App default');
  expect(button('Reset the lost reasons to default')).toBeNull();
  // The first cannot move up, the last cannot move down.
  expect(button('Move Price up')?.hasAttribute('disabled')).toBe(true);
  expect(button('Move Other down')?.hasAttribute('disabled')).toBe(true);
  expect(button('Move Price down')?.hasAttribute('disabled')).toBe(false);
  await m.unmount();
});

it('shows a retired reason with a Retired label and a Restore button, and offers the reset', async () => {
  const list = [...DEFAULTS.slice(0, 5), reason(5, 'Timing', { retired: true }), DEFAULTS[6]!];
  const m = await mountForm(<LostReasonsCard reasons={list} />);
  expect(rows()[5]?.textContent).toContain('Retired');
  expect(button('Restore Timing')).not.toBeNull();
  expect(button('Reset the lost reasons to default')).not.toBeNull();
  await m.unmount();
});

it('retires with the version it showed and moves by id, and toasts the outcome', async () => {
  const m = await mountForm(<LostReasonsCard reasons={DEFAULTS} />);
  await click(button('Retire No response'));
  await settle();
  expect(mocks.retire).toHaveBeenCalledExactlyOnceWith(DEFAULTS[3]!.id, true, DEFAULTS[3]!.version);
  expect(mocks.success).toHaveBeenCalledWith('Done.');

  await click(button('Move Timing up'));
  await settle();
  expect(mocks.move).toHaveBeenCalledExactlyOnceWith(DEFAULTS[5]!.id, 'up');
  await m.unmount();
});

it('says what the server refused and leaves the list as it was', async () => {
  mocks.retire.mockResolvedValue({ status: 'error', message: 'Someone else changed this reason.' });
  const m = await mountForm(<LostReasonsCard reasons={DEFAULTS} />);
  await click(button('Retire Price'));
  await settle();
  expect(mocks.error).toHaveBeenCalledWith('Someone else changed this reason.');
  expect(mocks.success).not.toHaveBeenCalled();
  expect(rows()).toHaveLength(7);
  await m.unmount();
});

it('renames in place: refuses a duplicate before any request, then saves the trimmed name', async () => {
  const m = await mountForm(<LostReasonsCard reasons={DEFAULTS} />);
  await click(button('Rename Price'));
  const input = rows()[0]!.querySelector('input');
  await fill(input, ' no budget ');
  await submit(rows()[0]!.querySelector('form')!.parentElement as HTMLElement);
  expect(mocks.rename).not.toHaveBeenCalled();
  expect(rows()[0]?.textContent).toContain('"No budget" is already on the list.');

  await fill(rows()[0]!.querySelector('input'), '  Too dear ');
  await submit(rows()[0]!.querySelector('form')!.parentElement as HTMLElement);
  await settle();
  expect(mocks.rename).toHaveBeenCalledExactlyOnceWith(
    DEFAULTS[0]!.id,
    'Too dear',
    DEFAULTS[0]!.version,
  );
  await m.unmount();
});

it('adds a reason at the end, trimmed, and refuses an empty or duplicate one', async () => {
  const m = await mountForm(<LostReasonsCard reasons={DEFAULTS} />);
  const addForm = () => document.querySelector('form:last-of-type') as HTMLFormElement;
  const addInput = () => addForm().querySelector('input');

  await submit(addForm().parentElement as HTMLElement);
  expect(addForm().textContent).toContain('Enter a name for the reason.');
  await fill(addInput(), 'price');
  await submit(addForm().parentElement as HTMLElement);
  expect(addForm().textContent).toContain('"Price" is already on the list.');
  expect(mocks.add).not.toHaveBeenCalled();

  await fill(addInput(), '  Slow to reply ');
  await submit(addForm().parentElement as HTMLElement);
  await settle();
  expect(mocks.add).toHaveBeenCalledExactlyOnceWith('Slow to reply');
  expect((addInput() as HTMLInputElement).value).toBe('');
  await m.unmount();
});
