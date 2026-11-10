import { Module } from '@nestjs/common';

import { MeModule } from './modules/me/me.module';
import { TelemetryModule } from './modules/telemetry/telemetry.module';
import { AuthModule } from './platform/auth/auth.module';
import { ConfigModule } from './platform/config/config.module';
import { DbModule } from './platform/db/db.module';
import { HealthModule } from './platform/health/health.module';
import { ObsModule } from './platform/obs/obs.module';
import { QueueModule } from './platform/queue/queue.module';
import { TenancyModule } from './platform/tenancy/tenancy.module';

/**
 * The HTTP API. Import order matters in one place: TenancyModule comes before ObsModule because
 * Nest registers middleware in module order, and the correlation middleware must set
 * `req.correlationId` before pino-http's request-id generator reads it.
 * Config, Obs and Db are global, so the modules below inject their services without importing them.
 */
@Module({
  imports: [
    ConfigModule.forRoot({ service: 'api' }),
    TenancyModule,
    ObsModule.forRoot({ service: 'api' }),
    DbModule,
    QueueModule,
    AuthModule,
    HealthModule,
    MeModule,
    TelemetryModule,
  ],
})
export class AppModule {}
