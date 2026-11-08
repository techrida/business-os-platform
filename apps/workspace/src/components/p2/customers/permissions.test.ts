import { describe, expect, it } from 'vitest';

import { hasPermission, permissionChecker } from './permissions';

describe('hasPermission', () => {
  it('denies every P2 permission to every role until the contracts grant it (deny by default)', () => {
    for (const role of ['founder', 'management', 'finance', 'accountant', 'sales']) {
      expect(hasPermission([role], 'customer.read'), role).toBe(false);
      expect(hasPermission([role], 'verification.review'), role).toBe(false);
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
