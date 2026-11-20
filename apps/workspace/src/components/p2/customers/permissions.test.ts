import { describe, expect, it } from 'vitest';

import type { Grants } from '@/lib/grants';

import { grantsFrom, hasPermission, isLiveGrants, permissionChecker } from './permissions';

describe('hasPermission', () => {
  it('denies a permission no role grants (deny by default), whatever the role', () => {
    for (const role of ['founder', 'management', 'finance', 'accountant', 'sales']) {
      expect(hasPermission([role], 'not.a.real.permission'), role).toBe(false);
    }
  });

  it('denies an unknown role, and no roles at all', () => {
    expect(hasPermission(['not-a-role'], 'customer.read')).toBe(false);
    expect(hasPermission([], 'customer.read')).toBe(false);
  });

  it('does not treat inherited object keys as roles', () => {
    expect(hasPermission(['constructor', 'toString', '__proto__'], 'customer.read')).toBe(false);
  });

  it('allows a permission once a role carries a grant for it', () => {
    const grants = { pmo: { 'verification.review': 'all' }, sales: { 'customer.read': 'own' } };
    expect(hasPermission(['pmo'], 'verification.review', grants)).toBe(true);
    expect(hasPermission(['sales'], 'verification.review', grants)).toBe(false);
    expect(hasPermission(['sales', 'pmo'], 'verification.review', grants)).toBe(true);
  });

  it('gives the nav a predicate bound to the roles', () => {
    const can = permissionChecker(['sales'], { sales: { 'customer.read': 'own' } });
    expect(can('customer.read')).toBe(true);
    expect(can('customer.write')).toBe(false);
  });
});

// The saved grants (what `getGrants` reads from /v1/me) decide, not the built-in role defaults.
describe('hasPermission with live grants', () => {
  it('allows a permission an admin granted that no default carries', () => {
    expect(hasPermission(['sales'], 'vendor.write')).toBe(false);
    const live: Grants = new Map([['vendor.write', 'all']]);
    expect(hasPermission(live, 'vendor.write')).toBe(true);
    expect(permissionChecker(live)('vendor.write')).toBe(true);
  });

  it('denies a permission an admin removed that the defaults still carry', () => {
    expect(hasPermission(['sales'], 'customer.write')).toBe(true);
    const live: Grants = new Map([['customer.read', 'own']]);
    expect(hasPermission(live, 'customer.write')).toBe(false);
    expect(permissionChecker(live)('customer.write')).toBe(false);
  });

  it('grantsFrom reads the /v1/me grants, and falls back to the roles only when there are none', () => {
    const live = grantsFrom(
      { permissions: [{ permission: 'procurement.pr.read', scope: 'all' }] },
      ['sales'],
    );
    expect(isLiveGrants(live)).toBe(true);
    expect(hasPermission(live, 'procurement.pr.read')).toBe(true);
    // A removed grant stays removed even though the sales defaults carry it.
    expect(hasPermission(live, 'customer.write')).toBe(false);
    expect(hasPermission(grantsFrom({ permissions: [] }, ['sales']), 'customer.write')).toBe(false);
    // A failed read (null) or a response without the list stands in the role defaults.
    expect(grantsFrom(null, ['sales'])).toEqual(['sales']);
    expect(grantsFrom({}, ['sales'])).toEqual(['sales']);
  });

  it('denies everything when the live grants are empty', () => {
    const none: Grants = new Map();
    expect(hasPermission(none, 'customer.read')).toBe(false);
    expect(isLiveGrants(none)).toBe(true);
    expect(isLiveGrants(['sales'])).toBe(false);
  });
});
