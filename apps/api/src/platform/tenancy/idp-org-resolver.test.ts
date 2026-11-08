import 'reflect-metadata';

import { idpOrgs, organizations } from '@bos/db';
import { ForbiddenException } from '@nestjs/common';
import { PgDialect } from 'drizzle-orm/pg-core';
import { beforeEach, describe, expect, it } from 'vitest';

import type { Db } from '../db/db.module';
import { IDP_ORG_CACHE_TTL_MS, IdpOrgResolver, type ResolvedIdpOrg } from './idp-org-resolver';

const TENANT = '11111111-1111-4111-8111-111111111111';
const OTHER_TENANT = '55555555-5555-4555-8555-555555555555';
const ENTITY_A = '22222222-2222-4222-8222-222222222222';
const ENTITY_B = '44444444-4444-4444-8444-444444444444';
const PARTY = '88888888-8888-4888-8888-888888888888';

interface IdpRow {
  idpOrgId: string;
  tenantId: string;
  kind: ResolvedIdpOrg['kind'];
  partyId: string | null;
}
interface EntityRow {
  tenantId: string;
  id: string;
  isDefault: boolean;
}

const STAFF_IDP: IdpRow = {
  idpOrgId: '99999999-9999-4999-8999-999999999999',
  tenantId: TENANT,
  kind: 'staff',
  partyId: null,
};
const CUSTOMER_IDP: IdpRow = {
  idpOrgId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  tenantId: TENANT,
  kind: 'customer',
  partyId: PARTY,
};
const ENTITIES: EntityRow[] = [
  { tenantId: TENANT, id: ENTITY_A, isDefault: true },
  { tenantId: TENANT, id: ENTITY_B, isDefault: false },
  { tenantId: OTHER_TENANT, id: '66666666-6666-4666-8666-666666666666', isDefault: true },
];

/**
 * Stands in for the two drizzle chains the resolver runs: `select().from(idpOrgs).where().limit()`
 * and `select().from(organizations).where()`. It reads the bound parameter of the real WHERE
 * clause, so a test also proves which column each query filters on.
 */
function fakeDb(idpByZitadelOrg: Record<string, IdpRow>, entities: EntityRow[] = ENTITIES) {
  const dialect = new PgDialect();
  const state = { queries: 0, sql: [] as string[] };
  const db = {
    select: () => ({
      from: (table: unknown) => ({
        where: (condition: Parameters<PgDialect['sqlToQuery']>[0]) => {
          const { sql, params } = dialect.sqlToQuery(condition);
          const key = String(params[0]);
          if (table === idpOrgs) {
            return {
              limit: (): Promise<IdpRow[]> => {
                state.queries += 1;
                state.sql.push(sql);
                const row = idpByZitadelOrg[key];
                return Promise.resolve(row ? [row] : []);
              },
            };
          }
          if (table === organizations) {
            state.queries += 1;
            state.sql.push(sql);
            return Promise.resolve(
              entities
                .filter((e) => e.tenantId === key)
                .map(({ id, isDefault }) => ({ id, isDefault })),
            );
          }
          throw new Error('unexpected table');
        },
      }),
    }),
  } as unknown as Db;
  return { db, state };
}

describe('IdpOrgResolver', () => {
  let nowMs: number;
  const clock = () => nowMs;

  beforeEach(() => {
    nowMs = 1_000_000;
  });

  it('maps the zitadel org to its idp org, tenant, kind and party, plus the tenant entities', async () => {
    const { db, state } = fakeDb({ 'zit-staff': STAFF_IDP, 'zit-cust': CUSTOMER_IDP });
    const resolver = new IdpOrgResolver(db, clock);

    await expect(resolver.resolve('zit-staff')).resolves.toEqual({
      ...STAFF_IDP,
      entityIds: [ENTITY_A, ENTITY_B],
      defaultEntityId: ENTITY_A,
    });
    expect(state.sql[0]).toContain('"zitadel_org_id" = $1');
    expect(state.sql[1]).toContain('"tenant_id" = $1');

    await expect(resolver.resolve('zit-cust')).resolves.toMatchObject({
      kind: 'customer',
      partyId: PARTY,
      defaultEntityId: ENTITY_A,
    });
  });

  it('reports no default entity when the tenant has none', async () => {
    const { db } = fakeDb({ 'zit-staff': STAFF_IDP }, [
      { tenantId: TENANT, id: ENTITY_B, isDefault: false },
    ]);
    const resolver = new IdpOrgResolver(db, clock);

    await expect(resolver.resolve('zit-staff')).resolves.toMatchObject({
      entityIds: [ENTITY_B],
      defaultEntityId: null,
    });
  });

  it('serves a repeat lookup, entities included, from the cache', async () => {
    const { db, state } = fakeDb({ 'zit-staff': STAFF_IDP });
    const resolver = new IdpOrgResolver(db, clock);

    await resolver.resolve('zit-staff');
    nowMs += IDP_ORG_CACHE_TTL_MS - 1;
    await resolver.resolve('zit-staff');

    expect(state.queries).toBe(2);
  });

  it('queries again once the 60 s cache entry has expired', async () => {
    const { db, state } = fakeDb({ 'zit-staff': STAFF_IDP });
    const resolver = new IdpOrgResolver(db, clock);

    await resolver.resolve('zit-staff');
    nowMs += IDP_ORG_CACHE_TTL_MS;
    await resolver.resolve('zit-staff');

    expect(IDP_ORG_CACHE_TTL_MS).toBe(60_000);
    expect(state.queries).toBe(4);
  });

  it('rejects an unknown org with 403 and does not cache the miss', async () => {
    const rows: Record<string, IdpRow> = {};
    const { db, state } = fakeDb(rows);
    const resolver = new IdpOrgResolver(db, clock);

    const failure = await resolver.resolve('nobody').catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(ForbiddenException);
    expect((failure as ForbiddenException).getStatus()).toBe(403);
    expect((failure as ForbiddenException).message).not.toContain('nobody');
    // A miss stops before the entity query.
    expect(state.queries).toBe(1);

    // The org is registered a moment later: the next call must see it, not a cached miss.
    rows.nobody = STAFF_IDP;
    await expect(resolver.resolve('nobody')).resolves.toMatchObject({
      idpOrgId: STAFF_IDP.idpOrgId,
    });
    expect(state.queries).toBe(3);
  });
});
