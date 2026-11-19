import type { DbTransaction } from '../../../platform/db/db.module';
import type { Actor, TxScope } from '../../../platform/db/tx';
import { describe, expect, it, vi } from 'vitest';

import {
  addDays,
  EXPIRING_SOON_DAYS,
  EXPIRY_BATCH,
  EXPIRY_EVERY_MS,
  kathmanduToday,
  QUOTATION_EXPIRY_JOB_PREFIX,
  QuotationExpiryProcessor,
  QuotationExpiryScheduler,
  QuotationExpirySweeper,
  type ExpiredVersion,
  type ExpiringNotice,
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

const notice = (over: Partial<ExpiringNotice> = {}): ExpiringNotice => ({
  quotationId: 'quotation-1',
  quotationNumber: 'QT-2083-0001',
  customerName: 'Himal Traders Pvt. Ltd.',
  validUntil: '2026-11-10',
  toEmail: 'sita@himal.example',
  ...over,
});

function setup(
  opts: {
    candidates?: ExpiryCandidate[];
    /** What `expire` returns per version id; a missing key means it expired with defaults, `undefined` means skipped. */
    results?: Record<string, ExpiredVersion | undefined | Error>;
    clock?: Date;
    /** Versions the expiring-soon pass finds. */
    expiring?: ExpiryCandidate[];
    /** What `expiringNotice` returns per version id; a missing key means a notice with defaults. */
    notices?: Record<string, ExpiringNotice | undefined | Error>;
  } = {},
) {
  const calls: string[] = [];
  const results = opts.results ?? {};
  const notices = opts.notices ?? {};
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
    expiringCandidates: vi.fn((from: string, until: string, limit: number) => {
      calls.push(`expiringCandidates(${from},${until},${limit})`);
      return Promise.resolve(opts.expiring ?? []);
    }),
    expiringNotice: vi.fn((_tx: DbTransaction, c: ExpiryCandidate) => {
      calls.push(`expiringNotice:${c.versionId}`);
      const result = c.versionId in notices ? notices[c.versionId] : notice();
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
    notifyEmail: vi.fn((_tx: DbTransaction, n: { dedupeKey: string }) => {
      calls.push(`email:${n.dedupeKey}`);
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
    await expect(sweeper.sweep()).resolves.toEqual({
      expired: 1,
      skipped: 0,
      failed: 0,
      expiring: 0,
    });
    expect(
      calls.filter((x) => !x.startsWith('candidates') && !x.startsWith('expiringCandidates')),
    ).toEqual([
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
    await expect(sweeper.sweep()).resolves.toEqual({
      expired: 1,
      skipped: 0,
      failed: 0,
      expiring: 0,
    });
    expect(audit.record).toHaveBeenCalledTimes(1);
    expect(notify.notifyUser).not.toHaveBeenCalled();
  });

  it('skips a version the store did not change (accepted meanwhile): no audit, no notice', async () => {
    const c = candidate(1);
    const { sweeper, audit, notify } = setup({
      candidates: [c],
      results: { [c.versionId]: undefined },
    });
    await expect(sweeper.sweep()).resolves.toEqual({
      expired: 0,
      skipped: 1,
      failed: 0,
      expiring: 0,
    });
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
    await expect(sweeper.sweep()).resolves.toEqual({
      expired: 1,
      skipped: 0,
      failed: 1,
      expiring: 0,
    });
    expect(calls).toContain(`audit:${b.versionId}`);
    expect(calls).not.toContain(`audit:${a.versionId}`);
  });

  it('a failing notice fails that version only (its transaction rolls back as a whole)', async () => {
    const a = candidate(1);
    const { sweeper, notify } = setup({ candidates: [a] });
    notify.notifyUser.mockRejectedValueOnce(new Error('notify down'));
    await expect(sweeper.sweep()).resolves.toEqual({
      expired: 0,
      skipped: 0,
      failed: 1,
      expiring: 0,
    });
  });

  it('does nothing when no version is due', async () => {
    const { sweeper, txs } = setup();
    await expect(sweeper.sweep()).resolves.toEqual({
      expired: 0,
      skipped: 0,
      failed: 0,
      expiring: 0,
    });
    expect(txs).toHaveLength(0);
  });
});

describe('addDays', () => {
  it('moves a calendar date across month and year ends', () => {
    expect(addDays('2026-11-09', 2)).toBe('2026-11-11');
    expect(addDays('2026-11-29', 2)).toBe('2026-12-01');
    expect(addDays('2026-12-31', 2)).toBe('2027-01-02');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
  });
});

describe('QuotationExpirySweeper expiring-soon notice', () => {
  it('looks for sent versions valid from today to today + 2 days in Kathmandu, with a bounded batch', async () => {
    // 18:20 UTC is already the 10th in Kathmandu.
    const { sweeper, store } = setup({ clock: new Date('2026-11-09T18:20:00.000Z') });
    await sweeper.sweep();
    expect(EXPIRING_SOON_DAYS).toBe(2);
    expect(store.expiringCandidates).toHaveBeenCalledWith('2026-11-10', '2026-11-12', EXPIRY_BATCH);
  });

  it('runs after the expiry pass, so a version that just expired is never also called expiring', async () => {
    const e = candidate(1);
    const { sweeper, calls } = setup({ candidates: [e], expiring: [candidate(2)] });
    await sweeper.sweep();
    const order = calls.filter(
      (x) => x.startsWith('expire:') || x.startsWith('expiringCandidates'),
    );
    expect(order).toEqual([
      `expire:${e.versionId}:2026-11-09`,
      `expiringCandidates(2026-11-09,2026-11-11,${EXPIRY_BATCH})`,
    ]);
  });

  it('emails the customer contact through notifyEmail, in the version own transaction, with the dedupe key', async () => {
    const c = candidate(2);
    const { sweeper, notify, txs, calls } = setup({ expiring: [c] });
    await expect(sweeper.sweep()).resolves.toEqual({
      expired: 0,
      skipped: 0,
      failed: 0,
      expiring: 1,
    });
    expect(notify.notifyEmail).toHaveBeenCalledTimes(1);
    expect(notify.notifyEmail).toHaveBeenCalledWith(TX, {
      toEmail: 'sita@himal.example',
      template: 'quotation.expiring',
      data: {
        quotationNumber: 'QT-2083-0001',
        customerName: 'Himal Traders Pvt. Ltd.',
        validUntil: '2026-11-10',
        // A path under the portal's quotations area, never a URL: the template prefixes PORTAL_PUBLIC_URL. The
        // portal looks quotations up by version id, so the path names the expiring version, not its quotation.
        linkPath: `/quotations/${c.versionId}`,
      },
      dedupeKey: `quotation.expiring:${c.versionId}`,
    });
    // Staff are not told in the bell: this notice is for the customer.
    expect(notify.notifyUser).not.toHaveBeenCalled();
    expect(txs).toHaveLength(1);
    expect(txs[0]?.scope).toEqual({ tenantId: c.tenantId, organizationId: c.organizationId });
    expect(txs[0]?.actor).toMatchObject({
      kind: 'system',
      id: `system:${QUOTATION_EXPIRY_JOB_PREFIX}`,
    });
    expect(calls.filter((x) => x.startsWith('expiringNotice') || x.startsWith('email'))).toEqual([
      `expiringNotice:${c.versionId}`,
      `email:quotation.expiring:${c.versionId}`,
    ]);
  });

  it('skips a version with no contact or no email (the store returns nothing) and sends nothing', async () => {
    const c = candidate(2);
    const { sweeper, notify } = setup({ expiring: [c], notices: { [c.versionId]: undefined } });
    await expect(sweeper.sweep()).resolves.toEqual({
      expired: 0,
      skipped: 1,
      failed: 0,
      expiring: 0,
    });
    expect(notify.notifyEmail).not.toHaveBeenCalled();
  });

  it('a failing email fails that version only; the next one is still noticed', async () => {
    const a = candidate(1);
    const b = candidate(2);
    const { sweeper, notify } = setup({ expiring: [a, b] });
    notify.notifyEmail.mockRejectedValueOnce(new Error('template broke'));
    await expect(sweeper.sweep()).resolves.toEqual({
      expired: 0,
      skipped: 0,
      failed: 1,
      expiring: 1,
    });
    expect(notify.notifyEmail).toHaveBeenCalledTimes(2);
  });

  it('a failing store read fails that version only', async () => {
    const a = candidate(1);
    const b = candidate(2);
    const { sweeper, notify } = setup({
      expiring: [a, b],
      notices: { [a.versionId]: new Error('read failed') },
    });
    await expect(sweeper.sweep()).resolves.toMatchObject({ failed: 1, expiring: 1 });
    expect(notify.notifyEmail).toHaveBeenCalledTimes(1);
  });

  it('opens no transaction when nothing is expiring', async () => {
    const { sweeper, txs } = setup();
    await sweeper.sweep();
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
