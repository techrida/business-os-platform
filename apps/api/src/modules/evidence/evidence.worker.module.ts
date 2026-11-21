// Evidence worker module (round 5, FU2): the unused-evidence sweeper, its processor and its hourly schedule. Imported only
// by WorkerModule, so the API process never sweeps. The storage adapter deletes the bytes of a removed file that never
// became clean, exactly as the documents worker module builds it.
import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';

import { AuditModule } from '../../platform/audit/audit.module';
import { CoreConfig } from '../../platform/config/config';
import { DiskStorageAdapter, STORAGE_ADAPTER } from '../../platform/documents/storage.adapter';
import {
  EVIDENCE_SWEEP_QUEUE,
  EvidenceSweepProcessor,
  EvidenceSweepScheduler,
  EvidenceSweeper,
} from './evidence-sweeper';

@Module({
  imports: [AuditModule, BullModule.registerQueue({ name: EVIDENCE_SWEEP_QUEUE })],
  providers: [
    {
      provide: STORAGE_ADAPTER,
      inject: [CoreConfig],
      useFactory: (config: CoreConfig) => new DiskStorageAdapter(config.FILES_ROOT),
    },
    EvidenceSweeper,
    EvidenceSweepProcessor,
    EvidenceSweepScheduler,
  ],
})
export class EvidenceWorkerModule {}
