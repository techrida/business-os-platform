import { ROLE_KEYS } from '@bos/contracts';
import { describe, expect, it } from 'vitest';

import {
  PERSONAS,
  PROJECT_ROLES,
  generatePassword,
  passwordsFromFile,
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
  it('has twelve personas: ten staff, one customer, one vendor', () => {
    expect(PERSONAS.map((p) => p.orgKind).sort()).toEqual([
      'customer',
      ...Array.from({ length: 10 }, () => 'staff'),
      'vendor',
    ]);
    expect(new Set(PERSONAS.map((p) => personaUsername(p.key))).size).toBe(12);
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
