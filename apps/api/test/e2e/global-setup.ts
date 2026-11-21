// Runs once, in the main Vitest process, before any e2e file. It starts the real dependencies,
// takes a migrated database from the shared Postgres (packages/db/src/testing, started by the first
// globalSetup of vitest.e2e.config.ts) and hands the addresses to the tests.
//
// Roles follow infra/postgres/init-dbs.sh (and packages/db/src/db.test.ts): `bos_owner` owns the
// schema and runs migrations, `bos_app` is the runtime role with data access only. The API under
// test connects as `bos_app`, so a missing GRANT shows up here instead of in production.
import { createParty, createTenantWithEntity } from '@bos/db';
import { createTestDatabase } from '@bos/db/testing';
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

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const valkey = await new GenericContainer('valkey/valkey:9.1-alpine')
    .withExposedPorts(6379)
    .withWaitStrategy(Wait.forLogMessage(/Ready to accept connections/))
    .start();
  // A real SMTP sink with a REST API, so an e2e can prove an email was really sent, not just queued.
  const mailpit = await new GenericContainer('axllent/mailpit:v1.33')
    .withExposedPorts(1025, 8025)
    .withWaitStrategy(Wait.forHttp('/livez', 8025))
    .start();

  // Roles, privileges and migrations come from the shared test database (see the header): the API
  // under test connects as `bos_app`, exactly as in production.
  const testDb = await createTestDatabase();

  // Seed as bos_app: the same role the API uses at runtime. The @bos/db fixtures open their own
  // transaction per call and set the audit context (actor, tenant, entity) in it, as withTx does.
  const databaseUrl = testDb.appUrl;
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
    await Promise.allSettled([testDb.drop(), valkey.stop(), mailpit.stop()]);
  };
}
