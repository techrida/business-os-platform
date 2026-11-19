import { expect, it, vi } from 'vitest';

import { apiFetch } from '@/lib/api';
import type { Session } from '@/lib/session';

import {
  cancelActivity,
  completeActivity,
  listActivities,
  listLeadOwners,
  listOpportunities,
  ownerFilterNames,
  rescheduleActivity,
  updateLead,
} from './crm-api';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/api', () => ({
  apiFetch: vi.fn(),
  ApiError: class ApiError extends Error {
    constructor(
      readonly status: number,
      message: string,
      readonly body?: unknown,
    ) {
      super(message);
    }
  },
}));

const session: Session = {
  id: 'session',
  sub: 'user',
  orgId: 'organization',
  orgKind: 'staff',
  roles: ['sales'],
  accessToken: 'test-token',
  accessExp: 2_000_000_000,
  createdAt: 1_700_000_000,
  lastSeenAt: 1_700_000_000,
};

it('serializes selected stages as repeated parameters and preserves single-stage queries', async () => {
  vi.mocked(apiFetch).mockImplementation(() => Promise.resolve(Response.json([])));

  await listOpportunities(session, {
    stage: ['qualified', 'negotiation'],
    q: 'North & West',
    limit: 2,
  });
  expect(apiFetch).toHaveBeenLastCalledWith(
    session,
    '/v1/opportunities?stage=qualified&stage=negotiation&q=North+%26+West&limit=2',
    undefined,
  );

  await listOpportunities(session, { stage: 'qualified' });
  expect(apiFetch).toHaveBeenLastCalledWith(
    session,
    '/v1/opportunities?stage=qualified',
    undefined,
  );

  await listOpportunities(session, { stage: [] });
  expect(apiFetch).toHaveBeenLastCalledWith(session, '/v1/opportunities', undefined);
});

const ACTIVITY = {
  id: '3f2b8c1e-4d5a-4b6c-8d7e-9f0a1b2c3d4e',
  kind: 'call',
  subject: 'Call',
  body: null,
  leadId: '9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d',
  opportunityId: null,
  customerId: null,
  contactId: null,
  quotationId: null,
  dueAt: '2026-11-20T09:00:00+05:45',
  assigneeUserId: null,
  assigneeName: null,
  completedAt: null,
  cancelledAt: null,
  planned: true,
  createdByUserId: null,
  createdByName: null,
  occurredAt: '2026-11-19T09:00:00+05:45',
  version: 2,
};

it('lists lead owners and validates each option', async () => {
  const owner = {
    userId: '9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d',
    displayName: 'Sunita Shrestha',
    email: 'sunita@example.com',
  };
  vi.mocked(apiFetch).mockImplementation(() => Promise.resolve(Response.json([owner])));
  await expect(listLeadOwners(session)).resolves.toEqual([owner]);
  expect(apiFetch).toHaveBeenLastCalledWith(session, '/v1/leads/owners', undefined);

  vi.mocked(apiFetch).mockImplementation(() =>
    Promise.resolve(Response.json([{ userId: 'nope' }])),
  );
  await expect(listLeadOwners(session)).rejects.toMatchObject({ status: 502 });
});

it('names the Owner filter people from the area owner-filter route, with Unnamed user for a blank name', async () => {
  const people = [
    { userId: '9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d', displayName: 'Sunita Shrestha', email: '' },
    { userId: '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5e', displayName: ' ', email: '' },
  ];
  vi.mocked(apiFetch).mockImplementation(() => Promise.resolve(Response.json(people)));
  const names = await ownerFilterNames(session, 'opportunities');
  expect(apiFetch).toHaveBeenLastCalledWith(session, '/v1/opportunities/owner-filter', undefined);
  expect([...names.values()]).toEqual(['Sunita Shrestha', 'Unnamed user']);

  vi.mocked(apiFetch).mockImplementation(() => Promise.resolve(Response.json({ nope: 1 })));
  expect((await ownerFilterNames(session, 'leads')).size).toBe(0);
});

it('patches the lead with the owner and version', async () => {
  vi.mocked(apiFetch).mockImplementation(() => Promise.resolve(Response.json({})));
  const body = { ownerUserId: '9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d', expectedVersion: 3 };
  await expect(updateLead(session, 'lead/1', body)).rejects.toMatchObject({ status: 502 });
  expect(apiFetch).toHaveBeenLastCalledWith(session, '/v1/leads/lead%2F1', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
});

it('filters activities by status', async () => {
  vi.mocked(apiFetch).mockImplementation(() => Promise.resolve(Response.json([ACTIVITY])));
  await expect(
    listActivities(session, { leadId: ACTIVITY.leadId, status: 'planned' }),
  ).resolves.toHaveLength(1);
  expect(apiFetch).toHaveBeenLastCalledWith(
    session,
    `/v1/activities?leadId=${ACTIVITY.leadId}&status=planned`,
    undefined,
  );
});

it('completes, reschedules and cancels through their own PATCH routes', async () => {
  vi.mocked(apiFetch).mockImplementation(() => Promise.resolve(Response.json(ACTIVITY)));
  const cases = [
    [completeActivity, 'complete', { expectedVersion: 2, note: 'Done' }],
    [rescheduleActivity, 'reschedule', { expectedVersion: 2, dueAt: '2026-11-21T10:00:00+05:45' }],
    [cancelActivity, 'cancel', { expectedVersion: 2 }],
  ] as const;
  for (const [fn, action, body] of cases) {
    // Each wrapper takes its own body type; the tuple keeps them paired.
    await expect(
      (fn as (s: Session, id: string, b: unknown) => Promise<unknown>)(session, ACTIVITY.id, body),
    ).resolves.toMatchObject({ id: ACTIVITY.id });
    expect(apiFetch).toHaveBeenLastCalledWith(session, `/v1/activities/${ACTIVITY.id}/${action}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }
});
