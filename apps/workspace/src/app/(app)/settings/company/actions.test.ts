import { EMPTY_COMPANY_PROFILE, type CompanyProfile } from '@bos/contracts';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { IDLE } from '../action-state';

vi.mock('server-only', () => ({}));
const revalidatePath = vi.fn<(path: string) => void>();
vi.mock('next/cache', () => ({ revalidatePath: (path: string) => revalidatePath(path) }));
type Current = { key: string; value: unknown; version: number | null };
const requireSection = vi.fn<(id: string) => Promise<{ accessToken: string }>>();
vi.mock('../guard', () => ({ requireSection: (id: string) => requireSection(id) }));
const getSetting = vi.fn<(session: unknown, key: string) => Promise<Current>>();
const putSetting =
  vi.fn<
    (
      session: unknown,
      key: string,
      value: unknown,
      expectedVersion?: number | null,
    ) => Promise<{ version: number }>
  >();
vi.mock('@/lib/api-admin', () => ({
  getSetting: (session: unknown, key: string) => getSetting(session, key),
  putSetting: (session: unknown, key: string, value: unknown, expectedVersion?: number | null) =>
    putSetting(session, key, value, expectedVersion),
}));

const { resetCompanyCardAction, saveCompanyCardAction } = await import('./actions');
const { STALE_SETTING_MESSAGE } = await import('@/components/settings/stale-setting');

const PNG = 'data:image/png;base64,iVBORw0KGgo=';
const DOC_ID = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
const session = { accessToken: 't' };

const stored: CompanyProfile = {
  ...EMPTY_COMPANY_PROFILE,
  displayName: 'Acme',
  legacyLogoDataUrl: PNG,
  phones: ['01-4000000'],
  email: 'a@acme.test',
  signatoryName: 'Sita',
};
let values: Record<string, unknown>;

// What the page loaded: the profile at version 3, no address yet, the PAN at version 5. The mocked
// current versions below are all 1, so a write that sends 3 or 5 took it from the form, not a re-read.
const LOADED = {
  'expectedVersion:entity.profile': '3',
  'expectedVersion:entity.address': '',
  'expectedVersion:entity.pan_vat_no': '5',
};
const form = (
  entries: Record<string, string | string[]>,
  loaded: Record<string, string> = LOADED,
) => {
  const data = new FormData();
  for (const [name, value] of Object.entries(loaded)) data.set(name, value);
  for (const [name, value] of Object.entries(entries)) {
    data.delete(name);
    for (const v of Array.isArray(value) ? value : [value]) data.append(name, v);
  }
  return data;
};
const written = () => putSetting.mock.calls.map(([, key, value]) => [key, value]);
const staleError = () =>
  Object.assign(new Error('conflict'), {
    status: 409,
    body: {
      error: {
        code: 'stale_setting',
        message: 'Setting entity.profile changed (api text).',
        correlationId: 'c1',
      },
    },
  });

beforeEach(() => {
  revalidatePath.mockReset();
  values = { 'entity.profile': stored, 'entity.address': null, 'entity.pan_vat_no': null };
  requireSection.mockReset().mockResolvedValue(session);
  getSetting
    .mockReset()
    .mockImplementation((_s, key) => Promise.resolve({ key, value: values[key], version: 1 }));
  putSetting.mockReset().mockResolvedValue({ version: 2 });
});

