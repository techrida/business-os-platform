// Vendor KYC expiry job (P4): the daily processor and its schedule. VendorKycExpiryService does the work (it needs
// only the database and AuditService); this module adds the BullMQ queue, the processor that calls `run()` and the
// scheduler that registers the daily job. Imported only by WorkerModule, so the API process never suspends a vendor.
import { BullModule, InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable, Module, type OnApplicationBootstrap } from '@nestjs/common';
import { type Job, Queue } from 'bullmq';

import { VendorKycExpiryService, VendorsWorkerModule } from './vendor-kyc-expiry.service';

export const VENDOR_KYC_EXPIRY_QUEUE = 'vendors.kyc-expiry';
export const VENDOR_KYC_EXPIRY_JOB = 'vendors.kyc-expiry.run';
/** Every day at 01:00 Nepal time, after the Kathmandu day has rolled over. */
export const VENDOR_KYC_EXPIRY_CRON = '0 1 * * *';
export const VENDOR_KYC_EXPIRY_TZ = 'Asia/Kathmandu';

@Processor(VENDOR_KYC_EXPIRY_QUEUE)
export class VendorKycExpiryProcessor extends WorkerHost {
  constructor(private readonly expiry: VendorKycExpiryService) {
    super();
  }

  async process(job: Job): Promise<{ suspended: string[] }> {
    if (job.name === VENDOR_KYC_EXPIRY_JOB) return this.expiry.run();
    // A job name nobody handles is a bug; failing keeps it visible instead of silently dropping it.
    throw new Error(`Unknown vendor KYC expiry job: ${job.name}`);
  }
}

/** Registers the daily check. upsertJobScheduler is idempotent, so restarts never stack schedules. */
@Injectable()
export class VendorKycExpiryScheduler implements OnApplicationBootstrap {
  constructor(@InjectQueue(VENDOR_KYC_EXPIRY_QUEUE) private readonly queue: Queue) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.queue.upsertJobScheduler(
      VENDOR_KYC_EXPIRY_JOB,
      { pattern: VENDOR_KYC_EXPIRY_CRON, tz: VENDOR_KYC_EXPIRY_TZ },
      { name: VENDOR_KYC_EXPIRY_JOB, opts: { removeOnComplete: 5, removeOnFail: 20 } },
    );
  }
}

@Module({
  imports: [VendorsWorkerModule, BullModule.registerQueue({ name: VENDOR_KYC_EXPIRY_QUEUE })],
  providers: [VendorKycExpiryProcessor, VendorKycExpiryScheduler],
})
export class VendorKycExpiryJobsModule {}
