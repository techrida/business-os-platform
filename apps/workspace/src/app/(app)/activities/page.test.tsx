import type { ActivityDto } from '@bos/contracts';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, expect, it, vi } from 'vitest';

import { ApiError } from '@/lib/api';

vi.mock('server-only', () => ({}));
const mocks = vi.hoisted(() => ({
  listActivitiesPage: vi.fn(),
  listLeadOwners: vi.fn(),
  requireStaffSession: vi.fn(),
  getMe: vi.fn(),
}));
vi.mock('@/lib/bff', () => ({ requireStaffSession: mocks.requireStaffSession }));
// The live grants come from GET /v1/me; when it fails the page falls back to the role defaults.
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getMe: mocks.getMe,
}));
vi.mock('@/components/p2/crm/activities-api', () => ({
  listActivitiesPage: mocks.listActivitiesPage,
}));
vi.mock('@/components/p2/crm/crm-api', () => ({
  listLeadOwners: mocks.listLeadOwners,
}));
// The filter bar is a client component that needs the app router; it has its own test.
vi.mock('./filters', () => ({ ActivityFilters: () => null }));
vi.mock('@/app/(app)/leads/actions', () => ({
  completeFollowUpAction: vi.fn(),
  rescheduleFollowUpAction: vi.fn(),
  cancelFollowUpAction: vi.fn(),
  scheduleFollowUpAction: vi.fn(),
}));

import ActivitiesPage from './page';

const LEAD = '11111111-1111-4111-8111-111111111111';
const ALL = { complete: true, reschedule: true, cancel: true };
const NONE = { complete: false, reschedule: false, cancel: false };

function activity(id: string, over: Partial<ActivityDto> = {}): ActivityDto {
  return {
    id,
    kind: 'call',
    subject: `Activity ${id.slice(0, 1)}`,
    body: null,
    leadId: LEAD,
    opportunityId: null,
    customerId: null,
    contactId: null,
    quotationId: null,
    dueAt: null,
    assigneeUserId: null,
    assigneeName: null,
    completedAt: null,
    cancelledAt: null,
    planned: false,
    createdByUserId: null,
    createdByName: null,
    occurredAt: '2026-11-18T04:00:00.000Z',
    version: 1,
    // The API sends every row its flags; a planned one here allows everything unless a test says otherwise.
    can: over.planned === true ? ALL : NONE,
    ...over,
  };
}

const LATER = activity('22222222-2222-4222-8222-222222222222', {
  subject: 'Call back next month',
  dueAt: '2099-01-02T04:00:00.000Z',
  planned: true,
});
const OVERDUE = activity('33333333-3333-4333-8333-333333333333', {
  subject: 'Send the brochure',
  kind: 'email',
  dueAt: '2020-01-01T04:00:00.000Z',
  planned: true,
});
const DONE = activity('44444444-4444-4444-8444-444444444444', {
  subject: 'Site visit',
  kind: 'meeting',
  dueAt: '2026-11-17T04:00:00.000Z',
  completedAt: '2026-11-18T09:30:00.000Z',
});

function byStatus(planned: ActivityDto[], logged: ActivityDto[]) {
  mocks.listActivitiesPage.mockImplementation((_s: unknown, opts: { status: string }) => {
    const items = opts.status === 'planned' ? planned : logged;
    return Promise.resolve({ items, total: items.length });
  });
}

async function render(kind?: string, params: Record<string, string> = kind ? { kind } : {}) {
  const page = await ActivitiesPage({ searchParams: Promise.resolve(params) });
  return renderToStaticMarkup(page);
}

beforeEach(() => {
  mocks.requireStaffSession.mockReset().mockResolvedValue({ accessToken: 't', roles: ['sales'] });
  mocks.listActivitiesPage.mockReset();
  mocks.listLeadOwners.mockReset().mockResolvedValue([]);
  mocks.getMe.mockReset().mockRejectedValue(new Error('down'));
  byStatus([], []);
});

/** The live grants `/v1/me` reports, each at `all`. */
const liveGrants = (...permissions: string[]) => ({
  permissions: permissions.map((permission) => ({ permission, scope: 'all' })),
});

it('asks for planned and logged activities separately', async () => {
  await render('meeting');
  expect(mocks.listActivitiesPage).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({ kind: ['meeting'], status: 'planned', limit: 100 }),
  );
  expect(mocks.listActivitiesPage).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({ kind: ['meeting'], status: 'logged', limit: 25, offset: 0 }),
  );
});

it('does not offer or apply task as a filter', async () => {
  const html = await render('task');
  expect(html).not.toMatch(/value="task"/);
  for (const [, opts] of mocks.listActivitiesPage.mock.calls)
    expect(opts).toMatchObject({ kind: [] });
});

