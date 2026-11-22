// U12: people and companies carry a pointer to their picture document. Each pointer is additive: a DTO without it
// (an older server) still parses, null means "no picture", and anything but a uuid is refused.
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';

import { AdminUserSchema } from './admin-users.js';
import { PersonNameSchema } from './approvals.js';
import {
  CustomerDtoSchema,
  LeadOwnerOptionSchema,
  VerificationReviewHistorySchema,
} from './crm.js';
import { MeResponseSchema } from './me.js';
import { MemoDirectoryPersonSchema, MemoListItemSchema } from './memo.js';
import { QuotationListItemSchema } from './quotations.js';
import { VendorDtoSchema } from './vendors.js';

const ID = '3f0c5a52-7c2e-4d0b-9a55-0e8d1d6a3b11';
const DOC = '7a1e2b3c-4d5e-4f60-8a7b-8c9d0e1f2a3b';
const AT = '2026-11-19T08:00:00.000Z';

/** A whole DTO without its picture pointer, and the key that carries it. */
const whole: [string, z.ZodType, Record<string, unknown>, string][] = [
  [
    'AdminUser',
    AdminUserSchema,
    {
      id: ID,
      idpOrgId: ID,
      email: 'sita@example.test',
      displayName: 'Sita',
      status: 'active',
      roles: ['sales'],
      department: null,
      createdAt: AT,
      lastActiveAt: null,
    },
    'avatarDocumentId',
  ],
  [
    'MeResponse',
    MeResponseSchema,
    {
      userId: '312345678901234567',
      tenantId: ID,
      organizationId: ID,
      orgKind: 'staff',
      partyId: null,
      roles: ['sales'],
      correlationId: 'corr-12345678',
    },
    'avatarDocumentId',
  ],
  [
    'CustomerDto',
    CustomerDtoSchema,
    {
      id: ID,
      number: 'CUS-0001',
      legalName: 'Himal Traders',
      panVatNo: null,
      industry: null,
      relationship: 'prospect',
      ownerUserId: null,
      defaultCurrency: null,
      country: 'NP',
      address: { line: 'Durbar Marg', city: 'Kathmandu' },
      mergedIntoId: null,
      version: 1,
      createdAt: AT,
      updatedAt: AT,
    },
    'logoDocumentId',
  ],
  [
    'VendorDto',
    VendorDtoSchema,
    {
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
    },
    'logoDocumentId',
  ],
  [
    'LeadOwnerOption',
    LeadOwnerOptionSchema,
    { userId: ID, displayName: 'Sita', email: 'sita@example.test' },
    'avatarDocumentId',
  ],
  ['PersonName', PersonNameSchema, { userId: ID, name: 'Sita' }, 'avatarDocumentId'],
  [
    'MemoDirectoryPerson',
    MemoDirectoryPersonSchema,
    { userId: ID, name: 'Sita', jobTitle: null, department: null, canApprove: true },
    'avatarDocumentId',
  ],
  [
    'MemoListItem',
    MemoListItemSchema,
    {
      id: ID,
      number: 'MEMO-1',
      title: 'Budget',
      status: 'draft',
      amount: '10.00',
      currency: 'NPR',
      ownerUserId: ID,
      ownerName: 'Sita',
      departmentName: null,
      createdAt: AT,
      updatedAt: AT,
    },
    'ownerAvatarDocumentId',
  ],
];

describe('picture pointers on DTOs', () => {
  describe.each(whole)('%s', (_name, schema, base, key) => {
    it('parses without the pointer (an older server) and with null', () => {
      expect(schema.safeParse(base).success).toBe(true);
      expect(schema.parse({ ...base, [key]: null })).toMatchObject({ [key]: null });
    });

    it('keeps a document id and refuses anything but a uuid', () => {
      expect(schema.parse({ ...base, [key]: DOC })).toMatchObject({ [key]: DOC });
      expect(schema.safeParse({ ...base, [key]: 'logo.png' }).success).toBe(false);
    });
  });

  // These two DTOs are large; their pointer field is checked on its own.
  it.each([
    [
      'QuotationListItem.ownerAvatarDocumentId',
      QuotationListItemSchema.shape.ownerAvatarDocumentId,
    ],
    [
      'VerificationReviewHistory item.reviewerAvatarDocumentId',
      VerificationReviewHistorySchema.shape.items.element.shape.reviewerAvatarDocumentId,
    ],
  ])('%s is an optional, nullable uuid', (_name, field) => {
    expect(field.safeParse(undefined).success).toBe(true);
    expect(field.safeParse(null).success).toBe(true);
    expect(field.safeParse(DOC).success).toBe(true);
    expect(field.safeParse('logo.png').success).toBe(false);
  });
});
