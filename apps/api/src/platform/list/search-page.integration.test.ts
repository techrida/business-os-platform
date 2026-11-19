// searchPage on a real Postgres (Testcontainers, needs Docker in WSL), queried as bos_app, the role the API runs
// as. Real: migrations (pg_trgm comes from 0041), the helper, the GIN trigram indexes created below. The test
// table is created by the owner in schema app, so bos_app gets DML through the default privileges, as for any
// table. The harness is the leads one: it only supplies the container, the roles and two entities.
// Run: pnpm --filter @bos/api exec vitest run src/platform/list/search-page.integration.test.ts
import { and, asc, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { PgDialect, pgSchema, text, uuid } from 'drizzle-orm/pg-core';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { scoped } from '@bos/db';

import { startHarness, type Harness } from '../../modules/leads/test/harness';
import { type Db } from '../db/db.module';
import { fuzzyMatch, searchPage, type Reader } from './search-page';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 180_000 });

const probe = pgSchema('app').table('list_probe', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  organizationId: uuid('organization_id').notNull(),
  name: text('name').notNull(),
  city: text('city'),
  status: text('status').notNull().default('open'),
});
const COLUMNS = [probe.name, probe.city];

let h: Harness;

async function seed(
  organizationId: string,
  names: string[],
  extra: { status?: string; city?: string } = {},
) {
  for (const name of names) {
    await h.ownerPool.query(
      `INSERT INTO app.list_probe (tenant_id, organization_id, name, city, status)
       VALUES ($1, $2, $3, $4, $5)`,
      [h.tenantId, organizationId, name, extra.city ?? null, extra.status ?? 'open'],
    );
  }
}

beforeAll(async () => {
  h = await startHarness({ Pool, drizzle });
  await h.ownerPool.query(`CREATE TABLE app.list_probe (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL, organization_id uuid NOT NULL,
    name text NOT NULL, city text, status text NOT NULL DEFAULT 'open')`);
  await h.ownerPool.query(
    'CREATE INDEX list_probe_name_trgm ON app.list_probe USING gin (name gin_trgm_ops)',
  );
  await h.ownerPool.query(
    'CREATE INDEX list_probe_city_trgm ON app.list_probe USING gin (city gin_trgm_ops)',
  );
  const A = h.scopeA.organizationId;
  const B = h.scopeB.organizationId;
  // Every name has a NULL city except one, so the NULL-column path is part of every search.
  await seed(A, [
    'Himalyan Traders Pvt Ltd',
    'Himal Chuli Foods',
    'Annapurna Supplies',
    'Everest Hardware',
    'Lumbini Paper Mills',
  ]);
  await seed(A, ['Kathmandu Steel', 'Kathmandu Paper', 'Kathmandu Foods']);
  await seed(A, ['Katmandu Traders', 'Katmandu Mills', 'Katmandu Works', 'Katmandu Dairy']);
  await seed(A, ['Katmandu Closed'], { status: 'closed' });
  await seed(A, ['Pokhara One', 'Pokhara Two', 'Pokhara Three', 'Pokhara Four', 'Pokhara Five']);
  await seed(A, ['Pokhra Tea']);
  await seed(A, ['Dhulikhel Hardware'], { city: 'Himalayan Foothills' });
  // Another entity of the same tenant: close to every search below, never visible to entity A.
  await seed(B, ['Himalyan Exports', 'Katmandu Exports', 'Pokhra Exports']);
});

afterAll(async () => {
  await h?.stop();
});

const where = () => scoped(h.scopeA).where(probe, eq(probe.status, 'open'));

const run = (db: Reader, q: string | undefined, limit = 50, offset = 0) =>
  searchPage(db, {
    q,
    columns: COLUMNS,
    where: where(),
    orderBy: [asc(probe.name), asc(probe.id)],
    limit,
    offset,
    rows: (tx, p) =>
      tx
        .select({ name: probe.name })
        .from(probe)
        .where(p.where)
        .orderBy(...p.orderBy)
        .limit(p.limit)
        .offset(p.offset),
    count: (tx, w) => tx.$count(probe, w),
  });
const names = (r: { rows: { name: string }[] }) => r.rows.map((x) => x.name);

