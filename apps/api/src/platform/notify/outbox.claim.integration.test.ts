// Integration test for the OutboxDrainer claim guard: a real postgres:16-alpine started by Testcontainers
// (needs Docker). Run with:
//   pnpm --filter @bos/api exec vitest run src/platform/notify/outbox.claim.integration.test.ts
//
// The race it pins down: worker A claims a row and its send hangs, the claim goes stale, worker B reclaims
// the row and sends it, then A's send finally fails. A's late update must find the claim is no longer
// its own and change nothing, so a `sent` row is never moved back to retry. Setup is the same as
// outbox.drainer.integration.test.ts: roles, migrations as bos_owner, work as bos_app, fake clocks.
import { randomUUID } from 'node:crypto';

import { createTenantWithEntity, outbox } from '@bos/db';
import { Logger } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { type Db } from '../db/db.module';
import { type TxScope, systemActor, withTx } from '../db/tx';
import { type EmailProvider } from './email.provider';
import { MAX_ATTEMPTS, OutboxDrainer, STALE_CLAIM_MIN } from './outbox.drainer';
import { createTestDatabase, type TestDatabase } from '@bos/db/testing';

const MINUTE = 60_000;
const T0 = new Date('2026-01-01T00:00:00Z');

let testDb: TestDatabase;
let appPool: Pool;
let db: Db;
let scope: TxScope;

async function seed(s: { attempts?: number } = {}): Promise<string> {
  const id = randomUUID();
  await withTx(db, scope, systemActor('test'), async (tx) => {
    await tx.insert(outbox).values({
      id,
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      kind: 'email',
      template: 'approval.pending',
      toEmail: `${id}@example.test`,
      subject: 'Subject',
      bodyText: 'Body',
      bodyHtml: '<p>Body</p>',
      dedupeKey: randomUUID(),
      status: 'pending',
      attempts: s.attempts ?? 0,
      nextAttemptAt: T0,
    });
  });
  return id;
}

async function rowOf(id: string) {
  const [row] = await db.select().from(outbox).where(eq(outbox.id, id));
  if (row === undefined) throw new Error(`no outbox row ${id}`);
  return row;
}

/** A provider whose send waits until the test settles it, so the test decides when "late" is. */
function hangingProvider() {
  let entered: () => void = () => undefined;
  const sendStarted = new Promise<void>((resolve) => (entered = resolve));
  let settle: (r: { providerMessageId: string } | Error) => void = () => undefined;
  const provider: EmailProvider = {
    send: () =>
      new Promise((resolve, reject) => {
        settle = (r) => (r instanceof Error ? reject(r) : resolve(r));
        entered();
      }),
  };
  return { provider, sendStarted, settle: (r: Error | { providerMessageId: string }) => settle(r) };
}

beforeAll(async () => {
  testDb = await createTestDatabase();

  const admin = new Pool({ connectionString: testDb.adminUrl, max: 1 });
  await admin.end();

  const bosAdmin = new Pool({ connectionString: testDb.adminUrl, max: 1 });
  await bosAdmin.end();

  appPool = new Pool({ connectionString: testDb.appUrl, max: 10 });
  db = drizzle({ client: appPool });

  const { tenantId, organizationId } = await createTenantWithEntity(appPool);
  scope = { tenantId, organizationId };
}, 120_000);

afterAll(async () => {
  await appPool?.end();
  await testDb?.drop();
});

const errorLog = vi.fn();
const warnLog = vi.fn();

