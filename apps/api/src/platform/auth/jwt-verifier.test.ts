import { Logger } from '@nestjs/common';
import {
  type CryptoKey,
  errors,
  exportJWK,
  exportSPKI,
  generateKeyPair,
  type JWK,
  type JWTPayload,
  SignJWT,
} from 'jose';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { ORG_ID_CLAIM } from './claims';
import { AuthUnavailableError, JwtVerifier } from './jwt-verifier';

const ISSUER = 'https://auth.test.local';
const AUDIENCE = '300000000000000001';
/** The workspace client, the default `azp` of a valid token. */
const CLIENT_ID = '300000000000000002';
/** A second allowed client (the k6 load-test user), to show the list is a list. */
const K6_CLIENT_ID = '300000000000000003';
const DISCOVERY_URL = `${ISSUER}/.well-known/openid-configuration`;
// Deliberately not ZITADEL's usual /oauth/v2/keys: the verifier must take the URL from discovery.
const JWKS_URI = `${ISSUER}/discovered/keys`;
const KID = 'trusted-key';

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

interface Routes {
  discovery?: () => Promise<Response>;
  jwks?: () => Promise<Response>;
}

/** Replaces global fetch, which both our discovery code and jose's key fetch use. */
function stubIdp(routes: Routes = {}) {
  const fetchMock = vi.fn((input: FetchInput): Promise<Response> => {
    const url = urlOf(input);
    if (url === DISCOVERY_URL) {
      return (
        routes.discovery?.() ??
        Promise.resolve(Response.json({ issuer: ISSUER, jwks_uri: JWKS_URI }))
      );
    }
    if (url === JWKS_URI) {
      return routes.jwks?.() ?? Promise.resolve(Response.json({ keys: [trustedJwk] }));
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
  azp: CLIENT_ID,
  sub: 'user-1',
  iat: now(),
  exp: now() + 300,
  [ORG_ID_CLAIM]: 'org-1',
  ...extra,
});

const sign = (
  payload: JWTPayload,
  key: CryptoKey = trusted.privateKey,
  kid = KID,
): Promise<string> => new SignJWT(payload).setProtectedHeader({ alg: 'RS256', kid }).sign(key);

const b64url = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');

const newVerifier = (
  warmupDelaysMs: readonly number[] = [1],
  allowedAzp: readonly string[] = [CLIENT_ID, K6_CLIENT_ID],
): JwtVerifier =>
  new JwtVerifier({ issuer: ISSUER, audience: AUDIENCE, allowedAzp, warmupDelaysMs });

const httpError = (status: number): Promise<Response> =>
  Promise.resolve(new Response('error', { status }));

describe('JwtVerifier.verify: token checks (each must reject as a token error, not 503)', () => {
  it('accepts a valid RS256 token from the trusted issuer', async () => {
    const fetchMock = stubIdp();
    const payload = await newVerifier().verify(await sign(claims()));
    expect(payload.sub).toBe('user-1');
    // jwks_uri came from discovery, not a hardcoded path.
    expect(fetchMock.mock.calls.map(([input]) => urlOf(input))).toEqual([DISCOVERY_URL, JWKS_URI]);
  });

  it('accepts a token expired within the 30 s clock tolerance', async () => {
    stubIdp();
    await expect(
      newVerifier().verify(await sign(claims({ exp: now() - 10 }))),
    ).resolves.toBeDefined();
  });

  const rejects = async (
    token: string,
    errorClass: new (...args: never[]) => Error,
    verifier: JwtVerifier = newVerifier(),
  ) => {
    stubIdp();
    const result = verifier.verify(token);
    await expect(result).rejects.toBeInstanceOf(errorClass);
    await expect(result).rejects.not.toBeInstanceOf(AuthUnavailableError);
  };

  it('rejects a forged signature (attacker key, trusted kid)', async () => {
    await rejects(await sign(claims(), attacker.privateKey), errors.JWSSignatureVerificationFailed);
  });

  it('rejects a token signed by an unknown key id', async () => {
    await rejects(
      await sign(claims(), attacker.privateKey, 'unknown-kid'),
      errors.JWKSNoMatchingKey,
    );
  });

  it('rejects the wrong issuer', async () => {
    await rejects(
      await sign(claims({ iss: 'https://evil.test' })),
      errors.JWTClaimValidationFailed,
    );
  });

  it('rejects the wrong audience', async () => {
    await rejects(
      await sign(claims({ aud: '300000000000000999' })),
      errors.JWTClaimValidationFailed,
    );
  });

  it('rejects an expired token (beyond tolerance)', async () => {
    await rejects(await sign(claims({ exp: now() - 120 })), errors.JWTExpired);
  });

  it('rejects alg: none', async () => {
    const token = `${b64url({ alg: 'none', typ: 'JWT' })}.${b64url(claims())}.`;
    await rejects(token, errors.JOSEError);
  });

  it('rejects HS256 signed with the public key (algorithm confusion)', async () => {
    const secret = new TextEncoder().encode(await exportSPKI(trusted.publicKey));
    const token = await new SignJWT(claims())
      .setProtectedHeader({ alg: 'HS256', kid: KID })
      .sign(secret);
    await rejects(token, errors.JOSEAlgNotAllowed);
  });

  it('rejects a token without sub', async () => {
    const { sub: _sub, ...noSub } = claims();
    await rejects(await sign(noSub), errors.JWTClaimValidationFailed);
  });

  it('rejects a token without iat', async () => {
    const { iat: _iat, ...noIat } = claims();
    await rejects(await sign(noIat), errors.JWTClaimValidationFailed);
  });

  it('rejects garbage', async () => {
    await rejects('not.a.jwt', errors.JOSEError);
  });

  // CR-04: `aud` only says our project may read the token. A client in another project can add
  // our project to `aud`, so the authorized party must be one of our own clients.
  it('rejects a valid token minted for a client that is not allow-listed (foreign azp)', async () => {
    await rejects(
      await sign(claims({ azp: '399999999999999999' })),
      errors.JWTClaimValidationFailed,
    );
  });

  it('rejects a token without azp', async () => {
    const { azp: _azp, ...noAzp } = claims();
    await rejects(await sign(noAzp), errors.JWTClaimValidationFailed);
  });

  it('rejects a non-string azp', async () => {
    await rejects(await sign(claims({ azp: [CLIENT_ID] })), errors.JWTClaimValidationFailed);
  });

  // Some ZITADEL token profiles carry the client only as `client_id`. It counts as the authorized
  // party when `azp` is absent, and is checked against the same allow-list.
  it('accepts a token with only client_id when that client is allow-listed', async () => {
    stubIdp();
    const { azp: _azp, ...noAzp } = claims({ client_id: CLIENT_ID });
    await expect(newVerifier().verify(await sign(noAzp))).resolves.toMatchObject({
      client_id: CLIENT_ID,
    });
  });

  it('rejects a token with only client_id when that client is not allow-listed', async () => {
    const { azp: _azp, ...noAzp } = claims({ client_id: '399999999999999999' });
    await rejects(await sign(noAzp), errors.JWTClaimValidationFailed);
  });

  it('does not let client_id stand in for a disallowed azp', async () => {
    await rejects(
      await sign(claims({ azp: '399999999999999999', client_id: CLIENT_ID })),
      errors.JWTClaimValidationFailed,
    );
  });

  it('accepts every allow-listed azp', async () => {
    stubIdp();
    const verifier = newVerifier();
    await expect(verifier.verify(await sign(claims()))).resolves.toMatchObject({ azp: CLIENT_ID });
    await expect(verifier.verify(await sign(claims({ azp: K6_CLIENT_ID })))).resolves.toMatchObject(
      { azp: K6_CLIENT_ID },
    );
  });

  it('fails closed when the allow-list is empty', async () => {
    await rejects(await sign(claims()), errors.JWTClaimValidationFailed, newVerifier([1], []));
  });

  // CR-05b: an ID token has the same issuer, keys and audience as an access token. Only ID
  // tokens carry `nonce`, so its presence means someone is replaying an ID token as a bearer.
  it('rejects an ID token used as a bearer token (has nonce)', async () => {
    await rejects(await sign(claims({ nonce: 'n-0S6_WzA2Mj' })), errors.JWTClaimValidationFailed);
  });
});

describe('JwtVerifier.verify: identity provider failures (must be AuthUnavailableError, i.e. 503)', () => {
  const unavailable = async (routes: Routes) => {
    stubIdp(routes);
    await expect(newVerifier().verify(await sign(claims()))).rejects.toBeInstanceOf(
      AuthUnavailableError,
    );
  };

  it('discovery answers 500', () => unavailable({ discovery: () => httpError(500) }));

  it('discovery fetch rejects (network down)', () =>
    unavailable({ discovery: () => Promise.reject(new TypeError('fetch failed')) }));

  it('discovery issuer differs from OIDC_ISSUER (even by a trailing slash)', () =>
    unavailable({
      discovery: () => Promise.resolve(Response.json({ issuer: `${ISSUER}/`, jwks_uri: JWKS_URI })),
    }));

  it('discovery has no jwks_uri', () =>
    unavailable({ discovery: () => Promise.resolve(Response.json({ issuer: ISSUER })) }));

  it('discovery downgrades jwks_uri to http', () =>
    unavailable({
      discovery: () =>
        Promise.resolve(Response.json({ issuer: ISSUER, jwks_uri: 'http://auth.test.local/keys' })),
    }));

  it('JWKS answers 500', () => unavailable({ jwks: () => httpError(500) }));

  it('JWKS fetch rejects (network down)', () =>
    unavailable({ jwks: () => Promise.reject(new TypeError('fetch failed')) }));

  it('JWKS is not a key set', () =>
    unavailable({ jwks: () => Promise.resolve(Response.json({ nope: true })) }));

  it('retries discovery on the next call after a failure', async () => {
    let calls = 0;
    stubIdp({
      discovery: () =>
        ++calls === 1
          ? httpError(503)
          : Promise.resolve(Response.json({ issuer: ISSUER, jwks_uri: JWKS_URI })),
    });
    const verifier = newVerifier();
    const token = await sign(claims());
    await expect(verifier.verify(token)).rejects.toBeInstanceOf(AuthUnavailableError);
    await expect(verifier.verify(token)).resolves.toBeDefined();
  });

  it('shares one discovery fetch between concurrent calls', async () => {
    const fetchMock = stubIdp();
    const verifier = newVerifier();
    const token = await sign(claims());
    await Promise.all([verifier.verify(token), verifier.verify(token), verifier.verify(token)]);
    const discoveries = fetchMock.mock.calls.filter(([input]) => urlOf(input) === DISCOVERY_URL);
    expect(discoveries).toHaveLength(1);
  });
});

describe('JwtVerifier warm-up and readiness', () => {
  it('is not ready before the keys load', async () => {
    stubIdp();
    await expect(newVerifier().isJwksReady()).resolves.toBe(false);
  });

  it('becomes ready after a verify loads the keys', async () => {
    stubIdp();
    const verifier = newVerifier();
    await verifier.verify(await sign(claims()));
    await expect(verifier.isJwksReady()).resolves.toBe(true);
  });

  it('bootstrap returns at once and retries with backoff until the keys load', async () => {
    let calls = 0;
    stubIdp({
      discovery: () =>
        ++calls <= 2
          ? Promise.reject(new TypeError('fetch failed'))
          : Promise.resolve(Response.json({ issuer: ISSUER, jwks_uri: JWKS_URI })),
    });
    const verifier = newVerifier([1]);
    // Returns synchronously: a down identity provider must not hold up (or crash) boot.
    expect(verifier.onApplicationBootstrap()).toBeUndefined();
    await expect(verifier.isJwksReady()).resolves.toBe(false);
    await vi.waitFor(async () => expect(await verifier.isJwksReady()).toBe(true));
    expect(calls).toBe(3);
    verifier.onModuleDestroy();
  });

  it('stops retrying after the module is destroyed', async () => {
    const fetchMock = stubIdp({ discovery: () => httpError(500) });
    const verifier = newVerifier([5]);
    verifier.onApplicationBootstrap();
    await vi.waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2));
    verifier.onModuleDestroy();
    // Let any in-flight attempt settle, then check no new attempts start.
    await new Promise((resolve) => setTimeout(resolve, 20));
    const settled = fetchMock.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fetchMock.mock.calls.length).toBe(settled);
    await expect(verifier.isJwksReady()).resolves.toBe(false);
  });
});
