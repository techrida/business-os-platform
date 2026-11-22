import type { CustomerDto } from '@bos/contracts';
import { describe, expect, it } from 'vitest';

import {
  EMPTY_CONTACT_VALUES,
  EMPTY_CUSTOMER_VALUES,
  normalizePhone,
  parseContact,
  parseCreateCustomer,
  parseUpdateCustomer,
  readPhoneRows,
  valuesOfCustomer,
  type CustomerValues,
  type PhoneRow,
} from './forms';

const valid: CustomerValues = {
  ...EMPTY_CUSTOMER_VALUES,
  legalName: '  Himalayan Construction Pvt. Ltd.  ',
  line: 'Balaju',
  city: 'Kathmandu',
  contactName: ' Sita Rai ',
  contactEmail: ' sita@himalayan.example ',
};

const existing: CustomerDto = {
  id: '11111111-1111-4111-8111-111111111111',
  number: 'CUS-0001',
  legalName: 'Himalayan Construction Pvt. Ltd.',
  panVatNo: '301234567',
  industry: 'Construction',
  relationship: 'prospect',
  ownerUserId: null,
  defaultCurrency: 'NPR',
  country: 'NP',
  address: { line: 'Balaju', city: 'Kathmandu' },
  mergedIntoId: null,
  version: 2,
  createdAt: '2026-11-08T05:45:00.000Z',
  updatedAt: '2026-11-08T05:45:00.000Z',
};

const nepal: PhoneRow = { country: 'NP', e164: '+9779812345678', isPrimary: true, index: 0 };
const us: PhoneRow = {
  country: 'US',
  e164: '+14155552671',
  label: 'work',
  isPrimary: false,
  index: 1,
};

function form(fields: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}

describe('readPhoneRows', () => {
  it('reads the rows in order, leaves out blank ones and keeps each row its own index', () => {
    const f = form({
      'phones.2.number': '+14155552671',
      'phones.2.country': 'us',
      'phones.2.label': 'work',
      'phones.2.isPrimary': 'false',
      'phones.0.number': '+9779812345678',
      'phones.0.country': 'NP',
      'phones.0.label': '',
      'phones.0.isPrimary': 'true',
      'phones.1.number': '',
      'phones.1.country': 'NP',
      'phones.1.isPrimary': 'false',
      'other.0.number': '+9779800000000',
    });
    expect(readPhoneRows(f, 'phones')).toEqual([
      { country: 'NP', e164: '+9779812345678', isPrimary: true, index: 0 },
      { country: 'US', e164: '+14155552671', label: 'work', isPrimary: false, index: 2 },
    ]);
  });

  it('makes the first number primary when the primary row was left blank', () => {
    const f = form({
      'phones.0.number': '',
      'phones.0.country': 'NP',
      'phones.0.isPrimary': 'true',
      'phones.1.number': '+14155552671',
      'phones.1.country': 'US',
      'phones.1.isPrimary': 'false',
    });
    expect(readPhoneRows(f, 'phones')).toEqual([
      { country: 'US', e164: '+14155552671', isPrimary: true, index: 1 },
    ]);
  });

  it('reads nothing from a form without rows', () => {
    expect(readPhoneRows(form({ fullName: 'Sita' }), 'phones')).toEqual([]);
  });
});

