// Integration test for the email delivery log and Resend (F1-Q15): a real postgres:16-alpine started by
// Testcontainers (needs Docker).
// Run with: pnpm --filter @bos/api exec vitest run src/platform/notify/delivery-log.integration.test.ts
//
// The resend goes through the real outbox drainer, the real NotifyService (so the Founder's dead-letter notice
// hits the real unique keys), the real AuditService and the real bounce store. Only the email provider, the
// user directory and the queue are fakes: no test talks to Resend. Setup is the one of
// outbox.drainer.integration.test.ts: the container starts with a superuser only, so beforeAll creates the
// roles that infra/postgres/init-dbs.sh creates, migrates as bos_owner and then works as bos_app.
import { randomUUID } from 'node:crypto';

import type { RoleKey } from '@bos/contracts';
import { createStaffUser, createTenantWithEntity, outbox } from '@bos/db';
import { ConflictException, Logger, NotFoundException } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { AuditService } from '../audit/audit.service';
import type { Principal } from '../authz/principal';
import { UserDirectory } from '../authz/user-directory';
import type { CoreConfig } from '../config/config';
import { type Db } from '../db/db.module';
import { type TxScope, systemActor, withTx } from '../db/tx';
import { bindIdentity, bindPrincipal, runWithRequestStore } from '../tenancy/request-context';
import { SqlBounceStore } from './bounce.store';
import { DeliveryLogService } from './delivery-log.service';
import { type EmailProvider } from './email.provider';
import { MAX_ATTEMPTS, OutboxDrainer } from './outbox.drainer';
import { NotifyService } from './notify.service';
import { createTestDatabase, type TestDatabase } from '@bos/db/testing';

const MINUTE = 60_000;
const BAD = 'broken@example.test';

/** Knows the Founder only: the dead-letter notice goes to every holder of `founder`. */
class FakeDirectory extends UserDirectory {
  readonly emails = new Map<string, string>();
  founders: string[] = [];
  resolve(): never {
    throw new Error('not used');
  }
  userIdsWithRole(_scope: TxScope, role: RoleKey): Promise<string[]> {
    return Promise.resolve(role === 'founder' ? this.founders : []);
  }
  emailOf(userId: string): Promise<string | null> {
    return Promise.resolve(this.emails.get(userId) ?? null);
  }
}

interface Org {
  scope: TxScope;
  idpOrgId: string;
  founderId: string;
}

let testDb: TestDatabase;
let appPool: Pool;
/** Superuser on the bos database: bos_app has no right to read audit.audit_events directly. */
let superPool: Pool;
let db: Db;
let home: Org;
let other: Org;
let notify: NotifyService;
let service: DeliveryLogService;
const directory = new FakeDirectory();
const queueAdd = vi.fn().mockResolvedValue(undefined);

/** The drainer's clock. A resend sets next_attempt_at to the database's now(), so tests start at real time. */
let nowMs = Date.now();
const clock = () => new Date(nowMs);

/** Runs `fn` as the org's Founder inside a request store, the way the tenancy interceptor binds it. */
function asFounder<T>(org: Org, fn: () => Promise<T>): Promise<T> {
  return runWithRequestStore('corr-12345678', () => {
    bindIdentity({
      ...org.scope,
      orgKind: 'staff',
      partyId: null,
      idpOrgId: org.idpOrgId,
      userId: `zitadel-${org.founderId}`,
      roles: ['founder'],
      departmentId: null,
      tokenExp: 1_900_000_000,
    });
    const p: Principal = {
      userId: org.founderId,
      zitadelUserId: `zitadel-${org.founderId}`,
      ...org.scope,
      orgKind: 'staff',
      partyId: null,
      idpOrgId: org.idpOrgId,
      roles: ['founder'],
      departmentId: null,
      status: 'active',
      grants: new Map(),
    };
    bindPrincipal(p);
    return fn();
  });
}

type Seed = Partial<{
  status: 'pending' | 'sending' | 'sent' | 'dead';
  attempts: number;
  lastError: string;
  providerMessageId: string;
  toEmail: string;
  createdAt: Date;
}>;

