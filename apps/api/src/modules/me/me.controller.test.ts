import { MeResponseSchema } from '@bos/contracts';
import { describe, expect, it } from 'vitest';

import { bindIdentity, runWithRequestStore } from '../../platform/tenancy/request-context';
import { MeController } from './me.controller';

describe('MeController', () => {
  it('returns a MeResponse built from the request context', () => {
    const roles = ['admin', 'sales'];
    const body = runWithRequestStore('corr-12345678', () => {
      bindIdentity({
        tenantId: '11111111-1111-4111-8111-111111111111',
        organizationId: '22222222-2222-4222-8222-222222222222',
        orgKind: 'customer',
        userId: '312345678901234567',
        roles,
        tokenExp: 1_900_000_000,
      });
      return new MeController().me();
    });

    expect(MeResponseSchema.parse(body)).toEqual({
      userId: '312345678901234567',
      tenantId: '11111111-1111-4111-8111-111111111111',
      organizationId: '22222222-2222-4222-8222-222222222222',
      orgKind: 'customer',
      roles: ['admin', 'sales'],
      correlationId: 'corr-12345678',
    });
    expect(body.roles).not.toBe(roles);
    // tokenExp is internal: it must not leak into the response.
    expect(body).not.toHaveProperty('tokenExp');
  });

  it('throws outside an authenticated request', () => {
    expect(() => new MeController().me()).toThrow('outside a request');
  });
});
