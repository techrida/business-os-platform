// Integration tests for migration 0001_audit (k-audit) on a real postgres:16-alpine (Testcontainers, needs
// Docker). Serves the NFR "every change is audited, and the trail is tamper-evident".
// Run with: pnpm --filter @bos/db exec vitest run src/audit.test.ts
//
// The setup mirrors infra/postgres/init-dbs.sh (roles, database, all three default-privilege lines), then
// migrates as bos_owner. Behaviour is tested as bos_app, the role the API runs as. Chains are per tenant,
// so every test uses a fresh random tenant and cannot see another test's rows.
import { randomUUID } from 'node:crypto';

import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from './testing/test-database.js';

let testDb: TestDatabase;
let superuser: Pool;
let owner: Pool;
let app: Pool;

interface Scope {
  tenantId: string;
  organizationId: string;
}

const newScope = (): Scope => ({ tenantId: randomUUID(), organizationId: randomUUID() });

/** The bos.* settings withTx() sets (apps/api/src/platform/db/tx.ts), for one transaction. */
function settingsFor(scope: Scope, over: Record<string, string> = {}): Record<string, string> {
  return {
    'bos.tenant_id': scope.tenantId,
    'bos.organization_id': scope.organizationId,
    'bos.actor_kind': 'system',
    'bos.actor_id': 'audit-test',
    'bos.correlation_id': randomUUID(),
    'bos.ip': '',
    'bos.user_agent': '',
    ...over,
  };
}

/** Runs fn in one transaction on `pool`, after set_config(..., true) of each setting (like withTx). */
async function inTx<T>(
  pool: Pool,
  settings: Record<string, string> | null,
  fn: (c: PoolClient) => Promise<T>,
): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    for (const [key, value] of Object.entries(settings ?? {})) {
      await c.query('SELECT set_config($1, $2, true)', [key, value]);
    }
    const result = await fn(c);
    await c.query('COMMIT');
    return result;
  } catch (error) {
    await c.query('ROLLBACK');
    throw error;
  } finally {
    c.release();
  }
}

/** Calls audit.record() in its own transaction as bos_app and returns the new event id. */
async function record(scope: Scope, action = 'test.happened', after: unknown = { n: 1 }) {
  return inTx(app, settingsFor(scope), async (c) => {
    const { rows } = await c.query<{ id: string }>(
      'SELECT audit.record($1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb) AS id',
      [action, 'test', 'entity-1', null, JSON.stringify(after), JSON.stringify({ via: 'test' })],
    );
    return rows[0]?.id;
  });
}

interface EventRow {
  id: string;
  seq: string;
  chain_month: string;
  action: string;
  entity_type: string;
  entity_id: string;
  actor_kind: string;
  actor_id: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  ip: string | null;
  prev_hash: Buffer;
  hash: Buffer;
}

/** Every event of a tenant in chain order, read as bos_owner (bos_app cannot read the table). */
async function eventsOf(tenantId: string): Promise<EventRow[]> {
  const { rows } = await owner.query<EventRow>(
    `SELECT id, seq, to_char(chain_month, 'YYYY-MM-DD') AS chain_month, action, entity_type, entity_id,
            actor_kind, actor_id, before, after, host(ip) AS ip, prev_hash, hash
       FROM audit.audit_events WHERE tenant_id = $1 ORDER BY chain_month, seq`,
    [tenantId],
  );
  return rows;
}

interface Verify {
  ok: boolean;
  rows: string;
  first_bad_seq: string | null;
}

/** audit.verify_chain as bos_app, for the current UTC month unless a month is given. */
async function verify(tenantId: string, month?: string): Promise<Verify> {
  const { rows } = await app.query<Verify>(
    `SELECT ok, "rows", first_bad_seq
       FROM audit.verify_chain($1, coalesce($2::date, (now() AT TIME ZONE 'UTC')::date))`,
    [tenantId, month ?? null],
  );
  const result = rows[0];
  if (result === undefined) throw new Error('verify_chain returned no row');
  return result;
}

beforeAll(async () => {
  testDb = await createTestDatabase();

  const admin = new Pool({ connectionString: testDb.adminUrl, max: 1 });
  await admin.end();

  superuser = new Pool({ connectionString: testDb.adminUrl, max: 2 });

  owner = new Pool({ connectionString: testDb.ownerUrl, max: 2 });
  app = new Pool({ connectionString: testDb.appUrl, max: 20 });
});

afterAll(async () => {
  await app?.end();
  await owner?.end();
  await superuser?.end();
  await testDb?.drop();
});

