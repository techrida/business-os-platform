// Runs once, in the main Vitest process, before any e2e file. It starts the real dependencies,
// prepares the database the way production does, and hands the addresses to the tests.
//
// Roles follow infra/postgres/init-dbs.sh (and packages/db/src/db.test.ts): `bos_owner` owns the
// schema and runs migrations, `bos_app` is the runtime role with data access only. The API under
// test connects as `bos_app`, so a missing GRANT shows up here instead of in production.
import { randomUUID } from 'node:crypto';

import { migrate, organizations, tenants } from '@bos/db';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { GenericContainer, Wait } from 'testcontainers';
import type { TestProject } from 'vitest/node';

/** One seeded organization, as the tests need to know it. */
export interface SeededOrg {
  /** `organizations.id` (equal to `organization_id`). */
  organizationId: string;
  /** The ZITADEL org id a token for this org carries in `urn:zitadel:iam:user:resourceowner:id`. */
  zitadelOrgId: string;
}

export interface E2eContext {
  /** `bos_app` connection string: what the API's DATABASE_URL is in production. */
  databaseUrl: string;
  valkeyUrl: string;
  tenantId: string;
  staff: SeededOrg;
  customer: SeededOrg;
  /** Mailpit SMTP (smtp://host:port): the SMTP_URL an e2e that sends email gives the API and worker. */
  mailpitSmtpUrl: string;
  /** Mailpit HTTP base (http://host:port); its REST API is under /api/v1. */
  mailpitApiUrl: string;
}

// `inject('e2e')` in the tests is typed through this declaration.
declare module 'vitest' {
  export interface ProvidedContext {
    e2e: E2eContext;
  }
}

const OWNER_PW = 'owner-e2e-pw';
const APP_PW = 'app-e2e-pw';

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const postgres = await new PostgreSqlContainer('postgres:16-alpine').start();
  const valkey = await new GenericContainer('valkey/valkey:9.1-alpine')
    .withExposedPorts(6379)
    .withWaitStrategy(Wait.forLogMessage(/Ready to accept connections/))
    .start();
  // A real SMTP sink with a REST API, so an e2e can prove an email was really sent, not just queued.
  const mailpit = await new GenericContainer('axllent/mailpit:v1.33')
    .withExposedPorts(1025, 8025)
    .withWaitStrategy(Wait.forHttp('/livez', 8025))
    .start();

  const urlFor = (user: string, password: string, database: string): string => {
    const url = new URL(postgres.getConnectionUri());
    url.username = user;
    url.password = password;
    url.pathname = `/${database}`;
    return url.toString();
  };

  // The container starts with only a superuser: create what init-dbs.sh creates in the real stack.
  const admin = new Pool({ connectionString: postgres.getConnectionUri(), max: 1 });
  await admin.query(`CREATE ROLE bos_owner LOGIN PASSWORD '${OWNER_PW}'`);
  await admin.query(`CREATE ROLE bos_app LOGIN PASSWORD '${APP_PW}'`);
  await admin.query('CREATE DATABASE bos OWNER bos_owner');
  await admin.query('REVOKE ALL ON DATABASE bos FROM PUBLIC');
  await admin.query('GRANT CONNECT ON DATABASE bos TO bos_app');
  await admin.end();

  // Default privileges belong to one database, so they are set from inside "bos".
  const bosAdmin = new Pool({ connectionString: urlFor('test', 'test', 'bos'), max: 1 });
  await bosAdmin.query(
    'ALTER DEFAULT PRIVILEGES FOR ROLE bos_owner GRANT USAGE ON SCHEMAS TO bos_app',
  );
  await bosAdmin.query(
    'ALTER DEFAULT PRIVILEGES FOR ROLE bos_owner GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO bos_app',
  );
  await bosAdmin.end();

  await migrate(urlFor('bos_owner', OWNER_PW, 'bos'));

  // Seed as bos_app: the same role the API uses at runtime.
  const databaseUrl = urlFor('bos_app', APP_PW, 'bos');
  const appPool = new Pool({ connectionString: databaseUrl, max: 1 });
  const db = drizzle({ client: appPool });
  // The audit trigger (0001) refuses app writes with no actor. The pool has one connection, so a
  // session-level (is_local = false) seed actor covers every insert below.
  await appPool.query(
    "SELECT set_config('bos.actor_kind', 'seed', false), set_config('bos.actor_id', 'seed:e2e', false), set_config('bos.correlation_id', 'e2e-global-setup', false)",
  );
  const [tenant] = await db.insert(tenants).values({}).returning({ id: tenants.id });
  if (tenant === undefined) throw new Error('tenant insert returned no row');

  const seed = async (
    kind: 'staff' | 'customer',
    name: string,
    zitadelOrgId: string,
  ): Promise<SeededOrg> => {
    const id = randomUUID();
    await db.insert(organizations).values({
      id,
      tenantId: tenant.id,
      organizationId: id,
      kind,
      name,
      zitadelOrgId,
    });
    return { organizationId: id, zitadelOrgId };
  };
  // ZITADEL ids are long numeric strings; use the same shape so nothing depends on a UUID format.
  const staff = await seed('staff', 'Techrida (e2e staff)', '310000000000000001');
  const customer = await seed('customer', 'Acme (e2e customer)', '310000000000000002');
  await appPool.end();

  project.provide('e2e', {
    databaseUrl,
    valkeyUrl: `redis://${valkey.getHost()}:${valkey.getMappedPort(6379)}`,
    tenantId: tenant.id,
    staff,
    customer,
    mailpitSmtpUrl: `smtp://${mailpit.getHost()}:${mailpit.getMappedPort(1025)}`,
    mailpitApiUrl: `http://${mailpit.getHost()}:${mailpit.getMappedPort(8025)}`,
  });

  return async () => {
    await Promise.allSettled([postgres.stop(), valkey.stop(), mailpit.stop()]);
  };
}
