// Integration test of the departments lookup on a real Postgres (Testcontainers, needs Docker in WSL): rows come
// back as { id, name } ordered by name, another entity's departments are left out, and a portal caller is
// answered 403. Real: migrations as bos_owner, queries as bos_app, DepartmentsService. Faked: the caller.
// Run: pnpm --filter @bos/api exec vitest run src/modules/procurement/requests/departments.integration.test.ts
import 'reflect-metadata';

import { randomUUID } from 'node:crypto';

import { createDepartment, createTenantWithEntity } from '@bos/db';
import { ForbiddenException } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { Principal } from '../../../platform/authz/principal';
import type { Db } from '../../../platform/db/db.module';
import { systemActor, withTx, type TxScope } from '../../../platform/db/tx';
import { DepartmentsService } from './departments.service';
import { createTestDatabase, type TestDatabase } from '@bos/db/testing';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 180_000 });

let testDb: TestDatabase;
let appPool: Pool;
let db: Db;
let scopeA: TxScope;
let scopeB: TxScope;
const ids = { zeta: '', alpha: '', mid: '', otherEntity: '' };
/** Who calls: the staff user of entity A by default. */
const current: { orgKind: Principal['orgKind']; scope: TxScope } = {
  orgKind: 'staff',
  scope: { tenantId: '', organizationId: '' },
};

const caller = {
  current: () => ({
    scope: current.scope,
    actor: { kind: 'user' as const, id: 'user-1', correlationId: 'test-corr' },
    principal: {
      userId: 'user-1',
      zitadelUserId: 'z-user-1',
      ...current.scope,
      orgKind: current.orgKind,
      partyId: current.orgKind === 'staff' ? null : randomUUID(),
      idpOrgId: 'unused',
      roles: [],
      departmentId: null,
      status: 'active',
      grants: new Map(),
    } satisfies Principal,
  }),
};
let service: DepartmentsService;

beforeAll(async () => {
  testDb = await createTestDatabase();
  const admin0 = new Pool({ connectionString: testDb.adminUrl, max: 1 });
  await admin0.end();
  const bosAdmin = new Pool({ connectionString: testDb.adminUrl, max: 1 });
  await bosAdmin.end();

  appPool = new Pool({ connectionString: testDb.appUrl, max: 4 });
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

  // Created out of name order on purpose; entity B's department sorts between them.
  ids.zeta = (await createDepartment(appPool, { ...scopeA, name: 'Zeta' })).departmentId;
  ids.alpha = (await createDepartment(appPool, { ...scopeA, name: 'Alpha' })).departmentId;
  ids.mid = (await createDepartment(appPool, { ...scopeA, name: 'Middle' })).departmentId;
  ids.otherEntity = (await createDepartment(appPool, { ...scopeB, name: 'Beta' })).departmentId;

  service = new DepartmentsService(db, caller);
});

afterAll(async () => {
  await appPool?.end();
  await testDb?.drop();
});

describe('DepartmentsService.list', () => {
  it('returns { id, name } of the acting entity ordered by name, and nothing else', async () => {
    current.orgKind = 'staff';
    current.scope = scopeA;
    const rows = await service.list();
    expect(rows).toEqual([
      { id: ids.alpha, name: 'Alpha' },
      { id: ids.mid, name: 'Middle' },
      { id: ids.zeta, name: 'Zeta' },
    ]);
  });

  it("leaves another entity's departments out, and shows them to that entity", async () => {
    current.orgKind = 'staff';
    current.scope = scopeA;
    expect((await service.list()).map((r) => r.id)).not.toContain(ids.otherEntity);
    current.scope = scopeB;
    expect(await service.list()).toEqual([{ id: ids.otherEntity, name: 'Beta' }]);
  });

  it.each(['vendor', 'customer'] as const)('answers 403 for a %s portal user', async (orgKind) => {
    current.orgKind = orgKind;
    current.scope = scopeA;
    await expect(service.list()).rejects.toBeInstanceOf(ForbiddenException);
  });
});
