import { beforeEach, expect, it, vi } from 'vitest';
import { getMe } from './api';
import { listUsers } from './api-admin';
import { userNames } from './business-labels';
import type { Session } from './session';

vi.mock('server-only', () => ({}));
vi.mock('./api-admin', () => ({ listUsers: vi.fn() }));
// The live grants come from GET /v1/me; when it fails the role defaults stand in.
vi.mock('./api', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getMe: vi.fn(),
}));
const session = { accessToken: 'test-token', roles: ['founder'] } as Session;
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getMe).mockRejectedValue(new Error('down'));
});
/** The live grants `/v1/me` reports, each at `all`. */
const liveGrants = (...permissions: string[]) =>
  ({ permissions: permissions.map((permission) => ({ permission, scope: 'all' })) }) as never;
it('resolves all directory pages as the caller and labels a blank name Unnamed user, never the address', async () => {
  vi.mocked(listUsers)
    .mockResolvedValueOnce({
      items: [
        { id: 'a', displayName: 'Mina', email: null },
        { id: 'b', displayName: null, email: 'b@example.test' },
        { id: 'c', displayName: null, email: null },
      ],
      nextAfter: 'b',
    } as never)
    .mockResolvedValueOnce({
      items: [{ id: 'd', displayName: 'Dev', email: null }],
      nextAfter: null,
    } as never);
  expect(await userNames(session)).toEqual(
    new Map([
      ['a', 'Mina'],
      ['b', 'Unnamed user'],
      ['c', 'Unnamed user'],
      ['d', 'Dev'],
    ]),
  );
  expect(listUsers).toHaveBeenNthCalledWith(2, session, { limit: 200, after: 'b' });
});
it('keeps business records usable when directory access is denied', async () => {
  vi.mocked(listUsers).mockRejectedValue(new Error('denied'));
  expect(await userNames(session)).toEqual(new Map());
});

it('skips the admin directory when resolving labels for Sales', async () => {
  expect(await userNames({ ...session, roles: ['sales'] })).toEqual(new Map());
  expect(listUsers).not.toHaveBeenCalled();
});

it('reads the directory for a role whose saved grants add admin.users.read, though its defaults lack it', async () => {
  vi.mocked(getMe).mockResolvedValue(liveGrants('admin.users.read'));
  vi.mocked(listUsers).mockResolvedValue({
    items: [{ id: 'a', displayName: 'Mina', email: null }],
    nextAfter: null,
  } as never);
  expect(await userNames({ ...session, accessToken: 'live-1', roles: ['sales'] })).toEqual(
    new Map([['a', 'Mina']]),
  );
});

it('skips the directory when the saved grants removed admin.users.read, though the defaults hold it', async () => {
  vi.mocked(getMe).mockResolvedValue(liveGrants('customer.read'));
  expect(await userNames({ ...session, accessToken: 'live-2' })).toEqual(new Map());
  expect(listUsers).not.toHaveBeenCalled();
});
