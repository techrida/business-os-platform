import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const guard = vi.hoisted(() => ({ roles: ['founder'] as string[] }));
vi.mock('server-only', () => ({}));
vi.mock('../guard', () => ({
  requireSection: () => ({ accessToken: 'test-token', roles: guard.roles }),
}));
const revalidatePath = vi.hoisted(() => vi.fn());
vi.mock('next/cache', () => ({ revalidatePath }));
vi.mock('@/lib/env', () => ({ getEnv: () => ({ API_INTERNAL_URL: 'http://api.test' }) }));

import { previewAccessAction, saveAccessAction } from './actions';

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
  expect(result).toEqual({
    ok: false,
    kind: 'error',
    message: 'Only a Founder can change access.',
  });
  expect(fetch).not.toHaveBeenCalled();
});

it('rejects an empty or unreadable save as invalid without calling the API', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch');
  const result = await saveAccessAction({
    changes: [],
    expectedRevision: '7',
    note: '',
    acknowledged: [],
  });
  expect(result).toMatchObject({ ok: false, kind: 'invalid' });
  expect(await saveAccessAction('not an object')).toMatchObject({ ok: false, kind: 'invalid' });
  expect(fetch).not.toHaveBeenCalled();
  expect(revalidatePath).not.toHaveBeenCalled();
});

it('previews with a dry run only: one POST to the preview path and nothing saved', async () => {
  const body = {
    applied: [],
    impact: {
      widened: { people: 0, sample: [] },
      narrowed: { people: 0, sample: [] },
      unchanged: 0,
    },
    warnings: [],
    summaries: {},
    assignmentSummaries: {},
  };
  const fetch = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(new Response(JSON.stringify(body), { status: 200 }));
  const result = await previewAccessAction({ changes: CHANGES });
  expect(result).toEqual({ ok: true, preview: body });
  expect(fetch).toHaveBeenCalledTimes(1);
  const [url, init] = fetch.mock.calls[0] ?? [];
  expect(url instanceof URL ? url.href : url).toBe('http://api.test/v1/admin/access/preview');
  expect(init?.method).toBe('POST');
  expect(revalidatePath).not.toHaveBeenCalled();
});

it('passes on the dry run 422 field errors and blocked warnings as a refusal', async () => {
  // The body the API's error filter sends for the save's own 422 (accessSaveRefusal).
  const reason = 'Leads does not use department rules.';
  const blocked = { code: 'W9', severity: 'blocked', message: reason, changeIndex: 0 };
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(
      JSON.stringify({
        error: {
          code: 'unprocessable',
          message: reason,
          correlationId: 'c-1',
          fieldErrors: { 'changes.0.scope': reason },
          warnings: [blocked],
        },
      }),
      { status: 422 },
    ),
  );
  const result = await previewAccessAction({ changes: CHANGES });
  expect(result).toEqual({
    ok: false,
    kind: 'refused',
    message: reason,
    fieldErrors: { 'changes.0.scope': reason },
    warnings: [blocked],
  });
  expect(revalidatePath).not.toHaveBeenCalled();
});

it('keeps a failed dry run that may pass on retry apart from a refusal', async () => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 503 }));
  const result = await previewAccessAction({ changes: CHANGES });
  expect(result).toMatchObject({ ok: false, kind: 'error' });
});
