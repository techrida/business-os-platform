// Unit tests of the vendor portal caller (K4): only a vendor principal with a party passes, and the capability a
// vendor status gives decides which portal actions it may take. Done check 13: a pending_kyc vendor is refused
// purchase orders (403) but may still upload its KYC documents.
import type { Permission, Scope, VendorStatus } from '@bos/contracts';
import { ForbiddenException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';

import type { Principal } from '../../platform/authz/principal';
import {
  assertVendorCapability,
  assertVendorCaller,
  vendorPortalAccess,
  type VendorPortalNeed,
} from './vendor-portal.caller';

const VENDOR = '00000000-0000-4000-8000-0000000000e1';

function principalOf(overrides: Partial<Principal> = {}): Principal {
  return {
    userId: 'vendor-user-1',
    zitadelUserId: 'z-vendor-1',
    tenantId: '00000000-0000-4000-8000-000000000001',
    organizationId: '00000000-0000-4000-8000-000000000002',
    orgKind: 'vendor',
    partyId: VENDOR,
    idpOrgId: 'idp-v',
    roles: ['vendor_user'],
    departmentId: null,
    status: 'active',
    grants: new Map<Permission, Scope>([['portal.vendor.read', 'customer_org']]),
    ...overrides,
  };
}

const forbidden = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ForbiddenException);
    expect((error as ForbiddenException).getResponse()).toEqual({
      code: 'forbidden',
      message: 'Forbidden',
      reason: 'no_permission',
    });
    return;
  }
  throw new Error('expected a 403');
};

describe('assertVendorCaller', () => {
  it('returns the vendor party id of a vendor principal', () => {
    expect(assertVendorCaller(principalOf())).toBe(VENDOR);
  });

  it.each<Partial<Principal>>([
    { orgKind: 'customer' },
    { orgKind: 'staff', partyId: null },
    { partyId: null },
    { partyId: '' },
  ])('answers 403 for %o', (over) => {
    forbidden(() => assertVendorCaller(principalOf(over)));
  });
});

describe('vendor portal capability', () => {
  it('reports onboarding-only access for a pending_kyc vendor', () => {
    expect(vendorPortalAccess(principalOf(), 'pending_kyc')).toEqual({
      vendorPartyId: VENDOR,
      capability: 'onboarding_only',
    });
  });

  it('refuses a pending_kyc vendor purchase orders but lets it upload KYC documents', () => {
    const { capability } = vendorPortalAccess(principalOf(), 'pending_kyc');
    forbidden(() => assertVendorCapability(capability, 'read'));
    forbidden(() => assertVendorCapability(capability, 'submit'));
    expect(() => assertVendorCapability(capability, 'onboarding')).not.toThrow();
  });

  const table: Array<[VendorStatus, Record<VendorPortalNeed, boolean>]> = [
    ['draft', { onboarding: true, read: false, submit: false }],
    ['pending_kyc', { onboarding: true, read: false, submit: false }],
    ['under_review', { onboarding: true, read: false, submit: false }],
    ['approved', { onboarding: true, read: true, submit: true }],
    ['suspended', { onboarding: true, read: true, submit: false }],
    ['blocked', { onboarding: false, read: false, submit: false }],
    ['archived', { onboarding: false, read: false, submit: false }],
  ];
  it.each(table)('a %s vendor may %o', (status, allowed) => {
    const { capability } = vendorPortalAccess(principalOf(), status);
    for (const need of ['onboarding', 'read', 'submit'] as const) {
      if (allowed[need]) expect(() => assertVendorCapability(capability, need)).not.toThrow();
      else forbidden(() => assertVendorCapability(capability, need));
    }
  });

  it('checks the caller before it looks at the status', () => {
    forbidden(() => vendorPortalAccess(principalOf({ orgKind: 'customer' }), 'approved'));
  });
});
