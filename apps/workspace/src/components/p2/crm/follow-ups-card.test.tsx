// @vitest-environment jsdom
import { avatarColour, imagePath, type ActivityDto, type LeadOwnerOption } from '@bos/contracts';
import { act } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { ApiError } from '@/lib/api';
import { click, mountForm } from '@/test/form-interactions';

vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/bff', () => ({
  requireStaffSession: vi.fn(() => Promise.resolve({ accessToken: 'test', roles: ['sales'] })),
}));
const mocks = vi.hoisted(() => ({
  completeActivity: vi.fn(),
  cancelActivity: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
}));
vi.mock('@/components/p2/crm/crm-api', () => ({
  completeActivity: mocks.completeActivity,
  cancelActivity: mocks.cancelActivity,
  createActivity: vi.fn(),
  rescheduleActivity: vi.fn(),
}));
vi.mock('@/components/ui/toast', () => ({ toast: { success: mocks.success, error: mocks.error } }));

import { assigneeAvatar, FollowUpsCard, sortFollowUps } from './follow-ups-card';

const LEAD = '11111111-1111-4111-8111-111111111111';
const OWNER = '33333333-3333-4333-8333-333333333333';
const STRANGER = '55555555-5555-4555-8555-555555555555';
const NOW = new Date('2026-11-19T12:00:00.000Z');
const ALL = { complete: true, reschedule: true, cancel: true };
const NONE = { complete: false, reschedule: false, cancel: false };

const owners: LeadOwnerOption[] = [
  { userId: OWNER, displayName: 'Sita Rai', email: 'sita@example.com' },
];

function activity(n: number, over: Partial<ActivityDto>): ActivityDto {
  return {
    id: `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, '0')}`,
    kind: 'call',
    subject: `Follow-up ${n}`,
    body: null,
    leadId: LEAD,
    opportunityId: null,
    customerId: null,
    contactId: null,
    quotationId: null,
    dueAt: '2026-11-25T04:15:00.000Z',
    assigneeUserId: OWNER,
    assigneeName: 'Sita Rai',
    completedAt: null,
    cancelledAt: null,
    planned: true,
    createdByUserId: OWNER,
    createdByName: 'Sita Rai',
    occurredAt: '2026-11-19T04:15:00.000Z',
    version: 2,
    can: ALL,
    ...over,
  };
}

const later = activity(1, { subject: 'Send revised quote', kind: 'email' });
const overdue = activity(2, { subject: 'Call about the site', dueAt: '2026-11-18T04:15:00.000Z' });
const soon = activity(3, {
  subject: 'Plan the meeting',
  kind: 'meeting',
  dueAt: '2026-11-20T04:15:00.000Z',
  assigneeUserId: STRANGER,
  assigneeName: 'Mira Thapa',
});
const done = activity(4, {
  subject: 'Already done',
  planned: false,
  completedAt: NOW.toISOString(),
});

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

async function settle() {
  for (let i = 0; i < 3; i += 1) await act(() => Promise.resolve());
}

const mount = (items: ActivityDto[]) =>
  mountForm(
    <FollowUpsCard leadId={LEAD} items={items} ownerUserId={OWNER} owners={owners} now={NOW} />,
  );
const rows = (root: ParentNode) => [...root.querySelectorAll('li')];
const button = (root: ParentNode, label: string) =>
  root.querySelector(`button[aria-label="${label}"]`);

it('lists only planned follow-ups, earliest first, and marks the overdue one', async () => {
  const mounted = await mount([later, done, soon, overdue]);
  const list = rows(mounted.container);
  expect(list.map((li) => li.querySelector('p')?.textContent)).toEqual([
    'Call: Call about the site',
    'Meeting: Plan the meeting',
    'Email: Send revised quote',
  ]);
  expect(list.map((li) => li.dataset['overdue'])).toEqual(['true', 'false', 'false']);
  expect(list[0]?.textContent).toContain('Overdue');
  expect(list[1]?.textContent).not.toContain('Overdue');
  expect(list[0]?.querySelector('time')?.getAttribute('dateTime')).toBe(overdue.dueAt);
  await mounted.unmount();
});

it('labels a collection call as such', async () => {
  const call = activity(9, { kind: 'collection_call', subject: 'Collect payment for INV-1' });
  const mounted = await mount([call]);
  expect(rows(mounted.container)[0]?.querySelector('p')?.textContent).toBe(
    'Collection call: Collect payment for INV-1',
  );
  await mounted.unmount();
});

