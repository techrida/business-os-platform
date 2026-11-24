import 'server-only';

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import { Redis } from 'ioredis';
import * as client from 'openid-client';
import { z } from 'zod';

import { getEnv } from './env';
import { safeReturnTo, VALKEY_CLIENT_OPTIONS, whenReady } from './session';

/**
 * Copied from apps/workspace/src/lib/oidc.ts (dedupe later); keys are `pt:oidc:`.
 *
 * OIDC against ZITADEL with openid-client v6 (functional API).
 *
 * The portal is a public client with its own ZITADEL app (not the workspace one): Authorization
 * Code + PKCE (S256), no client secret, so client authentication is `None()`. State, nonce and
 * the PKCE verifier stay server-side in Valkey; the browser only carries `state` through the
 * redirect.
 *
 * PKCE does not tie a login to a browser: anyone holding a valid `code&state` link could finish
 * it, so an attacker could send a victim their own callback link and sign the victim into the
 * attacker's account (login CSRF, CR-01). /auth/login therefore also sets the LOGIN_COOKIE with
 * a random value whose SHA-256 is stored with the state, and the callback only completes when
 * the browser presents that cookie.
 */

/**
 * Requested scopes. `{aud}` is replaced with OIDC_AUDIENCE (the ZITADEL project id) when the
 * login URL is built. It stays a template so importing this module never reads the env, which
 * keeps `next build` and `next start` working without the auth configuration.
 */
export const OIDC_SCOPES =
  'openid profile email offline_access urn:zitadel:iam:org:project:id:{aud}:aud urn:zitadel:iam:user:resourceowner';

/** A login attempt must finish within 10 minutes. */
const LOGIN_STATE_TTL_SECONDS = 600;
/** openid-client's `randomState()` is 43 base64url chars; allow some slack, nothing else. */
const STATE_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;
const MAX_LOGIN_HINT_LENGTH = 256;
const PROMPTS = new Set(['login', 'none', 'consent', 'select_account']);

/**
 * Browser binding for a login in progress. `__Host-` makes the browser insist on Secure, Path=/
 * and no Domain. Set by /auth/login for LOGIN_STATE_TTL_SECONDS, read and cleared by the callback.
 */
export const LOGIN_COOKIE = '__Host-bos_portal_login';
/** Max-Age of LOGIN_COOKIE: the same 10 minutes as the stored state. */
export const LOGIN_COOKIE_MAX_AGE = LOGIN_STATE_TTL_SECONDS;
const LOGIN_BINDING_BYTES = 32;

const oidcKey = (state: string) => `pt:oidc:${state}`;

const PendingLoginSchema = z.object({
  codeVerifier: z.string().min(43),
  nonce: z.string().min(1),
  returnTo: z.string(),
  /** SHA-256 (hex) of the LOGIN_COOKIE value. The raw value is never stored. */
  bindingHash: z.string().regex(/^[0-9a-f]{64}$/),
});

/**
 * The callback was not presented by the browser that started the login: the LOGIN_COOKIE is
 * missing or belongs to another login. Thrown before any token request.
 */
export class LoginBindingError extends Error {
  constructor() {
    super('oidc: login is not bound to this browser');
    this.name = 'LoginBindingError';
  }
}

