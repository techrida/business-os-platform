import { describe, expect, it } from 'vitest';

import { hasPermission, permissionChecker } from './permissions';

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
