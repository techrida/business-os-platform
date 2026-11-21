// Unit test for NotifyService.nudge with a fake queue (no Valkey, no database). The write path and the
// reads are covered by notify.service.integration.test.ts. nudge is the one method that must never throw:
// it runs after a commit, where an exception would turn a successful request into an error.
import type { Queue } from 'bullmq';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { UserDirectory } from '../authz/user-directory';
import type { CoreConfig } from '../config/config';
import type { Db } from '../db/db.module';
import type { DbTransaction } from '../db/tx';
import { OUTBOX_DRAIN_JOB, OUTBOX_QUEUE } from './notify.constants';
import { NotifyService } from './notify.service';
import type { EmailTemplate } from './templates';

function serviceWith(queue: { add: ReturnType<typeof vi.fn> }): NotifyService {
  return new NotifyService(
    {} as Db,
    { WORKSPACE_PUBLIC_URL: 'https://app.example.com' } as CoreConfig,
    {} as UserDirectory,
    queue as unknown as Queue,
  );
}

describe('notify constants', () => {
  it('match the names the drainer and the plan use', () => {
    expect(OUTBOX_QUEUE).toBe('outbox');
    expect(OUTBOX_DRAIN_JOB).toBe('outbox.drain');
  });
});

describe('NotifyService.nudge', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('adds outbox.drain with a per-second job id and removes the job when it ends', async () => {
    // 2025-01-01T00:00:10.900Z is epoch second 1735689610 (the fraction is dropped).
    vi.setSystemTime(new Date('2025-01-01T00:00:10.900Z'));
    const queue = { add: vi.fn().mockResolvedValue(undefined) };

    await serviceWith(queue).nudge();

    expect(queue.add).toHaveBeenCalledExactlyOnceWith(
      'outbox.drain',
      {},
      { jobId: 'outbox.drain-1735689610', removeOnComplete: true, removeOnFail: true },
    );
  });

  it('uses a new job id in the next second', async () => {
    const queue = { add: vi.fn().mockResolvedValue(undefined) };
    const service = serviceWith(queue);

    vi.setSystemTime(new Date('2025-01-01T00:00:10.000Z'));
    await service.nudge();
    vi.setSystemTime(new Date('2025-01-01T00:00:11.000Z'));
    await service.nudge();

    const jobIds = queue.add.mock.calls.map((c) => (c[2] as { jobId: string }).jobId);
    expect(jobIds).toEqual(['outbox.drain-1735689610', 'outbox.drain-1735689611']);
  });

  it('swallows a queue error: the repeatable drain is the backstop', async () => {
    const queue = { add: vi.fn().mockRejectedValue(new Error('valkey is down')) };

    await expect(serviceWith(queue).nudge()).resolves.toBeUndefined();
    expect(queue.add).toHaveBeenCalledOnce();
  });

  it('stops waiting after about a second when the queue never answers (Valkey down)', async () => {
    const queue = { add: vi.fn().mockReturnValue(new Promise(() => undefined)) };
    let settled = false;

    const done = serviceWith(queue)
      .nudge()
      .then(() => {
        settled = true;
      });
    await vi.advanceTimersByTimeAsync(900);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(200);
    await done;
    expect(settled).toBe(true);
  });
});

