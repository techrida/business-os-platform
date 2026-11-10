import { describe, expect, it } from 'vitest';

import { bindIdentity, ctx, runWithRequestStore } from './request-context';

const IDENTITY = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  organizationId: '22222222-2222-4222-8222-222222222222',
  orgKind: 'staff' as const,
  userId: 'user-1',
  roles: ['admin'],
  tokenExp: 1_900_000_000,
};

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
      expect(ctx()).toEqual({ ...IDENTITY, correlationId: 'corr-12345678' });
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
});
