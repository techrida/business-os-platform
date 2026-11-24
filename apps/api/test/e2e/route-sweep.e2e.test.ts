// Walks every route Nest registered (not a hand-kept list) and proves that 100% of them fail closed.
// Serves the NFR "authorization is deny-by-default" (P1 plan §1, §7 U1, finding 7):
// - exactly six routes are public: five authenticate themselves (HMAC, signed link), and GET /v1/public/logo/:tenantId
//   is the one deliberate anonymous read (the company logo, nothing else);
// - every other route carries @Can or @AnyAuthenticated, so none relies on the interceptor's default;
// - no token is 401 everywhere; a staff token with no role, a customer token holding staff role
//   names, and a role granted only in another org are all 403 on every @Can route.
// A new controller that forgets its marker, or a stray @Public(), fails here.
import 'reflect-metadata';

import { createHmac } from 'node:crypto';

import { ErrorBodySchema } from '@bos/contracts';
import { Module, RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { DiscoveryModule, DiscoveryService, MetadataScanner, Reflector } from '@nestjs/core';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { IS_PUBLIC_KEY } from '../../src/platform/auth/public.decorator';
import { ANY_AUTHENTICATED_KEY, CAN_KEY } from '../../src/platform/authz/decorators';
import { CLIENT_ID, PROJECT_ID, startApp, type TestApp } from './support/app';
import { zitadelClaims } from './support/test-issuer';

// Without a configured key the webhook answers 401 to everything, which would make its 401 tests
// prove nothing. With one, a bad signature is refused by the HMAC check itself. AppModule is
// imported inside startApp(), after this line, so the config sees it.
const SIGNING_KEY = 'e2e-route-sweep-signing-key';
process.env.ZITADEL_ACTIONS_SIGNING_KEY = SIGNING_KEY;

const e2e = inject('e2e');

/** `public`: @Public. `can`: @Can (wins over @AnyAuthenticated, as in the interceptor). `none`: a bug. */
type RouteKind = 'public' | 'can' | 'any' | 'none';

interface RouteInfo {
  method: string;
  /** Path with a leading slash and `:param` segments filled in so it can be requested. */
  path: string;
  /** The template, for messages and for the public-route comparison. */
  template: string;
  kind: RouteKind;
}

const EXPECTED_PUBLIC = [
  'GET /health/live',
  'GET /health/ready',
  'GET /v1/files/:token',
  'GET /v1/public/logo/:tenantId',
  'POST /v1/hooks/postal',
  'POST /v1/hooks/zitadel',
];

/** Staff role names (every ROLE_KEY except the portal roles). */
const STAFF_ROLES = ['founder', 'management', 'finance', 'accountant', 'sales'];

/** A valid v4 uuid, so a `ParseUUIDPipe` would accept it if a request ever got that far. */
const DUMMY_ID = '00000000-0000-4000-8000-000000000001';

const asArray = (value: unknown): string[] =>
  Array.isArray(value) ? value.map(String) : typeof value === 'string' ? [value] : [''];

const join = (a: string, b: string): string =>
  '/' +
  [a, b]
    .flatMap((part) => part.split('/'))
    .filter((part) => part.length > 0)
    .join('/');

const label = (r: RouteInfo): string => `${r.method} ${r.template}`;

let t: TestApp;
let routes: RouteInfo[];

function listRoutes(): RouteInfo[] {
  const discovery = t.app.get(DiscoveryService);
  const scanner = t.app.get(MetadataScanner);
  const reflector = t.app.get(Reflector);
  // Keyed by "METHOD template": a controller declared by two modules is listed twice by Nest.
  const found = new Map<string, RouteInfo>();

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
      // Method metadata overrides class metadata, read the same way the guard and interceptor do.
      const targets = [handler, controller];
      const meta = (key: string): unknown => reflector.getAllAndOverride<unknown>(key, targets);
      const kind: RouteKind =
        meta(IS_PUBLIC_KEY) === true
          ? 'public'
          : meta(CAN_KEY) !== undefined
            ? 'can'
            : meta(ANY_AUTHENTICATED_KEY) === true
              ? 'any'
              : 'none';

      for (const base of controllerPaths) {
        for (const sub of asArray(Reflect.getMetadata(PATH_METADATA, handler))) {
          const template = join(base, sub);
          const route: RouteInfo = {
            method: RequestMethod[method] ?? String(method),
            template,
            path: template.replace(/:[^/]+/g, DUMMY_ID),
            kind,
          };
          found.set(label(route), route);
        }
      }
    }
  }
  return [...found.values()];
}

