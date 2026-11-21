// @vitest-environment jsdom
import type { LeadOwnerOption } from '@bos/contracts';
import { act } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { ApiError } from '@/lib/api';
import { choose, click, fill, mountForm, pickDate } from '@/test/form-interactions';

vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/bff', () => ({
  requireStaffSession: vi.fn(() => Promise.resolve({ accessToken: 'test', roles: ['sales'] })),
}));
const mocks = vi.hoisted(() => ({
  createActivity: vi.fn(),
  rescheduleActivity: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
}));
vi.mock('@/components/p2/crm/crm-api', () => ({
  createActivity: mocks.createActivity,
  rescheduleActivity: mocks.rescheduleActivity,
}));
vi.mock('@/components/ui/toast', () => ({ toast: { success: mocks.success, error: mocks.error } }));

import { RescheduleFollowUpDialog, ScheduleFollowUpDialog } from './schedule-follow-up-dialog';

const LEAD = '11111111-1111-4111-8111-111111111111';
const ACTIVITY = '22222222-2222-4222-8222-222222222222';
const OWNER = '33333333-3333-4333-8333-333333333333';
const OTHER = '44444444-4444-4444-8444-444444444444';
const STRANGER = '55555555-5555-4555-8555-555555555555';
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const owners: LeadOwnerOption[] = [
  { userId: OWNER, displayName: 'Sita Rai', email: 'sita@example.com' },
  { userId: OTHER, displayName: 'Ram Thapa', email: 'ram@example.com' },
];

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

async function openSchedule(ownerUserId: string | null = OWNER) {
  const mounted = await mountForm(
    <ScheduleFollowUpDialog subjectId={LEAD} ownerUserId={ownerUserId} owners={owners} />,
  );
  await click(mounted.container.querySelector('button'));
  return mounted;
}

it('posts a planned email on the lead, defaulting the subject and the assignee to the owner', async () => {
  mocks.createActivity.mockResolvedValue({ id: ACTIVITY });
  const mounted = await openSchedule();
  await click(inDialog('[role="radio"][data-kind="email"]'));
  await pickDate(dialog()!, 'dueAt', '2026-11-20T10:30');
  await click(footerButton('Schedule'));
  await settle();

  expect(mocks.createActivity).toHaveBeenCalledExactlyOnceWith(
    expect.anything(),
    {
      kind: 'email',
      subject: 'Email',
      dueAt: '2026-11-20T10:30:00+05:45',
      assigneeUserId: OWNER,
      leadId: LEAD,
    },
    expect.stringMatching(UUID_SHAPE),
  );
  expect(mocks.success).toHaveBeenCalledWith('Follow-up scheduled.');
  expect(dialog()).toBeNull();
  await mounted.unmount();
});

it('sends the chosen assignee, subject and note', async () => {
  mocks.createActivity.mockResolvedValue({ id: ACTIVITY });
  const mounted = await openSchedule();
  await fill(inDialog('input[name="subject"]'), 'Site visit plan');
  await pickDate(dialog()!, 'dueAt', '2026-11-21T14:00');
  await choose(document.body, 'assigneeUserId', 'Ram Thapa');
  const note = inDialog('textarea[name="body"]') as HTMLTextAreaElement;
  note.value = 'Bring the drawings.';
  await click(footerButton('Schedule'));
  await settle();

  expect(mocks.createActivity.mock.calls[0]?.[1]).toEqual({
    kind: 'call',
    subject: 'Site visit plan',
    body: 'Bring the drawings.',
    dueAt: '2026-11-21T14:00:00+05:45',
    assigneeUserId: OTHER,
    leadId: LEAD,
  });
  await mounted.unmount();
});

it('leaves the assignee to the API when the owner is not someone the caller can pick', async () => {
  mocks.createActivity.mockResolvedValue({ id: ACTIVITY });
  const mounted = await openSchedule(STRANGER);
  await pickDate(dialog()!, 'dueAt', '2026-11-20T10:30');
  await click(footerButton('Schedule'));
  await settle();
  expect(mocks.createActivity.mock.calls[0]?.[1]).not.toHaveProperty('assigneeUserId');
  await mounted.unmount();
});

