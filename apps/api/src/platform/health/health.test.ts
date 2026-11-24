import 'reflect-metadata';

import type { Server } from 'node:http';

import { getQueueToken } from '@nestjs/bullmq';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { TerminusModule } from '@nestjs/terminus';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { IS_PUBLIC_KEY } from '../auth/public.decorator';
import { PG_POOL } from '../db/db.module';
import { SYSTEM_QUEUE } from '../queue/queue.constants';
import { HealthController } from './health.controller';
import { HealthService } from './health.service';
import { JwksStatus } from './jwks-status';

interface Fakes {
  db: 'up' | 'down' | 'hang';
  valkey: 'up' | 'down';
  jwks: boolean;
}

describe('health', () => {
  let app: INestApplication | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
    vi.useRealTimers();
  });

  async function start(fakes: Fakes): Promise<INestApplication> {
    const pool = {
      query: () =>
        fakes.db === 'up'
          ? Promise.resolve({ rows: [{ '?column?': 1 }] })
          : fakes.db === 'down'
            ? Promise.reject(new Error('connection refused'))
            : new Promise(() => undefined),
    };
    const queue = {
      getBackend: () => ({
        connection: {
          client: Promise.resolve({
            ping: () =>
              fakes.valkey === 'up'
                ? Promise.resolve('PONG')
                : Promise.reject(new Error('ECONNREFUSED')),
          }),
        },
      }),
    };
    const moduleRef = await Test.createTestingModule({
      imports: [TerminusModule],
      controllers: [HealthController],
      providers: [
        HealthService,
        { provide: PG_POOL, useValue: pool },
        { provide: getQueueToken(SYSTEM_QUEUE), useValue: queue },
        { provide: JwksStatus, useValue: { isJwksReady: () => Promise.resolve(fakes.jwks) } },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    return app;
  }

  it('live answers 200 even when every dependency is down', async () => {
    const server = (
      await start({ db: 'down', valkey: 'down', jwks: false })
    ).getHttpServer() as Server;
    const res = await request(server).get('/health/live').expect(200);
    expect(res.body).toEqual({ status: 'ok' });
  });

  it('ready is 200 when db, valkey and jwks are all up', async () => {
    const server = (await start({ db: 'up', valkey: 'up', jwks: true })).getHttpServer() as Server;
    const res = await request(server).get('/health/ready').expect(200);
    expect(res.body).toMatchObject({
      status: 'ok',
      info: { db: { status: 'up' }, valkey: { status: 'up' }, jwks: { status: 'up' } },
    });
  });

  it.each<[string, Fakes, string]>([
    ['db is down', { db: 'down', valkey: 'up', jwks: true }, 'db'],
    ['valkey is down', { db: 'up', valkey: 'down', jwks: true }, 'valkey'],
    ['jwks was never fetched', { db: 'up', valkey: 'up', jwks: false }, 'jwks'],
  ])('ready is 503 when %s', async (_name, fakes, failing) => {
    const server = (await start(fakes)).getHttpServer() as Server;
    const res = await request(server).get('/health/ready').expect(503);
    expect(res.body).toMatchObject({ status: 'error', error: { [failing]: { status: 'down' } } });
  });

  it('ready is 503 (not a hang) when the database never answers', async () => {
    const server = (
      await start({ db: 'hang', valkey: 'up', jwks: true })
    ).getHttpServer() as Server;
    const res = await request(server).get('/health/ready').expect(503);
    expect(res.body).toMatchObject({ error: { db: { status: 'down' } } });
  }, 10_000);

  it('marks both routes @Public (the controller carries the metadata)', () => {
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, HealthController)).toBe(true);
  });
});
