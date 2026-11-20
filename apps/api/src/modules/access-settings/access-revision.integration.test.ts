// "Last changed by" on Access Settings (readAccessRevision): the updater's display name, or "Unnamed user" when they
// have none (D54-2), never their address; null when no person is recorded.
// Runs against a real postgres:16-alpine container started by Testcontainers (needs Docker in WSL).
// Run on Linux/WSL with:
//   pnpm --filter @bos/api exec vitest run src/modules/access-settings/access-revision.integration.test.ts
import { createStaffUser, createTenantWithEntity, runMigrations } from '@bos/db';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Db } from '../../platform/db/db.module';
import { type TxScope, systemActor, withTx } from '../../platform/db/tx';
import { bumpAccessRevision, readAccessRevision } from './access-revision';

const OWNER_PW = 'owner-test-pw';
const APP_PW = 'app-test-pw';

let container: StartedPostgreSqlContainer;
let appPool: Pool;
let db: Db;

function urlFor(user: string, password: string, database: string): string {
  const url = new URL(container.getConnectionUri());
  url.username = user;
  url.password = password;
  url.pathname = `/${database}`;
  return url.toString();
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();

  const admin = new Pool({ connectionString: container.getConnectionUri(), max: 1 });
  await admin.query(`CREATE ROLE bos_owner LOGIN PASSWORD '${OWNER_PW}'`);
  await admin.query(`CREATE ROLE bos_app LOGIN PASSWORD '${APP_PW}'`);
  await admin.query('CREATE DATABASE bos OWNER bos_owner');
  await admin.query('REVOKE ALL ON DATABASE bos FROM PUBLIC');
  await admin.query('GRANT CONNECT ON DATABASE bos TO bos_app');
  await admin.end();

  const bosAdmin = new Pool({ connectionString: urlFor('test', 'test', 'bos'), max: 1 });
  await bosAdmin.query(
    'ALTER DEFAULT PRIVILEGES FOR ROLE bos_owner GRANT USAGE ON SCHEMAS TO bos_app',
  );
  await bosAdmin.query(
    'ALTER DEFAULT PRIVILEGES FOR ROLE bos_owner GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO bos_app',
  );
  await bosAdmin.end();

  await runMigrations(urlFor('bos_owner', OWNER_PW, 'bos'));

  appPool = new Pool({ connectionString: urlFor('bos_app', APP_PW, 'bos'), max: 4 });
  db = drizzle({ client: appPool });
}, 120_000);

afterAll(async () => {
  await appPool?.end();
  await container?.stop();
});

/** A fresh tenant whose access revision was last changed by a staff user with `displayName`. */
async function changedBy(
  displayName: string | null,
): Promise<{ scope: TxScope; userId: string; email: string }> {
  const tenant = await createTenantWithEntity(appPool);
  const scope: TxScope = { tenantId: tenant.tenantId, organizationId: tenant.organizationId };
  const { userId } = await createStaffUser(appPool, {
    ...scope,
    idpOrgId: tenant.idpOrgId,
    roleKeys: ['founder'],
  });
  const email = await withTx(db, scope, systemActor('test-seed'), async (tx) => {
    await tx.execute(
      sql`UPDATE app.users SET display_name = ${displayName} WHERE tenant_id = ${scope.tenantId} AND id = ${userId}`,
    );
    await bumpAccessRevision(tx, scope, { actorUserId: userId });
    const res = await tx.execute<{ email: string }>(
      sql`SELECT email FROM app.users WHERE tenant_id = ${scope.tenantId} AND id = ${userId}`,
    );
    return res.rows[0]!.email;
  });
  return { scope, userId, email };
}

describe('readAccessRevision: who last changed access', () => {
  it('is the display name of the person who saved', async () => {
    const { scope, userId } = await changedBy('Sita Sharma');
    const row = await readAccessRevision(db, scope.tenantId);
    expect(row.updatedByUserId).toBe(userId);
    expect(row.updatedByName).toBe('Sita Sharma');
  });

  it('is "Unnamed user", never the address, for a person with no display name', async () => {
    const { scope, userId, email } = await changedBy(null);
    expect(email).toContain('@');
    const row = await readAccessRevision(db, scope.tenantId);
    expect(row.updatedByUserId).toBe(userId);
    expect(row.updatedByName).toBe('Unnamed user');
    expect(row.updatedByName).not.toBe(email);
  });

  it('is "Unnamed user" for a blank display name', async () => {
    const { scope, email } = await changedBy('   ');
    const row = await readAccessRevision(db, scope.tenantId);
    expect(row.updatedByName).toBe('Unnamed user');
    expect(row.updatedByName).not.toBe(email);
  });

  it('is null when no person is recorded, and for a tenant that never changed access', async () => {
    const tenant = await createTenantWithEntity(appPool);
    const scope: TxScope = { tenantId: tenant.tenantId, organizationId: tenant.organizationId };
    expect((await readAccessRevision(db, scope.tenantId)).updatedByName).toBeNull();

    await withTx(db, scope, systemActor('test-seed'), (tx) => bumpAccessRevision(tx, scope));
    const row = await readAccessRevision(db, scope.tenantId);
    expect(row.revision).toBe('1');
    expect(row.updatedByUserId).toBeNull();
    expect(row.updatedByName).toBeNull();
  });

  it("does not name a person from another tenant's revision", async () => {
    const named = await changedBy('Sita Sharma');
    const other = await changedBy(null);
    expect((await readAccessRevision(db, named.scope.tenantId)).updatedByName).toBe('Sita Sharma');
    expect((await readAccessRevision(db, other.scope.tenantId)).updatedByName).toBe('Unnamed user');
  });
});
