import 'reflect-metadata';

import { Controller, Get, Post } from '@nestjs/common';
import { DiscoveryService, ModulesContainer } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';

import { Public } from '../auth/public.decorator';
import { AnyAuthenticated, Can } from './decorators';
import { assertRoutePolicy, findUnmarkedRoutes } from './route-policy.check';

@Controller('open')
class UndecoratedController {
  @Get()
  list(): string[] {
    return [];
  }
}

@Controller('marked')
class MarkedController {
  @Get('can')
  @Can('memo.read')
  withCan(): void {}

  @Get('any')
  @AnyAuthenticated()
  withAny(): void {}

  @Get('public')
  @Public()
  withPublic(): void {}

  // Not a route handler: no verb decorator, so it needs no marker.
  helper(): void {}
}

@Controller('class-level')
@Can('memo.read')
class ClassMarkedController {
  @Get()
  list(): void {}

  @Post()
  create(): void {}
}

@Controller('half')
class HalfMarkedController {
  @Get('ok')
  @AnyAuthenticated()
  ok(): void {}

  @Post('forgot')
  forgot(): void {}
}

async function moduleWith(...controllers: (new () => unknown)[]) {
  return Test.createTestingModule({ controllers }).compile();
}

describe('route policy sweep (D33)', () => {
  it('throws, naming the route, when a controller has no marker', async () => {
    const moduleRef = await moduleWith(UndecoratedController);
    expect(() => assertRoutePolicy(moduleRef)).toThrow(/GET \/open/);
    expect(() => assertRoutePolicy(moduleRef)).toThrow(/UndecoratedController\.list/);
    await moduleRef.close();
  });

  it('passes when every handler carries @Can, @AnyAuthenticated or @Public', async () => {
    const moduleRef = await moduleWith(MarkedController);
    expect(() => assertRoutePolicy(moduleRef)).not.toThrow();
    await moduleRef.close();
  });

  it('accepts a class-level marker for every handler of the class', async () => {
    const moduleRef = await moduleWith(ClassMarkedController);
    expect(() => assertRoutePolicy(moduleRef)).not.toThrow();
    await moduleRef.close();
  });

  it('lists every offender at once, and only the unmarked handlers', async () => {
    const moduleRef = await moduleWith(HalfMarkedController, UndecoratedController);
    expect(findUnmarkedRoutes(moduleRef).sort()).toEqual([
      'GET /open (UndecoratedController.list)',
      'POST /half/forgot (HalfMarkedController.forgot)',
    ]);
    const error = (() => {
      try {
        assertRoutePolicy(moduleRef);
      } catch (e) {
        return e as Error;
      }
      return undefined;
    })();
    expect(error?.message).toContain('POST /half/forgot');
    expect(error?.message).toContain('GET /open');
    expect(error?.message).not.toContain('GET /half/ok');
    await moduleRef.close();
  });
});

describe('route policy sweep on the real AppModule', () => {
  it('finds no unmarked route in the controllers AppModule registers', async () => {
    // ConfigModule.forRoot() reads process.env when app.module is evaluated, so set it first.
    // The URLs point nowhere: compile() builds providers but never calls init(), so no JWKS warm-up
    // runs and the lazy pg pool opens no connection.
    Object.assign(process.env, {
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      DATABASE_URL: 'postgres://nobody:nothing@127.0.0.1:1/none',
      VALKEY_URL: 'redis://127.0.0.1:1',
      OIDC_ISSUER: 'http://127.0.0.1:1',
      OIDC_AUDIENCE: 'route-policy-check',
      OIDC_CLIENT_ID: 'route-policy-client',
    });
    const { AppModule } = await import('../../app.module');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    try {
      // The count guards against a scan that silently finds no controllers.
      const discovery = new DiscoveryService(moduleRef.get(ModulesContainer, { strict: false }));
      expect(discovery.getControllers().length).toBeGreaterThan(5);
      expect(findUnmarkedRoutes(moduleRef)).toEqual([]);
      expect(() => assertRoutePolicy(moduleRef)).not.toThrow();
    } finally {
      await moduleRef.close();
    }
  }, 60_000);
});
