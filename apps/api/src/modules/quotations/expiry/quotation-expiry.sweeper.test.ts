import type { DbTransaction } from '../../../platform/db/db.module';
import type { Actor, TxScope } from '../../../platform/db/tx';
import { describe, expect, it, vi } from 'vitest';

import {
  EXPIRY_BATCH,
  EXPIRY_EVERY_MS,
  kathmanduToday,
  QUOTATION_EXPIRY_JOB_PREFIX,
  QuotationExpiryProcessor,
  QuotationExpiryScheduler,
  QuotationExpirySweeper,
  type ExpiredVersion,
  type ExpiryCandidate,
  type ExpiryStore,
  type RunInTx,
} from './quotation-expiry.sweeper';

const TX = { marker: 'tx' } as unknown as DbTransaction;
/** 2026-11-09 12:00 in Kathmandu is 06:15 UTC. */
const NOW = new Date('2026-11-09T06:15:00.000Z');

const candidate = (n: number): ExpiryCandidate => ({
  tenantId: 'tenant-1',
  organizationId: 'org-1',
  versionId: `00000000-0000-4000-8000-00000000000${n}`,
});

const expired = (over: Partial<ExpiredVersion> = {}): ExpiredVersion => ({
  quotationId: 'quotation-1',
  quotationNumber: 'QT-2083-0001',
  ownerUserId: 'owner-1',
  validUntil: '2026-11-08',
  fromStatus: 'sent',
  ...over,
});

function setup(
  opts: {
    candidates?: ExpiryCandidate[];
    /** What `expire` returns per version id; a missing key means it expired with defaults, `undefined` means skipped. */
    results?: Record<string, ExpiredVersion | undefined | Error>;
    clock?: Date;
  } = {},
) {
  const calls: string[] = [];
  const results = opts.results ?? {};
  const store: ExpiryStore = {
    candidates: vi.fn((today: string, limit: number) => {
      calls.push(`candidates(${today},${limit})`);
      return Promise.resolve(opts.candidates ?? []);
    }),
    expire: vi.fn((_tx: DbTransaction, c: ExpiryCandidate, today: string) => {
      calls.push(`expire:${c.versionId}:${today}`);
      const result = c.versionId in results ? results[c.versionId] : expired();
      if (result instanceof Error) return Promise.reject(result);
      return Promise.resolve(result);
    }),
  };
  const txs: { scope: TxScope; actor: Actor }[] = [];
  const runTx: RunInTx = (scope, actor, fn) => {
    txs.push({ scope, actor });
    return fn(TX);
  };
  const audit = {
    record: vi.fn((_tx: DbTransaction, e: { entityId: string }) => {
      calls.push(`audit:${e.entityId}`);
      return Promise.resolve();
    }),
  };
  const notify = {
    notifyUser: vi.fn((_tx: DbTransaction, n: { dedupeKey: string }) => {
      calls.push(`notify:${n.dedupeKey}`);
      return Promise.resolve();
    }),
  };
  const sweeper = new QuotationExpirySweeper(store, runTx, audit, notify, () => opts.clock ?? NOW);
  return { sweeper, store, audit, notify, calls, txs };
}

describe('kathmanduToday', () => {
  it('is the calendar date in Asia/Kathmandu (UTC+5:45), not in UTC', () => {
    // 18:14 UTC is 23:59 in Kathmandu: still the 9th. 18:15 UTC is midnight there: the 10th.
    expect(kathmanduToday(new Date('2026-11-09T18:14:59.000Z'))).toBe('2026-11-09');
    expect(kathmanduToday(new Date('2026-11-09T18:15:00.000Z'))).toBe('2026-11-10');
    expect(kathmanduToday(new Date('2026-11-09T00:00:00.000Z'))).toBe('2026-11-09');
    expect(kathmanduToday(new Date('2026-12-31T18:15:00.000Z'))).toBe('2027-01-01');
  });
});

