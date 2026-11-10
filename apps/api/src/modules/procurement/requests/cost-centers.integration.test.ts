// Integration test of the cost centres lookup on a real Postgres (Testcontainers, needs Docker in WSL): entity-scoped catalogues, populated schema upgrade, and FK integrity. A portal caller is
// answered 403. Real: migrations as bos_owner, queries as bos_app, CostCentersService. Faked: the caller.
// Run: pnpm --filter @bos/api exec vitest run src/modules/procurement/requests/cost-centers.integration.test.ts
import 'reflect-metadata';

import { randomUUID } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  MIGRATIONS_FOLDER,
  checkTenancy,
  createCostCenter,
  createDepartment,
  createStaffUser,
  createTenantWithEntity,
  runMigrations,
} from '@bos/db';
import { ForbiddenException } from '@nestjs/common';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { Principal } from '../../../platform/authz/principal';
import type { Db } from '../../../platform/db/db.module';
import { systemActor, withTx, type TxScope } from '../../../platform/db/tx';
import { CostCentersService } from './cost-centers.service';
import { CostCentersController } from './cost-centers.controller';
import { AuditService } from '../../../platform/audit/audit.service';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 180_000 });

const OWNER_PW = 'owner-test-pw';
const APP_PW = 'app-test-pw';

let container: StartedPostgreSqlContainer;
let appPool: Pool;
let ownerPool: Pool;
const migratedPrIds: string[] = [];
let generalA: string;
let generalB: string;
let db: Db;
let scopeA: TxScope;
let scopeB: TxScope;
const ids = { zeta: '', alpha: '', mid: '', otherEntity: '' };
/** Who calls: the staff user of entity A by default. */
const current: { orgKind: Principal['orgKind']; scope: TxScope } = {
  orgKind: 'staff',
  scope: { tenantId: '', organizationId: '' },
};

let actingUserId = '';
const caller = {
  current: () => ({
    scope: current.scope,
    actor: { kind: 'user' as const, id: actingUserId, correlationId: 'test-corr' },
    principal: {
      userId: actingUserId,
      zitadelUserId: 'z-user-1',
      ...current.scope,
      orgKind: current.orgKind,
      partyId: current.orgKind === 'staff' ? null : randomUUID(),
      idpOrgId: 'unused',
      roles: [],
      departmentId: null,
      status: 'active',
      grants: new Map([['admin.settings.write', 'all']]),
    } satisfies Principal,
  }),
};
let service: CostCentersService;

