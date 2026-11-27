// The docs.scan worker: streams a quarantined file to clamd and acts on the verdict.
// Serves NFR Security (no upload is downloadable before this says `clean`; files the system renders itself skip
// the scan, D28, and are marked clean by DocumentsService.receiveGenerated) and Availability (a down
// scanner means retries over about half an hour, then `scan_failed`; it never means "treat as clean"; a
// sweeper keeps trying versions the retries gave up on, ADR 0022).
//
// Decision, infected files: the file is DELETED from quarantine, not kept. The row keeps the SHA-256 and the
// signature name, which is the evidence anyone needs. Keeping live malware on the volume buys nothing and
// has a cost: it would sit next to clean files and could be opened by mistake. (The restic backup also skips
// quarantine/, so a restore never brings it back.) The uploader is told and simply uploads a fixed file.
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';

import { documents, documentVersions, scoped } from '@bos/db';
import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { and, asc, eq, isNotNull, isNull, lt } from 'drizzle-orm';
import type { Job, Queue } from 'bullmq';

import { DB, type Db } from '../db/db.module';
import { systemActor, withTx } from '../db/tx';
import { ClamdClient } from './clamd.client';
import {
  AUDIT_PORT,
  DOCS_SCAN_JOB,
  DOCS_SCAN_QUEUE,
  NOTIFY_PORT,
  type AuditPort,
  type NotifyPort,
  type ScanJobData,
} from './documents.ports';
import { GENERATED_ENGINE, markVersionClean, stillQuarantined } from './mark-version-clean';
import { STORAGE_ADAPTER, type StorageAdapter } from './storage.adapter';

/**
 * How a scan job is queued: 7 tries, waiting 30 s, 60 s, 120 s ... 960 s between them (BullMQ's exponential
 * backoff is delay * 2^(attemptsMade - 1)), about 31 minutes in all. A short ClamAV outage (a restart, a
 * signature reload, an OOM kill and restart) then ends in a successful scan, not a permanent scan_failed.
 * The upload path (documents.service.ts) and the sweeper must queue with these same options.
 */
export const SCAN_JOB_OPTIONS = {
  attempts: 7,
  backoff: { type: 'exponential' as const, delay: 30_000 },
  removeOnComplete: 100,
  removeOnFail: 500,
};

/** Total time BullMQ waits between the attempts of one scan job, in ms. */
export function scanBackoffTotalMs(options = SCAN_JOB_OPTIONS): number {
  let total = 0;
  for (let made = 1; made < options.attempts; made += 1) {
    total += Math.round(2 ** (made - 1) * options.backoff.delay);
  }
  return total;
}

/**
 * Written to `scan_engine` of a `scan_failed` version when the scanner was unreachable (as opposed to clamd
 * answering with an error about this file). The sweeper re-queues exactly these. `scan_engine` is used
 * because it is not part of the version DTO and is otherwise empty on a failed scan; a dedicated column
 * would be cleaner (see the handback).
 */
export const SCAN_FAILED_INFRA = 'infra-error';

/** What one run did. `retry` means "try again later": the processor throws so BullMQ retries with backoff. */
export type ScanOutcome = 'clean' | 'infected' | 'scan_failed' | 'skipped' | 'retry';

// Three files at a time: a scan streams the file to clamd and mostly waits, so one upload of several files
// no longer queues behind its own first file. Each job opens its own clamd connection and its own transactions.
@Processor(DOCS_SCAN_QUEUE, { concurrency: 3 })
export class ScanProcessor extends WorkerHost {
  private readonly logger = new Logger(ScanProcessor.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(STORAGE_ADAPTER) private readonly storage: StorageAdapter,
    private readonly clamd: ClamdClient,
    @Inject(AUDIT_PORT) private readonly audit: AuditPort,
    @Inject(NOTIFY_PORT) private readonly notify: NotifyPort,
  ) {
    super();
  }

  async process(job: Job<ScanJobData>): Promise<ScanOutcome> {
    const finalAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
    const outcome = await this.scanVersion(job.data, finalAttempt);
    if (outcome === 'retry') throw new Error('clamd could not scan the file; retrying');
    return outcome;
  }

