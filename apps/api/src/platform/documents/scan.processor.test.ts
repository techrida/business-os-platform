// ScanProcessor and the scan sweeper against a real Postgres 16 (Testcontainers, migrations as bos_owner,
// queries as bos_app), the real DiskStorageAdapter on a temp dir and the fake clamd over TCP. Audit and notify
// are stubs; the queue is an in-memory stand-in that follows BullMQ's rule that a job id already in the queue
// (even a finished, retained job) makes add() a no-op.
// Serves review findings R7 (a short ClamAV outage must not end in a permanent scan_failed; a sweeper catches
// what retries miss) and R21 (verdict handling: no permanent verdict from a transient error, guarded
// updates, markClean errors propagate, unique re-queue ids).
// Needs Docker. Run: pnpm --filter @bos/api exec vitest run src/platform/documents/scan.processor.test.ts
import 'reflect-metadata';

import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { createTenantWithEntity, documentVersions } from '@bos/db';
import { Logger } from '@nestjs/common';
import type { Job, Queue } from 'bullmq';
import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Db } from '../db/db.module';
import { systemActor, withTx, type TxScope } from '../db/tx';
import { ClamdClient } from './clamd.client';
import { DOCS_SCAN_JOB, type ScanJobData } from './documents.ports';
import { startFakeClamd, type FakeClamd } from './fake-clamd';
import {
  SCAN_FAILED_INFRA,
  SCAN_JOB_OPTIONS,
  ScanProcessor,
  ScanSweepProcessor,
  scanBackoffTotalMs,
} from './scan.processor';
import { DiskStorageAdapter, type StorageAdapter } from './storage.adapter';
import { createTestDatabase, type TestDatabase } from '@bos/db/testing';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 180_000 });

const MINUTE = 60_000;

let testDb: TestDatabase;
let pool: Pool;
let db: Db;
let scope: TxScope;
let storageRoot: string;
let storage: DiskStorageAdapter;
let okClamd: FakeClamd;
let errorClamd: FakeClamd;
let deadPort: number;

const audit = { record: vi.fn().mockResolvedValue(undefined) };
const notify = { notifyUser: vi.fn().mockResolvedValue(undefined) };

/** Just enough of a BullMQ queue for the sweeper: getJobs by state, and add() that ignores a used id. */
class FakeQueue {
  readonly jobs = new Map<
    string,
    { id: string; name: string; data: ScanJobData; opts: Record<string, unknown>; state: string }
  >();
  add = vi.fn(
    (name: string, data: ScanJobData, opts: { jobId: string } & Record<string, unknown>) => {
      // BullMQ: a job whose id is already in the queue, in any state, is not added again.
      if (!this.jobs.has(opts.jobId)) {
        this.jobs.set(opts.jobId, { id: opts.jobId, name, data, opts, state: 'waiting' });
      }
      return Promise.resolve({ id: opts.jobId });
    },
  );
  getJobs = vi.fn((states: string[]) =>
    Promise.resolve([...this.jobs.values()].filter((j) => states.includes(j.state))),
  );
  /** Jobs the sweeper added (every id except the retained ones the tests plant). */
  added(versionId: string) {
    return this.add.mock.calls.filter(([, data]) => data.versionId === versionId);
  }
}

beforeAll(async () => {
  testDb = await createTestDatabase();
  const admin = new Pool({ connectionString: testDb.adminUrl, max: 1 });
  await admin.end();
  const bosAdmin = new Pool({ connectionString: testDb.adminUrl, max: 1 });
  await bosAdmin.end();

  pool = new Pool({ connectionString: testDb.appUrl, max: 8 });
  db = drizzle({ client: pool });

  const { tenantId, organizationId } = await createTenantWithEntity(pool);
  scope = { tenantId, organizationId };

  storageRoot = await mkdtemp(join(tmpdir(), 'bos-scan-test-'));
  storage = new DiskStorageAdapter(storageRoot);
  okClamd = await startFakeClamd();
  errorClamd = await startFakeClamd({ mode: 'error' });
  const dead = await startFakeClamd();
  deadPort = dead.port;
  await dead.close(); // nobody listens on this port any more
});

afterAll(async () => {
  await okClamd?.close();
  await errorClamd?.close();
  await pool?.end();
  await testDb?.drop();
  if (storageRoot) await rm(storageRoot, { recursive: true, force: true });
});