function sha256(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

/** Constant-time check that `cookie` hashes to `bindingHash`. Both sides are 32-byte digests. */
function bindingMatches(cookie: string | undefined, bindingHash: string): boolean {
  if (!cookie) return false;
  const expected = Buffer.from(bindingHash, 'hex');
  const actual = sha256(cookie);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export interface OidcTokens {
  accessToken: string;
  refreshToken?: string;
  idToken?: string;
  /** Access token expiry, epoch seconds. */
  accessExp: number;
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

// ---------------------------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------------------------

let configPromise: Promise<client.Configuration> | undefined;

/**
 * Lazy, cached discovery. Concurrent first calls share one request. A failure is not cached,
 * so the next call retries (ZITADEL may simply not be up yet when the app boots).
 */
export function getOidcConfig(): Promise<client.Configuration> {
  if (!configPromise) {
    const pending = (async () => {
      const env = getEnv();
      return client.discovery(
        new URL(env.OIDC_ISSUER),
        env.OIDC_CLIENT_ID,
        undefined,
        client.None(),
      );
    })();
    configPromise = pending;
    void pending.catch(() => {
      if (configPromise === pending) configPromise = undefined;
    });
  }
  return configPromise;
}

/** Tests only: forget the cached discovery result. */
export function __resetOidcForTests(): void {
  configPromise = undefined;
}

// ---------------------------------------------------------------------------------------------
// Login state Valkey
// ---------------------------------------------------------------------------------------------

let oidcRedis: Redis | undefined;

/**
 * Login state lives on its own Valkey (OIDC_STATE_VALKEY_URL, CR-03), so anonymous logins can
 * fill only that server and never the memory sessions need. One connection per process, created
 * on first use, with the same fail-fast options as the session client.
 */
export function getOidcRedis(): Redis {
  oidcRedis ??= new Redis(getEnv().OIDC_STATE_VALKEY_URL, { ...VALKEY_CLIENT_OPTIONS });
  return oidcRedis;
}

/** Tests only: inject an ioredis-mock instance, or pass undefined to drop the injected one. */
export function __setOidcRedisForTests(redis: Redis | undefined): void {
  oidcRedis = redis;
}

// ---------------------------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------------------------

/**
 * Starts a login: stores `pt:oidc:<state>` = { codeVerifier, nonce, returnTo, bindingHash } for
 * 10 minutes and returns the ZITADEL authorization URL to redirect to, plus the `binding` value
 * the caller must set as LOGIN_COOKIE (HttpOnly, Secure, SameSite=Lax, Path=/,
 * Max-Age=LOGIN_COOKIE_MAX_AGE) on that redirect.
 */
export async function beginLogin(o: {
  loginHint?: string;
  prompt?: 'login' | 'none' | 'consent' | 'select_account';
  returnTo: string;
}): Promise<{ url: URL; binding: string }> {
  const env = getEnv();
  const config = await getOidcConfig();

  const codeVerifier = client.randomPKCECodeVerifier();
  const codeChallenge = await client.calculatePKCECodeChallenge(codeVerifier);
  const state = client.randomState();
  const nonce = client.randomNonce();
  // Sanitised again here so no caller can store an open redirect, even by mistake.
  const returnTo = safeReturnTo(o.returnTo);
  const binding = randomBytes(LOGIN_BINDING_BYTES).toString('base64url');
  const bindingHash = sha256(binding).toString('hex');

  const redis = await whenReady(getOidcRedis());
  await redis.set(
    oidcKey(state),
    JSON.stringify({ codeVerifier, nonce, returnTo, bindingHash }),
    'EX',
    LOGIN_STATE_TTL_SECONDS,
  );

  const params: Record<string, string> = {
    response_type: 'code',
    redirect_uri: env.OIDC_REDIRECT_URI,
    scope: OIDC_SCOPES.replace('{aud}', env.OIDC_AUDIENCE),
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    state,
    nonce,
  };
  // These come from the query string at runtime, whatever the static type says.
  if (o.loginHint && o.loginHint.length <= MAX_LOGIN_HINT_LENGTH) params.login_hint = o.loginHint;
  if (o.prompt && PROMPTS.has(o.prompt)) params.prompt = o.prompt;

  return { url: client.buildAuthorizationUrl(config, params), binding };
}

/**
 * Finishes a login from the callback URL.
 *
 * The stored state is read with GETDEL, so it works once: a replayed or forged callback finds
 * nothing and fails. `bindingCookie` is the LOGIN_COOKIE value from the request; if it is
 * missing or does not match the one set by beginLogin, this throws LoginBindingError before
 * any token request (the state is consumed all the same). The code exchange then checks the
 * PKCE verifier, state and ID token nonce.
 */
export async function completeLogin(
  callbackUrl: URL,
  bindingCookie: string | undefined,
): Promise<{
  tokens: OidcTokens;
  sub: string;
  returnTo: string;
}> {
  const env = getEnv();
  // openid-client derives the `redirect_uri` it sends from this URL (minus the query), and the
  // token endpoint requires it to match the registered one exactly. The caller must therefore
  // pass OIDC_REDIRECT_URI plus the callback query (behind Caddy `req.url` has the internal
  // origin). Refuse anything else so a wiring mistake fails loudly instead of at ZITADEL.
  const expected = new URL(env.OIDC_REDIRECT_URI);
  if (callbackUrl.origin !== expected.origin || callbackUrl.pathname !== expected.pathname) {
    throw new Error('oidc: callback URL does not match OIDC_REDIRECT_URI');
  }

  const state = callbackUrl.searchParams.get('state');
  if (!state || !STATE_PATTERN.test(state)) throw new Error('oidc: missing or malformed state');

  const redis = await whenReady(getOidcRedis());
  const raw = await redis.getdel(oidcKey(state));
  if (raw === null) throw new Error('oidc: unknown, expired or already used state');

  let pending: z.infer<typeof PendingLoginSchema>;
  try {
    pending = PendingLoginSchema.parse(JSON.parse(raw));
  } catch {
    throw new Error('oidc: corrupt login state');
  }

  // CR-01: only the browser that started this login may finish it.
  if (!bindingMatches(bindingCookie, pending.bindingHash)) throw new LoginBindingError();

  const config = await getOidcConfig();
  const response = await client.authorizationCodeGrant(config, callbackUrl, {
    pkceCodeVerifier: pending.codeVerifier,
    expectedState: state,
    expectedNonce: pending.nonce,
    idTokenExpected: true,
  });

  const sub = response.claims()?.sub;
  if (!sub) throw new Error('oidc: ID token has no subject');

  return { tokens: toTokens(response), sub, returnTo: safeReturnTo(pending.returnTo) };
}

/** Exchanges a refresh token. ZITADEL may rotate it; the new one, if sent, replaces the old. */
export async function refreshTokens(refreshToken: string): Promise<OidcTokens> {
  const config = await getOidcConfig();
  const response = await client.refreshTokenGrant(config, refreshToken);
  return toTokens(response);
}

/**
 * RP-initiated logout URL. `client_id` is always sent: ZITADEL ignores
 * `post_logout_redirect_uri` unless it can tie it to a client.
 *
 * No `id_token_hint` (CR-05a): this URL is a browser redirect, so it lands in history, proxy
 * logs and Referer headers, and an ID token must not. The cost is that ZITADEL may show its own
 * logout confirmation.
 */
export async function endSessionUrl(options: { idTokenHint?: string } = {}): Promise<URL> {
  const env = getEnv();
  const config = await getOidcConfig();
  return client.buildEndSessionUrl(config, {
    // Without the hint ZITADEL's end_session does not end the user's ZITADEL session, and the
    // next visit signs straight back in. It does put the ID token in the redirect URL (history,
    // proxy logs, Referer; CR-05a): accepted, since the API refuses ID tokens as credentials.
    ...(options.idTokenHint !== undefined ? { id_token_hint: options.idTokenHint } : {}),
    client_id: env.OIDC_CLIENT_ID,
    post_logout_redirect_uri: env.PORTAL_PUBLIC_URL.replace(/\/+$/, '') + '/',
  });
}

/** What both grants return, minus the `decryptedResponseType` brand, which differs between them. */
type TokenResponse = client.TokenEndpointResponse & client.TokenEndpointResponseHelpers;

function toTokens(response: TokenResponse): OidcTokens {
  const expiresIn = response.expiresIn();
  // Without an expiry we could not know when to refresh; fail closed rather than guess.
  if (expiresIn === undefined) throw new Error('oidc: token response has no expires_in');
  return {
    accessToken: response.access_token,
    ...(response.refresh_token !== undefined ? { refreshToken: response.refresh_token } : {}),
    ...(response.id_token !== undefined ? { idToken: response.id_token } : {}),
    accessExp: nowSeconds() + expiresIn,
  };
}
