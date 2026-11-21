// The unused-evidence sweeper (round 5, FU2; worker only). A file uploaded in place as the evidence of a record (owner
// type `evidence`) is only kept once the record's form is saved. A dialog that is closed after the upload, a browser
// that is shut, or a request that failed leaves the file behind, and nothing removed it. Every hour this takes away
// the evidence files that no record uses and that were uploaded more than 24 hours ago.
//
// "Used" means named by a record: a billable schedule line, a match exception, a confirmed order's evidence, a recorded vendor quotation, or the
// evidence list of a quotation outcome. A used file is a frozen one (evidence-owner.policy.ts) and is never touched.
// A file is only judged by its age when none of its versions changed within the last 24 hours either.
//
// Removal is the documents kernel's own: the document is soft-removed (`removed_at`, the row and its clean bytes stay
// for the audit trail), `document.removed` is audited under the actor `system:evidence.sweep`, and the bytes of a
// version that never became clean are deleted after the commit. Files are listed across tenants on purpose (this is the
// system, not a request); each removal then runs in its own tenant's scope through withTx. The used check is made again
// inside that transaction, which also holds the tenant's audit-chain lock like every record save, so a save and a
// removal of the same file cannot interleave.
import {
  billingScheduleLines,
  documents,
  documentVersions,
  matchExceptions,
  quotationAcceptances,
  quotationEvidenceConfirmations,
  salesOrderEvidence,
  scoped,
  vendorQuotations,
} from '@bos/db';
import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import type { Job, Queue } from 'bullmq';
import { and, asc, eq, gte, isNull, lt, notExists, sql, type SQL } from 'drizzle-orm';

import { AuditService } from '../../platform/audit/audit.service';
import { DB, type Db } from '../../platform/db/db.module';
import { systemActor, withTx } from '../../platform/db/tx';
import { EVIDENCE_OWNER_TYPE } from '../../platform/documents/evidence-document';
import { STORAGE_ADAPTER, type StorageAdapter } from '../../platform/documents/storage.adapter';

export const EVIDENCE_SWEEP_QUEUE = 'evidence.sweep';
export const EVIDENCE_SWEEP_JOB = 'evidence.sweep';
export const EVIDENCE_SWEEP_SCHEDULER_ID = 'evidence.sweep.hourly';
export const EVIDENCE_SWEEP_EVERY_MS = 60 * 60_000;
/** How long an evidence file may stay unused before it is removed. */
export const UNUSED_EVIDENCE_AFTER_MS = 24 * 60 * 60_000;
/** One sweep removes at most this many files, oldest first, so a first run on a long backlog is spread over sweeps. */
const SWEEP_BATCH = 200;

export interface EvidenceSweepResult {
  removed: number;
}

/** True when a record names `documents.id`. Correlated on tenant and id: a record only names files of its own entity. */
function usedByARecord(db: Db): SQL[] {
  return [
    notExists(
      db
        .select({ one: sql`1` })
        .from(billingScheduleLines)
        .where(
          and(
            eq(billingScheduleLines.tenantId, documents.tenantId),
            eq(billingScheduleLines.billableEvidenceDocumentId, documents.id),
          ),
        ),
    ),
    notExists(
      db
        .select({ one: sql`1` })
        .from(salesOrderEvidence)
        .where(
          and(
            eq(salesOrderEvidence.tenantId, documents.tenantId),
            eq(salesOrderEvidence.documentId, documents.id),
          ),
        ),
    ),
    notExists(
      db
        .select({ one: sql`1` })
        .from(matchExceptions)
        .where(
          and(
            eq(matchExceptions.tenantId, documents.tenantId),
            eq(matchExceptions.evidenceDocumentId, documents.id),
          ),
        ),
    ),
    notExists(
      db
        .select({ one: sql`1` })
        .from(vendorQuotations)
        .where(
          and(
            eq(vendorQuotations.tenantId, documents.tenantId),
            eq(vendorQuotations.documentId, documents.id),
          ),
        ),
    ),
    notExists(
      db
        .select({ one: sql`1` })
        .from(quotationAcceptances)
        .where(
          and(
            eq(quotationAcceptances.tenantId, documents.tenantId),
            sql`${documents.id} = ANY(${quotationAcceptances.evidenceDocumentIds})`,
          ),
        ),
    ),
    notExists(
      db
        .select({ one: sql`1` })
        .from(quotationEvidenceConfirmations)
        .where(
          and(
            eq(quotationEvidenceConfirmations.tenantId, documents.tenantId),
            sql`${documents.id} = ANY(${quotationEvidenceConfirmations.evidenceDocumentIds})`,
          ),
        ),
    ),
  ];
}

@Injectable()
export class EvidenceSweeper {
  private readonly logger = new Logger(EvidenceSweeper.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly audit: AuditService,
    @Inject(STORAGE_ADAPTER) private readonly storage: Pick<StorageAdapter, 'removeQuarantine'>,
  ) {}

