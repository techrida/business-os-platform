// Concurrency test: the owner converts a lead (LeadConvertService.convert, which carries the lead's open follow-ups to
// the new deal: follow-ups.ts carryOpenFollowUps, U16-Q6) while the same follow-up is completed or rescheduled
// (ActivitiesService.complete / reschedule), at the same moment, on a real Postgres (the shared test database of
// @bos/db/testing). There is no opportunity convert: carryOpenFollowUps is called only by the lead convert.
// Real: migrations, triggers, the leads harness (RoleCache, NotifyService's outbox), LeadsService (the lead is created
// and moved to qualified through it), ActivitiesService (the follow-up is planned through it), CustomersService,
// NumberingService, AuditService. Faked: the request context. Each call has a caller and authz fixed to the owner,
// snapshotted from the harness's actAs, so no call reads a shared mutable identity.
//
// Locks: convert claims its Idempotency-Key first (an audited INSERT, so the tenant's audit-chain lock), locks the
// lead, writes the customer, contact and deal, then UPDATEs the follow-up row. complete and reschedule lock the
// follow-up row FOR UPDATE first (activities.service.ts changePlanned) and take the audit lock at their first audited
// write. lead-convert.integration.test.ts pins a serialisation with raw SQL that takes the audit lock before the row;
// the real routes take the row first, which this test races.
//
// Each round: a fresh qualified lead with one planned follow-up; then the convert and the change race, each in its own
// transaction, with a 0-10 ms start offset on either side (the first half of the rounds complete, the second half
// reschedule). One forced round per change: a third connection holds the audit-chain lock, convert starts and waits,
// the change starts and waits (with the 'lazy' order: at its first audited write, holding the row), then the lock is
// released to convert.
//
// Desired behaviour (the assertions): no error that is not a clean HTTP answer (no 40P01, no 55P03); the convert
// succeeds every round; the change succeeds or gets a 409 for the version the carry moved; the rows agree: a follow-up
// completed first stays on the lead as history, one rescheduled first is carried with its new due time, and one the
// carry moved first keeps its old due time and stays open.
// RACE_TX_AUDIT=lazy runs every withTx with `audit: 'lazy'` (the lock order before the lock-first default) to show
// what the default prevents.
// Run: pnpm --filter @bos/api exec vitest run src/modules/leads/convert/lead-convert-followup.concurrency.integration.test.ts
import 'reflect-metadata';

import { randomUUID } from 'node:crypto';

import { ConvertLeadBodySchema, type ConvertLeadBody, type Permission } from '@bos/contracts';
import { activities, leads } from '@bos/db';
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
} from '../../../../test/support/race';
import { AuditService } from '../../../platform/audit/audit.service';
import type { AuthzService } from '../../../platform/authz/authz.service';
import { can } from '../../../platform/authz/can';
import { CurrencyEnabledService } from '../../../platform/settings/currency-enabled';
import { NumberingService } from '../../../platform/settings/numbering.service';
import { SettingsService } from '../../../platform/settings/settings.service';
import { ActivitiesService } from '../../activities/activities.service';
import { CustomersService } from '../../customers/customers.service';
import { LeadsService } from '../leads.service';
import { LeadLostReasonsService } from '../lost-reasons.service';
import { startHarness, type Harness } from '../test/harness';
import { LeadConvertService } from './lead-convert.service';

vi.mock('../../../platform/db/tx', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../platform/db/tx')>();
  if (process.env.RACE_TX_AUDIT !== 'lazy') return real;
  const withTx: typeof real.withTx = (db, scope, actor, fn, options) =>
    real.withTx(db, scope, actor, fn, { audit: 'lazy', ...options });
  return { ...real, withTx };
});

vi.setConfig({ testTimeout: 600_000, hookTimeout: 180_000 });

const ROUNDS = 32;
const DUE = '2026-12-01T09:30:00.000Z';
const NEW_DUE = '2026-12-03T11:00:00.000Z';
const ADDRESS = { line: '1 Durbar Marg', city: 'Kathmandu' };

