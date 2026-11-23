import { afterEach, expect, it, vi } from 'vitest';

import { IDLE } from '../action-state';
import {
  changeUserStatusAction,
  inviteUserAction,
  resolveIdentityAction,
  setRolesAction,
} from './actions';

vi.mock('server-only', () => ({}));
vi.mock('../guard', () => ({ requireSection: () => ({ accessToken: 'test-token' }) }));
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

it('sends the chosen department and level with the invitation (F1-Q50)', async () => {
  const departmentId = '00000000-0000-4000-8000-0000000005a1';
  const fetch = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(
      Response.json({ userId: '00000000-0000-4000-8000-000000000001' }, { status: 201 }),
    );
  const invite = new FormData();
  invite.set('givenName', 'Asha');
  invite.set('familyName', 'Lama');
  invite.set('email', 'asha@example.test');
  invite.set('departmentId', departmentId);
  invite.set('level', 'manager');
  expect((await inviteUserAction(IDLE, invite)).status).toBe('ok');
  const init = fetch.mock.calls[0]?.[1];
  expect(JSON.parse(typeof init?.body === 'string' ? init.body : 'null')).toEqual({
    givenName: 'Asha',
    familyName: 'Lama',
    email: 'asha@example.test',
    roles: [],
    departmentId,
    level: 'manager',
  });
});

it('asks for a department before inviting a department head, keeping the chosen level', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch');
  const invite = new FormData();
  invite.set('givenName', 'Asha');
  invite.set('familyName', 'Lama');
  invite.set('email', 'asha@example.test');
  invite.set('departmentId', '');
  invite.set('level', 'head');
  const result = await inviteUserAction(IDLE, invite);
  expect(result.status).toBe('error');
  expect(result.fieldErrors).toEqual({
    departmentId: 'Choose a department for a department head.',
  });
  expect(result.fields).toMatchObject({ level: 'head', departmentId: '' });
  expect(fetch).not.toHaveBeenCalled();
});

it.each([
  ['lock', 'User locked.'],
  ['unlock', 'User unlocked.'],
] as const)('sends %s to its own admin route and reports it (F1-Q5)', async (action, message) => {
  const userId = '00000000-0000-4000-8000-000000000001';
  const fetch = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(new Response(null, { status: 204 }));

  expect(await changeUserStatusAction(userId, action)).toMatchObject({ status: 'ok', message });

  const [url, init] = fetch.mock.calls[0] ?? [];
  expect(url instanceof Request ? url.url : new URL(url ?? '').href).toBe(
    `http://api.test/v1/admin/users/${userId}/${action}`,
  );
  expect(init?.method).toBe('POST');
});

it("shows the API's refusal of a lock in the user's words", async () => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
    Response.json(
      { code: 'last_founder', message: 'Mina is the only Founder of Techrida Nepal.' },
      { status: 409 },
    ),
  );

  const result = await changeUserStatusAction('00000000-0000-4000-8000-000000000001', 'lock');

  expect(result.status).toBe('error');
});

it('resolves a flagged person through the resolve-identity route and reports a 503 with the flag left set', async () => {
  const userId = '00000000-0000-4000-8000-000000000001';
  const fetch = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(new Response(null, { status: 204 }))
    .mockResolvedValueOnce(
      Response.json(
        {
          error: {
            code: 'unavailable',
            message: 'The identity provider could not be read.',
            correlationId: 'c1',
          },
        },
        { status: 503 },
      ),
    );
  expect(await resolveIdentityAction(userId)).toMatchObject({
    status: 'ok',
    message: 'Flag resolved.',
  });
  expect(await resolveIdentityAction(userId)).toMatchObject({
    status: 'error',
    message:
      'The identity provider could not be read, so nothing changed and the flag stays. Try again later.',
  });
  const [url, init] = fetch.mock.calls[0]!;
  expect(url instanceof Request ? url.url : new URL(url).pathname).toContain(
    `/v1/admin/users/${userId}/resolve-identity`,
  );
  expect(init?.method ?? (url as Request).method).toBe('POST');
  expect(await resolveIdentityAction('not-a-uuid')).toMatchObject({ status: 'error' });
});