it('lists planned ones earliest due first with Planned and Overdue badges, logged ones with Done', async () => {
  byStatus([LATER, OVERDUE], [DONE]);
  const html = await render();
  expect(html.indexOf('Send the brochure')).toBeLessThan(html.indexOf('Call back next month'));
  expect(html).toContain('>Overdue<');
  expect(html).toContain('>Planned<');
  expect(html).toContain('>Done<');
  // The completed row is timed by its completion.
  expect(html).toContain('dateTime="2026-11-18T09:30:00.000Z"');
});

it('keeps the logged list when the planned one fails to load', async () => {
  mocks.listActivitiesPage.mockImplementation((_s: unknown, opts: { status: string }) =>
    opts.status === 'planned'
      ? Promise.reject(new ApiError(503, 'down'))
      : Promise.resolve({ items: [DONE], total: 1 }),
  );
  const html = await render();
  expect(html).toContain('Planned follow-ups did not load');
  expect(html).toContain('Site visit');
});

it('gives every planned row Complete, Reschedule and Cancel, whatever its subject', async () => {
  const onDeal = activity('55555555-5555-4555-8555-555555555555', {
    subject: 'Migrated task on the deal',
    leadId: null,
    opportunityId: '66666666-6666-4666-8666-666666666666',
    dueAt: '2099-02-01T04:00:00.000Z',
    planned: true,
  });
  byStatus([LATER, onDeal], [DONE]);
  const html = await render();
  for (const subject of ['Call back next month', 'Migrated task on the deal']) {
    for (const action of ['Complete', 'Reschedule', 'Cancel']) {
      expect(html).toContain(`aria-label="${action} ${subject}"`);
    }
  }
  // Logged rows stay read-only.
  expect(html).not.toContain('aria-label="Complete Site visit"');
});

it('asks for the owners list only with crm.lead.write, so a reader gets no 403', async () => {
  byStatus([{ ...LATER, can: NONE }], []);
  mocks.requireStaffSession.mockResolvedValue({ accessToken: 't', roles: ['no-such-role'] });
  const html = await render();
  expect(mocks.listLeadOwners).not.toHaveBeenCalled();
  // The API's flags allow nothing: no action it would refuse.
  expect(html).toContain('Call back next month');
  expect(html).not.toContain('aria-label="Complete Call back next month"');
  expect(html).not.toContain('aria-label="Reschedule Call back next month"');
});

// Each button follows its own flag from the API, never a guess from the caller's grants: the caller here
// holds crm.lead.write, which the old rule took as every action on a lead's follow-up.
const leadWriter = (id = '99999999-9999-4999-8999-999999999999') => ({
  id,
  ...liveGrants('customer.read', 'crm.lead.read', 'crm.lead.write'),
});
const plannedOn = (n: number, subject: string, over: Partial<ActivityDto> = {}) =>
  activity(
    `${n}${n}${n}${n}${n}${n}${n}${n}-${n}${n}${n}${n}-4${n}${n}${n}-8${n}${n}${n}-${String(n).repeat(12)}`,
    {
      subject,
      dueAt: `2099-02-0${n}T04:00:00.000Z`,
      planned: true,
      ...over,
    },
  );
const offered = (html: string, subject: string) =>
  ['Complete', 'Reschedule', 'Cancel'].filter((a) => html.includes(`aria-label="${a} ${subject}"`));

it("shows each action only when the row's own flag allows it", async () => {
  byStatus(
    [
      plannedOn(5, 'Only complete', { can: { ...NONE, complete: true } }),
      plannedOn(6, 'Only reschedule', { can: { ...NONE, reschedule: true } }),
      plannedOn(7, 'Only cancel', { can: { ...NONE, cancel: true } }),
      plannedOn(8, 'All but complete', { can: { ...ALL, complete: false } }),
    ],
    [],
  );
  mocks.getMe.mockResolvedValue(leadWriter());
  const html = await render();
  expect(offered(html, 'Only complete')).toEqual(['Complete']);
  expect(offered(html, 'Only reschedule')).toEqual(['Reschedule']);
  expect(offered(html, 'Only cancel')).toEqual(['Cancel']);
  expect(offered(html, 'All but complete')).toEqual(['Reschedule', 'Cancel']);
});

it('shows no action on a row without flags, with no fallback to the role', async () => {
  const ME = '99999999-9999-4999-8999-999999999999';
  const { can: _omitted, ...unflagged } = plannedOn(5, 'No flags here', {
    assigneeUserId: ME,
  });
  expect('can' in unflagged).toBe(false);
  byStatus([unflagged], []);
  mocks.getMe.mockResolvedValue(leadWriter(ME));
  const html = await render();
  expect(html).toContain('No flags here');
  expect(offered(html, 'No flags here')).toEqual([]);
});