let h: Harness;
let leadsService: LeadsService;
let converter: LeadConvertService;
let followUps: ActivitiesService;

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
  const salesDept = await h.department('Sales Convert Race');
  const salesStaff = await h.member({
    roles: ['sales'],
    departmentId: salesDept,
    displayName: 'Sam',
  });

  const { caller, authz } = await fixedIdentity(salesStaff);
  const audit = new AuditService(h.db);
  const numbering = new NumberingService();
  leadsService = new LeadsService(
    h.db,
    authz,
    audit,
    numbering,
    caller,
    new CurrencyEnabledService(new SettingsService(h.db)),
    new LeadLostReasonsService(h.db, audit, caller),
    h.roleCache,
    h.notify,
  );
  const customersService = new CustomersService(h.db, numbering, authz, caller, audit);
  converter = new LeadConvertService(
    h.db,
    authz,
    audit,
    numbering,
    customersService,
    caller,
    h.roleCache,
  );
  followUps = new ActivitiesService(h.db, authz, audit, caller, h.roleCache, h.notify);
});

afterAll(async () => {
  await h?.stop();
});

// ---------------------------------------------------------------------------------------- helpers

/** A lead moved to qualified through the real stage route (version 3), with one planned follow-up of its owner. */
async function qualifiedLeadWithFollowUp() {
  const lead = await leadsService.create({
    title: 'Website for Acme',
    source: 'referral',
    companyName: 'Acme Pvt. Ltd.',
    contactName: 'Sita Rai',
    country: 'NP',
    email: 'sita.rai@race.example',
    phones: [],
    currency: 'NPR',
  });
  await leadsService.changeStage(lead.id, {
    stage: 'contacted',
    expectedVersion: 1,
    contactActivity: { kind: 'call', body: 'Intro call' },
  });
  await leadsService.changeStage(lead.id, { stage: 'qualified', expectedVersion: 2 });
  const followUp = await followUps.create({
    kind: 'call',
    subject: 'Call back about the proposal',
    dueAt: DUE,
    leadId: lead.id,
  });
  return { leadId: lead.id, followUpId: followUp.id, followUpVersion: followUp.version };
}
type Fixture = Awaited<ReturnType<typeof qualifiedLeadWithFollowUp>>;

/**
 * A new customer and contact with names no other round uses (duplicates match on exact name and email), parsed as
 * the controller parses it (lead-convert.controller.ts), so the service gets the schema's defaults too.
 */
const convertBody = (): ConvertLeadBody => {
  const tag = randomUUID();
  return ConvertLeadBodySchema.parse({
    customer: {
      mode: 'create',
      customer: { legalName: `Race ${tag} Traders`, country: 'NP', address: ADDRESS },
    },
    contact: {
      mode: 'create',
      contact: { fullName: 'Buyer', email: `buyer.${tag}@race.example`, country: 'NP' },
    },
    opportunityName: 'Acme website',
    expectedVersion: 3,
  });
};

type Change = 'complete' | 'reschedule';
const convertLead = (x: Fixture) => converter.convert(x.leadId, convertBody(), randomUUID());
const changeFollowUp = (x: Fixture, change: Change) =>
  change === 'complete'
    ? followUps.complete(x.followUpId, { expectedVersion: x.followUpVersion })
    : followUps.reschedule(x.followUpId, { expectedVersion: x.followUpVersion, dueAt: NEW_DUE });

type Round = {
  change: Change;
  round: number;
  offset: string;
  convert: string;
  act: string;
  leadStage: string;
  /** Where the follow-up is: 'lead' or 'deal'. */
  on: string;
  completed: boolean;
  due: 'old' | 'new';
};

let firstDeadlock: PgFields | null = null;
const noteDeadlock = (side: string, r: PromiseSettledResult<unknown>) => {
  if (r.status === 'rejected' && firstDeadlock === null && pgErrorOf(r.reason).code === '40P01') {
    firstDeadlock = { ...pgErrorOf(r.reason), message: `${side}: ${pgErrorOf(r.reason).message}` };
  }
};

async function finish(
  x: Fixture,
  change: Change,
  round: number,
  offset: string,
  convert: PromiseSettledResult<unknown>,
  act: PromiseSettledResult<unknown>,
): Promise<Round> {
  noteDeadlock('convert', convert);
  noteDeadlock(change, act);
  const [lead] = await h.db.select().from(leads).where(eq(leads.id, x.leadId));
  const [row] = await h.db.select().from(activities).where(eq(activities.id, x.followUpId));
  return {
    change,
    round,
    offset,
    convert: outcomeOf(convert),
    act: outcomeOf(act),
    leadStage: lead!.stage,
    on:
      row!.leadId === x.leadId && row!.opportunityId === null
        ? 'lead'
        : row!.leadId === null && row!.opportunityId !== null
          ? 'deal'
          : 'both-or-neither',
    completed: row!.completedAt !== null,
    due: row!.dueAt?.toISOString() === NEW_DUE ? 'new' : 'old',
  };
}

