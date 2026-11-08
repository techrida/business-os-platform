// Walks every route Nest registered (not a hand-kept list) and checks the security posture:
// everything needs a token except exactly the two health probes. A new controller that forgets
// its guard, or a stray @Public(), fails here.
import 'reflect-metadata';

import { ErrorBodySchema } from '@bos/contracts';
import { Module, RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { DiscoveryModule, DiscoveryService, MetadataScanner, Reflector } from '@nestjs/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { IS_PUBLIC_KEY } from '../../src/platform/auth/public.decorator';
import { startApp, type TestApp } from './support/app';

interface RouteInfo {
  method: string;
  /** Path with a leading slash and `:param` segments filled in so it can be requested. */
  path: string;
  /** The template, for messages and for the public-route comparison. */
  template: string;
  isPublic: boolean;
}

const asArray = (value: unknown): string[] =>
  Array.isArray(value) ? value.map(String) : typeof value === 'string' ? [value] : [''];

const join = (a: string, b: string): string =>
  '/' +
  [a, b]
    .flatMap((part) => part.split('/'))
    .filter((part) => part.length > 0)
    .join('/');

let t: TestApp;
let routes: RouteInfo[];

function listRoutes(): RouteInfo[] {
  const discovery = t.app.get(DiscoveryService);
  const scanner = t.app.get(MetadataScanner);
  const reflector = t.app.get(Reflector);
  const found: RouteInfo[] = [];

  for (const wrapper of discovery.getControllers()) {
    const controller = wrapper.metatype;
    if (typeof controller !== 'function') continue;
    const prototype = controller.prototype as Record<string, unknown>;
    const controllerPaths = asArray(Reflect.getMetadata(PATH_METADATA, controller));

    for (const name of scanner.getAllMethodNames(prototype)) {
      const handler = prototype[name];
      if (typeof handler !== 'function') continue;
      const method = Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod | undefined;
      if (method === undefined) continue; // not a route handler
      const isPublic =
        reflector.getAllAndOverride<boolean | undefined>(IS_PUBLIC_KEY, [handler, controller]) ===
        true;

      for (const base of controllerPaths) {
        for (const sub of asArray(Reflect.getMetadata(PATH_METADATA, handler))) {
          const template = join(base, sub);
          found.push({
            method: RequestMethod[method] ?? String(method),
            template,
            path: template.replace(/:[^/]+/g, 'sample'),
            isPublic,
          });
        }
      }
    }
  }
  return found;
}

function send(app: TestApp, route: RouteInfo, authorization?: string) {
  const http = app.http();
  const req =
    route.method === 'GET'
      ? http.get(route.path)
      : route.method === 'POST'
        ? http.post(route.path)
        : route.method === 'PUT'
          ? http.put(route.path)
          : route.method === 'PATCH'
            ? http.patch(route.path)
            : route.method === 'DELETE'
              ? http.delete(route.path)
              : undefined;
  if (req === undefined)
    throw new Error(`route sweep cannot send ${route.method} yet; extend send()`);
  return authorization === undefined ? req : req.set('authorization', authorization);
}

beforeAll(async () => {
  // DiscoveryService lives in DiscoveryModule, which AppModule does not import: wrap it.
  t = await startApp({
    wrapRoot: (appModule) => {
      class SweepRoot {}
      Module({ imports: [appModule, DiscoveryModule] })(SweepRoot);
      return SweepRoot;
    },
  });
  routes = listRoutes();
});

afterAll(async () => {
  await t?.close();
});

describe('route sweep', () => {
  it('finds the routes (guards against a scan that silently returns nothing)', () => {
    const all = routes.map((r) => `${r.method} ${r.template}`);
    expect(all).toEqual(
      expect.arrayContaining([
        'GET /health/live',
        'GET /health/ready',
        'GET /v1/me',
        'POST /v1/telemetry/vitals',
      ]),
    );
  });

  it('exposes exactly GET /health/live and GET /health/ready without a token', () => {
    const open = routes
      .filter((r) => r.isPublic)
      .map((r) => `${r.method} ${r.template}`)
      .sort();
    expect(open).toEqual(['GET /health/live', 'GET /health/ready']);
  });

  it('answers 401 with an ErrorBody on every protected route when no token is sent', async () => {
    const protectedRoutes = routes.filter((r) => !r.isPublic);
    expect(protectedRoutes.length).toBeGreaterThanOrEqual(2);

    for (const route of protectedRoutes) {
      const res = await send(t, route);
      const label = `${route.method} ${route.template}`;
      expect(res.status, label).toBe(401);
      const body = ErrorBodySchema.safeParse(res.body);
      expect(body.success, `${label}: body is an ErrorBody`).toBe(true);
      expect(body.data?.error.code, label).toBe('unauthenticated');
    }
  });

  it('answers 401 on every protected route for a token that is not a valid JWT', async () => {
    for (const route of routes.filter((r) => !r.isPublic)) {
      const res = await send(t, route, 'Bearer garbage.garbage.garbage');
      expect(res.status, `${route.method} ${route.template}`).toBe(401);
    }
  });
});
