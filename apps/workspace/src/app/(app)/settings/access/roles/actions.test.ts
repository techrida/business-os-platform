import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Session } from '@/lib/session';

vi.mock('server-only', () => ({}));
vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT:${url}`);
  },
}));
const revalidatePath = vi.fn();
vi.mock('next/cache', () => ({ revalidatePath: (...args: unknown[]) => void revalidatePath(...args) }));
const getSession = vi.fn<() => Promise<Session | null>>();
vi.mock('@/lib/session', () => ({ getSession: () => getSession() }));

const api = vi.hoisted(() => ({
  previewAccessChanges: vi.fn(),
  saveAccessChanges: vi.fn(),
}));
vi.mock('@/lib/api-access', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/api-access')>();
  return { ...real, ...api };
});

const { previewAccessAction, saveAccessAction } = await import('./actions');
const { ApiError } = await import('@/lib/api');

const session = (roles: string[]): Session =>
  ({ accessToken: 't', orgKind: 'staff', roles }) as Session;

const change = { kind: 'grant', role: 'sales', permission: 'crm.lead.read', scope: 'department' };

beforeEach(() => {
  getSession.mockReset();
  revalidatePath.mockReset();
  api.previewAccessChanges.mockReset();
  api.saveAccessChanges.mockReset();
});

describe('access Server Actions', () => {
  it('send a person without access to the denied page and call nothing', async () => {
    getSession.mockResolvedValue(session(['sales']));
    await expect(previewAccessAction([change])).rejects.toThrow('REDIRECT:/settings/denied');
    await expect(saveAccessAction({ changes: [change] })).rejects.toThrow(
      'REDIRECT:/settings/denied',
    );
    expect(api.previewAccessChanges).not.toHaveBeenCalled();
    expect(api.saveAccessChanges).not.toHaveBeenCalled();
  });

  it('refuse a malformed change list before calling the API', async () => {
    getSession.mockResolvedValue(session(['founder']));
    const result = await previewAccessAction([{ kind: 'grant', role: 'nobody' }]);
    expect(result.ok).toBe(false);
    expect(api.previewAccessChanges).not.toHaveBeenCalled();
  });

  it('preview the parsed changes and return the dry run', async () => {
    getSession.mockResolvedValue(session(['founder']));
    const preview = { applied: [], warnings: [] };
    api.previewAccessChanges.mockResolvedValue(preview);
    expect(await previewAccessAction([change])).toEqual({ ok: true, preview });
    expect(api.previewAccessChanges).toHaveBeenCalledWith(expect.anything(), {
      changes: [change],
    });
  });

  it('save with the loaded revision, ticked warnings and a trimmed note, then refresh Access', async () => {
    getSession.mockResolvedValue(session(['founder']));
    api.saveAccessChanges.mockResolvedValue({});
    const result = await saveAccessAction({
      changes: [change],
      expectedRevision: 'rev-7',
      acknowledged: ['W5'],
      note: '  New sales structure  ',
    });
    expect(result).toEqual({ ok: true });
    expect(api.saveAccessChanges).toHaveBeenCalledWith(expect.anything(), {
      changes: [change],
      expectedRevision: 'rev-7',
      acknowledged: ['W5'],
      note: 'New sales structure',
    });
    expect(revalidatePath).toHaveBeenCalledWith('/settings/access', 'layout');
  });

  it('turn a stale save into the stale result and refresh nothing', async () => {
    getSession.mockResolvedValue(session(['founder']));
    api.saveAccessChanges.mockRejectedValue(
      new ApiError(409, 'stale', { error: { code: 'stale_access', message: 'old' } }),
    );
    const result = await saveAccessAction({
      changes: [change],
      expectedRevision: 'rev-6',
      acknowledged: [],
      note: '',
    });
    expect(result).toMatchObject({ ok: false, kind: 'stale' });
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});
