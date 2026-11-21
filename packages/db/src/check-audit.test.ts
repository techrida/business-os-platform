// Integration test for check-audit: a database of its own on the run's shared postgres:16-alpine (needs Docker).
// Run with: pnpm --filter @bos/db exec vitest run src/check-audit.test.ts
//
// It builds its own schemas and a stand-in audit.capture_row() instead of running the migrations, so it does
// not depend on the real audit migration (0001). What it proves is the checker's logic: which tables it flags.
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { assertAudit, checkAudit } from './check-audit.js';
import { createTestDatabase, type TestDatabase } from './testing/test-database.js';

let testDb: TestDatabase;
let pool: Pool;

beforeAll(async () => {
  // No migration: the file builds its own schemas.
  testDb = await createTestDatabase({ migrated: false });
  pool = new Pool({ connectionString: testDb.adminUrl, max: 2 });
  await pool.query('CREATE SCHEMA audit');
  await pool.query('CREATE SCHEMA app');
  // Fixture: same name and schema as the real function, but it does nothing.
  await pool.query(
    `CREATE FUNCTION audit.capture_row() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$`,
  );
  // A function with the right trigger shape but the wrong name, for the "wrong function" case.
  await pool.query(
    `CREATE FUNCTION audit.other_fn() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$`,
  );
});

afterAll(async () => {
  await pool?.end();
  await testDb?.drop();
});

/** Runs the fixture SQL in a transaction, checks, and rolls back so tests never leak into each other. */
async function offendersFor(setupSql: string[]): Promise<string[]> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const sql of setupSql) await client.query(sql);
    return await checkAudit(client);
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

const trigger = (table: string, fn = 'audit.capture_row', name = 'audit_capture') =>
  `CREATE TRIGGER ${name} AFTER INSERT OR UPDATE OR DELETE ON app.${table}
     FOR EACH ROW EXECUTE FUNCTION ${fn}()`;

