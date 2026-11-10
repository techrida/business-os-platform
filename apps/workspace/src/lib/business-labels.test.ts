import { beforeEach, expect, it, vi } from 'vitest';
import { listUsers } from './api-admin';
import { userNames } from './business-labels';
import type { Session } from './session';

vi.mock('server-only', () => ({}));
vi.mock('./api-admin', () => ({ listUsers: vi.fn() }));
const session = { accessToken: 'test-token' } as Session;
beforeEach(() => vi.resetAllMocks());
it('resolves all directory pages as the caller and keeps unnamed references out of labels', async () => {
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
      ['b', 'b@example.test'],
      ['d', 'Dev'],
    ]),
  );
  expect(listUsers).toHaveBeenNthCalledWith(2, session, { limit: 200, after: 'b' });
});
it('keeps business records usable when directory access is denied', async () => {
  vi.mocked(listUsers).mockRejectedValue(new Error('denied'));
  expect(await userNames(session)).toEqual(new Map());
});
