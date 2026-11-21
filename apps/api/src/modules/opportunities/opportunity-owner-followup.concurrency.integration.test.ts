// Concurrency test: a deal's owner hands it to a peer (OpportunityOwnerChangeService.changeOwner, F1-Q51) while a
// colleague plans a follow-up on the same deal (ActivitiesService.create with a due time and no assignee, so it goes
// to the deal's owner), at the same moment, on a real Postgres (the shared test database of @bos/db/testing).
// Real: migrations, triggers, the leads harness (RoleCache, NotifyService's outbox), AuditService, the assignment
// rule. Faked: the request context. Each actor has its own fixed caller and authz, snapshotted from the harness's
// actAs, so the two sides of a race never see each other's identity.
//
// Locks: changeOwner locks the deal FOR UPDATE, then its first audited write takes the tenant's audit-chain lock.
// create reads the deal FOR SHARE (activities.service.ts refOf, lockOwned) and then writes; with an Idempotency-Key
// (optional: the workspace form sends none) it claims the key first, an audited INSERT, so it takes the audit lock
// before the deal. Both variants race here.
//
// Each round: a fresh deal owned by the sales staff member; then the change of owner and the planned follow-up race,
// each in its own transaction, with a 0-10 ms start offset on either side. One forced round per variant: a third
// connection holds the audit-chain lock; the side named first starts and waits; the other starts and waits; then the
// lock is released.
//
// Desired behaviour (the assertions): no error that is not a clean HTTP answer (no 40P01, no 55P03), both sides
// succeed every round, the deal belongs to the peer, and the new follow-up is the peer's (planned before the change, it
// moves with the deal, D45; planned after, it goes to the new owner).
// RACE_TX_AUDIT=lazy runs every withTx with `audit: 'lazy'` (the lock order before the lock-first default) to show
// what the default prevents.
// Run: pnpm --filter @bos/api exec vitest run src/modules/opportunities/opportunity-owner-followup.concurrency.integration.test.ts
import 'reflect-metadata';

import { randomUUID } from 'node:crypto';

import { type Permission } from '@bos/contracts';
import { activities, opportunities } from '@bos/db';
import { ForbiddenException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  forcedRound,
  outcomeOf,
  pgErrorOf,
  race,
  tally,
  type ConnectPool,
  type PgFields,
} from '../../../test/support/race';
import { AuditService } from '../../platform/audit/audit.service';
import type { AuthzService } from '../../platform/authz/authz.service';
import { can } from '../../platform/authz/can';
import { systemActor, withTx } from '../../platform/db/tx';
import { ActivitiesService } from '../activities/activities.service';
import { startHarness, type Harness } from '../leads/test/harness';
import { OpportunityOwnerChangeService } from './opportunity-owner-change.service';

vi.mock('../../platform/db/tx', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../platform/db/tx')>();
  if (process.env.RACE_TX_AUDIT !== 'lazy') return real;
  const withTx: typeof real.withTx = (db, scope, actor, fn, options) =>
    real.withTx(db, scope, actor, fn, { audit: 'lazy', ...options });
  return { ...real, withTx };
});

vi.setConfig({ testTimeout: 600_000, hookTimeout: 180_000 });

const ROUNDS = 32;
const DUE = '2026-12-01T09:30:00.000Z';

let h: Harness;
let customerId: string;
let salesStaff: string;
let salesPeer: string;
let changer: OpportunityOwnerChangeService;
let planner: ActivitiesService;
let seq = 0;

/** The harness's caller as it is right after actAs(userId), frozen, and an authz that checks that principal. */
async function fixedIdentity(userId: string) {
  await h.actAs(userId);
  const snapshot = h.caller.current();
  const caller: Harness['caller'] = { current: () => snapshot };
  const authz = {
    assert: (action: Permission, ref?: Parameters<typeof can>[2]) => {
      const d = can(snapshot.principal, action, ref);
      if (!d.allowed) {
        throw new ForbiddenException({ code: 'forbidden', message: 'Forbidden', reason: d.reason });
      }
    },
  } as unknown as AuthzService;
  return { caller, authz };
}

beforeAll(async () => {
  h = await startHarness({ Pool, drizzle });
  const salesDept = await h.department('Sales Race');
  const sales = { roles: ['sales'] as const, departmentId: salesDept };
  salesStaff = await h.member({ ...sales, displayName: 'Sam Staff' });
  salesPeer = await h.member({ ...sales, displayName: 'Pia Peer' });
  customerId = await h.seedCustomer(salesStaff);

  const audit = new AuditService(h.db);
  // The owner hands the deal over; the founder (who writes every deal) plans the follow-up.
  const owner = await fixedIdentity(salesStaff);
  changer = new OpportunityOwnerChangeService(
    h.db,
    owner.caller,
    owner.authz,
    audit,
    h.notify,
    h.roleCache,
  );
  const boss = await fixedIdentity(h.users.boss);
  planner = new ActivitiesService(h.db, boss.authz, audit, boss.caller, h.roleCache, h.notify);
});

afterAll(async () => {
  await h?.stop();
});

// ---------------------------------------------------------------------------------------- helpers

/** A deal of entity A owned by the sales staff member, version 1. */
async function seedDeal(): Promise<string> {
  seq += 1;
  const id = randomUUID();
  await withTx(h.db, h.scopeA, systemActor('test'), (tx) =>
    tx.insert(opportunities).values({
      id,
      tenantId: h.tenantId,
      organizationId: h.scopeA.organizationId,
      number: `DEAL-RACE-${String(seq).padStart(4, '0')}`,
      name: `Race deal ${seq}`,
      customerId,
      ownerUserId: salesStaff,
      stage: 'negotiation',
      value: '125000.00',
      currency: 'NPR',
    }),
  );
  return id;
}

