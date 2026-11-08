import { describe, expect, it } from 'vitest';

import { ErrorBodySchema, MeResponseSchema, VitalsSchema } from './index.js';

const validMe = {
  userId: '312345678901234567',
  tenantId: '00000000-0000-4000-8000-000000000001',
  organizationId: '00000000-0000-4000-8000-000000000002',
  orgKind: 'staff',
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
