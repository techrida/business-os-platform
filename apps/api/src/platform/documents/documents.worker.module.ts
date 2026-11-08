// Documents worker module (owner: U4): the docs.scan processor. Imported only by WorkerModule.
// Serves NFR Availability: scanning runs in the worker process, so a slow scan never blocks an API request.
import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';

import { AuditModule } from '../audit/audit.module';
import { AuditService } from '../audit/audit.service';
import { CoreConfig } from '../config/config';
import { NotifyModule } from '../notify/notify.module';
import { NotifyService } from '../notify/notify.service';
import { ClamdClient } from './clamd.client';
import { AUDIT_PORT, DOCS_SCAN_QUEUE, NOTIFY_PORT } from './documents.ports';
import { ScanProcessor } from './scan.processor';
import { DiskStorageAdapter, STORAGE_ADAPTER } from './storage.adapter';

@Module({
  imports: [AuditModule, NotifyModule, BullModule.registerQueue({ name: DOCS_SCAN_QUEUE })],
  providers: [
    {
      provide: STORAGE_ADAPTER,
      inject: [CoreConfig],
      useFactory: (config: CoreConfig) => new DiskStorageAdapter(config.FILES_ROOT),
    },
    {
      provide: ClamdClient,
      inject: [CoreConfig],
      useFactory: (config: CoreConfig) =>
        new ClamdClient({ host: config.CLAMD_HOST, port: config.CLAMD_PORT, timeoutMs: 60_000 }),
    },
    { provide: AUDIT_PORT, useExisting: AuditService },
    { provide: NOTIFY_PORT, useExisting: NotifyService },
    ScanProcessor,
  ],
})
export class DocumentsWorkerModule {}
