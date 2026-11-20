// Integration test for OutboxDrainer: a real postgres:16-alpine started by Testcontainers (needs Docker).
// Run with: pnpm --filter @bos/api exec vitest run src/platform/notify/outbox.drainer.integration.test.ts
//
// Only a real database can show the promises that matter: two drainers never send the same row, a crashed
// drainer's `sending` rows are recovered, and the retry schedule really lands in next_attempt_at. The
// container starts with just a superuser, so beforeAll creates the roles and default privileges that
// infra/postgres/init-dbs.sh creates in the real stack (same as numbering.service.test.ts), migrates as
// bos_owner and then works as bos_app. Time is a fake clock and the provider is a fake: nothing sleeps.
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

import { createTenantWithEntity, outbox, runMigrations } from '@bos/db';
import { Logger } from '@nestjs/common';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { type Db } from '../db/db.module';
import { type TxScope, systemActor, withTx } from '../db/tx';
import { type EmailProvider } from './email.provider';
import {
  BACKOFF_MIN,
  type DeadLetterNotifier,
  MAX_ATTEMPTS,
  OutboxDrainer,
} from './outbox.drainer';

const OWNER_PW = 'owner-test-pw';
const APP_PW = 'app-test-pw';
const MINUTE = 60_000;
const T0 = new Date('2026-01-01T00:00:00Z');

let container: StartedPostgreSqlContainer;
let appPool: Pool;
let db: Db;
let scope: TxScope;

/** The fake clock: tests move it by assigning. */
let nowMs = T0.getTime();
const clock = () => new Date(nowMs);

function urlFor(user: string, password: string, database: string): string {
  const url = new URL(container.getConnectionUri());
  url.username = user;
  url.password = password;
  url.pathname = `/${database}`;
  return url.toString();
}

type Seed = Partial<{
  template: string;
  status: 'pending' | 'sending' | 'sent' | 'dead';
  attempts: number;
  nextAttemptAt: Date;
  claimedAt: Date;
  toEmail: string;
}>;

/** One outbox row, written the way every app.* write is: through withTx. */
async function seed(s: Seed = {}): Promise<string> {
  const id = randomUUID();
  await withTx(db, scope, systemActor('test'), async (tx) => {
    await tx.insert(outbox).values({
      id,
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      kind: 'email',
      template: s.template ?? 'approval.pending',
      toEmail: s.toEmail ?? `${id}@example.test`,
      subject: 'Subject',
      bodyText: 'Body',
      bodyHtml: '<p>Body</p>',
      dedupeKey: randomUUID(),
      status: s.status ?? 'pending',
      attempts: s.attempts ?? 0,
      nextAttemptAt: s.nextAttemptAt ?? T0,
      claimedAt: s.claimedAt ?? null,
    });
  });
  return id;
}

async function rowOf(id: string) {
  const [row] = await db.select().from(outbox).where(eq(outbox.id, id));
  if (row === undefined) throw new Error(`no outbox row ${id}`);
  return row;
}

/** A provider that records every send; `fail` turns it into one that always throws. */
function fakeProvider(fail?: string) {
  const sentTo: string[] = [];
  const provider: EmailProvider = {
    async send(m) {
      // A short pause so two concurrent drainers genuinely overlap.
      await sleep(2);
      sentTo.push(m.to);
      if (fail !== undefined) throw new Error(fail);
      return { providerMessageId: `<msg-${sentTo.length}@test>` };
    },
  };
  return { provider, sentTo };
}

function fakeNotifier() {
  const notifyRole = vi.fn().mockResolvedValue(undefined);
  const notifier: DeadLetterNotifier = { notifyRole };
  return { notifier, notifyRole };
}

const metrics = () => {
  const recordDeadLetter = vi.fn();
  return { recordDeadLetter };
};

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

  // Ten connections: two drainers each hold one for the claim and use more for the per-row updates.
  appPool = new Pool({ connectionString: urlFor('bos_app', APP_PW, 'bos'), max: 10 });
  db = drizzle({ client: appPool });

  const { tenantId, organizationId } = await createTenantWithEntity(appPool);
  scope = { tenantId, organizationId };
}, 120_000);

afterAll(async () => {
  await appPool?.end();
  await container?.stop();
});

const errorLog = vi.fn();

