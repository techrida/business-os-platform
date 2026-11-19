import { EMPTY_COMPANY_PROFILE, type CompanyProfile } from '@bos/contracts';
import { describe, expect, it } from 'vitest';

import {
  CARD_WRITES,
  LOGO_MAX_BYTES,
  MAX_PHONES,
  addPhone,
  addressLines,
  canAddPhone,
  draftsFromSettings,
  emptyProfilePatch,
  isCardEmpty,
  isLogoDataUrl,
  isResettableCard,
  logoFormData,
  mergeProfile,
  parseAddress,
  parseCompanySettings,
  parseContact,
  parseIdentity,
  parseLogo,
  parseSignatory,
  planCard,
  readExpectedVersion,
  removePhone,
  sameDraft,
  setPhone,
  validateLogoFile,
  versionFieldName,
  versionFieldValue,
  type AddressDraft,
} from './company-profile';

const anyString = expect.any(String) as string;
const stringWith = (text: string) => expect.stringContaining(text) as string;
const PNG = 'data:image/png;base64,iVBORw0KGgo=';

describe('validateLogoFile', () => {
  it('accepts PNG, JPEG and WebP within the limit', () => {
    for (const type of ['image/png', 'image/jpeg', 'image/webp']) {
      expect(validateLogoFile({ type, size: 1000 })).toEqual({ ok: true });
    }
    expect(validateLogoFile({ type: 'image/png', size: LOGO_MAX_BYTES })).toEqual({ ok: true });
  });

  it('refuses SVG by type and by file name, with its own message', () => {
    const byType = validateLogoFile({ type: 'image/svg+xml', size: 100 });
    const byName = validateLogoFile({ type: '', size: 100, name: 'logo.SVG' });
    for (const result of [byType, byName]) {
      expect(result).toEqual({
        ok: false,
        message: 'SVG logos are not accepted. Use a PNG, JPEG or WebP image.',
      });
    }
  });

  it('refuses other types, an empty file and anything over 200 KB', () => {
    expect(validateLogoFile({ type: 'image/gif', size: 100 })).toMatchObject({ ok: false });
    expect(validateLogoFile({ type: 'application/pdf', size: 100 })).toMatchObject({ ok: false });
    expect(validateLogoFile({ type: 'image/png', size: 0 })).toEqual({
      ok: false,
      message: 'That file is empty.',
    });
    expect(validateLogoFile({ type: 'image/png', size: LOGO_MAX_BYTES + 1 })).toEqual({
      ok: false,
      message: 'That image is 201 KB. The limit is 200 KB.',
    });
  });

  it('keeps a 200 KB file inside what the profile can store', () => {
    const base64Length = Math.ceil(LOGO_MAX_BYTES / 3) * 4;
    const url = `data:image/png;base64,${'A'.repeat(base64Length)}`;
    expect(isLogoDataUrl(url)).toBe(true);
    expect(isLogoDataUrl('data:image/svg+xml;base64,PHN2Zz4=')).toBe(false);
  });
});

describe('phones', () => {
  it('adds up to four rows and then stops', () => {
    let phones: string[] = [];
    for (let i = 0; i < 6; i += 1) phones = addPhone(phones);
    expect(phones).toHaveLength(MAX_PHONES);
    expect(canAddPhone(phones)).toBe(false);
    expect(canAddPhone(removePhone(phones, 0))).toBe(true);
  });

  it('removes and edits a row by position', () => {
    expect(removePhone(['1', '2', '3'], 1)).toEqual(['1', '3']);
    expect(setPhone(['1', '2'], 1, '9')).toEqual(['1', '9']);
  });

  it('rejects a fifth number when parsing, and drops empty rows', () => {
    const base = { email: '', website: '' };
    expect(parseContact({ ...base, phones: ['1', '', ' 2 '] })).toEqual({
      ok: true,
      value: { phones: ['1', '2'], email: null, website: null },
    });
    const five = parseContact({ ...base, phones: ['1', '2', '3', '4', '5'] });
    expect(five).toMatchObject({ ok: false, errors: { phones: anyString } });
  });
});