describe('QuotationExpirySweeper', () => {
  it('asks the store for versions past valid_until on the Kathmandu date, with a bounded batch', async () => {
    const { sweeper, store } = setup({ clock: new Date('2026-11-09T18:20:00.000Z') });
    await sweeper.sweep();
    expect(store.candidates).toHaveBeenCalledWith('2026-11-10', EXPIRY_BATCH);
  });

  it('expires a version, then writes the audit event and the owner notice in the same transaction', async () => {
    const c = candidate(1);
    const { sweeper, calls, audit, txs } = setup({ candidates: [c] });
    await expect(sweeper.sweep()).resolves.toEqual({ expired: 1, skipped: 0, failed: 0 });
    expect(calls.filter((x) => !x.startsWith('candidates'))).toEqual([
      `expire:${c.versionId}:2026-11-09`,
      `audit:${c.versionId}`,
      `notify:quotation.expired:${c.versionId}`,
    ]);
    // One transaction, scoped to the version's entity, under the job's system actor.
    expect(txs).toHaveLength(1);
    expect(txs[0]?.scope).toEqual({ tenantId: c.tenantId, organizationId: c.organizationId });
    expect(txs[0]?.actor).toMatchObject({
      kind: 'system',
      id: `system:${QUOTATION_EXPIRY_JOB_PREFIX}`,
    });
    expect(audit.record).toHaveBeenCalledWith(
      TX,
      expect.objectContaining({
        action: 'quotation.expired',
        entityType: 'quotation_version',
        entityId: c.versionId,
        meta: { quotationId: 'quotation-1', from: 'sent', validUntil: '2026-11-08' },
      }),
    );
  });

  it('notifies the staff owner in the bell only: the customer-facing K5 email is never used', async () => {
    const c = candidate(1);
    const { sweeper, notify } = setup({ candidates: [c] });
    await sweeper.sweep();
    expect(notify.notifyUser).toHaveBeenCalledTimes(1);
    const [, input] = notify.notifyUser.mock.calls[0] as unknown as [
      unknown,
      Record<string, unknown>,
    ];
    expect(input).toMatchObject({
      userId: 'owner-1',
      link: '/quotations/quotation-1',
      dedupeKey: `quotation.expired:${c.versionId}`,
    });
    expect(input).not.toHaveProperty('email');
    expect(String(input['title'])).toContain('QT-2083-0001');
    expect(String(input['body'])).toContain('2026-11-08');
  });

  it('still expires a version that has no owner, and notifies nobody', async () => {
    const c = candidate(1);
    const { sweeper, audit, notify } = setup({
      candidates: [c],
      results: { [c.versionId]: expired({ ownerUserId: null }) },
    });
    await expect(sweeper.sweep()).resolves.toEqual({ expired: 1, skipped: 0, failed: 0 });
    expect(audit.record).toHaveBeenCalledTimes(1);
    expect(notify.notifyUser).not.toHaveBeenCalled();
  });

  it('skips a version the store did not change (accepted meanwhile): no audit, no notice', async () => {
    const c = candidate(1);
    const { sweeper, audit, notify } = setup({
      candidates: [c],
      results: { [c.versionId]: undefined },
    });
    await expect(sweeper.sweep()).resolves.toEqual({ expired: 0, skipped: 1, failed: 0 });
    expect(audit.record).not.toHaveBeenCalled();
    expect(notify.notifyUser).not.toHaveBeenCalled();
  });

  it('a failing version does not stop the next one', async () => {
    const a = candidate(1);
    const b = candidate(2);
    const { sweeper, calls } = setup({
      candidates: [a, b],
      results: { [a.versionId]: new Error('boom') },
    });
    await expect(sweeper.sweep()).resolves.toEqual({ expired: 1, skipped: 0, failed: 1 });
    expect(calls).toContain(`audit:${b.versionId}`);
    expect(calls).not.toContain(`audit:${a.versionId}`);
  });

  it('a failing notice fails that version only (its transaction rolls back as a whole)', async () => {
    const a = candidate(1);
    const { sweeper, notify } = setup({ candidates: [a] });
    notify.notifyUser.mockRejectedValueOnce(new Error('notify down'));
    await expect(sweeper.sweep()).resolves.toEqual({ expired: 0, skipped: 0, failed: 1 });
  });

  it('does nothing when no version is due', async () => {
    const { sweeper, txs } = setup();
    await expect(sweeper.sweep()).resolves.toEqual({ expired: 0, skipped: 0, failed: 0 });
    expect(txs).toHaveLength(0);
  });
});

describe('QuotationExpiryProcessor', () => {
  it('runs a sweep for the sweep job and refuses any other job name', async () => {
    const sweeper = { sweep: vi.fn().mockResolvedValue({ expired: 0, skipped: 0, failed: 0 }) };
    const processor = new QuotationExpiryProcessor(sweeper as unknown as QuotationExpirySweeper);
    await processor.process({ name: 'quotation.expiry.sweep' } as never);
    expect(sweeper.sweep).toHaveBeenCalledTimes(1);
    await expect(processor.process({ name: 'something.else' } as never)).rejects.toThrow(
      /Unknown quotation expiry job/,
    );
  });
});

describe('QuotationExpiryScheduler', () => {
  it('registers one hourly repeatable job through upsertJobScheduler (idempotent across restarts)', async () => {
    const queue = { upsertJobScheduler: vi.fn().mockResolvedValue(undefined) };
    await new QuotationExpiryScheduler(queue as never).onApplicationBootstrap();
    expect(EXPIRY_EVERY_MS).toBe(3_600_000);
    expect(queue.upsertJobScheduler).toHaveBeenCalledTimes(1);
    expect(queue.upsertJobScheduler).toHaveBeenCalledWith(
      'quotation.expiry.sweep',
      { every: 3_600_000 },
      expect.objectContaining({ name: 'quotation.expiry.sweep' }),
    );
  });
});