const handOver = (dealId: string) =>
  changer.changeOwner(dealId, { ownerUserId: salesPeer, expectedVersion: 1 });
const planFollowUp = (dealId: string, keyed: boolean) => {
  const body = {
    kind: 'call' as const,
    subject: 'Call about the contract',
    dueAt: DUE,
    opportunityId: dealId,
  };
  return keyed ? planner.create(body, `plan-${randomUUID()}`) : planner.create(body);
};

const dealRow = async (id: string) =>
  (await h.db.select().from(opportunities).where(eq(opportunities.id, id)))[0]!;
const followUpsOf = (dealId: string) =>
  h.db
    .select({ assigneeUserId: activities.assigneeUserId })
    .from(activities)
    .where(eq(activities.opportunityId, dealId));

type Variant = 'no-key' | 'keyed';
type Round = {
  variant: Variant;
  round: number;
  offset: string;
  change: string;
  create: string;
  owner: string;
  followUps: string;
};

let firstDeadlock: PgFields | null = null;
const noteDeadlock = (side: string, r: PromiseSettledResult<unknown>) => {
  if (r.status === 'rejected' && firstDeadlock === null && pgErrorOf(r.reason).code === '40P01') {
    firstDeadlock = { ...pgErrorOf(r.reason), message: `${side}: ${pgErrorOf(r.reason).message}` };
  }
};

const who = (userId: string | null) =>
  userId === salesPeer ? 'peer' : userId === salesStaff ? 'staff' : String(userId);

async function finish(
  dealId: string,
  variant: Variant,
  round: number,
  offset: string,
  change: PromiseSettledResult<unknown>,
  create: PromiseSettledResult<unknown>,
): Promise<Round> {
  noteDeadlock(`change (${variant})`, change);
  noteDeadlock(`create (${variant})`, create);
  return {
    variant,
    round,
    offset,
    change: outcomeOf(change),
    create: outcomeOf(create),
    owner: who((await dealRow(dealId)).ownerUserId),
    followUps: (await followUpsOf(dealId)).map((a) => who(a.assigneeUserId)).join(',') || 'none',
  };
}

// ------------------------------------------------------------------------------------------------ test

describe('opportunity owner change racing a follow-up planned on the same deal', () => {
  it('control: each side alone, in either order, succeeds and the follow-up ends with the new owner', async () => {
    for (const keyed of [false, true]) {
      const before = await seedDeal();
      await planFollowUp(before, keyed);
      await handOver(before);
      expect(await followUpsOf(before)).toEqual([{ assigneeUserId: salesPeer }]);
      const after = await seedDeal();
      await handOver(after);
      await planFollowUp(after, keyed);
      expect(await followUpsOf(after)).toEqual([{ assigneeUserId: salesPeer }]);
    }
  });

  it("never deadlocks: both succeed and the follow-up is the new owner's", async () => {
    const lockPool = h.ownerPool as unknown as ConnectPool;
    const rounds: Round[] = [];
    const forcedOrder: { round: string; firstWaited: boolean; bothWaited: boolean }[] = [];

    for (const variant of ['no-key', 'keyed'] as const) {
      const keyed = variant === 'keyed';
      // Forced. Keyed: create claims its key under the held audit lock, the change locks the deal and waits at its
      // first audited write, then the lock goes to create, which next wants the deal FOR SHARE. No key: the change
      // locks the deal and waits at its first audited write, create waits for the deal.
      {
        const dealId = await seedDeal();
        const forced = keyed
          ? await forcedRound(
              lockPool,
              h.ownerPool,
              h.tenantId,
              () => planFollowUp(dealId, true),
              () => handOver(dealId),
            )
          : await forcedRound(
              lockPool,
              h.ownerPool,
              h.tenantId,
              () => handOver(dealId),
              () => planFollowUp(dealId, false),
            );
        console.log(
          `[S2 step4 pair3] forced ${variant}: firstWaited=${forced.firstWaited} bothWaited=${forced.bothWaited} waiters=${JSON.stringify(forced.waiters)}`,
        );
        forcedOrder.push({
          round: variant,
          firstWaited: forced.firstWaited,
          bothWaited: forced.bothWaited,
        });
        const [change, create] = keyed
          ? [forced.second, forced.first]
          : [forced.first, forced.second];
        rounds.push(await finish(dealId, variant, 0, 'forced', change, create));
      }

      for (let i = 1; i <= ROUNDS; i++) {
        const dealId = await seedDeal();
        const r = await race(
          i,
          () => handOver(dealId),
          () => planFollowUp(dealId, keyed),
        );
        rounds.push(
          await finish(dealId, variant, i, `change+${r.offsets.a} create+${r.offsets.b}`, r.a, r.b),
        );
      }
    }

    // Printed before any assertion, so a failure keeps the counts.
    for (const variant of ['no-key', 'keyed'] as const) {
      const of = rounds.filter((r) => r.variant === variant);
      console.log(
        `[S2 step4 pair3] ${variant}: rounds=${of.length} counts=${JSON.stringify(tally(of, ['change', 'create']), null, 1)}`,
      );
    }
    console.log(`[S2 step4 pair3] per round:\n${rounds.map((r) => JSON.stringify(r)).join('\n')}`);
    console.log(`[S2 step4 pair3] first 40P01: ${JSON.stringify(firstDeadlock, null, 1)}`);

    // The forced rounds ran in the order they claim only if both sides were seen waiting (forcedRound).
    expect(forcedOrder.filter((r) => !r.firstWaited || !r.bothWaited)).toEqual([]);
    expect(rounds.filter((r) => r.change !== 'ok' || r.create !== 'ok')).toEqual([]);
    expect(rounds.filter((r) => r.owner !== 'peer' || r.followUps !== 'peer')).toEqual([]);
  });
});
