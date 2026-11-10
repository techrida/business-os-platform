import { Module } from '@nestjs/common';

import { TelemetryController } from './telemetry.controller';

// MetricsService comes from the global ObsModule, so no imports are needed here.
@Module({ controllers: [TelemetryController] })
export class TelemetryModule {}