const urlFor = (user: string, password: string, database: string) => {
  const url = new URL(container.getConnectionUri());
  url.username = user;
  url.password = password;
  url.pathname = `/${database}`;
  return url.toString();
};

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  const admin0 = new Pool({ connectionString: container.getConnectionUri(), max: 1 });
  await admin0.query(`CREATE ROLE bos_owner LOGIN PASSWORD '${OWNER_PW}'`);
  await admin0.query(`CREATE ROLE bos_app LOGIN PASSWORD '${APP_PW}'`);
  await admin0.query('CREATE DATABASE bos OWNER bos_owner');
  await admin0.query('GRANT CONNECT ON DATABASE bos TO bos_app');
  await admin0.end();
  const bosAdmin = new Pool({ connectionString: urlFor('test', 'test', 'bos'), max: 1 });
  await bosAdmin.query(
    'ALTER DEFAULT PRIVILEGES FOR ROLE bos_owner GRANT USAGE ON SCHEMAS TO bos_app',
  );
  await bosAdmin.query(
    'ALTER DEFAULT PRIVILEGES FOR ROLE bos_owner GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO bos_app',
  );
  await bosAdmin.end();
  // Apply the real pre-0037 schema first, then populate it before upgrading.
  const priorFolder = mkdtempSync(join(tmpdir(), 'bos-cost-centers-'));
  const journal = JSON.parse(
    readFileSync(join(MIGRATIONS_FOLDER, 'meta/_journal.json'), 'utf8'),
  ) as { entries: { idx: number; tag: string }[] };
  journal.entries = journal.entries.filter((entry) => entry.idx < 37);
  mkdirSync(join(priorFolder, 'meta'));
  writeFileSync(join(priorFolder, 'meta/_journal.json'), JSON.stringify(journal));
  for (const entry of journal.entries)
    copyFileSync(
      join(MIGRATIONS_FOLDER, `${entry.tag}.sql`),
      join(priorFolder, `${entry.tag}.sql`),
    );
  ownerPool = new Pool({ connectionString: urlFor('bos_owner', OWNER_PW, 'bos'), max: 1 });
  try {
    await migrate(drizzle({ client: ownerPool }), { migrationsFolder: priorFolder });
  } finally {
    rmSync(priorFolder, { recursive: true, force: true });
  }

  appPool = new Pool({ connectionString: urlFor('bos_app', APP_PW, 'bos'), max: 4 });
  db = drizzle({ client: appPool });

  // One tenant, entity A (the acting one) and entity B.
  const tenant = await createTenantWithEntity(appPool);
  scopeA = { tenantId: tenant.tenantId, organizationId: tenant.organizationId };
  const otherEntityId = randomUUID();
  await withTx(db, scopeA, systemActor('test'), (tx) =>
    tx.execute(
      sql`INSERT INTO app.organizations (id, tenant_id, organization_id, name, code, legal_name, is_default)
          VALUES (${otherEntityId}, ${scopeA.tenantId}, ${otherEntityId}, ${`E-${otherEntityId}`},
                  ${`E-${otherEntityId}`}, ${`E-${otherEntityId}`}, false)`,
    ),
  );
  scopeB = { tenantId: scopeA.tenantId, organizationId: otherEntityId };
  current.scope = scopeA;

  const { userId } = await createStaffUser(appPool, { ...scopeA, idpOrgId: tenant.idpOrgId });
  actingUserId = userId;
  for (const scope of [scopeA, scopeB]) {
    const { departmentId } = await createDepartment(appPool, scope);
    const prId = randomUUID();
    migratedPrIds.push(prId);
    await withTx(db, scope, systemActor('test'), (tx) =>
      tx.execute(
        sql`INSERT INTO app.purchase_requests (id, tenant_id, organization_id, request_type, department_id,
        requester_user_id, cost_center_id, justification, required_by, budget_code, currency,
        status, fx_rate, estimated_total_npr)
        VALUES (${prId}, ${scope.tenantId}, ${scope.organizationId}, 'goods', ${departmentId},
          ${userId}, ${randomUUID()}, 'Existing submitted request', '2026-12-31', 'OPS', 'NPR',
          'submitted', 1, 0)`,
      ),
    );
  }
  await runMigrations(urlFor('bos_owner', OWNER_PW, 'bos'));
  const general = await appPool.query<{ id: string; organization_id: string }>(
    "SELECT id, organization_id FROM app.cost_centers WHERE code = 'GENERAL' ORDER BY organization_id",
  );
  generalA = general.rows.find((r) => r.organization_id === scopeA.organizationId)!.id;
  generalB = general.rows.find((r) => r.organization_id === scopeB.organizationId)!.id;

  // Created out of name order on purpose; entity B's department sorts between them.
  ids.zeta = (await createCostCenter(appPool, { ...scopeA, name: 'Zeta', code: 'Z' })).costCenterId;
  ids.alpha = (
    await createCostCenter(appPool, { ...scopeA, name: 'Alpha', code: 'A' })
  ).costCenterId;
  ids.mid = (
    await createCostCenter(appPool, { ...scopeA, name: 'Middle', code: 'M', active: false })
  ).costCenterId;
  ids.otherEntity = (
    await createCostCenter(appPool, { ...scopeB, name: 'Beta', code: 'B' })
  ).costCenterId;

  service = new CostCentersService(db, caller, new AuditService());
});

afterAll(async () => {
  await appPool?.end();
  await ownerPool?.end();
  await container?.stop();
});