function send(route: RouteInfo, authorization?: string) {
  const http = t.http();
  const req =
    route.method === 'GET'
      ? http.get(route.path)
      : route.method === 'POST'
        ? http.post(route.path).send({})
        : route.method === 'PUT'
          ? http.put(route.path).send({})
          : route.method === 'PATCH'
            ? http.patch(route.path).send({})
            : route.method === 'DELETE'
              ? http.delete(route.path)
              : undefined;
  if (req === undefined)
    throw new Error(`route sweep cannot send ${route.method} yet; extend send()`);
  return authorization === undefined ? req : req.set('authorization', authorization);
}

interface Mismatch {
  route: string;
  status: number;
  code: string | undefined;
  reason: string | undefined;
}

/**
 * Sends one request per route and returns every route that did not answer `status` with an
 * ErrorBody of `code` (and, when given, the 403 `reason`). Collects instead of failing on the
 * first, so one run lists them all.
 */
async function sweep(
  targets: readonly RouteInfo[],
  status: number,
  code: string,
  authorization?: string,
  expectedReason?: string,
): Promise<{ sent: number; mismatches: Mismatch[] }> {
  let sent = 0;
  const mismatches: Mismatch[] = [];
  for (const route of targets) {
    const res = await send(route, authorization);
    sent += 1;
    const body = ErrorBodySchema.safeParse(res.body);
    const error = body.success ? body.data.error : undefined;
    const raw = (res.body as { error?: { reason?: unknown } } | undefined)?.error?.reason;
    const reason = typeof raw === 'string' ? raw : undefined;
    if (
      res.status !== status ||
      error?.code !== code ||
      (expectedReason !== undefined && reason !== expectedReason)
    ) {
      mismatches.push({ route: label(route), status: res.status, code: error?.code, reason });
    }
  }
  return { sent, mismatches };
}

const bearer = (token: string): string => `Bearer ${token}`;

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

const nonPublic = (): RouteInfo[] => routes.filter((r) => r.kind !== 'public');
const canRoutes = (): RouteInfo[] => routes.filter((r) => r.kind === 'can');

describe('route sweep: discovery and markers', () => {
  it('finds the routes (guards against a scan that silently returns nothing)', () => {
    expect(routes.map(label)).toEqual(
      expect.arrayContaining([...EXPECTED_PUBLIC, 'GET /v1/me', 'POST /v1/telemetry/vitals']),
    );
  });

  it('exposes exactly the six public routes (five self-authenticating, plus the anonymous logo)', () => {
    const open = routes
      .filter((r) => r.kind === 'public')
      .map(label)
      .sort();
    expect(open).toEqual(EXPECTED_PUBLIC);
  });

  it('marks every non-public route with @Can or @AnyAuthenticated', () => {
    const counts = { public: 0, can: 0, any: 0, none: 0 };
    for (const r of routes) counts[r.kind] += 1;
    console.log(
      `route sweep: ${routes.length} routes: ${counts.public} public, ${counts.can} @Can, ` +
        `${counts.any} @AnyAuthenticated, ${counts.none} unmarked`,
    );
    expect(
      routes.filter((r) => r.kind === 'none').map(label),
      'routes with neither @Can nor @AnyAuthenticated',
    ).toEqual([]);
    expect(counts.can).toBeGreaterThan(0);
  });
});