async function seed(org: Org, s: Seed = {}): Promise<string> {
  const id = randomUUID();
  await withTx(db, org.scope, systemActor('test'), async (tx) => {
    await tx.insert(outbox).values({
      id,
      tenantId: org.scope.tenantId,
      organizationId: org.scope.organizationId,
      kind: 'email',
      template: 'approval.pending',
      toEmail: s.toEmail ?? `${id}@example.test`,
      subject: 'Approval needed',
      bodyText: 'Body',
      bodyHtml: '<p>Body</p>',
      dedupeKey: randomUUID(),
      status: s.status ?? 'pending',
      attempts: s.attempts ?? 0,
      nextAttemptAt: new Date(nowMs - MINUTE),
      lastError: s.lastError ?? null,
      providerMessageId: s.providerMessageId ?? null,
      sentAt: s.status === 'sent' ? new Date(nowMs - MINUTE) : null,
      ...(s.createdAt === undefined ? {} : { createdAt: s.createdAt }),
    });
  });
  return id;
}

async function rowOf(id: string) {
  const [row] = await db.select().from(outbox).where(eq(outbox.id, id));
  if (row === undefined) throw new Error(`no outbox row ${id}`);
  return row;
}

/** Records every send; any address in `failFor` fails, every other one is delivered. */
function fakeProvider(failFor: readonly string[] = []) {
  const sentTo: string[] = [];
  const provider: EmailProvider = {
    send(m) {
      sentTo.push(m.to);
      if (failFor.includes(m.to)) return Promise.reject(new Error('550 mailbox unavailable'));
      return Promise.resolve({ providerMessageId: `<msg-${sentTo.length}@test>` });
    },
  };
  return { provider, sentTo };
}

const drainerWith = (provider: EmailProvider) =>
  new OutboxDrainer(db, provider, clock, { recordDeadLetter: vi.fn() }, notify);

async function resentEvents(id: string): Promise<{ actor_id: string; meta: unknown }[]> {
  const { rows } = await superPool.query<{ actor_id: string; meta: unknown }>(
    `SELECT actor_id, meta FROM audit.audit_events
      WHERE action = 'notify.email.resent' AND entity_id = $1 ORDER BY id`,
    [id],
  );
  return rows;
}

async function deadLetterNotices(id: string): Promise<number> {
  const { rows } = await appPool.query<{ n: string }>(
    `SELECT count(*) AS n FROM app.notifications WHERE dedupe_key LIKE $1`,
    [`dead-letter:${id}%`],
  );
  return Number(rows[0]?.n);
}

/** A tenant and its Founder. The fake directory answers who holds `founder`, so no role row is needed. */
async function makeOrg(label: string): Promise<Org> {
  const tenant = await createTenantWithEntity(appPool);
  const { userId } = await createStaffUser(appPool, { ...tenant });
  directory.emails.set(userId, `founder-${label}@example.test`);
  return {
    scope: { tenantId: tenant.tenantId, organizationId: tenant.organizationId },
    idpOrgId: tenant.idpOrgId,
    founderId: userId,
  };
}

beforeAll(async () => {
  testDb = await createTestDatabase();

  const admin = new Pool({ connectionString: testDb.adminUrl, max: 1 });
  await admin.end();

  superPool = new Pool({ connectionString: testDb.adminUrl, max: 2 });

  appPool = new Pool({ connectionString: testDb.appUrl, max: 10 });
  db = drizzle({ client: appPool });

  home = await makeOrg('home');
  other = await makeOrg('other');

  notify = new NotifyService(
    db,
    { WORKSPACE_PUBLIC_URL: 'https://app.example.com' } as CoreConfig,
    directory,
    { add: queueAdd } as unknown as Queue,
  );
  service = new DeliveryLogService(db, new AuditService(db), notify);
}, 120_000);

afterAll(async () => {
  await appPool?.end();
  await superPool?.end();
  await testDb?.drop();
});

beforeEach(async () => {
  nowMs = Date.now();
  // Neither table has an audit trigger, so a bare delete is allowed between tests.
  await appPool.query('DELETE FROM app.outbox');
  await appPool.query('DELETE FROM app.notifications');
  queueAdd.mockClear();
  // Each test sets the Founder of the org it drains.
  directory.founders = [home.founderId];
  vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
});

