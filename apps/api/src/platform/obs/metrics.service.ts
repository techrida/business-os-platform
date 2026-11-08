import { Injectable } from '@nestjs/common';
import { Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

/**
 * Buckets are chosen so the NFR thresholds (300 ms, 500 ms, 800 ms) are bucket edges: a
 * percentile read from the histogram is then exact at those points instead of interpolated.
 */
export const HTTP_DURATION_BUCKETS = [0.025, 0.05, 0.1, 0.2, 0.3, 0.5, 0.8, 1, 2, 5] as const;
export const LCP_BUCKETS = [0.5, 1, 1.5, 2, 2.5, 4, 8] as const;

/**
 * The one place that knows prom-client. If we ever move to OpenTelemetry metrics, only this
 * file changes (prom-client has had no npm release since mid-2024).
 *
 * It owns a private Registry rather than using prom-client's global one: several Nest apps can
 * live in one process (tests do this) and the global registry throws on a duplicate name.
 */
@Injectable()
export class MetricsService {
  readonly registry = new Registry();

  private readonly httpDuration = new Histogram({
    name: 'http_server_request_duration_seconds',
    help: 'HTTP server request duration in seconds, by Nest route template.',
    labelNames: ['method', 'route', 'status_class'] as const,
    buckets: [...HTTP_DURATION_BUCKETS],
    registers: [this.registry],
  });

  private readonly lcp = new Histogram({
    name: 'web_vitals_lcp_seconds',
    help: 'Largest Contentful Paint reported by the browser, in seconds.',
    labelNames: ['app', 'route'] as const,
    buckets: [...LCP_BUCKETS],
    registers: [this.registry],
  });

  private readonly heartbeat = new Gauge({
    name: 'worker_last_heartbeat_seconds',
    help: 'Unix time of the last system.heartbeat job the worker processed (0 in the API).',
    registers: [this.registry],
  });

  private lastHeartbeat = 0;

  constructor() {
    collectDefaultMetrics({ register: this.registry });
  }

  /**
   * `route` must be the Nest route template (`/v1/things/:id`), never the raw URL: a raw URL
   * gives every id its own time series and exhausts Prometheus memory.
   */
  observeHttp(method: string, route: string, statusCode: number, seconds: number): void {
    const statusClass = `${Math.floor(statusCode / 100)}xx`;
    this.httpDuration.observe({ method, route, status_class: statusClass }, seconds);
  }

  observeWebVitalLcp(app: string, route: string, seconds: number): void {
    this.lcp.observe({ app, route }, seconds);
  }

  recordHeartbeat(epochSeconds: number): void {
    this.lastHeartbeat = epochSeconds;
    this.heartbeat.set(epochSeconds);
  }

  get lastHeartbeatSeconds(): number {
    return this.lastHeartbeat;
  }

  get contentType(): string {
    return this.registry.contentType;
  }

  render(): Promise<string> {
    return this.registry.metrics();
  }
}
