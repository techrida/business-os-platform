// Integration tests of the stage history on the opportunity detail (R4a Q13) on a real Postgres. Real: migrations
// as bos_owner, queries as bos_app, OpportunitiesService with the real AuditService and LeadLostReasonsService, real
// stage moves (changeStage, and markQuotationSent in a system transaction) and the real get(). Faked: the request
// context and authz.assert (the real pure can() decides). Every response is parsed with the contract schema.
// Run: pnpm --filter @bos/api exec vitest run src/modules/opportunities/opportunity-detail-history.integration.test.ts
import 'reflect-metadata';

import { randomUUID } from 'node:crypto';

import {
  type AccessLevel,
  DEFAULT_ROLE_PERMISSIONS,
  OpportunityDtoSchema,
  type OpportunityStage,
  type Permission,
  type RoleKey,
  type Scope,
} from '@bos/contracts';
import { createParty, createStaffUser, createTenantWithEntity, opportunities } from '@bos/db';
import { createTestDatabase, type TestDatabase } from '@bos/db/testing';
import { ForbiddenException } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { AuditService } from '../../platform/audit/audit.service';
import type { AuthzService } from '../../platform/authz/authz.service';
import { can } from '../../platform/authz/can';
import type { Principal } from '../../platform/authz/principal';
import type { Db } from '../../platform/db/db.module';
import { systemActor, withTx } from '../../platform/db/tx';
import { LeadLostReasonsService } from '../leads/lost-reasons.service';
import { OpportunitiesService } from './opportunities.service';
import { ListOpportunitiesQuerySchema } from './opportunities.types';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 180_000 });

type TenantScope = { tenantId: string; organizationId: string };

let testDb: TestDatabase;
let appPool: Pool;
let db: Db;
let service: OpportunitiesService;
/** Tenant 1, entity A: where the tests act. Entity B is another legal entity of tenant 1. */
let scopeA: TenantScope;
let scopeB: TenantScope;
/** Another tenant altogether. */
let scopeT2: TenantScope;
let acting: TenantScope;
const idp: Record<'t1' | 't2', string> = { t1: '', t2: '' };
let actingIdp = '';
const customers: Record<'A' | 'B' | 'T2', string> = { A: '', B: '', T2: '' };
const U: Record<'owner' | 'colleague' | 'salesB' | 'salesT2', string> = {
  owner: '',
  colleague: '',
  salesB: '',
  salesT2: '',
};
const OWNER_NAME = 'Asha Rai';

const grantsOf = (role: RoleKey) =>
  new Map(Object.entries(DEFAULT_ROLE_PERMISSIONS[role])) as Map<Permission, Scope>;
const current: {
  userId: string;
  roles: RoleKey[];
  level: AccessLevel;
  grants: Map<Permission, Scope>;
} = { userId: '', roles: ['sales'], level: 'staff', grants: grantsOf('sales') };
const as = (userId: string, role: RoleKey) => {
  current.userId = userId;
  current.roles = [role];
  current.level = 'staff';
  current.grants = grantsOf(role);
};
const principalNow = (): Principal => ({
  userId: current.userId,
  zitadelUserId: `z-${current.userId}`,
  ...acting,
  orgKind: 'staff',
  partyId: null,
  idpOrgId: actingIdp,
  roles: current.roles,
  departmentId: null,
  level: current.level,
  status: 'active',
  grants: current.grants,
});
const caller = {
  current: () => ({
    scope: acting,
    actor: { kind: 'user' as const, id: current.userId, correlationId: 'test-corr' },
    principal: principalNow(),
  }),
};
const authz = {
  assert: (action: Permission, ref?: Parameters<typeof can>[2]) => {
    const d = can(principalNow(), action, ref);
    if (!d.allowed) {
      throw new ForbiddenException({ code: 'forbidden', message: 'Forbidden', reason: d.reason });
    }
  },
};

beforeAll(async () => {
  testDb = await createTestDatabase();
  appPool = new Pool({ connectionString: testDb.appUrl, max: 6 });
  db = drizzle({ client: appPool });

  const t1 = await createTenantWithEntity(appPool);
  idp.t1 = t1.idpOrgId;
  scopeA = { tenantId: t1.tenantId, organizationId: t1.organizationId };
  const entityB = randomUUID();
  await withTx(db, scopeA, systemActor('test'), (tx) =>
    tx.execute(
      sql`INSERT INTO app.organizations (id, tenant_id, organization_id, name, code, legal_name, is_default)
          VALUES (${entityB}, ${scopeA.tenantId}, ${entityB}, ${`E-${entityB}`}, ${`E-${entityB}`}, ${`E-${entityB}`}, false)`,
    ),
  );
  scopeB = { tenantId: scopeA.tenantId, organizationId: entityB };
  const t2 = await createTenantWithEntity(appPool);
  idp.t2 = t2.idpOrgId;
  scopeT2 = { tenantId: t2.tenantId, organizationId: t2.organizationId };

  U.owner = (await createStaffUser(appPool, { ...scopeA, idpOrgId: idp.t1 })).userId;
  U.colleague = (await createStaffUser(appPool, { ...scopeA, idpOrgId: idp.t1 })).userId;
  U.salesB = (await createStaffUser(appPool, { ...scopeB, idpOrgId: idp.t1 })).userId;
  U.salesT2 = (await createStaffUser(appPool, { ...scopeT2, idpOrgId: idp.t2 })).userId;
  await withTx(db, scopeA, systemActor('test'), (tx) =>
    tx.execute(sql`UPDATE app.users SET display_name = ${OWNER_NAME} WHERE id = ${U.owner}`),
  );
  customers.A = await seedCustomer(scopeA);
  customers.B = await seedCustomer(scopeB);
  customers.T2 = await seedCustomer(scopeT2);
  const audit = new AuditService(db);
  service = new OpportunitiesService(
    db,
    authz as unknown as AuthzService,
    audit,
    caller,
    new LeadLostReasonsService(db, audit, caller),
  );
});