describe('searchPage as bos_app', () => {
  it("ranks 'Himalyan Traders' first for 'Himalayan' (below pg_trgm's default 0.6)", async () => {
    // The exact hit ('Himalayan Foothills' is only a city) comes first, then the typo.
    const r = await run(h.db, 'Himalayan');
    expect(r.fuzzy).toBe(true);
    expect(names(r)[1]).toBe('Himalyan Traders Pvt Ltd');
    expect(names(r)[0]).toBe('Dhulikhel Hardware');
    expect(r.total).toBe(r.rows.length);
  });

  it('never returns a row outside the scope or the filters, in either mode', async () => {
    for (const q of ['Himalayan', 'Kathmandu', 'Pokhara', 'Exports', 'Closed']) {
      const r = await run(h.db, q);
      expect(names(r), q).not.toContain('Himalyan Exports');
      expect(names(r), q).not.toContain('Katmandu Exports');
      expect(names(r), q).not.toContain('Pokhra Exports');
      expect(names(r), q).not.toContain('Katmandu Closed');
    }
    // 'Exports' only exists in entity B: no exact hit, and the fuzzy step must not reach it either.
    const none = await run(h.db, 'Exports');
    expect(none).toEqual({ rows: [], total: 0, fuzzy: true });
  });

  it('puts exact hits first in the caller order, then close matches', async () => {
    const r = await run(h.db, 'Kathmandu');
    expect(r.fuzzy).toBe(true);
    expect(names(r).slice(0, 3)).toEqual(['Kathmandu Foods', 'Kathmandu Paper', 'Kathmandu Steel']);
    expect(names(r).slice(3).sort()).toEqual([
      'Katmandu Dairy',
      'Katmandu Mills',
      'Katmandu Traders',
      'Katmandu Works',
    ]);
    expect(r.total).toBe(7);
  });

  it('leaves exact search alone from five exact hits up, even on a short last page', async () => {
    const all = await run(h.db, 'Pokhara');
    expect(all.fuzzy).toBe(false);
    expect(all.total).toBe(5);
    expect(names(all)).not.toContain('Pokhra Tea');
    const last = await run(h.db, 'Pokhara', 2, 4);
    expect(last).toMatchObject({ fuzzy: false, total: 5 });
    expect(last.rows).toHaveLength(1);
    // Under the threshold elsewhere, the same call does go fuzzy: the mode follows the total.
    expect((await run(h.db, 'Pokhra')).fuzzy).toBe(true);
  });

  it('does not change mode or total on page 2, and pages do not overlap', async () => {
    const p1 = await run(h.db, 'Kathmandu', 5, 0);
    const p2 = await run(h.db, 'Kathmandu', 5, 5);
    expect([p1.fuzzy, p1.total]).toEqual([true, 7]);
    expect([p2.fuzzy, p2.total]).toEqual([true, 7]);
    expect(p1.rows).toHaveLength(5);
    expect(p2.rows).toHaveLength(2);
    const seen = [...names(p1), ...names(p2)];
    expect(new Set(seen).size).toBe(7);
    expect(seen).toEqual(names(await run(h.db, 'Kathmandu')));
  });

  it('lists without a search, and ignores a one-character search', async () => {
    const plain = await run(h.db, undefined);
    expect(plain.fuzzy).toBe(false);
    expect(plain.total).toBe(await h.db.$count(probe, where()));
    expect((await run(h.db, 'k')).total).toBe(plain.total);
  });

  it('sets the similarity threshold for the transaction only', async () => {
    // A one-connection pool: whatever the helper left on its connection, the next query would see it.
    const pool = new Pool({
      connectionString: (h.appPool as unknown as Pool).options.connectionString,
      max: 1,
    });
    try {
      const db: Db = drizzle({ client: pool });
      const r = await run(db, 'Himalayan');
      expect(r.fuzzy).toBe(true);
      const { rows } = await pool.query(
        "SELECT current_setting('pg_trgm.word_similarity_threshold', true) AS v",
      );
      expect((rows[0] as { v: string | null }).v).not.toBe('0.4');
    } finally {
      await pool.end();
    }
  });

  it('uses the trigram indexes for the fuzzy predicate', async () => {
    const dialect = new PgDialect();
    const w = and(where(), fuzzyMatch('Himalayan', COLUMNS))!;
    const { sql: text_, params } = dialect.sqlToQuery(
      sql`SELECT id FROM app.list_probe WHERE ${w}`,
    );
    const client = await (h.appPool as unknown as Pool).connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL enable_seqscan = off');
      await client.query("SET LOCAL pg_trgm.word_similarity_threshold = '0.4'");
      const { rows } = await client.query(`EXPLAIN ${text_}`, params);
      const plan = rows.map((r: Record<string, string>) => r['QUERY PLAN']).join('\n');
      expect(plan).toMatch(/list_probe_(name|city)_trgm/);
      expect(plan).not.toMatch(/Seq Scan/);
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });
});
