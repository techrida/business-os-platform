// The monthly audit seal job (k-audit). Serves the NFR "every change is audited, and the trail is
// tamper-evident" (ADR 0020): once a UTC month has closed, each tenant's chain for that month is verified
// and its tail (last seq + last hash) is written to audit.chain_seals by the SECURITY DEFINER function
// audit.seal(). bos_app has no right on chain_seals, so the function is the only way in.
import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { type Job, Queue } from 'bullmq';
import { sql } from 'drizzle-orm';

import { DB, type Db } from '../db/db.module';
import { systemActor, withTx } from '../db/tx';

export const AUDIT_QUEUE = 'audit';
export const AUDIT_SEAL_JOB = 'audit.seal';
export const AUDIT_SEAL_SCHEDULER_ID = 'audit.seal.monthly';
/**
 * 06:00 Kathmandu on the 1st. The plan said 02:00, but that is 20:15 UTC on the last day of the
 * month, while audit chain months are UTC: the month would still be open and the job would seal the
 * one before it, a month late. 06:00 Kathmandu is 00:15 UTC on the 1st, just after the UTC month closes.
 */
export const AUDIT_SEAL_PATTERN = '0 6 1 * *';
export const AUDIT_SEAL_TZ = 'Asia/Kathmandu';

/**
 * The first day ('YYYY-MM-01') of the UTC month before the one `now` falls in. Chains are cut on UTC
 * months (append() computes chain_month in UTC), so the job must count months the same way, whatever
 * time zone the schedule fires in.
 */
export function previousUtcMonth(now: Date): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1))
    .toISOString()
    .slice(0, 10);
}

export interface SealRunResult {
  month: string;
  tenants: number;
  sealed: number;
  alreadySealed: number;
}

/**
 * Seals the previous UTC month for every tenant that has rows in it. One tenant's failure (a broken
 * chain, a tenant without a default entity) never stops the others: failures are collected and the job
 * fails at the end, so BullMQ records it as failed. There is no automatic retry (attempts defaults to 1)
 * and no catch-up (next month's run seals only its own previous month), so an operator re-runs it. A
 * re-run is safe because audit.seal() inserts with ON CONFLICT DO NOTHING: tenants already sealed just
 * report sealed=false.
 */
@Processor(AUDIT_QUEUE)
export class SealProcessor extends WorkerHost {
  private readonly logger = new Logger(SealProcessor.name);

  constructor(@Inject(DB) private readonly db: Db) {
    super();
  }

  async process(job: Job): Promise<SealRunResult> {
    if (job.name !== AUDIT_SEAL_JOB) {
      // A job name nobody handles is a bug; failing keeps it visible instead of silently dropping it.
      throw new Error(`Unknown audit job: ${job.name}`);
    }
    const month = previousUtcMonth(new Date());
    // One actor (and so one correlation id) for the whole run, so its seals can be traced together.
    const actor = systemActor('audit-seal');

    const listed = await this.db.execute<{ tenant_id: string }>(
      sql`SELECT t AS tenant_id FROM audit.tenants_with_rows(${month}::date) AS t`,
    );
    const tenants = listed.rows.map((r) => r.tenant_id);

    let sealed = 0;
    let alreadySealed = 0;
    const failures: string[] = [];
    for (const tenantId of tenants) {
      try {
        const organizationId = await this.defaultEntity(tenantId);
        if (organizationId === undefined) {
          throw new Error('tenant has no default entity');
        }
        // withTx needs a full scope even though the seal is tenant-wide: audit.seal() reads neither
        // bos.organization_id nor any org table, and takes chain_seals.organization_id from the month's
        // last row. But the audit fallback needs bos.organization_id for any write to a tenant-scoped table
        // (ADR 0027), so the scope is the tenant's default entity: there is at most one per tenant, which
        // keeps reruns identical.
        // Sealing hashes a whole month of the tenant's chain: slow on purpose, so 5 minutes, not the 15 s default.
        const result = await withTx(
          this.db,
          { tenantId, organizationId },
          actor,
          (tx) =>
            tx.execute<{ sealed: boolean; last_seq: string | null }>(
              sql`SELECT sealed, last_seq FROM audit.seal(${tenantId}::uuid, ${month}::date)`,
            ),
          { statementTimeoutMs: 300_000 },
        );
        if (result.rows[0]?.sealed === true) {
          sealed += 1;
        } else {
          alreadySealed += 1;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.error(`audit seal ${month} failed for tenant ${tenantId}: ${message}`);
        failures.push(`${tenantId}: ${message}`);
      }
    }

    this.logger.log(
      `audit seal ${month}: ${tenants.length} tenant(s), ${sealed} sealed, ${alreadySealed} already sealed or empty, ${failures.length} failed`,
    );
    if (failures.length > 0) {
      throw new Error(
        `audit seal ${month}: ${failures.length} of ${tenants.length} tenant(s) failed: ${failures.join('; ')}`,
      );
    }
    return { month, tenants: tenants.length, sealed, alreadySealed };
  }

  private async defaultEntity(tenantId: string): Promise<string | undefined> {
    const found = await this.db.execute<{ id: string }>(
      sql`SELECT id FROM app.organizations WHERE tenant_id = ${tenantId}::uuid AND is_default`,
    );
    return found.rows[0]?.id;
  }
}

/**
 * Registers the monthly seal at startup. `upsertJobScheduler` is idempotent: restarting the worker (or
 * running two) updates the one schedule instead of stacking duplicates.
 */
@Injectable()
export class SealScheduler implements OnModuleInit {
  constructor(@InjectQueue(AUDIT_QUEUE) private readonly queue: Queue) {}

  async onModuleInit(): Promise<void> {
    await this.queue.upsertJobScheduler(
      AUDIT_SEAL_SCHEDULER_ID,
      { pattern: AUDIT_SEAL_PATTERN, tz: AUDIT_SEAL_TZ },
      { name: AUDIT_SEAL_JOB, opts: { removeOnComplete: 12, removeOnFail: 24 } },
    );
  }
}