describe('CostCentersService.list', () => {
  it('returns active and inactive catalogue entries of the acting entity in name order', async () => {
    current.orgKind = 'staff';
    current.scope = scopeA;
    const rows = await service.list();
    expect(rows).toEqual([
      { id: ids.alpha, name: 'Alpha', code: 'A', active: true },
      { id: generalA, code: 'GENERAL', name: 'General', active: true },
      { id: ids.mid, name: 'Middle', code: 'M', active: false },
      { id: ids.zeta, name: 'Zeta', code: 'Z', active: true },
    ]);
  });

  it("leaves another entity's cost centres out, and shows them to that entity", async () => {
    current.orgKind = 'staff';
    current.scope = scopeA;
    expect((await service.list()).map((r) => r.id)).not.toContain(ids.otherEntity);
    current.scope = scopeB;
    expect(await service.list()).toEqual([
      { id: ids.otherEntity, name: 'Beta', code: 'B', active: true },
      { id: generalB, code: 'GENERAL', name: 'General', active: true },
    ]);
  });

  it.each(['vendor', 'customer'] as const)('answers 403 for a %s portal user', async (orgKind) => {
    current.orgKind = orgKind;
    current.scope = scopeA;
    await expect(service.list()).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('0037 populated upgrade', () => {
  it('backfills every existing request, including submitted rows, into its entity GENERAL centre', async () => {
    const result = await appPool.query<{ id: string; cost_center_id: string; status: string }>(
      'SELECT id, cost_center_id, status FROM app.purchase_requests WHERE id = ANY($1::uuid[])',
      [migratedPrIds],
    );
    expect(result.rows).toHaveLength(2);
    expect(result.rows.find((r) => r.id === migratedPrIds[0])).toMatchObject({
      cost_center_id: generalA,
      status: 'submitted',
    });
    expect(result.rows.find((r) => r.id === migratedPrIds[1])).toMatchObject({
      cost_center_id: generalB,
      status: 'submitted',
    });
    const audit = await ownerPool.query<{ count: string }>(
      "SELECT count(*) FROM audit.audit_events WHERE actor_id = 'migration:0037_cost_centers' AND entity_type = 'purchase_requests'",
    );
    expect(Number(audit.rows[0]?.count)).toBe(2);
    expect(await checkTenancy(ownerPool)).toEqual([]);
  });

  it('refuses a purchase request cost centre belonging to another entity', async () => {
    await expect(
      withTx(db, scopeA, systemActor('test'), (tx) =>
        tx.execute(
          sql`UPDATE app.purchase_requests SET cost_center_id = ${generalB} WHERE id = ${migratedPrIds[0]}`,
        ),
      ),
    ).rejects.toMatchObject({
      cause: { code: '23503', constraint: 'purchase_requests_cost_center_fk' },
    });
  });
});

describe('cost centre management', () => {
  it('creates, replays, renames and deactivates with one audit event per command', async () => {
    current.orgKind = 'staff';
    current.scope = scopeA;
    const managed = new CostCentersService(db, caller, new AuditService());
    const controller = new CostCentersController(managed);
    const key = randomUUID();
    const row = await controller.create(key, { code: 'NEW', name: 'New centre' });
    expect(await controller.create(key, { code: 'NEW', name: 'New centre' })).toEqual(row);
    const updateKey = randomUUID();
    expect(
      await controller.update(row.id, updateKey, { name: 'Renamed', active: false }),
    ).toMatchObject({ name: 'Renamed', active: false });
    await controller.update(row.id, updateKey, { name: 'Renamed', active: false });
    const events = await ownerPool.query<{ action: string }>(
      'SELECT action FROM audit.audit_events WHERE entity_id = $1 AND action LIKE $2',
      [row.id, 'cost_center.%'],
    );
    expect(events.rows.map((r) => r.action).sort()).toEqual([
      'cost_center.created',
      'cost_center.updated',
    ]);
    current.scope = scopeB;
    await expect(controller.update(row.id, randomUUID(), { active: true })).rejects.toMatchObject({
      status: 404,
    });
    current.scope = scopeA;
    await expect(
      controller.create(randomUUID(), { code: 'NEW', name: 'Duplicate' }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(controller.create(randomUUID(), { code: '', name: 'Bad' })).rejects.toMatchObject({
      status: 400,
    });
  });
});