describe('saveCompanyCardAction', () => {
  it('Identity writes entity.pan_vat_no and the display name, and leaves profile.panVatNo alone', async () => {
    const result = await saveCompanyCardAction(
      IDLE,
      form({ card: 'identity', displayName: 'Acme Pvt', panVatNo: '123456789' }),
    );
    expect(result.status).toBe('ok');
    expect(requireSection).toHaveBeenCalledWith('company');
    expect(written()).toEqual([
      ['entity.profile', { ...stored, displayName: 'Acme Pvt' }],
      ['entity.pan_vat_no', '123456789'],
    ]);
  });

  it('Contact merges into the stored profile: logo, signatory and name survive', async () => {
    await saveCompanyCardAction(
      IDLE,
      form({
        card: 'contact',
        phone: ['+9779800000000', ''],
        email: 'b@acme.test',
        website: 'acme.test',
      }),
    );
    expect(written()).toEqual([
      [
        'entity.profile',
        { ...stored, phones: ['+9779800000000'], email: 'b@acme.test', website: 'acme.test' },
      ],
    ]);
  });

  it('Address writes entity.address only, with blank optional parts left out', async () => {
    await saveCompanyCardAction(
      IDLE,
      form({ card: 'address', line1: 'Durbar Marg', line2: '', city: 'Kathmandu', country: 'NP' }),
    );
    expect(written()).toEqual([
      ['entity.address', { line1: 'Durbar Marg', city: 'Kathmandu', country: 'NP' }],
    ]);
  });

  it('has no logo card: the logo is moved by its upload, so a form cannot set or clear it', async () => {
    for (const logo of ['', PNG, DOC_ID]) {
      const result = await saveCompanyCardAction(
        IDLE,
        form({ card: 'logo', logo, logoDocumentId: DOC_ID }),
      );
      expect(result).toEqual({ status: 'error', message: 'Unknown card.' });
    }
    expect(getSetting).not.toHaveBeenCalled();
    expect(putSetting).not.toHaveBeenCalled();
  });

  it('keeps the uploaded logo and a logo not yet moved when any other card saves', async () => {
    const withLogo: CompanyProfile = { ...stored, logoDocumentId: DOC_ID, legacyLogoDataUrl: PNG };
    const saves: Record<string, string | string[]>[] = [
      { card: 'identity', displayName: 'Acme Pvt', panVatNo: '' },
      { card: 'contact', phone: ['+9779800000000'], email: '', website: '' },
      { card: 'signatory', name: 'Ram', title: 'Director' },
      // A smuggled logo field is ignored: only the card's own fields are read.
      { card: 'contact', phone: [], email: '', website: '', logoDocumentId: '', logo: '' },
    ];
    for (const entries of saves) {
      values['entity.profile'] = withLogo;
      putSetting.mockClear();
      const result = await saveCompanyCardAction(IDLE, form(entries));
      expect(result.status).toBe('ok');
      const profile = putSetting.mock.calls.find(([, key]) => key === 'entity.profile')?.[2] as
        CompanyProfile | undefined;
      expect(profile?.logoDocumentId).toBe(DOC_ID);
      expect(profile?.legacyLogoDataUrl).toBe(PNG);
    }
  });

  it('refuses an unknown card without touching a setting', async () => {
    for (const card of ['documents', 'format.number_system', '', 'entity.profile']) {
      const result = await saveCompanyCardAction(IDLE, form({ card }));
      expect(result).toEqual({ status: 'error', message: 'Unknown card.' });
    }
    expect(getSetting).not.toHaveBeenCalled();
    expect(putSetting).not.toHaveBeenCalled();
  });

  it('writes nothing when nothing changed', async () => {
    const result = await saveCompanyCardAction(
      IDLE,
      form({ card: 'signatory', name: 'Sita', title: '' }),
    );
    expect(result).toEqual({ status: 'ok', message: 'No changes to save.' });
    expect(putSetting).not.toHaveBeenCalled();
  });

  it('shows a refused field at the field and writes nothing', async () => {
    const result = await saveCompanyCardAction(
      IDLE,
      form({ card: 'identity', displayName: '', panVatNo: 'ab' }),
    );
    expect(result.status).toBe('error');
    expect(result.fieldErrors).toEqual({ panVatNo: 'A PAN is exactly 9 digits.' });
    expect(putSetting).not.toHaveBeenCalled();
  });

  it('fails closed when the stored profile cannot be read', async () => {
    values['entity.profile'] = { unexpected: true };
    const result = await saveCompanyCardAction(
      IDLE,
      form({ card: 'signatory', name: 'Ram', title: '' }),
    );
    expect(result).toEqual({
      status: 'error',
      message: 'The saved company profile could not be read, so nothing was changed.',
    });
    expect(putSetting).not.toHaveBeenCalled();
  });

  it('is stopped by the section guard before any read or write', async () => {
    requireSection.mockRejectedValue(new Error('REDIRECT:/settings/denied'));
    await expect(
      saveCompanyCardAction(IDLE, form({ card: 'signatory', name: 'Ram', title: '' })),
    ).rejects.toThrow('REDIRECT:/settings/denied');
    expect(getSetting).not.toHaveBeenCalled();
    expect(putSetting).not.toHaveBeenCalled();
  });
});

