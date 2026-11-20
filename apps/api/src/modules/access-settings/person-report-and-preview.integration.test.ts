// Integration tests for two Settings > Access edge cases (U20b-Q6): Check a person for someone who
// cannot enter the acting entity, and the dry run refusing what the save refuses.
// Runs against a real postgres:16-alpine container started by Testcontainers (needs Docker in WSL).
// Run on Linux/WSL with:
//   pnpm --filter @bos/api exec vitest run src/modules/access-settings/person-report-and-preview.integration.test.ts
import { randomUUID } from 'node:crypto';

import type { AccessChange } from '@bos/contracts';
import { createDepartment, createStaffUser, createTenantWithEntity, runMigrations } from '@bos/db';
import { UnprocessableEntityException } from '@nestjs/common';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AuditService } from '../../platform/audit/audit.service';
import { AuthzService } from '../../platform/authz/authz.service';
import { RoleCache } from '../../platform/authz/role-cache';
import type { Db } from '../../platform/db/db.module';
import { type Actor, type TxScope, systemActor, withTx } from '../../platform/db/tx';
import { AccessSettingsService } from './access-settings.service';

const OWNER_PW = 'owner-test-pw';
const APP_PW = 'app-test-pw';

let container: StartedPostgreSqlContainer;
let appPool: Pool;
let db: Db;
const clock = (): number => 1_000_000;

function urlFor(user: string, password: string, database: string): string {
  const url = new URL(container.getConnectionUri());
  url.username = user;
  url.password = password;
  url.pathname = `/${database}`;
  return url.toString();
}

interface Env {
  scope: TxScope;
  otherEntity: TxScope;
  salesDeptId: string;
  marketingDeptId: string;
  founderId: string;
  salesStaffId: string;
  /** Holds the Sales role but is a member of the other entity only. */
  outsiderId: string;
  service: AccessSettingsService;
}

async function createEnv(): Promise<Env> {
  const tenant = await createTenantWithEntity(appPool);
  const scope: TxScope = { tenantId: tenant.tenantId, organizationId: tenant.organizationId };

  const otherEntityId = randomUUID();
  await withTx(db, scope, systemActor('test-seed'), (tx) =>
    tx.execute(sql`
      INSERT INTO app.organizations (id, tenant_id, organization_id, name, code, legal_name, is_default)
      VALUES (${otherEntityId}, ${scope.tenantId}, ${otherEntityId}, ${`E-${otherEntityId}`},
              ${`E-${otherEntityId}`}, ${`E-${otherEntityId}`}, false)
    `),
  );
  const otherEntity: TxScope = { tenantId: scope.tenantId, organizationId: otherEntityId };

  const { departmentId: salesDeptId } = await createDepartment(appPool, {
    ...scope,
    name: 'Sales',
  });
  const { departmentId: marketingDeptId } = await createDepartment(appPool, {
    ...scope,
    name: 'Marketing',
  });

  const { userId: founderId } = await createStaffUser(appPool, {
    ...scope,
    idpOrgId: tenant.idpOrgId,
    roleKeys: ['founder'],
  });
  const { userId: salesStaffId } = await createStaffUser(appPool, {
    ...scope,
    idpOrgId: tenant.idpOrgId,
    roleKeys: ['sales'],
    departmentId: salesDeptId,
  });
  const { userId: outsiderId } = await createStaffUser(appPool, {
    ...otherEntity,
    idpOrgId: tenant.idpOrgId,
    roleKeys: ['sales'],
  });

  const roleCache = new RoleCache(db, clock);
  const authz = new AuthzService(db, roleCache);
  const audit = new AuditService(db);
  const service = new AccessSettingsService(db, authz, audit);

  return {
    scope,
    otherEntity,
    salesDeptId,
    marketingDeptId,
    founderId,
    salesStaffId,
    outsiderId,
    service,
  };
}

function founderActor(env: Env): Actor {
  return { kind: 'user', id: env.founderId, correlationId: `test-${randomUUID()}` };
}

/** The 422 body `fn` throws; fails the test when it resolves or throws anything else. */
async function refusalOf(fn: () => Promise<unknown>): Promise<Record<string, unknown>> {
  let caught: unknown;
  try {
    await fn();
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(UnprocessableEntityException);
  return (caught as UnprocessableEntityException).getResponse() as Record<string, unknown>;
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

  appPool = new Pool({ connectionString: urlFor('bos_app', APP_PW, 'bos'), max: 8 });
  db = drizzle({ client: appPool });
}, 120_000);

afterAll(async () => {
  await appPool?.end();
  await container?.stop();
});

