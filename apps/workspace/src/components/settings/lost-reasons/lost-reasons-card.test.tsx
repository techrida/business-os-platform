// @vitest-environment jsdom
import {
  DEFAULT_LEAD_LOST_REASONS,
  LOST_REASONS_STALE_MESSAGE,
  lostReasonsToken,
  type LeadLostReason,
} from '@bos/contracts';
import { act } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { click, fill, mountForm, submit } from '@/test/form-interactions';

const mocks = vi.hoisted(() => ({
  add: vi.fn(),
  rename: vi.fn(),
  retire: vi.fn(),
  reorder: vi.fn(),
  reset: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
}));
vi.mock('@/app/(app)/settings/sales/actions', () => ({
  addLostReasonAction: mocks.add,
  renameLostReasonAction: mocks.rename,
  setLostReasonRetiredAction: mocks.retire,
  reorderLostReasonsAction: mocks.reorder,
  resetLostReasonsAction: mocks.reset,
}));
vi.mock('@/app/(app)/settings/_components/actions', () => ({ resetSettingAction: vi.fn() }));
vi.mock('@/components/ui/toast', () => ({ toast: { success: mocks.success, error: mocks.error } }));

import { LostReasonsCard } from './lost-reasons-card';
import { movedOrder } from './lost-reasons-model';

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
  for (const m of [mocks.add, mocks.rename, mocks.retire, mocks.reorder, mocks.reset]) {
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
    DEFAULT_LEAD_LOST_REASONS.map((d): string => d.label).map(
      (label) => expect.stringContaining(label) as unknown,
    ),
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

it('retires with the version it showed and reorders with the displayed ids and token', async () => {
  const m = await mountForm(<LostReasonsCard reasons={DEFAULTS} />);
  await click(button('Retire No response'));
  await settle();
  expect(mocks.retire).toHaveBeenCalledExactlyOnceWith(DEFAULTS[3]!.id, true, DEFAULTS[3]!.version);
  expect(mocks.success).toHaveBeenCalledWith('Done.');

  await click(button('Move Timing up'));
  await settle();
  expect(mocks.reorder).toHaveBeenCalledExactlyOnceWith(
    movedOrder(DEFAULTS, DEFAULTS[5]!.id, 'up'),
    lostReasonsToken(DEFAULTS),
  );
  await m.unmount();
});

it('shows the stale message with a Reload action when a reorder is refused as stale', async () => {
  mocks.reorder.mockResolvedValue({ status: 'error', message: LOST_REASONS_STALE_MESSAGE });
  const m = await mountForm(<LostReasonsCard reasons={DEFAULTS} />);
  await click(button('Move Price down'));
  await settle();
  expect(mocks.reorder).toHaveBeenCalledExactlyOnceWith(
    movedOrder(DEFAULTS, DEFAULTS[0]!.id, 'down'),
    lostReasonsToken(DEFAULTS),
  );
  expect(mocks.error).toHaveBeenCalledOnce();
  const [message, options] = mocks.error.mock.calls[0] as [
    string,
    { action?: { label: string; onClick: () => void } },
  ];
  expect(message).toBe(LOST_REASONS_STALE_MESSAGE);
  expect(options.action?.label).toBe('Reload');
  expect(typeof options.action?.onClick).toBe('function');
  expect(mocks.success).not.toHaveBeenCalled();
  expect(rows()).toHaveLength(7);
  await m.unmount();
});

it('sends the displayed token on reset and shows the stale message with Reload when refused', async () => {
  const list = [...DEFAULTS.slice(0, 5), reason(5, 'Timing', { retired: true }), DEFAULTS[6]!];
  mocks.reset.mockResolvedValue({ status: 'error', message: LOST_REASONS_STALE_MESSAGE });
  const m = await mountForm(<LostReasonsCard reasons={list} />);
  await click(button('Reset the lost reasons to default'));
  const confirmBtn =
    [...document.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === 'Reset lost reasons',
    ) ?? null;
  await click(confirmBtn);
  await settle();
  expect(mocks.reset).toHaveBeenCalledExactlyOnceWith(lostReasonsToken(list));
  expect(mocks.error).toHaveBeenCalledOnce();
  const [message, options] = mocks.error.mock.calls[0] as [
    string,
    { id?: string; action?: { label: string; onClick: () => void } },
  ];
  expect(message).toBe(LOST_REASONS_STALE_MESSAGE);
  expect(options.id).toBe('reset:lead_lost_reasons');
  expect(options.action?.label).toBe('Reload');
  expect(typeof options.action?.onClick).toBe('function');
  expect(mocks.success).not.toHaveBeenCalled();
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