describe('route sweep: every non-public route fails closed', () => {
  it('answers 401 unauthenticated on every non-public route when no token is sent', async () => {
    const targets = nonPublic();
    const { sent, mismatches } = await sweep(targets, 401, 'unauthenticated');
    console.log(`route sweep (no token): exercised ${sent}/${targets.length} routes`);
    expect(mismatches).toEqual([]);
    expect(sent).toBe(targets.length);
  }, 90_000);

  it('answers 401 on every non-public route for a token that is not a valid JWT', async () => {
    const targets = nonPublic();
    const { mismatches } = await sweep(
      targets,
      401,
      'unauthenticated',
      'Bearer garbage.garbage.garbage',
    );
    expect(mismatches).toEqual([]);
  }, 90_000);

  it('answers 403 forbidden on every @Can route for a staff token with no role', async () => {
    const token = await t.token(e2e.staff, { userId: 'user-sweep-staff-no-role', roles: [] });
    const targets = canRoutes();
    // `no_permission` pins the cause: an org-resolve 403 has no reason, so it cannot pass this.
    const { sent, mismatches } = await sweep(
      targets,
      403,
      'forbidden',
      bearer(token),
      'no_permission',
    );
    console.log(`route sweep (zero-role staff): exercised ${sent}/${targets.length} @Can routes`);
    expect(mismatches).toEqual([]);
  }, 90_000);

  it('answers 403 forbidden on every @Can route for a customer token holding staff role names', async () => {
    // No P1 permission is granted to a customer org, whatever the role is called.
    const token = await t.token(e2e.customer, {
      userId: 'user-sweep-customer-staff-roles',
      roles: STAFF_ROLES,
    });
    const targets = canRoutes();
    const { sent, mismatches } = await sweep(targets, 403, 'forbidden', bearer(token));
    console.log(
      `route sweep (customer with staff roles): exercised ${sent}/${targets.length} @Can routes`,
    );
    expect(mismatches).toEqual([]);
  }, 90_000);

  it('answers 403 forbidden on every @Can route for a staff user whose roles are granted only in another org', async () => {
    // Finding 4: `founder` granted in the customer org must not count in the staff org.
    const token = await t.issuer.mint(
      zitadelClaims({
        projectId: PROJECT_ID,
        clientId: CLIENT_ID,
        userId: 'user-sweep-staff-cross-org',
        orgId: e2e.staff.zitadelOrgId,
        roles: [],
        rolesInOtherOrgs: { [e2e.customer.zitadelOrgId]: STAFF_ROLES },
      }),
    );
    const { mismatches } = await sweep(
      canRoutes(),
      403,
      'forbidden',
      bearer(token),
      'no_permission',
    );
    expect(mismatches).toEqual([]);
  }, 90_000);
});

describe('route sweep: the public routes authenticate themselves', () => {
  const hookBody = JSON.stringify({
    instanceID: 'instance-e2e',
    aggregateID: 'org-e2e-sweep',
    aggregateType: 'org',
    sequence: 1,
    event_type: 'org.changed',
  });
  const sign = (timestamp: number, body: string, key = SIGNING_KEY): string =>
    `t=${timestamp},v1=${createHmac('sha256', key).update(`${timestamp}.${body}`).digest('hex')}`;
  const now = (): number => Math.floor(Date.now() / 1000);
  const postHook = (signature?: string) => {
    const req = t.http().post('/v1/hooks/zitadel').set('content-type', 'application/json');
    return (signature === undefined ? req : req.set('zitadel-signature', signature)).send(hookBody);
  };

  // Each header is built at request time, so the timestamp is fresh unless the case says otherwise.
  const badSignatures: [string, () => string | undefined][] = [
    ['no ZITADEL-Signature header', () => undefined],
    ['a malformed header', () => 'not-a-signature'],
    ['a well-formed header with the wrong HMAC', () => `t=${now()},v1=${'0'.repeat(64)}`],
    ['a header signed with another key', () => sign(now(), hookBody, 'not-the-signing-key')],
    ['a correct HMAC older than the 300 s tolerance', () => sign(now() - 3600, hookBody)],
  ];

  it.each(badSignatures)('POST /v1/hooks/zitadel answers 401 with %s', async (_name, header) => {
    const res = await postHook(header());
    expect(res.status, JSON.stringify(res.body)).toBe(401);
    expect(ErrorBodySchema.parse(res.body).error.code).toBe('unauthenticated');
  });

  it('POST /v1/hooks/zitadel accepts a correctly signed call (so the 401s above come from the HMAC check)', async () => {
    const res = await postHook(sign(now(), hookBody));
    expect(res.status, JSON.stringify(res.body)).toBe(204);
  });

  it('POST /v1/hooks/postal answers 401 with no secret configured or no signature (fails closed)', async () => {
    const res = await t
      .http()
      .post('/v1/hooks/postal')
      .set('content-type', 'application/json')
      .send({ event: 'MessageDeliveryFailed' });
    expect(res.status, JSON.stringify(res.body)).toBe(401);
    expect(ErrorBodySchema.parse(res.body).error.code).toBe('unauthenticated');
  });

  it('GET /v1/files/<garbage> answers 401 unauthenticated', async () => {
    const res = await t.http().get('/v1/files/garbage-not-a-signed-link');
    expect(res.status, JSON.stringify(res.body)).toBe(401);
    expect(ErrorBodySchema.parse(res.body).error.code).toBe('unauthenticated');
  });
});
