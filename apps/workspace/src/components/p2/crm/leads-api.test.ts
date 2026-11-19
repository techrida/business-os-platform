import { LEAD_STAGES } from '@bos/contracts';
import { expect, it, vi } from 'vitest';

import { ApiError, apiFetch } from '@/lib/api';
import type { Session } from '@/lib/session';

import { getLeadSummary, listLeadsPage } from './leads-api';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  apiFetch: vi.fn(),
}));

const session = { accessToken: 'test-token' } as Session;
const OWNER = '9b2c1d3e-5f60-4a7b-8c9d-0e1f2a3b4c5d';

const reply = (body: unknown, total?: string) =>
  Response.json(body, total === undefined ? {} : { headers: { 'x-total-count': total } });

it('sends repeated filters with paging and reads the total from the header', async () => {
  vi.mocked(apiFetch).mockResolvedValue(reply([], '42'));
  const page = await listLeadsPage(session, {
    stage: ['new', 'contacted'],
    source: ['web'],
    ownerUserId: [OWNER],
    q: 'North & West',
    limit: 20,
    offset: 40,
  });
  expect(page).toEqual({ items: [], total: 42 });
  expect(apiFetch).toHaveBeenLastCalledWith(
    session,
    `/v1/leads?q=North+%26+West&source=web&ownerUserId=${OWNER}&stage=new&stage=contacted&limit=20&offset=40`,
  );
});

it('omits empty filters and offset 0', async () => {
  vi.mocked(apiFetch).mockResolvedValue(reply([], '0'));
  await listLeadsPage(session, { stage: [], source: [], ownerUserId: [], limit: 200 });
  expect(apiFetch).toHaveBeenLastCalledWith(session, '/v1/leads?limit=200');
});

it('answers 502 when the total header is missing or not an integer', async () => {
  vi.mocked(apiFetch).mockResolvedValue(reply([]));
  await expect(listLeadsPage(session, { limit: 5 })).rejects.toMatchObject({ status: 502 });
  vi.mocked(apiFetch).mockResolvedValue(reply([], '4.5'));
  await expect(listLeadsPage(session, { limit: 5 })).rejects.toBeInstanceOf(ApiError);
});

it('passes API errors through with their status', async () => {
  vi.mocked(apiFetch).mockResolvedValue(Response.json({ message: 'bad' }, { status: 400 }));
  await expect(listLeadsPage(session, { limit: 5 })).rejects.toMatchObject({ status: 400 });
});

const zeroed = Object.fromEntries(LEAD_STAGES.map((stage) => [stage, 0]));

it('parses the summary and sends only q, source and owner', async () => {
  vi.mocked(apiFetch).mockImplementation(() =>
    Promise.resolve(Response.json({ total: 3, byStage: { ...zeroed, new: 3 } })),
  );
  const summary = await getLeadSummary(session, {
    q: 'abc',
    source: ['web'],
    ownerUserId: [OWNER],
  });
  expect(summary.total).toBe(3);
  expect(summary.byStage.new).toBe(3);
  expect(apiFetch).toHaveBeenLastCalledWith(
    session,
    `/v1/leads/summary?q=abc&source=web&ownerUserId=${OWNER}`,
  );
  await getLeadSummary(session);
  expect(apiFetch).toHaveBeenLastCalledWith(session, '/v1/leads/summary');
});

it('rejects a summary missing a stage', async () => {
  vi.mocked(apiFetch).mockResolvedValue(Response.json({ total: 1, byStage: { new: 1 } }));
  await expect(getLeadSummary(session)).rejects.toMatchObject({ status: 502 });
});