afterAll(async () => {
  await appPool?.end();
  await testDb?.drop();
});

beforeEach(() => {
  acting = scopeA;
  actingIdp = idp.t1;
  as(U.owner, 'sales');
});

async function seedCustomer(inScope: TenantScope) {
  const { partyId } = await createParty(appPool, { tenantId: inScope.tenantId, kind: 'customer' });
  await withTx(db, inScope, systemActor('test'), (tx) =>
    tx.execute(
      sql`INSERT INTO app.customers
              (id, tenant_id, number, legal_name, name_norm, country, address_line, address_city)
          VALUES (${partyId}, ${inScope.tenantId}, ${`CUS-${partyId.slice(0, 8)}`}, 'Acme Pvt. Ltd.',
                  'acme pvt. ltd.', 'NP', '1 Durbar Marg', 'Kathmandu')`,
    ),
  );
  return partyId;
}

/** An opportunity seeded with the schema at `stage` (leads convert into them; there is no create route). */
async function seed(
  where: 'A' | 'B' | 'T2' = 'A',
  owner: string = where === 'B' ? U.salesB : where === 'T2' ? U.salesT2 : U.owner,
  stage: OpportunityStage = 'qualified',
) {
  const inScope = where === 'B' ? scopeB : where === 'T2' ? scopeT2 : scopeA;
  const [row] = await withTx(db, inScope, systemActor('test'), (tx) =>
    tx
      .insert(opportunities)
      .values({
        ...inScope,
        number: `DEAL-${randomUUID().slice(0, 8)}`,
        name: 'Acme website',
        customerId: customers[where],
        ownerUserId: owner,
        stage,
      })
      .returning({ id: opportunities.id }),
  );
  return row!.id;
}

const detail = async (id: string) => OpportunityDtoSchema.parse(await service.get(id));

describe('stage history on the opportunity detail (R4a Q13)', () => {
  it('returns real moves oldest first, named for the user and null for the system', async () => {
    const id = await seed();
    await service.changeStage(id, { stage: 'requirement_received', expectedVersion: 1 });
    await service.changeStage(id, { stage: 'proposal_sent', expectedVersion: 2 });
    // A quotation sent by a job: no user behind the move.
    await withTx(db, scopeA, systemActor('test'), (tx) => service.markQuotationSent(tx, id));

    const dto = await detail(id);
    expect(dto.stageHistory?.map(({ from, to, actorName }) => ({ from, to, actorName }))).toEqual([
      { from: 'qualified', to: 'requirement_received', actorName: OWNER_NAME },
      { from: 'requirement_received', to: 'proposal_sent', actorName: OWNER_NAME },
      { from: 'proposal_sent', to: 'quotation_sent', actorName: null },
    ]);
    const times = dto.stageHistory!.map((h) => Date.parse(h.at));
    expect(times).toEqual([...times].sort((a, b) => a - b));
    // No raw user id leaks into the history.
    expect(JSON.stringify(dto.stageHistory)).not.toContain(U.owner);
  });

  it('sends an empty history for a deal with no recorded move, and none on list rows', async () => {
    const id = await seed();
    expect((await detail(id)).stageHistory).toEqual([]);
    await service.changeStage(id, { stage: 'requirement_received', expectedVersion: 1 });
    const { items } = await service.list(ListOpportunitiesQuerySchema.parse({ limit: '200' }));
    const row = items.find((o) => o.id === id);
    expect(row).toBeDefined();
    expect(row).not.toHaveProperty('stageHistory');
  });

  it('keeps the read gate: a colleague without reach, another entity and another tenant get 404', async () => {
    const mine = await seed();
    await service.changeStage(mine, { stage: 'requirement_received', expectedVersion: 1 });

    // A sales colleague in the same entity reads own deals only.
    as(U.colleague, 'sales');
    await expect(service.get(mine)).rejects.toMatchObject({ status: 404 });

    // Another entity of the same tenant, with a history of its own.
    acting = scopeB;
    as(U.salesB, 'sales');
    const inB = await seed('B');
    await service.changeStage(inB, { stage: 'requirement_received', expectedVersion: 1 });
    expect((await detail(inB)).stageHistory).toHaveLength(1);
    acting = scopeA;
    as(U.owner, 'sales');
    await expect(service.get(inB)).rejects.toMatchObject({ status: 404 });

    // Another tenant.
    acting = scopeT2;
    actingIdp = idp.t2;
    as(U.salesT2, 'sales');
    const inT2 = await seed('T2');
    await service.changeStage(inT2, { stage: 'requirement_received', expectedVersion: 1 });
    acting = scopeA;
    actingIdp = idp.t1;
    as(U.owner, 'sales');
    await expect(service.get(inT2)).rejects.toMatchObject({ status: 404 });
    // The owner's own detail still carries only its own move.
    expect((await detail(mine)).stageHistory).toHaveLength(1);
  });
});
