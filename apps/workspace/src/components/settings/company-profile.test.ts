import { EMPTY_COMPANY_PROFILE, type CompanyProfile } from '@bos/contracts';
import { describe, expect, it } from 'vitest';

import {
  CARD_WRITES,
  MAX_PHONES,
  addressLines,
  companyLogo,
  draftsFromSettings,
  emptyProfilePatch,
  isCardEmpty,
  isCompanyCard,
  isResettableCard,
  logoSource,
  mergeProfile,
  parseAddress,
  parseCompanySettings,
  parseContact,
  parseIdentity,
  parseSignatory,
  phoneListDefault,
  planCard,
  postedPhones,
  profilePhones,
  readExpectedVersion,
  sameDraft,
  versionFieldName,
  versionFieldValue,
  type AddressDraft,
} from './company-profile';

const anyString = expect.any(String) as string;
const PNG = 'data:image/png;base64,iVBORw0KGgo=';

const DOC_ID = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';

describe('logo', () => {
  it('shows the uploaded image through the image route, ahead of a logo not yet moved', () => {
    const logo = companyLogo({
      ...EMPTY_COMPANY_PROFILE,
      logoDocumentId: DOC_ID,
      legacyLogoDataUrl: PNG,
    });
    expect(logo).toEqual({ documentId: DOC_ID, legacyDataUrl: null });
    expect(logoSource(logo)).toBe(`/api/images/${DOC_ID}`);
  });

  it('shows a logo saved before uploads while it has not been moved, and nothing when there is none', () => {
    const legacy = companyLogo({ ...EMPTY_COMPANY_PROFILE, legacyLogoDataUrl: PNG });
    expect(legacy).toEqual({ documentId: null, legacyDataUrl: PNG });
    expect(logoSource(legacy)).toBe(PNG);
    const none = companyLogo(EMPTY_COMPANY_PROFILE);
    expect(none).toEqual({ documentId: null, legacyDataUrl: null });
    expect(logoSource(none)).toBeNull();
  });

  it('has no card that saves the logo through a form', () => {
    expect(isCompanyCard('logo')).toBe(false);
    expect(Object.keys(CARD_WRITES)).not.toContain('logo');
  });
});

const NP_MOBILE = { country: 'NP', e164: '+9779812345678', label: null } as const;
const NP_LANDLINE = { country: 'NP', e164: '+97714123456', label: 'work' } as const;
const US_PHONE = { country: 'US', e164: '+14155552671', label: null } as const;

/** A form as `planCard` reads it: one value per name. */
const form = (entries: Record<string, string>) => ({
  get: (name: string) => entries[name] ?? null,
  getAll: (name: string) => (entries[name] === undefined ? [] : [entries[name]]),
});

/** The fields a `PhoneListInput` named `phones` posts, row by row. */
const phoneFields = (rows: { number: string; country: string; label?: string }[]) =>
  Object.fromEntries(
    rows.flatMap((row, i) => [
      [`phones.${i}.number`, row.number],
      [`phones.${i}.country`, row.country],
      [`phones.${i}.label`, row.label ?? ''],
      [`phones.${i}.isPrimary`, i === 0 ? 'true' : 'false'],
    ]),
  );

