// Integration tests of the opportunity stage history (0162) on a real Postgres. Real: migrations as bos_owner,
// queries as bos_app, OpportunitiesService with the real AuditService and LeadLostReasonsService, and the
// transaction actor set by withTx. Faked: the request context and authz.assert (the real pure can() decides).
// Every stage write goes through applyStageChange, which records one history row in the same transaction.
// Run: pnpm --filter @bos/api exec vitest run src/modules/opportunities/opportunity-stage-history.integration.test.ts
import 'reflect-metadata';

import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  type AccessLevel,
  DEFAULT_ROLE_PERMISSIONS,
  type OpportunityStage,
  type Permission,
  type RoleKey,
  type Scope,
} from '@bos/contracts';
import {
  createParty,
  createStaffUser,
  createTenantWithEntity,
  opportunities,
  opportunityStageHistory,
} from '@bos/db';
import { createTestDatabase, type TestDatabase } from '@bos/db/testing';
import { ForbiddenException } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { AuditService } from '../../platform/audit/audit.service';
import type { AuthzService } from '../../platform/authz/authz.service';
import { can } from '../../platform/authz/can';
import type { Principal } from '../../platform/authz/principal';
import type { Db } from '../../platform/db/db.module';
import { type Actor, systemActor, withTx, type DbTransaction } from '../../platform/db/tx';
import { LeadLostReasonsService } from '../leads/lost-reasons.service';
import { OpportunitiesService } from './opportunities.service';
import { stageHistoryOf } from './opportunity-stage';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 180_000 });

const ADDRESS = JSON.stringify({ line1: '1 Durbar Marg', city: 'Kathmandu', country: 'NP' });

type TenantScope = { tenantId: string; organizationId: string };

let testDb: TestDatabase;
let appPool: Pool;
let db: Db;
let service: OpportunitiesService;
/** Tenant 1, entity A: where most tests act. Entity B is another legal entity of tenant 1. */
let scopeA: TenantScope;
let scopeB: TenantScope;
/** Another tenant altogether. */
let scopeT2: TenantScope;
let acting: TenantScope;
const idp: Record<'t1' | 't2', string> = { t1: '', t2: '' };
let actingIdp = '';
const customers: Record<'A' | 'B' | 'T2', string> = { A: '', B: '', T2: '' };
const U: Record<'salesA' | 'boss' | 'salesT2', string> = { salesA: '', boss: '', salesT2: '' };

const grantsOf = (role: RoleKey) =>
  new Map(Object.entries(DEFAULT_ROLE_PERMISSIONS[role])) as Map<Permission, Scope>;
const current: {
  userId: string;
  roles: RoleKey[];
  level: AccessLevel;
  grants: Map<Permission, Scope>;
} = { userId: '', roles: ['sales'], level: 'staff', grants: grantsOf('sales') };
const as = (userId: string, role: RoleKey, level: AccessLevel = 'staff') => {
  current.userId = userId;
  current.roles = [role];
  current.level = level;
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

const newService = () => {
  const audit = new AuditService(db);
  return new OpportunitiesService(
    db,
    authz as unknown as AuthzService,
    audit,
    caller,
    new LeadLostReasonsService(db, audit, caller),
  );
};

const lostReasonIdOf = async (label: string): Promise<string> => {
  const audit = new AuditService(db);
  const found = (await new LeadLostReasonsService(db, audit, caller).choices()).find(
    (o) => o.label === label,
  );
  expect(found, `option ${label}`).toBeDefined();
  return found!.id;
};

const userActor = (userId: string): Actor => ({ kind: 'user', id: userId, correlationId: 'corr' });

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

  U.salesA = (await createStaffUser(appPool, { ...scopeA, idpOrgId: idp.t1 })).userId;
  U.boss = (await createStaffUser(appPool, { ...scopeA, idpOrgId: idp.t1 })).userId;
  U.salesT2 = (await createStaffUser(appPool, { ...scopeT2, idpOrgId: idp.t2 })).userId;
  customers.A = await seedCustomer(scopeA);
  customers.B = await seedCustomer(scopeB);
  customers.T2 = await seedCustomer(scopeT2);
  service = newService();
});

