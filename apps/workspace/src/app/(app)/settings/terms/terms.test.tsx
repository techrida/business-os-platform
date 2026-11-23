import { DEFAULT_TERM_PRESETS, SETTING_DEFAULTS, type TermPreset } from '@bos/contracts';
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
const master = vi.hoisted(() => ({
  listAdminPaymentTerms: vi.fn(),
  createPaymentTerm: vi.fn(),
  updatePaymentTerm: vi.fn(),
}));
vi.mock('@/lib/api-master-data', () => master);
const putSetting =
  vi.fn<
    (
      session: Session,
      key: string,
      value: unknown,
      expectedVersion?: number | null,
    ) => Promise<unknown>
  >();
const getSetting = vi.fn<(session: Session, key: string) => Promise<unknown>>();
vi.mock('@/lib/api-admin', () => ({
  putSetting: (session: Session, key: string, value: unknown, expectedVersion?: number | null) =>
    putSetting(session, key, value, expectedVersion),
  getSetting: (session: Session, key: string) => getSetting(session, key),
}));

const { default: TermsPage } = await import('./page');
const { savePresetAction, removePresetAction, setDefaultPresetAction } = await import('./actions');
const { resetSettingAction } = await import('../_components/actions');
const { ApiError } = await import('@/lib/api');

const session = (roles: string[]): Session =>
  ({ accessToken: 't', orgKind: 'staff', roles }) as Session;

const ID = '11111111-1111-4111-8111-111111111111';
const preset: TermPreset = {
  id: ID,
  kind: 'scope',
  name: 'Standard build',
  body: '<p>We build it.</p><ul><li>In two phases.</li></ul>',
};

beforeEach(() => {
  vi.clearAllMocks();
  getSession.mockReset();
  putSetting.mockReset();
  putSetting.mockResolvedValue({ version: 2 });
  getSetting.mockReset();
  getSetting.mockResolvedValue({ key: 'quotation.term_presets', value: [], version: 3 });
  master.listAdminPaymentTerms.mockResolvedValue([]);
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

  it('shows the founder one tab per kind, each term set with its name and a one-line plain preview', async () => {
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
    // Plain words on one line: no markup, no list marker.
    expect(html).toContain('We build it. · In two phases.');
    expect(html).not.toContain('<ul><li>');
    expect(html).toContain('aria-label="Edit Standard build"');
    expect(html).toContain('aria-label="Remove Standard build"');
    expect(html).toContain('Add term set');
    expect(html).not.toContain('Saved option');
  });

  it('marks the kind default and offers Make default on the others', async () => {
    getSession.mockResolvedValue(session(['founder']));
    const other: TermPreset = { ...preset, id: '22222222-2222-4222-8222-222222222222', name: 'Other' };
    api.listTermPresets.mockResolvedValue([{ ...preset, isDefault: true }, other]);
    const html = renderToStaticMarkup((await TermsPage()) as ReactElement);
    expect(html.match(/>Default</g)).toHaveLength(1);
    expect(html).toContain('aria-label="Clear default Scope"');
    expect(html).toContain('aria-label="Make Other the default Scope"');
  });

  it('labels only the app default sets, and leaves them editable', async () => {
    getSession.mockResolvedValue(session(['founder']));
    // The page opens on the Scope tab, so the default's id is carried by a Scope set here.
    const shipped: TermPreset = { ...(DEFAULT_TERM_PRESETS[0] as TermPreset), kind: 'scope' };
    api.listTermPresets.mockResolvedValue([shipped, preset]);
    const html = renderToStaticMarkup((await TermsPage()) as ReactElement);
    expect(html.match(/App default/g)).toHaveLength(1);
    expect(html).toContain(`aria-label="Edit ${shipped.name}"`);
    expect(html).toContain(`aria-label="Remove ${shipped.name}"`);
    expect(html).toContain('aria-label="Edit Standard build"');
  });

  it('offers Reset all term sets to default only while the list differs from the defaults', async () => {
    getSession.mockResolvedValue(session(['founder']));
    api.listTermPresets.mockResolvedValue([...DEFAULT_TERM_PRESETS].reverse());
    const same = renderToStaticMarkup((await TermsPage()) as ReactElement);
    expect(same).not.toContain('Reset all term sets to default');

    api.listTermPresets.mockResolvedValue([...DEFAULT_TERM_PRESETS, preset]);
    const custom = renderToStaticMarkup((await TermsPage()) as ReactElement);
    expect(custom).toContain('aria-label="Reset all term sets to default"');
    expect(custom).toContain('aria-haspopup="dialog"');

    api.listTermPresets.mockResolvedValue([{ ...DEFAULT_TERM_PRESETS[0]!, name: 'Edited' }]);
    expect(renderToStaticMarkup((await TermsPage()) as ReactElement)).toContain(
      'aria-label="Reset all term sets to default"',
    );
  });

  it('keeps the list but offers no reset when the saved version cannot be read', async () => {
    getSession.mockResolvedValue(session(['founder']));
    getSetting.mockRejectedValue(new ApiError(403, 'no'));
    api.listTermPresets.mockResolvedValue([...DEFAULT_TERM_PRESETS, preset]);
    const html = renderToStaticMarkup((await TermsPage()) as ReactElement);
    expect(html).toContain('aria-label="Edit Standard build"');
    expect(html).not.toContain('Reset all term sets to default');
  });

  it('shows the empty state with Add term set when nothing is saved', async () => {
    getSession.mockResolvedValue(session(['founder']));
    api.listTermPresets.mockResolvedValue([]);
    const html = renderToStaticMarkup((await TermsPage()) as ReactElement);
    expect(html).toContain('No term sets for Scope yet');
    expect(html).toContain('Add term set');
    expect(html).toContain('aria-label="Reset all term sets to default"');
  });

  it('says what went wrong, in words, when the list cannot be read', async () => {
    getSession.mockResolvedValue(session(['founder']));
    api.listTermPresets.mockRejectedValue(new ApiError(403, 'no'));
    const html = renderToStaticMarkup((await TermsPage()) as ReactElement);
    expect(html).toContain('You don&#x27;t have permission to view term sets.');
    expect(html).not.toContain('Add term set');
    expect(html).not.toContain('Reset all term sets to default');
  });
});