describe('DeliveryLogService.resend through the real drainer', () => {
  it('sends a failed email once more, audits who resent it, and wakes the drainer', async () => {
    const id = await seed(home, { status: 'dead', attempts: MAX_ATTEMPTS, lastError: '550 nope' });

    expect(await asFounder(home, () => service.resend(id))).toEqual({ outcome: 'queued' });

    const queued = await rowOf(id);
    expect(queued).toMatchObject({
      status: 'pending',
      attempts: 0,
      resendCount: 1,
      lastError: null,
      claimedAt: null,
      providerMessageId: null,
      sentAt: null,
    });
    expect(queueAdd).toHaveBeenCalledTimes(1);

    const events = await resentEvents(id);
    expect(events).toHaveLength(1);
    expect(events[0]?.actor_id).toBe(home.founderId);
    // The address and the error text stay out of the trail.
    expect(JSON.stringify(events)).not.toContain('example.test');
    expect(JSON.stringify(events)).not.toContain('550');

    nowMs = Date.now() + MINUTE;
    const { provider, sentTo } = fakeProvider();
    expect(await drainerWith(provider).drainOnce()).toMatchObject({ claimed: 1, sent: 1 });
    expect(sentTo).toEqual([queued.toEmail]);
    expect(await rowOf(id)).toMatchObject({ status: 'sent', attempts: 1, resendCount: 1 });

    // Delivered now: a second click (a stale page) is refused and sends nothing.
    await expect(asFounder(home, () => service.resend(id))).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(await drainerWith(provider).drainOnce()).toMatchObject({ claimed: 0 });
    expect(sentTo).toHaveLength(1);
    expect(await resentEvents(id)).toHaveLength(1);
  });

  it('queues one resend when two requests race (double click): one audit event, one send', async () => {
    const id = await seed(home, { status: 'dead', attempts: MAX_ATTEMPTS, lastError: 'x' });

    const outcomes = await Promise.all([
      asFounder(home, () => service.resend(id)),
      asFounder(home, () => service.resend(id)),
    ]);

    expect(outcomes.map((o) => o.outcome).sort()).toEqual(['already_queued', 'queued']);
    expect(await rowOf(id)).toMatchObject({ status: 'pending', resendCount: 1 });
    expect(await resentEvents(id)).toHaveLength(1);
    expect(queueAdd).toHaveBeenCalledTimes(1);

    nowMs = Date.now() + MINUTE;
    const { provider, sentTo } = fakeProvider();
    await drainerWith(provider).drainOnce();
    expect(sentTo).toHaveLength(1);
  });

  it('tells the Founder again when a resent email runs out of retries again', async () => {
    const id = await seed(home, { status: 'pending', attempts: MAX_ATTEMPTS - 1, toEmail: BAD });
    const { provider, sentTo } = fakeProvider([BAD]);
    const drainer = drainerWith(provider);

    // First death: one notice to the Founder.
    expect(await drainer.drainOnce()).toMatchObject({ dead: 1 });
    expect(await deadLetterNotices(id)).toBe(1);

    await asFounder(home, () => service.resend(id));

    // Five more failures, each after its backoff.
    nowMs = Date.now() + MINUTE;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      const result = await drainer.drainOnce();
      expect(result.failed, `attempt ${attempt}`).toBe(1);
      const row = await rowOf(id);
      nowMs = Math.max(nowMs, row.nextAttemptAt.getTime()) + 1000;
    }

    const row = await rowOf(id);
    expect(row).toMatchObject({ status: 'dead', attempts: MAX_ATTEMPTS, resendCount: 1 });
    expect(sentTo.filter((to) => to === BAD)).toHaveLength(1 + MAX_ATTEMPTS);
    // The second death has its own notice; the first one's dedupe key did not swallow it.
    expect(await deadLetterNotices(id)).toBe(2);
  });

  it('resends a bounced email and a late bounce for the old message no longer touches it', async () => {
    const id = await seed(home, {
      status: 'sent',
      attempts: 1,
      lastError: 'bounced (hard)',
      providerMessageId: '<old-message@test>',
    });

    expect(await asFounder(home, () => service.resend(id))).toEqual({ outcome: 'queued' });

    // The webhook matches on the message id alone; the resent row no longer carries the old one.
    expect(
      await new SqlBounceStore(db).markBounced({ messageId: 'old-message@test', kind: 'hard' }),
    ).toBe(0);
    expect(await rowOf(id)).toMatchObject({ status: 'pending', lastError: null });
  });

  it('refuses a delivered email (409) and changes nothing', async () => {
    const id = await seed(home, { status: 'sent', attempts: 1, providerMessageId: '<m@test>' });
    const before = await rowOf(id);

    await expect(asFounder(home, () => service.resend(id))).rejects.toBeInstanceOf(
      ConflictException,
    );

    expect(await rowOf(id)).toEqual(before);
    expect(await resentEvents(id)).toHaveLength(0);
    expect(queueAdd).not.toHaveBeenCalled();
  });

  it('leaves an email that is still waiting alone and says it is already queued', async () => {
    const id = await seed(home, { status: 'pending', attempts: 2, lastError: 'timeout' });
    const before = await rowOf(id);

    expect(await asFounder(home, () => service.resend(id))).toEqual({
      outcome: 'already_queued',
    });

    expect(await rowOf(id)).toEqual(before);
    expect(await resentEvents(id)).toHaveLength(0);
    expect(queueAdd).not.toHaveBeenCalled();
  });

  it("answers 404 for another tenant's email and an unknown id, and changes nothing", async () => {
    const theirs = await seed(other, { status: 'dead', attempts: MAX_ATTEMPTS, lastError: 'x' });
    const before = await rowOf(theirs);

    await expect(asFounder(home, () => service.resend(theirs))).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(asFounder(home, () => service.resend(randomUUID()))).rejects.toBeInstanceOf(
      NotFoundException,
    );

    expect(await rowOf(theirs)).toEqual(before);
    expect(await resentEvents(theirs)).toHaveLength(0);
  });
});