it("shows no action on someone else's follow-up whose flags are all false (a Finance viewer)", async () => {
  byStatus(
    [
      plannedOn(5, 'Their customer call', {
        leadId: null,
        customerId: '66666666-6666-4666-8666-666666666666',
        assigneeUserId: '88888888-8888-4888-8888-888888888888',
        can: NONE,
      }),
      plannedOn(6, 'Their lead call', {
        assigneeUserId: '88888888-8888-4888-8888-888888888888',
        can: NONE,
      }),
    ],
    [],
  );
  mocks.getMe.mockResolvedValue(leadWriter());
  const html = await render();
  expect(html).toContain('Their customer call');
  expect(offered(html, 'Their customer call')).toEqual([]);
  expect(offered(html, 'Their lead call')).toEqual([]);
});

// U20a2-Q7: the API lets an assignee complete a follow-up on a subject they cannot write, and says so in
// the flags; Reschedule and Cancel stay hidden because their flags are false.
it("offers Complete alone where the flags allow only Complete (the assignee's own follow-up)", async () => {
  const ME = '99999999-9999-4999-8999-999999999999';
  byStatus(
    [
      plannedOn(5, 'Call the customer back', {
        leadId: null,
        customerId: '66666666-6666-4666-8666-666666666666',
        assigneeUserId: ME,
        assigneeName: 'Me',
        can: { ...NONE, complete: true },
      }),
      LATER,
    ],
    [],
  );
  mocks.getMe.mockResolvedValue(leadWriter(ME));
  const html = await render();
  expect(offered(html, 'Call the customer back')).toEqual(['Complete']);
  expect(offered(html, 'Call back next month')).toEqual(['Complete', 'Reschedule', 'Cancel']);
});

it('asks for the owners list when the saved grants add crm.lead.write to a role without it', async () => {
  byStatus([LATER], []);
  mocks.requireStaffSession.mockResolvedValue({ accessToken: 'live-1', roles: ['management'] });
  mocks.getMe.mockResolvedValue(liveGrants('crm.lead.read', 'crm.lead.write'));
  await render();
  expect(mocks.listLeadOwners).toHaveBeenCalledTimes(1);
});

it('skips the owners list when the saved grants removed crm.lead.write from sales', async () => {
  byStatus([{ ...LATER, can: NONE }], []);
  mocks.requireStaffSession.mockResolvedValue({ accessToken: 'live-2', roles: ['sales'] });
  mocks.getMe.mockResolvedValue(liveGrants('crm.lead.read'));
  const html = await render();
  expect(mocks.listLeadOwners).not.toHaveBeenCalled();
  // The row stays listed, and offers nothing its flags do not allow.
  expect(html).toContain('Call back next month');
  expect(html).not.toContain('aria-label="Reschedule Call back next month"');
});

it('shows one empty state when there is nothing at all', async () => {
  mocks.getMe.mockResolvedValue(liveGrants('crm.lead.read', 'crm.lead.write'));
  const html = await render();
  expect(html).toContain('No calls, meetings, emails or notes yet');
  expect(html).not.toContain('No activity yet');
  expect(html).toContain(
    'Open a lead or an opportunity, then log an activity or schedule a follow-up.',
  );
  expect(html).not.toContain('No follow-ups planned');
});

it('tells a viewer who may not log activities only what shows here', async () => {
  mocks.getMe.mockResolvedValue(liveGrants('crm.lead.read'));
  const html = await render();
  expect(html).toContain('No calls, meetings, emails or notes yet');
  expect(html).toContain('Activities logged on the leads and opportunities you can see show here.');
  expect(html).not.toContain('log an activity');
});

it('sends the due-day range to both lists, in order, and clears it with the other filters', async () => {
  const html = await render(undefined, { dueFrom: '2030-01-05', dueTo: '2030-01-01', rows: '50' });
  for (const [, opts] of mocks.listActivitiesPage.mock.calls)
    expect(opts).toMatchObject({ dueFrom: '2030-01-01', dueTo: '2030-01-05' });
  expect(html).toContain('No activities match');
  expect(html).toContain('Due from: ');
  expect(html).toContain('Due to: ');
  expect(html).toContain('href="/activities?rows=50"');
});

it('drops a malformed due day instead of sending it', async () => {
  await render(undefined, { dueFrom: '2030-02-30', dueTo: 'soon' });
  for (const [, opts] of mocks.listActivitiesPage.mock.calls) {
    expect(opts).not.toHaveProperty('dueFrom');
    expect(opts).not.toHaveProperty('dueTo');
  }
});