it('sorts a row without a due time last', () => {
  const undated = activity(5, { dueAt: null });
  expect(sortFollowUps([undated, later, soon]).map((a) => a.id)).toEqual([
    soon.id,
    later.id,
    undated.id,
  ]);
});

it("shows the assignee by the record's own name with initials, whoever the owners list holds", async () => {
  const mounted = await mount([soon, later]);
  const [first, second] = rows(mounted.container);
  expect(first?.textContent).toContain('Mira Thapa');
  expect(first?.textContent).not.toContain('Another teammate');
  expect(second?.textContent).toContain('Sita Rai');
  expect(second?.querySelector('[aria-hidden="true"]')?.textContent).toBe('SR');
  await mounted.unmount();
});

it("shows the assignee's picture over the colour seeded from their user id", async () => {
  const assignee = '9f1c2e4a-6b7d-4e8f-a1b2-c3d4e5f60718';
  const picture = '66666666-6666-4666-8666-666666666666';
  // The id must not land on the unseeded colour, or this check would pass without a seed.
  expect(avatarColour(assignee)).not.toBe(avatarColour(null));
  const mounted = await mountForm(
    <FollowUpsCard
      leadId={LEAD}
      items={[activity(5, { assigneeUserId: assignee })]}
      ownerUserId={OWNER}
      owners={[
        {
          userId: assignee,
          displayName: 'Asha Gurung',
          email: 'asha@example.com',
          avatarDocumentId: picture,
        },
      ]}
      now={NOW}
    />,
  );
  const avatar = rows(mounted.container)[0]?.querySelector<HTMLElement>('[aria-hidden="true"]');
  expect(avatar?.style.getPropertyValue('--avatar-fill')).toBe(avatarColour(assignee));
  expect(avatar?.querySelector('img')?.getAttribute('src')).toBe(imagePath(picture));
  await mounted.unmount();
});

it('seeds the assignee avatar from their user id, with the picture the owners list carries', () => {
  const picture = '66666666-6666-4666-8666-666666666666';
  const withPicture = [{ ...owners[0]!, avatarDocumentId: picture }];
  expect(assigneeAvatar({ assigneeUserId: OWNER }, withPicture)).toEqual({
    seedId: OWNER,
    imageDocumentId: picture,
  });
  expect(assigneeAvatar({ assigneeUserId: STRANGER }, withPicture)).toEqual({
    seedId: STRANGER,
    imageDocumentId: null,
  });
  expect(assigneeAvatar({ assigneeUserId: null }, withPicture)).toEqual({
    seedId: null,
    imageDocumentId: null,
  });
});

it('shows an empty state and still offers Schedule follow-up', async () => {
  const mounted = await mount([done]);
  expect(rows(mounted.container)).toHaveLength(0);
  expect(mounted.container.textContent).toContain('No follow-ups planned');
  const schedule = [...mounted.container.querySelectorAll('button')].find(
    (b) => b.textContent === 'Schedule follow-up',
  );
  expect(schedule).toBeDefined();
  await mounted.unmount();
});

it('completes a follow-up in one click with its version and confirms with a toast', async () => {
  mocks.completeActivity.mockResolvedValue({});
  const mounted = await mount([overdue]);
  await click(button(mounted.container, 'Complete Call about the site'));
  await settle();
  expect(mocks.completeActivity).toHaveBeenCalledExactlyOnceWith(expect.anything(), overdue.id, {
    expectedVersion: 2,
  });
  expect(mocks.success).toHaveBeenCalledWith('Follow-up marked done.');
  await mounted.unmount();
});

it('offers a reload when completing finds the follow-up already changed', async () => {
  mocks.completeActivity.mockRejectedValue(
    new ApiError(409, 'x', { error: { code: 'conflict', message: 'x', correlationId: 'c' } }),
  );
  const mounted = await mount([overdue]);
  await click(button(mounted.container, 'Complete Call about the site'));
  await settle();
  expect(mocks.success).not.toHaveBeenCalled();
  expect(mocks.error).toHaveBeenCalledTimes(1);
  await mounted.unmount();
});

