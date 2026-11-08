// The docs.scan worker: streams a quarantined file to clamd and acts on the verdict.
// Serves NFR Security (nothing is downloadable before this says `clean`) and Availability (a down
// scanner means retries, then `scan_failed`; it never means "treat as clean").
//
// Decision, infected files: the file is DELETED from quarantine, not kept. The row keeps the SHA-256 and the
// signature name, which is the evidence anyone needs. Keeping live malware on the volume buys nothing and
// has a cost: it would sit next to clean files and could be opened by mistake. (The restic backup also skips
// quarantine/, so a restore never brings it back.) The uploader is told and simply uploads a fixed file.
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';

import { documents, documentVersions, scoped } from '@bos/db';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import type { Job } from 'bullmq';

import { DB, type Db } from '../db/db.module';
import { systemActor, withTx } from '../db/tx';
import { ClamdClient } from './clamd.client';
import {
  AUDIT_PORT,
  DOCS_SCAN_QUEUE,
  NOTIFY_PORT,
  type AuditPort,
  type NotifyPort,
  type ScanJobData,
} from './documents.ports';
import { STORAGE_ADAPTER, type StorageAdapter } from './storage.adapter';

/** What one run did. `retry` means "try again later": the processor throws so BullMQ retries with backoff. */
export type ScanOutcome = 'clean' | 'infected' | 'scan_failed' | 'skipped' | 'retry';

@Processor(DOCS_SCAN_QUEUE)
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

    const path = this.storage.quarantinePath(v.storageKey);
    if (!(await exists(path))) {
      // Either a previous run already promoted it (the database update then failed), or it is really gone.
      try {
        await this.storage.promote(v.storageKey); // idempotent: succeeds only if clean/ already holds it
        await this.markClean(scope, v, await this.engine());
        return 'clean';
      } catch {
        await this.markFailed(scope, v.id, 'file missing from quarantine');
        return 'scan_failed';
      }
    }

    const stream = createReadStream(path);
    const result = await this.clamd.scan(stream).finally(() => stream.destroy());

    if (result.verdict === 'clean') {
      await this.storage.promote(v.storageKey);
      await this.markClean(scope, v, await this.engine());
      return 'clean';
    }

    if (result.verdict === 'infected') {
      const engine = await this.engine();
      const linkPath = await this.noticeLink(s, v.documentId);
      await withTx(this.db, scope, systemActor('docs.scan'), async (tx) => {
        await tx
          .update(documentVersions)
          .set({
            status: 'infected',
            scanSignature: result.signature ?? 'unknown',
            scanEngine: engine,
            scannedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(s.where(documentVersions, eq(documentVersions.id, v.id)));
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
      });
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

    // verdict 'error': timeout, connection refused, clamd ERROR line. Not a verdict on the file.
    this.logger.warn(
      `scan of version ${v.id} failed (attempt final=${finalAttempt}): ${result.detail ?? ''}`,
    );
    if (!finalAttempt) return 'retry';
    await this.markFailed(scope, v.id, result.detail ?? 'scanner error');
    return 'scan_failed';
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
    engine: string,
  ): Promise<void> {
    const s = scoped(scope);
    await withTx(this.db, scope, systemActor('docs.scan'), async (tx) => {
      await tx
        .update(documentVersions)
        .set({
          status: 'clean',
          scanSignature: null,
          scanEngine: engine,
          scannedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(s.where(documentVersions, eq(documentVersions.id, v.id)));
      // The document points at its newest clean version: set it when it has none, or only an older one.
      await tx
        .update(documents)
        .set({ currentVersionId: v.id, updatedAt: new Date() })
        .where(
          s.where(
            documents,
            and(
              eq(documents.id, v.documentId),
              sql`(${documents.currentVersionId} IS NULL OR EXISTS (
                SELECT 1 FROM ${documentVersions} c
                 WHERE c.id = ${documents.currentVersionId} AND c.version < ${v.version}))`,
            ),
          ),
        );
      await this.audit.record(tx, {
        action: 'document.scanned',
        entityType: 'document_version',
        entityId: v.id,
        meta: { result: 'clean', engine, sha256: v.sha256?.toString('hex') ?? null },
      });
    });
  }

  private async markFailed(
    scope: { tenantId: string; organizationId: string },
    versionId: string,
    detail: string,
  ): Promise<void> {
    const s = scoped(scope);
    this.logger.error(`version ${versionId} is now scan_failed: ${detail}`);
    await withTx(this.db, scope, systemActor('docs.scan'), async (tx) => {
      await tx
        .update(documentVersions)
        .set({ status: 'scan_failed', updatedAt: new Date() })
        .where(s.where(documentVersions, eq(documentVersions.id, versionId)));
    });
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
