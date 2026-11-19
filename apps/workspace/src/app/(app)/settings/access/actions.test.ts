import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const guard = vi.hoisted(() => ({ roles: ['founder'] as string[] }));
vi.mock('server-only', () => ({}));
vi.mock('../guard', () => ({
  requireSection: () => ({ accessToken: 'test-token', roles: guard.roles }),
}));
const revalidatePath = vi.hoisted(() => vi.fn());
vi.mock('next/cache', () => ({ revalidatePath }));
vi.mock('@/lib/env', () => ({ getEnv: () => ({ API_INTERNAL_URL: 'http://api.test' }) }));

import { saveAccessAction } from './actions';

const CHANGES = [
  { kind: 'grant', role: 'sales', permission: 'crm.lead.read', scope: 'department' },
];

beforeEach(() => {
  guard.roles = ['founder'];
  revalidatePath.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

it('refuses a save from a person who may only view access, without calling the API', async () => {
  guard.roles = ['management'];
  const fetch = vi.spyOn(globalThis, 'fetch');
  const result = await saveAccessAction({
    changes: CHANGES,
    expectedRevision: '7',
    note: '',
    acknowledged: [],
  });
  expect(result).toEqual({ ok: false, kind: 'error', message: 'Only a Founder can change access.' });
  expect(fetch).not.toHaveBeenCalled();
});
