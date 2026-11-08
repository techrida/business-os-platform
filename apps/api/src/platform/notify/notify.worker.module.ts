// Notify worker module (owner: U5): the outbox drainer, its processor and its 5 s schedule.
// Imported only by WorkerModule, so the API process never sends email or consumes the outbox queue.
// Serves NFR Availability: a slow SMTP server stalls the worker's drain job, never an API request.
import { Module } from '@nestjs/common';

import { CoreConfig } from '../config/config';
import { DB, type Db } from '../db/db.module';
import { EMAIL_PROVIDER, type EmailProvider, SmtpEmailProvider } from './email.provider';
import { NotifyMetrics } from './notify-metrics';
import { NotifyModule } from './notify.module';
import { NotifyService } from './notify.service';
import { OUTBOX_CLOCK, type Clock, OutboxDrainer, systemClock } from './outbox.drainer';
import { OutboxDrainScheduler, OutboxProcessor } from './outbox.processor';

@Module({
  // NotifyModule gives NotifyService and re-exports the `outbox` queue the scheduler injects.
  imports: [NotifyModule],
  providers: [
    {
      provide: EMAIL_PROVIDER,
      inject: [CoreConfig],
      useFactory: (config: CoreConfig): EmailProvider => new SmtpEmailProvider(config),
    },
    { provide: OUTBOX_CLOCK, useValue: systemClock },
    NotifyMetrics,
    {
      provide: OutboxDrainer,
      inject: [DB, EMAIL_PROVIDER, OUTBOX_CLOCK, NotifyMetrics, NotifyService],
      useFactory: (
        db: Db,
        provider: EmailProvider,
        clock: Clock,
        metrics: NotifyMetrics,
        notify: NotifyService,
      ): OutboxDrainer => new OutboxDrainer(db, provider, clock, metrics, notify),
    },
    OutboxProcessor,
    OutboxDrainScheduler,
  ],
})
export class NotifyWorkerModule {}
