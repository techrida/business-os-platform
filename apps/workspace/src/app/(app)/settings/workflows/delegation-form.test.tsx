// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { choose, mountForm, pickDate, submit } from '@/test/form-interactions';

import type { ActionState } from '../action-state';
import { DelegationForm } from './panels';

type Action = (previous: ActionState, form: FormData) => Promise<ActionState>;
const actions = vi.hoisted(() => ({ createDelegationAction: vi.fn<Action>() }));
vi.mock('./actions', () => ({
  addMemberAction: vi.fn(),
  createGroupAction: vi.fn(),
  createDelegationAction: actions.createDelegationAction,
}));

const USERS = [
  { id: 'u-mina', label: 'Mina', name: 'Mina', email: null },
  { id: 'u-ravi', label: 'Ravi', name: 'Ravi', email: null },
];

let mounted: Awaited<ReturnType<typeof mountForm>> | undefined;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
  document.body.innerHTML = '';
  vi.clearAllMocks();
});

const hidden = (name: string) =>
  mounted!.container.querySelector<HTMLInputElement>(`input[type="hidden"][name="${name}"]`)?.value;

it('posts the delegation times from the app picker and keeps them after a refused submit', async () => {
  actions.createDelegationAction.mockImplementation((_previous, form) =>
    Promise.resolve({
      status: 'error',
      message: 'The end must be after the start.',
      fields: Object.fromEntries(
        [...form.entries()].map(([k, v]) => [k, typeof v === 'string' ? v : v.name]),
      ),
    }),
  );
  mounted = await mountForm(<DelegationForm users={USERS} documentTypes={[]} />);
  const { container } = mounted;

  // The app's date-and-time picker, not the browser's datetime-local box (UIP-FORM-004).
  expect(container.querySelector('input[type="datetime-local"]')).toBeNull();

  await choose(container, 'fromUserId', 'Mina');
  await choose(container, 'toUserId', 'Ravi');
  await pickDate(container, 'startsAt', '2026-12-01T09:30');
  await pickDate(container, 'endsAt', '2026-11-30T17:00');
  await submit(container);

  expect(actions.createDelegationAction).toHaveBeenCalledOnce();
  const sent = actions.createDelegationAction.mock.calls[0]![1];
  // The `YYYY-MM-DDTHH:mm` string the native box posted, which kathmanduLocalToIso reads.
  expect(sent.get('startsAt')).toBe('2026-12-01T09:30');
  expect(sent.get('endsAt')).toBe('2026-11-30T17:00');
  expect(container.textContent).toContain('The end must be after the start.');

  // React resets the form after the action; the typed times stay for the user to correct.
  expect(hidden('startsAt')).toBe('2026-12-01T09:30');
  expect(hidden('endsAt')).toBe('2026-11-30T17:00');
  const shown = (name: string, type: string) =>
    container
      .querySelector(`input[name="${name}"]`)
      ?.parentElement?.querySelector(`[data-type="${type}"]`)?.textContent;
  expect(shown('startsAt', 'day')).toBe('1');
  expect(shown('startsAt', 'minute')).toBe('30');
  expect(shown('endsAt', 'day')).toBe('30');
  expect(shown('endsAt', 'hour')).toBe('5');
});

it('does not submit while a required delegation time is missing', async () => {
  mounted = await mountForm(<DelegationForm users={USERS} documentTypes={[]} />);
  const { container } = mounted;
  await choose(container, 'fromUserId', 'Mina');
  await choose(container, 'toUserId', 'Ravi');
  await pickDate(container, 'startsAt', '2026-12-01T09:30');
  await submit(container);
  expect(actions.createDelegationAction).not.toHaveBeenCalled();
});
