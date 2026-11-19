import type { TermPreset } from '@bos/contracts';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Session } from '@/lib/session';

vi.mock('server-only', () => ({}));
vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT:${url}`);
  },
  usePathname: () => '/settings/terms',
  useRouter: () => ({ replace: vi.fn() }),
}));
const revalidatePath = vi.fn();
vi.mock('next/cache', () => ({
  revalidatePath: (path: string): void => {
    revalidatePath(path);
  },
}));
const getSession = vi.fn<() => Promise<Session | null>>();
vi.mock('@/lib/session', () => ({ getSession: () => getSession() }));
const api = vi.hoisted(() => ({
  listTermPresets: vi.fn(),
  createTermPreset: vi.fn(),
  updateTermPreset: vi.fn(),
  deleteTermPreset: vi.fn(),
}));
vi.mock('@/lib/api-term-presets', () => api);

const { default: TermsPage } = await import('./page');
const { savePresetAction, removePresetAction } = await import('./actions');
const { ApiError } = await import('@/lib/api');

const session = (roles: string[]): Session =>
  ({ accessToken: 't', orgKind: 'staff', roles }) as Session;

const ID = '11111111-1111-4111-8111-111111111111';
const preset: TermPreset = {
  id: ID,
  kind: 'scope',
  name: 'Standard build',
  body: 'We build it.\nIn two phases.',
};

beforeEach(() => {
  vi.clearAllMocks();
  getSession.mockReset();
});

describe('the Saved terms page', () => {
  it('sends a sales user to the no-access page and calls no API', async () => {
    getSession.mockResolvedValue(session(['sales']));
    await expect(TermsPage()).rejects.toThrow('REDIRECT:/settings/denied');
    expect(api.listTermPresets).not.toHaveBeenCalled();
  });

  it('sends a signed-out visitor to sign in, and a customer user to the staff-only page', async () => {
    getSession.mockResolvedValue(null);
    await expect(TermsPage()).rejects.toThrow('REDIRECT:/auth/login?returnTo=%2Fsettings%2Fterms');
    getSession.mockResolvedValue({
      accessToken: 't',
      orgKind: 'customer',
      roles: ['founder'],
    } as Session);
    await expect(TermsPage()).rejects.toThrow('REDIRECT:/staff-only');
  });

  it('shows the founder one tab per kind, each option with its name and first line, and Add option', async () => {
    getSession.mockResolvedValue(session(['founder']));
    api.listTermPresets.mockResolvedValue([preset]);
    const html = renderToStaticMarkup((await TermsPage()) as ReactElement);
    for (const label of [
      'Scope',
      'Assumptions',
      'Exclusions',
      'Delivery timeline',
      'Terms and conditions',
      'Payment terms',
    ]) {
      expect(html).toContain(label);
    }
    expect(html).toContain('Standard build');
    expect(html).toContain('We build it.');
    expect(html).not.toContain('In two phases.');
    expect(html).toContain('aria-label="Edit Standard build"');
    expect(html).toContain('aria-label="Remove Standard build"');
    expect(html).toContain('Add option');
  });

  it('shows the empty state with Add option when nothing is saved', async () => {
    getSession.mockResolvedValue(session(['founder']));
    api.listTermPresets.mockResolvedValue([]);
    const html = renderToStaticMarkup((await TermsPage()) as ReactElement);
    expect(html).toContain('No saved options for Scope yet');
    expect(html).toContain('Add option');
  });

  it('says what went wrong, in words, when the list cannot be read', async () => {
    getSession.mockResolvedValue(session(['founder']));
    api.listTermPresets.mockRejectedValue(new ApiError(403, 'no'));
    const html = renderToStaticMarkup((await TermsPage()) as ReactElement);
    expect(html).toContain('You don&#x27;t have permission to view saved terms.');
    expect(html).not.toContain('Add option');
  });
});

describe('savePresetAction', () => {
  const add = { kind: 'scope', name: ' Standard build ', body: ' We build it. ' };

  it('refuses a person without the section permission before any call', async () => {
    getSession.mockResolvedValue(session(['sales']));
    await expect(savePresetAction(add)).rejects.toThrow('REDIRECT:/settings/denied');
    expect(api.createTermPreset).not.toHaveBeenCalled();
  });

  it('adds a trimmed option for a founder and refreshes the list', async () => {
    getSession.mockResolvedValue(session(['founder']));
    api.createTermPreset.mockResolvedValue(preset);
    expect(await savePresetAction(add)).toMatchObject({ status: 'ok' });
    expect(api.createTermPreset).toHaveBeenCalledWith(expect.anything(), {
      kind: 'scope',
      name: 'Standard build',
      body: 'We build it.',
    });
    expect(revalidatePath).toHaveBeenCalledWith('/settings/terms');
  });

  it('rejects an unknown kind, an empty name and an over-long delivery text without calling the API', async () => {
    getSession.mockResolvedValue(session(['founder']));
    expect((await savePresetAction({ ...add, kind: 'constructor' })).status).toBe('error');
    const empty = await savePresetAction({ ...add, name: '  ' });
    expect(empty.fieldErrors).toHaveProperty('name');
    const long = await savePresetAction({
      kind: 'delivery_timeline',
      name: 'a',
      body: 'x'.repeat(2_001),
    });
    expect(long.fieldErrors).toHaveProperty('body');
    expect(api.createTermPreset).not.toHaveBeenCalled();
  });

  it('shows a taken name at the name field', async () => {
    getSession.mockResolvedValue(session(['founder']));
    api.createTermPreset.mockRejectedValue(new ApiError(409, 'dup'));
    const result = await savePresetAction(add);
    expect(result.status).toBe('error');
    expect(result.fieldErrors).toHaveProperty('name');
    expect(result.message).toContain('Standard build');
  });

  it('on an edit sends only what changed, and nothing when nothing changed', async () => {
    getSession.mockResolvedValue(session(['founder']));
    api.updateTermPreset.mockResolvedValue(preset);
    await savePresetAction({
      id: ID,
      kind: 'scope',
      name: 'Standard build',
      body: 'New text',
      initialName: 'Standard build',
      initialBody: 'We build it.',
    });
    expect(api.updateTermPreset).toHaveBeenCalledWith(expect.anything(), ID, { body: 'New text' });

    api.updateTermPreset.mockClear();
    const same = await savePresetAction({
      id: ID,
      kind: 'scope',
      name: 'Standard build',
      body: 'We build it.',
      initialName: 'Standard build',
      initialBody: 'We build it.',
    });
    expect(same.status).toBe('ok');
    expect(api.updateTermPreset).not.toHaveBeenCalled();
  });
});

describe('removePresetAction', () => {
  it('refuses a person without the section permission', async () => {
    getSession.mockResolvedValue(session(['sales']));
    await expect(removePresetAction(ID)).rejects.toThrow('REDIRECT:/settings/denied');
    expect(api.deleteTermPreset).not.toHaveBeenCalled();
  });

  it('removes for a founder, treats an already-removed option as done, and rejects a bad id', async () => {
    getSession.mockResolvedValue(session(['founder']));
    api.deleteTermPreset.mockResolvedValue(undefined);
    expect((await removePresetAction(ID)).status).toBe('ok');
    expect(api.deleteTermPreset).toHaveBeenCalledWith(expect.anything(), ID);

    api.deleteTermPreset.mockRejectedValue(new ApiError(404, 'gone'));
    expect((await removePresetAction(ID)).status).toBe('ok');

    api.deleteTermPreset.mockClear();
    expect((await removePresetAction('../x')).status).toBe('error');
    expect(api.deleteTermPreset).not.toHaveBeenCalled();
  });
});
