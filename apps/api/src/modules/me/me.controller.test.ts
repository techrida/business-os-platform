import { MeResponseSchema } from '@bos/contracts';
import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

import type { Principal } from '../../platform/authz/principal';
import type { Db } from '../../platform/db/db.module';
import {
  bindIdentity,
  bindPrincipal,
  runWithRequestStore,
} from '../../platform/tenancy/request-context';
import { MeController } from './me.controller';

const TENANT = '11111111-1111-4111-8111-111111111111';
const APP_USER = '33333333-3333-4333-8333-333333333333';
const AVATAR = '44444444-4444-4444-8444-444444444444';

/** Answers the one users lookup; records the WHERE parameters so a test can see whose row was read. */
function fakeDb(rows: { avatarDocumentId: string | null }[]) {
  const seen: unknown[][] = [];
  const db = {
    select: () => ({
      from: () => ({
        where: (condition: Parameters<PgDialect['sqlToQuery']>[0]) => {
          seen.push(new PgDialect().sqlToQuery(condition).params);
          return { limit: () => Promise.resolve(rows) };
        },
      }),
    }),
  };
  return { db: db as unknown as Db, seen };
}

const identity = {
  tenantId: TENANT,
  organizationId: '22222222-2222-4222-8222-222222222222',
  orgKind: 'customer' as const,
  partyId: '88888888-8888-4888-8888-888888888888',
  idpOrgId: '99999999-9999-4999-8999-999999999999',
  userId: '312345678901234567',
  departmentId: null,
  tokenExp: 1_900_000_000,
};

function principalFor(userId: string): Principal {
  return {
    ...identity,
    userId,
    zitadelUserId: identity.userId,
    roles: [],
    status: 'active',
    grants: new Map(),
  };
}

describe('MeController', () => {
  it('returns a MeResponse built from the request context', async () => {
    const roles = ['admin', 'sales'];
    const { db } = fakeDb([]);
    const body = await runWithRequestStore('corr-12345678', () => {
      bindIdentity({ ...identity, roles });
      return new MeController(db).me();
    });

    expect(MeResponseSchema.parse(body)).toEqual({
      userId: '312345678901234567',
      tenantId: TENANT,
      organizationId: '22222222-2222-4222-8222-222222222222',
      orgKind: 'customer',
      partyId: '88888888-8888-4888-8888-888888888888',
      roles: ['admin', 'sales'],
      correlationId: 'corr-12345678',
      avatarDocumentId: null,
    });
    expect(body.roles).not.toBe(roles);
    // tokenExp, idpOrgId and departmentId are internal: they must not leak into the response.
    expect(body).not.toHaveProperty('tokenExp');
    expect(body).not.toHaveProperty('idpOrgId');
    expect(body).not.toHaveProperty('departmentId');
  });

  it("carries the caller's own avatar document id, read by tenant and app user id", async () => {
    const { db, seen } = fakeDb([{ avatarDocumentId: AVATAR }]);
    const body = await runWithRequestStore('corr-12345678', () => {
      bindIdentity({ ...identity, roles: [] });
      bindPrincipal(principalFor(APP_USER));
      return new MeController(db).me();
    });

    expect(MeResponseSchema.parse(body).avatarDocumentId).toBe(AVATAR);
    expect(seen).toEqual([[TENANT, APP_USER]]);
  });

  it('throws outside an authenticated request', async () => {
    await expect(new MeController(fakeDb([]).db).me()).rejects.toThrow('outside a request');
  });
});
