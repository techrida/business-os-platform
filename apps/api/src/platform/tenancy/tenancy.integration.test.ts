import 'reflect-metadata';

import type { Server } from 'node:http';

import { ErrorBodySchema, MeResponseSchema } from '@bos/contracts';
import { organizations } from '@bos/db';
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
import { AnyAuthenticated } from '../authz/decorators';
import { RoleCache } from '../authz/role-cache';
import { type ResolvedUser, UserDirectory } from '../authz/user-directory';
import { DB } from '../db/db.module';
import { MetricsService } from '../obs/metrics.service';
import { TenancyModule } from './tenancy.module';

// In-process wiring of the real middleware, interceptor, filter and controllers. Only the things
// outside this unit are faked: the database, the token check, the user directory and the role table.

const TENANT = '11111111-1111-4111-8111-111111111111';
const STAFF_ORG = '22222222-2222-4222-8222-222222222222';
const APP_USER_ID = '33333333-3333-4333-8333-333333333333';

const STAFF_IDP_ORG = '99999999-9999-4999-8999-999999999999';

/**
 * Fake of the resolver's two queries, each found through the real WHERE clause: the IdP org by
 * `select().from(idpOrgs).where().limit()` (one staff org is known), then the tenant's entities by
 * `select().from(organizations).where()` (STAFF_ORG is the one, default, entity).
 */
const fakeDb = {
  select: () => ({
    from: (table: unknown) => ({
      where: (condition: Parameters<PgDialect['sqlToQuery']>[0]) => {
        const { params } = new PgDialect().sqlToQuery(condition);
        if (table === organizations) {
          return Promise.resolve(params[0] === TENANT ? [{ id: STAFF_ORG, isDefault: true }] : []);
        }
        return {
          limit: () =>
            Promise.resolve(
              params[0] === 'zit-staff'
                ? [{ idpOrgId: STAFF_IDP_ORG, tenantId: TENANT, kind: 'staff', partyId: null }]
                : [],
            ),
        };
      },
    }),
  }),
};

@Global()
@Module({ providers: [{ provide: DB, useValue: fakeDb }], exports: [DB] })
class FakeDbModule {}

/** Stands in for the global UsersModule and AuthzModule, which provide these two in the app. */
@Global()
@Module({
  providers: [
    {
      provide: UserDirectory,
      useValue: {
        // Echoes the scope it is asked for: the user row lives in the token's tenant with one
        // default membership in the default entity, as the real JIT insert would place it.
        resolve: (i: { tenantId: string; idpOrgId: string }): Promise<ResolvedUser> =>
          Promise.resolve({
            userId: APP_USER_ID,
            status: 'active',
            tenantId: i.tenantId,
            idpOrgId: i.idpOrgId,
            memberships: [
              {
                organizationId: STAFF_ORG,
                isDefault: true,
                roleKeys: null,
                departmentId: null,
              },
            ],
          }),
      },
    },
    { provide: RoleCache, useValue: { grantsFor: () => Promise.resolve(new Map()) } },
  ],
  exports: [UserDirectory, RoleCache],
})
class FakeAuthzPortsModule {}

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
    const zitadelOrgId = match[1] ?? '';
    req.auth = {
      userId: 'user-1',
      zitadelOrgId,
      // The union lists a role from another org; only the caller's own org counts (finding 4).
      roles: ['finance', 'founder'],
      rolesByOrg: { [zitadelOrgId]: ['founder'], 'zit-elsewhere': ['finance'] },
      tokenExp: 1_900_000_000,
    };
    return true;
  }
}

@Controller('v1/boom')
@AnyAuthenticated()
class BoomController {
  @Get()
  boom(): never {
    throw new Error('connection to postgres://bos_app:hunter2@db failed');
  }
}

/** A protected route nobody marked: the interceptor must refuse it. */
@Controller('v1/unmarked')
class UnmarkedController {
  @Get()
  get(): { ok: true } {
    return { ok: true };
  }
}

const observeWebVitalLcp = vi.fn();

describe('tenancy wiring (in-process)', () => {
  let app: INestApplication;
  const http = () => request(app.getHttpServer() as Server);

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [FakeDbModule, FakeAuthzPortsModule, TenancyModule],
      controllers: [MeController, TelemetryController, BoomController, UnmarkedController],
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
      partyId: null,
      roles: ['founder'],
      correlationId: 'trace-abcdef12',
      // The stub RoleCache grants nothing, so the effective grants are empty.
      permissions: [],
    });
  });

  it('a protected route with no marker is 403 no_permission through the real filter', async () => {
    const res = await http()
      .get('/v1/unmarked')
      .set('authorization', 'Bearer zit-staff')
      .expect(403);

    const { error } = ErrorBodySchema.parse(res.body);
    expect(error).toMatchObject({ code: 'forbidden', reason: 'no_permission' });
    expect(error.correlationId).toBe(res.headers['x-request-id']);
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