describe('profile merge', () => {
  const stored: CompanyProfile = {
    ...EMPTY_COMPANY_PROFILE,
    displayName: 'Acme',
    logoDataUrl: PNG,
    phones: ['01-4000000'],
    email: 'a@acme.test',
    signatoryName: 'Sita',
    panVatNo: 'LEGACY-1',
  };

  it('replaces only the fields of the card that saved', () => {
    const contact = parseContact({ phones: ['9800000000'], email: '', website: 'acme.test' });
    if (!contact.ok) throw new Error('expected ok');
    expect(mergeProfile(stored, contact.value)).toEqual({
      ...stored,
      phones: ['9800000000'],
      email: null,
      website: 'acme.test',
    });
  });

  it('never carries panVatNo from the Identity card into the profile', () => {
    const identity = parseIdentity({ displayName: 'Acme Pvt', panVatNo: '123456789' });
    if (!identity.ok) throw new Error('expected ok');
    expect(identity.value.panVatNo).toBe('123456789');
    expect(identity.value.profile).toEqual({ displayName: 'Acme Pvt' });
    expect(mergeProfile(stored, identity.value.profile).panVatNo).toBe('LEGACY-1');
  });

  it('keeps the logo and phones when the signatory card saves', () => {
    const signatory = parseSignatoryForTest();
    const merged = mergeProfile(stored, signatory);
    expect(merged.logoDataUrl).toBe(PNG);
    expect(merged.phones).toEqual(['01-4000000']);
    expect(merged.signatoryName).toBe('Ram');
  });
});

function parseSignatoryForTest() {
  const parsed = parseSignatory({ name: 'Ram', title: 'Director' });
  if (!parsed.ok) throw new Error('expected ok');
  return parsed.value;
}

describe('parsers', () => {
  const empty: AddressDraft = {
    line1: '',
    line2: '',
    city: '',
    district: '',
    province: '',
    postalCode: '',
    country: 'NP',
  };

  it('treats an address with nothing typed as none', () => {
    expect(parseAddress(empty)).toEqual({ ok: true, value: null });
  });

  it('requires line 1 and city, and omits optional parts left blank', () => {
    expect(parseAddress({ ...empty, district: 'Kathmandu' })).toMatchObject({
      ok: false,
      errors: { line1: 'Enter the address line 1.', city: 'Enter the city.' },
    });
    expect(parseAddress({ ...empty, line1: ' Durbar Marg ', city: 'Kathmandu' })).toEqual({
      ok: true,
      value: { line1: 'Durbar Marg', city: 'Kathmandu', country: 'NP' },
    });
  });

  it('checks PAN or VAT, email and logo at the field', () => {
    expect(parseIdentity({ displayName: '', panVatNo: 'ab' })).toMatchObject({
      ok: false,
      errors: { panVatNo: anyString },
    });
    expect(parseContact({ phones: [], email: 'nope', website: '' })).toMatchObject({
      ok: false,
      errors: { email: anyString },
    });
    expect(parseLogo('data:image/svg+xml;base64,PHN2Zz4=')).toMatchObject({
      ok: false,
      errors: { logo: stringWith('SVG') },
    });
    expect(parseLogo('')).toEqual({ ok: true, value: { logoDataUrl: null } });
    expect(parseLogo(PNG)).toEqual({ ok: true, value: { logoDataUrl: PNG } });
  });

  it('plans the writes each card asks for', () => {
    const form = (entries: Record<string, string | string[]>) => ({
      get: (name: string) => {
        const v = entries[name];
        return Array.isArray(v) ? v[0] : v;
      },
      getAll: (name: string) => {
        const v = entries[name];
        return v === undefined ? [] : Array.isArray(v) ? v : [v];
      },
    });
    expect(planCard('contact', form({ phone: ['1', '2'], email: '', website: '' }))).toEqual({
      ok: true,
      value: { profile: { phones: ['1', '2'], email: null, website: null } },
    });
    expect(planCard('address', form({ line1: '', city: '', country: 'NP' }))).toEqual({
      ok: true,
      value: { address: null },
    });
  });

  it('lists the keys each card may write', () => {
    expect(CARD_WRITES.address).toEqual(['entity.address']);
    expect(CARD_WRITES.identity).toEqual(['entity.profile', 'entity.pan_vat_no']);
    for (const card of ['contact', 'logo', 'signatory'] as const) {
      expect(CARD_WRITES[card]).toEqual(['entity.profile']);
    }
  });
});

describe('drafts', () => {
  it('reads the stored values, with Nepal as the starting country', () => {
    const drafts = draftsFromSettings({
      profile: EMPTY_COMPANY_PROFILE,
      address: null,
      panVatNo: null,
    });
    expect(drafts.address.country).toBe('NP');
    expect(drafts.contact.phones).toEqual([]);
    expect(drafts.logo).toBeNull();
  });

  it('does not call trimming or a blank phone row a change', () => {
    expect(sameDraft({ phones: ['1', ''], n: ' a ' }, { phones: ['1'], n: 'a' })).toBe(true);
    expect(sameDraft({ n: 'a' }, { n: 'b' })).toBe(false);
  });

  it('writes the letterhead address lines, skipping empty parts', () => {
    expect(
      addressLines({
        line1: 'Durbar Marg',
        line2: '',
        city: 'Kathmandu',
        district: 'Kathmandu',
        province: 'Bagmati',
        postalCode: '44600',
        country: 'NP',
      }),
    ).toEqual(['Durbar Marg', 'Kathmandu, Kathmandu', 'Bagmati, 44600', 'Nepal']);
    expect(
      addressLines({
        line1: '',
        line2: '',
        city: '',
        district: '',
        province: '',
        postalCode: '',
        country: 'NP',
      }),
    ).toEqual([]);
  });

  it('reports an unreadable stored value instead of guessing', () => {
    expect(parseCompanySettings({ profile: { bad: true }, address: null, panVatNo: null })).toEqual(
      {
        ok: false,
        message: 'The saved company profile could not be read.',
      },
    );
    expect(
      parseCompanySettings({ profile: EMPTY_COMPANY_PROFILE, address: null, panVatNo: null }).ok,
    ).toBe(true);
  });
});

