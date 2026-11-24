// Payment-promise worker module (F1-Q33): the hourly job that marks missed promises to pay and plans their collection
// calls, with its processor and schedule. Imported only by WorkerModule, so the API process never runs it.
// AuditService comes from AuditModule; NotifyService from NotifyModule (the service without HTTP routes), which reads
// the UserDirectory of the worker's global UsersModule, as for the quotation expiry job.
import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';

import { AuditModule } from '../../../platform/audit/audit.module';
import { AuditService } from '../../../platform/audit/audit.service';
import { DB, type Db } from '../../../platform/db/db.module';
import { withTx } from '../../../platform/db/tx';
import { NotifyModule } from '../../../platform/notify/notify.module';
import { NotifyService } from '../../../platform/notify/notify.service';
import {
  drizzlePromiseStore,
  PAYMENT_PROMISE_QUEUE,
  PaymentPromiseProcessor,
  PaymentPromiseScheduler,
  PaymentPromiseSweeper,
  PROMISE_AUDIT,
  PROMISE_CLOCK,
  PROMISE_NOTIFY,
  PROMISE_STORE,
  PROMISE_TX,
  type RunInTx,
} from './payment-promise.sweeper';

@Module({
  imports: [AuditModule, NotifyModule, BullModule.registerQueue({ name: PAYMENT_PROMISE_QUEUE })],
  providers: [
    { provide: PROMISE_STORE, inject: [DB], useFactory: (db: Db) => drizzlePromiseStore(db) },
    {
      provide: PROMISE_TX,
      inject: [DB],
      useFactory:
        (db: Db): RunInTx =>
        (scope, actor, fn) =>
          withTx(db, scope, actor, fn),
    },
    { provide: PROMISE_AUDIT, useExisting: AuditService },
    { provide: PROMISE_NOTIFY, useExisting: NotifyService },
    { provide: PROMISE_CLOCK, useValue: () => new Date() },
    PaymentPromiseSweeper,
    PaymentPromiseProcessor,
    PaymentPromiseScheduler,
  ],
})
export class PaymentPromiseWorkerModule {}
