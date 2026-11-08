import { Controller, Get } from '@nestjs/common';
import { HealthCheck, type HealthCheckResult } from '@nestjs/terminus';

import { Public } from '../auth/public.decorator';
import { HealthService } from './health.service';

/** The only routes in P0 that need no token. The e2e route sweep asserts exactly these two. */
@Public()
@Controller('health')
export class HealthController {
  constructor(private readonly service: HealthService) {}

  @Get('live')
  live(): { status: 'ok' } {
    return this.service.live();
  }

  @Get('ready')
  @HealthCheck()
  ready(): Promise<HealthCheckResult> {
    return this.service.ready();
  }
}
