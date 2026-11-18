import { describe, expect, it } from 'vitest';

import { actorLabel } from './audit-actor';

const ID = '3f2b6f0e-8a41-4c58-9d0b-0123456789ab';

describe('actorLabel', () => {
  it('shows the person name when there is one', () => {
    expect(actorLabel({ id: ID, kind: 'user', name: 'Dev Accountant' })).toBe('Dev Accountant');
    expect(actorLabel({ id: ID, name: '  Dev Accountant ' })).toBe('Dev Accountant');
  });

  it('falls back to a short id for a person with no known name (old rows, other tenants)', () => {
    expect(actorLabel({ id: ID, kind: 'user', name: null })).toBe('person 456789ab');
    expect(actorLabel({ id: ID, name: undefined })).toBe('person 456789ab');
    expect(actorLabel({ id: ID, name: '   ' })).toBe('person 456789ab');
  });

  it('names the kind for actors that are not people', () => {
    expect(actorLabel({ id: 'system:seal', kind: 'system' })).toBe('system');
    expect(actorLabel({ id: 'seed', kind: 'seed', name: null })).toBe('seed');
  });
});
