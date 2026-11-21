// What a caller may do with one customer (`can` on GET /v1/customers/:id), decided by the real pure can() on the
// default grants of each role. Audit #6: Sales were shown "Start verification" on customers they do not own, and
// the API then refused the create (verification.read is `own` for sales); the flag now says no for that record.
import {
  DEFAULT_ROLE_PERMISSIONS,
  type Permission,
  type RoleKey,
  type Scope,
} from '@bos/contracts';
import { describe, expect, it } from 'vitest';

import { type Principal } from '../../platform/authz/principal';
import { customerCapabilities, customerPortalAccess } from './customers.service';

const TENANT = '11111111-1111-4111-8111-111111111111';
const ENTITY = '22222222-2222-4222-8222-222222222222';
const ME = '33333333-3333-4333-8333-333333333333';
const COLLEAGUE = '44444444-4444-4444-8444-444444444444';
const CUSTOMER = '55555555-5555-4555-8555-555555555555';

const as = (role: RoleKey, over: Partial<Principal> = {}): Principal => ({
  userId: ME,
  zitadelUserId: 'z-me',
  tenantId: TENANT,
  organizationId: ENTITY,
  orgKind: 'staff',
  partyId: null,
  idpOrgId: '66666666-6666-4666-8666-666666666666',
  roles: [role],
  departmentId: null,
  status: 'active',
  grants: new Map(Object.entries(DEFAULT_ROLE_PERMISSIONS[role])) as Map<Permission, Scope>,
  ...over,
});
const customer = (ownerUserId: string | null, mergedIntoId: string | null = null) => ({
  tenantId: TENANT,
  id: CUSTOMER,
  ownerUserId,
  mergedIntoId,
});

describe('customerCapabilities', () => {
  it('lets Sales start verification on a customer they own', () => {
    expect(customerCapabilities(customer(ME), as('sales'))).toEqual({
      write: true,
      readVerification: true,
      openVerification: true,
      creditLimit: false,
      owner: false,
      paymentTerms: true,
    });
  });

  it("does not offer Sales verification on a colleague's customer, though they may still edit it", () => {
    expect(customerCapabilities(customer(COLLEAGUE), as('sales'))).toEqual({
      write: true,
      readVerification: false,
      openVerification: false,
      creditLimit: false,
      owner: false,
      paymentTerms: true,
    });
    expect(customerCapabilities(customer(null), as('sales')).openVerification).toBe(false);
  });

  it('reads every case for pmo, who holds no customer.write and so cannot start one', () => {
    expect(customerCapabilities(customer(COLLEAGUE), as('pmo'))).toEqual({
      write: false,
      readVerification: true,
      openVerification: false,
      creditLimit: false,
      owner: false,
      paymentTerms: false,
    });
  });

  it('never offers a case on a merged customer, and answers a live grant change', () => {
    expect(customerCapabilities(customer(ME, CUSTOMER), as('sales')).openVerification).toBe(false);
    // An admin widened verification.read to all for sales: the colleague's customer opens now.
    const widened = as('sales');
    (widened.grants as Map<Permission, Scope>).set('verification.read', 'all');
    expect(customerCapabilities(customer(COLLEAGUE), widened).openVerification).toBe(true);
  });

  it('gives a portal caller or an inactive user nothing', () => {
    const portal = as('sales', { orgKind: 'customer', partyId: CUSTOMER });
    expect(customerCapabilities(customer(ME), portal).write).toBe(false);
    expect(customerCapabilities(customer(ME), portal).openVerification).toBe(false);
    expect(customerCapabilities(customer(ME), as('sales', { status: 'inactive' }))).toEqual({
      write: false,
      readVerification: false,
      openVerification: false,
      creditLimit: false,
      owner: false,
      paymentTerms: false,
    });
  });
});

describe('customerCapabilities: commercial terms (R4a Q12, R4c2 Q5a)', () => {
  const terms = (p: Principal) => {
    const c = customerCapabilities(customer(COLLEAGUE), p);
    return { creditLimit: c.creditLimit, owner: c.owner, paymentTerms: c.paymentTerms };
  };

  it.each([
    ['founder', { creditLimit: true, owner: true, paymentTerms: true }],
    ['finance', { creditLimit: true, owner: false, paymentTerms: false }],
    ['management', { creditLimit: false, owner: true, paymentTerms: false }],
    ['sales', { creditLimit: false, owner: false, paymentTerms: true }],
    ['accountant', { creditLimit: false, owner: false, paymentTerms: false }],
    ['marketing', { creditLimit: false, owner: false, paymentTerms: false }],
  ] as const)('%s holds the default flags', (role, expected) => {
    expect(terms(as(role))).toEqual(expected);
  });

  it('gives a portal caller holding the grants by mistake, or an inactive Founder, none of them', () => {
    const portal = as('founder', { orgKind: 'customer', partyId: CUSTOMER });
    expect(terms(portal)).toEqual({ creditLimit: false, owner: false, paymentTerms: false });
    expect(terms(as('founder', { status: 'inactive' }))).toEqual({
      creditLimit: false,
      owner: false,
      paymentTerms: false,
    });
  });
});

describe('customerPortalAccess (F1-Q31: the account owner invites the first portal admin)', () => {
  const access = (
    row: ReturnType<typeof customer>,
    p: Principal,
    hasUser: boolean,
    kyb: string | null = 'approved',
  ) => customerPortalAccess(row, p, customerCapabilities(row, p), hasUser, kyb);

  it('offers the first invite to the account owner only', () => {
    expect(access(customer(ME), as('sales'), false)).toEqual({
      hasUser: false,
      canInvite: true,
      blocked: null,
    });
    // A founder holds customer.write on every customer, but is not this one's owner.
    expect(access(customer(COLLEAGUE), as('founder'), false)).toMatchObject({
      canInvite: false,
      blocked: 'owner_only',
    });
    expect(access(customer(null), as('founder'), false)).toMatchObject({
      canInvite: false,
      blocked: 'owner_missing',
    });
  });

  it('offers later invites to anyone holding customer.write on the record', () => {
    expect(access(customer(COLLEAGUE), as('founder'), true)).toEqual({
      hasUser: true,
      canInvite: true,
      blocked: null,
    });
    // No customer.write: no invite, and no reason told.
    expect(access(customer(COLLEAGUE), as('pmo'), true)).toEqual({
      hasUser: true,
      canInvite: false,
      blocked: null,
    });
  });

  it('offers no invite until the KYB case is approved, after the owner rule', () => {
    for (const kyb of [null, 'draft', 'submitted', 'rejected']) {
      expect(access(customer(ME), as('sales'), false, kyb)).toMatchObject({
        canInvite: false,
        blocked: 'kyb_not_verified',
      });
    }
    expect(access(customer(COLLEAGUE), as('founder'), false, null).blocked).toBe('owner_only');
  });

  it('never offers an invite on a merged customer or to a portal caller', () => {
    expect(access(customer(ME, CUSTOMER), as('sales'), true).canInvite).toBe(false);
    expect(
      access(customer(ME), as('founder', { orgKind: 'customer', partyId: CUSTOMER }), true)
        .canInvite,
    ).toBe(false);
  });
});
