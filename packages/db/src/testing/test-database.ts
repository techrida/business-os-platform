// The one way an integration test gets a migrated Postgres database.
//
// `vitest-global-setup.ts` starts ONE postgres:16-alpine container per vitest run, creates the roles of
// infra/postgres/init-dbs.sh and applies every migration once into a template database. A test file calls
// `createTestDatabase()` in beforeAll and gets its own `CREATE DATABASE … TEMPLATE …` copy: the isolation of a
// container of its own, for a file copy instead of a container start and 90 migrations.
//
// This file only needs `pg`: it runs inside the test workers and reads the container address that the global
// setup put in the environment. Nothing may start a PostgreSqlContainer outside the global setup.
import { randomBytes } from 'node:crypto';

import { Pool } from 'pg';

/** Passwords of the two roles every test database shares (roles live in the cluster, not in a database). */
export const TEST_OWNER_PASSWORD = 'owner-test-pw';
export const TEST_APP_PASSWORD = 'app-test-pw';

/** Superuser connection string of the shared container, set by the global setup. */
export const ENV_PG_URI = 'BOS_TEST_PG_URI';
export const ENV_TEMPLATE_MIGRATED = 'BOS_TEST_TEMPLATE_MIGRATED';
export const ENV_TEMPLATE_BASE = 'BOS_TEST_TEMPLATE_BASE';

export interface TestDatabase {
  /** The database's name, unique in the cluster. */
  readonly name: string;
  /** Superuser (`test`) connection string to this database, what `container.getConnectionUri()` used to be. */
  readonly adminUrl: string;
  /** `bos_owner`: owns the schema and runs migrations. */
  readonly ownerUrl: string;
  /** `bos_app`: the runtime role with data access only. */
  readonly appUrl: string;
  /** A connection string for any role and database of the cluster (default: this database). */
  urlFor(user: string, password: string, database?: string): string;
  /** Drops the database, closing any connection still open on it. Call it from afterAll. */
  drop(): Promise<void>;
}

export interface CreateTestDatabaseOptions {
  /**
   * `true` (default): every migration is applied, as after `runMigrations`.
   * `false`: roles and privileges as init-dbs.sh sets them, but no migration, for tests that apply migrations
   * themselves (partial journals, upgrade paths).
   */
  migrated?: boolean;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is not set: this test must run under a vitest config that has ` +
        `globalSetup: ['<repo>/packages/db/src/testing/vitest-global-setup.ts'] (Docker is required).`,
    );
  }
  return value;
}

function connectionFor(
  base: string,
  user: string | null,
  password: string | null,
  database: string,
) {
  const url = new URL(base);
  if (user !== null && password !== null) {
    url.username = user;
    url.password = password;
  }
  url.pathname = `/${database}`;
  return url.toString();
}

const MAX_ATTEMPTS = 8;

export async function createTestDatabase(
  options: CreateTestDatabaseOptions = {},
): Promise<TestDatabase> {
  const base = required(ENV_PG_URI);
  const template = required(options.migrated === false ? ENV_TEMPLATE_BASE : ENV_TEMPLATE_MIGRATED);
  const name = `bos_t_${randomBytes(6).toString('hex')}`;
  const admin = new Pool({ connectionString: connectionFor(base, null, null, 'postgres'), max: 1 });
  try {
    // PostgreSQL refuses a template that another session touches at that moment, and two copies of the
    // same template started together can collide. A cluster-wide advisory lock keeps the copies in line;
    // the retry covers a copy started by another vitest run that shares this cluster.
    for (let attempt = 1; ; attempt += 1) {
      try {
        await admin.query('SELECT pg_advisory_lock(7_000_001)');
        try {
          await admin.query(`CREATE DATABASE ${name} TEMPLATE ${template} OWNER bos_owner`);
        } finally {
          await admin.query('SELECT pg_advisory_unlock(7_000_001)');
        }
        break;
      } catch (error) {
        if (attempt >= MAX_ATTEMPTS) throw error;
        await new Promise((resolve) => setTimeout(resolve, 100 * attempt));
      }
    }
    await admin.query(`REVOKE ALL ON DATABASE ${name} FROM PUBLIC`);
    await admin.query(`GRANT CONNECT ON DATABASE ${name} TO bos_app`);
  } finally {
    await admin.end();
  }

  const urlFor = (user: string, password: string, database: string = name): string =>
    connectionFor(base, user, password, database);
  return {
    name,
    adminUrl: connectionFor(base, null, null, name),
    ownerUrl: urlFor('bos_owner', TEST_OWNER_PASSWORD),
    appUrl: urlFor('bos_app', TEST_APP_PASSWORD),
    urlFor,
    async drop() {
      const dropper = new Pool({
        connectionString: connectionFor(base, null, null, 'postgres'),
        max: 1,
      });
      try {
        await dropper.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      } finally {
        await dropper.end();
      }
    },
  };
}
