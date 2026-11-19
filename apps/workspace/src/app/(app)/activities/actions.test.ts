import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/lib/api';

vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/bff', () => ({
  requireStaffSession: vi.fn(() => Promise.resolve({ accessToken: 't', roles: ['sales'] })),
}));

const api = vi.hoisted(() => ({ createActivity: vi.fn() }));
vi.mock('@/components/p2/crm/crm-api', () => api);

import { logActivityAction } from './actions';

const KEY = '44444444-4444-4444-8444-444444444444';
const LEAD = '11111111-1111-4111-8111-111111111111';
const GUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function form(extra: Record<string, string> = {}): FormData {
  const f = new FormData();
  const fields = {
    subjectKind: 'leadId',
    subjectId: LEAD,
    kind: 'call',
    subject: 'Asked for a revised quote',
    idempotencyKey: KEY,
    ...extra,
  };
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}

const empty = { values: {}, fieldErrors: {} };

beforeEach(() => vi.clearAllMocks());

describe('logActivityAction', () => {
  it('sends the form key as the idempotency key', async () => {
    api.createActivity.mockResolvedValue({ id: 'a' });
    const res = await logActivityAction(empty, form());
    expect(res.ok).toBe(true);
    expect(api.createActivity).toHaveBeenCalledWith(expect.anything(), expect.anything(), KEY);
  });

  it('hands back a new key after a save, so the next activity is a new request', async () => {
    api.createActivity.mockResolvedValue({ id: 'a' });
    const res = await logActivityAction(empty, form());
    expect(res.key).toMatch(GUID_SHAPE);
    expect(res.key).not.toBe(KEY);
  });

  it('keeps the key after a 5xx or a network error, so a retry cannot log it twice', async () => {
    api.createActivity.mockRejectedValueOnce(new ApiError(503, 'down'));
    const first = await logActivityAction(empty, form());
    expect(first.error).toBeTruthy();
    expect(first.key).toBe(KEY);

    api.createActivity.mockRejectedValueOnce(new TypeError('fetch failed'));
    const second = await logActivityAction(empty, form());
    expect(second.key).toBe(KEY);
  });

  it('rotates the key after a definite 4xx', async () => {
    api.createActivity.mockRejectedValueOnce(new ApiError(403, 'no'));
    const res = await logActivityAction(empty, form());
    expect(res.key).toMatch(GUID_SHAPE);
    expect(res.key).not.toBe(KEY);
  });

  it('keeps the unused key when the form is refused before any call', async () => {
    const res = await logActivityAction(empty, form({ subject: '' }));
    expect(res.fieldErrors['subject']).toBeTruthy();
    expect(res.key).toBe(KEY);
    expect(api.createActivity).not.toHaveBeenCalled();
  });

  it('refuses a task: it is no longer a kind a person logs', async () => {
    const res = await logActivityAction(empty, form({ kind: 'task' }));
    expect(res.ok).toBeFalsy();
    expect(res.fieldErrors['kind']).toBeTruthy();
    expect(api.createActivity).not.toHaveBeenCalled();
  });

  it('refuses a note with a due time: a note cannot be planned', async () => {
    const res = await logActivityAction(empty, form({ kind: 'note', dueAt: '2026-12-01T10:00' }));
    expect(res.ok).toBeFalsy();
    expect(res.fieldErrors['kind']).toMatch(/note records something that happened/);
    expect(api.createActivity).not.toHaveBeenCalled();
  });

  it('replaces a missing or tampered key with a fresh one', async () => {
    api.createActivity.mockResolvedValue({ id: 'a' });
    await logActivityAction(empty, form({ idempotencyKey: '' }));
    const sent = api.createActivity.mock.calls[0]?.[2] as string;
    expect(sent).toMatch(GUID_SHAPE);
  });
});
