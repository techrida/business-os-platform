import 'reflect-metadata';

import type { Server } from 'node:http';
import { Writable } from 'node:stream';

import {
  Controller,
  ForbiddenException,
  Get,
  type INestApplication,
  type MiddlewareConsumer,
  Module,
  type NestModule,
  Put,
} from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { Logger, LoggerModule } from 'nestjs-pino';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { CoreConfig } from '../config/config';
import { buildLoggerParams } from '../obs/logger';
import { ErrorBodyFilter } from './error-body.filter';

// Values a leaked request would carry into the line: a record id, a query string and a searched name.
const USER_ID = 'sample-id';
const QUERY_VALUE = 'test-only';
const SEARCHED_NAME = 'Ramesh Shrestha';
const BLOCKED_ID = 'blocked-record-42';

@Controller('v1')
class DeniedController {
  @Put('admin/users/:id/roles')
  setRoles(): never {
    throw new ForbiddenException({ code: 'forbidden', reason: 'no_permission', message: 'No' });
  }

  @Get('customers')
  search(): never {
    throw new ForbiddenException({ code: 'forbidden', reason: 'out_of_scope', message: 'No' });
  }
}

/** A refusal before routing, like an auth middleware: Express has matched no route yet. */
function refuseBeforeRouting(): never {
  throw new ForbiddenException({
    code: 'forbidden',
    reason: 'entity_not_permitted',
    message: 'No',
  });
}

const lines: string[] = [];
const sink = new Writable({
  write(chunk: Buffer, _enc, cb) {
    lines.push(...chunk.toString().split('\n').filter(Boolean));
    cb();
  },
});

// The app's own logger settings, at warn: the access log is suppressed and only the 403 line is left.
const params = buildLoggerParams({ LOG_LEVEL: 'warn' } as unknown as CoreConfig, 'api');

@Module({
  imports: [LoggerModule.forRoot({ ...params, pinoHttp: [params.pinoHttp as object, sink] })],
  controllers: [DeniedController],
  providers: [{ provide: APP_FILTER, useClass: ErrorBodyFilter }],
})
class DeniedModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(refuseBeforeRouting).forRoutes('v1/blocked/{*rest}');
  }
}

/** The parsed `http.forbidden` lines written since `from`, with each raw line kept for substring checks. */
function forbiddenLines(from: number): { raw: string; json: Record<string, unknown> }[] {
  return lines
    .slice(from)
    .map((raw) => ({ raw, json: JSON.parse(raw) as Record<string, unknown> }))
    .filter((line) => line.json.event === 'http.forbidden');
}

/** Keys a request-bound pino line has (pino-http's `req` and `res`, Express fields); none may appear. */
const REQUEST_KEYS = [
  'req',
  'res',
  'url',
  'query',
  'params',
  'headers',
  'ip',
  'remoteAddress',
  'path',
];

describe('the http.forbidden log line (serialized by the real logger)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [DeniedModule] }).compile();
    app = moduleRef.createNestApplication({ bufferLogs: true });
    // As in main.ts: Nest's logger is nestjs-pino's, so a request-bound line would reach the sink.
    app.useLogger(app.get(Logger));
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  async function deniedLine(
    send: (server: Server) => request.Test,
  ): Promise<{ raw: string; json: Record<string, unknown>; requestId: string }> {
    const from = lines.length;
    const res = await send(app.getHttpServer() as Server);
    expect(res.status).toBe(403);
    const found = forbiddenLines(from);
    expect(found).toHaveLength(1);
    const [line] = found;
    if (line === undefined) throw new Error('no http.forbidden line');
    return { ...line, requestId: String(res.headers['x-request-id']) };
  }

  function expectNoRequestData(line: { raw: string; json: Record<string, unknown> }): void {
    for (const key of REQUEST_KEYS) expect(line.json).not.toHaveProperty(key);
    for (const value of [
      USER_ID,
      QUERY_VALUE,
      'sample=',
      SEARCHED_NAME,
      'Ramesh',
      'Shrestha',
      BLOCKED_ID,
    ]) {
      expect(line.raw).not.toContain(value);
    }
    expect(line.raw).not.toContain('127.0.0.1');
    expect(line.raw).not.toContain('::1');
    expect(line.raw).not.toContain('"url"');
  }

  it('a denied role change logs the route template and none of the id or query string', async () => {
    const line = await deniedLine((server) =>
      request(server)
        .put(`/v1/admin/users/${USER_ID}/roles?sample=${QUERY_VALUE}`)
        .set('user-agent', 'probe-agent')
        .send({ roles: ['x'] }),
    );
    expectNoRequestData(line);
    expect(line.raw).not.toContain('probe-agent');
    expect(line.json).toMatchObject({
      level: 'warn',
      service: 'bos-api',
      msg: 'request forbidden',
      event: 'http.forbidden',
      status: 403,
      method: 'PUT',
      route: '/v1/admin/users/:id/roles',
      code: 'forbidden',
      reason: 'no_permission',
      correlationId: line.requestId,
    });
  });

  it('a denied customer search logs no searched name', async () => {
    const line = await deniedLine((server) =>
      request(server).get('/v1/customers').query({ search: SEARCHED_NAME }),
    );
    expectNoRequestData(line);
    expect(line.json).toMatchObject({
      method: 'GET',
      route: '/v1/customers',
      reason: 'out_of_scope',
      correlationId: line.requestId,
    });
  });

  it('a refusal before routing logs the fixed fallback, not the path', async () => {
    const line = await deniedLine((server) =>
      request(server).get(`/v1/blocked/${BLOCKED_ID}?sample=${QUERY_VALUE}`),
    );
    expectNoRequestData(line);
    expect(line.json).toMatchObject({
      method: 'GET',
      route: 'unmatched',
      reason: 'entity_not_permitted',
      correlationId: line.requestId,
    });
  });
});