describe('parseCreateCustomer', () => {
  it('builds the contract body: trimmed, blanks left out, country top level and upper case', () => {
    const out = parseCreateCustomer({ ...valid, country: ' np ', industry: '  ', panVatNo: '' });
    expect(out).toEqual({
      ok: true,
      data: {
        legalName: 'Himalayan Construction Pvt. Ltd.',
        relationship: 'prospect',
        country: 'NP',
        address: { line: 'Balaju', city: 'Kathmandu' },
        contact: {
          fullName: 'Sita Rai',
          email: 'sita@himalayan.example',
          country: 'NP',
          phones: [],
        },
      },
    });
  });

  it('refuses an address without a country, on the country field', () => {
    const out = parseCreateCustomer({ ...valid, country: '' });
    expect(out).toEqual({ ok: false, errors: { country: "Choose the company's country." } });
  });

  it('refuses a Nepal customer whose PAN is not 9 digits, on the PAN field', () => {
    const out = parseCreateCustomer({ ...valid, country: 'NP', panVatNo: '30123456' });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.errors.panVatNo).toMatch(/9 digits/);
  });

  it('saves a foreign customer with no PAN, and one with a foreign tax id', () => {
    const none = parseCreateCustomer({ ...valid, country: 'IN', panVatNo: '' });
    expect(none.ok).toBe(true);
    expect(none.ok && none.data).toMatchObject({ country: 'IN' });
    expect(none.ok && none.data.panVatNo).toBeUndefined();
    const foreign = parseCreateCustomer({ ...valid, country: 'IN', panVatNo: 'AAAPL1234C' });
    expect(foreign.ok && foreign.data.panVatNo).toBe('AAAPL1234C');
    const shortForeign = parseCreateCustomer({ ...valid, country: 'IN', panVatNo: '12 34' });
    expect(!shortForeign.ok && shortForeign.errors.panVatNo).toMatch(/5 to 20/);
  });

  it("sends the first contact's country and two phones in different countries intact", () => {
    const out = parseCreateCustomer({ ...valid, contactCountry: 'us', contactTitle: 'Director' }, [
      nepal,
      us,
    ]);
    expect(out.ok && out.data.contact).toEqual({
      fullName: 'Sita Rai',
      email: 'sita@himalayan.example',
      country: 'US',
      title: 'Director',
      phones: [
        { country: 'NP', e164: '+9779812345678', isPrimary: true },
        { country: 'US', e164: '+14155552671', label: 'work', isPrimary: false },
      ],
    });
  });

  it("puts a phone refusal on the row the form posted, by that row's own index", () => {
    const out = parseCreateCustomer(valid, [
      nepal,
      { country: 'NP', e164: '+14155552671', isPrimary: false, index: 3 },
    ]);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.errors.phoneRows?.[3]).toMatch(/Nepal number starts with \+977\.$/);
    expect(out.errors.phoneRows?.slice(0, 3)).toEqual([undefined, undefined, undefined]);
  });

  it('needs a first contact with an email, and says so on its fields', () => {
    const out = parseCreateCustomer({ ...valid, contactName: '', contactEmail: '' });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.errors.contactName).toMatch(/full name/i);
    expect(out.errors.contactEmail).toMatch(/email/i);
    const bad = parseCreateCustomer({ ...valid, contactEmail: 'not-an-email' });
    expect(!bad.ok && bad.errors.contactEmail).toMatch(/name@company.com/);
  });

  it('keeps the optional fields that are filled', () => {
    const out = parseCreateCustomer({
      ...valid,
      panVatNo: ' 301234567 ',
      industry: 'Hydropower',
      defaultCurrency: 'USD',
      relationship: 'active',
    });
    expect(out.ok && out.data).toMatchObject({
      panVatNo: '301234567',
      industry: 'Hydropower',
      defaultCurrency: 'USD',
      relationship: 'active',
    });
  });

  it('says what is missing in plain words', () => {
    const out = parseCreateCustomer({ ...EMPTY_CUSTOMER_VALUES, country: '' });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.errors.legalName).toMatch(/legal name/i);
    expect(out.errors.line).toMatch(/address/i);
    expect(out.errors.city).toMatch(/city/i);
    expect(out.errors.country).toMatch(/country/i);
    expect(JSON.stringify(out.errors)).not.toMatch(/too small|invalid/i);
  });

  it('refuses a country that is not on the list and over-long text with a friendly message', () => {
    const out = parseCreateCustomer({ ...valid, country: 'NEP', industry: 'x'.repeat(101) });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.errors.country).toMatch(/from the list/);
    expect(out.errors.industry).toMatch(/100/);
  });

  it('refuses a relationship or currency that is not on the list', () => {
    const out = parseCreateCustomer({ ...valid, relationship: 'vip', defaultCurrency: 'EUR' });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.errors.relationship).toBeDefined();
    expect(out.errors.defaultCurrency).toBeDefined();
  });
});