describe('loaded versions', () => {
  const formWith = (name: string, value: string) => {
    const data = new FormData();
    data.set(name, value);
    return data;
  };

  it('names the field after the setting and writes null as an empty value', () => {
    expect(versionFieldName('entity.profile')).toBe('expectedVersion:entity.profile');
    expect(versionFieldValue(null)).toBe('');
    expect(versionFieldValue(7)).toBe('7');
  });

  it('reads a number, null for the default, and undefined for anything unreadable', () => {
    const key = versionFieldName('entity.address');
    expect(readExpectedVersion(formWith(key, '12'), 'entity.address')).toBe(12);
    expect(readExpectedVersion(formWith(key, ''), 'entity.address')).toBeNull();
    for (const bad of ['x', '-1', '1.5', ' 1', '1e3']) {
      expect(readExpectedVersion(formWith(key, bad), 'entity.address')).toBeUndefined();
    }
    expect(readExpectedVersion(new FormData(), 'entity.address')).toBeUndefined();
  });

  it('puts the loaded profile version into the logo card form, for a new logo and for a removal', () => {
    const save = logoFormData(PNG, 4);
    expect(save.get('card')).toBe('logo');
    expect(save.get('logo')).toBe(PNG);
    expect(save.get('expectedVersion:entity.profile')).toBe('4');
    const remove = logoFormData(null, null);
    expect(remove.get('logo')).toBe('');
    expect(remove.get('expectedVersion:entity.profile')).toBe('');
  });

  it('reads the logo card form back as the version the page loaded', () => {
    const data = logoFormData(PNG, 4);
    expect(readExpectedVersion(data, 'entity.profile')).toBe(4);
    expect(planCard('logo', data)).toEqual({ ok: true, value: { profile: { logoDataUrl: PNG } } });
  });
});

describe('undo icons (D32)', () => {
  const settings = {
    profile: {
      ...EMPTY_COMPANY_PROFILE,
      displayName: 'Acme',
      logoDataUrl: PNG,
      phones: ['01-4000000'],
      signatoryTitle: 'Director',
    },
    address: { line1: 'Durbar Marg', city: 'Kathmandu', country: 'NP' },
    panVatNo: '123456789',
  };

  it('names the cards that can be undone', () => {
    expect(['address', 'contact', 'signatory'].every(isResettableCard)).toBe(true);
    for (const other of ['identity', 'logo', 'entity.profile', '']) {
      expect(isResettableCard(other)).toBe(false);
    }
  });

  it('empties only the fields of the card, so the logo and display name stay', () => {
    expect(emptyProfilePatch('contact')).toEqual({ phones: [], email: null, website: null });
    expect(emptyProfilePatch('signatory')).toEqual({ signatoryName: null, signatoryTitle: null });
    const merged = mergeProfile(settings.profile, emptyProfilePatch('contact'));
    expect(merged.logoDataUrl).toBe(PNG);
    expect(merged.displayName).toBe('Acme');
    expect(merged.signatoryTitle).toBe('Director');
  });

  it('shows the icon only while the saved card differs from empty', () => {
    expect(isCardEmpty('address', settings)).toBe(false);
    expect(isCardEmpty('contact', settings)).toBe(false);
    expect(isCardEmpty('signatory', settings)).toBe(false);
    const empty = { profile: EMPTY_COMPANY_PROFILE, address: null, panVatNo: null };
    for (const card of ['address', 'contact', 'signatory'] as const) {
      expect(isCardEmpty(card, empty)).toBe(true);
    }
    // A logo or display name alone does not make Contact or Signatory look changed.
    const onlyLogo = {
      ...empty,
      profile: { ...EMPTY_COMPANY_PROFILE, logoDataUrl: PNG, displayName: 'Acme' },
    };
    expect(isCardEmpty('contact', onlyLogo)).toBe(true);
    expect(isCardEmpty('signatory', onlyLogo)).toBe(true);
  });
});