describe('DeliveryLogService.list', () => {
  it('lists failed and bounced emails by default, newest first, with the state shown', async () => {
    const t = (min: number) => new Date(nowMs - min * MINUTE);
    const dead = await seed(home, {
      status: 'dead',
      attempts: 5,
      lastError: '550',
      createdAt: t(5),
    });
    const bounced = await seed(home, {
      status: 'sent',
      attempts: 1,
      lastError: 'bounced (soft)',
      createdAt: t(4),
    });
    const stopped = await seed(home, {
      status: 'dead',
      attempts: 0,
      lastError: 'recipient bounced',
      createdAt: t(3),
    });
    const delivered = await seed(home, { status: 'sent', attempts: 1, createdAt: t(2) });
    const waiting = await seed(home, { status: 'pending', createdAt: t(1) });
    await seed(other, { status: 'dead', attempts: 5, lastError: '550' });

    const failed = await asFounder(home, () => service.list({ filter: 'failed', limit: 50 }));
    expect(failed.items.map((i) => [i.id, i.state, i.canResend])).toEqual([
      [stopped, 'bounced', true],
      [dead, 'failed', true],
    ]);
    expect(failed.nextBefore).toBeNull();

    const all = await asFounder(home, () => service.list({ filter: 'all', limit: 50 }));
    expect(all.items.map((i) => [i.id, i.state, i.canResend])).toEqual([
      [waiting, 'queued', false],
      [delivered, 'delivered', false],
      [stopped, 'bounced', true],
      // A soft bounce may still be delivered by the mail server: shown, but not resendable (no second copy).
      [bounced, 'bounced', false],
      [dead, 'failed', true],
    ]);
  });

  it('pages with nextBefore, and a foreign cursor returns nothing', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      ids.push(
        await seed(home, {
          status: 'dead',
          attempts: 5,
          lastError: 'x',
          createdAt: new Date(nowMs - (3 - i) * MINUTE),
        }),
      );
    }
    const first = await asFounder(home, () => service.list({ filter: 'failed', limit: 2 }));
    expect(first.items.map((i) => i.id)).toEqual([ids[2], ids[1]]);
    expect(first.nextBefore).toBe(ids[1]);

    const second = await asFounder(home, () =>
      service.list({ filter: 'failed', limit: 2, before: first.nextBefore ?? undefined }),
    );
    expect(second.items.map((i) => i.id)).toEqual([ids[0]]);
    expect(second.nextBefore).toBeNull();

    const theirs = await seed(other, { status: 'dead', attempts: 5, lastError: 'x' });
    const foreign = await asFounder(home, () =>
      service.list({ filter: 'all', limit: 50, before: theirs }),
    );
    expect(foreign.items).toEqual([]);
  });
});