/** The rows that agree with the outcomes of a round where the convert succeeded. */
function coherent(r: Round): boolean {
  if (r.leadStage !== 'converted') return false;
  if (r.act === 'ok') {
    return r.change === 'complete'
      ? r.on === 'lead' && r.completed && r.due === 'old'
      : r.on === 'deal' && !r.completed && r.due === 'new';
  }
  return r.on === 'deal' && !r.completed && r.due === 'old';
}

// ------------------------------------------------------------------------------------------------ test

describe("lead convert racing a change to the lead's follow-up", () => {
  it('control: each side alone, in either order, answers as expected', async () => {
    for (const change of ['complete', 'reschedule'] as const) {
      const first = await qualifiedLeadWithFollowUp();
      await changeFollowUp(first, change);
      await convertLead(first);
      const second = await qualifiedLeadWithFollowUp();
      await convertLead(second);
      const late = await Promise.allSettled([changeFollowUp(second, change)]);
      expect(outcomeOf(late[0])).toBe('http-409:-');
    }
  });

  it('never deadlocks: the convert succeeds, the change succeeds or gets 409, and the rows agree', async () => {
    const lockPool = h.ownerPool as unknown as ConnectPool;
    const rounds: Round[] = [];
    const forcedOrder: { round: string; firstWaited: boolean; bothWaited: boolean }[] = [];

    // Forced: convert claims its key under the held audit lock; the change locks the follow-up and waits at its first
    // audited write; then the lock goes to convert, which reaches the follow-up's row last.
    for (const change of ['complete', 'reschedule'] as const) {
      const x = await qualifiedLeadWithFollowUp();
      const forced = await forcedRound(
        lockPool,
        h.ownerPool,
        h.tenantId,
        () => convertLead(x),
        () => changeFollowUp(x, change),
      );
      console.log(
        `[S2 step4 pair4] forced ${change}: firstWaited=${forced.firstWaited} bothWaited=${forced.bothWaited} waiters=${JSON.stringify(forced.waiters)}`,
      );
      forcedOrder.push({
        round: change,
        firstWaited: forced.firstWaited,
        bothWaited: forced.bothWaited,
      });
      rounds.push(await finish(x, change, 0, 'forced', forced.first, forced.second));
    }

    for (let i = 1; i <= ROUNDS; i++) {
      const change: Change = i <= ROUNDS / 2 ? 'complete' : 'reschedule';
      const x = await qualifiedLeadWithFollowUp();
      const r = await race(
        i,
        () => convertLead(x),
        () => changeFollowUp(x, change),
      );
      rounds.push(
        await finish(x, change, i, `convert+${r.offsets.a} ${change}+${r.offsets.b}`, r.a, r.b),
      );
    }

    // Printed before any assertion, so a failure keeps the counts.
    for (const change of ['complete', 'reschedule'] as const) {
      const of = rounds.filter((r) => r.change === change);
      console.log(
        `[S2 step4 pair4] ${change}: rounds=${of.length} counts=${JSON.stringify(tally(of, ['convert', 'act']), null, 1)}`,
      );
    }
    console.log(`[S2 step4 pair4] per round:\n${rounds.map((r) => JSON.stringify(r)).join('\n')}`);
    console.log(`[S2 step4 pair4] first 40P01: ${JSON.stringify(firstDeadlock, null, 1)}`);

    const cleanAct = new Set(['ok', 'http-409:-', 'http-409:conflict']);
    // The forced rounds ran in the order they claim only if both sides were seen waiting (forcedRound).
    expect(forcedOrder.filter((r) => !r.firstWaited || !r.bothWaited)).toEqual([]);
    expect(rounds.filter((r) => r.convert !== 'ok' || !cleanAct.has(r.act))).toEqual([]);
    expect(rounds.filter((r) => !coherent(r))).toEqual([]);
  });
});
