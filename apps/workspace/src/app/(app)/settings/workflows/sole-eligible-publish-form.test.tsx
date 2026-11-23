// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { mountForm, submit } from '@/test/form-interactions';

import type { ActionState } from '../action-state';
import { SoleEligiblePublishForm } from './panels';

vi.mock('./actions', () => ({}));

type Action = (previous: ActionState, form: FormData) => Promise<ActionState>;
const publish = vi.fn<Action>();

let mounted: Awaited<ReturnType<typeof mountForm>> | undefined;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  publish.mockResolvedValue({ status: 'ok', message: 'Version 2 is published.' });
});
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
  document.body.innerHTML = '';
  vi.clearAllMocks();
});

const mount = async () => {
  mounted = await mountForm(
    <SoleEligiblePublishForm action={publish} fields={{ key: 'invoice-approval', version: '2' }} />,
  );
  return mounted.container;
};

it('shows an error on the empty publish reason and does not call the action', async () => {
  const container = await mount();
  await submit(container);
  expect(publish).not.toHaveBeenCalled();
  expect(container.textContent).toContain('Enter a reason for publishing.');
  expect(container.querySelector('textarea[name="reason"]')?.getAttribute('aria-invalid')).toBe(
    'true',
  );
});

it('publishes once a reason is typed', async () => {
  const container = await mount();
  await submit(container);
  const reason = container.querySelector('textarea[name="reason"]');
  if (!(reason instanceof HTMLTextAreaElement)) throw new Error('Missing reason box');
  reason.value = 'Only approver available';
  await submit(container);
  expect(publish).toHaveBeenCalledOnce();
  expect(publish.mock.calls[0]![1].get('reason')).toBe('Only approver available');
});
