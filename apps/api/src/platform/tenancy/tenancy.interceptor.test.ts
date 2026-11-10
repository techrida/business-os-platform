import 'reflect-metadata';

import type { Server } from 'node:http';

import { ErrorBodySchema, MeResponseSchema } from '@bos/contracts';
import {
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
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { MeController } from '../../modules/me/me.controller';
import { DB } from '../db/db.module';
import { TenancyModule } from './tenancy.module';

// CR-02: a staff principal must hold at least one project role. Org kind alone is not enough,
// because anyone who can register into the staff org would otherwise get in. Runs through the
// real interceptor and exception filter so the 403 body shape is checked too.

const TENANT = '11111111-1111-4111-8111-111111111111';
const ORGS: Record<string, { organizationId: string; orgKind: 'staff' | 'customer' | 'vendor' }> = {
  'zit-staff': { organizationId: '22222222-2222-4222-8222-222222222222', orgKind: 'staff' },
  'zit-customer': { organizationId: '33333333-3333-4333-8333-333333333333', orgKind: 'customer' },
  'zit-vendor': { organizationId: '44444444-4444-4444-8444-444444444444', orgKind: 'vendor' },
};

/** Fake `select().from().where().limit()` that knows three orgs, found through the real WHERE clause. */
const fakeDb = {
  select: () => ({
    from: () => ({
      where: (condition: Parameters<PgDialect['sqlToQuery']>[0]) => ({
        limit: () => {
          const { params } = new PgDialect().sqlToQuery(condition);
          const org = ORGS[params[0] as string];
          return Promise.resolve(org ? [{ tenantId: TENANT, ...org }] : []);
        },
      }),
    }),
  }),
};

@Global()
@Module({ providers: [{ provide: DB, useValue: fakeDb }], exports: [DB] })
class FakeDbModule {}

/**
 * Plays AuthGuard's role: "Bearer <zitadelOrgId>:<role,role|none>" gives `req.auth` with those
 * roles. Test scaffolding only (the real guard verifies a JWT).
 */
class FakeAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context
      .switchToHttp()
      .getRequest<{ headers: Record<string, string>; auth?: unknown }>();
    const match = /^Bearer ([^:]+):(.+)$/.exec(req.headers['authorization'] ?? '');
    const zitadelOrgId = match?.[1];
    const roleList = match?.[2];
    if (zitadelOrgId === undefined || roleList === undefined) {
      throw new UnauthorizedException('Missing bearer token');
    }
    req.auth = {
      userId: 'user-1',
      zitadelOrgId,
      roles: roleList === 'none' ? [] : roleList.split(','),
      tokenExp: 1_900_000_000,
    };
    return true;
  }
}

describe('TenancyInterceptor: staff need a project role (CR-02)', () => {
  let app: INestApplication;
  const me = (token: string) =>
    request(app.getHttpServer() as Server)
      .get('/v1/me')
      .set('authorization', `Bearer ${token}`);

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [FakeDbModule, TenancyModule],
      controllers: [MeController],
      providers: [{ provide: APP_GUARD, useClass: FakeAuthGuard }],
    }).compile();
    app = moduleRef.createNestApplication();
    app.useLogger(false);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('refuses a staff principal with no roles: 403 forbidden in the shared error body', async () => {
    const res = await me('zit-staff:none').expect(403);

    const { error } = ErrorBodySchema.parse(res.body);
    expect(error.code).toBe('forbidden');
    expect(error.correlationId).toBe(res.headers['x-request-id']);
    // The caller learns nothing about the org it landed in.
    const text = JSON.stringify(res.body);
    expect(text).not.toContain(TENANT);
    const staffOrg = ORGS['zit-staff'];
    if (!staffOrg) throw new Error('fixture: zit-staff org missing');
    expect(text).not.toContain(staffOrg.organizationId);
  });

  it('lets a staff principal with a role through', async () => {
    const res = await me('zit-staff:admin').expect(200);
    expect(MeResponseSchema.parse(res.body)).toMatchObject({ orgKind: 'staff', roles: ['admin'] });
  });

  it('lets customer and vendor principals with no roles through, as before', async () => {
    const customer = await me('zit-customer:none').expect(200);
    expect(MeResponseSchema.parse(customer.body)).toMatchObject({ orgKind: 'customer', roles: [] });

    const vendor = await me('zit-vendor:none').expect(200);
    expect(MeResponseSchema.parse(vendor.body)).toMatchObject({ orgKind: 'vendor', roles: [] });
  });
});