describe('saveCompanyCardAction: the loaded version', () => {
  it('sends the version the page loaded for each key, never one it read itself', async () => {
    await saveCompanyCardAction(
      IDLE,
      form({ card: 'identity', displayName: 'Acme Pvt', panVatNo: '123456789' }),
    );
    expect(putSetting.mock.calls.map(([, key, , version]) => [key, version])).toEqual([
      ['entity.profile', 3],
      ['entity.pan_vat_no', 5],
    ]);
  });

  it('sends null when the page loaded the default (an empty field)', async () => {
    await saveCompanyCardAction(
      IDLE,
      form({ card: 'address', line1: 'Durbar Marg', city: 'Kathmandu', country: 'NP' }),
    );
    expect(putSetting).toHaveBeenCalledTimes(1);
    expect(putSetting.mock.calls[0]?.[3]).toBeNull();
  });

  it('refuses a stale save with the reload message, saves nothing more and does not revalidate', async () => {
    putSetting.mockRejectedValue(staleError());
    const result = await saveCompanyCardAction(
      IDLE,
      form({ card: 'signatory', name: 'Ram', title: '' }),
    );
    expect(result).toEqual({ status: 'error', message: STALE_SETTING_MESSAGE });
    expect(putSetting).toHaveBeenCalledTimes(1);
    expect(putSetting.mock.calls[0]?.[3]).toBe(3);
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it('says what was and was not saved when the second write of the Identity card is stale', async () => {
    putSetting.mockResolvedValueOnce({ version: 4 }).mockRejectedValueOnce(staleError());
    const result = await saveCompanyCardAction(
      IDLE,
      form({ card: 'identity', displayName: 'Acme Pvt', panVatNo: '123456789' }),
    );
    expect(result.status).toBe('error');
    expect(result.message).toBe(
      'The display name was saved, but the PAN or VAT number was changed by someone else. Reload to see the latest.',
    );
    expect(result.stale).toBe(true);
    expect(putSetting).toHaveBeenCalledTimes(2);
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it('does not save a form that carries no loaded version', async () => {
    const result = await saveCompanyCardAction(
      IDLE,
      form({ card: 'signatory', name: 'Ram', title: '' }, {}),
    );
    expect(result).toEqual({ status: 'error', message: STALE_SETTING_MESSAGE });
    for (const bad of ['abc', '-1', '1.5', '3 ']) {
      const again = await saveCompanyCardAction(
        IDLE,
        form(
          { card: 'signatory', name: 'Ram', title: '' },
          { ...LOADED, 'expectedVersion:entity.profile': bad },
        ),
      );
      expect(again.message).toBe(STALE_SETTING_MESSAGE);
    }
    expect(getSetting).not.toHaveBeenCalled();
    expect(putSetting).not.toHaveBeenCalled();
  });

  it('still revalidates and explains any other failure', async () => {
    putSetting.mockRejectedValue(Object.assign(new Error('no'), { status: 403 }));
    const result = await saveCompanyCardAction(
      IDLE,
      form({ card: 'signatory', name: 'Ram', title: '' }),
    );
    expect(result.message).toBe("You don't have permission to change the company profile.");
    expect(revalidatePath).toHaveBeenCalledWith('/settings/company');
  });
});

describe('resetCompanyCardAction', () => {
  it('Contact goes back to empty inside the current profile: logo and display name stay', async () => {
    const result = await resetCompanyCardAction('contact', 3);
    expect(result.status).toBe('ok');
    expect(requireSection).toHaveBeenCalledWith('company');
    expect(putSetting).toHaveBeenCalledTimes(1);
    expect(putSetting).toHaveBeenCalledWith(
      session,
      'entity.profile',
      { ...stored, phones: [], email: null, website: null },
      3,
    );
    const profile = putSetting.mock.calls[0]?.[2] as CompanyProfile;
    expect(profile.legacyLogoDataUrl).toBe(PNG);
    expect(profile.displayName).toBe('Acme');
    expect(profile.signatoryName).toBe('Sita');
    expect(revalidatePath).toHaveBeenCalledWith('/settings/company');
  });

  it('Signatory clears the name and title only', async () => {
    await resetCompanyCardAction('signatory', 3);
    expect(written()).toEqual([
      ['entity.profile', { ...stored, signatoryName: null, signatoryTitle: null }],
    ]);
  });

  it('keeps the uploaded logo and a logo not yet moved when Contact or Signatory is reset', async () => {
    for (const card of ['contact', 'signatory']) {
      values['entity.profile'] = { ...stored, logoDocumentId: DOC_ID, legacyLogoDataUrl: PNG };
      putSetting.mockClear();
      expect((await resetCompanyCardAction(card, 3)).status).toBe('ok');
      const profile = putSetting.mock.calls[0]?.[2] as CompanyProfile;
      expect(profile.logoDocumentId).toBe(DOC_ID);
      expect(profile.legacyLogoDataUrl).toBe(PNG);
    }
  });

  it('merges into the value saved now, so a field someone else added is kept', async () => {
    values['entity.profile'] = { ...stored, displayName: 'Acme Ltd' };
    await resetCompanyCardAction('contact', 1);
    expect((putSetting.mock.calls[0]?.[2] as CompanyProfile).displayName).toBe('Acme Ltd');
  });

  it('Address clears the whole address with the loaded version (null when it was the default)', async () => {
    await resetCompanyCardAction('address', 2);
    expect(putSetting).toHaveBeenLastCalledWith(session, 'entity.address', null, 2);
    await resetCompanyCardAction('address', null);
    expect(putSetting).toHaveBeenLastCalledWith(session, 'entity.address', null, null);
  });

  it('is refused as stale without revalidating, and never reads the version itself', async () => {
    putSetting.mockRejectedValue(staleError());
    const result = await resetCompanyCardAction('address', 2);
    expect(result).toEqual({ status: 'error', message: STALE_SETTING_MESSAGE });
    expect(revalidatePath).not.toHaveBeenCalled();
    expect(putSetting.mock.calls[0]?.[3]).toBe(2);
  });

  it('refuses a version that is not a whole number or null', async () => {
    for (const bad of [Number.NaN, 1.5, Number.POSITIVE_INFINITY]) {
      const result = await resetCompanyCardAction('address', bad);
      expect(result).toEqual({ status: 'error', message: STALE_SETTING_MESSAGE });
    }
    expect(putSetting).not.toHaveBeenCalled();
  });

  it('refuses a card with no undo, and an unreadable stored profile, without writing', async () => {
    for (const card of ['identity', 'logo', 'entity.profile', '']) {
      expect(await resetCompanyCardAction(card, 3)).toEqual({
        status: 'error',
        message: 'Unknown card.',
      });
    }
    values['entity.profile'] = { unexpected: true };
    const result = await resetCompanyCardAction('contact', 3);
    expect(result.message).toBe(
      'The saved company profile could not be read, so nothing was changed.',
    );
    expect(putSetting).not.toHaveBeenCalled();
  });

  it('is stopped by the section guard before any read or write', async () => {
    requireSection.mockRejectedValue(new Error('REDIRECT:/settings/denied'));
    await expect(resetCompanyCardAction('address', 2)).rejects.toThrow('REDIRECT:/settings/denied');
    await expect(resetCompanyCardAction('contact', 3)).rejects.toThrow('REDIRECT:/settings/denied');
    expect(getSetting).not.toHaveBeenCalled();
    expect(putSetting).not.toHaveBeenCalled();
  });
});
