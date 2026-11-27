import 'reflect-metadata';

import { EventEmitter } from 'node:events';

import { Global, Logger, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ConfigModule } from '../config/config.module';
import { MetricsService } from '../obs/metrics.service';
import { DB, DbModule, PG_POOL, guardClientErrors, inTransaction } from './db.module';
import { configureTx, txObserver, txTimeouts } from './tx-settings';

const ENV = {
  DATABASE_URL: 'postgresql://u:p@127.0.0.1:1/bos',
  VALKEY_URL: 'redis://127.0.0.1:1',
};

@Global()
@Module({ providers: [MetricsService], exports: [MetricsService] })
class FakeObsModule {}

describe('DbModule', () => {
  it('builds a lazy pool and a drizzle db, and closes the pool on shutdown', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          service: 'worker',
          env: {
            DATABASE_URL: 'postgresql://u:p@127.0.0.1:1/bos',
            VALKEY_URL: 'redis://127.0.0.1:1',
          },
        }),
        DbModule,
      ],
    }).compile();
    const app = moduleRef.createNestApplication();
    await app.init();
    const pool = moduleRef.get<{ end: () => Promise<void> }>(PG_POOL);
    const end = vi.spyOn(pool, 'end');
    expect(moduleRef.get(DB)).toBeDefined();
    await app.close();
    expect(end).toHaveBeenCalledOnce();
  });
});

describe('the connection pool options', () => {
  async function poolOptionsOf(service: 'api' | 'worker') {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          service,
          env:
            service === 'api'
              ? {
                  ...ENV,
                  OIDC_ISSUER: 'https://auth.example.com',
                  OIDC_AUDIENCE: 'aud',
                  OIDC_CLIENT_ID: 'c',
                }
              : ENV,
        }),
        DbModule,
      ],
    }).compile();
    const pool = moduleRef.get<{ options: Record<string, unknown>; end: () => Promise<void> }>(
      PG_POOL,
    );
    const options = { ...pool.options };
    await pool.end();
    return options;
  }

  it('gives the API 4 warm connections, a 5 minute idle limit and a 30 s statement limit', async () => {
    expect(await poolOptionsOf('api')).toMatchObject({
      max: 10,
      min: 4,
      idleTimeoutMillis: 300_000,
      connectionTimeoutMillis: 5_000,
      statement_timeout: 30_000,
      query_timeout: 35_000,
    });
  });

  it('keeps the worker on a longer 120 s statement limit', async () => {
    expect(await poolOptionsOf('worker')).toMatchObject({
      min: 4,
      statement_timeout: 120_000,
      query_timeout: 125_000,
    });
  });
});

describe('inTransaction', () => {
  it('runs the callback through the db transaction (commit or roll back is drizzle behaviour)', async () => {
    const tx = { marker: 'tx' };
    const db = { transaction: vi.fn((fn: (t: unknown) => Promise<unknown>) => fn(tx)) };
    const result = await inTransaction(db as never, (t) => Promise.resolve(t));
    expect(result).toBe(tx);
    expect(db.transaction).toHaveBeenCalledOnce();
  });
});

describe('DbModule settings and metrics', () => {
  afterEach(() => {
    configureTx({});
    vi.restoreAllMocks();
  });

  it('sets the withTx timeouts from config', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          service: 'worker',
          env: { ...ENV, DB_LOCK_TIMEOUT_MS: '1500', DB_IDLE_IN_TX_TIMEOUT_MS: '45000' },
        }),
        DbModule,
      ],
    }).compile();
    const app = moduleRef.createNestApplication();
    await app.init();
    expect(txTimeouts()).toEqual({
      lockTimeoutMs: 1500,
      statementTimeoutMs: 15_000,
      idleInTxTimeoutMs: 45_000,
    });
    await app.close();
  });

  it('reports the pool on /metrics and observes withTx while the app runs, where metrics exist', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ service: 'worker', env: ENV }), FakeObsModule, DbModule],
    }).compile();
    const app = moduleRef.createNestApplication();
    await app.init();
    const metrics = moduleRef.get(MetricsService);
    expect(txObserver()).toBe(metrics);
    const text = await metrics.render();
    // The pool starts warming its 4 connections at boot, so a count may be a pending connect, not 0.
    expect(text).toMatch(/^db_pool_connections [0-4]$/m);
    expect(text).toMatch(/^db_pool_idle_connections 0$/m);
    expect(text).toMatch(/^db_pool_waiting_clients 0$/m);
    await app.close();
    expect(txObserver()).toBeUndefined();
  });

  it('runs without metrics when no ObsModule is loaded', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ service: 'worker', env: ENV }), DbModule],
    }).compile();
    const app = moduleRef.createNestApplication();
    await app.init();
    expect(txObserver()).toBeUndefined();
    await app.close();
  });
});

describe('guardClientErrors', () => {
  it('logs an error a checked-out client emits instead of letting it crash the process', () => {
    const log = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const pool = new EventEmitter();
    const client = new EventEmitter();
    guardClientErrors(pool as never);
    pool.emit('connect', client);
    const fatal = Object.assign(
      new Error('terminating connection due to idle-in-transaction timeout'),
      { code: '25P03' },
    );
    expect(() => client.emit('error', fatal)).not.toThrow();
    expect(String(log.mock.calls[0]?.[0])).toContain('25P03');
    log.mockRestore();
  });
});