beforeEach(async () => {
  nowMs = T0.getTime();
  // app.outbox has no audit trigger, so a bare delete is allowed between tests.
  await appPool.query('DELETE FROM app.outbox');
  errorLog.mockClear();
  vi.spyOn(Logger.prototype, 'error').mockImplementation(errorLog);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('OutboxDrainer: sending', () => {
  it('marks a delivered row sent with the provider message id', async () => {
    const id = await seed();
    const { provider, sentTo } = fakeProvider();
    const drainer = new OutboxDrainer(db, provider, clock, metrics());

    const result = await drainer.drainOnce();

    expect(result).toEqual({ claimed: 1, sent: 1, failed: 0, dead: 0 });
    expect(sentTo).toHaveLength(1);
    const row = await rowOf(id);
    expect(row.status).toBe('sent');
    expect(row.attempts).toBe(1);
    expect(row.providerMessageId).toBe('<msg-1@test>');
    expect(row.sentAt).toEqual(T0);
    expect(row.lastError).toBeNull();
  });

  it('leaves a row that is not due yet alone', async () => {
    const id = await seed({ nextAttemptAt: new Date(T0.getTime() + MINUTE) });
    const { provider, sentTo } = fakeProvider();
    const drainer = new OutboxDrainer(db, provider, clock, metrics());

    expect(await drainer.drainOnce()).toMatchObject({ claimed: 0 });
    expect(sentTo).toHaveLength(0);
    expect((await rowOf(id)).status).toBe('pending');
  });
});

describe('OutboxDrainer: retries and dead letters', () => {
  it('waits 1, 5, 10 and 20 minutes between attempts, then the fifth failure kills the row', async () => {
    expect(MAX_ATTEMPTS).toBe(5);
    expect(BACKOFF_MIN.slice(0, 4)).toEqual([1, 5, 10, 20]);

    const id = await seed();
    const { provider, sentTo } = fakeProvider(
      'connect ECONNREFUSED smtp://mailer:s3cret-pw@smtp.test:587',
    );
    const m = metrics();
    const { notifier, notifyRole } = fakeNotifier();
    const drainer = new OutboxDrainer(db, provider, clock, m, notifier);

    for (const [index, waitMin] of [1, 5, 10, 20].entries()) {
      const attempt = index + 1;
      const result = await drainer.drainOnce();
      expect(result).toEqual({ claimed: 1, sent: 0, failed: 1, dead: 0 });

      const row = await rowOf(id);
      expect(row.status).toBe('pending');
      expect(row.attempts).toBe(attempt);
      expect(row.nextAttemptAt).toEqual(new Date(nowMs + waitMin * MINUTE));
      // The stored error is redacted: the SMTP password never reaches the table.
      expect(row.lastError).toContain('ECONNREFUSED');
      expect(row.lastError).not.toContain('s3cret-pw');

      // One second early: not due, nothing is claimed and nothing is sent.
      nowMs = row.nextAttemptAt.getTime() - 1000;
      expect(await drainer.drainOnce()).toMatchObject({ claimed: 0 });
      nowMs = row.nextAttemptAt.getTime();
    }

    const last = await drainer.drainOnce();
    expect(last).toEqual({ claimed: 1, sent: 0, failed: 1, dead: 1 });

    const row = await rowOf(id);
    expect(row.status).toBe('dead');
    expect(row.attempts).toBe(5);
    expect(row.lastError).not.toContain('s3cret-pw');
    expect(sentTo).toHaveLength(5);

    // The metric went up once and the founder was told once, without the error text.
    expect(m.recordDeadLetter).toHaveBeenCalledTimes(1);
    expect(notifyRole).toHaveBeenCalledTimes(1);
    const [, role, n] = notifyRole.mock.calls[0] as [unknown, string, Record<string, unknown>];
    expect(role).toBe('founder');
    expect(n).toMatchObject({
      title: 'Email could not be delivered',
      link: '/settings/email-delivery',
      dedupeKey: `dead-letter:${id}`,
      email: {
        template: 'outbox.dead_letter',
        vars: { failedTemplate: 'approval.pending', attempts: '5' },
      },
    });
    expect(JSON.stringify(n)).not.toContain('ECONNREFUSED');
    expect(JSON.stringify(n)).not.toContain('s3cret-pw');

    // The log names the row and the template only.
    expect(errorLog).toHaveBeenCalledTimes(1);
    expect(errorLog.mock.calls[0]?.[0]).toBe(
      `outbox row ${id} is dead (template approval.pending)`,
    );

    // A dead row is never picked up again.
    nowMs += 24 * 60 * MINUTE;
    expect(await drainer.drainOnce()).toMatchObject({ claimed: 0 });
    expect(sentTo).toHaveLength(5);
  });

  it('only logs when the dead row is itself a dead-letter email (no notification loop)', async () => {
    const id = await seed({ template: 'outbox.dead_letter', attempts: MAX_ATTEMPTS - 1 });
    const { provider } = fakeProvider('smtp down');
    const m = metrics();
    const { notifier, notifyRole } = fakeNotifier();
    const drainer = new OutboxDrainer(db, provider, clock, m, notifier);

    expect(await drainer.drainOnce()).toMatchObject({ failed: 1, dead: 1 });

    expect((await rowOf(id)).status).toBe('dead');
    expect(notifyRole).not.toHaveBeenCalled();
    expect(m.recordDeadLetter).toHaveBeenCalledTimes(1);
    expect(errorLog).toHaveBeenCalledWith(`outbox row ${id} is dead (template outbox.dead_letter)`);
  });

  it('still marks the row dead when the founder notice itself fails', async () => {
    const id = await seed({ attempts: MAX_ATTEMPTS - 1 });
    const { provider } = fakeProvider('smtp down');
    const notifyRole = vi.fn().mockRejectedValue(new Error('no founder in this organization'));
    const drainer = new OutboxDrainer(db, provider, clock, metrics(), { notifyRole });

    expect(await drainer.drainOnce()).toMatchObject({ dead: 1 });

    expect((await rowOf(id)).status).toBe('dead');
  });
});

describe('OutboxDrainer: two drainers', () => {
  it('never send the same row twice (30 rows, each sent exactly once)', async () => {
    const ids = await Promise.all(Array.from({ length: 30 }, () => seed()));
    const a = fakeProvider();
    const b = fakeProvider();
    const drainerA = new OutboxDrainer(db, a.provider, clock, metrics());
    const drainerB = new OutboxDrainer(db, b.provider, clock, metrics());

    /** Keeps draining until a pass finds nothing, like the 5 s schedule would. */
    const drainAll = async (d: OutboxDrainer): Promise<number> => {
      let claimed = 0;
      for (;;) {
        const r = await d.drainOnce();
        if (r.claimed === 0) return claimed;
        claimed += r.claimed;
      }
    };
    const [claimedA, claimedB] = await Promise.all([drainAll(drainerA), drainAll(drainerB)]);

    expect(claimedA + claimedB).toBe(30);
    const recipients = [...a.sentTo, ...b.sentTo];
    expect(recipients).toHaveLength(30);
    expect(new Set(recipients).size).toBe(30);
    for (const id of ids) {
      const row = await rowOf(id);
      expect(row.status).toBe('sent');
      expect(row.attempts).toBe(1);
    }
  });
});

describe('OutboxDrainer: crash recovery', () => {
  it('reclaims stale sending rows and leaves fresh ones alone', async () => {
    const staleId = await seed({
      status: 'sending',
      attempts: 2,
      claimedAt: new Date(T0.getTime() - 11 * MINUTE),
    });
    const freshId = await seed({
      status: 'sending',
      attempts: 1,
      claimedAt: new Date(T0.getTime() - 9 * MINUTE),
    });
    const { provider, sentTo } = fakeProvider();
    const drainer = new OutboxDrainer(db, provider, clock, metrics());

    const result = await drainer.drainOnce();

    // The stale row went back to pending, was due, and was sent in the same pass (attempt 3).
    expect(result).toEqual({ claimed: 1, sent: 1, failed: 0, dead: 0 });
    expect(sentTo).toEqual([`${staleId}@example.test`]);
    const stale = await rowOf(staleId);
    expect(stale.status).toBe('sent');
    expect(stale.attempts).toBe(3);
    // The other drainer may still be sending this one.
    const fresh = await rowOf(freshId);
    expect(fresh.status).toBe('sending');
    expect(fresh.attempts).toBe(1);
  });

  it('kills a stale row that crashed its last attempt and tells the founder', async () => {
    const id = await seed({
      status: 'sending',
      attempts: MAX_ATTEMPTS,
      claimedAt: new Date(T0.getTime() - 11 * MINUTE),
    });
    const { provider, sentTo } = fakeProvider();
    const m = metrics();
    const { notifier, notifyRole } = fakeNotifier();
    const drainer = new OutboxDrainer(db, provider, clock, m, notifier);

    const result = await drainer.drainOnce();

    expect(result).toEqual({ claimed: 0, sent: 0, failed: 0, dead: 1 });
    expect(sentTo).toHaveLength(0);
    expect((await rowOf(id)).status).toBe('dead');
    expect(notifyRole).toHaveBeenCalledTimes(1);
    expect(m.recordDeadLetter).toHaveBeenCalledTimes(1);
  });
});
