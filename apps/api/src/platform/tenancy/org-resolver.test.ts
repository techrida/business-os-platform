import 'reflect-metadata';

import { ForbiddenException } from '@nestjs/common';
import { PgDialect } from 'drizzle-orm/pg-core';
import { beforeEach, describe, expect, it } from 'vitest';

import type { Db } from '../db/db.module';
import { ORG_CACHE_TTL_MS, OrgResolver, type ResolvedOrg } from './org-resolver';

const STAFF: ResolvedOrg = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  organizationId: '22222222-2222-4222-8222-222222222222',
  orgKind: 'staff',
};

/**
 * Stands in for drizzle's `select().from().where().limit()` chain. It reads the zitadel_org_id the
 * resolver put in the WHERE clause, so a test also proves the query filters on that column.
 */
function fakeDb(rowsByZitadelOrg: Record<string, ResolvedOrg>) {
  const dialect = new PgDialect();
  const state = { queries: 0, lastSql: '' };
  const db = {
    select: () => ({
      from: () => ({
        where: (condition: Parameters<PgDialect['sqlToQuery']>[0]) => ({
          limit: (): Promise<(typeof STAFF)[]> => {
            const { sql, params } = dialect.sqlToQuery(condition);
            state.queries += 1;
            state.lastSql = sql;
            const row = rowsByZitadelOrg[String(params[0])];
            return Promise.resolve(row ? [row] : []);
          },
        }),
      }),
    }),
  } as unknown as Db;
  return { db, state };
}

describe('OrgResolver', () => {
  let nowMs: number;
  const clock = () => nowMs;

  beforeEach(() => {
    nowMs = 1_000_000;
  });

  it('looks the org up by zitadel_org_id and returns tenant, organization and kind', async () => {
    const { db, state } = fakeDb({ 'zit-staff': STAFF });
    const resolver = new OrgResolver(db, clock);

    await expect(resolver.resolve('zit-staff')).resolves.toEqual(STAFF);
    expect(state.lastSql).toContain('"zitadel_org_id" = $1');
  });

  it('serves a repeat lookup from the cache', async () => {
    const { db, state } = fakeDb({ 'zit-staff': STAFF });
    const resolver = new OrgResolver(db, clock);

    await resolver.resolve('zit-staff');
    nowMs += ORG_CACHE_TTL_MS - 1;
    await resolver.resolve('zit-staff');

    expect(state.queries).toBe(1);
  });

  it('queries again once the 60 s cache entry has expired', async () => {
    const { db, state } = fakeDb({ 'zit-staff': STAFF });
    const resolver = new OrgResolver(db, clock);

    await resolver.resolve('zit-staff');
    nowMs += ORG_CACHE_TTL_MS;
    await resolver.resolve('zit-staff');

    expect(ORG_CACHE_TTL_MS).toBe(60_000);
    expect(state.queries).toBe(2);
  });

  it('keeps separate cache entries per org', async () => {
    const other = { ...STAFF, orgKind: 'customer' as const };
    const { db, state } = fakeDb({ a: STAFF, b: other });
    const resolver = new OrgResolver(db, clock);

    await expect(resolver.resolve('a')).resolves.toEqual(STAFF);
    await expect(resolver.resolve('b')).resolves.toEqual(other);
    expect(state.queries).toBe(2);
  });

  it('rejects an unknown org with 403 and does not cache the miss', async () => {
    const rows: Record<string, ResolvedOrg> = {};
    const { db, state } = fakeDb(rows);
    const resolver = new OrgResolver(db, clock);

    const failure = await resolver.resolve('nobody').catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(ForbiddenException);
    expect((failure as ForbiddenException).getStatus()).toBe(403);
    expect((failure as ForbiddenException).message).not.toContain('nobody');

    // The org is registered a moment later: the next call must see it, not a cached miss.
    rows.nobody = STAFF;
    await expect(resolver.resolve('nobody')).resolves.toEqual(STAFF);
    expect(state.queries).toBe(2);
  });
});