describe('savePresetAction', () => {
  const add = { kind: 'scope', name: ' Standard build ', body: ' We build it. ' };

  it('refuses a person without the section permission before any call', async () => {
    getSession.mockResolvedValue(session(['sales']));
    await expect(savePresetAction(add)).rejects.toThrow('REDIRECT:/settings/denied');
    expect(api.createTermPreset).not.toHaveBeenCalled();
  });

  it('adds a trimmed term set for a founder and refreshes the list', async () => {
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

  it('sanitises the rich text on the server: a script, handler or link typed anywhere never reaches the API', async () => {
    getSession.mockResolvedValue(session(['founder']));
    api.createTermPreset.mockResolvedValue(preset);
    await savePresetAction({
      kind: 'terms_conditions',
      name: 'Casual website terms',
      body:
        '<p onclick="steal()">Pay <strong>half</strong> first.</p><script>alert(1)</script>' +
        '<ul><li><a href="javascript:x()">Two rounds</a></li></ul><img src=x onerror=y()>',
    });
    const sent = api.createTermPreset.mock.calls[0]?.[1] as { body: string };
    expect(sent.body).toBe('<p>Pay <strong>half</strong> first.</p><ul><li>Two rounds</li></ul>');
    expect(sent.body).not.toMatch(/script|onclick|onerror|href|<img|alert/);
  });

  it('refuses a body that is only markup or an empty list, at the text field', async () => {
    getSession.mockResolvedValue(session(['founder']));
    for (const body of ['<p></p>', '<ul><li></li></ul>', '<p> </p>', '   ']) {
      const result = await savePresetAction({ kind: 'scope', name: 'a', body });
      expect(result.fieldErrors).toHaveProperty('body');
    }
    expect(api.createTermPreset).not.toHaveBeenCalled();
  });

  it('counts the words, not the markup, against the limit', async () => {
    getSession.mockResolvedValue(session(['founder']));
    api.createTermPreset.mockResolvedValue(preset);
    const words = 'x'.repeat(2_000);
    const ok = await savePresetAction({
      kind: 'delivery_timeline',
      name: 'a',
      body: `<p><strong>${words}</strong></p>`,
    });
    expect(ok.status).toBe('ok');
    const over = await savePresetAction({
      kind: 'delivery_timeline',
      name: 'b',
      body: `<p><strong>${words}x</strong></p>`,
    });
    expect(over.fieldErrors).toHaveProperty('body');
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
      body: '<p>New text</p>',
      initialName: 'Standard build',
      initialBody: preset.body,
    });
    expect(api.updateTermPreset).toHaveBeenCalledWith(expect.anything(), ID, {
      body: '<p>New text</p>',
    });

    api.updateTermPreset.mockClear();
    const same = await savePresetAction({
      id: ID,
      kind: 'scope',
      name: 'Standard build',
      body: preset.body,
      initialName: 'Standard build',
      initialBody: preset.body,
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

  it('removes for a founder, treats an already-removed term set as done, and rejects a bad id', async () => {
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

describe('resetting every term set to the app defaults', () => {
  it('writes exactly DEFAULT_TERM_PRESETS to quotation.term_presets for a founder and refreshes the page', async () => {
    getSession.mockResolvedValue(session(['founder']));
    expect(await resetSettingAction('terms', 'quotation.term_presets', 3)).toMatchObject({
      status: 'ok',
    });
    expect(putSetting).toHaveBeenCalledTimes(1);
    expect(putSetting).toHaveBeenCalledWith(
      expect.anything(),
      'quotation.term_presets',
      DEFAULT_TERM_PRESETS,
      3,
    );
    expect(SETTING_DEFAULTS['quotation.term_presets']).toBe(DEFAULT_TERM_PRESETS);
    expect(revalidatePath).toHaveBeenCalledWith('/settings/terms');
  });

  it('refuses a person without the terms permission before any write', async () => {
    getSession.mockResolvedValue(session(['sales']));
    await expect(resetSettingAction('terms', 'quotation.term_presets', 3)).rejects.toThrow(
      'REDIRECT:/settings/denied',
    );
    getSession.mockResolvedValue(null);
    await expect(resetSettingAction('terms', 'quotation.term_presets', 3)).rejects.toThrow(
      'REDIRECT:',
    );
    expect(putSetting).not.toHaveBeenCalled();
  });

  it('writes no other setting through the terms section', async () => {
    getSession.mockResolvedValue(session(['founder']));
    expect(await resetSettingAction('terms', 'tax.vat_rate', 3)).toMatchObject({ status: 'error' });
    expect(putSetting).not.toHaveBeenCalled();
  });
});

describe('setDefaultPresetAction', () => {
  it('refuses a person without the section permission before any call', async () => {
    getSession.mockResolvedValue(session(['sales']));
    await expect(setDefaultPresetAction(ID, true)).rejects.toThrow('REDIRECT:/settings/denied');
    expect(api.updateTermPreset).not.toHaveBeenCalled();
  });

  it('sets and clears the default through the API and refreshes the list', async () => {
    getSession.mockResolvedValue(session(['founder']));
    api.updateTermPreset.mockResolvedValue(preset);
    expect(await setDefaultPresetAction(ID, true)).toMatchObject({ status: 'ok' });
    expect(api.updateTermPreset).toHaveBeenLastCalledWith(expect.anything(), ID, { isDefault: true });
    expect(await setDefaultPresetAction(ID, false)).toMatchObject({ status: 'ok' });
    expect(api.updateTermPreset).toHaveBeenLastCalledWith(expect.anything(), ID, {
      isDefault: false,
    });
    expect(revalidatePath).toHaveBeenCalledWith('/settings/terms');
  });

  it('says so when the term set was removed meanwhile', async () => {
    getSession.mockResolvedValue(session(['founder']));
    api.updateTermPreset.mockRejectedValue(new ApiError(404, 'gone'));
    expect(await setDefaultPresetAction(ID, true)).toMatchObject({ status: 'error' });
  });
});