it('plans a follow-up on an opportunity, leaving it to the deal owner when they are not a choice (U16-Q6)', async () => {
  const DEAL = '66666666-6666-4666-8666-666666666666';
  mocks.createActivity.mockResolvedValue({ id: ACTIVITY });
  const mounted = await mountForm(
    <ScheduleFollowUpDialog
      subjectKind="opportunityId"
      subjectId={DEAL}
      ownerUserId={STRANGER}
      owners={owners.map((o) => ({ ...o, email: '' }))}
    />,
  );
  await click(mounted.container.querySelector('button'));
  expect(dialog()?.textContent).toContain('Opportunity owner');
  expect(dialog()?.textContent).not.toContain('Lead owner');
  await pickDate(dialog()!, 'dueAt', '2026-11-22T09:00');
  await click(footerButton('Schedule'));
  await settle();
  expect(mocks.createActivity).toHaveBeenCalledExactlyOnceWith(
    expect.anything(),
    { kind: 'call', subject: 'Call', dueAt: '2026-11-22T09:00:00+05:45', opportunityId: DEAL },
    expect.stringMatching(UUID_SHAPE),
  );
  expect(mocks.success).toHaveBeenCalledWith('Follow-up scheduled.');
  await mounted.unmount();
});

it('says the follow-up goes to the person scheduling it when the record has no owner', async () => {
  const mounted = await mountForm(
    <ScheduleFollowUpDialog
      subjectKind="opportunityId"
      subjectId={LEAD}
      ownerUserId={null}
      owners={owners}
    />,
  );
  await click(mounted.container.querySelector('button'));
  expect(dialog()?.textContent).toContain('Me');
  expect(dialog()?.textContent).not.toContain('Opportunity owner');
  await mounted.unmount();
});

it('shows a refusal next to the field, stays open, and starts clean when opened again', async () => {
  const mounted = await openSchedule();
  await click(footerButton('Schedule'));
  await settle();

  expect(mocks.createActivity).not.toHaveBeenCalled();
  expect(dialog()?.textContent).toContain('Choose when the follow-up is due.');
  // The date and time fields are React Aria's, which mark the invalid state with data-invalid.
  const due = inDialog('input[name="dueAt"]')?.parentElement;
  expect(due?.querySelector('[data-invalid]')).not.toBeNull();

  await click(footerButton('Cancel'));
  expect(dialog()).toBeNull();
  await click(mounted.container.querySelector('button'));
  expect(dialog()?.textContent).not.toContain('Choose when the follow-up is due.');
  await mounted.unmount();
});

it('keeps the same key for a retry after an unknown outcome, and shows the failure in the dialog', async () => {
  mocks.createActivity.mockRejectedValueOnce(new ApiError(503, 'down'));
  mocks.createActivity.mockResolvedValueOnce({ id: ACTIVITY });
  const mounted = await openSchedule();
  await pickDate(dialog()!, 'dueAt', '2026-11-20T10:30');
  await click(footerButton('Schedule'));
  await settle();
  expect(inDialog('[role="alert"]')).not.toBeNull();

  await click(footerButton('Schedule'));
  await settle();
  const [first, second] = mocks.createActivity.mock.calls.map((c) => c[2] as string);
  expect(second).toBe(first);
  await mounted.unmount();
});

it('reschedules from the current Kathmandu time and keeps an unlisted assignee unless changed', async () => {
  mocks.rescheduleActivity.mockResolvedValue({});
  const mounted = await mountForm(
    <RescheduleFollowUpDialog
      leadId={LEAD}
      owners={owners}
      item={{
        id: ACTIVITY,
        subject: 'Call back',
        dueAt: '2026-11-20T04:45:00.000Z',
        assigneeUserId: STRANGER,
        version: 3,
      }}
      trigger={<button type="button">Reschedule</button>}
    />,
  );
  await click(mounted.container.querySelector('button'));
  const due = inDialog('input[name="dueAt"]') as HTMLInputElement;
  expect(due.value).toBe('2026-11-20T10:30');

  await pickDate(dialog()!, 'dueAt', '2026-11-22T09:00');
  await click(footerButton('Reschedule'));
  await settle();

  expect(mocks.rescheduleActivity).toHaveBeenCalledExactlyOnceWith(expect.anything(), ACTIVITY, {
    expectedVersion: 3,
    dueAt: '2026-11-22T09:00:00+05:45',
  });
  expect(mocks.success).toHaveBeenCalledWith('Follow-up rescheduled.');
  await mounted.unmount();
});
