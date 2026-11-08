import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/lib/api';

vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('next/navigation', () => ({
  redirect: vi.fn((to: string) => {
    throw new Error(`NEXT_REDIRECT ${to}`);
  }),
}));
vi.mock('@/lib/bff', () => ({
  requireStaffSession: vi.fn(() => Promise.resolve({ accessToken: 't', roles: ['sales'] })),
}));

const api = vi.hoisted(() => ({ createLead: vi.fn(), convertLead: vi.fn() }));
vi.mock('@/components/p2/crm/crm-api', () => api);

import { createLeadAction } from './actions';

const IDEM = '44444444-4444-4444-8444-444444444444';
const LEAD = '11111111-1111-4111-8111-111111111111';
const GUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function form(extra: Record<string, string> = {}): FormData {
  const f = new FormData();
  const fields = {
    title: 'Dispatch automation',
    source: 'referral',
    companyName: 'Binford Ltd.',
    contactName: 'Sunita Shrestha',
    idempotencyKey: IDEM,
    ...extra,
  };
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}

const empty = { values: {}, fieldErrors: {} };

beforeEach(() => vi.clearAllMocks());

describe('createLeadAction', () => {
  it('sends the page key as the idempotency key and goes to the new lead', async () => {
    api.createLead.mockResolvedValue({ id: LEAD });
    await expect(createLeadAction(empty, form())).rejects.toThrow(`NEXT_REDIRECT /leads/${LEAD}`);
    expect(api.createLead).toHaveBeenCalledWith(expect.anything(), expect.anything(), IDEM);
  });

  it('keeps the key after a 5xx or a network error, so a retry cannot create a second lead', async () => {
    api.createLead.mockRejectedValueOnce(new ApiError(503, 'down'));
    const first = await createLeadAction(empty, form());
    expect(first.error).toBeTruthy();
    expect(first.key).toBe(IDEM);

    api.createLead.mockRejectedValueOnce(new TypeError('fetch failed'));
    const second = await createLeadAction(empty, form());
    expect(second.error).toBeTruthy();
    expect(second.key).toBe(IDEM);
  });

  it('rotates the key after a definite 4xx, so the next try is a new request', async () => {
    api.createLead.mockRejectedValueOnce(new ApiError(422, 'refused'));
    const res = await createLeadAction(empty, form());
    expect(res.key).toMatch(GUID_SHAPE);
    expect(res.key).not.toBe(IDEM);
  });

  it('keeps the unused key when the form is refused before any call', async () => {
    const res = await createLeadAction(empty, form({ title: '' }));
    expect(res.fieldErrors['title']).toBeTruthy();
    expect(res.key).toBe(IDEM);
    expect(api.createLead).not.toHaveBeenCalled();
  });

  it('replaces a missing or tampered key with a fresh one', async () => {
    api.createLead.mockResolvedValue({ id: LEAD });
    await expect(createLeadAction(empty, form({ idempotencyKey: 'x y' }))).rejects.toThrow();
    const sent = api.createLead.mock.calls[0]?.[2] as string;
    expect(sent).toMatch(GUID_SHAPE);
    expect(sent).not.toBe('x y');
  });
});
