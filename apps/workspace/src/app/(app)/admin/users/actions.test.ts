import { afterEach, expect, it, vi } from 'vitest';

import { IDLE } from '../action-state';
import { inviteUserAction, setRolesAction } from './actions';

vi.mock('server-only', () => ({}));
vi.mock('../guard', () => ({ requireSession: () => ({ accessToken: 'test-token' }) }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/env', () => ({ getEnv: () => ({ API_INTERNAL_URL: 'http://api.test' }) }));

afterEach(() => {
  vi.restoreAllMocks();
});

it('keeps the rejected invitation fields and marks each invalid control without sending an invite', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch');
  const data = new FormData();
  data.set('givenName', ' ');
  data.set('familyName', 'Lama');
  data.set('email', 'incorrect');
  data.append('roles', 'finance');
  const result = await inviteUserAction(IDLE, data);
  expect(result.status).toBe('error');
  expect(result.fields).toMatchObject({ familyName: 'Lama', roles: 'finance' });
  expect(result.fieldErrors).toEqual({
    givenName: 'Enter a given name.',
    email: 'Enter a valid email address.',
  });
  expect(fetch).not.toHaveBeenCalled();
});

it('sends the invitation and subsequent role edit through the authenticated admin API', async () => {
  const userId = '00000000-0000-4000-8000-000000000001';
  const fetch = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(Response.json({ userId }, { status: 201 }))
    .mockResolvedValueOnce(new Response(null, { status: 204 }));
  const invite = new FormData();
  invite.set('givenName', 'Asha');
  invite.set('familyName', 'Lama');
  invite.set('email', 'asha@example.test');
  invite.append('roles', 'finance');
  invite.append('roles', 'sales');
  expect((await inviteUserAction(IDLE, invite)).status).toBe('ok');
  const update = new FormData();
  update.set('userId', userId);
  update.append('roles', 'accountant');
  expect((await setRolesAction(IDLE, update)).status).toBe('ok');
  const sent = fetch.mock.calls.map(([url, init]) => ({
    path: url instanceof Request ? url.url : new URL(url).href,
    method: init?.method,
    auth: new Headers(init?.headers).get('authorization'),
    body: JSON.parse(typeof init?.body === 'string' ? init.body : 'null') as unknown,
  }));
  expect(sent).toEqual([
    {
      path: 'http://api.test/v1/admin/users/invite',
      method: 'POST',
      auth: 'Bearer test-token',
      body: {
        givenName: 'Asha',
        familyName: 'Lama',
        email: 'asha@example.test',
        roles: ['finance', 'sales'],
      },
    },
    {
      path: `http://api.test/v1/admin/users/${userId}/roles`,
      method: 'PUT',
      auth: 'Bearer test-token',
      body: { roles: ['accountant'] },
    },
  ]);
});