describe('privileges', () => {
  it('denies bos_app every direct statement on audit.audit_events (42501)', async () => {
    const denied = { code: '42501' };
    await expect(
      app.query(
        `INSERT INTO audit.audit_events (tenant_id, organization_id, chain_month, seq, actor_kind, actor_id,
           action, entity_type, entity_id, correlation_id, prev_hash, hash)
         VALUES (gen_random_uuid(), gen_random_uuid(), '2026-01-01', 1, 'user', 'x', 'a', 'e', 'i', 'c',
           '\\x00', '\\x00')`,
      ),
    ).rejects.toMatchObject(denied);
    await expect(app.query(`UPDATE audit.audit_events SET actor_id = 'x'`)).rejects.toMatchObject(
      denied,
    );
    await expect(app.query('DELETE FROM audit.audit_events')).rejects.toMatchObject(denied);
    await expect(app.query('SELECT 1 FROM audit.audit_events')).rejects.toMatchObject(denied);
    await expect(app.query('SELECT 1 FROM audit.chain_seals')).rejects.toMatchObject(denied);
    await expect(app.query(`SELECT nextval('audit.audit_events_id_seq')`)).rejects.toMatchObject(
      denied,
    );
  });

  it('lets only bos_owner call attach and append', async () => {
    await expect(app.query(`SELECT audit.attach('app.organizations')`)).rejects.toMatchObject({
      code: '42501',
    });
    await expect(
      app.query(
        `SELECT audit.append(gen_random_uuid(), gen_random_uuid(), 'a', 'e', 'i', NULL, NULL, NULL)`,
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('lets bos_app append through audit.record() and read through audit.read_events()', async () => {
    const scope = newScope();
    const id = await record(scope, 'approval.approved', { step: 1 });
    expect(id).toMatch(/^\d+$/);

    const { rows } = await app.query<{ id: string; action: string; after: unknown }>(
      'SELECT id, action, after FROM audit.read_events($1, $2, $3, $4, NULL, NULL, NULL, 10)',
      [scope.tenantId, scope.organizationId, 'test', 'entity-1'],
    );
    expect(rows).toEqual([{ id, action: 'approval.approved', after: { step: 1 } }]);
  });

  it('makes audit.record() refuse to run without the bos.* scope and actor', async () => {
    const scope = newScope();
    await expect(
      inTx(app, settingsFor(scope, { 'bos.actor_id': '' }), (c) =>
        c.query(`SELECT audit.record('x.y', 'test', '1', NULL, NULL, NULL)`),
      ),
    ).rejects.toThrow(/bos\.actor_id is not set/);
    await expect(
      inTx(app, settingsFor(scope, { 'bos.tenant_id': '' }), (c) =>
        c.query(`SELECT audit.record('x.y', 'test', '1', NULL, NULL, NULL)`),
      ),
    ).rejects.toThrow(/bos\.tenant_id/);
  });
});

describe('append-only', () => {
  it('raises on UPDATE, DELETE and TRUNCATE even for bos_owner', async () => {
    const scope = newScope();
    await record(scope);
    const where = [scope.tenantId];
    await expect(
      owner.query(`UPDATE audit.audit_events SET actor_id = 'x' WHERE tenant_id = $1`, where),
    ).rejects.toThrow('audit_events is append-only');
    await expect(
      owner.query('DELETE FROM audit.audit_events WHERE tenant_id = $1', where),
    ).rejects.toThrow('audit_events is append-only');
    await expect(owner.query('TRUNCATE audit.audit_events')).rejects.toThrow(
      'audit_events is append-only',
    );
    expect(await eventsOf(scope.tenantId)).toHaveLength(1);
  });
});

describe('row trigger audit_capture', () => {
  async function newTenant(): Promise<string> {
    const { rows } = await app.query<{ id: string }>(
      'INSERT INTO app.tenants DEFAULT VALUES RETURNING id',
    );
    const id = rows[0]?.id;
    if (id === undefined) throw new Error('tenant insert returned no row');
    return id;
  }

  // A legal entity (ADR 0027): code and legal_name are required, kind and zitadel_org_id are gone.
  const insertOrg = `INSERT INTO app.organizations (tenant_id, code, name, legal_name)
                     VALUES ($1, $2, 'Acme', 'Acme Ltd') RETURNING id`;

  it('is installed on app.organizations under the name audit_capture', async () => {
    const { rows } = await owner.query<{ tgname: string }>(
      `SELECT tgname FROM pg_trigger WHERE tgrelid = 'app.organizations'::regclass AND NOT tgisinternal
        ORDER BY tgname`,
    );
    expect(rows.map((r) => r.tgname)).toContain('audit_capture');
  });

  it('raises when a write to app.organizations has no bos.actor_id', async () => {
    const tenantId = await newTenant();
    await expect(app.query(insertOrg, [tenantId, `E-${randomUUID()}`])).rejects.toThrow(
      /bos\.actor_id is not set/,
    );
    // An explicitly empty actor (what a pooled connection reads after an earlier withTx) also fails.
    const scope = { tenantId, organizationId: randomUUID() };
    await expect(
      inTx(app, settingsFor(scope, { 'bos.actor_id': '' }), (c) =>
        c.query(insertOrg, [tenantId, `E-${randomUUID()}`]),
      ),
    ).rejects.toThrow(/bos\.actor_id is not set/);
  });

  it('records insert, update and delete for bos_app with the actor from bos.*', async () => {
    const tenantId = await newTenant();
    const settings = settingsFor(
      { tenantId, organizationId: randomUUID() },
      { 'bos.actor_kind': 'user', 'bos.actor_id': 'user-42', 'bos.ip': '10.0.0.7' },
    );
    const orgId = await inTx(app, settings, async (c) => {
      const { rows } = await c.query<{ id: string }>(insertOrg, [tenantId, `E-${randomUUID()}`]);
      const id = rows[0]?.id;
      await c.query(`UPDATE app.organizations SET name = 'Acme 2' WHERE id = $1`, [id]);
      await c.query('DELETE FROM app.organizations WHERE id = $1', [id]);
      return id;
    });

    const events = await eventsOf(tenantId);
    expect(events.map((e) => [e.seq, e.action])).toEqual([
      ['1', 'organizations.insert'],
      ['2', 'organizations.update'],
      ['3', 'organizations.delete'],
    ]);
    expect(events.every((e) => e.entity_type === 'organizations' && e.entity_id === orgId)).toBe(
      true,
    );
    expect(events[0]).toMatchObject({ actor_kind: 'user', actor_id: 'user-42', ip: '10.0.0.7' });
    expect(events[0]?.before).toBeNull();
    expect(events[1]?.before?.['name']).toBe('Acme');
    expect(events[1]?.after?.['name']).toBe('Acme 2');
    expect(events[2]?.after).toBeNull();
    await expect(verify(tenantId)).resolves.toEqual({ ok: true, rows: '3', first_bad_seq: null });
  });
});

describe('attach options: redact and ignore', () => {
  it('drops redacted columns from before/after and skips updates of ignored columns only', async () => {
    await owner.query(`CREATE TABLE app.audit_fixture (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL,
      organization_id uuid NOT NULL,
      name text NOT NULL,
      secret text,
      touched_at timestamptz)`);
    try {
      await expect(
        owner.query(`SELECT audit.attach('app.audit_fixture', '{nope}')`),
      ).rejects.toThrow(/no such column/);
      await owner.query(`SELECT audit.attach('app.audit_fixture', '{secret}', '{touched_at}')`);

      const scope = newScope();
      await inTx(app, settingsFor(scope), async (c) => {
        const { rows } = await c.query<{ id: string }>(
          `INSERT INTO app.audit_fixture (tenant_id, organization_id, name, secret)
           VALUES ($1, $2, 'a', 's1') RETURNING id`,
          [scope.tenantId, scope.organizationId],
        );
        const id = rows[0]?.id;
        await c.query('UPDATE app.audit_fixture SET touched_at = now() WHERE id = $1', [id]);
        await c.query(`UPDATE app.audit_fixture SET name = 'b', secret = 's2' WHERE id = $1`, [id]);
      });

      const events = await eventsOf(scope.tenantId);
      expect(events.map((e) => e.action)).toEqual(['audit_fixture.insert', 'audit_fixture.update']);
      for (const e of events) {
        expect(e.before ?? {}).not.toHaveProperty('secret');
        expect(e.after ?? {}).not.toHaveProperty('secret');
      }
      expect(events[1]?.before?.['name']).toBe('a');
      expect(events[1]?.after?.['name']).toBe('b');
    } finally {
      await owner.query('DROP TABLE IF EXISTS app.audit_fixture');
    }
  });
});

describe('hash chain', () => {
  it('starts a new tenant at \\x00, verifies 3 rows, and pins tampering to the changed row', async () => {
    const scope = newScope();
    await record(scope, 'test.one');
    await record(scope, 'test.two');
    await record(scope, 'test.three');

    const events = await eventsOf(scope.tenantId);
    expect(events.map((e) => e.seq)).toEqual(['1', '2', '3']);
    expect(events[0]?.prev_hash).toEqual(Buffer.from([0]));
    expect(events[1]?.prev_hash).toEqual(events[0]?.hash);
    expect(events[2]?.prev_hash).toEqual(events[1]?.hash);
    await expect(verify(scope.tenantId)).resolves.toEqual({
      ok: true,
      rows: '3',
      first_bad_seq: null,
    });

    // A superuser can switch triggers off (session_replication_role = replica) and edit a row in place.
    await inTx(superuser, null, async (c) => {
      await c.query('SET LOCAL session_replication_role = replica');
      await c.query(
        `UPDATE audit.audit_events SET after = '{"n": 999}' WHERE tenant_id = $1 AND seq = 2`,
        [scope.tenantId],
      );
    });
    await expect(verify(scope.tenantId)).resolves.toEqual({
      ok: false,
      rows: '3',
      first_bad_seq: '2',
    });
  });

  it("links a month's first row to the previous month's last hash", async () => {
    const scope = newScope();
    // A row in last month, appended by bos_owner with an explicit occurred_at (append is owner-only).
    await inTx(owner, settingsFor(scope), (c) =>
      c.query(
        `SELECT audit.append($1, $2, 'test.last_month', 'test', 'e', NULL, NULL, NULL,
                date_trunc('month', now()) - interval '1 day')`,
        [scope.tenantId, scope.organizationId],
      ),
    );
    await record(scope, 'test.this_month');

    const [last, first] = await eventsOf(scope.tenantId);
    expect(last?.chain_month).not.toBe(first?.chain_month);
    expect(last?.seq).toBe('1');
    expect(first?.seq).toBe('1');
    expect(last?.prev_hash).toEqual(Buffer.from([0]));
    expect(first?.prev_hash).toEqual(last?.hash);
    await expect(verify(scope.tenantId, last?.chain_month)).resolves.toMatchObject({ ok: true });
    await expect(verify(scope.tenantId)).resolves.toMatchObject({ ok: true, rows: '1' });
  });

  it('gives 20 concurrent transactions the gap-free seq 1..20', async () => {
    const scope = newScope();
    // Each transaction keeps holding the chain lock for a moment after appending, so they really contend.
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        inTx(app, settingsFor(scope), async (c) => {
          await c.query(`SELECT audit.record($1, 'test', $2, NULL, NULL, NULL)`, [
            'test.concurrent',
            String(i),
          ]);
          await c.query('SELECT pg_sleep(0.02)');
        }),
      ),
    );

    const events = await eventsOf(scope.tenantId);
    expect(events.map((e) => Number(e.seq))).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    expect(new Set(events.map((e) => e.entity_id)).size).toBe(20);
    await expect(verify(scope.tenantId)).resolves.toEqual({
      ok: true,
      rows: '20',
      first_bad_seq: null,
    });
  });
});

describe('seal', () => {
  interface SealResult {
    sealed: boolean;
    last_seq: string | null;
  }

  /** audit.seal as bos_app (proves the GRANT). It writes no event, so it needs no bos.* settings. */
  async function seal(tenantId: string, month: string): Promise<SealResult> {
    const { rows } = await app.query<SealResult>('SELECT * FROM audit.seal($1, $2::date)', [
      tenantId,
      month,
    ]);
    const result = rows[0];
    if (result === undefined) throw new Error('audit.seal returned no row');
    return result;
  }

  /** Appends `n` rows dated last month, as bos_owner (only the owner may pass p_occurred_at). */
  async function appendLastMonth(scope: Scope, n: number): Promise<EventRow[]> {
    for (let i = 0; i < n; i++) {
      await inTx(owner, settingsFor(scope), (c) =>
        c.query(
          `SELECT audit.append($1, $2, 'test.last_month', 'test', $3, NULL, NULL, NULL,
                  date_trunc('month', now()) - interval '1 day')`,
          [scope.tenantId, scope.organizationId, String(i)],
        ),
      );
    }
    return eventsOf(scope.tenantId);
  }

  async function sealsOf(tenantId: string) {
    const { rows } = await owner.query<{
      organization_id: string;
      chain_month: string;
      last_seq: string;
      last_hash: Buffer;
    }>(
      `SELECT organization_id, to_char(chain_month, 'YYYY-MM-DD') AS chain_month, last_seq, last_hash
         FROM audit.chain_seals WHERE tenant_id = $1`,
      [tenantId],
    );
    return rows;
  }

  it("seals last month's tail once, and a second call reports sealed=false", async () => {
    const scope = newScope();
    const events = await appendLastMonth(scope, 2);
    const month = events[0]?.chain_month ?? '';
    const last = events[1];

    // The job's work list includes the tenant for that month.
    const { rows: tenants } = await app.query<{ t: string }>(
      'SELECT t FROM audit.tenants_with_rows($1::date) AS t',
      [month],
    );
    expect(tenants.map((r) => r.t)).toContain(scope.tenantId);

    await expect(seal(scope.tenantId, month)).resolves.toEqual({ sealed: true, last_seq: '2' });
    expect(await sealsOf(scope.tenantId)).toEqual([
      {
        organization_id: scope.organizationId,
        chain_month: month,
        last_seq: '2',
        last_hash: last?.hash,
      },
    ]);

    await expect(seal(scope.tenantId, month)).resolves.toEqual({ sealed: false, last_seq: '2' });
    expect(await sealsOf(scope.tenantId)).toHaveLength(1);
  });

  it('reports sealed=false and writes nothing for a month with no rows', async () => {
    const scope = newScope();
    const events = await appendLastMonth(scope, 1);
    const month = events[0]?.chain_month ?? '';
    const earlier = `${String(Number(month.slice(0, 4)) - 1)}${month.slice(4)}`;
    await expect(seal(scope.tenantId, earlier)).resolves.toEqual({ sealed: false, last_seq: null });
    expect(await sealsOf(scope.tenantId)).toEqual([]);
  });

  it('refuses the current UTC month', async () => {
    const scope = newScope();
    await record(scope);
    const [event] = await eventsOf(scope.tenantId);
    await expect(seal(scope.tenantId, event?.chain_month ?? '')).rejects.toThrow(
      /is not a closed UTC month/,
    );
    expect(await sealsOf(scope.tenantId)).toEqual([]);
  });

  it('refuses to seal a tampered month and writes no seal', async () => {
    const scope = newScope();
    const events = await appendLastMonth(scope, 3);
    const month = events[0]?.chain_month ?? '';
    await inTx(superuser, null, async (c) => {
      await c.query('SET LOCAL session_replication_role = replica');
      await c.query(
        `UPDATE audit.audit_events SET entity_id = 'forged' WHERE tenant_id = $1 AND seq = 2`,
        [scope.tenantId],
      );
    });
    await expect(seal(scope.tenantId, month)).rejects.toThrow(/broken at seq 2; refusing to seal/);
    expect(await sealsOf(scope.tenantId)).toEqual([]);
  });
});

// Hardening of 0008_audit_hardening (FIX-C1a): review findings R4, R5, R15 and R27.
describe('audit hardening (0008)', () => {
  interface VerifyFull extends Verify {
    reason: string | null;
  }

  /** verify_chain with the reason column 0008 added, as bos_app. */
  async function verifyFull(tenantId: string, month?: string): Promise<VerifyFull> {
    const { rows } = await app.query<VerifyFull>(
      `SELECT ok, "rows", first_bad_seq, reason
         FROM audit.verify_chain($1, coalesce($2::date, (now() AT TIME ZONE 'UTC')::date))`,
      [tenantId, month ?? null],
    );
    const result = rows[0];
    if (result === undefined) throw new Error('verify_chain returned no row');
    return result;
  }

  /** audit.append as bos_owner with an explicit occurred_at (a SQL expression). */
  async function ownerAppend(scope: Scope, occurredAt: string, entityId = 'e'): Promise<void> {
    await inTx(owner, settingsFor(scope), (c) =>
      c.query(
        `SELECT audit.append($1, $2, 'test.owner', 'test', $3, NULL, NULL, NULL, ${occurredAt})`,
        [scope.tenantId, scope.organizationId, entityId],
      ),
    );
  }

  const LAST_MONTH = `date_trunc('month', now()) - interval '1 day'`;

  /** Runs one statement as the superuser with every trigger switched off (what an attacker could do). */
  async function asReplica(text: string, values: unknown[]): Promise<void> {
    await inTx(superuser, null, async (c) => {
      await c.query('SET LOCAL session_replication_role = replica');
      await c.query(text, values);
    });
  }

  const sealAsApp = (tenantId: string, month: string) =>
    app.query('SELECT * FROM audit.seal($1, $2::date)', [tenantId, month]);

  it('R4: never forks a month: a late owner append after a newer month lands in the newest month', async () => {
    const scope = newScope();
    await ownerAppend(scope, LAST_MONTH);
    await record(scope, 'test.this_month');
    // Dated one hour before this month began, i.e. last month, after this month already has a row.
    await ownerAppend(scope, `date_trunc('month', now()) - interval '1 hour'`, 'late');

    const events = await eventsOf(scope.tenantId);
    const [lastMonthRow, thisMonthRow, late] = events;
    expect(events).toHaveLength(3);
    expect(late?.entity_id).toBe('late');
    expect(late?.chain_month).toBe(thisMonthRow?.chain_month);
    expect(late?.chain_month).not.toBe(lastMonthRow?.chain_month);
    expect(late?.seq).toBe('2');
    expect(late?.prev_hash).toEqual(thisMonthRow?.hash);
    await expect(verifyFull(scope.tenantId)).resolves.toEqual({
      ok: true,
      rows: '2',
      first_bad_seq: null,
      reason: null,
    });
    await expect(verifyFull(scope.tenantId, lastMonthRow?.chain_month)).resolves.toMatchObject({
      ok: true,
      rows: '1',
    });
  });

  it('R5: writes hash_version 2 and detects a tampered organization_id', async () => {
    const scope = newScope();
    await record(scope, 'test.one');
    await record(scope, 'test.two');
    const { rows: versions } = await owner.query<{ hash_version: number }>(
      'SELECT hash_version FROM audit.audit_events WHERE tenant_id = $1 ORDER BY seq',
      [scope.tenantId],
    );
    expect(versions.map((r) => r.hash_version)).toEqual([2, 2]);

    await asReplica(
      'UPDATE audit.audit_events SET organization_id = $2 WHERE tenant_id = $1 AND seq = 1',
      [scope.tenantId, randomUUID()],
    );
    await expect(verifyFull(scope.tenantId)).resolves.toEqual({
      ok: false,
      rows: '2',
      first_bad_seq: '1',
      reason: 'hash_mismatch',
    });
  });

  it('R5: still verifies a v1 row written before 0008, chained to a v2 row', async () => {
    const scope = newScope();
    // A row exactly as 0001's append wrote it: hash_version 1, hashed by audit.event_hash (v1).
    await superuser.query(
      `WITH v AS (
         SELECT nextval(pg_get_serial_sequence('audit.audit_events', 'id')) AS id,
                date_trunc('month', now() AT TIME ZONE 'UTC')::date AS m, now() AS at)
       INSERT INTO audit.audit_events (id, tenant_id, organization_id, chain_month, seq, occurred_at,
         actor_kind, actor_id, action, entity_type, entity_id, before, after, meta, ip, user_agent,
         correlation_id, prev_hash, hash, hash_version)
       OVERRIDING SYSTEM VALUE
       SELECT v.id, $1::uuid, $2::uuid, v.m, 1, v.at, 'system', 'v1', 'test.v1', 'test', 'e',
              NULL::jsonb, '{"n":1}'::jsonb, NULL::jsonb, '10.0.0.0/24'::inet, NULL::text, 'c',
              '\\x00'::bytea,
              audit.event_hash('\\x00'::bytea, v.id, $1::uuid, v.m, 1, v.at, 'system', 'v1', 'test.v1',
                'test', 'e', NULL::jsonb, '{"n":1}'::jsonb, NULL::jsonb, '10.0.0.0/24'::inet, NULL::text,
                'c'),
              1
         FROM v`,
      [scope.tenantId, scope.organizationId],
    );
    await record(scope, 'test.v2');
    await expect(verifyFull(scope.tenantId)).resolves.toEqual({
      ok: true,
      rows: '2',
      first_bad_seq: null,
      reason: null,
    });
  });

  it('R15: reports a row deleted from a sealed month, and refuses to re-seal it', async () => {
    const scope = newScope();
    await ownerAppend(scope, LAST_MONTH, '0');
    await ownerAppend(scope, LAST_MONTH, '1');
    const month = (await eventsOf(scope.tenantId))[0]?.chain_month ?? '';
    await expect(sealAsApp(scope.tenantId, month)).resolves.toMatchObject({
      rows: [{ sealed: true, last_seq: '2' }],
    });

    await asReplica('DELETE FROM audit.audit_events WHERE tenant_id = $1 AND seq = 2', [
      scope.tenantId,
    ]);
    await expect(verifyFull(scope.tenantId, month)).resolves.toMatchObject({
      ok: false,
      rows: '1',
      reason: 'seal_count_mismatch',
    });
    await expect(sealAsApp(scope.tenantId, month)).rejects.toThrow(/refusing to seal/);
  });

  it('R15: refuses to append into a sealed month', async () => {
    const scope = newScope();
    await ownerAppend(scope, LAST_MONTH);
    const month = (await eventsOf(scope.tenantId))[0]?.chain_month ?? '';
    await sealAsApp(scope.tenantId, month);
    await expect(ownerAppend(scope, LAST_MONTH, 'after-seal')).rejects.toThrow(/is sealed/);
    expect(await eventsOf(scope.tenantId)).toHaveLength(1);
  });

  it('R15: makes chain_seals append-only, even for bos_owner', async () => {
    const scope = newScope();
    await ownerAppend(scope, LAST_MONTH);
    const month = (await eventsOf(scope.tenantId))[0]?.chain_month ?? '';
    await sealAsApp(scope.tenantId, month);
    await expect(
      owner.query('UPDATE audit.chain_seals SET last_seq = 99 WHERE tenant_id = $1', [
        scope.tenantId,
      ]),
    ).rejects.toThrow('chain_seals is append-only');
    await expect(
      owner.query('DELETE FROM audit.chain_seals WHERE tenant_id = $1', [scope.tenantId]),
    ).rejects.toThrow('chain_seals is append-only');
    await expect(owner.query('TRUNCATE audit.chain_seals')).rejects.toThrow(
      'chain_seals is append-only',
    );
  });

  it('R27: refuses to append outside READ COMMITTED', async () => {
    const scope = newScope();
    const c = await app.connect();
    try {
      // The isolation level must be set before the first statement takes a snapshot.
      await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      for (const [key, value] of Object.entries(settingsFor(scope))) {
        await c.query('SELECT set_config($1, $2, true)', [key, value]);
      }
      await expect(
        c.query(`SELECT audit.record('x.y', 'test', '1', NULL, NULL, NULL)`),
      ).rejects.toThrow(/read committed/i);
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
    expect(await eventsOf(scope.tenantId)).toEqual([]);
  });

  it('R27: ends the search_path of every SECURITY DEFINER function in audit with pg_temp', async () => {
    const { rows } = await owner.query<{ proname: string; proconfig: string[] | null }>(
      `SELECT p.proname, p.proconfig FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'audit' AND p.prosecdef ORDER BY p.proname`,
    );
    expect(rows.map((r) => r.proname)).toEqual(
      expect.arrayContaining(['append', 'capture_row', 'record', 'seal', 'verify_chain']),
    );
    for (const { proname, proconfig } of rows) {
      const path = (proconfig ?? []).find((s) => s.startsWith('search_path='));
      const last = path?.slice('search_path='.length).split(',').pop()?.trim();
      expect({ proname, last }).toEqual({ proname, last: 'pg_temp' });
    }
  });
});

// Privileges of 0008_audit_hardening (FIX-C1b): review finding R16.
describe('privileges after 0008 (R16)', () => {
  const denied = { code: '42501' };

  it('R16: denies bos_app every statement on the drizzle migration journal (42501)', async () => {
    // With the journal writable, a compromised API could mark future migrations as applied and skip them.
    await expect(
      app.query(`INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ('x', 1)`),
    ).rejects.toMatchObject(denied);
    await expect(app.query('SELECT 1 FROM drizzle.__drizzle_migrations')).rejects.toMatchObject(
      denied,
    );
    await expect(
      app.query(`UPDATE drizzle.__drizzle_migrations SET hash = 'x'`),
    ).rejects.toMatchObject(denied);
    await expect(app.query('DELETE FROM drizzle.__drizzle_migrations')).rejects.toMatchObject(
      denied,
    );
  });

  it('R16: a function bos_owner creates later is not executable by bos_app until it is granted', async () => {
    // PostgreSQL gives PUBLIC EXECUTE on every new function; the default privileges of 0008 take that away.
    for (const schema of ['app', 'audit']) {
      const fn = `${schema}.dp_probe_fn`;
      await owner.query(`CREATE FUNCTION ${fn}() RETURNS int LANGUAGE sql AS 'SELECT 1'`);
      try {
        await expect(app.query(`SELECT ${fn}()`)).rejects.toMatchObject(denied);
        await owner.query(`GRANT EXECUTE ON FUNCTION ${fn}() TO bos_app`);
        await expect(app.query(`SELECT ${fn}() AS n`)).resolves.toMatchObject({ rows: [{ n: 1 }] });
      } finally {
        await owner.query(`DROP FUNCTION IF EXISTS ${fn}()`);
      }
    }
  });

  it('R16: a table bos_owner creates later in audit is not readable or writable by bos_app', async () => {
    await owner.query('CREATE TABLE audit.dp_probe_tbl (n int)');
    try {
      await expect(app.query('SELECT 1 FROM audit.dp_probe_tbl')).rejects.toMatchObject(denied);
      await expect(app.query('INSERT INTO audit.dp_probe_tbl VALUES (1)')).rejects.toMatchObject(
        denied,
      );
    } finally {
      await owner.query('DROP TABLE IF EXISTS audit.dp_probe_tbl');
    }
  });

  it('R16: still lets bos_app write to a table bos_owner creates later in app and ops', async () => {
    // The change to the default table privileges must not take away the API's access to its own schemas.
    for (const schema of ['app', 'ops']) {
      const tbl = `${schema}.dp_probe_dml`;
      await owner.query(`CREATE TABLE ${tbl} (n int)`);
      try {
        await app.query(`INSERT INTO ${tbl} VALUES (1)`);
        await app.query(`UPDATE ${tbl} SET n = 2`);
        await expect(app.query(`SELECT n FROM ${tbl}`)).resolves.toMatchObject({
          rows: [{ n: 2 }],
        });
        await app.query(`DELETE FROM ${tbl}`);
      } finally {
        await owner.query(`DROP TABLE IF EXISTS ${tbl}`);
      }
    }
  });

  it('R16: still lets bos_app call each of the five intended audit functions', async () => {
    const scope = newScope();
    await expect(record(scope)).resolves.toMatch(/^\d+$/);
    await expect(
      app.query('SELECT id FROM audit.read_events($1, NULL, NULL, NULL, NULL, NULL, NULL, 10)', [
        scope.tenantId,
      ]),
    ).resolves.toMatchObject({ rowCount: 1 });
    await expect(
      app.query(`SELECT ok FROM audit.verify_chain($1, (now() AT TIME ZONE 'UTC')::date)`, [
        scope.tenantId,
      ]),
    ).resolves.toMatchObject({ rows: [{ ok: true }] });
    // A closed month with no rows: nothing to seal, and nothing written.
    await expect(
      app.query(`SELECT sealed FROM audit.seal($1, date '2020-01-01')`, [scope.tenantId]),
    ).resolves.toMatchObject({ rows: [{ sealed: false }] });
    const { rows: tenants } = await app.query<{ t: string }>(
      `SELECT t FROM audit.tenants_with_rows((now() AT TIME ZONE 'UTC')::date) AS t`,
    );
    expect(tenants.map((r) => r.t)).toContain(scope.tenantId);
  });

  it('reads distinct user actors for the transaction tenant, organization, entity and actions', async () => {
    const scope = newScope();
    const add = (s: Scope, actor: string, action = 'edit', entityId = '1') =>
      inTx(app, settingsFor(s, { 'bos.actor_kind': 'user', 'bos.actor_id': actor }), (c) =>
        c.query("SELECT audit.record($1, 'test', $2, NULL, NULL, NULL)", [action, entityId]),
      );
    await add(scope, 'editor');
    await add(scope, 'editor');
    await add(scope, 'viewer', 'view');
    await add(scope, 'another-entity', 'edit', '2');
    await add({ ...scope, organizationId: randomUUID() }, 'another-organization');
    await add({ ...scope, tenantId: randomUUID() }, 'another-tenant');
    const query = "SELECT actor_id FROM audit.entity_user_actors('test', '1', ARRAY['edit'])";
    expect((await inTx(app, settingsFor(scope), (c) => c.query(query))).rows).toEqual([
      { actor_id: 'editor' },
    ]);
    expect((await app.query(query)).rows).toEqual([]);
  });

  it('R16: bos_app can execute exactly these functions in audit, and PUBLIC none', async () => {
    const { rows } = await owner.query<{ proname: string; app: boolean; public: boolean }>(
      `SELECT p.proname,
              has_function_privilege('bos_app', p.oid, 'EXECUTE') AS app,
              (p.proacl IS NULL OR coalesce(bool_or(a.grantee = 0), false)) AS public
         FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
         LEFT JOIN LATERAL aclexplode(p.proacl) a ON true
        WHERE n.nspname = 'audit'
        GROUP BY p.oid, p.proname, p.proacl ORDER BY p.proname`,
    );
    expect(rows.filter((r) => r.app).map((r) => r.proname)).toEqual([
      'entity_user_actors',
      'read_events',
      'record',
      'seal',
      'tenants_with_rows',
      'verify_chain',
    ]);
    expect(rows.filter((r) => r.public)).toEqual([]);
  });
});
