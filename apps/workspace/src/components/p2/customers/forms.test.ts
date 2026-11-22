import type { CustomerDto } from '@bos/contracts';
import { describe, expect, it } from 'vitest';

import {
  EMPTY_CUSTOMER_VALUES,
  normalizePhone,
  parseContact,
  parseCreateCustomer,
  parseUpdateCustomer,
  valuesOfCustomer,
  type CustomerValues,
} from './forms';

const valid: CustomerValues = {
  ...EMPTY_CUSTOMER_VALUES,
  legalName: '  Himalayan Construction Pvt. Ltd.  ',
  line1: 'Balaju',
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
  address: { line1: 'Balaju', city: 'Kathmandu', country: 'NP' },
  mergedIntoId: null,
  version: 2,
  createdAt: '2026-11-08T05:45:00.000Z',
  updatedAt: '2026-11-08T05:45:00.000Z',
};

describe('parseCreateCustomer', () => {
  it('builds the contract body: trimmed, blanks left out, country upper case', () => {
    const out = parseCreateCustomer({ ...valid, country: ' np ', industry: '  ', panVatNo: '' });
    expect(out).toEqual({
      ok: true,
      data: {
        legalName: 'Himalayan Construction Pvt. Ltd.',
        relationship: 'prospect',
        address: { line1: 'Balaju', city: 'Kathmandu', country: 'NP' },
        contact: { fullName: 'Sita Rai', email: 'sita@himalayan.example' },
      },
    });
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

  it("keeps the first contact's phone (punctuation removed) and job title", () => {
    const out = parseCreateCustomer({
      ...valid,
      contactPhone: '+977 981-234 5678',
      contactTitle: 'Director',
    });
    expect(out.ok && out.data.contact).toEqual({
      fullName: 'Sita Rai',
      email: 'sita@himalayan.example',
      phone: '+9779812345678',
      title: 'Director',
    });
    const badPhone = parseCreateCustomer({ ...valid, contactPhone: '9812345678' });
    expect(!badPhone.ok && badPhone.errors.contactPhone).toMatch(/country code/i);
  });

  it('keeps the optional fields that are filled', () => {
    const out = parseCreateCustomer({
      ...valid,
      panVatNo: ' 301234567 ',
      industry: 'Hydropower',
      defaultCurrency: 'USD',
      relationship: 'active',
      line2: 'Ward 4',
      postalCode: '44600',
    });
    expect(out.ok && out.data).toMatchObject({
      panVatNo: '301234567',
      industry: 'Hydropower',
      defaultCurrency: 'USD',
      relationship: 'active',
      address: { line2: 'Ward 4', postalCode: '44600' },
    });
  });

  it('says what is missing in plain words', () => {
    const out = parseCreateCustomer({ ...EMPTY_CUSTOMER_VALUES });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.errors.legalName).toMatch(/legal name/i);
    expect(out.errors.line1).toMatch(/address/i);
    expect(out.errors.city).toMatch(/city/i);
    expect(JSON.stringify(out.errors)).not.toMatch(/too small|invalid/i);
  });

  it('refuses a bad PAN/VAT, country and over-long text with a friendly message', () => {
    const out = parseCreateCustomer({
      ...valid,
      panVatNo: '12 34',
      country: 'NEP',
      industry: 'x'.repeat(101),
    });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.errors.panVatNo).toMatch(/5 to 20/);
    expect(out.errors.country).toMatch(/two-letter/);
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
    expect(same.defaultCurrency).toBe('NPR');
    expect(parseUpdateCustomer(same, existing)).toEqual({ ok: false, nothingChanged: true });
  });

  it('sends only what changed, with the version the person saw', () => {
    const out = parseUpdateCustomer({ ...same, industry: 'Hydropower' }, existing);
    expect(out).toEqual({ ok: true, data: { industry: 'Hydropower', expectedVersion: 2 } });
  });

  it('sends the whole address when any part of it changed', () => {
    const out = parseUpdateCustomer({ ...same, city: 'Lalitpur' }, existing);
    expect(out).toEqual({
      ok: true,
      data: {
        address: { line1: 'Balaju', city: 'Lalitpur', country: 'NP' },
        expectedVersion: 2,
      },
    });
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

  it('still validates what it sends', () => {
    const out = parseUpdateCustomer({ ...same, panVatNo: '!!' }, existing);
    expect(out.ok).toBe(false);
    if (out.ok || !('errors' in out)) return;
    expect(out.errors.panVatNo).toMatch(/5 to 20/);
  });
});

describe('normalizePhone', () => {
  it('drops spaces, hyphens, dots and brackets but never adds a country code', () => {
    expect(normalizePhone('+977 (98) 1234-5678')).toBe('+9779812345678');
    expect(normalizePhone('9812345678')).toBe('9812345678');
  });
});

describe('parseContact', () => {
  const base = { fullName: ' Sita Sharma ', title: '', email: '', phone: '', isPrimary: false };

  it('needs an email while the customer has no contact with one, and only then', () => {
    const out = parseContact(base, { requireEmail: true });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.errors.email).toMatch(/no contact with an email/i);
    expect(parseContact({ ...base, email: 'sita@example.com' }, { requireEmail: true }).ok).toBe(
      true,
    );
    expect(parseContact(base, { requireEmail: false }).ok).toBe(true);
  });

  it('keeps the other field errors when the email is also missing', () => {
    const out = parseContact({ ...base, fullName: ' ' }, { requireEmail: true });
    expect(!out.ok && Object.keys(out.errors).sort()).toEqual(['email', 'fullName']);
  });

  it('builds a contact with only a name', () => {
    expect(parseContact(base)).toEqual({
      ok: true,
      data: { fullName: 'Sita Sharma', isPrimary: false },
    });
  });

  it('accepts a phone typed with spaces and normalises it to E.164', () => {
    const out = parseContact({
      ...base,
      phone: '+977 981-234 5678',
      email: 'sita@example.com',
      isPrimary: true,
    });
    expect(out).toEqual({
      ok: true,
      data: {
        fullName: 'Sita Sharma',
        phone: '+9779812345678',
        email: 'sita@example.com',
        isPrimary: true,
      },
    });
  });

  it('explains a phone without a country code', () => {
    const out = parseContact({ ...base, phone: '9812345678' });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.errors.phone).toMatch(/country code/i);
    expect(out.errors.phone).toContain('+9779812345678');
    expect(out.errors.phone).not.toMatch(/E\.164|regex|pattern/i);
  });

  it('requires a name and a real email', () => {
    const out = parseContact({ ...base, fullName: '   ', email: 'not-an-email' });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.errors.fullName).toMatch(/name/i);
    expect(out.errors.email).toMatch(/email/i);
  });
});
