import { describe, expect, it } from 'vitest';

import {
  ConvertLeadBodySchema,
  CreateCustomerBodySchema,
  PhoneSchema,
  UpdateCustomerBodySchema,
  nepalPanProblem,
} from './crm.js';
import * as documentStyle from './document-style.js';
import {
  CompanyProfileSchema,
  SnapshotCompanyProfileSchema,
  documentSellerContact,
  formatPhoneForPrint,
  snapshotProfileFrom,
} from './document-style.js';
import * as settings from './settings.js';
import { SETTINGS } from './settings.js';
import { VendorPanSchema } from './vendors.js';

const address = { line: 'Baneshwor', city: 'Kathmandu' };
const contact = { fullName: 'Sita Rai', email: 'sita@example.com', country: 'NP' };

describe('PhoneSchema, Nepal numbers', () => {
  it.each(['+9779812345678', '+97714123456', '+9776152345'])('accepts %s', (phone) => {
    expect(PhoneSchema.safeParse(phone).success).toBe(true);
  });

  it.each([
    ['a mobile that does not start with 9', '+9778123456789'],
    ['a mobile with a leading 0 left in', '+97709812345678'],
    ['a national number of 6 digits', '+977123456'],
    ['a national number of 11 digits', '+97798123456789'],
    ['a landline with a trunk 0', '+977014123456'],
    ['a 7-digit number starting with 9', '+9779812345'],
    ['a 9-digit number starting with 9', '+977981234567'],
  ])('refuses %s', (_why, phone) => {
    expect(PhoneSchema.safeParse(phone).success).toBe(false);
  });

  it('leaves a number from another country to the generic E.164 rule', () => {
    expect(PhoneSchema.safeParse('+14155552671').success).toBe(true);
    expect(PhoneSchema.safeParse('+919876543210').success).toBe(true);
    expect(PhoneSchema.safeParse('9876543210').success).toBe(false);
  });
});

describe('Nepal PAN on a customer', () => {
  const create = (country: string, panVatNo: string) =>
    CreateCustomerBodySchema.safeParse({
      legalName: 'Himal Foods',
      panVatNo,
      country,
      address,
      contact,
    });

  it('requires nine digits when the customer is in Nepal', () => {
    expect(create('NP', '123456789').success).toBe(true);
    const short = create('NP', '12345');
    expect(short.success).toBe(false);
    expect(short.error?.issues[0]?.path).toEqual(['panVatNo']);
    expect(create('NP', 'AB-12345').success).toBe(false);
  });

  it('keeps the loose foreign tax id for a customer abroad', () => {
    expect(create('IN', 'AAACH1234C').success).toBe(true);
    expect(create('US', '12-3456789').success).toBe(true);
  });

  it('applies the same rule on an update that sends both fields', () => {
    const body = { expectedVersion: 1, panVatNo: '12345', country: 'NP' };
    expect(UpdateCustomerBodySchema.safeParse(body).success).toBe(false);
    expect(UpdateCustomerBodySchema.safeParse({ ...body, country: 'IN' }).success).toBe(true);
    expect(
      UpdateCustomerBodySchema.safeParse({ expectedVersion: 1, panVatNo: '12345' }).success,
    ).toBe(true);
  });

  it('applies the same rule to a customer created by lead conversion', () => {
    const body = (country: string, panVatNo: string) => ({
      customer: {
        mode: 'create' as const,
        customer: { legalName: 'Himal Foods', panVatNo, country, address },
      },
      contact: { mode: 'create' as const, contact },
      opportunityName: 'Deal',
      expectedVersion: 1,
    });
    expect(ConvertLeadBodySchema.safeParse(body('NP', '1234')).success).toBe(false);
    expect(ConvertLeadBodySchema.safeParse(body('NP', '123456789')).success).toBe(true);
    expect(ConvertLeadBodySchema.safeParse(body('IN', 'AAACH1234C')).success).toBe(true);
  });

  it('nepalPanProblem judges only a Nepal party that has a PAN', () => {
    expect(nepalPanProblem('NP', undefined)).toBeNull();
    expect(nepalPanProblem('NP', null)).toBeNull();
    expect(nepalPanProblem('NP', '1234')).not.toBeNull();
    expect(nepalPanProblem('IN', '1234')).toBeNull();
    expect(nepalPanProblem(undefined, '1234')).toBeNull();
  });
});

