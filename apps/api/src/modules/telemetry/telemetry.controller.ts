import { VitalsSchema } from '@bos/contracts';
import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  HttpCode,
  PayloadTooLargeException,
  Post,
} from '@nestjs/common';

import { MetricsService } from '../../platform/obs/metrics.service';

/** Largest accepted request body. A vitals sample is about 100 bytes; this leaves room and stops abuse. */
export const MAX_VITALS_BODY_BYTES = 2048;

/**
 * Routes allowed as a metric label. The browser sends any pathname, and an open label set would let a
 * client create unlimited time series in Prometheus (and run the API out of memory). Anything not
 * listed is recorded as `other`. Add routes here as the workspace grows.
 */
export const VITALS_ROUTE_ALLOWLIST: ReadonlySet<string> = new Set(['/', '/staff-only']);
export const OTHER_ROUTE = 'other';

/** The `app` label on every vitals metric sent from the workspace web app. */
const WORKSPACE_APP = 'workspace';

export function labelForRoute(route: string): string {
  return VITALS_ROUTE_ALLOWLIST.has(route) ? route : OTHER_ROUTE;
}

@Controller('v1/telemetry')
export class TelemetryController {
  constructor(private readonly metrics: MetricsService) {}

  @Post('vitals')
  @HttpCode(202)
  vitals(
    @Headers('content-length') contentLength: string | undefined,
    @Body() body: unknown,
  ): void {
    // Two checks on purpose. The header lets us refuse early without trusting the parsed body, but a
    // client can lie in it (or use chunked encoding, which has none), so the parsed body is measured too.
    const declared = contentLength === undefined ? Number.NaN : Number(contentLength);
    if (declared > MAX_VITALS_BODY_BYTES) {
      throw new PayloadTooLargeException('Request body too large');
    }
    const serialized = JSON.stringify(body) ?? '';
    if (Buffer.byteLength(serialized, 'utf8') > MAX_VITALS_BODY_BYTES) {
      throw new PayloadTooLargeException('Request body too large');
    }

    const parsed = VitalsSchema.safeParse(body);
    if (!parsed.success) {
      // Field names only: echoing values back would reflect attacker-controlled text.
      const fields = [...new Set(parsed.error.issues.map((i) => i.path.join('.') || 'body'))];
      throw new BadRequestException(`Invalid vitals sample: ${fields.join(', ')}`);
    }

    const { name, value, route } = parsed.data;
    if (name === 'LCP') {
      // The histogram is in seconds; the browser reports milliseconds.
      this.metrics.observeWebVitalLcp(WORKSPACE_APP, labelForRoute(route), value / 1000);
    }
    // CLS, INP, FCP and TTFB are valid but not recorded in P0: accept so the browser need not retry.
  }
}