/** Same as offendersFor, but returns the message assertAudit throws ('' when it does not throw). */
async function messageFor(setupSql: string[]): Promise<string> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const sql of setupSql) await client.query(sql);
    try {
      await assertAudit(client);
      return '';
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

describe('check-audit', () => {
  it('passes on an empty app schema', async () => {
    await expect(checkAudit(pool)).resolves.toEqual([]);
    await expect(assertAudit(pool)).resolves.toBeUndefined();
  });

  it('flags only the table without the audit_capture trigger', async () => {
    const offenders = await offendersFor([
      'CREATE TABLE app.good (id uuid PRIMARY KEY)',
      trigger('good'),
      'CREATE TABLE app.bad (id uuid PRIMARY KEY)',
    ]);
    expect(offenders).toEqual(['app.bad']);
  });

  it('lets an allowlisted table through without the trigger', async () => {
    const offenders = await offendersFor([
      'CREATE TABLE app.tenants (id uuid PRIMARY KEY)',
      'CREATE TABLE app.notifications (id uuid PRIMARY KEY)',
      'CREATE TABLE app.outbox (id uuid PRIMARY KEY)',
      'CREATE TABLE app.authz_versions (id uuid PRIMARY KEY)',
    ]);
    expect(offenders).toEqual([]);
  });

  it('flags a trigger with the right name but the wrong function', async () => {
    const offenders = await offendersFor([
      'CREATE TABLE app.wrong_fn (id uuid PRIMARY KEY)',
      trigger('wrong_fn', 'audit.other_fn'),
    ]);
    expect(offenders).toEqual(['app.wrong_fn']);
  });

  it('flags the right function under the wrong trigger name', async () => {
    const offenders = await offendersFor([
      'CREATE TABLE app.wrong_name (id uuid PRIMARY KEY)',
      trigger('wrong_name', 'audit.capture_row', 'some_other_name'),
    ]);
    expect(offenders).toEqual(['app.wrong_name']);
  });

  it('is not satisfied by an internal foreign-key trigger', async () => {
    // A foreign key creates internal triggers on both tables; they must not count as audit triggers.
    const offenders = await offendersFor([
      'CREATE TABLE app.parent (id uuid PRIMARY KEY)',
      trigger('parent'),
      'CREATE TABLE app.child (id uuid PRIMARY KEY, parent_id uuid REFERENCES app.parent(id))',
    ]);
    expect(offenders).toEqual(['app.child']);
  });

  it('checks partitioned tables too', async () => {
    const offenders = await offendersFor([
      'CREATE TABLE app.parted (id uuid, month date) PARTITION BY RANGE (month)',
    ]);
    expect(offenders).toEqual(['app.parted']);
  });

  it('passes the real trigger shape in both always-on enabled modes', async () => {
    // tgenabled 'O' (default, fires unless session_replication_role = replica) and 'A' (fires always).
    const offenders = await offendersFor([
      'CREATE TABLE app.on_default (id uuid PRIMARY KEY)',
      trigger('on_default'),
      'CREATE TABLE app.on_always (id uuid PRIMARY KEY)',
      trigger('on_always'),
      'ALTER TABLE app.on_always ENABLE ALWAYS TRIGGER audit_capture',
    ]);
    expect(offenders).toEqual([]);
  });

  it('flags a disabled audit trigger and says it is disabled', async () => {
    const setup = [
      'CREATE TABLE app.disabled_t (id uuid PRIMARY KEY)',
      trigger('disabled_t'),
      'ALTER TABLE app.disabled_t DISABLE TRIGGER audit_capture',
    ];
    expect(await offendersFor(setup)).toEqual(['app.disabled_t']);
    expect(await messageFor(setup)).toMatch(/app\.disabled_t.*disabled/);
  });

  it('flags an ENABLE REPLICA trigger: it is silent in a normal session', async () => {
    const setup = [
      'CREATE TABLE app.replica_t (id uuid PRIMARY KEY)',
      trigger('replica_t'),
      'ALTER TABLE app.replica_t ENABLE REPLICA TRIGGER audit_capture',
    ];
    expect(await offendersFor(setup)).toEqual(['app.replica_t']);
    expect(await messageFor(setup)).toMatch(/app\.replica_t.*replica/);
  });

  it('flags a statement-level audit trigger', async () => {
    const setup = [
      'CREATE TABLE app.stmt_t (id uuid PRIMARY KEY)',
      `CREATE TRIGGER audit_capture AFTER INSERT OR UPDATE OR DELETE ON app.stmt_t
         FOR EACH STATEMENT EXECUTE FUNCTION audit.capture_row()`,
    ];
    expect(await offendersFor(setup)).toEqual(['app.stmt_t']);
    expect(await messageFor(setup)).toMatch(/app\.stmt_t.*statement-level/);
  });

  it('flags a BEFORE audit trigger', async () => {
    // BEFORE would record a row a later trigger or a constraint can still change or reject.
    const setup = [
      'CREATE TABLE app.before_t (id uuid PRIMARY KEY)',
      `CREATE TRIGGER audit_capture BEFORE INSERT OR UPDATE OR DELETE ON app.before_t
         FOR EACH ROW EXECUTE FUNCTION audit.capture_row()`,
    ];
    expect(await offendersFor(setup)).toEqual(['app.before_t']);
    expect(await messageFor(setup)).toMatch(/app\.before_t.*BEFORE/);
  });

  it.each(['INSERT', 'UPDATE', 'DELETE', 'INSERT OR UPDATE', 'UPDATE OR DELETE'])(
    'flags a trigger that fires on %s only',
    async (events) => {
      const name = `only_${events.toLowerCase().replaceAll(' ', '_')}`;
      const setup = [
        `CREATE TABLE app.${name} (id uuid PRIMARY KEY)`,
        `CREATE TRIGGER audit_capture AFTER ${events} ON app.${name}
         FOR EACH ROW EXECUTE FUNCTION audit.capture_row()`,
      ];
      expect(await offendersFor(setup)).toEqual([`app.${name}`]);
      expect(await messageFor(setup)).toMatch(
        new RegExp(`app\\.${name}.*INSERT, UPDATE and DELETE`),
      );
    },
  );

  it('names the offending tables in assertAudit and leaves other schemas alone', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('CREATE TABLE app.bad_one (id uuid PRIMARY KEY)');
      await client.query('CREATE TABLE audit.not_checked (id uuid PRIMARY KEY)');
      await expect(assertAudit(client)).rejects.toThrow(/app\.bad_one/);
      await expect(assertAudit(client)).rejects.not.toThrow(/not_checked/);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});
