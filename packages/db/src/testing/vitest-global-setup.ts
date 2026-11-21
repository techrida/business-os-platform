// Vitest `globalSetup` for every suite that needs Postgres: starts one postgres:16-alpine container for the
// whole run, prepares it the way infra/postgres/init-dbs.sh does and migrates once into a template database.
// Test files then copy that template with `createTestDatabase()` (test-database.ts).
//
// Wire it in a vitest config: `globalSetup: [fileURLToPath(new URL('<path>/packages/db/src/testing/vitest-global-setup.ts', import.meta.url))]`.
// Needs Docker. The container is stopped when the run ends (Testcontainers' reaper removes it if the run is killed).
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';

import { runMigrations } from '../migrate.js';

import {
  ENV_PG_URI,
  ENV_TEMPLATE_BASE,
  ENV_TEMPLATE_MIGRATED,
  TEST_APP_PASSWORD,
  TEST_OWNER_PASSWORD,
} from './test-database.js';

const BASE = 'bos_tpl_base';
const MIGRATED = 'bos_tpl_migrated';

function connection(uri: string, user: string, password: string, database: string): string {
  const url = new URL(uri);
  url.username = user;
  url.password = password;
  url.pathname = `/${database}`;
  return url.toString();
}

export default async function setup(): Promise<() => Promise<void>> {
  // Throwaway data: no fsync or full-page writes, enough connections for several workers' pools, and a data
  // directory in memory. Never copy these flags to a real database.
  const container = await new PostgreSqlContainer('postgres:16-alpine')
    .withCommand([
      'postgres',
      '-c',
      'fsync=off',
      '-c',
      'synchronous_commit=off',
      '-c',
      'full_page_writes=off',
      '-c',
      'max_connections=500',
    ])
    .withTmpFs({ '/var/lib/postgresql/data': 'rw' })
    .start();
  try {
    const uri = container.getConnectionUri();
    const admin = new Pool({ connectionString: uri, max: 1 });
    try {
      await admin.query(`CREATE ROLE bos_owner LOGIN PASSWORD '${TEST_OWNER_PASSWORD}'`);
      await admin.query(`CREATE ROLE bos_app LOGIN PASSWORD '${TEST_APP_PASSWORD}'`);
      await admin.query(`CREATE DATABASE ${BASE} OWNER bos_owner`);
    } finally {
      await admin.end();
    }

    // infra/postgres/init-dbs.sh, minus the zitadel database.
    const baseAdmin = new Pool({ connectionString: connection(uri, 'test', 'test', BASE), max: 1 });
    try {
      await baseAdmin.query('REVOKE ALL ON SCHEMA public FROM PUBLIC');
      await baseAdmin.query('GRANT USAGE ON SCHEMA public TO bos_app');
      await baseAdmin.query(
        'ALTER DEFAULT PRIVILEGES FOR ROLE bos_owner GRANT USAGE ON SCHEMAS TO bos_app',
      );
      await baseAdmin.query(
        'ALTER DEFAULT PRIVILEGES FOR ROLE bos_owner GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO bos_app',
      );
      await baseAdmin.query(
        'ALTER DEFAULT PRIVILEGES FOR ROLE bos_owner GRANT USAGE, SELECT ON SEQUENCES TO bos_app',
      );
    } finally {
      await baseAdmin.end();
    }

    const admin2 = new Pool({ connectionString: uri, max: 1 });
    try {
      await admin2.query(`CREATE DATABASE ${MIGRATED} TEMPLATE ${BASE} OWNER bos_owner`);
    } finally {
      await admin2.end();
    }
    await runMigrations(connection(uri, 'bos_owner', TEST_OWNER_PASSWORD, MIGRATED));

    process.env[ENV_PG_URI] = uri;
    process.env[ENV_TEMPLATE_BASE] = BASE;
    process.env[ENV_TEMPLATE_MIGRATED] = MIGRATED;
  } catch (error) {
    await container.stop();
    throw error;
  }
  return async () => {
    await container.stop();
  };
}