  /** The whole job, separate from BullMQ so tests can call it directly. */
  async scanVersion(data: ScanJobData, finalAttempt: boolean): Promise<ScanOutcome> {
    const scope = { tenantId: data.tenantId, organizationId: data.organizationId };
    const s = scoped(scope);
    const [v] = await this.db
      .select()
      .from(documentVersions)
      .where(s.where(documentVersions, eq(documentVersions.id, data.versionId)))
      .limit(1);
    // A retried or duplicated job must not scan or promote a version twice.
    if (v === undefined || v.status !== 'quarantined') {
      this.logger.warn(`scan skipped for version ${data.versionId}: ${v?.status ?? 'not found'}`);
      return 'skipped';
    }
    // The bytes are only a file to scan once the upload recorded that they passed its length and type checks. Before
    // that (a stopped process, a client still sending) they are unvalidated and must never be scanned clean.
    if (v.sha256 === null || v.detectedMime === null) {
      this.logger.warn(`scan skipped for version ${v.id}: its upload never finished validating`);
      return 'skipped';
    }
    // A removed document's quarantine bytes are deleted with it. A job that still arrives for it has nothing
    // to scan: no verdict (a missing file must not become scan_failed) and no infected notice.
    if (await this.documentRemoved(s, v.documentId)) {
      this.logger.warn(`scan skipped for version ${v.id}: its document was removed`);
      return 'skipped';
    }

    const path = this.storage.quarantinePath(v.storageKey);
    if (!(await exists(path))) {
      // Either a previous run already promoted it (the database update then failed), or it is really gone.
      try {
        await this.storage.promote(v.storageKey); // idempotent: succeeds only if clean/ already holds it
      } catch (error) {
        // Only "in neither folder" is a verdict. Any other error (disk I/O, permissions, a mount that is
        // briefly away) says nothing about the file, so it propagates and BullMQ retries.
        if (!isNotFound(error)) throw error;
        const applied = await this.markFailed(scope, v.id, 'file missing from quarantine', false);
        return applied ? 'scan_failed' : 'skipped';
      }
      // Outside the try: a database error here must fail the job, not turn into "file missing".
      // Nothing was scanned on this run. A system-rendered file (D28) whose clean mark failed after its promote
      // is finished as such, with the generated label, never with the scanner's name.
      const applied = (await this.isGenerated(s, v))
        ? await this.markClean(scope, v, { result: GENERATED_ENGINE, engine: GENERATED_ENGINE })
        : await this.markClean(scope, v, { result: 'clean', engine: await this.engine() });
      return applied ? 'clean' : 'skipped';
    }

    const stream = createReadStream(path);
    const result = await this.clamd.scan(stream).finally(() => stream.destroy());

    if (result.verdict === 'clean') {
      await this.storage.promote(v.storageKey);
      return (await this.markClean(scope, v, { result: 'clean', engine: await this.engine() }))
        ? 'clean'
        : 'skipped';
    }

    if (result.verdict === 'infected') {
      const engine = await this.engine();
      const linkPath = await this.noticeLink(s, v.documentId);
      const applied = await withTx(this.db, scope, systemActor('docs.scan'), async (tx) => {
        const updated = await tx
          .update(documentVersions)
          .set({
            status: 'infected',
            scanSignature: result.signature ?? 'unknown',
            scanEngine: engine,
            scannedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(s.where(documentVersions, stillQuarantined(v.id)))
          .returning({ id: documentVersions.id });
        // Zero rows: the version was rejected, finished by another run or otherwise moved on since we read
        // it. Our verdict is stale, so it writes nothing, audits nothing and notifies nobody.
        if (updated.length === 0) return false;
        await this.audit.record(tx, {
          action: 'document.infected',
          entityType: 'document_version',
          entityId: v.id,
          meta: { signature: result.signature ?? 'unknown', engine, filename: v.filename },
        });
        if (v.uploadedBy !== null) {
          await this.notify.notifyUser(tx, {
            userId: v.uploadedBy,
            title: 'File blocked by the virus scan',
            body: `${v.filename} was blocked because the scanner found a virus. It was not stored.`,
            link: linkPath,
            email: {
              template: 'document.infected',
              vars: { filename: v.filename, linkPath },
            },
            dedupeKey: `document.infected:${v.id}`,
          });
        }
        return true;
      });
      if (!applied) {
        this.noOp(v.id, 'infected verdict');
        return 'skipped';
      }
      // Deleted only after the status is committed. Deleting first meant a failed transaction left a
      // quarantined row with no file, and the BullMQ retry then marked it scan_failed. If the delete
      // itself fails the file is still unreachable (no link is issued for an infected version), so we
      // log it and keep the verdict.
      try {
        await this.storage.removeQuarantine(v.storageKey);
      } catch (error) {
        this.logger.error(
          `infected version ${v.id} is recorded but its quarantined file could not be deleted: ${String(error)}`,
        );
      }
      return 'infected';
    }

    // verdict 'error'. Not a verdict on the file, but two different things:
    //  - transient: the scanner was unreachable (refused, reset, timeout, no reply). Retry with backoff; only
    //    after the last attempt is it `scan_failed`, marked so the sweeper keeps trying later (R7).
    //  - definite: clamd answered with an ERROR line (for example "size limit exceeded"). Retrying cannot
    //    change that, so it is final at once and the sweeper leaves it alone.
    const transient = result.transient === true;
    this.logger.warn(
      `scan of version ${v.id} failed (transient=${transient}, final attempt=${finalAttempt}): ${result.detail ?? ''}`,
    );
    if (transient && !finalAttempt) return 'retry';
    const applied = await this.markFailed(scope, v.id, result.detail ?? 'scanner error', transient);
    return applied ? 'scan_failed' : 'skipped';
  }

  private noOp(versionId: string, what: string): void {
    this.logger.warn(
      `${what} for version ${versionId} was not applied: it is no longer quarantined (another run or a state change got there first)`,
    );
  }

  private async documentRemoved(
    s: ReturnType<typeof scoped>,
    documentId: string,
  ): Promise<boolean> {
    const [doc] = await this.db
      .select({ removedAt: documents.removedAt })
      .from(documents)
      .where(s.where(documents, eq(documents.id, documentId)))
      .limit(1);
    return doc?.removedAt != null;
  }

  /**
   * Was this version made by the system's generated path (createGenerated writes actorUuid(system) = null into both
   * `documents.created_by` and `document_versions.uploaded_by`)? A user upload always records its user, and no
   * request can set either column, so the pair is not client-controlled. Used only where nothing was scanned
   * (the quarantine file is already promoted) to label the version honestly. Limit: a non-user actor that used the
   * ordinary create + receiveContent path would carry the same null pair and be labelled generated here; only the
   * label would differ (the bytes are in clean storage either way).
   */
  private async isGenerated(
    s: ReturnType<typeof scoped>,
    v: typeof documentVersions.$inferSelect,
  ): Promise<boolean> {
    if (v.uploadedBy !== null) return false;
    const [doc] = await this.db
      .select({ createdBy: documents.createdBy })
      .from(documents)
      .where(s.where(documents, eq(documents.id, v.documentId)))
      .limit(1);
    return doc !== undefined && doc.createdBy === null;
  }

  /**
   * Where the "file blocked" notice points. Emails may only link under /inbox/ or /memos/ (buildLink), so a
   * known memo gets its own page and anything else the inbox. A bad path here would make notifyUser throw
   * and roll back the whole infected transaction.
   */
  private async noticeLink(s: ReturnType<typeof scoped>, documentId: string): Promise<string> {
    const [doc] = await this.db
      .select({ ownerType: documents.ownerType, ownerId: documents.ownerId })
      .from(documents)
      .where(s.where(documents, eq(documents.id, documentId)))
      .limit(1);
    return doc?.ownerType === 'test_memo' ? `/memos/${doc.ownerId}` : '/inbox/';
  }

  /** The scanner's version string for the audit trail; a failure here must not fail a good scan. */
  private async engine(): Promise<string> {
    try {
      return (await this.clamd.version()).slice(0, 120);
    } catch {
      return 'clamd';
    }
  }

  private async markClean(
    scope: { tenantId: string; organizationId: string },
    v: typeof documentVersions.$inferSelect,
    how: { result: string; engine: string },
  ): Promise<boolean> {
    // Errors propagate on purpose: the job fails and BullMQ retries; swallowing one here once turned a
    // database blip into a permanent scan_failed.
    const applied = await withTx(
      this.db,
      scope,
      systemActor('docs.scan'),
      async (tx) => (await markVersionClean(tx, this.audit, scope, v, how)) !== null,
    );
    if (!applied) this.noOp(v.id, 'clean verdict');
    return applied;
  }

  private async markFailed(
    scope: { tenantId: string; organizationId: string },
    versionId: string,
    detail: string,
    transient: boolean,
  ): Promise<boolean> {
    const s = scoped(scope);
    const applied = await withTx(this.db, scope, systemActor('docs.scan'), async (tx) => {
      const updated = await tx
        .update(documentVersions)
        .set({
          status: 'scan_failed',
          // The marker is what lets the sweeper tell "scanner was down" from "clamd said ERROR".
          ...(transient ? { scanEngine: SCAN_FAILED_INFRA } : {}),
          updatedAt: new Date(),
        })
        .where(s.where(documentVersions, stillQuarantined(versionId)))
        .returning({ id: documentVersions.id });
      return updated.length > 0;
    });
    if (applied) this.logger.error(`version ${versionId} is now scan_failed: ${detail}`);
    else this.noOp(versionId, 'scan_failed verdict');
    return applied;
  }
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ENOENT'
  );
}

/** Only ENOENT means "not there". Any other stat error (I/O, permissions) is not an answer, so it throws. */
async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
}

