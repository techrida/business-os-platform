// FX9 party contracts: a country on every party, three-field addresses and several phones per person. Each case
// below fails on the pre-FX9 schemas (free-form address with its own country, one `phone` string per person).
import { describe, expect, it } from 'vitest';

import {
  ContactDtoSchema,
  ConvertLeadBodySchema,
  CreateContactBodySchema,
  CreateCustomerBodySchema,
  CreateLeadBodySchema,
  CreateVendorBodySchema,
  CustomerFieldsSchema,
  LeadDtoSchema,
  LeadIngestBodySchema,
  UpdateCustomerBodySchema,
  UpdateLeadBodySchema,
  VendorContactBodySchema,
  VendorDtoSchema,
} from './index.js';

const ID = '11111111-1111-4111-8111-111111111111';
const AT = '2026-11-22T10:00:00+05:45';
const address = { line: 'Durbar Marg 1', city: 'Kathmandu' };
const npMobile = {
  country: 'NP',
  e164: '+9779812345678',
  label: 'mobile',
  isPrimary: true,
} as const;
const usWork = { country: 'US', e164: '+14155552671', label: 'work', isPrimary: false } as const;

/** Lists a response DTO must refuse too (FX9 A2): no primary, two primaries, one number twice. */
const brokenLists = [
  ['no primary', [{ ...npMobile, isPrimary: false }, usWork]],
  ['two primaries', [npMobile, { ...usWork, isPrimary: true }]],
  ['one number twice', [npMobile, { ...npMobile, label: 'work', isPrimary: false }]],
] as const;

const issuePaths = (result: { success: boolean; error?: { issues: { path: PropertyKey[] }[] } }) =>
  (result.error?.issues ?? []).map((issue) => issue.path.join('.'));

describe('contacts carry a country and several phones (FX9)', () => {
  it('round-trips a contact with an NP mobile and a US number through the DTO', () => {
    const dto = {
      id: ID,
      customerId: ID,
      fullName: 'Sita Rai',
      email: 'sita@himal.example',
      country: 'NP',
      phones: [npMobile, usWork],
      title: null,
      isPrimary: true,
      version: 1,
    };
    const parsed = ContactDtoSchema.parse(dto);
    expect(parsed.phones.map((phone) => [phone.country, phone.e164])).toEqual([
      ['NP', '+9779812345678'],
      ['US', '+14155552671'],
    ]);
    expect(ContactDtoSchema.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed);
  });

  it.each(brokenLists)('refuses a contact DTO whose phones have %s', (_case, phones) => {
    const dto = {
      id: ID,
      customerId: ID,
      fullName: 'Sita Rai',
      email: null,
      country: 'NP',
      phones,
      title: null,
      isPrimary: true,
      version: 1,
    };
    expect(ContactDtoSchema.safeParse(dto).success).toBe(false);
    expect(ContactDtoSchema.safeParse({ ...dto, phones: [] }).success).toBe(true);
  });

  it('takes the same two phones on a new contact, and refuses a number that is not its row country', () => {
    const body = { fullName: 'Sita Rai', country: 'NP', phones: [npMobile, usWork] };
    expect(CreateContactBodySchema.safeParse(body).success).toBe(true);
    const wrong = CreateContactBodySchema.safeParse({
      ...body,
      phones: [npMobile, { ...usWork, country: 'NP' }],
    });
    expect(wrong.success).toBe(false);
    expect(issuePaths(wrong)).toContain('phones.1.e164');
  });

  it('needs a country on a contact, and defaults its phones to none', () => {
    const body = { fullName: 'Ravi', country: 'IN' };
    expect(CreateContactBodySchema.parse(body).phones).toEqual([]);
    const { country: _none, ...noCountry } = body;
    const refused = CreateContactBodySchema.safeParse(noCountry);
    expect(refused.success).toBe(false);
    expect(issuePaths(refused)).toEqual(['country']);
  });
});