beforeEach(async () => {
  await appPool.query('DELETE FROM app.outbox');
  errorLog.mockClear();
  warnLog.mockClear();
  vi.spyOn(Logger.prototype, 'error').mockImplementation(errorLog);
  vi.spyOn(Logger.prototype, 'warn').mockImplementation(warnLog);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('OutboxDrainer: claim guard', () => {
  it('a late failure from a worker whose claim expired does not overwrite the later success', async () => {
    const id = await seed();

    // Worker A claims at T0 and its send hangs.
    const a = hangingProvider();
    const drainerA = new OutboxDrainer(db, a.provider, () => T0, { recordDeadLetter: vi.fn() });
    const passA = drainerA.drainOnce();
    await a.sendStarted;
    expect((await rowOf(id)).attempts).toBe(1);

    // The claim goes stale. Worker B reclaims the row and sends it.
    const tB = new Date(T0.getTime() + (STALE_CLAIM_MIN + 1) * MINUTE);
    const b = hangingProvider();
    const drainerB = new OutboxDrainer(db, b.provider, () => tB, { recordDeadLetter: vi.fn() });
    const passB = drainerB.drainOnce();
    await b.sendStarted;
    b.settle({ providerMessageId: '<from-b@test>' });
    expect(await passB).toEqual({ claimed: 1, sent: 1, failed: 0, dead: 0 });

    // A's send now fails, long after it lost the claim.
    a.settle(new Error('smtp timeout'));
    const resultA = await passA;

    // A does not count a success, and it does not overwrite B's.
    expect(resultA.sent).toBe(0);
    const row = await rowOf(id);
    expect(row.status).toBe('sent');
    expect(row.attempts).toBe(2);
    expect(row.providerMessageId).toBe('<from-b@test>');
    expect(row.sentAt).toEqual(tB);
    expect(row.lastError).toBeNull();
    // The lost claim is visible in the log, without the row's address or the error text.
    expect(warnLog).toHaveBeenCalledTimes(1);
    expect(String(warnLog.mock.calls[0]?.[0])).toContain(id);
    expect(String(warnLog.mock.calls[0]?.[0])).not.toContain('example.test');
  });

  it('a late failure does not release a row that another worker is still sending', async () => {
    const id = await seed();
    const a = hangingProvider();
    const drainerA = new OutboxDrainer(db, a.provider, () => T0, { recordDeadLetter: vi.fn() });
    const passA = drainerA.drainOnce();
    await a.sendStarted;

    const tB = new Date(T0.getTime() + (STALE_CLAIM_MIN + 1) * MINUTE);
    const b = hangingProvider();
    const drainerB = new OutboxDrainer(db, b.provider, () => tB, { recordDeadLetter: vi.fn() });
    const passB = drainerB.drainOnce();
    await b.sendStarted;

    a.settle(new Error('smtp timeout'));
    await passA;

    // B still holds the claim: still `sending`, B's claim time, not back in the queue with a backoff.
    const row = await rowOf(id);
    expect(row.status).toBe('sending');
    expect(row.claimedAt).toEqual(tB);
    expect(row.lastError).toBeNull();

    b.settle({ providerMessageId: '<from-b@test>' });
    await passB;
    expect((await rowOf(id)).status).toBe('sent');
  });

  it('a late failure of a lost claim does not announce a dead letter a second time', async () => {
    // Attempt 5 of 5 is A's. When it goes stale the reclaim kills the row and announces it once.
    const id = await seed({ attempts: MAX_ATTEMPTS - 1 });
    const a = hangingProvider();
    const metricsA = { recordDeadLetter: vi.fn() };
    const notifyA = vi.fn().mockResolvedValue(undefined);
    const drainerA = new OutboxDrainer(db, a.provider, () => T0, metricsA, {
      notifyRole: notifyA,
    });
    const passA = drainerA.drainOnce();
    await a.sendStarted;

    const metricsB = { recordDeadLetter: vi.fn() };
    const notifyB = vi.fn().mockResolvedValue(undefined);
    const tB = new Date(T0.getTime() + (STALE_CLAIM_MIN + 1) * MINUTE);
    const drainerB = new OutboxDrainer(
      db,
      { send: () => Promise.reject(new Error('unused')) },
      () => tB,
      metricsB,
      { notifyRole: notifyB },
    );
    expect(await drainerB.drainOnce()).toMatchObject({ claimed: 0, dead: 1 });

    a.settle(new Error('smtp timeout'));
    await passA;

    expect((await rowOf(id)).status).toBe('dead');
    expect(notifyB).toHaveBeenCalledTimes(1);
    expect(notifyA).not.toHaveBeenCalled();
    expect(metricsB.recordDeadLetter).toHaveBeenCalledTimes(1);
    expect(metricsA.recordDeadLetter).not.toHaveBeenCalled();
  });

  it('the holder of the claim still settles normally', async () => {
    const id = await seed();
    const a = hangingProvider();
    const drainerA = new OutboxDrainer(db, a.provider, () => T0, { recordDeadLetter: vi.fn() });
    const passA = drainerA.drainOnce();
    await a.sendStarted;
    a.settle(new Error('smtp timeout'));

    expect(await passA).toMatchObject({ claimed: 1, sent: 0, failed: 1 });
    const row = await rowOf(id);
    expect(row.status).toBe('pending');
    expect(row.claimedAt).toBeNull();
    expect(row.lastError).toContain('smtp timeout');
  });
});
