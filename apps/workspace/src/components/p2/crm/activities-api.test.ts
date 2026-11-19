import { expect, it, vi } from 'vitest';

import { apiFetch } from '@/lib/api';
import type { Session } from '@/lib/session';

import { listActivitiesPage } from './activities-api';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  apiFetch: vi.fn(),
}));

const session = { accessToken: 'test-token' } as Session;

const reply = (body: unknown, total?: string) =>
  Response.json(body, total === undefined ? {} : { headers: { 'x-total-count': total } });

it('sends repeated kind params with paging, and reads the total from the header', async () => {
  vi.mocked(apiFetch).mockResolvedValue(reply([], '42'));
  const page = await listActivitiesPage(session, {
    kind: ['call', 'note'],
    q: 'North & West',
    limit: 25,
    offset: 50,
  });
  expect(page).toEqual({ items: [], total: 42 });
  expect(apiFetch).toHaveBeenLastCalledWith(
    session,
    '/v1/activities?kind=call&kind=note&q=North+%26+West&limit=25&offset=50',
  );
});

it('omits empty filters and offset 0', async () => {
  vi.mocked(apiFetch).mockResolvedValue(reply([], '0'));
  await listActivitiesPage(session, { kind: [], limit: 100 });
  expect(apiFetch).toHaveBeenLastCalledWith(session, '/v1/activities?limit=100');
});

it('fails loudly when the total header is missing or the body is not a list', async () => {
  vi.mocked(apiFetch).mockResolvedValueOnce(reply([]));
  await expect(listActivitiesPage(session, { limit: 25 })).rejects.toMatchObject({
    status: 502,
  });
  vi.mocked(apiFetch).mockResolvedValueOnce(reply({ nope: true }, '1'));
  await expect(listActivitiesPage(session, { limit: 25 })).rejects.toMatchObject({
    status: 502,
  });
});

it('turns an API refusal into an ApiError with its status', async () => {
  vi.mocked(apiFetch).mockResolvedValue(
    Response.json({ error: { code: 'forbidden' } }, { status: 403 }),
  );
  await expect(listActivitiesPage(session, { limit: 25 })).rejects.toMatchObject({
    status: 403,
  });
});
