// Unit tests of the list query, the Idempotency-Key rule and the PATCH field filter.
import { UpdateCustomerBodySchema } from '@bos/contracts';
import { describe, expect, it } from 'vitest';

import { ListCustomersQuerySchema, requireIdempotencyKey, sentFields } from './customers.types';

describe('ListCustomersQuerySchema', () => {
  it('defaults to the first 50 and treats a blank or one-character q as no search', () => {
    expect(ListCustomersQuerySchema.parse({ q: '  ' })).toMatchObject({
      q: undefined,
      limit: 50,
      offset: 0,
    });
    expect(ListCustomersQuerySchema.parse({ q: 'a' }).q).toBeUndefined();
  });

  it('reads limit and offset from strings, as an HTTP query delivers them', () => {
    expect(ListCustomersQuerySchema.parse({ q: 'acme', limit: '20', offset: '40' })).toMatchObject({
      q: 'acme',
      limit: 20,
      offset: 40,
    });
  });

  it('accepts one or repeated relationship and industry values, once each', () => {
    expect(ListCustomersQuerySchema.parse({ relationship: 'active' }).relationship).toEqual([
      'active',
    ]);
    const parsed = ListCustomersQuerySchema.parse({
      relationship: ['active', 'prospect', 'active'],
      industry: ['Retail', 'Hydropower'],
    });
    expect(parsed.relationship).toEqual(['active', 'prospect']);
    expect(parsed.industry).toEqual(['Retail', 'Hydropower']);
  });

  it.each([
    { limit: '0' },
    { limit: '101' },
    { limit: '-1' },
    { offset: 'x' },
    { q: ['a', 'b'] },
    { x: '1' },
    { relationship: 'vip' },
    { relationship: ['active', 'vip'] },
  ])('refuses %o', (query) => {
    expect(ListCustomersQuerySchema.safeParse(query).success).toBe(false);
  });
});

describe('requireIdempotencyKey', () => {
  it('returns a printable key and refuses a missing or empty one with 400', () => {
    expect(requireIdempotencyKey('4f1c-key')).toBe('4f1c-key');
    expect(() => requireIdempotencyKey(undefined)).toThrow(/Idempotency-Key/);
    expect(() => requireIdempotencyKey('')).toThrow(/Idempotency-Key/);
    expect(() => requireIdempotencyKey('has space')).toThrow(/Idempotency-Key/);
  });
});

describe('sentFields', () => {
  it('does not turn the relationship default into an edit', () => {
    const raw = { expectedVersion: 3, legalName: 'Acme' };
    const parsed = UpdateCustomerBodySchema.parse(raw);
    // The trap: Zod 4 puts the default back in.
    expect(parsed.relationship).toBe('prospect');
    expect(sentFields(raw, parsed)).toEqual({ expectedVersion: 3, legalName: 'Acme' });
  });

  it('keeps a relationship the client did send', () => {
    const raw = { expectedVersion: 1, relationship: 'active' };
    expect(sentFields(raw, UpdateCustomerBodySchema.parse(raw))).toEqual(raw);
  });
});
