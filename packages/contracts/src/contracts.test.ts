import { describe, expect, it } from 'vitest';

import { dropUnknownGrants, ErrorBodySchema, MeResponseSchema, VitalsSchema } from './index.js';

const validMe = {
  userId: '312345678901234567',
  tenantId: '00000000-0000-4000-8000-000000000001',
  organizationId: '00000000-0000-4000-8000-000000000002',
  orgKind: 'staff',
  partyId: null,
  roles: ['founder', 'management'],
  correlationId: 'req-12345678',
};

describe('MeResponseSchema', () => {
  it('parses a valid response', () => {
    const parsed = MeResponseSchema.parse(validMe);
    expect(parsed.orgKind).toBe('staff');
    expect(parsed.roles).toEqual(['founder', 'management']);
  });

  it('accepts every org kind', () => {
    for (const orgKind of ['staff', 'customer', 'vendor']) {
      expect(MeResponseSchema.safeParse({ ...validMe, orgKind }).success).toBe(true);
    }
  });

  it('accepts effective grants and rejects an unknown permission or scope in them', () => {
    const permissions = [{ permission: 'customer.read', scope: 'own' }];
    expect(MeResponseSchema.parse({ ...validMe, permissions }).permissions).toEqual(permissions);
    expect(MeResponseSchema.parse(validMe).permissions).toBeUndefined();
    for (const bad of [
      { permission: 'made.up', scope: 'all' },
      { permission: 'customer.read', scope: 'galaxy' },
    ]) {
      expect(MeResponseSchema.safeParse({ ...validMe, permissions: [bad] }).success).toBe(false);
    }
  });

  it('rejects an unknown org kind', () => {
    expect(MeResponseSchema.safeParse({ ...validMe, orgKind: 'admin' }).success).toBe(false);
  });

  it('rejects a missing field and malformed ids', () => {
    const { userId: _userId, ...withoutUser } = validMe;
    expect(MeResponseSchema.safeParse(withoutUser).success).toBe(false);
    expect(MeResponseSchema.safeParse({ ...validMe, tenantId: 'not-a-uuid' }).success).toBe(false);
    expect(MeResponseSchema.safeParse({ ...validMe, correlationId: 'short' }).success).toBe(false);
    expect(MeResponseSchema.safeParse({ ...validMe, roles: 'founder' }).success).toBe(false);
  });
});

describe('dropUnknownGrants', () => {
  const known = { permission: 'customer.read', scope: 'own' };

  it('removes a permission or scope this build does not know and names it', () => {
    const permissions = [
      known,
      { permission: 'vat.future.read', scope: 'all' },
      { permission: 'customer.read', scope: 'galaxy' },
    ];
    const { body, dropped } = dropUnknownGrants({ ...validMe, permissions });
    expect(dropped).toEqual(['vat.future.read@all', 'customer.read@galaxy']);
    expect(MeResponseSchema.parse(body).permissions).toEqual([known]);
  });

  it.each([
    ['null', null],
    ['an empty object', {}],
    ['a string', 'junk'],
    ['a number', 7],
    ['an array', ['customer.read', 'own']],
    ['a row without a scope', { permission: 'customer.read' }],
    ['a row without a permission', { scope: 'own' }],
    ['a non-string permission', { permission: 7, scope: 'own' }],
    ['a hostile non-string scope', { permission: 'customer.read', scope: { toString: null } }],
  ])('leaves a malformed row (%s) for the schema to reject, without throwing', (_name, row) => {
    const unknownRow = { permission: 'vat.future.read', scope: 'all' };
    const { body, dropped } = dropUnknownGrants({
      ...validMe,
      permissions: [known, unknownRow, row],
    });
    // The well-formed unknown row is still dropped; the malformed one is not, so the body fails.
    expect(dropped).toEqual(['vat.future.read@all']);
    expect((body as { permissions: unknown[] }).permissions).toEqual([known, row]);
    expect(MeResponseSchema.safeParse(body).success).toBe(false);
  });

  it('leaves a permissions value that is not a list for the schema to reject', () => {
    const body = { ...validMe, permissions: 'customer.read' };
    expect(dropUnknownGrants(body)).toEqual({ body, dropped: [] });
    expect(MeResponseSchema.safeParse(body).success).toBe(false);
  });

  it('leaves a body with only known grants, and any other shape, untouched', () => {
    const clean = { ...validMe, permissions: [known] };
    expect(dropUnknownGrants(clean)).toEqual({ body: clean, dropped: [] });
    expect(dropUnknownGrants(validMe)).toEqual({ body: validMe, dropped: [] });
    expect(dropUnknownGrants('text')).toEqual({ body: 'text', dropped: [] });
  });

  it('does not rescue a body that is wrong elsewhere', () => {
    const { body } = dropUnknownGrants({ ...validMe, orgKind: 'admin', permissions: [known] });
    expect(MeResponseSchema.safeParse(body).success).toBe(false);
  });
});

describe('VitalsSchema', () => {
  const valid = { name: 'LCP', value: 1234.5, route: '/', id: 'v5-1700000000000-1234567890123' };

  it('parses a valid sample', () => {
    expect(VitalsSchema.parse(valid).name).toBe('LCP');
  });

  it('rejects an unknown metric, a negative value and an empty route', () => {
    expect(VitalsSchema.safeParse({ ...valid, name: 'FID' }).success).toBe(false);
    expect(VitalsSchema.safeParse({ ...valid, value: -1 }).success).toBe(false);
    expect(VitalsSchema.safeParse({ ...valid, route: '' }).success).toBe(false);
  });
});

describe('ErrorBodySchema', () => {
  it('parses the error envelope and rejects a bare message', () => {
    const body = {
      error: { code: 'unauthorized', message: 'No token', correlationId: 'abc-12345' },
    };
    expect(ErrorBodySchema.parse(body)).toEqual(body);
    expect(ErrorBodySchema.safeParse({ message: 'No token' }).success).toBe(false);
  });
});