describe('the company profile', () => {
  const npMobile = { country: 'NP', e164: '+9779812345678' };
  const usWork = { country: 'US', e164: '+14155552671', label: 'work' };
  const profile = {
    displayName: 'Techrida',
    phones: [npMobile, { country: 'NP', e164: '+97714123456', label: null }, usWork],
    email: null,
    website: null,
    panVatNo: '123456789',
    signatoryName: null,
    signatoryTitle: null,
    logoDocumentId: null,
  };

  it('reads and writes phones with their own country and a nine-digit PAN', () => {
    expect(CompanyProfileSchema.safeParse(profile).success).toBe(true);
    expect(
      CompanyProfileSchema.safeParse({
        ...profile,
        phones: [npMobile, { country: 'US', e164: '+14155552671' }],
      }).success,
    ).toBe(true);
    expect(CompanyProfileSchema.safeParse({ ...profile, panVatNo: 'AB12345' }).success).toBe(false);
    expect(CompanyProfileSchema.safeParse({ ...profile, panVatNo: '12-34567' }).success).toBe(
      false,
    );
  });

  it('refuses a number that is not valid for its country', () => {
    const usAsNepal = CompanyProfileSchema.safeParse({
      ...profile,
      phones: [{ country: 'NP', e164: '+14155552671' }],
    });
    expect(usAsNepal.success).toBe(false);
    expect(usAsNepal.error?.issues[0]?.path).toEqual(['phones', 0, 'e164']);
    expect(
      CompanyProfileSchema.safeParse({
        ...profile,
        phones: [{ country: 'NP', e164: '+9778123456789' }],
      }).success,
    ).toBe(false);
    expect(
      CompanyProfileSchema.safeParse({
        ...profile,
        phones: [{ country: 'NP', e164: '+977 9812345678' }],
      }).success,
    ).toBe(false);
  });

  it('refuses the FX8 shape: bare string phones, a primary flag, more than four numbers', () => {
    expect(CompanyProfileSchema.safeParse({ ...profile, phones: ['+9779812345678'] }).success).toBe(
      false,
    );
    expect(
      CompanyProfileSchema.safeParse({ ...profile, phones: [{ ...npMobile, isPrimary: true }] })
        .success,
    ).toBe(false);
    expect(
      CompanyProfileSchema.safeParse({
        ...profile,
        phones: [
          '+9779812345671',
          '+9779812345672',
          '+9779812345673',
          '+9779812345674',
          '+9779812345675',
        ].map((e164) => ({ country: 'NP', e164 })),
      }).success,
    ).toBe(false);
  });

  it('no longer exports the tolerant FX8 read schemas', () => {
    expect('StoredCompanyProfileSchema' in documentStyle).toBe(false);
    expect('StoredEntityPanVatNoSchema' in settings).toBe(false);
  });

  it('snapshots each phone as its E.164 number', () => {
    const parsed = CompanyProfileSchema.parse(profile);
    const snapshot = snapshotProfileFrom(parsed, null);
    expect(snapshot.phones).toEqual(['+9779812345678', '+97714123456', '+14155552671']);
    expect(SnapshotCompanyProfileSchema.safeParse(snapshot).success).toBe(true);
  });

  it('keeps a snapshot frozen before the strict rules readable', () => {
    const snapshot = {
      displayName: 'Techrida',
      logoDataUrl: null,
      phones: ['+977 9812345678', '01-4123456', 'office'],
      email: null,
      website: null,
      panVatNo: '12-34567',
      signatoryName: null,
      signatoryTitle: null,
    };
    expect(SnapshotCompanyProfileSchema.safeParse(snapshot).success).toBe(true);
  });

  it('prints the seller contact phones, a foreign one in international format', () => {
    expect(documentSellerContact(profile)?.phones).toEqual([
      '+977 9812345678',
      '+977 1-4123456',
      '+1 415 555 2671',
    ]);
    expect(documentSellerContact(profile)?.phones.map(formatPhoneForPrint)).toEqual(
      documentSellerContact(profile)?.phones,
    );
  });

  it('prints no seller contact for a profile stored with FX8 string phones', () => {
    expect(documentSellerContact({ ...profile, phones: ['+9779812345678'] })).toBeNull();
  });

  it('holds the entity PAN setting to nine digits', () => {
    expect(SETTINGS['entity.pan_vat_no'].safeParse('123456789').success).toBe(true);
    expect(SETTINGS['entity.pan_vat_no'].safeParse('12345').success).toBe(false);
    expect(SETTINGS['entity.pan_vat_no'].safeParse('12-34567').success).toBe(false);
    expect(SETTINGS['entity.pan_vat_no'].safeParse(null).success).toBe(true);
    expect(VendorPanSchema.safeParse('12345').success).toBe(false);
  });
});

describe('formatPhoneForPrint', () => {
  it.each([
    ['+9779812345678', '+977 9812345678'],
    ['+97714123456', '+977 1-4123456'],
    ['+97761523456', '+977 61-523456'],
    ['+14155552671', '+1 415 555 2671'],
    ['+1 415 555 2671', '+1 415 555 2671'],
    ['+447911123456', '+44 7911 123456'],
    ['01-4123456', '01-4123456'],
    ['+977 1-4123456', '+977 1-4123456'],
    ['+977123', '+977123'],
  ])('%s prints as %s', (given, printed) => {
    expect(formatPhoneForPrint(given)).toBe(printed);
  });
});