beforeEach(() => {
  audit.record.mockReset().mockResolvedValue(undefined);
  notify.notifyUser.mockReset().mockResolvedValue(undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------------------- helpers

const clamdAt = (port: number, timeoutMs = 2_000) =>
  new ClamdClient({ host: '127.0.0.1', port, timeoutMs });

const processorFor = (clamd: ClamdClient, adapter: StorageAdapter = storage) =>
  new ScanProcessor(db, adapter, clamd, audit, notify);

interface Seeded {
  documentId: string;
  versionId: string;
  storageKey: string;
  job: ScanJobData;
}

/** A document with one version in `status`; with `bytes` the file is also written to quarantine/. */
async function seed(
  status: 'quarantined' | 'scan_failed' = 'quarantined',
  opts: {
    bytes?: Buffer | null;
    scanEngine?: string | null;
    removed?: boolean;
    /** An upload whose type check and sha256 were never recorded (the receive is still running, or died). */
    unvalidated?: boolean;
  } = {},
): Promise<Seeded> {
  const documentId = randomUUID();
  const versionId = randomUUID();
  const storageKey = `${scope.tenantId}/${versionId}`;
  await withTx(db, scope, systemActor('test'), async (tx) => {
    // Raw SQL, not the drizzle table object: this test must not depend on columns another unit adds to
    // `documents` in a migration that may not be in the tree yet.
    await tx.execute(sql`INSERT INTO app.documents (id, tenant_id, organization_id, owner_type, owner_id)
      VALUES (${documentId}, ${scope.tenantId}, ${scope.organizationId}, 'test_memo', ${randomUUID()})`);
    // Inserted as awaiting_content and moved along the allowed transitions, as the real flow does.
    await tx.insert(documentVersions).values({
      id: versionId,
      ...scope,
      documentId,
      version: 1,
      filename: 'a.pdf',
      declaredMime: 'application/pdf',
      sizeBytes: 10,
      storageKey,
      status: 'awaiting_content',
    });
    await tx
      .update(documentVersions)
      .set({ status: 'quarantined' })
      .where(eq(documentVersions.id, versionId));
    // The receive records both in one UPDATE after its checks: that is what marks the bytes as validated.
    if (opts.unvalidated !== true) {
      await tx
        .update(documentVersions)
        .set({ sha256: createHash('sha256').update('x').digest(), detectedMime: 'application/pdf' })
        .where(eq(documentVersions.id, versionId));
    }
    if (status === 'scan_failed') {
      await tx
        .update(documentVersions)
        .set({ status: 'scan_failed', scanEngine: opts.scanEngine ?? null })
        .where(eq(documentVersions.id, versionId));
    }
    if (opts.removed === true) {
      await tx.execute(sql`UPDATE app.documents SET removed_at = now() WHERE id = ${documentId}`);
    }
  });
  if (opts.bytes !== null) {
    await storage.writeQuarantine(
      storageKey,
      Readable.from([opts.bytes ?? Buffer.from('%PDF-1.4 harmless')]),
      1_000_000,
    );
  }
  return { documentId, versionId, storageKey, job: { versionId, ...scope } };
}

async function row(versionId: string) {
  const { rows } = await pool.query<{
    status: string;
    scan_engine: string | null;
    current_version_id: string | null;
  }>(
    `SELECT v.status, v.scan_engine, d.current_version_id
       FROM app.document_versions v JOIN app.documents d ON d.id = v.document_id WHERE v.id = $1`,
    [versionId],
  );
  const r = rows[0];
  if (r === undefined) throw new Error('no such version');
  return r;
}

/** What BullMQ hands process(): the attempt counter and the options the job was queued with. */
const bullJob = (data: ScanJobData, attemptsMade: number, attempts: number) =>
  ({ name: DOCS_SCAN_JOB, data, attemptsMade, opts: { attempts } }) as unknown as Job<ScanJobData>;

const sweeperFor = (queue: FakeQueue) => new ScanSweepProcessor(db, queue as unknown as Queue);

// ------------------------------------------------------------------------------------------- R7

describe('R7: the scan survives a ClamAV outage of about half an hour', () => {
  it('queues scan jobs with a retry window of about 30 minutes (ADR 0022)', () => {
    expect(SCAN_JOB_OPTIONS.attempts).toBeGreaterThan(3);
    expect(SCAN_JOB_OPTIONS.backoff.type).toBe('exponential');
    const total = scanBackoffTotalMs();
    expect(total).toBeGreaterThanOrEqual(25 * MINUTE);
    expect(total).toBeLessThanOrEqual(40 * MINUTE);
  });

  it('a connection error on attempt 1 is not final: the job throws so BullMQ retries it', async () => {
    const s = await seed();
    const processor = processorFor(clamdAt(deadPort));
    await expect(processor.process(bullJob(s.job, 0, SCAN_JOB_OPTIONS.attempts))).rejects.toThrow(
      /retrying/,
    );
    expect((await row(s.versionId)).status).toBe('quarantined');
  });

  it('a connection error on the last attempt ends as scan_failed, marked as an infrastructure failure', async () => {
    const s = await seed();
    const processor = processorFor(clamdAt(deadPort));
    const last = SCAN_JOB_OPTIONS.attempts - 1;
    expect(await processor.process(bullJob(s.job, last, SCAN_JOB_OPTIONS.attempts))).toBe(
      'scan_failed',
    );
    expect(await row(s.versionId)).toMatchObject({
      status: 'scan_failed',
      scan_engine: SCAN_FAILED_INFRA,
    });
    expect(existsSync(storage.quarantinePath(s.storageKey))).toBe(true);
  });

  it('a definite clamd ERROR answer is final at once, and is not marked as infrastructure', async () => {
    const s = await seed();
    const processor = processorFor(clamdAt(errorClamd.port));
    expect(await processor.process(bullJob(s.job, 0, SCAN_JOB_OPTIONS.attempts))).toBe(
      'scan_failed',
    );
    const r = await row(s.versionId);
    expect(r.status).toBe('scan_failed');
    expect(r.scan_engine).not.toBe(SCAN_FAILED_INFRA);
  });
});

describe('R7: the sweeper', () => {
  const later = () => new Date(Date.now() + 16 * MINUTE);

  it('re-queues a version stuck in quarantined for over 15 minutes with no live job', async () => {
    const s = await seed();
    const queue = new FakeQueue();
    const result = await sweeperFor(queue).sweep(later());
    expect(result.requeued).toBeGreaterThanOrEqual(1);
    const [added] = queue.added(s.versionId);
    expect(added?.[0]).toBe(DOCS_SCAN_JOB);
    expect(added?.[1]).toEqual(s.job);
    expect(added?.[2]).toMatchObject({
      attempts: SCAN_JOB_OPTIONS.attempts,
      backoff: SCAN_JOB_OPTIONS.backoff,
    });
  });

  it('neither scans nor re-queues a quarantined version whose upload never recorded its validation', async () => {
    const s = await seed('quarantined', { unvalidated: true });
    const queue = new FakeQueue();
    await sweeperFor(queue).sweep(later());
    expect(queue.added(s.versionId)).toHaveLength(0);
    // A scan job that arrives anyway (an old one) does not publish the bytes either.
    expect(
      await processorFor({
        scan: () => Promise.resolve({ kind: 'clean' }),
      } as unknown as ClamdClient).scanVersion(s.job, true),
    ).toBe('skipped');
    expect((await row(s.versionId)).status).toBe('quarantined');
  });

  it('reopens an upload that never finished validating after 2 hours, so a retry starts clean', async () => {
    const s = await seed('quarantined', { unvalidated: true });
    await sweeperFor(new FakeQueue()).sweep(new Date(Date.now() + 2 * 60 * MINUTE + MINUTE));
    expect((await row(s.versionId)).status).toBe('awaiting_content');
  });

  it('leaves alone a quarantined version younger than 15 minutes', async () => {
    const s = await seed();
    const queue = new FakeQueue();
    await sweeperFor(queue).sweep(new Date());
    expect(queue.added(s.versionId)).toHaveLength(0);
  });

  it('leaves alone a stale version that still has a live job (a delayed retry counts as live)', async () => {
    const s = await seed();
    const queue = new FakeQueue();
    queue.jobs.set(`${s.versionId}-1`, {
      id: `${s.versionId}-1`,
      name: DOCS_SCAN_JOB,
      data: s.job,
      opts: {},
      state: 'delayed',
    });
    await sweeperFor(queue).sweep(later());
    expect(queue.added(s.versionId)).toHaveLength(0);
  });

  it('the re-queue job id is not the one a retained BullMQ job already holds (R21)', async () => {
    const s = await seed();
    const queue = new FakeQueue();
    // The upload queued the job under the bare version id; it finished long ago and BullMQ still retains it.
    queue.jobs.set(s.versionId, {
      id: s.versionId,
      name: DOCS_SCAN_JOB,
      data: s.job,
      opts: {},
      state: 'failed',
    });
    await sweeperFor(queue).sweep(later());
    const [added] = queue.added(s.versionId);
    const jobId = (added?.[2] as { jobId: string }).jobId;
    expect(jobId).not.toBe(s.versionId);
    // BullMQ refuses ':' in a custom id.
    expect(jobId).not.toContain(':');
    expect(queue.jobs.get(jobId)?.state).toBe('waiting');
    // A second sweep after that job was lost gets yet another id instead of colliding with the first.
    queue.jobs.get(jobId)!.state = 'failed';
    await sweeperFor(queue).sweep(new Date(Date.now() + 17 * MINUTE));
    const ids = queue.added(s.versionId).map((c) => (c[2] as { jobId: string }).jobId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBeGreaterThanOrEqual(2);
  });

  it('re-queues a scan_failed version whose failure was an infrastructure error, and puts it back to quarantined', async () => {
    const s = await seed('scan_failed', { scanEngine: SCAN_FAILED_INFRA });
    const queue = new FakeQueue();
    await sweeperFor(queue).sweep(new Date());
    expect(queue.added(s.versionId)).toHaveLength(1);
    // quarantined again, with the marker cleared: scanVersion skips anything that is not quarantined.
    expect(await row(s.versionId)).toMatchObject({ status: 'quarantined', scan_engine: null });
  });

  it('does not re-queue a scan_failed version that clamd failed definitively', async () => {
    const s = await seed('scan_failed', { scanEngine: null });
    const queue = new FakeQueue();
    await sweeperFor(queue).sweep(later());
    expect(queue.added(s.versionId)).toHaveLength(0);
    expect((await row(s.versionId)).status).toBe('scan_failed');
  });
});

// ----------------------------------------------------------------------------- removed documents

describe('a removed document (documents.removed_at set)', () => {
  it('its scan job is a no-op: no verdict, no infected notice, even when the bytes are gone', async () => {
    const s = await seed('quarantined', { bytes: null, removed: true });
    const processor = processorFor(clamdAt(okClamd.port));
    expect(await processor.scanVersion(s.job, true)).toBe('skipped');
    expect((await row(s.versionId)).status).toBe('quarantined'); // not scan_failed for the missing file
    expect(audit.record).not.toHaveBeenCalled();
    expect(notify.notifyUser).not.toHaveBeenCalled();
  });

  it('an infected file of a removed document gets no verdict and no notice', async () => {
    const eicar = (await import('./fake-clamd')).eicarBytes();
    const s = await seed('quarantined', { bytes: eicar, removed: true });
    const processor = processorFor(clamdAt(okClamd.port));
    expect(await processor.scanVersion(s.job, true)).toBe('skipped');
    expect((await row(s.versionId)).status).toBe('quarantined');
    expect(notify.notifyUser).not.toHaveBeenCalled();
  });

  it('the sweeper neither re-queues its stale quarantined version nor its infra scan_failed one', async () => {
    const stale = await seed('quarantined', { removed: true });
    const failed = await seed('scan_failed', { scanEngine: SCAN_FAILED_INFRA, removed: true });
    const queue = new FakeQueue();
    await sweeperFor(queue).sweep(new Date(Date.now() + 16 * MINUTE));
    expect(queue.added(stale.versionId)).toHaveLength(0);
    expect(queue.added(failed.versionId)).toHaveLength(0);
    expect((await row(failed.versionId)).status).toBe('scan_failed');
  });
});

// ------------------------------------------------------------------------------------------ R21

describe('R21: verdict handling', () => {
  it('a transient storage error on the missing-file path throws so the job retries; no verdict is written', async () => {
    const s = await seed('quarantined', { bytes: null }); // nothing in quarantine/
    const broken: StorageAdapter = Object.create(storage) as StorageAdapter;
    broken.promote = () => Promise.reject(Object.assign(new Error('i/o error'), { code: 'EIO' }));
    const processor = processorFor(clamdAt(okClamd.port), broken);
    await expect(processor.scanVersion(s.job, false)).rejects.toThrow('i/o error');
    expect((await row(s.versionId)).status).toBe('quarantined');
  });

  it('a file that is in neither quarantine/ nor clean/ is a definite scan_failed', async () => {
    const s = await seed('quarantined', { bytes: null });
    const processor = processorFor(clamdAt(okClamd.port));
    expect(await processor.scanVersion(s.job, false)).toBe('scan_failed');
    expect((await row(s.versionId)).status).toBe('scan_failed');
  });

  it('markClean errors propagate (missing-file path, file already promoted)', async () => {
    const s = await seed();
    await storage.promote(s.storageKey); // a previous run moved it, then its database update failed
    audit.record.mockRejectedValueOnce(new Error('audit is down'));
    const processor = processorFor(clamdAt(okClamd.port));
    await expect(processor.scanVersion(s.job, false)).rejects.toThrow('audit is down');
    expect((await row(s.versionId)).status).toBe('quarantined'); // rolled back, not scan_failed
  });

  describe('a promoted file whose clean mark failed earlier (nothing is scanned on this run)', () => {
    /** Seeds a quarantined version whose bytes were already promoted, with the given actor columns. */
    async function promoted(who: { uploadedBy: string | null; createdBy: string | null }) {
      const s = await seed();
      await storage.promote(s.storageKey);
      await withTx(db, scope, systemActor('test'), async (tx) => {
        await tx.execute(
          sql`UPDATE app.document_versions SET uploaded_by = ${who.uploadedBy} WHERE id = ${s.versionId}`,
        );
        await tx.execute(
          sql`UPDATE app.documents SET created_by = ${who.createdBy} WHERE id = ${s.documentId}`,
        );
      });
      return s;
    }
    const scanned = () =>
      (audit.record.mock.calls as unknown as [unknown, { action: string; meta?: object }][])
        .map(([, event]) => event)
        .filter((event) => event.action === 'document.scanned');

    it('labels a system-generated version (no uploader, no creator) generated, not with the scanner name', async () => {
      const s = await promoted({ uploadedBy: null, createdBy: null });
      const processor = processorFor(clamdAt(okClamd.port));
      const scansBefore = okClamd.scans.length;

      expect(await processor.scanVersion(s.job, false)).toBe('clean');

      expect(await row(s.versionId)).toMatchObject({ status: 'clean', scan_engine: 'generated' });
      expect(okClamd.scans).toHaveLength(scansBefore);
      expect(scanned()).toHaveLength(1);
      expect(scanned()[0]).toMatchObject({ meta: { result: 'generated', engine: 'generated' } });
    });

    it.each([
      ['an uploader', { uploadedBy: randomUUID(), createdBy: null }],
      ['a creator', { uploadedBy: null, createdBy: randomUUID() }],
    ])('keeps the ordinary label for a version that has %s', async (_name, who) => {
      const s = await promoted(who);
      const processor = processorFor(clamdAt(okClamd.port));

      expect(await processor.scanVersion(s.job, false)).toBe('clean');

      const r = await row(s.versionId);
      expect(r.status).toBe('clean');
      expect(r.scan_engine).not.toBe('generated');
      expect(scanned()[0]).toMatchObject({ meta: { result: 'clean' } });
    });
  });

  it('markClean errors propagate (normal path)', async () => {
    const s = await seed();
    audit.record.mockRejectedValueOnce(new Error('audit is down'));
    const processor = processorFor(clamdAt(okClamd.port));
    await expect(processor.scanVersion(s.job, false)).rejects.toThrow('audit is down');
    expect((await row(s.versionId)).status).toBe('quarantined');
  });

  it('a verdict is only written while the version is still quarantined: zero rows is a logged no-op', async () => {
    const s = await seed();
    // The race, made deterministic: the version is rejected after the scan read it and before the verdict.
    const racing: StorageAdapter = Object.create(storage) as StorageAdapter;
    // Through withTx like every write to app.*: the audit trigger needs the actor settings.
    racing.promote = async (key) => {
      await storage.promote(key);
      await withTx(db, scope, systemActor('race'), (tx) =>
        tx
          .update(documentVersions)
          .set({ status: 'rejected' })
          .where(eq(documentVersions.id, s.versionId)),
      );
    };
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const processor = processorFor(clamdAt(okClamd.port), racing);

    expect(await processor.scanVersion(s.job, false)).toBe('skipped');

    const r = await row(s.versionId);
    expect(r.status).toBe('rejected'); // not overwritten with clean
    expect(r.current_version_id).toBeNull();
    expect(audit.record).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(s.versionId));
  });

  it('a verdict of infected is not written, and the file is not deleted, when the version moved on', async () => {
    const eicar = (await import('./fake-clamd')).eicarBytes();
    const s = await seed('quarantined', { bytes: eicar });
    // clamd answers infected, but the version is rejected between the read and the update.
    const clamd = clamdAt(okClamd.port);
    const realScan = clamd.scan.bind(clamd);
    vi.spyOn(clamd, 'scan').mockImplementation(async (src) => {
      const result = await realScan(src);
      await withTx(db, scope, systemActor('race'), (tx) =>
        tx
          .update(documentVersions)
          .set({ status: 'rejected' })
          .where(eq(documentVersions.id, s.versionId)),
      );
      return result;
    });
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const processor = processorFor(clamd);

    expect(await processor.scanVersion(s.job, true)).toBe('skipped');

    expect((await row(s.versionId)).status).toBe('rejected');
    expect(audit.record).not.toHaveBeenCalled();
    expect(notify.notifyUser).not.toHaveBeenCalled();
    expect(existsSync(storage.quarantinePath(s.storageKey))).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(s.versionId));
  });
});
