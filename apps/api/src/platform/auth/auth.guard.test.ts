import {
  Controller,
  type ExecutionContext,
  Get,
  HttpException,
  type INestApplication,
  Logger,
  Req,
} from '@nestjs/common';
import { APP_GUARD, Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import {
  type CryptoKey,
  exportJWK,
  exportSPKI,
  generateKeyPair,
  type JWK,
  type JWTPayload,
  SignJWT,
} from 'jose';
import request from 'supertest';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { AuthGuard } from './auth.guard';
import {
  type AuthenticatedRequest,
  ORG_ID_CLAIM,
  PROJECT_ROLES_CLAIM,
  projectRolesClaim,
} from './claims';
import { AUTH_OPTIONS, type AuthOptions, JwtVerifier } from './jwt-verifier';
import { Public } from './public.decorator';

const ISSUER = 'https://auth.test.local';
const AUDIENCE = '300000000000000001';
const DISCOVERY_URL = `${ISSUER}/.well-known/openid-configuration`;
const JWKS_URI = `${ISSUER}/oauth/v2/keys`;
const KID = 'trusted-key';
const OPTIONS: AuthOptions = {
  issuer: ISSUER,
  audience: AUDIENCE,
  allowedAzp: ['web-client'],
  warmupDelaysMs: [1],
};
const UNAUTHENTICATED = 'Missing or invalid bearer token';

let trusted: { privateKey: CryptoKey; publicKey: CryptoKey };
let attacker: { privateKey: CryptoKey; publicKey: CryptoKey };
let trustedJwk: JWK;

beforeAll(async () => {
  Logger.overrideLogger(false);
  trusted = await generateKeyPair('RS256');
  attacker = await generateKeyPair('RS256');
  trustedJwk = { ...(await exportJWK(trusted.publicKey)), kid: KID, alg: 'RS256', use: 'sig' };
});

afterEach(() => {
  vi.unstubAllGlobals();
});

type FetchInput = Parameters<typeof fetch>[0];
const urlOf = (input: FetchInput): string =>
  typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

/** A fake ZITADEL: discovery plus JWKS, served through a stubbed global fetch. */
function stubIdp(mode: 'up' | 'discovery-down' | 'jwks-down' = 'up') {
  const fetchMock = vi.fn((input: FetchInput): Promise<Response> => {
    const url = urlOf(input);
    if (url === DISCOVERY_URL) {
      return mode === 'discovery-down'
        ? Promise.reject(new TypeError('fetch failed'))
        : Promise.resolve(Response.json({ issuer: ISSUER, jwks_uri: JWKS_URI }));
    }
    if (url === JWKS_URI) {
      return mode === 'jwks-down'
        ? Promise.resolve(new Response('error', { status: 500 }))
        : Promise.resolve(Response.json({ keys: [trustedJwk] }));
    }
    return Promise.resolve(new Response('not found', { status: 404 }));
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const now = (): number => Math.floor(Date.now() / 1000);

const claims = (extra: JWTPayload = {}): JWTPayload => ({
  iss: ISSUER,
  aud: AUDIENCE,
  azp: 'web-client',
  sub: 'user-1',
  iat: now(),
  exp: now() + 300,
  [ORG_ID_CLAIM]: 'org-1',
  ...extra,
});

const sign = (payload: JWTPayload, key: CryptoKey = trusted.privateKey): Promise<string> =>
  new SignJWT(payload).setProtectedHeader({ alg: 'RS256', kid: KID }).sign(key);

const b64url = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');

class Routes {
  @Public()
  open(): void {}

  closed(): void {}
}

@Public()
class PublicRoutes {
  anything(): void {}
}

function httpContext(
  headers: Record<string, string>,
  handler: () => void = Routes.prototype.closed,
  cls: object = Routes,
  type = 'http',
): { context: ExecutionContext; req: AuthenticatedRequest } {
  const req = { headers } as unknown as AuthenticatedRequest;
  const context = {
    getType: () => type,
    getHandler: () => handler,
    getClass: () => cls,
    switchToHttp: () => ({
      getRequest: () => req,
      getResponse: () => ({}),
      getNext: () => undefined,
    }),
  } as unknown as ExecutionContext;
  return { context, req };
}

const newGuard = (verifier: JwtVerifier = new JwtVerifier(OPTIONS)): AuthGuard =>
  new AuthGuard(new Reflector(), verifier, OPTIONS);

/** Runs the guard and returns the HTTP status it denied with (or 200 when it let the call in). */
async function statusOf(headers: Record<string, string>, guard = newGuard()): Promise<number> {
  const { context } = httpContext(headers);
  try {
    await guard.canActivate(context);
    return 200;
  } catch (err) {
    if (err instanceof HttpException) return err.getStatus();
    throw err;
  }
}

const bearer = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}` });

describe('AuthGuard: public routes', () => {
  it('lets a @Public() method through without checking anything', async () => {
    const fetchMock = stubIdp();
    const { context, req } = httpContext(
      { authorization: 'garbage' },
      Routes.prototype.open,
      Routes,
    );
    await expect(newGuard().canActivate(context)).resolves.toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(req.auth).toBeUndefined();
  });

  it('lets a method of a @Public() class through', async () => {
    stubIdp();
    const { context } = httpContext({}, PublicRoutes.prototype.anything, PublicRoutes);
    await expect(newGuard().canActivate(context)).resolves.toBe(true);
  });
});

describe('AuthGuard: the Authorization header', () => {
  it.each([
    ['no header at all', {}],
    ['Basic credentials', { authorization: 'Basic dXNlcjpwYXNz' }],
    ['a bare scheme', { authorization: 'Bearer' }],
    ['a scheme with only spaces', { authorization: 'Bearer   ' }],
    ['two tokens', { authorization: 'Bearer abc def' }],
    ['a different scheme', { authorization: 'Token abc' }],
    ['a token with no scheme', { authorization: 'abc.def.ghi' }],
    ['identity in other headers only', { 'x-user-id': 'user-1', cookie: 'session=abc' }],
  ])('answers 401 for %s', async (_label, headers: Record<string, string>) => {
    stubIdp();
    expect(await statusOf(headers)).toBe(401);
  });

  it('accepts a lowercase scheme', async () => {
    stubIdp();
    expect(await statusOf({ authorization: `bearer ${await sign(claims())}` })).toBe(200);
  });

  it('denies a non-HTTP context', async () => {
    stubIdp();
    const { context } = httpContext(bearer(await sign(claims())), undefined, undefined, 'rpc');
    await expect(newGuard().canActivate(context)).rejects.toBeInstanceOf(HttpException);
  });
});

describe('AuthGuard: token verification', () => {
  const badTokens: [string, () => Promise<string>][] = [
    ['a forged signature', () => sign(claims(), attacker.privateKey)],
    ['the wrong issuer', () => sign(claims({ iss: 'https://evil.test' }))],
    ['the wrong audience', () => sign(claims({ aud: '300000000000000999' }))],
    ['an expired token', () => sign(claims({ exp: now() - 120 }))],
    ['alg: none', () => Promise.resolve(`${b64url({ alg: 'none' })}.${b64url(claims())}.`)],
    [
      'HS256 signed with the public key',
      async () =>
        new SignJWT(claims())
          .setProtectedHeader({ alg: 'HS256', kid: KID })
          .sign(new TextEncoder().encode(await exportSPKI(trusted.publicKey))),
    ],
    [
      'a token without sub',
      () => {
        const { sub: _sub, ...rest } = claims();
        return sign(rest);
      },
    ],
  ];

  it.each(badTokens)('answers 401 with a generic message for %s', async (_label, makeToken) => {
    stubIdp();
    const { context, req } = httpContext(bearer(await makeToken()));
    const err: unknown = await newGuard()
      .canActivate(context)
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    expect(err).toBeInstanceOf(HttpException);
    expect((err as HttpException).getStatus()).toBe(401);
    // No jose detail leaks to the client.
    expect((err as HttpException).message).toBe(UNAUTHENTICATED);
    expect(req.auth).toBeUndefined();
  });

  it('answers 403 for a valid token with no org claim', async () => {
    stubIdp();
    const { [ORG_ID_CLAIM]: _org, ...rest } = claims();
    expect(await statusOf(bearer(await sign(rest)))).toBe(403);
  });

  it('answers 503 when discovery is down', async () => {
    stubIdp('discovery-down');
    expect(await statusOf(bearer(await sign(claims())))).toBe(503);
  });

  it('answers 503 when the JWKS endpoint fails', async () => {
    stubIdp('jwks-down');
    expect(await statusOf(bearer(await sign(claims())))).toBe(503);
  });

  it('answers 401 when the verifier throws something unexpected', async () => {
    const verifier = new JwtVerifier(OPTIONS);
    vi.spyOn(verifier, 'verify').mockRejectedValue(new Error('surprise'));
    expect(await statusOf(bearer('a.b.c'), newGuard(verifier))).toBe(401);
  });

  it('sets req.auth on success, with roles from both claim forms and not other projects', async () => {
    stubIdp();
    const grant = { 'org-1': 'staff.auth.localhost' };
    const token = await sign(
      claims({
        [PROJECT_ROLES_CLAIM]: { viewer: grant },
        [projectRolesClaim(AUDIENCE)]: { admin: grant },
        [projectRolesClaim('300000000000000999')]: { superuser: grant },
      }),
    );
    const { context, req } = httpContext(bearer(token));
    await expect(newGuard().canActivate(context)).resolves.toBe(true);
    expect(req.auth).toEqual({
      userId: 'user-1',
      zitadelOrgId: 'org-1',
      roles: ['admin', 'viewer'],
      tokenExp: expect.any(Number) as number,
    });
  });
});

@Controller('probe')
class ProbeController {
  @Public()
  @Get('open')
  open(): { ok: true } {
    return { ok: true };
  }

  @Get('closed')
  closed(@Req() req: AuthenticatedRequest): { userId: string | undefined } {
    return { userId: req.auth?.userId };
  }
}

// Wires the guard the way AuthModule does (APP_GUARD + DI), without U3's AppConfig, to prove the
// constructor injection works under SWC and that the guard really runs on every route.
describe('AuthGuard as APP_GUARD in a Nest app', () => {
  let app: INestApplication | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  async function startApp(): Promise<INestApplication> {
    const moduleRef = await Test.createTestingModule({
      controllers: [ProbeController],
      providers: [
        { provide: AUTH_OPTIONS, useValue: OPTIONS },
        JwtVerifier,
        { provide: APP_GUARD, useClass: AuthGuard },
      ],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.init();
    return app;
  }

  it('serves a public route without a token', async () => {
    stubIdp();
    const server = (await startApp()).getHttpServer() as Parameters<typeof request>[0];
    await request(server).get('/probe/open').expect(200, { ok: true });
  });

  it('denies a protected route without a token, and serves it with one', async () => {
    stubIdp();
    const server = (await startApp()).getHttpServer() as Parameters<typeof request>[0];
    await request(server).get('/probe/closed').expect(401);
    await request(server)
      .get('/probe/closed')
      .set('authorization', `Bearer ${await sign(claims())}`)
      .expect(200, { userId: 'user-1' });
  });
});