// ------------------------------------------------------------------------------------------ sweeper

/** The sweeper has its own queue so `ScanProcessor` stays a plain scan worker. */
export const DOCS_SCAN_SWEEP_QUEUE = 'docs.scan.sweep';
export const DOCS_SCAN_SWEEP_JOB = 'docs.scan.sweep';
export const DOCS_SCAN_SWEEP_SCHEDULER_ID = 'docs.scan.sweep.every10min';
export const SWEEP_EVERY_MS = 10 * 60_000;
/** A quarantined version this old with no live job lost its job (Valkey flushed, a crash between commit and queue). */
export const SWEEP_STALE_MS = 15 * 60_000;
/** One sweep re-queues at most this many versions per list, so a long outage cannot flood the queue at once. */
const SWEEP_BATCH = 200;
/**
 * Job states that mean "a worker will still look at this version". BullMQ 6 has no `paused` job
 * state: the jobs of a paused queue are reported as `waiting`.
 */
export const LIVE_STATES = [
  'active',
  'waiting',
  'delayed',
  'prioritized',
  'waiting-children',
] as const;

export interface SweepResult {
  /** Jobs added to the scan queue. */
  requeued: number;
  /** Of those, versions moved from scan_failed back to quarantined first. */
  reset: number;
}

type VersionRow = typeof documentVersions.$inferSelect;

