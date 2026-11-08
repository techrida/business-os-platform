// Boot-time route-policy sweep (review finding D33). Authorization is deny-by-default: an
// undecorated route boots fine and then answers 403 to everyone, which hides the mistake until
// someone calls it. This check turns the mistake into a failed boot instead.
//
// Every route handler must carry @Can, @AnyAuthenticated or @Public, on the method or on its
// controller class. The e2e route sweep checks the same thing against a live app, but it needs
// containers; this one runs in every process that boots `main.ts`.
import 'reflect-metadata';

import { RequestMethod, type INestApplicationContext } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { DiscoveryService, MetadataScanner, ModulesContainer, Reflector } from '@nestjs/core';

import { IS_PUBLIC_KEY } from '../auth/public.decorator';
import { ANY_AUTHENTICATED_KEY, CAN_KEY } from './decorators';

const asArray = (value: unknown): string[] =>
  Array.isArray(value) ? value.map(String) : typeof value === 'string' ? [value] : [''];

const join = (a: string, b: string): string =>
  '/' +
  [a, b]
    .flatMap((part) => part.split('/'))
    .filter((part) => part.length > 0)
    .join('/');

/**
 * Returns one line per route handler that has none of the three markers, for example
 * `GET /open (OpenController.list)`. Empty when every route is marked.
 *
 * The services are built from the app's own `ModulesContainer` rather than injected, so AppModule
 * does not have to import DiscoveryModule just for this check.
 */
export function findUnmarkedRoutes(app: INestApplicationContext): string[] {
  const discovery = new DiscoveryService(app.get(ModulesContainer, { strict: false }));
  const scanner = new MetadataScanner();
  const reflector = new Reflector();
  // Keyed by line: a controller declared by two modules is listed twice by Nest.
  const offenders = new Set<string>();

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

      // Method metadata wins over class metadata, read the same way the guard and interceptor do.
      const targets = [handler, controller];
      const read = (key: string): unknown => reflector.getAllAndOverride<unknown>(key, targets);
      const marked =
        read(IS_PUBLIC_KEY) === true ||
        read(CAN_KEY) !== undefined ||
        read(ANY_AUTHENTICATED_KEY) === true;
      if (marked) continue;

      const verb = RequestMethod[method] ?? String(method);
      for (const base of controllerPaths) {
        for (const sub of asArray(Reflect.getMetadata(PATH_METADATA, handler))) {
          offenders.add(`${verb} ${join(base, sub)} (${controller.name}.${name})`);
        }
      }
    }
  }
  return [...offenders];
}

/** Throws one error listing every route that lacks @Can, @AnyAuthenticated or @Public. */
export function assertRoutePolicy(app: INestApplicationContext): void {
  const offenders = findUnmarkedRoutes(app);
  if (offenders.length === 0) return;
  throw new Error(
    `Route policy: ${offenders.length} route(s) carry none of @Can, @AnyAuthenticated or @Public, ` +
      `so they would answer 403 to everyone:\n  ${offenders.join('\n  ')}`,
  );
}
