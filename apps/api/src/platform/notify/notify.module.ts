// Notify modules (owner: U5): NotifyModule holds the service and the `outbox` queue, so the worker and
// every kernel module that notifies can import it without HTTP. NotifyHttpModule adds the bell routes
// and is the one AppModule imports. Same split as SettingsModule / SettingsHttpModule.
// UserDirectory is not provided here: the global UsersModule provides it.
import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';

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

@Module({
  imports: [NotifyModule],
  controllers: [NotifyController],
})
export class NotifyHttpModule {}