describe('Check a person for someone who cannot enter the entity (real Postgres)', () => {
  it('reports no access in this entity instead of the company-level role access', async () => {
    const env = await createEnv();

    // The same Sales role inside the entity does reach leads, so the outsider's Nothing below
    // comes from the missing membership, not from the grants.
    const insider = await env.service.checkPerson(env.scope, env.salesStaffId);
    const insiderLeads = insider.areas.find((a) => a.area === 'leads');
    expect(insiderLeads?.scope).not.toBeNull();
    expect(insiderLeads?.actions.length).toBeGreaterThan(0);

    const report = await env.service.checkPerson(env.scope, env.outsiderId);
    expect(report.person.department).toBeNull();
    for (const area of report.areas) {
      expect(area.scope, area.area).toBeNull();
      expect(area.scopeLabel, area.area).toBe('Nothing');
      expect(area.visibleCount, area.area).toBe(0);
      expect(area.actions, area.area).toEqual([]);
      expect(area.why, area.area).toEqual(['No access in this entity.']);
      if (area.assignableCount !== null) expect(area.assignableCount, area.area).toBe(0);
    }

    // In the entity where the person is a member, the role access shows as before.
    const home = await env.service.checkPerson(env.otherEntity, env.outsiderId);
    expect(home.areas.find((a) => a.area === 'leads')?.scope).not.toBeNull();
  });

  it('simulates the same refusal in the dry run report', async () => {
    const env = await createEnv();
    const preview = await env.service.preview(env.scope, {
      changes: [{ kind: 'grant', role: 'sales', permission: 'crm.lead.read', scope: 'all' }],
      person: env.outsiderId,
    });
    const leads = preview.report?.areas.find((a) => a.area === 'leads');
    expect(leads?.scope).toBeNull();
    expect(leads?.why).toEqual(['No access in this entity.']);
    // Nothing before and Nothing after: no "was" label for this person.
    expect(leads?.previousScopeLabel).toBeUndefined();
  });
});

describe('Access dry run refuses what the save refuses (real Postgres)', () => {
  it('refuses a head who is not in the department, with the save body', async () => {
    const env = await createEnv();
    const { revision } = await env.service.getCatalogue(env.scope);
    const changes: AccessChange[] = [
      { kind: 'head', departmentId: env.marketingDeptId, userId: env.salesStaffId },
    ];

    const previewBody = await refusalOf(() => env.service.preview(env.scope, { changes }));
    const saveBody = await refusalOf(() =>
      env.service.save(env.scope, founderActor(env), {
        expectedRevision: revision,
        changes,
        acknowledged: [],
      }),
    );

    expect(previewBody).toEqual(saveBody);
    expect(previewBody.code).toBe('unprocessable');
    expect(previewBody.message).toMatch(/is not a member of Marketing\.$/);
    expect(previewBody.fieldErrors).toEqual({ 'changes.0.userId': previewBody.message });
  });

  it('refuses a head with no membership in the entity, and a batch that hides it among valid changes', async () => {
    const env = await createEnv();
    const outsider = await refusalOf(() =>
      env.service.preview(env.scope, {
        changes: [{ kind: 'head', departmentId: env.salesDeptId, userId: env.outsiderId }],
      }),
    );
    expect(outsider.message).toBe('Person does not belong to this company.');

    const mixed = await refusalOf(() =>
      env.service.preview(env.scope, {
        changes: [
          { kind: 'head', departmentId: env.salesDeptId, userId: env.salesStaffId },
          { kind: 'head', departmentId: env.marketingDeptId, userId: env.salesStaffId },
        ],
      }),
    );
    expect(Object.keys(mixed.fieldErrors as Record<string, string>)).toEqual(['changes.1.userId']);
  });

  it('still previews a valid head change and still returns blocked warnings in the response', async () => {
    const env = await createEnv();
    const valid = await env.service.preview(env.scope, {
      changes: [{ kind: 'head', departmentId: env.salesDeptId, userId: env.salesStaffId }],
    });
    expect(valid.applied.some((a) => a.to === 'Head' || a.label.includes('becomes head'))).toBe(
      true,
    );
    expect(valid.warnings.some((w) => w.severity === 'blocked')).toBe(false);

    // W1 (editing the Founder role) keeps its blocked warning in the dry run response.
    const blocked = await env.service.preview(env.scope, {
      changes: [{ kind: 'grant', role: 'founder', permission: 'crm.lead.read', scope: 'own' }],
    });
    expect(blocked.warnings.some((w) => w.code === 'W1' && w.severity === 'blocked')).toBe(true);
  });
});