afterAll(async () => {
  await appPool?.end();
  await testDb?.drop();
});

beforeEach(() => {
  acting = scopeA;
  actingIdp = idp.t1;
  as(U.salesA, 'sales');
});

// ---------------------------------------------------------------------------------------- helpers

async function seedCustomer(inScope: TenantScope) {
  const { partyId } = await createParty(appPool, { tenantId: inScope.tenantId, kind: 'customer' });
  await withTx(db, inScope, systemActor('test'), (tx) =>
    tx.execute(
      sql`INSERT INTO app.customers (id, tenant_id, number, legal_name, name_norm, address)
          VALUES (${partyId}, ${inScope.tenantId}, ${`CUS-${partyId.slice(0, 8)}`}, 'Acme Pvt. Ltd.',
                  'acme pvt. ltd.', ${ADDRESS}::jsonb)`,
    ),
  );
  return partyId;
}

/** An opportunity seeded with the schema (leads convert into them; there is no create route). */
async function seed(
  options: { stage?: OpportunityStage; where?: 'A' | 'B' | 'T2'; owner?: string } = {},
) {
  const where = options.where ?? 'A';
  const inScope = where === 'B' ? scopeB : where === 'T2' ? scopeT2 : scopeA;
  const stage = options.stage ?? 'qualified';
  const [row] = await withTx(db, inScope, systemActor('test'), (tx) =>
    tx
      .insert(opportunities)
      .values({
        ...inScope,
        number: `DEAL-${randomUUID().slice(0, 8)}`,
        name: 'Acme website',
        customerId: customers[where],
        ownerUserId: options.owner ?? (where === 'T2' ? U.salesT2 : U.salesA),
        stage,
        ...(stage === 'lost' || stage === 'on_hold'
          ? { stageReason: 'seeded', stageNote: 'seeded note' }
          : {}),
      })
      .returning({ id: opportunities.id }),
  );
  return row!.id;
}

/** A Draft quotation version on the opportunity (won_quotation_version_id must point at a real one). */
async function seedVersion(opportunityId: string): Promise<string> {
  return withTx(db, scopeA, systemActor('test'), async (tx) => {
    const quotation = await tx.execute<{ id: string }>(
      sql`INSERT INTO app.quotations (tenant_id, organization_id, number, customer_party_id, opportunity_id)
          VALUES (${scopeA.tenantId}, ${scopeA.organizationId}, ${`QT-${randomUUID().slice(0, 8)}`},
                  ${customers.A}, ${opportunityId})
          RETURNING id`,
    );
    const version = await tx.execute<{ id: string }>(
      sql`INSERT INTO app.quotation_versions
            (tenant_id, organization_id, quotation_id, revision_no, currency, issue_date, valid_until)
          VALUES (${scopeA.tenantId}, ${scopeA.organizationId}, ${quotation.rows[0]!.id}, 1, 'NPR',
                  '2026-11-09', '2026-12-09')
          RETURNING id`,
    );
    return version.rows[0]!.id;
  });
}

/** The history of one opportunity as entity A of tenant 1 reads it. */
const historyOf = async (id: string, inScope: TenantScope = scopeA) =>
  (await stageHistoryOf(db, inScope, id)).map((r) => ({
    from: r.fromStage,
    to: r.toStage,
    actorKind: r.actorKind,
    actorUserId: r.actorUserId,
  }));

const rowOf = async (id: string) => {
  const [row] = await db.select().from(opportunities).where(eq(opportunities.id, id));
  return row!;
};

/** A transaction like a quotation service opens it for a user's send or acceptance. */
const asUserTx = <T>(userId: string, fn: (tx: DbTransaction) => Promise<T>) =>
  withTx(db, scopeA, userActor(userId), fn);

