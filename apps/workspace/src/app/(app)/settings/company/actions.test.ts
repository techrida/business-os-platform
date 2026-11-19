import { EMPTY_COMPANY_PROFILE, type CompanyProfile } from '@bos/contracts';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { IDLE } from '../action-state';

vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
type Current = { key: string; value: unknown; version: number | null };
const requireSection = vi.fn<(id: string) => Promise<{ accessToken: string }>>();
vi.mock('../guard', () => ({ requireSection: (id: string) => requireSection(id) }));
const getSetting = vi.fn<(session: unknown, key: string) => Promise<Current>>();
const putSetting =
  vi.fn<(session: unknown, key: string, value: unknown) => Promise<{ version: number }>>();
vi.mock('@/lib/api-admin', () => ({
  getSetting: (session: unknown, key: string) => getSetting(session, key),
  putSetting: (session: unknown, key: string, value: unknown) => putSetting(session, key, value),
}));

const { saveCompanyCardAction } = await import('./actions');

const PNG = 'data:image/png;base64,iVBORw0KGgo=';
const session = { accessToken: 't' };

const stored: CompanyProfile = {
  ...EMPTY_COMPANY_PROFILE,
  displayName: 'Acme',
  logoDataUrl: PNG,
  phones: ['01-4000000'],
  email: 'a@acme.test',
  signatoryName: 'Sita',
};
let values: Record<string, unknown>;

const form = (entries: Record<string, string | string[]>) => {
  const data = new FormData();
  for (const [name, value] of Object.entries(entries)) {
    for (const v of Array.isArray(value) ? value : [value]) data.append(name, v);
  }
  return data;
};
const written = () => putSetting.mock.calls.map(([, key, value]) => [key, value]);

beforeEach(() => {
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
        phone: ['9800000000', ''],
        email: 'b@acme.test',
        website: 'acme.test',
      }),
    );
    expect(written()).toEqual([
      [
        'entity.profile',
        { ...stored, phones: ['9800000000'], email: 'b@acme.test', website: 'acme.test' },
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

  it('Logo saves a PNG and removes it with an empty value; SVG is refused', async () => {
    values['entity.profile'] = { ...stored, logoDataUrl: null };
    await saveCompanyCardAction(IDLE, form({ card: 'logo', logo: PNG }));
    expect(written()).toEqual([['entity.profile', { ...stored, logoDataUrl: PNG }]]);

    putSetting.mockClear();
    values['entity.profile'] = stored;
    await saveCompanyCardAction(IDLE, form({ card: 'logo', logo: '' }));
    expect(written()).toEqual([['entity.profile', { ...stored, logoDataUrl: null }]]);

    putSetting.mockClear();
    const svg = await saveCompanyCardAction(
      IDLE,
      form({ card: 'logo', logo: 'data:image/svg+xml;base64,PHN2Zz4=' }),
    );
    expect(svg.status).toBe('error');
    expect(svg.fieldErrors?.['logo']).toContain('SVG');
    expect(putSetting).not.toHaveBeenCalled();
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
    expect(result.fieldErrors).toEqual({ panVatNo: 'Use 5 to 20 letters, digits or hyphens.' });
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
