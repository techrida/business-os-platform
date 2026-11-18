import { expect, it, vi } from 'vitest';

import { apiFetch } from '@/lib/api';
import type { Session } from '@/lib/session';

import { listOpportunities } from './crm-api';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/api', () => ({ apiFetch: vi.fn() }));

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
