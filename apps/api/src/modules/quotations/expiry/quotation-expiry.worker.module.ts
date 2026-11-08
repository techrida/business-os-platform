// Quotation expiry worker module (P2 unit Q3c): the hourly expiry sweeper, its processor and its schedule.
// Imported only by WorkerModule, so the API process never expires anything. Nothing here is needed by a request:
// a version past its date is closed by this job, and the accept path refuses it either way.
//
// NotifyService comes from NotifyModule (the service without HTTP routes), AuditService from AuditModule. The
// worker's global UsersModule provides the UserDirectory that NotifyService reads, as for the approvals worker.
import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';

import { AuditModule } from '../../../platform/audit/audit.module';
import { AuditService } from '../../../platform/audit/audit.service';
import { DB, type Db } from '../../../platform/db/db.module';
import { withTx } from '../../../platform/db/tx';
import { NotifyModule } from '../../../platform/notify/notify.module';
import { NotifyService } from '../../../platform/notify/notify.service';
import {
  drizzleExpiryStore,
  EXPIRY_AUDIT,
  EXPIRY_CLOCK,
  EXPIRY_NOTIFY,
  EXPIRY_STORE,
  EXPIRY_TX,
  QUOTATION_EXPIRY_QUEUE,
  QuotationExpiryProcessor,
  QuotationExpiryScheduler,
  QuotationExpirySweeper,
  type RunInTx,
} from './quotation-expiry.sweeper';

@Module({
  imports: [AuditModule, NotifyModule, BullModule.registerQueue({ name: QUOTATION_EXPIRY_QUEUE })],
  providers: [
    {
      provide: EXPIRY_STORE,
      inject: [DB],
      useFactory: (db: Db) => drizzleExpiryStore(db),
    },
    {
      provide: EXPIRY_TX,
      inject: [DB],
      useFactory:
        (db: Db): RunInTx =>
        (scope, actor, fn) =>
          withTx(db, scope, actor, fn),
    },
    { provide: EXPIRY_AUDIT, useExisting: AuditService },
    { provide: EXPIRY_NOTIFY, useExisting: NotifyService },
    { provide: EXPIRY_CLOCK, useValue: () => new Date() },
    QuotationExpirySweeper,
    QuotationExpiryProcessor,
    QuotationExpiryScheduler,
  ],
})
export class QuotationExpiryWorkerModule {}