describe('customers: a country of their own and a three-field address (FX9)', () => {
  const contact = { fullName: 'John Doe', email: 'john@acme.example', country: 'US' };
  const foreign = { legalName: 'Acme Inc.', country: 'US', address, contact };

  it('saves a foreign customer with no PAN', () => {
    expect(CreateCustomerBodySchema.safeParse(foreign).success).toBe(true);
  });

  it('refuses a 5-digit PAN on an NP customer, and takes it on a foreign one', () => {
    const np = CreateCustomerBodySchema.safeParse({ ...foreign, country: 'NP', panVatNo: '12345' });
    expect(np.success).toBe(false);
    expect(issuePaths(np)).toEqual(['panVatNo']);
    expect(CreateCustomerBodySchema.safeParse({ ...foreign, panVatNo: '12345' }).success).toBe(
      true,
    );
    expect(
      CreateCustomerBodySchema.safeParse({ ...foreign, country: 'NP', panVatNo: '123456789' })
        .success,
    ).toBe(true);
  });

  it('refuses a customer without a country', () => {
    const { country: _none, ...noCountry } = foreign;
    const refused = CreateCustomerBodySchema.safeParse(noCountry);
    expect(refused.success).toBe(false);
    expect(issuePaths(refused)).toEqual(['country']);
  });

  it('refuses an address that still carries the old shape or misses its city', () => {
    const { contact: _c, ...fields } = foreign;
    expect(CustomerFieldsSchema.safeParse(fields).success).toBe(true);
    expect(
      CustomerFieldsSchema.safeParse({
        ...fields,
        address: { line1: 'Durbar Marg', city: 'Kathmandu', country: 'US' },
      }).success,
    ).toBe(false);
    expect(
      CustomerFieldsSchema.safeParse({ ...fields, address: { line: 'Durbar Marg' } }).success,
    ).toBe(false);
  });

  it('does not put a default country or phones into an edit', () => {
    const parsed = UpdateCustomerBodySchema.parse({ expectedVersion: 1, legalName: 'Acme' });
    expect('country' in parsed).toBe(false);
    expect('address' in parsed).toBe(false);
  });

  it('checks the PAN of a customer created by lead conversion against its country', () => {
    const body = (country: string, panVatNo: string) => ({
      customer: {
        mode: 'create',
        customer: { legalName: 'Himal Foods', panVatNo, country, address },
      },
      contact: {
        mode: 'create',
        contact: {
          fullName: 'Sita',
          email: 'sita@himal.example',
          country: 'NP',
          phones: [npMobile],
        },
      },
      opportunityName: 'Order',
      expectedVersion: 1,
    });
    expect(ConvertLeadBodySchema.safeParse(body('NP', '12345')).success).toBe(false);
    expect(ConvertLeadBodySchema.safeParse(body('US', '12345')).success).toBe(true);
  });

  it('keeps an omitted contact phone list apart from an explicit empty one on conversion (FX9 A2)', () => {
    const body = (phones?: unknown) => ({
      customer: { mode: 'existing', customerId: ID },
      contact: {
        mode: 'create',
        contact: {
          fullName: 'Sita',
          email: 'sita@himal.example',
          country: 'NP',
          ...(phones === undefined ? {} : { phones }),
        },
      },
      opportunityName: 'Order',
      expectedVersion: 1,
    });
    const contactOf = (parsed: ReturnType<typeof ConvertLeadBodySchema.parse>) =>
      parsed.contact.mode === 'create' ? parsed.contact.contact : undefined;
    // Omitted: the API copies the lead's numbers. Empty: the user removed them all.
    const omitted = contactOf(ConvertLeadBodySchema.parse(body()));
    expect(omitted).toBeDefined();
    expect('phones' in omitted!).toBe(false);
    expect(contactOf(ConvertLeadBodySchema.parse(body([])))?.phones).toEqual([]);
    for (const [, phones] of brokenLists) {
      expect(ConvertLeadBodySchema.safeParse(body(phones)).success).toBe(false);
    }
  });
});

