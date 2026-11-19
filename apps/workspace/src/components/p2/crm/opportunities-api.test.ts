import { expect, it, vi } from 'vitest';

import { apiFetch } from '@/lib/api';
import type { Session } from '@/lib/session';

import { listOpportunitiesPage } from './opportunities-api';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  apiFetch: vi.fn(),
}));

const session = { accessToken: 'test-token' } as Session;

const reply = (body: unknown, total?: string) =>
  Response.json(body, total === undefined ? {} : { headers: { 'x-total-count': total } });

it('sends repeated stage and owner params with paging, and reads the total from the header', async () => {
  vi.mocked(apiFetch).mockResolvedValue(reply([], '42'));
  const page = await listOpportunitiesPage(session, {
    stage: ['qualified', 'negotiation'],
    owner: ['9b2c1d3e-5f60-4a7b-8c9d-0e1f2a3b4c5d'],
    q: 'North & West',
    limit: 25,
    offset: 50,
  });
  expect(page).toEqual({ items: [], total: 42 });
  expect(apiFetch).toHaveBeenLastCalledWith(
    session,
    '/v1/opportunities?stage=qualified&stage=negotiation&owner=9b2c1d3e-5f60-4a7b-8c9d-0e1f2a3b4c5d&q=North+%26+West&limit=25&offset=50',
  );
});

it('omits empty filters and offset 0', async () => {
  vi.mocked(apiFetch).mockResolvedValue(reply([], '0'));
  await listOpportunitiesPage(session, { stage: [], owner: [], limit: 200 });
  expect(apiFetch).toHaveBeenLastCalledWith(session, '/v1/opportunities?limit=200');
});

it('fails loudly when the total header is missing or the body is not a list', async () => {
  vi.mocked(apiFetch).mockResolvedValueOnce(reply([]));
  await expect(listOpportunitiesPage(session, { limit: 25 })).rejects.toMatchObject({
    status: 502,
  });
  vi.mocked(apiFetch).mockResolvedValueOnce(reply({ nope: true }, '1'));
  await expect(listOpportunitiesPage(session, { limit: 25 })).rejects.toMatchObject({
    status: 502,
  });
});

it('turns an API refusal into an ApiError with its status', async () => {
  vi.mocked(apiFetch).mockResolvedValue(
    Response.json({ error: { code: 'forbidden' } }, { status: 403 }),
  );
  await expect(listOpportunitiesPage(session, { limit: 25 })).rejects.toMatchObject({
    status: 403,
  });
});