// ------------------------------------------------------------------------------------------- tests

describe('user moves (changeStage)', () => {
  it('records from, to, the acting user and the time of each move, oldest first', async () => {
    const id = await seed();
    const before = Date.now();
    await service.changeStage(id, { stage: 'requirement_received', expectedVersion: 1 });
    await service.changeStage(id, { stage: 'proposal_sent', expectedVersion: 2 });
    const rows = await stageHistoryOf(db, scopeA, id);
    expect(await historyOf(id)).toEqual([
      { from: 'qualified', to: 'requirement_received', actorKind: 'user', actorUserId: U.salesA },
      {
        from: 'requirement_received',
        to: 'proposal_sent',
        actorKind: 'user',
        actorUserId: U.salesA,
      },
    ]);
    for (const r of rows) {
      expect(r.tenantId).toBe(scopeA.tenantId);
      expect(r.organizationId).toBe(scopeA.organizationId);
      expect(r.createdAt.getTime()).toBeGreaterThanOrEqual(before - 5_000);
    }
    expect(rows[0]!.seq).toBeLessThan(rows[1]!.seq);
  });

  it('records hold, resume, lost and a manager reopen, each by its actor', async () => {
    const id = await seed({ stage: 'negotiation' });
    await service.changeStage(id, {
      stage: 'on_hold',
      reason: 'budget',
      note: 'revisit in Q3',
      expectedVersion: 1,
    });
    await service.changeStage(id, { stage: 'negotiation', expectedVersion: 2 });
    await service.changeStage(id, {
      stage: 'lost',
      lostReasonId: await lostReasonIdOf('Price'),
      note: 'went with a cheaper vendor',
      expectedVersion: 3,
    });
    as(U.boss, 'founder');
    await service.changeStage(id, { stage: 'qualified', expectedVersion: 4 });
    expect(await historyOf(id)).toEqual([
      { from: 'negotiation', to: 'on_hold', actorKind: 'user', actorUserId: U.salesA },
      { from: 'on_hold', to: 'negotiation', actorKind: 'user', actorUserId: U.salesA },
      { from: 'negotiation', to: 'lost', actorKind: 'user', actorUserId: U.salesA },
      { from: 'lost', to: 'qualified', actorKind: 'user', actorUserId: U.boss },
    ]);
  });

  it('records the older hold (no held-from stage) resuming to negotiation', async () => {
    const legacy = await seed({ stage: 'on_hold' });
    expect((await rowOf(legacy)).heldFromStage).toBeNull();
    await service.changeStage(legacy, { stage: 'negotiation', expectedVersion: 1 });
    expect(await historyOf(legacy)).toEqual([
      { from: 'on_hold', to: 'negotiation', actorKind: 'user', actorUserId: U.salesA },
    ]);
  });

  it('writes no row for a refused, stale or out-of-scope move', async () => {
    const id = await seed();
    await expect(
      service.changeStage(id, { stage: 'negotiation', expectedVersion: 1 }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      service.changeStage(id, { stage: 'won', expectedVersion: 1 } as never),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      service.changeStage(id, { stage: 'requirement_received', expectedVersion: 7 }),
    ).rejects.toMatchObject({ status: 409 });
    const inB = await seed({ where: 'B' });
    await expect(
      service.changeStage(inB, { stage: 'requirement_received', expectedVersion: 1 }),
    ).rejects.toMatchObject({ status: 404 });
    expect(await historyOf(id)).toEqual([]);
    expect(await historyOf(inB, scopeB)).toEqual([]);
  });

  it('rolls the history row back with a loss whose lost handler fails', async () => {
    const failing = newService();
    failing.registerLostHandler({
      name: 'quotations.cancel',
      onLost: () => Promise.reject(new Error('cannot cancel the open quotation')),
    });
    const id = await seed({ stage: 'negotiation' });
    await expect(
      failing.changeStage(id, {
        stage: 'lost',
        lostReasonId: await lostReasonIdOf('Price'),
        note: 'n',
        expectedVersion: 1,
      }),
    ).rejects.toThrow('cannot cancel the open quotation');
    expect(await rowOf(id)).toMatchObject({ stage: 'negotiation', version: 1 });
    expect(await historyOf(id)).toEqual([]);
  });
});

describe('system moves (markQuotationSent, markWon)', () => {
  it('records the user who sent or accepted the quotation as the actor', async () => {
    const id = await seed();
    await asUserTx(U.salesA, (tx) => service.markQuotationSent(tx, id));
    const versionId = await seedVersion(id);
    await asUserTx(U.boss, (tx) => service.markWon(tx, id, versionId));
    expect(await historyOf(id)).toEqual([
      { from: 'qualified', to: 'quotation_sent', actorKind: 'user', actorUserId: U.salesA },
      { from: 'quotation_sent', to: 'won', actorKind: 'user', actorUserId: U.boss },
    ]);
  });

  it('records a job with no user as actor kind system and no user', async () => {
    const id = await seed();
    await withTx(db, scopeA, systemActor('quotations'), (tx) => service.markQuotationSent(tx, id));
    expect(await historyOf(id)).toEqual([
      { from: 'qualified', to: 'quotation_sent', actorKind: 'system', actorUserId: null },
    ]);
  });

  it('writes no row for a no-op: already sent, in negotiation, or won again with the same version', async () => {
    const sent = await seed({ stage: 'quotation_sent' });
    await asUserTx(U.salesA, (tx) => service.markQuotationSent(tx, sent));
    const negotiating = await seed({ stage: 'negotiation' });
    await asUserTx(U.salesA, (tx) => service.markQuotationSent(tx, negotiating));
    expect(await historyOf(sent)).toEqual([]);
    expect(await historyOf(negotiating)).toEqual([]);

    const versionId = await seedVersion(sent);
    await asUserTx(U.salesA, (tx) => service.markWon(tx, sent, versionId));
    await asUserTx(U.salesA, (tx) => service.markWon(tx, sent, versionId));
    expect(await historyOf(sent)).toHaveLength(1);
  });

  it('orders two moves of one transaction by seq, and rolls both back with it', async () => {
    const id = await seed();
    const versionId = await seedVersion(id);
    await asUserTx(U.salesA, async (tx) => {
      await service.markQuotationSent(tx, id);
      await service.markWon(tx, id, versionId);
    });
    const rows = await stageHistoryOf(db, scopeA, id);
    expect(rows.map((r) => r.toStage)).toEqual(['quotation_sent', 'won']);
    // Same transaction, same time: seq alone keeps the order.
    expect(rows[0]!.createdAt.getTime()).toBe(rows[1]!.createdAt.getTime());

    const other = await seed();
    const otherVersion = await seedVersion(other);
    await expect(
      asUserTx(U.salesA, async (tx) => {
        await service.markQuotationSent(tx, other);
        await service.markWon(tx, other, otherVersion);
        throw new Error('the quotation write failed');
      }),
    ).rejects.toThrow('the quotation write failed');
    expect(await rowOf(other)).toMatchObject({ stage: 'qualified', version: 1 });
    expect(await historyOf(other)).toEqual([]);
  });
});

describe('the history table', () => {
  it('is append-only for bos_app: UPDATE and DELETE are refused', async () => {
    const id = await seed();
    await service.changeStage(id, { stage: 'requirement_received', expectedVersion: 1 });
    await expect(
      withTx(db, scopeA, systemActor('test'), (tx) =>
        tx
          .update(opportunityStageHistory)
          .set({ toStage: 'proposal_sent' })
          .where(eq(opportunityStageHistory.opportunityId, id)),
      ),
    ).rejects.toThrow();
    await expect(
      withTx(db, scopeA, systemActor('test'), (tx) =>
        tx.delete(opportunityStageHistory).where(eq(opportunityStageHistory.opportunityId, id)),
      ),
    ).rejects.toThrow();
    expect(await historyOf(id)).toHaveLength(1);
  });

  it('is invisible to another entity and another tenant, and refuses a row naming another entity', async () => {
    const own = await seed();
    await service.changeStage(own, { stage: 'requirement_received', expectedVersion: 1 });

    acting = scopeT2;
    actingIdp = idp.t2;
    as(U.salesT2, 'sales');
    const theirs = await seed({ where: 'T2' });
    await service.changeStage(theirs, { stage: 'requirement_received', expectedVersion: 1 });

    expect(await historyOf(own, scopeA)).toHaveLength(1);
    expect(await historyOf(theirs, scopeT2)).toEqual([
      { from: 'qualified', to: 'requirement_received', actorKind: 'user', actorUserId: U.salesT2 },
    ]);
    // The other tenant, and the other entity of the same tenant, read nothing.
    expect(await historyOf(own, scopeT2)).toEqual([]);
    expect(await historyOf(own, scopeB)).toEqual([]);
    expect(await historyOf(theirs, scopeA)).toEqual([]);

    // The composite key ties a row to its opportunity's tenant and entity.
    await expect(
      withTx(db, scopeB, systemActor('test'), (tx) =>
        tx.insert(opportunityStageHistory).values({
          ...scopeB,
          opportunityId: own,
          fromStage: 'qualified',
          toStage: 'requirement_received',
          actorKind: 'system',
          actorUserId: null,
        }),
      ),
    ).rejects.toThrow();
  });
});

describe('one writer of opportunities.stage', () => {
  const apiSrc = fileURLToPath(new URL('../..', import.meta.url));
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return files(path);
      return path.endsWith('.ts') && !path.endsWith('.test.ts') ? [path] : [];
    });
  // A write of the opportunities table: the query builder, updateVersioned or raw SQL.
  const WRITE =
    /\.update\(\s*opportunities\s*\)|updateVersioned\(\s*\w+\s*,\s*opportunities\s*,|update\s+"?app"?\."?opportunities"?\b/gi;
  const STAGE = /\bstage\b|heldFromStage|held_from_stage|plan\.set|\.\.\.set\b/;

  it('finds no stage write outside applyStageChange', () => {
    const writers: string[] = [];
    const offenders: string[] = [];
    for (const path of files(apiSrc)) {
      const text = readFileSync(path, 'utf8');
      for (const match of text.matchAll(WRITE)) {
        const rest = text.slice(match.index);
        // The write's arguments: up to the WHERE (query builder, SQL) or the end of the updateVersioned call.
        const end = rest.search(/\.where\(|\bWHERE\b|\}\s*\)/);
        const args = rest.slice(0, end === -1 ? 400 : end);
        const file = relative(apiSrc, path);
        writers.push(file);
        if (STAGE.test(args) && file !== join('modules', 'opportunities', 'opportunity-stage.ts')) {
          offenders.push(`${file}: ${args.split('\n')[0]}`);
        }
      }
    }
    expect(offenders).toEqual([]);
    // The scan is not vacuous: it sees the writer and the two non-stage writes (owner, credit override).
    expect(writers).toEqual(
      expect.arrayContaining([
        join('modules', 'opportunities', 'opportunity-stage.ts'),
        join('modules', 'opportunities', 'opportunity-owner-change.service.ts'),
        join('modules', 'opportunities', 'credit-hold.service.ts'),
      ]),
    );
    const writer = readFileSync(
      join(apiSrc, 'modules', 'opportunities', 'opportunity-stage.ts'),
      'utf8',
    );
    expect(writer).toMatch(/await recordStageChange\(tx, row, row\.stage, updated\.stage\)/);
  });
});
