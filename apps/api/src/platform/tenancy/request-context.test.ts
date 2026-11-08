import { describe, expect, it } from 'vitest';

import type { Principal } from '../authz/principal';
import {
  bindIdentity,
  bindPrincipal,
  ctx,
  currentPrincipal,
  runWithRequestStore,
} from './request-context';

const IDENTITY = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  organizationId: '22222222-2222-4222-8222-222222222222',
  orgKind: 'staff' as const,
  partyId: null,
  idpOrgId: '99999999-9999-4999-8999-999999999999',
  userId: 'user-1',
  roles: ['admin'],
  departmentId: null,
  tokenExp: 1_900_000_000,
};

// Only identity matters to the store; the real shape is U1b's Principal.
const PRINCIPAL = { userId: '33333333-3333-4333-8333-333333333333' } as unknown as Principal;

describe('request context', () => {
  it('throws outside a request', () => {
    expect(() => ctx()).toThrow('outside a request');
  });

  it('throws inside a request until an identity is bound (public routes)', () => {
    runWithRequestStore('corr-12345678', () => {
      expect(() => ctx()).toThrow('before the request was authenticated');
    });
  });

  it('returns identity plus correlation id once bound, across awaits', async () => {
    await runWithRequestStore('corr-12345678', async () => {
      bindIdentity(IDENTITY);
      await Promise.resolve();
      expect(ctx()).toEqual({
        ...IDENTITY,
        correlationId: 'corr-12345678',
        ip: null,
        userAgent: null,
      });
    });
  });

  it('exposes ip and userAgent from the store through ctx()', async () => {
    await runWithRequestStore(
      'corr-12345678',
      async () => {
        bindIdentity(IDENTITY);
        await Promise.resolve();
        expect(ctx().ip).toBe('203.0.113.7');
        expect(ctx().userAgent).toBe('vitest/1.0');
      },
      { ip: '203.0.113.7', userAgent: 'vitest/1.0' },
    );
  });

  it('defaults ip and userAgent to null when the store is opened with the old call shape', () => {
    runWithRequestStore('corr-12345678', () => {
      bindIdentity(IDENTITY);
      expect(ctx().ip).toBeNull();
      expect(ctx().userAgent).toBeNull();
    });
  });

  it('keeps concurrent requests apart', async () => {
    const read = (id: string, delayMs: number) =>
      runWithRequestStore(id, async () => {
        bindIdentity({ ...IDENTITY, userId: `user-${id}` });
        await new Promise((r) => setTimeout(r, delayMs));
        return ctx();
      });

    const [a, b] = await Promise.all([read('corr-aaaaaaaa', 20), read('corr-bbbbbbbb', 1)]);

    expect(a.userId).toBe('user-corr-aaaaaaaa');
    expect(b.correlationId).toBe('corr-bbbbbbbb');
  });

  it('refuses to bind outside a request', () => {
    expect(() => bindIdentity(IDENTITY)).toThrow('outside a request');
  });

  describe('principal slot', () => {
    it('is undefined before anything is bound, and outside a request', () => {
      expect(currentPrincipal()).toBeUndefined();
      runWithRequestStore('corr-12345678', () => {
        expect(currentPrincipal()).toBeUndefined();
      });
    });

    it('refuses to bind outside a request', () => {
      expect(() => bindPrincipal(PRINCIPAL)).toThrow('outside a request');
    });

    it('refuses to bind before the identity is bound', () => {
      runWithRequestStore('corr-12345678', () => {
        expect(() => bindPrincipal(PRINCIPAL)).toThrow('before bindIdentity');
        expect(currentPrincipal()).toBeUndefined();
      });
    });

    it('returns the bound principal across awaits in the same async chain', async () => {
      await runWithRequestStore('corr-12345678', async () => {
        bindIdentity(IDENTITY);
        bindPrincipal(PRINCIPAL);
        await new Promise((r) => setTimeout(r, 1));
        expect(currentPrincipal()).toBe(PRINCIPAL);
      });
      expect(currentPrincipal()).toBeUndefined();
    });

    it('keeps principals of concurrent requests apart', async () => {
      const read = (id: string, delayMs: number) =>
        runWithRequestStore(id, async () => {
          bindIdentity(IDENTITY);
          bindPrincipal({ userId: id } as unknown as Principal);
          await new Promise((r) => setTimeout(r, delayMs));
          return currentPrincipal();
        });

      const [a, b] = await Promise.all([read('user-a', 20), read('user-b', 1)]);

      expect(a?.userId).toBe('user-a');
      expect(b?.userId).toBe('user-b');
    });
  });
});
