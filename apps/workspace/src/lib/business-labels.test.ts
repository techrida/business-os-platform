import { beforeEach, expect, it, vi } from 'vitest';
import { listUsers } from './api-admin';
import { userNames } from './business-labels';
import type { Session } from './session';

vi.mock('server-only', () => ({}));
vi.mock('./api-admin', () => ({ listUsers: vi.fn() }));
const session = { accessToken: 'test-token', roles: ['founder'] } as Session;
beforeEach(() => vi.resetAllMocks());
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
