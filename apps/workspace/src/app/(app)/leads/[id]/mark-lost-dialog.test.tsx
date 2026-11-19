// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { ApiError } from '@/lib/api';
import { click, fill, mountForm } from '@/test/form-interactions';

vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/bff', () => ({
  requireStaffSession: vi.fn(() => Promise.resolve({ accessToken: 'test', roles: ['sales'] })),
}));
const mocks = vi.hoisted(() => ({
  changeLeadStage: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
}));
vi.mock('@/components/p2/crm/crm-api', () => ({ changeLeadStage: mocks.changeLeadStage }));
vi.mock('@/components/ui/toast', () => ({ toast: { success: mocks.success, error: mocks.error } }));

import { MarkLostDialog } from './mark-lost-dialog';

const LEAD = '11111111-1111-4111-8111-111111111111';

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
});
afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

const dialog = () => document.querySelector('[role="dialog"]');
const inDialog = (selector: string) => dialog()?.querySelector(selector) ?? null;
const footerButton = (label: string) =>
  [...(dialog()?.querySelectorAll('footer button') ?? [])].find((b) => b.textContent === label) ??
  null;

/** Let the transition, the mocked call and the state updates finish. */
async function settle() {
  for (let i = 0; i < 3; i += 1) await act(() => Promise.resolve());
}

async function typeNote(value: string) {
  const note = inDialog('textarea[name="note"]');
  if (!(note instanceof HTMLTextAreaElement)) throw new Error('Missing note');
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(note, value);
  await act(() => Promise.resolve(note.dispatchEvent(new Event('input', { bubbles: true }))));
}

async function open() {
  const mounted = await mountForm(<MarkLostDialog id={LEAD} number="LEAD-1" version={4} />);
  const trigger = mounted.container.querySelector('button');
  expect(trigger?.textContent).toBe('Mark lost');
  await click(trigger);
  return mounted;
}

it('refuses an empty reason and note with field errors and sends nothing', async () => {
  const mounted = await open();
  await fill(inDialog('input[name="reason"]'), '   ');
  await click(footerButton('Mark lost'));
  await settle();

  expect(mocks.changeLeadStage).not.toHaveBeenCalled();
  expect(dialog()?.textContent).toContain('Give a reason, up to 200 characters.');
  expect(dialog()?.textContent).toContain('Add a note for the record, up to 2,000 characters.');
  expect(inDialog('input[name="reason"]')?.getAttribute('aria-invalid')).toBe('true');
  await mounted.unmount();
});

it('refuses a reason without a note', async () => {
  const mounted = await open();
  await fill(inDialog('input[name="reason"]'), 'Chose another vendor');
  await click(footerButton('Mark lost'));
  await settle();

  expect(mocks.changeLeadStage).not.toHaveBeenCalled();
  expect(dialog()?.textContent).not.toContain('Give a reason');
  expect(dialog()?.textContent).toContain('Add a note for the record, up to 2,000 characters.');
  await mounted.unmount();
});

it('moves the lead to Lost with the trimmed reason and note and the visible version', async () => {
  mocks.changeLeadStage.mockResolvedValue({});
  const mounted = await open();
  await fill(inDialog('input[name="reason"]'), '  Chose another vendor ');
  await typeNote(' Went with a cheaper local supplier. ');
  await click(footerButton('Mark lost'));
  await settle();

  expect(mocks.changeLeadStage).toHaveBeenCalledExactlyOnceWith(expect.anything(), LEAD, {
    expectedVersion: 4,
    stage: 'lost',
    reason: 'Chose another vendor',
    note: 'Went with a cheaper local supplier.',
  });
  expect(mocks.success).toHaveBeenCalledWith('Moved to Lost.');
  expect(dialog()).toBeNull();
  await mounted.unmount();
});

it('keeps the dialog and the typed text, and offers a reload, when the lead changed meanwhile', async () => {
  mocks.changeLeadStage.mockRejectedValueOnce(
    new ApiError(409, 'stale', { error: { code: 'conflict', message: 'x', correlationId: 'c' } }),
  );
  const mounted = await open();
  await fill(inDialog('input[name="reason"]'), 'Chose another vendor');
  await typeNote('Went elsewhere.');
  await click(footerButton('Mark lost'));
  await settle();

  expect(mocks.success).not.toHaveBeenCalled();
  expect(mocks.error).toHaveBeenCalledOnce();
  const options = mocks.error.mock.calls[0]?.[1] as { action?: { label: string } } | undefined;
  expect(options?.action?.label).toBe('Reload');
  expect(dialog()).not.toBeNull();
  expect((inDialog('input[name="reason"]') as HTMLInputElement).value).toBe('Chose another vendor');
  await mounted.unmount();
});

it('opens clean after a cancelled attempt', async () => {
  const mounted = await open();
  await click(footerButton('Mark lost'));
  await settle();
  expect(dialog()?.textContent).toContain('Give a reason');

  await click(footerButton('Cancel'));
  await click(mounted.container.querySelector('button'));
  expect(dialog()?.textContent).not.toContain('Give a reason');
  expect((inDialog('input[name="reason"]') as HTMLInputElement).value).toBe('');
  await mounted.unmount();
});