describe('phones', () => {
  it('reads each posted number with its own country and label, drops blank rows, and ignores the primary flag', () => {
    const posted = form({
      ...phoneFields([
        { number: '+9779812345678', country: 'NP' },
        { number: '', country: 'NP' },
        { number: '+14155552671', country: 'US', label: 'work' },
      ]),
      'phones.2.isPrimary': 'true',
    });
    expect(postedPhones(posted)).toEqual([
      { row: 0, country: 'NP', e164: '+9779812345678', label: null },
      { row: 2, country: 'US', e164: '+14155552671', label: 'work' },
    ]);
    expect(planCard('contact', posted)).toEqual({
      ok: true,
      value: {
        profile: {
          phones: [NP_MOBILE, { ...US_PHONE, label: 'work' }],
          email: null,
          website: null,
        },
      },
    });
  });

  it('refuses a fifth number, a number of the wrong country and a number listed twice, at its row', () => {
    const base = { email: '', website: '' };
    const row = (i: number, e164: string, country = 'NP') => ({
      row: i,
      country,
      e164,
      label: null,
    });
    const five = parseContact({
      ...base,
      phones: ['+97714123456', '+97714123457', '+97714123458', '+97714123459', '+97714123450'].map(
        (e164, i) => row(i, e164),
      ),
    });
    expect(five).toMatchObject({ ok: false, errors: { phones: 'Add up to 4 phone numbers.' } });
    expect(MAX_PHONES).toBe(4);
    // A US number posted as Nepal's, and the same number twice.
    expect(
      parseContact({ ...base, phones: [row(0, '+14155552671', 'NP'), row(1, '+9779812345678')] }),
    ).toMatchObject({ ok: false, errors: { 'phones.0': 'A Nepal number starts with +977.' } });
    expect(
      parseContact({ ...base, phones: [row(0, '+9779812345678'), row(3, '+9779812345678')] }),
    ).toMatchObject({ ok: false, errors: { 'phones.3': 'This number is already listed.' } });
  });

  it('opens the list with the saved numbers, the first one marked primary, and saves them without it', () => {
    const list = phoneListDefault([NP_LANDLINE, US_PHONE]);
    expect(list).toEqual([
      { ...NP_LANDLINE, isPrimary: true },
      { ...US_PHONE, isPrimary: false },
    ]);
    expect(profilePhones(list)).toEqual([NP_LANDLINE, US_PHONE]);
  });
});

