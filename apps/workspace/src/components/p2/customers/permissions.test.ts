import { describe, expect, it } from 'vitest';

import type { Grants } from '@/lib/grants';

import { hasPermission, isLiveGrants, permissionChecker } from './permissions';

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

  it('denies everything when no grants came back (a failed /v1/me)', () => {
    const none: Grants = new Map();
    expect(hasPermission(none, 'customer.read')).toBe(false);
    expect(isLiveGrants(none)).toBe(true);
    expect(isLiveGrants(['sales'])).toBe(false);
  });
});
