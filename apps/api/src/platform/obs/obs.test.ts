import 'reflect-metadata';

import { createServer, type Server } from 'node:http';
import { Writable } from 'node:stream';

import {
  Controller,
  Get,
  type INestApplication,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import pino from 'pino';
import { pinoHttp, type Options as PinoHttpOptions } from 'pino-http';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';

import type { CoreConfig } from '../config/config';
import { ConfigModule } from '../config/config.module';
import { newCorrelationId } from './correlation';
import { REDACT_PATHS, buildLoggerParams, genReqId } from './logger';
import { MetricsServer } from './metrics.server';
import { MetricsService, TX_DURATION_BUCKETS, TX_SETUP_BUCKETS } from './metrics.service';
import { ObsModule } from './obs.module';

const env = {
  LOG_LEVEL: 'silent',
  DATABASE_URL: 'postgresql://u:p@localhost:5432/bos',
  VALKEY_URL: 'redis://localhost:6379',
};

/** The `le` boundaries of one histogram series in Prometheus text output. */
function bucketBounds(text: string, metric: string): string[] {
  return [...text.matchAll(new RegExp(`^${metric}_bucket\\{[^}]*le="([^"]+)"[^}]*\\} `, 'gm'))].map(
    (m) => m[1] ?? '',
  );
}

describe('newCorrelationId', () => {
  it('keeps a valid incoming id', () => {
    expect(newCorrelationId('abc-12345678')).toBe('abc-12345678');
  });

  it.each([
    undefined,
    null,
    '',
    'short',
    'has space in it',
    'new\nline-forged',
    'x'.repeat(65),
    'bad_chars!!',
  ])('replaces %j with a UUID', (incoming) => {
    expect(newCorrelationId(incoming)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it('accepts the length limits 8 and 64', () => {
    expect(newCorrelationId('a'.repeat(8))).toBe('a'.repeat(8));
    expect(newCorrelationId('a'.repeat(64))).toBe('a'.repeat(64));
  });
});

describe('genReqId', () => {
  it('prefers req.correlationId, then a valid x-request-id header, then a fresh UUID', () => {
    expect(genReqId({ correlationId: 'from-middleware-1', headers: {} } as never)).toBe(
      'from-middleware-1',
    );
    expect(genReqId({ headers: { 'x-request-id': 'from-header-123' } } as never)).toBe(
      'from-header-123',
    );
    const generated = genReqId({ headers: { 'x-request-id': 'bad id' } } as never);
    expect(generated).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('stores a generated id on the request so a later reader agrees with the log', () => {
    const req = { headers: {} } as { headers: Record<string, string>; correlationId?: string };
    const id = genReqId(req as never);
    expect(req.correlationId).toBe(id);
    expect(genReqId(req as never)).toBe(id);
  });
});

describe('log redaction', () => {
  it('redacts authorization, cookie and *.password', () => {
    const lines: string[] = [];
    const sink = new Writable({
      write(chunk: Buffer, _enc, cb) {
        lines.push(chunk.toString());
        cb();
      },
    });
    const logger = pino({ redact: { paths: REDACT_PATHS, censor: '[Redacted]' } }, sink);
    logger.info({
      req: {
        headers: {
          authorization: 'Bearer secret-token',
          cookie: 'sid=secret-cookie',
          accept: 'json',
        },
      },
      res: { headers: { 'set-cookie': 'sid=secret-cookie' } },
      user: { password: 'secret-pw' },
      authorization: 'Bearer secret-token',
    });
    const out = lines.join('');
    expect(out).not.toContain('secret-token');
    expect(out).not.toContain('secret-cookie');
    expect(out).not.toContain('secret-pw');
    expect(out).toContain('"accept":"json"');
    expect(out).toContain('[Redacted]');
  });
});

describe('log redaction through pino-http', () => {
  it('redacts the step-up ID token header on a logged request (K7)', async () => {
    const lines: string[] = [];
    const sink = new Writable({
      write(chunk: Buffer, _enc, cb) {
        lines.push(chunk.toString());
        cb();
      },
    });
    // The real request logger settings, so a missing redact path shows up here.
    const params = buildLoggerParams({ LOG_LEVEL: 'info' } as unknown as CoreConfig, 'api');
    const log = pinoHttp(params.pinoHttp as PinoHttpOptions, sink);
    const server = createServer((req, res) => {
      log(req, res);
      res.end('ok');
    });
    await request(server)
      .post('/v1/approvals/requests/x/actions')
      .set('x-bos-id-token', 'header.secret-id-token.sig')
      .set('accept', 'json');
    const out = lines.join('');
    expect(out).toContain('"x-bos-id-token":"[Redacted]"');
    expect(out).not.toContain('secret-id-token');
    expect(out).toContain('"accept":"json"');
  });
});

describe('MetricsService', () => {
  it('uses the specified buckets for both histograms', async () => {
    const metrics = new MetricsService();
    metrics.observeHttp('GET', '/v1/me', 200, 0.12);
    metrics.observeWebVitalLcp('workspace', '/', 1.2);
    const text = await metrics.render();
    expect(bucketBounds(text, 'http_server_request_duration_seconds')).toEqual([
      '0.025',
      '0.05',
      '0.1',
      '0.2',
      '0.3',
      '0.5',
      '0.8',
      '1',
      '2',
      '5',
      '+Inf',
    ]);
    expect(bucketBounds(text, 'web_vitals_lcp_seconds')).toEqual([
      '0.5',
      '1',
      '1.5',
      '2',
      '2.5',
      '4',
      '8',
      '+Inf',
    ]);
  });

  it('labels with method, route and status_class', async () => {
    const metrics = new MetricsService();
    metrics.observeHttp('POST', '/v1/telemetry/vitals', 413, 0.01);
    metrics.observeWebVitalLcp('workspace', '/staff-only', 2);
    const text = await metrics.render();
    expect(text).toContain(
      'http_server_request_duration_seconds_count{method="POST",route="/v1/telemetry/vitals",status_class="4xx"} 1',
    );
    expect(text).toContain('web_vitals_lcp_seconds_count{app="workspace",route="/staff-only"} 1');
  });

  it('exports process metrics and the heartbeat gauge', async () => {
    const metrics = new MetricsService();
    metrics.recordHeartbeat(1_700_000_000);
    const text = await metrics.render();
    expect(text).toContain('process_cpu_user_seconds_total');
    expect(text).toContain('worker_last_heartbeat_seconds 1700000000');
    expect(metrics.lastHeartbeatSeconds).toBe(1_700_000_000);
  });

  it('reads the pool counts at scrape time', async () => {
    const metrics = new MetricsService();
    const pool = { totalCount: 4, idleCount: 1, waitingCount: 2 };
    metrics.observePool(pool);
    let text = await metrics.render();
    expect(text).toMatch(/^db_pool_connections 4$/m);
    expect(text).toMatch(/^db_pool_idle_connections 1$/m);
    expect(text).toMatch(/^db_pool_waiting_clients 2$/m);
    pool.waitingCount = 0;
    text = await metrics.render();
    expect(text).toMatch(/^db_pool_waiting_clients 0$/m);
  });

  it('counts busy rollbacks by kind and times transactions by outcome', async () => {
    const metrics = new MetricsService();
    metrics.countDbBusy('deadlock');
    metrics.countDbBusy('lock_timeout');
    metrics.countDbBusy('lock_timeout');
    metrics.observeTx('commit', 0.002, 0.04);
    metrics.observeTx('rollback', undefined, 6);
    const text = await metrics.render();
    expect(text).toContain('db_busy_errors_total{kind="deadlock"} 1');
    expect(text).toContain('db_busy_errors_total{kind="lock_timeout"} 2');
    expect(text).toContain('db_tx_duration_seconds_count{outcome="commit"} 1');
    expect(text).toContain('db_tx_duration_seconds_count{outcome="rollback"} 1');
    expect(text).toMatch(/^db_tx_setup_seconds_count 1$/m);
    expect(bucketBounds(text, 'db_tx_setup_seconds')).toEqual([
      ...TX_SETUP_BUCKETS.map(String),
      '+Inf',
    ]);
    expect(new Set(bucketBounds(text, 'db_tx_duration_seconds'))).toEqual(
      new Set([...TX_DURATION_BUCKETS.map(String), '+Inf']),
    );
  });

  it('keeps separate registries per instance (several Nest apps may share a process)', () => {
    expect(() => {
      new MetricsService();
      new MetricsService();
    }).not.toThrow();
  });
});

@Controller()
class ProbeController {
  @Get('items/:id')
  item(): { ok: true } {
    return { ok: true };
  }

  @Get('items/:id/missing')
  missing(): never {
    throw new NotFoundException();
  }

  @Get('denied')
  denied(): never {
    throw new UnauthorizedException();
  }
}

describe('HTTP latency middleware (real Nest app)', () => {
  let app: INestApplication | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  async function start(): Promise<{ app: INestApplication; metrics: MetricsService }> {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          service: 'api',
          env: {
            ...env,
            OIDC_ISSUER: 'http://127.0.0.1:1',
            OIDC_AUDIENCE: 'aud',
            OIDC_CLIENT_ID: 'client',
          },
        }),
        ObsModule.forRoot({ service: 'api' }),
      ],
      controllers: [ProbeController],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    return { app, metrics: moduleRef.get(MetricsService) };
  }

  it('labels by route template, never the raw URL', async () => {
    const started = await start();
    await request(started.app.getHttpServer() as Server)
      .get('/items/12345')
      .expect(200);
    await request(started.app.getHttpServer() as Server)
      .get('/items/98765')
      .expect(200);
    const text = await started.metrics.render();
    expect(text).toContain('route="/items/:id"');
    // The raw path must never become a label. (A bare-digit check is flaky: timing sums can contain them.)
    expect(text).not.toContain('/items/12345');
    expect(text).not.toContain('/items/98765');
    expect(text).toContain(
      'http_server_request_duration_seconds_count{method="GET",route="/items/:id",status_class="2xx"} 2',
    );
  });

  it('counts guard-style 401s, 404s from a handler and unmatched routes', async () => {
    const started = await start();
    await request(started.app.getHttpServer() as Server)
      .get('/denied')
      .expect(401);
    await request(started.app.getHttpServer() as Server)
      .get('/items/7/missing')
      .expect(404);
    await request(started.app.getHttpServer() as Server)
      .get('/no/such/path/777')
      .expect(404);
    const text = await started.metrics.render();
    expect(text).toContain('route="/denied",status_class="4xx"} 1');
    expect(text).toContain('route="/items/:id/missing",status_class="4xx"} 1');
    expect(text).toContain('route="unmatched",status_class="4xx"} 1');
    expect(text).not.toContain('/no/such/path');
  });
});

describe('MetricsServer', () => {
  it('serves /metrics on its own port and /health only when asked', async () => {
    const metrics = new MetricsService();
    metrics.observeHttp('GET', '/x', 200, 0.01);
    const server = new MetricsServer(metrics);
    const port = await server.listen(0, {
      host: '127.0.0.1',
      health: () => ({ ok: true, detail: { uptime: 1 } }),
    });
    try {
      const base = `http://127.0.0.1:${port}`;
      const res = await fetch(`${base}/metrics`);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain('http_server_request_duration_seconds_bucket');
      const health = await fetch(`${base}/health`);
      expect(health.status).toBe(200);
      expect(await health.json()).toEqual({ status: 'ok', uptime: 1 });
      expect((await fetch(`${base}/other`)).status).toBe(404);
      expect((await fetch(`${base}/metrics`, { method: 'POST' })).status).toBe(405);
    } finally {
      await server.close();
    }
  });

  it('answers 503 when the health callback says not ok, and 404 for /health without one', async () => {
    const unhealthy = new MetricsServer(new MetricsService());
    const p1 = await unhealthy.listen(0, { host: '127.0.0.1', health: () => ({ ok: false }) });
    const plain = new MetricsServer(new MetricsService());
    const p2 = await plain.listen(0, { host: '127.0.0.1' });
    try {
      expect((await fetch(`http://127.0.0.1:${p1}/health`)).status).toBe(503);
      expect((await fetch(`http://127.0.0.1:${p2}/health`)).status).toBe(404);
    } finally {
      await unhealthy.close();
      await plain.close();
    }
  });
});