describe('profile merge', () => {
  const stored: CompanyProfile = {
    ...EMPTY_COMPANY_PROFILE,
    displayName: 'Acme',
    legacyLogoDataUrl: PNG,
    phones: [NP_LANDLINE],
    email: 'a@acme.test',
    signatoryName: 'Sita',
    panVatNo: 'LEGACY-1',
  };

  it('replaces only the fields of the card that saved', () => {
    const contact = parseContact({
      phones: [{ row: 0, country: 'US', e164: '+14155552671', label: null }],
      email: '',
      website: 'acme.test',
    });
    if (!contact.ok) throw new Error('expected ok');
    expect(mergeProfile(stored, contact.value)).toEqual({
      ...stored,
      phones: [US_PHONE],
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
    expect(merged.legacyLogoDataUrl).toBe(PNG);
    expect(merged.phones).toEqual([NP_LANDLINE]);
    expect(merged.signatoryName).toBe('Ram');
  });
});

function parseSignatoryForTest() {
  const parsed = parseSignatory({ name: 'Ram', title: 'Director' });
  if (!parsed.ok) throw new Error('expected ok');
  return parsed.value;
}

describe('parsers', () => {
  const empty: AddressDraft = { line: '', city: '', country: 'NP' };

  it('treats an address with no street lines and no city as none, whatever the country', () => {
    expect(parseAddress(empty)).toEqual({ ok: true, value: null });
    expect(parseAddress({ ...empty, country: 'US' })).toEqual({ ok: true, value: null });
  });

  it('requires the address, the city and a country, and trims them', () => {
    expect(parseAddress({ ...empty, city: 'Kathmandu' })).toMatchObject({
      ok: false,
      errors: { line: 'Enter the address.' },
    });
    expect(parseAddress({ ...empty, line: ' Durbar Marg\nWard 1 ', city: ' Kathmandu ' })).toEqual({
      ok: true,
      value: { line: 'Durbar Marg\nWard 1', city: 'Kathmandu', country: 'NP' },
    });
  });

  it('refuses an address posted without a country, or with one that is not a country code', () => {
    const fields = { card: 'address', 'address.line': 'Durbar Marg', 'address.city': 'Kathmandu' };
    expect(planCard('address', form(fields))).toEqual({
      ok: false,
      errors: { country: 'Choose a country.' },
    });
    expect(planCard('address', form({ ...fields, 'address.country': 'Nepal' }))).toEqual({
      ok: false,
      errors: { country: 'Choose a country.' },
    });
  });

  it('checks PAN or VAT and email at the field', () => {
    expect(parseIdentity({ displayName: '', panVatNo: 'ab' })).toMatchObject({
      ok: false,
      errors: { panVatNo: anyString },
    });
    expect(parseIdentity({ displayName: '', panVatNo: '12345678' })).toMatchObject({
      ok: false,
      errors: { panVatNo: 'A PAN is exactly 9 digits.' },
    });
    expect(parseContact({ phones: [], email: 'nope', website: '' })).toMatchObject({
      ok: false,
      errors: { email: anyString },
    });
  });

  it('plans the writes each card asks for', () => {
    expect(
      planCard(
        'address',
        form({
          'address.line': 'Durbar Marg',
          'address.city': 'Kathmandu',
          'address.country': 'NP',
        }),
      ),
    ).toEqual({
      ok: true,
      value: { address: { line: 'Durbar Marg', city: 'Kathmandu', country: 'NP' } },
    });
    expect(
      planCard(
        'address',
        form({ 'address.line': '', 'address.city': '', 'address.country': 'NP' }),
      ),
    ).toEqual({ ok: true, value: { address: null } });
  });

  it('lists the keys each card may write', () => {
    expect(CARD_WRITES.address).toEqual(['entity.address']);
    expect(CARD_WRITES.identity).toEqual(['entity.profile', 'entity.pan_vat_no']);
    for (const card of ['contact', 'signatory'] as const) {
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
    expect(drafts.address).toEqual({ line: '', city: '', country: 'NP' });
    expect(drafts.contact.phones).toEqual([]);
    expect(Object.keys(drafts)).toEqual(['identity', 'address', 'contact', 'signatory']);
  });

  it('does not call a stored phone without a label a change once the list reports it', () => {
    const { label: _omit, ...unlabelled } = US_PHONE;
    const drafts = draftsFromSettings({
      profile: { ...EMPTY_COMPANY_PROFILE, phones: [unlabelled] },
      address: null,
      panVatNo: null,
    });
    expect(sameDraft(drafts.contact.phones, profilePhones(phoneListDefault([US_PHONE])))).toBe(
      true,
    );
    expect(sameDraft({ n: ' a ' }, { n: 'a' })).toBe(true);
    expect(sameDraft({ n: 'a' }, { n: 'b' })).toBe(false);
  });

  it("prints line and city, leaving out the company's own country but not a foreign one", () => {
    const kathmandu: AddressDraft = { line: 'Durbar Marg', city: 'Kathmandu', country: 'NP' };
    expect(addressLines(kathmandu, 'NP')).toEqual(['Durbar Marg', 'Kathmandu']);
    // A foreign customer of a Nepal company keeps its country.
    expect(
      addressLines({ line: '1 Market St', city: 'San Francisco', country: 'US' }, 'NP'),
    ).toEqual(['1 Market St', 'San Francisco', 'United States']);
    expect(addressLines(kathmandu)).toEqual(['Durbar Marg', 'Kathmandu', 'Nepal']);
    expect(addressLines({ line: ' ', city: '', country: 'NP' }, 'NP')).toEqual([]);
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
});

describe('undo icons (D32)', () => {
  const settings = {
    profile: {
      ...EMPTY_COMPANY_PROFILE,
      displayName: 'Acme',
      legacyLogoDataUrl: PNG,
      phones: [NP_LANDLINE],
      signatoryTitle: 'Director',
    },
    address: { line: 'Durbar Marg', city: 'Kathmandu', country: 'NP' as const },
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
    expect(merged.legacyLogoDataUrl).toBe(PNG);
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
      profile: { ...EMPTY_COMPANY_PROFILE, legacyLogoDataUrl: PNG, displayName: 'Acme' },
    };
    expect(isCardEmpty('contact', onlyLogo)).toBe(true);
    expect(isCardEmpty('signatory', onlyLogo)).toBe(true);
  });
});