/**
 * Every 10 minutes it re-queues, so no file stays stuck:
 *  - versions `quarantined` for over 15 minutes with no live scan job;
 *  - `scan_failed` versions whose failure was the scanner being unreachable (see SCAN_FAILED_INFRA). They go
 *    back to `quarantined` first (the trigger allows scan_failed -> quarantined), because scanVersion skips
 *    anything that is not quarantined.
 * Versions of a removed document are never touched (their bytes are gone). Versions are listed across
 * tenants on purpose (this is the system, not a request); each state change then runs in its own tenant's
 * scope through withTx.
 */
@Processor(DOCS_SCAN_SWEEP_QUEUE)
export class ScanSweepProcessor extends WorkerHost {
  private readonly logger = new Logger(ScanSweepProcessor.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    @InjectQueue(DOCS_SCAN_QUEUE) private readonly scanQueue: Queue,
  ) {
    super();
  }

  async process(job: Job): Promise<SweepResult> {
    if (job.name !== DOCS_SCAN_SWEEP_JOB) throw new Error(`Unknown scan sweep job: ${job.name}`);
    return this.sweep();
  }

  /** One pass. `now` is a parameter so tests need no waiting. */
  async sweep(now: Date = new Date()): Promise<SweepResult> {
    const cutoff = new Date(now.getTime() - SWEEP_STALE_MS);
    const stale = await this.list(
      and(
        eq(documentVersions.status, 'quarantined'),
        lt(documentVersions.updatedAt, cutoff),
        // Validated uploads only (sha256 and detected type, recorded together after the checks). An upload that never recorded
        // them stays quarantined for good: never scanned, published or served. The user uploads again as a new version.
        isNotNull(documentVersions.sha256),
        isNotNull(documentVersions.detectedMime),
      ),
    );
    const failed = await this.list(
      and(
        eq(documentVersions.status, 'scan_failed'),
        eq(documentVersions.scanEngine, SCAN_FAILED_INFRA),
      ),
    );
    if (stale.length === 0 && failed.length === 0) return { requeued: 0, reset: 0 };

    // A version that is waiting out a backoff has a delayed job, so it is live and left alone. Matching is by
    // the job's data, not its id: a re-queued job's id is not the version id.
    const live = new Set(
      (await this.scanQueue.getJobs([...LIVE_STATES], 0, -1))
        .filter((j) => j.name === DOCS_SCAN_JOB)
        .map((j) => (j.data as ScanJobData).versionId),
    );

    const result: SweepResult = { requeued: 0, reset: 0 };
    const failures: string[] = [];
    const attempt = async (v: VersionRow, resetFirst: boolean) => {
      if (live.has(v.id)) return;
      try {
        const scope = { tenantId: v.tenantId, organizationId: v.organizationId };
        if (resetFirst && !(await this.resetToQuarantined(scope, v.id))) return;
        const data: ScanJobData = { versionId: v.id, ...scope };
        await this.scanQueue.add(DOCS_SCAN_JOB, data, {
          ...SCAN_JOB_OPTIONS,
          // Not the bare version id: the upload's job (same id) may still be retained by BullMQ, and an add()
          // under a used id is silently dropped. The timestamp makes each re-queue its own job. No ':' either:
          // BullMQ rejects it in custom ids.
          jobId: `${v.id}-${now.getTime()}`,
        });
        result.requeued += 1;
        if (resetFirst) result.reset += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.error(`could not re-queue the scan of version ${v.id}: ${message}`);
        failures.push(`${v.id}: ${message}`);
      }
    };
    for (const v of stale) await attempt(v, false);
    for (const v of failed) await attempt(v, true);

    this.logger.log(
      `scan sweep: ${result.requeued} re-queued (${result.reset} were scan_failed), ${failures.length} failed`,
    );
    // A version whose reset committed but whose add() failed is quarantined with no job: the next sweep finds
    // it as stale, so failing the job here is for visibility, not for recovery.
    if (failures.length > 0) throw new Error(`scan sweep: ${failures.join('; ')}`);
    return result;
  }

