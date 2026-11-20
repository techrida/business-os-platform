// Notify modules (owner: U5): NotifyModule holds the service and the `outbox` queue, so the worker and
// every kernel module that notifies can import it without HTTP. NotifyHttpModule adds the bell routes
// and the delivery log, and is the one AppModule imports. Same split as SettingsModule / SettingsHttpModule.
// UserDirectory is not provided here: the global UsersModule provides it.
import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';

import { AuditModule } from '../audit/audit.module';
import { BounceController } from './bounce.controller';
import { BounceService, BounceStore } from './bounce.service';
import { SqlBounceStore } from './bounce.store';
import { DeliveryLogController } from './delivery-log.controller';
import { DeliveryLogService } from './delivery-log.service';
import { NotifyController } from './notify.controller';
import { OUTBOX_QUEUE } from './notify.constants';
import { NotifyService } from './notify.service';

@Module({
  imports: [BullModule.registerQueue({ name: OUTBOX_QUEUE })],
  providers: [NotifyService],
  // BullModule is re-exported so the worker module (drainer) can inject the same queue.
  exports: [NotifyService, BullModule],
})
export class NotifyModule {}

// The delivery log (list and resend) lives here, not in NotifyModule, so the worker never loads it.
@Module({
  imports: [NotifyModule, AuditModule],
  controllers: [NotifyController, BounceController, DeliveryLogController],
  providers: [
    BounceService,
    { provide: BounceStore, useClass: SqlBounceStore },
    DeliveryLogService,
  ],
})
export class NotifyHttpModule {}
