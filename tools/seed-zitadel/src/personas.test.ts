import { ROLE_KEYS } from '@bos/contracts';
import { describe, expect, it } from 'vitest';

import {
  EXTRA_VENDORS,
  PERSONAS,
  PROJECT_ROLES,
  generatePassword,
  passwordsFromFile,
  personaOrgKey,
  personaUsername,
  renderPersonasFile,
  totpSecretsFromFile,
  type PersonaEntry,
} from './personas.js';

describe('generatePassword', () => {
  it('is 24 characters with all four classes every time (ZITADEL default policy)', () => {
    for (let i = 0; i < 300; i++) {
      const pw = generatePassword();
      expect(pw).toHaveLength(24);
      expect(pw).toMatch(/[a-z]/);
      expect(pw).toMatch(/[A-Z]/);
      expect(pw).toMatch(/\d/);
      expect(pw).toMatch(/[^A-Za-z0-9]/);
    }
  });

  it('does not repeat', () => {
    const seen = new Set(Array.from({ length: 200 }, () => generatePassword()));
    expect(seen.size).toBe(200);
  });
});

describe('personas', () => {
  it('has twenty personas: sixteen staff, one customer, three vendors', () => {
    expect(PERSONAS.map((p) => p.orgKind).sort()).toEqual([
      'customer',
      ...Array.from({ length: 16 }, () => 'staff'),
      'vendor',
      'vendor',
      'vendor',
    ]);
    expect(new Set(PERSONAS.map((p) => personaUsername(p.key))).size).toBe(20);
  });

  it('adds a second approved vendor and a vendor awaiting KYC, each in an org of its own, after the staff personas', () => {
    expect(PERSONAS.slice(-2).map((p) => p.key)).toEqual(['vendor2', 'vendorpending']);
    const [second, pending] = PERSONAS.slice(-2);
    expect([second?.role, pending?.role]).toEqual(['vendor_user', 'vendor_user']);
    expect([second?.label, pending?.label]).toEqual(['Vendor 2 (approved)', 'Vendor awaiting KYC']);
    // Own org each: not Dev Vendor Co's, and not each other's.
    const orgKeys = new Set(PERSONAS.filter((p) => p.orgKind === 'vendor').map(personaOrgKey));
    expect(orgKeys).toEqual(new Set(['vendor', 'vendor2', 'vendorpending']));
    expect(EXTRA_VENDORS.map((v) => [v.key, v.status])).toEqual([
      ['vendor2', 'approved'],
      ['vendorpending', 'pending_kyc'],
    ]);
    // Each vendor has its own PAN and party code, and none is the dev vendor's (123456789 / VEND-DEV).
    expect(new Set(EXTRA_VENDORS.map((v) => v.pan)).size).toBe(2);
    for (const v of EXTRA_VENDORS) {
      expect(v.pan).toMatch(/^[0-9]{9}$/);
      expect(v.pan).not.toBe('123456789');
      expect(v.partyCode).not.toBe('VEND-DEV');
    }
  });

  it('keeps the frozen logins first, in their order, and appends the new ones after them', () => {
    // Logins are frozen: Playwright, the account switcher and life-kb Logins use these keys.
    expect(PERSONAS.slice(0, 12).map((p) => p.key)).toEqual([
      'founder',
      'management',
      'finance',
      'sales',
      'customer',
      'vendor',
      'accountant',
      'procurement',
      'warehouse',
      'depthead',
      'management2',
      'finance2',
    ]);
    expect(PERSONAS.slice(12).map((p) => p.key)).toEqual([
      'sales2',
      'salesmgr',
      'saleshead',
      'marketing',
      'marketingmgr',
      'marketinghead',
      'vendor2',
      'vendorpending',
    ]);
  });

  it('adds the Sales and Marketing department people with their department role (D50)', () => {
    const roleOf = new Map(PERSONAS.map((p) => [p.key, p.role]));
    for (const key of ['sales', 'sales2', 'salesmgr', 'saleshead']) {
      expect(roleOf.get(key), key).toBe('sales');
    }
    for (const key of ['marketing', 'marketingmgr', 'marketinghead']) {
      expect(roleOf.get(key), key).toBe('marketing');
    }
    for (const p of PERSONAS.slice(12, -2)) {
      expect(p.orgKind, p.key).toBe('staff');
      expect(p.givenName, p.key).toBe('Dev');
    }
    // The original Sales persona keeps its name, so its label in .dev/personas.json does not change.
    expect(PERSONAS).toContainEqual({
      key: 'sales',
      givenName: 'Dev',
      familyName: 'Sales',
      orgKind: 'staff',
      role: 'sales',
    });
    expect(personaUsername('saleshead')).toBe('saleshead@dev.bos.test');
  });

  it('adds a second Finance user, so a Finance-created note can get an independent Finance approver', () => {
    expect(PERSONAS).toContainEqual({
      key: 'finance2',
      givenName: 'Dev',
      familyName: 'Finance Two',
      orgKind: 'staff',
      role: 'finance',
    });
    expect(personaUsername('finance2')).toBe('finance2@dev.bos.test');
    expect(PERSONAS.filter((p) => p.role === 'finance').map((p) => p.key)).toEqual([
      'finance',
      'finance2',
    ]);
    // Appended after the P4 personas, so the order (and every earlier login) of the existing personas does not change.
    expect(PERSONAS.findIndex((p) => p.key === 'finance2')).toBe(11);
  });

  it('adds the P4 personas: procurement, warehouse, a department head and a second management user', () => {
    const byKey = new Map(PERSONAS.map((p) => [p.key, p]));
    expect(byKey.get('procurement')?.role).toBe('procurement');
    // Receipts are confirmed by warehouse (Kuu D03: there is no receiver role).
    expect(byKey.get('warehouse')?.role).toBe('warehouse');
    // A department head is an ordinary staff user named in departments.head_user_id; the role lets them raise PRs.
    expect(byKey.get('depthead')?.role).toBe('operations_officer');
    // AD8: a Founder's own purchase above 10,00,000 needs two distinct Management approvers.
    expect(byKey.get('management2')?.role).toBe('management');
    expect(PERSONAS.filter((p) => p.role === 'management')).toHaveLength(2);
    for (const key of ['procurement', 'warehouse', 'depthead', 'management2']) {
      expect(byKey.get(key)?.orgKind, key).toBe('staff');
      expect(personaUsername(key)).toBe(`${key}@dev.bos.test`);
    }
    expect(PERSONAS.some((p) => (p.role as string) === 'receiver')).toBe(false);
    for (const p of PERSONAS) expect(PROJECT_ROLES).toContain(p.role);
  });

  it('includes the frozen Accountant persona and its project role', () => {
    expect(PERSONAS).toContainEqual({
      key: 'accountant',
      givenName: 'Dev',
      familyName: 'Accountant',
      orgKind: 'staff',
      role: 'accountant',
    });
    expect(personaUsername('accountant')).toBe('accountant@dev.bos.test');
    expect(PROJECT_ROLES).toContain('accountant');
  });

  it('creates a ZITADEL project role for every role key the API knows (ADR 0027 section 3)', () => {
    // A token can only carry a role ZITADEL has, so a role missing here can never be granted to anyone.
    expect([...PROJECT_ROLES].sort()).toEqual([...ROLE_KEYS].sort());
    for (const role of [
      'pmo',
      'operations_head',
      'procurement',
      'warehouse',
      'operations_officer',
    ]) {
      expect(PROJECT_ROLES).toContain(role);
    }
  });

  it('round-trips TOTP secrets and treats entries without one as unknown', () => {
    const base: PersonaEntry = {
      key: 'sales',
      label: 'Dev Sales',
      orgKind: 'staff',
      role: 'sales',
      username: personaUsername('sales'),
      preferredLoginName: personaUsername('sales'),
      password: 'Abcdefgh1!abcdefgh1!abcd',
    };
    const file = renderPersonasFile([
      { ...base, totpSecret: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ' },
      { ...base, key: 'finance' },
    ]);
    const secrets = totpSecretsFromFile(file);
    expect(secrets.get('sales')).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    expect(secrets.has('finance')).toBe(false);
    expect(totpSecretsFromFile('{not json').size).toBe(0);
    expect(totpSecretsFromFile(undefined).size).toBe(0);
  });

  it('round-trips passwords through the file format and ignores corrupt files', () => {
    const entry: PersonaEntry = {
      key: 'founder',
      label: 'Dev Founder',
      orgKind: 'staff',
      role: 'founder',
      username: personaUsername('founder'),
      preferredLoginName: personaUsername('founder'),
      password: 'Abcdefgh1!abcdefgh1!abcd',
    };
    expect(passwordsFromFile(renderPersonasFile([entry])).get('founder')).toBe(entry.password);
    expect(passwordsFromFile('{not json').size).toBe(0);
    expect(passwordsFromFile(undefined).size).toBe(0);
  });
});
