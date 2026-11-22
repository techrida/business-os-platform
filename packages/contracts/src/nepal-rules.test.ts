import { describe, expect, it } from 'vitest';

import {
  ConvertLeadBodySchema,
  CreateCustomerBodySchema,
  PhoneSchema,
  UpdateCustomerBodySchema,
  nepalPanProblem,
} from './crm.js';
import {
  CompanyProfileSchema,
  SnapshotCompanyProfileSchema,
  StoredCompanyProfileSchema,
  documentSellerContact,
  formatPhoneForPrint,
} from './document-style.js';
import { SETTINGS, StoredEntityPanVatNoSchema } from './settings.js';
import { VendorPanSchema } from './vendors.js';

const address = (country: string) => ({ line1: 'Baneshwor', city: 'Kathmandu', country });
const contact = { fullName: 'Sita Rai', email: 'sita@example.com' };

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
      address: address(country),
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
    const body = { expectedVersion: 1, panVatNo: '12345', address: address('NP') };
    expect(UpdateCustomerBodySchema.safeParse(body).success).toBe(false);
    expect(UpdateCustomerBodySchema.safeParse({ ...body, address: address('IN') }).success).toBe(
      true,
    );
    expect(
      UpdateCustomerBodySchema.safeParse({ expectedVersion: 1, panVatNo: '12345' }).success,
    ).toBe(true);
  });

  it('applies the same rule to a customer created by lead conversion', () => {
    const body = (country: string, panVatNo: string) => ({
      customer: {
        mode: 'create' as const,
        customer: { legalName: 'Himal Foods', panVatNo, address: address(country) },
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
  const profile = {
    displayName: 'Techrida',
    phones: ['+9779812345678', '+97714123456'],
    email: null,
    website: null,
    panVatNo: '123456789',
    signatoryName: null,
    signatoryTitle: null,
    logoDocumentId: null,
  };
  const legacy = { ...profile, phones: ['01-4123456', 'office'], panVatNo: '12-34567' };

  it('writes E.164 phones and a nine-digit PAN', () => {
    expect(CompanyProfileSchema.safeParse(profile).success).toBe(true);
    expect(CompanyProfileSchema.safeParse(legacy).success).toBe(false);
    expect(CompanyProfileSchema.safeParse({ ...profile, phones: ['+9778123456789'] }).success).toBe(
      false,
    );
    expect(CompanyProfileSchema.safeParse({ ...profile, panVatNo: 'AB12345' }).success).toBe(false);
  });

  it('still reads a legacy row, so no screen or render fails on it', () => {
    expect(StoredCompanyProfileSchema.safeParse(legacy).success).toBe(true);
    expect(documentSellerContact(legacy)?.phones).toEqual(['01-4123456', 'office']);
  });

  it('keeps a snapshot frozen before the strict rules readable', () => {
    const snapshot = { ...legacy, logoDataUrl: null };
    const { logoDocumentId: _ignored, ...rest } = snapshot;
    expect(SnapshotCompanyProfileSchema.safeParse(rest).success).toBe(true);
  });

  it('holds the entity PAN setting to nine digits on a write only', () => {
    expect(SETTINGS['entity.pan_vat_no'].safeParse('123456789').success).toBe(true);
    expect(SETTINGS['entity.pan_vat_no'].safeParse('12345').success).toBe(false);
    expect(SETTINGS['entity.pan_vat_no'].safeParse(null).success).toBe(true);
    expect(StoredEntityPanVatNoSchema.safeParse('12-34567').success).toBe(true);
    expect(VendorPanSchema.safeParse('12345').success).toBe(false);
  });
});

describe('formatPhoneForPrint', () => {
  it.each([
    ['+9779812345678', '+977 9812345678'],
    ['+97714123456', '+977 1-4123456'],
    ['+97761523456', '+977 61-523456'],
    ['+14155552671', '+14155552671'],
    ['01-4123456', '01-4123456'],
    ['+977 1-4123456', '+977 1-4123456'],
    ['+977123', '+977123'],
  ])('%s prints as %s', (given, printed) => {
    expect(formatPhoneForPrint(given)).toBe(printed);
  });
});
