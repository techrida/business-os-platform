import { type Server, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { Injectable, type OnApplicationShutdown } from '@nestjs/common';

import { MetricsService } from './metrics.service';

export interface HealthReport {
  ok: boolean;
  detail?: Record<string, unknown>;
}

export interface MetricsServerOptions {
  host?: string;
  /** When given, the server also answers `GET /health` (the worker's container healthcheck). */
  health?: () => HealthReport;
}

/**
 * A tiny HTTP server, separate from the API router, that serves `/metrics`.
 *
 * Why separate: `/metrics` has no authentication, so it must never share a port with routes the
 * reverse proxy publishes. Caddy only forwards the API port; this port stays on the internal
 * network. It uses node:http directly so it does not depend on the Nest app being healthy.
 */
@Injectable()
export class MetricsServer implements OnApplicationShutdown {
  private server: Server | undefined;

  constructor(private readonly metrics: MetricsService) {}

  /** Starts listening and returns the bound port (useful when `port` is 0 in tests). */
  async listen(port: number, options: MetricsServerOptions = {}): Promise<number> {
    const { host = '0.0.0.0', health } = options;
    const server = createServer((req, res) => {
      const path = (req.url ?? '/').split('?')[0];
      if (req.method !== 'GET') {
        res.writeHead(405, { allow: 'GET' }).end();
        return;
      }
      if (path === '/metrics') {
        this.metrics.render().then(
          (body) => res.writeHead(200, { 'content-type': this.metrics.contentType }).end(body),
          () => res.writeHead(500, { 'content-type': 'text/plain' }).end('metrics unavailable'),
        );
        return;
      }
      if (path === '/health' && health) {
        const report = health();
        res
          .writeHead(report.ok ? 200 : 503, { 'content-type': 'application/json' })
          .end(JSON.stringify({ status: report.ok ? 'ok' : 'error', ...report.detail }));
        return;
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => {
        server.off('error', reject);
        resolve();
      });
    });
    this.server = server;
    return (server.address() as AddressInfo).port;
  }

  async close(): Promise<void> {
    const server = this.server;
    if (!server) return;
    this.server = undefined;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }

  async onApplicationShutdown(): Promise<void> {
    await this.close();
  }
}