it('cancels only after the confirm dialog, whose buttons do not both say Cancel', async () => {
  mocks.cancelActivity.mockResolvedValue({});
  const mounted = await mount([later]);
  await click(button(mounted.container, 'Cancel Send revised quote'));
  const footer = [...document.querySelectorAll('[role="dialog"] footer button')];
  expect(footer.map((b) => b.textContent)).toEqual(['Keep follow-up', 'Cancel follow-up']);

  await click(footer[0] ?? null);
  expect(mocks.cancelActivity).not.toHaveBeenCalled();

  await click(button(mounted.container, 'Cancel Send revised quote'));
  const confirm = [...document.querySelectorAll('[role="dialog"] footer button')].find(
    (b) => b.textContent === 'Cancel follow-up',
  );
  await click(confirm ?? null);
  await settle();
  expect(mocks.cancelActivity).toHaveBeenCalledExactlyOnceWith(expect.anything(), later.id, {
    expectedVersion: 2,
  });
  expect(mocks.success).toHaveBeenCalledWith('Follow-up cancelled.');
  await mounted.unmount();
});

const labels = (root: ParentNode, subject: string) =>
  ['Complete', 'Reschedule', 'Cancel'].filter((a) => button(root, `${a} ${subject}`) !== null);

it("shows each of Complete, Reschedule and Cancel only when the row's own flag allows it", async () => {
  const items = [
    activity(11, { subject: 'Only complete', can: { ...NONE, complete: true } }),
    activity(12, { subject: 'Only reschedule', can: { ...NONE, reschedule: true } }),
    activity(13, { subject: 'Only cancel', can: { ...NONE, cancel: true } }),
    activity(14, { subject: 'Not complete', can: { ...ALL, complete: false } }),
  ];
  // canEdit is the default true, the old rule's grant of every action: the flags win.
  const mounted = await mount(items);
  expect(labels(mounted.container, 'Only complete')).toEqual(['Complete']);
  expect(labels(mounted.container, 'Only reschedule')).toEqual(['Reschedule']);
  expect(labels(mounted.container, 'Only cancel')).toEqual(['Cancel']);
  expect(labels(mounted.container, 'Not complete')).toEqual(['Reschedule', 'Cancel']);
  await mounted.unmount();
});

it('shows no action on a row without flags, even to an editor who is its assignee', async () => {
  const { can: _omitted, ...unflagged } = activity(15, { subject: 'No flags' });
  expect('can' in unflagged).toBe(false);
  const mounted = await mountForm(
    <FollowUpsCard
      leadId={LEAD}
      items={[unflagged]}
      ownerUserId={OWNER}
      owners={owners}
      canEdit
      currentUserId={OWNER}
      now={NOW}
    />,
  );
  expect(rows(mounted.container)[0]?.textContent).toContain('No flags');
  expect(labels(mounted.container, 'No flags')).toEqual([]);
  expect(rows(mounted.container)[0]?.querySelector('button')).toBeNull();
  await mounted.unmount();
});

it("shows no action on someone else's follow-up whose flags are all false (a Finance viewer)", async () => {
  const mounted = await mountForm(
    <FollowUpsCard
      leadId={LEAD}
      items={[activity(16, { subject: 'Their call', assigneeUserId: STRANGER, can: NONE })]}
      ownerUserId={OWNER}
      owners={owners}
      currentUserId={OWNER}
      now={NOW}
    />,
  );
  expect(labels(mounted.container, 'Their call')).toEqual([]);
  expect(rows(mounted.container)[0]?.querySelector('button')).toBeNull();
  await mounted.unmount();
});

it("without write access, still follows the flags: Complete alone on the caller's own follow-up", async () => {
  const mounted = await mountForm(
    <FollowUpsCard
      leadId={LEAD}
      items={[
        { ...overdue, can: { ...NONE, complete: true } },
        { ...soon, can: NONE },
      ]}
      ownerUserId={OWNER}
      owners={owners}
      canEdit={false}
      currentUserId={OWNER}
      now={NOW}
    />,
  );
  expect(labels(mounted.container, 'Call about the site')).toEqual(['Complete']);
  // Assigned to someone else: nothing at all.
  expect(labels(mounted.container, 'Plan the meeting')).toEqual([]);
  // Scheduling a new one still follows canEdit.
  expect(mounted.container.textContent).not.toContain('Schedule follow-up');
  await mounted.unmount();
});
