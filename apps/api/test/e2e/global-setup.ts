// Runs once, in the main Vitest process, before any e2e file. It starts the real dependencies,
// prepares the database the way production does, and hands the addresses to the tests.
//
// Roles follow infra/postgres/init-dbs.sh (and packages/db/src/db.test.ts): `bos_owner` owns the
// schema and runs migrations, `bos_app` is the runtime role with data access only. The API under
// test connects as `bos_app`, so a missing GRANT shows up here instead of in production.
import { createParty, createTenantWithEntity, migrate } from '@bos/db';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { GenericContainer, Wait } from 'testcontainers';
import type { TestProject } from 'vitest/node';

/** One seeded IdP org (a ZITADEL org), as the tests need to know it (ADR 0027). */
export interface SeededOrg {
  /** The legal entity the org's users act in: the tenant's default entity (`organizations.id`). */
  organizationId: string;
  /** `idp_orgs.id`. */
  idpOrgId: string;
  /** The ZITADEL org id a token for this org carries in `urn:zitadel:iam:user:resourceowner:id`. */
  zitadelOrgId: string;
  /** The customer party behind the org; null for the staff org. */
  partyId: string | null;
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

  // Seed as bos_app: the same role the API uses at runtime. The @bos/db fixtures open their own
  // transaction per call and set the audit context (actor, tenant, entity) in it, as withTx does.
  const databaseUrl = urlFor('bos_app', APP_PW, 'bos');
  const appPool = new Pool({ connectionString: databaseUrl, max: 2 });
  // ADR 0027: one tenant, its default legal entity and the staff IdP org (the login container of
  // staff), plus a customer party behind its own customer IdP org. A customer or vendor user has no
  // entity of its own: it acts in the tenant's default entity, so both orgs share `organizationId`.
  const tenantEntity = await createTenantWithEntity(appPool, {
    code: 'E2E',
    name: 'Techrida (e2e entity)',
  });
  const party = await createParty(appPool, { tenantId: tenantEntity.tenantId, kind: 'customer' });

  // The fixtures mint a random ZITADEL org id per IdP org. The test issuer must put the same id in
  // `urn:zitadel:iam:user:resourceowner:id`, so read back what was stored instead of assuming it.
  const { rows: idpRows } = await appPool.query<{ id: string; zitadel_org_id: string }>(
    'SELECT id, zitadel_org_id FROM app.idp_orgs WHERE id = ANY($1::uuid[])',
    [[tenantEntity.idpOrgId, party.idpOrgId]],
  );
  const zitadelOrgOf = (idpOrgId: string): string => {
    const found = idpRows.find((r) => r.id === idpOrgId)?.zitadel_org_id;
    if (found === undefined) throw new Error(`idp_orgs row ${idpOrgId} was not seeded`);
    return found;
  };
  const staff: SeededOrg = {
    organizationId: tenantEntity.organizationId,
    idpOrgId: tenantEntity.idpOrgId,
    zitadelOrgId: zitadelOrgOf(tenantEntity.idpOrgId),
    partyId: null,
  };
  const customer: SeededOrg = {
    organizationId: tenantEntity.organizationId,
    idpOrgId: party.idpOrgId,
    zitadelOrgId: zitadelOrgOf(party.idpOrgId),
    partyId: party.partyId,
  };
  await appPool.end();

  project.provide('e2e', {
    databaseUrl,
    valkeyUrl: `redis://${valkey.getHost()}:${valkey.getMappedPort(6379)}`,
    tenantId: tenantEntity.tenantId,
    staff,
    customer,
    mailpitSmtpUrl: `smtp://${mailpit.getHost()}:${mailpit.getMappedPort(1025)}`,
    mailpitApiUrl: `http://${mailpit.getHost()}:${mailpit.getMappedPort(8025)}`,
  });

  return async () => {
    await Promise.allSettled([postgres.stop(), valkey.stop(), mailpit.stop()]);
  };
}