describe('leads: a country, several phones, and an email or a phone (FX9)', () => {
  const lead = {
    title: 'Rooftop',
    source: 'referral',
    companyName: 'Himal Traders',
    contactName: 'Sita Rai',
    country: 'NP',
  };

  it('refuses a lead with no email and no phones, and takes one with either', () => {
    const refused = CreateLeadBodySchema.safeParse(lead);
    expect(refused.success).toBe(false);
    expect(issuePaths(refused)).toEqual(['email']);
    expect(CreateLeadBodySchema.safeParse({ ...lead, phones: [] }).success).toBe(false);
    expect(CreateLeadBodySchema.safeParse({ ...lead, email: 'sita@himal.example' }).success).toBe(
      true,
    );
    expect(CreateLeadBodySchema.safeParse({ ...lead, phones: [npMobile, usWork] }).success).toBe(
      true,
    );
  });

  it('needs a lead country, and keeps phones and country out of an edit that does not send them', () => {
    const { country: _none, ...noCountry } = lead;
    expect(
      CreateLeadBodySchema.safeParse({ ...noCountry, email: 'sita@himal.example' }).success,
    ).toBe(false);
    const parsed = UpdateLeadBodySchema.parse({ expectedVersion: 1, title: 'New title' });
    expect('phones' in parsed).toBe(false);
    expect('country' in parsed).toBe(false);
  });

  it('D9: takes an optional address on create and edit, null clearing it on edit, never half of one', () => {
    const base = {
      title: 'Rooftop',
      source: 'referral',
      companyName: 'Himal',
      contactName: 'Sita',
      country: 'NP',
      email: 'sita@himal.example',
    };
    const address = { line: ' 12 Lazimpat Road ', city: 'Kathmandu' };
    expect(CreateLeadBodySchema.parse(base)).not.toHaveProperty('address');
    expect(CreateLeadBodySchema.parse({ ...base, address }).address).toEqual({
      line: '12 Lazimpat Road',
      city: 'Kathmandu',
    });
    expect(
      CreateLeadBodySchema.safeParse({ ...base, address: { city: 'Kathmandu' } }).success,
    ).toBe(false);
    expect(UpdateLeadBodySchema.parse({ expectedVersion: 1, address: null }).address).toBeNull();
    expect(UpdateLeadBodySchema.parse({ expectedVersion: 1, title: 'x' })).not.toHaveProperty(
      'address',
    );
  });

  it('has a lead DTO with a country and its phones', () => {
    const dto = {
      id: ID,
      number: 'LD-2026-0001',
      title: 'Rooftop',
      source: 'referral',
      campaign: null,
      ownerUserId: null,
      ownerName: null,
      companyName: 'Himal Traders',
      contactName: 'Sita Rai',
      country: 'NP',
      address: null,
      email: null,
      phones: [npMobile, usWork],
      customerId: null,
      contactId: null,
      requirement: null,
      expectedValue: null,
      currency: 'NPR',
      probability: null,
      expectedClose: null,
      nextFollowUpAt: null,
      stage: 'new',
      stageReason: null,
      lostReason: null,
      stageNote: null,
      convertedOpportunityId: null,
      version: 1,
      createdAt: AT,
      updatedAt: AT,
    };
    expect(LeadDtoSchema.parse(dto).phones).toHaveLength(2);
    // D9: the address is the street lines and city together, or null; a DTO without the key is not a lead.
    const address = { line: '12 Lazimpat Road', city: 'Kathmandu' };
    expect(LeadDtoSchema.parse({ ...dto, address }).address).toEqual(address);
    expect(LeadDtoSchema.safeParse({ ...dto, address: { line: '12 Lazimpat Road' } }).success).toBe(
      false,
    );
    const { address: _omitted, ...without } = dto;
    expect(LeadDtoSchema.safeParse(without).success).toBe(false);
    // The list invariants hold on the response too (FX9 A2).
    for (const [, phones] of brokenLists) {
      expect(LeadDtoSchema.safeParse({ ...dto, phones }).success).toBe(false);
    }
  });

  it('accepts a website lead with a US number and refuses a short Nepal one', () => {
    const ingest = { companyName: 'Acme', contactName: 'Jo' };
    expect(LeadIngestBodySchema.safeParse({ ...ingest, phone: '+14155552671' }).success).toBe(true);
    const short = LeadIngestBodySchema.safeParse({ ...ingest, phone: '+977123' });
    expect(short.success).toBe(false);
    expect(issuePaths(short)).toEqual(['phone']);
    // A +1 number that is no real number is refused by its derived country's rules.
    expect(LeadIngestBodySchema.safeParse({ ...ingest, phone: '+11234567890' }).success).toBe(
      false,
    );
  });
});

describe('vendors: an optional three-field address and contacts with phones (FX9)', () => {
  const vendor = {
    legalName: 'Everest Supplies',
    kind: 'company',
    pan: '123456789',
    vatRegistered: true,
    country: 'NP',
  };

  it('takes a vendor with no address or a full one, and refuses an address with only a line', () => {
    expect(CreateVendorBodySchema.safeParse(vendor).success).toBe(true);
    expect(CreateVendorBodySchema.safeParse({ ...vendor, address }).success).toBe(true);
    const lineOnly = CreateVendorBodySchema.safeParse({
      ...vendor,
      address: { line: 'Teku Road' },
    });
    expect(lineOnly.success).toBe(false);
    expect(issuePaths(lineOnly)).toEqual(['address.city']);
  });

  it('still lets only a foreign vendor leave the PAN out', () => {
    const { pan: _none, ...noPan } = vendor;
    expect(
      CreateVendorBodySchema.safeParse({ ...noPan, kind: 'foreign', country: 'DE' }).success,
    ).toBe(true);
    const resident = CreateVendorBodySchema.safeParse(noPan);
    expect(resident.success).toBe(false);
    expect(issuePaths(resident)).toEqual(['pan']);
  });

  it('gives a vendor contact a country and phones instead of one phone', () => {
    const contact = { name: 'Hari', country: 'NP', phones: [npMobile] };
    expect(VendorContactBodySchema.safeParse(contact).success).toBe(true);
    expect(VendorContactBodySchema.parse({ name: 'Hari', country: 'NP' }).phones).toEqual([]);
    expect(
      VendorContactBodySchema.safeParse({ name: 'Hari', country: 'NP', phone: '+9779812345678' })
        .success,
    ).toBe(false);
  });

  it('exposes the vendor address, or null', () => {
    const dto = {
      id: ID,
      legalName: 'Everest Supplies',
      tradeName: null,
      kind: 'company',
      pan: '123456789',
      vatRegistered: true,
      country: 'NP',
      address: null,
      status: 'draft',
      version: 1,
      approvedAt: null,
    };
    expect(VendorDtoSchema.safeParse(dto).success).toBe(true);
    expect(VendorDtoSchema.safeParse({ ...dto, address }).success).toBe(true);
  });
});