  /** Oldest first, only versions whose document is not removed. */
  private async list(where: ReturnType<typeof and>): Promise<VersionRow[]> {
    const rows = await this.db
      .select({ v: documentVersions })
      .from(documentVersions)
      .innerJoin(documents, eq(documents.id, documentVersions.documentId))
      .where(and(where, isNull(documents.removedAt)))
      .orderBy(asc(documentVersions.updatedAt))
      .limit(SWEEP_BATCH);
    return rows.map((r) => r.v);
  }

  private resetToQuarantined(
    scope: { tenantId: string; organizationId: string },
    versionId: string,
  ): Promise<boolean> {
    const s = scoped(scope);
    return withTx(this.db, scope, systemActor('docs.scan.sweep'), async (tx) => {
      const updated = await tx
        .update(documentVersions)
        .set({ status: 'quarantined', scanEngine: null, updatedAt: new Date() })
        .where(
          s.where(
            documentVersions,
            and(
              eq(documentVersions.id, versionId),
              eq(documentVersions.status, 'scan_failed'),
              eq(documentVersions.scanEngine, SCAN_FAILED_INFRA),
            ),
          ),
        )
        .returning({ id: documentVersions.id });
      return updated.length > 0;
    });
  }
}

/**
 * Registers the sweep at worker start. `upsertJobScheduler` is idempotent, like the audit seal's: restarting
 * the worker (or running two) updates the one schedule instead of stacking duplicates.
 */
@Injectable()
export class ScanSweepScheduler implements OnModuleInit {
  constructor(@InjectQueue(DOCS_SCAN_SWEEP_QUEUE) private readonly queue: Queue) {}

  async onModuleInit(): Promise<void> {
    await this.queue.upsertJobScheduler(
      DOCS_SCAN_SWEEP_SCHEDULER_ID,
      { every: SWEEP_EVERY_MS },
      { name: DOCS_SCAN_SWEEP_JOB, opts: { removeOnComplete: 20, removeOnFail: 50 } },
    );
  }
}