  /** One pass. `now` is a parameter so tests need no waiting. */
  async sweep(now: Date = new Date()): Promise<EvidenceSweepResult> {
    const cutoff = new Date(now.getTime() - UNUSED_EVIDENCE_AFTER_MS);
    const candidates = await this.db
      .select({
        id: documents.id,
        tenantId: documents.tenantId,
        organizationId: documents.organizationId,
      })
      .from(documents)
      .where(this.unusedWhere(cutoff))
      .orderBy(asc(documents.createdAt))
      .limit(SWEEP_BATCH);

    let removed = 0;
    const failures: string[] = [];
    for (const candidate of candidates) {
      try {
        if (await this.remove(candidate, cutoff)) removed += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.error(`could not remove unused evidence ${candidate.id}: ${message}`);
        failures.push(`${candidate.id}: ${message}`);
      }
    }
    if (removed > 0 || failures.length > 0) {
      this.logger.log(`evidence sweep: ${removed} unused files removed, ${failures.length} failed`);
    }
    if (failures.length > 0) throw new Error(`evidence sweep: ${failures.join('; ')}`);
    return { removed };
  }

  /** A live evidence document created before the cutoff, none of whose versions changed since, and no record names it. */
  private unusedWhere(cutoff: Date): SQL | undefined {
    return and(
      eq(documents.ownerType, EVIDENCE_OWNER_TYPE),
      isNull(documents.removedAt),
      lt(documents.createdAt, cutoff),
      notExists(
        this.db
          .select({ one: sql`1` })
          .from(documentVersions)
          .where(
            and(
              eq(documentVersions.tenantId, documents.tenantId),
              eq(documentVersions.documentId, documents.id),
              gte(documentVersions.updatedAt, cutoff),
            ),
          ),
      ),
      ...usedByARecord(this.db),
    );
  }

  /** True when the file was removed; false when a record took it, or it was removed, since it was listed. */
  private async remove(
    candidate: { id: string; tenantId: string; organizationId: string },
    cutoff: Date,
  ): Promise<boolean> {
    const scope = { tenantId: candidate.tenantId, organizationId: candidate.organizationId };
    const s = scoped(scope);
    const unclean = await withTx(this.db, scope, systemActor(EVIDENCE_SWEEP_JOB), async (tx) => {
      const [doc] = await tx
        .select({ id: documents.id, ownerId: documents.ownerId })
        .from(documents)
        .where(s.where(documents, and(eq(documents.id, candidate.id), this.unusedWhere(cutoff))))
        .for('update');
      if (doc === undefined) return null;
      const versions = await tx
        .select()
        .from(documentVersions)
        .where(s.where(documentVersions, eq(documentVersions.documentId, doc.id)))
        .orderBy(asc(documentVersions.version));
      const at = new Date();
      await tx
        .update(documents)
        .set({ removedAt: at, updatedAt: at })
        .where(s.where(documents, eq(documents.id, doc.id)));
      await this.audit.record(tx, {
        action: 'document.removed',
        entityType: 'document',
        entityId: doc.id,
        meta: {
          ownerType: EVIDENCE_OWNER_TYPE,
          ownerId: doc.ownerId,
          reason: 'unused_evidence',
          versions: versions.map((v) => ({ id: v.id, version: v.version, status: v.status })),
        },
      });
      return versions.filter((v) => v.status === 'quarantined' || v.status === 'scan_failed');
    });
    if (unclean === null) return false;
    // After the commit: a failed delete leaves an unreachable file, never a live row.
    for (const v of unclean) {
      try {
        await this.storage.removeQuarantine(v.storageKey);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn(
          `unused evidence ${candidate.id}: could not delete the file of ${v.id}: ${message}`,
        );
      }
    }
    return true;
  }
}

@Processor(EVIDENCE_SWEEP_QUEUE)
export class EvidenceSweepProcessor extends WorkerHost {
  constructor(private readonly sweeper: EvidenceSweeper) {
    super();
  }

  async process(job: Job): Promise<EvidenceSweepResult> {
    if (job.name !== EVIDENCE_SWEEP_JOB) throw new Error(`Unknown evidence sweep job: ${job.name}`);
    return this.sweeper.sweep();
  }
}

/** Registers the hourly sweep at worker start; `upsertJobScheduler` is idempotent, so a restart never stacks a second. */
@Injectable()
export class EvidenceSweepScheduler implements OnModuleInit {
  constructor(@InjectQueue(EVIDENCE_SWEEP_QUEUE) private readonly queue: Queue) {}

  async onModuleInit(): Promise<void> {
    await this.queue.upsertJobScheduler(
      EVIDENCE_SWEEP_SCHEDULER_ID,
      { every: EVIDENCE_SWEEP_EVERY_MS },
      { name: EVIDENCE_SWEEP_JOB, opts: { removeOnComplete: 20, removeOnFail: 50 } },
    );
  }
}
