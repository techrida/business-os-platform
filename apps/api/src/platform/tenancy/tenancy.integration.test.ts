import 'reflect-metadata';

import type { Server } from 'node:http';

import { ErrorBodySchema, MeResponseSchema } from '@bos/contracts';
import {
  Controller,
  Get,
  Global,
  Module,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
  type INestApplication,
} from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { PgDialect } from 'drizzle-orm/pg-core';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { MeController } from '../../modules/me/me.controller';
import { TelemetryController } from '../../modules/telemetry/telemetry.controller';
import { DB } from '../db/db.module';
import { MetricsService } from '../obs/metrics.service';
import { TenancyModule } from './tenancy.module';

// In-process wiring of the real middleware, interceptor, filter and controllers. Only the things
// outside this unit are faked: the database and the token check.

const TENANT = '11111111-1111-4111-8111-111111111111';
const STAFF_ORG = '22222222-2222-4222-8222-222222222222';

/** Fake `select().from().where().limit()` that knows one org, found through the real WHERE clause. */
const fakeDb = {
  select: () => ({
    from: () => ({
      where: (condition: Parameters<PgDialect['sqlToQuery']>[0]) => ({
        limit: () => {
          const { params } = new PgDialect().sqlToQuery(condition);
          return Promise.resolve(
            params[0] === 'zit-staff'
              ? [{ tenantId: TENANT, organizationId: STAFF_ORG, orgKind: 'staff' }]
              : [],
          );
        },
      }),
    }),
  }),
};

@Global()
@Module({ providers: [{ provide: DB, useValue: fakeDb }], exports: [DB] })
class FakeDbModule {}

/**
 * Plays AuthGuard's role: "Bearer <zitadelOrgId>" gives `req.auth`, anything else is 401. Test
 * scaffolding only (the real guard verifies a JWT); nothing like it exists in src.
 */
class FakeAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context
      .switchToHttp()
      .getRequest<{ headers: Record<string, string>; auth?: unknown }>();
    const match = /^Bearer (.+)$/.exec(req.headers['authorization'] ?? '');
    if (!match) throw new UnauthorizedException('Missing bearer token');
    req.auth = {
      userId: 'user-1',
      zitadelOrgId: match[1],
      roles: ['admin'],
      tokenExp: 1_900_000_000,
    };
    return true;
  }
}

@Controller('v1/boom')
class BoomController {
  @Get()
  boom(): never {
    throw new Error('connection to postgres://bos_app:hunter2@db failed');
  }
}

const observeWebVitalLcp = vi.fn();

describe('tenancy wiring (in-process)', () => {
  let app: INestApplication;
  const http = () => request(app.getHttpServer() as Server);

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [FakeDbModule, TenancyModule],
      controllers: [MeController, TelemetryController, BoomController],
      providers: [
        { provide: APP_GUARD, useClass: FakeAuthGuard },
        { provide: MetricsService, useValue: { observeWebVitalLcp } },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    app.useLogger(false);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /v1/me returns the context and echoes a valid x-request-id', async () => {
    const res = await http()
      .get('/v1/me')
      .set('authorization', 'Bearer zit-staff')
      .set('x-request-id', 'trace-abcdef12')
      .expect(200);

    expect(res.headers['x-request-id']).toBe('trace-abcdef12');
    expect(MeResponseSchema.parse(res.body)).toEqual({
      userId: 'user-1',
      tenantId: TENANT,
      organizationId: STAFF_ORG,
      orgKind: 'staff',
      roles: ['admin'],
      correlationId: 'trace-abcdef12',
    });
  });

  it('replaces an invalid x-request-id and reports the same id in the header and the body', async () => {
    const res = await http()
      .get('/v1/me')
      .set('authorization', 'Bearer zit-staff')
      .set('x-request-id', 'bad id!')
      .expect(200);

    const id = res.headers['x-request-id'];
    expect(id).not.toBe('bad id!');
    expect((res.body as { correlationId: string }).correlationId).toBe(id);
  });

  it('an unknown org is 403 forbidden with an ErrorBodySchema body', async () => {
    const res = await http().get('/v1/me').set('authorization', 'Bearer zit-stranger').expect(403);

    const { error } = ErrorBodySchema.parse(res.body);
    expect(error.code).toBe('forbidden');
    expect(error.correlationId).toBe(res.headers['x-request-id']);
    expect(JSON.stringify(res.body)).not.toContain('zit-stranger');
  });

  it('a guard rejection (no ALS identity yet) is 401 with the correlation id', async () => {
    const res = await http().get('/v1/me').expect(401);

    const { error } = ErrorBodySchema.parse(res.body);
    expect(error.code).toBe('unauthenticated');
    expect(error.correlationId).toBe(res.headers['x-request-id']);
  });

  it('an unrouted path still gets a 404 error body and an id (middleware covers every route)', async () => {
    for (const path of ['/', '/nope', '/deep/unknown/path']) {
      const res = await http().get(path).expect(404);
      const { error } = ErrorBodySchema.parse(res.body);
      expect(error.code).toBe('not_found');
      expect(error.correlationId).toBe(res.headers['x-request-id']);
    }
  });

  it('an unhandled error is a generic 500 with no secret, stack or path', async () => {
    const res = await http().get('/v1/boom').set('authorization', 'Bearer zit-staff').expect(500);

    const { error } = ErrorBodySchema.parse(res.body);
    expect(error).toMatchObject({ code: 'internal', message: 'Internal server error' });
    expect(error.correlationId).toBe(res.headers['x-request-id']);
    const text = JSON.stringify(res.body);
    expect(text).not.toContain('hunter2');
    expect(text).not.toContain('.ts');
  });

  it('POST /v1/telemetry/vitals answers 202 and records LCP for an allowed route', async () => {
    observeWebVitalLcp.mockClear();

    await http()
      .post('/v1/telemetry/vitals')
      .set('authorization', 'Bearer zit-staff')
      .send({ name: 'LCP', value: 900, route: '/staff-only', id: 'v5-1' })
      .expect(202);
    await http()
      .post('/v1/telemetry/vitals')
      .set('authorization', 'Bearer zit-staff')
      .send({ name: 'LCP', value: 2000, route: '/secret/42', id: 'v5-2' })
      .expect(202);

    expect(observeWebVitalLcp.mock.calls).toEqual([
      ['workspace', '/staff-only', 0.9],
      ['workspace', 'other', 2],
    ]);
  });

  it('POST /v1/telemetry/vitals rejects a body over 2048 bytes with a 413 error body', async () => {
    const res = await http()
      .post('/v1/telemetry/vitals')
      .set('authorization', 'Bearer zit-staff')
      .send({ name: 'LCP', value: 900, route: '/', id: 'x'.repeat(3000) })
      .expect(413);

    expect(ErrorBodySchema.parse(res.body).error.code).toBe('payload_too_large');
  });

  it('POST /v1/telemetry/vitals rejects an invalid sample with 400', async () => {
    const res = await http()
      .post('/v1/telemetry/vitals')
      .set('authorization', 'Bearer zit-staff')
      .send({ name: 'LCP', value: -5, route: '/', id: 'v5-3' })
      .expect(400);

    expect(ErrorBodySchema.parse(res.body).error.code).toBe('bad_request');
  });
});
