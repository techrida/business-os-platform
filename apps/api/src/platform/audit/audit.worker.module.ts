// Audit worker module (owner: U2): the monthly seal processor and its schedule on the `audit` queue.
// Imported only by WorkerModule, never by the API process. Serves the NFR "the audit trail is
// tamper-evident": closed months get a seal the app itself cannot write.
//
// It does not import AuditModule: that module carries the HTTP controller, and HTTP modules never enter
// the worker. The seal needs only DB (global) and the queue registered here.
import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';

import { AUDIT_QUEUE, SealProcessor, SealScheduler } from './seal.processor';

@Module({
  // The connection comes from BullModule.forRootAsync in QueueModule; this only adds the queue.
  imports: [BullModule.registerQueue({ name: AUDIT_QUEUE })],
  providers: [SealProcessor, SealScheduler],
})
export class AuditWorkerModule {}
