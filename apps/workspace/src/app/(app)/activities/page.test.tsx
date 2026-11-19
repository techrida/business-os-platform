import type { ActivityDto } from '@bos/contracts';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, expect, it, vi } from 'vitest';

import { ApiError } from '@/lib/api';

vi.mock('server-only', () => ({}));
const mocks = vi.hoisted(() => ({
  listActivities: vi.fn(),
  listLeadOwners: vi.fn(),
  requireStaffSession: vi.fn(),
}));
vi.mock('@/lib/bff', () => ({ requireStaffSession: mocks.requireStaffSession }));
vi.mock('@/components/p2/crm/crm-api', () => ({
  listActivities: mocks.listActivities,
  listLeadOwners: mocks.listLeadOwners,
}));
vi.mock('@/app/(app)/leads/actions', () => ({
  completeFollowUpAction: vi.fn(),
  rescheduleFollowUpAction: vi.fn(),
  cancelFollowUpAction: vi.fn(),
  scheduleFollowUpAction: vi.fn(),
}));

import ActivitiesPage from './page';

const LEAD = '11111111-1111-4111-8111-111111111111';

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
  mocks.listActivities.mockImplementation((_s: unknown, opts: { status: string }) =>
    Promise.resolve(opts.status === 'planned' ? planned : logged),
  );
}

async function render(kind?: string) {
  const page = await ActivitiesPage({ searchParams: Promise.resolve(kind ? { kind } : {}) });
  return renderToStaticMarkup(page);
}

beforeEach(() => {
  mocks.requireStaffSession.mockReset().mockResolvedValue({ accessToken: 't', roles: ['sales'] });
  mocks.listActivities.mockReset();
  mocks.listLeadOwners.mockReset().mockResolvedValue([]);
  byStatus([], []);
});

it('asks for planned and logged activities separately', async () => {
  await render('meeting');
  expect(mocks.listActivities).toHaveBeenCalledWith(expect.anything(), {
    kind: 'meeting',
    status: 'planned',
    limit: 100,
  });
  expect(mocks.listActivities).toHaveBeenCalledWith(expect.anything(), {
    kind: 'meeting',
    status: 'logged',
    limit: 100,
  });
});

it('does not offer or apply task as a filter', async () => {
  const html = await render('task');
  expect(html).not.toMatch(/value="task"/);
  for (const [, opts] of mocks.listActivities.mock.calls) expect(opts).not.toHaveProperty('kind');
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
  mocks.listActivities.mockImplementation((_s: unknown, opts: { status: string }) =>
    opts.status === 'planned' ? Promise.reject(new ApiError(503, 'down')) : Promise.resolve([DONE]),
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
  byStatus([LATER], []);
  mocks.requireStaffSession.mockResolvedValue({ accessToken: 't', roles: ['no-such-role'] });
  const html = await render();
  expect(mocks.listLeadOwners).not.toHaveBeenCalled();
  expect(html).toContain('aria-label="Reschedule Call back next month"');
});

it('shows one empty state when there is nothing at all', async () => {
  const html = await render();
  expect(html).toContain('No activity yet');
  expect(html).not.toContain('No follow-ups planned');
});
