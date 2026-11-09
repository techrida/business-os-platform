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
  it('has seven personas: five staff, one customer, one vendor', () => {
    expect(PERSONAS.map((p) => p.orgKind).sort()).toEqual([
      'customer',
      'staff',
      'staff',
      'staff',
      'staff',
      'staff',
      'vendor',
    ]);
    expect(new Set(PERSONAS.map((p) => personaUsername(p.key))).size).toBe(7);
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
    for (const role of ['pmo', 'operations_head', 'procurement', 'warehouse', 'operations_officer']) {
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