describe('NotifyService.notifyUser email links', () => {
  /** A transaction that answers the scope query and records what the outbox insert receives. */
  function fakeTx() {
    const outboxRows: Record<string, unknown>[] = [];
    let insertCount = 0;
    const tx = {
      execute: vi
        .fn()
        .mockResolvedValue({ rows: [{ tenant_id: 'tenant-1', organization_id: 'org-1' }] }),
      insert: vi.fn(() => {
        insertCount += 1;
        const isOutbox = insertCount === 2; // the bell row is written first
        return {
          values: (row: Record<string, unknown>) => {
            if (isOutbox) outboxRows.push(row);
            return { onConflictDoNothing: () => Promise.resolve() };
          },
        };
      }),
    };
    return { tx: tx as unknown as DbTransaction, outboxRows };
  }

  const notifier = (config: Partial<CoreConfig>): NotifyService =>
    new NotifyService(
      {} as Db,
      config as CoreConfig,
      { emailOf: vi.fn().mockResolvedValue('someone@example.com') } as unknown as UserDirectory,
      { add: vi.fn() } as unknown as Queue,
    );

  const input = (template: EmailTemplate, linkPath: string) => ({
    userId: 'user-1',
    title: 't',
    body: 'b',
    link: '/inbox/1',
    email: { template, vars: { linkPath } },
    dedupeKey: 'evt:1',
  });

  it('builds a customer email link from PORTAL_PUBLIC_URL, not from the workspace address', async () => {
    const { tx, outboxRows } = fakeTx();
    const service = notifier({
      WORKSPACE_PUBLIC_URL: 'https://app.example.com',
      PORTAL_PUBLIC_URL: 'https://portal.example.com',
    });

    await service.notifyUser(tx, input('quotation.sent', '/quotations/q-1'));

    const row = outboxRows[0];
    expect(row?.bodyText).toContain('https://portal.example.com/quotations/q-1');
    expect(row?.bodyText).not.toContain('app.example.com');
  });

  it('keeps staff email links on WORKSPACE_PUBLIC_URL', async () => {
    const { tx, outboxRows } = fakeTx();
    const service = notifier({
      WORKSPACE_PUBLIC_URL: 'https://app.example.com',
      PORTAL_PUBLIC_URL: 'https://portal.example.com',
    });

    await service.notifyUser(tx, input('quotation.accepted', '/quotations/q-1'));

    expect(outboxRows[0]?.bodyText).toContain('https://app.example.com/quotations/q-1');
    expect(outboxRows[0]?.bodyText).not.toContain('portal.example.com');
  });
});

describe('NotifyService.notifyEmail (an address that is not a user, such as a customer contact)', () => {
  /** A transaction that answers the scope query and records every insert, with its conflict target. */
  function fakeTx() {
    const inserts: { row: Record<string, unknown>; target: unknown }[] = [];
    const tx = {
      execute: vi
        .fn()
        .mockResolvedValue({ rows: [{ tenant_id: 'tenant-1', organization_id: 'org-1' }] }),
      insert: vi.fn(() => ({
        values: (row: Record<string, unknown>) => ({
          onConflictDoNothing: (opts: { target: unknown }) => {
            inserts.push({ row, target: opts.target });
            return Promise.resolve();
          },
        }),
      })),
    };
    return { tx: tx as unknown as DbTransaction, inserts };
  }

  const config = {
    WORKSPACE_PUBLIC_URL: 'https://app.example.com',
    PORTAL_PUBLIC_URL: 'https://portal.example.com',
  } as CoreConfig;
  const emailOf = vi.fn();
  const notifier = (c: CoreConfig = config): NotifyService =>
    new NotifyService(
      {} as Db,
      c,
      { emailOf } as unknown as UserDirectory,
      { add: vi.fn() } as unknown as Queue,
    );

  it('writes one outbox row to the address, with no user, no bell row and a portal link', async () => {
    const { tx, inserts } = fakeTx();

    await notifier().notifyEmail(tx, {
      toEmail: 'buyer@acme.example',
      template: 'quotation.sent',
      data: { quotationNumber: 'QT-1', linkPath: '/quotations/q-1' },
      dedupeKey: 'quotation.sent:v-1',
    });

    expect(inserts).toHaveLength(1);
    const row = inserts[0]!.row;
    expect(row).toMatchObject({
      tenantId: 'tenant-1',
      organizationId: 'org-1',
      kind: 'email',
      template: 'quotation.sent',
      toUserId: null,
      toEmail: 'buyer@acme.example',
      dedupeKey: 'quotation.sent:v-1',
    });
    expect(row.bodyText).toContain('https://portal.example.com/quotations/q-1');
    expect(row.bodyText).toContain('QT-1');
    expect(emailOf).not.toHaveBeenCalled();
  });

  it('refuses a customer template without PORTAL_PUBLIC_URL and writes nothing', async () => {
    const { tx, inserts } = fakeTx();
    const service = notifier({ WORKSPACE_PUBLIC_URL: 'https://app.example.com' } as CoreConfig);

    await expect(
      service.notifyEmail(tx, {
        toEmail: 'buyer@acme.example',
        template: 'quotation.sent',
        data: { linkPath: '/quotations/q-1' },
        dedupeKey: 'quotation.sent:v-1',
      }),
    ).rejects.toThrow(/PORTAL_PUBLIC_URL/);
    expect(inserts).toHaveLength(0);
  });
});
