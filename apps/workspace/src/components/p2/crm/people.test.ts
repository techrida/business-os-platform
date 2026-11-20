import { beforeEach, expect, it, vi } from 'vitest';

import { getMe } from '@/lib/api';

import { canAssignFollowUps } from './people';

// `server-only` throws outside the react-server condition, which Vitest does not use.
vi.mock('server-only', () => ({}));
vi.mock('./crm-api', () => ({ listLeadOwners: vi.fn() }));
// The live grants come from GET /v1/me; when it fails the role defaults stand in.
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getMe: vi.fn(),
}));

/** The live grants `/v1/me` reports, each at `all`. */
const liveGrants = (...permissions: string[]) =>
  ({ permissions: permissions.map((permission) => ({ permission, scope: 'all' })) }) as never;

let token = 0;
/** A new token per call: `getMeOrNull` is a React `cache` keyed on it. */
const session = (roles: string[]) => ({ accessToken: `tok-${++token}`, roles });

beforeEach(() => {
  vi.mocked(getMe).mockReset();
});

it('follows a crm.lead.write grant the saved rows add to a role whose defaults lack it', async () => {
  vi.mocked(getMe).mockResolvedValue(liveGrants('crm.lead.read', 'crm.lead.write'));
  expect(await canAssignFollowUps(session(['management']))).toBe(true);
});

it('follows a crm.lead.write grant the saved rows removed from a role whose defaults hold it', async () => {
  vi.mocked(getMe).mockResolvedValue(liveGrants('crm.lead.read'));
  expect(await canAssignFollowUps(session(['sales']))).toBe(false);
});

it('falls back to the role defaults only when the live read fails', async () => {
  vi.mocked(getMe).mockRejectedValue(new Error('down'));
  expect(await canAssignFollowUps(session(['sales']))).toBe(true);
  expect(await canAssignFollowUps(session(['management']))).toBe(false);
});
