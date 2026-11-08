import { Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';

import { AuthModule } from '../auth/auth.module';
import { QueueModule } from '../queue/queue.module';
import { HealthController } from './health.controller';
import { HealthService } from './health.service';

/**
 * `/health/live` and `/health/ready`. Imports AuthModule to receive the `JwksStatus` provider
 * (AuthModule must export it) and QueueModule for the Valkey ping; the Postgres pool comes from
 * the global DbModule.
 */
@Module({
  imports: [TerminusModule, AuthModule, QueueModule],
  controllers: [HealthController],
  providers: [HealthService],
})
export class HealthModule {}
