import { describe, expect, it } from 'vitest';

import {
  PERSONAS,
  generatePassword,
  passwordsFromFile,
  personaUsername,
  renderPersonasFile,
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
  it('has six personas: four staff, one customer, one vendor', () => {
    expect(PERSONAS.map((p) => p.orgKind).sort()).toEqual([
      'customer',
      'staff',
      'staff',
      'staff',
      'staff',
      'vendor',
    ]);
    expect(new Set(PERSONAS.map((p) => personaUsername(p.key))).size).toBe(6);
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
