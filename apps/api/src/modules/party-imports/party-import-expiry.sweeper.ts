// The party import preview expiry job (worker only; round 5, FU11, Kuu decision K1 Q5 b). A customer or vendor CSV
// import is two steps: a preview batch (`previewed`), then the commit. A preview nobody commits keeps the uploaded
// names, addresses, emails and phones in `party_import_batches.rows`, so every 6 hours this job finds the previewed
// batches older than 7 days and moves each to `expired`, clearing its rows (migration 0185). Committed batches are the
// record of who imported what and are never touched; the database refuses to change them anyway.
//
// Safe to repeat and to run on two workers at once: every batch is its own transaction, the row is locked
// (SELECT ... FOR UPDATE) and re-checked for `previewed` and age, and the UPDATE names the status again. A batch that was
// committed meanwhile is therefore skipped, and a second run finds nothing left to do. The audit event commits with the
// change or not at all; its payload is the counts only, never the rows.
import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { partyImportBatches } from '@bos/db';
import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { type Job, Queue } from 'bullmq';
import { and, asc, eq, lt } from 'drizzle-orm';

import { AuditService } from '../../platform/audit/audit.service';
import { DB, type Db } from '../../platform/db/db.module';
import { systemActor, withTx } from '../../platform/db/tx';

export const PARTY_IMPORT_EXPIRY_QUEUE = 'party-import.expiry';
export const PARTY_IMPORT_EXPIRY_SWEEP_JOB = 'party-import.expiry.sweep';
/** The job name after the `system:` prefix of the actor id; the audit log shows `system:party-import-expiry`. */
export const PARTY_IMPORT_EXPIRY_JOB_PREFIX = 'party-import-expiry';
/** A preview is kept this long; a seven day window leaves a weekend and a holiday for the check. */
export const PARTY_IMPORT_PREVIEW_TTL_DAYS = 7;
export const PARTY_IMPORT_EXPIRY_EVERY_MS = 6 * 60 * 60_000;
/** Batches handled per run; a larger backlog drains over the following runs. */
export const PARTY_IMPORT_EXPIRY_BATCH = 200;

export interface PartyImportExpiryResult {
  expired: number;
  /** Batches another transaction finished first (a commit that won the lock). */
  skipped: number;
  failed: number;
}

@Injectable()
export class PartyImportExpirySweeper {
  private readonly logger = new Logger(PartyImportExpirySweeper.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  /** One run over every tenant. `now` is a parameter so tests need no waiting. */
  async sweep(now: Date = new Date()): Promise<PartyImportExpiryResult> {
    const cutoff = new Date(now.getTime() - PARTY_IMPORT_PREVIEW_TTL_DAYS * 24 * 60 * 60_000);
    const due = await this.db
      .select({
        id: partyImportBatches.id,
        tenantId: partyImportBatches.tenantId,
        organizationId: partyImportBatches.organizationId,
      })
      .from(partyImportBatches)
      .where(
        and(eq(partyImportBatches.status, 'previewed'), lt(partyImportBatches.createdAt, cutoff)),
      )
      .orderBy(asc(partyImportBatches.createdAt), asc(partyImportBatches.id))
      .limit(PARTY_IMPORT_EXPIRY_BATCH);

    const result: PartyImportExpiryResult = { expired: 0, skipped: 0, failed: 0 };
    for (const batch of due) {
      try {
        const outcome = await this.expireOne(batch, cutoff);
        result[outcome] += 1;
      } catch (error) {
        result.failed += 1;
        // The batch id and a fixed word only: an error message can carry uploaded data.
        this.logger.error(
          `party import expiry failed: batch=${batch.id} kind=${error instanceof Error ? error.name : 'error'}`,
        );
      }
    }
    this.logger.log(
      `party import expiry: ${result.expired} expired, ${result.skipped} skipped, ${result.failed} failed`,
    );
    return result;
  }

  async expireOne(
    batch: { id: string; tenantId: string; organizationId: string },
    cutoff: Date,
  ): Promise<'expired' | 'skipped'> {
    const scope = { tenantId: batch.tenantId, organizationId: batch.organizationId };
    return withTx(this.db, scope, systemActor(PARTY_IMPORT_EXPIRY_JOB_PREFIX), async (tx) => {
      const stillDue = and(
        eq(partyImportBatches.tenantId, batch.tenantId),
        eq(partyImportBatches.organizationId, batch.organizationId),
        eq(partyImportBatches.id, batch.id),
        eq(partyImportBatches.status, 'previewed'),
        lt(partyImportBatches.createdAt, cutoff),
      );
      // The lock is the race guard: a commit that is writing waits here, and its row no longer matches afterwards.
      const [locked] = await tx
        .select({
          kind: partyImportBatches.kind,
          fileName: partyImportBatches.fileName,
          rowCount: partyImportBatches.rowCount,
          validCount: partyImportBatches.validCount,
          duplicateCount: partyImportBatches.duplicateCount,
          errorCount: partyImportBatches.errorCount,
        })
        .from(partyImportBatches)
        .where(stillDue)
        .limit(1)
        .for('update');
      if (locked === undefined) return 'skipped';
      const updated = await tx
        .update(partyImportBatches)
        .set({ status: 'expired', rows: [] })
        .where(stillDue)
        .returning({ id: partyImportBatches.id });
      if (updated.length !== 1) return 'skipped';
      await this.audit.record(tx, {
        action: 'party_import.expired',
        entityType: 'party_import_batch',
        entityId: batch.id,
        meta: {
          kind: locked.kind,
          fileName: locked.fileName,
          rowCount: locked.rowCount,
          validCount: locked.validCount,
          duplicateCount: locked.duplicateCount,
          errorCount: locked.errorCount,
          ttlDays: PARTY_IMPORT_PREVIEW_TTL_DAYS,
        },
      });
      return 'expired';
    });
  }
}

@Processor(PARTY_IMPORT_EXPIRY_QUEUE)
export class PartyImportExpiryProcessor extends WorkerHost {
  constructor(private readonly sweeper: PartyImportExpirySweeper) {
    super();
  }

  async process(job: Job): Promise<void> {
    if (job.name === PARTY_IMPORT_EXPIRY_SWEEP_JOB) {
      await this.sweeper.sweep();
      return;
    }
    // A job name nobody handles is a bug; failing keeps it visible instead of silently dropping it.
    throw new Error(`Unknown party import expiry job: ${job.name}`);
  }
}

/** Registers the sweep. upsertJobScheduler is idempotent, so restarts never stack schedules. */
@Injectable()
export class PartyImportExpiryScheduler implements OnApplicationBootstrap {
  constructor(@InjectQueue(PARTY_IMPORT_EXPIRY_QUEUE) private readonly queue: Queue) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.queue.upsertJobScheduler(
      PARTY_IMPORT_EXPIRY_SWEEP_JOB,
      { every: PARTY_IMPORT_EXPIRY_EVERY_MS },
      { name: PARTY_IMPORT_EXPIRY_SWEEP_JOB, opts: { removeOnComplete: 5, removeOnFail: 20 } },
    );
  }
}