describe('parseUpdateCustomer', () => {
  const same = valuesOfCustomer(existing);

  it('turns a customer into form values and back with no change', () => {
    expect(same.country).toBe('NP');
    expect(same.line).toBe('Balaju');
    expect(same.defaultCurrency).toBe('NPR');
    expect(parseUpdateCustomer(same, existing)).toEqual({ ok: false, nothingChanged: true });
  });

  it('sends only what changed, with the version the person saw', () => {
    const out = parseUpdateCustomer({ ...same, industry: 'Hydropower' }, existing);
    expect(out).toEqual({ ok: true, data: { industry: 'Hydropower', expectedVersion: 2 } });
  });

  it('sends the whole address with the unchanged country when only the city changed', () => {
    // The API refuses an address without its country, so a city-only edit must carry the form's country.
    const out = parseUpdateCustomer({ ...same, city: 'Lalitpur' }, existing);
    expect(out).toEqual({
      ok: true,
      data: { country: 'NP', address: { line: 'Balaju', city: 'Lalitpur' }, expectedVersion: 2 },
    });
  });

  it('sends a new country on its own, and holds the kept PAN to the new country', () => {
    const foreign = { ...existing, country: 'IN' as const, panVatNo: 'AAAPL1234C' };
    const toNepal = parseUpdateCustomer({ ...valuesOfCustomer(foreign), country: 'NP' }, foreign);
    expect(!toNepal.ok && 'errors' in toNepal && toNepal.errors.panVatNo).toMatch(/9 digits/);
    const out = parseUpdateCustomer({ ...same, country: 'IN' }, existing);
    expect(out).toEqual({ ok: true, data: { country: 'IN', expectedVersion: 2 } });
  });

  it('refuses an 8-digit PAN for a Nepal customer', () => {
    const out = parseUpdateCustomer({ ...same, panVatNo: '30123456' }, existing);
    expect(!out.ok && 'errors' in out && out.errors.panVatNo).toMatch(/9 digits/);
  });

  it('cannot clear PAN/VAT, industry or currency, and says so instead of ignoring the blank', () => {
    const out = parseUpdateCustomer(
      { ...same, panVatNo: '', industry: '', defaultCurrency: '' },
      existing,
    );
    expect(out.ok).toBe(false);
    if (out.ok || !('errors' in out)) return;
    expect(out.errors.panVatNo).toMatch(/cannot be cleared/i);
    expect(out.errors.industry).toMatch(/cannot be cleared/i);
    expect(out.errors.defaultCurrency).toMatch(/cannot be cleared/i);
  });

  it('allows a blank for a field that was already empty', () => {
    const bare = { ...existing, industry: null };
    const out = parseUpdateCustomer({ ...valuesOfCustomer(bare), city: 'Pokhara' }, bare);
    expect(out.ok).toBe(true);
  });

  it('refuses a cleared country', () => {
    const out = parseUpdateCustomer({ ...same, country: '' }, existing);
    expect(!out.ok && 'errors' in out && out.errors.country).toMatch(/country/i);
  });
});

describe('normalizePhone', () => {
  it('drops spaces, hyphens, dots and brackets but never adds a country code', () => {
    expect(normalizePhone('+977 (98) 1234-5678')).toBe('+9779812345678');
    expect(normalizePhone('9812345678')).toBe('9812345678');
  });
});

describe('parseContact', () => {
  const base = { ...EMPTY_CONTACT_VALUES, fullName: ' Sita Sharma ' };

  it('needs an email while the customer has no contact with one, and only then', () => {
    const out = parseContact(base, [], { requireEmail: true });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.errors.email).toMatch(/no contact with an email/i);
    expect(
      parseContact({ ...base, email: 'sita@example.com' }, [], { requireEmail: true }).ok,
    ).toBe(true);
    expect(parseContact(base, [], { requireEmail: false }).ok).toBe(true);
  });

  it('keeps the other field errors when the email is also missing', () => {
    const out = parseContact({ ...base, fullName: ' ' }, [], { requireEmail: true });
    expect(!out.ok && Object.keys(out.errors).sort()).toEqual(['email', 'fullName']);
  });

  it('builds a contact with only a name and a country', () => {
    expect(parseContact(base)).toEqual({
      ok: true,
      data: { fullName: 'Sita Sharma', country: 'NP', phones: [], isPrimary: false },
    });
  });

  it('sends two phones in different countries intact, with the contact country', () => {
    const out = parseContact(
      { ...base, country: 'in', email: 'sita@example.com', isPrimary: true },
      [nepal, us],
    );
    expect(out).toEqual({
      ok: true,
      data: {
        fullName: 'Sita Sharma',
        email: 'sita@example.com',
        country: 'IN',
        isPrimary: true,
        phones: [
          { country: 'NP', e164: '+9779812345678', isPrimary: true },
          { country: 'US', e164: '+14155552671', label: 'work', isPrimary: false },
        ],
      },
    });
  });

  it('explains a number without its country code on its row, in plain words', () => {
    const out = parseContact(base, [
      { country: 'NP', e164: '9812345678', isPrimary: true, index: 0 },
    ]);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.errors.phoneRows?.[0]).toMatch(/country code/i);
    expect(out.errors.phoneRows?.[0]).toContain('+9779812345678');
    expect(out.errors.phoneRows?.[0]).not.toMatch(/E\.164|regex|pattern/i);
  });

  it('says a number is listed twice on the second row', () => {
    const out = parseContact(base, [nepal, { ...nepal, isPrimary: false, index: 1 }]);
    expect(!out.ok && out.errors.phoneRows).toEqual([undefined, 'This number is already listed.']);
  });

  it('requires a name, a country and a real email', () => {
    const out = parseContact({ ...base, fullName: '   ', country: '', email: 'not-an-email' });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.errors.fullName).toMatch(/name/i);
    expect(out.errors.country).toMatch(/country/i);
    expect(out.errors.email).toMatch(/email/i);
  });
});
