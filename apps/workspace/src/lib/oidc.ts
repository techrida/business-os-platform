import 'server-only';

import * as client from 'openid-client';
import { z } from 'zod';

import { getEnv } from './env';
import { getRedis, safeReturnTo } from './session';

/**
 * OIDC against ZITADEL with openid-client v6 (functional API).
 *
 * The workspace is a public client: Authorization Code + PKCE (S256), no client secret, so
 * client authentication is `None()`. State, nonce and the PKCE verifier stay server-side in
 * Valkey; the browser only carries `state` through the redirect.
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

const oidcKey = (state: string) => `ws:oidc:${state}`;

const PendingLoginSchema = z.object({
  codeVerifier: z.string().min(43),
  nonce: z.string().min(1),
  returnTo: z.string(),
});

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
// Login
// ---------------------------------------------------------------------------------------------

/**
 * Starts a login: stores `ws:oidc:<state>` = { codeVerifier, nonce, returnTo } for 10 minutes
 * and returns the ZITADEL authorization URL to redirect to.
 */
export async function beginLogin(o: {
  loginHint?: string;
  prompt?: 'login' | 'none' | 'consent' | 'select_account';
  returnTo: string;
}): Promise<URL> {
  const env = getEnv();
  const config = await getOidcConfig();

  const codeVerifier = client.randomPKCECodeVerifier();
  const codeChallenge = await client.calculatePKCECodeChallenge(codeVerifier);
  const state = client.randomState();
  const nonce = client.randomNonce();
  // Sanitised again here so no caller can store an open redirect, even by mistake.
  const returnTo = safeReturnTo(o.returnTo);

  await getRedis().set(
    oidcKey(state),
    JSON.stringify({ codeVerifier, nonce, returnTo }),
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

  return client.buildAuthorizationUrl(config, params);
}

/**
 * Finishes a login from the callback URL.
 *
 * The stored state is read with GETDEL, so it works once: a replayed or forged callback finds
 * nothing and fails. The code exchange checks the PKCE verifier, state and ID token nonce.
 */
export async function completeLogin(callbackUrl: URL): Promise<{
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

  const raw = await getRedis().getdel(oidcKey(state));
  if (raw === null) throw new Error('oidc: unknown, expired or already used state');

  let pending: z.infer<typeof PendingLoginSchema>;
  try {
    pending = PendingLoginSchema.parse(JSON.parse(raw));
  } catch {
    throw new Error('oidc: corrupt login state');
  }

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
 * `post_logout_redirect_uri` unless it can tie it to a client, and the ID token hint is
 * optional.
 */
export async function endSessionUrl(o: { idTokenHint?: string }): Promise<URL> {
  const env = getEnv();
  const config = await getOidcConfig();
  const params: Record<string, string> = {
    client_id: env.OIDC_CLIENT_ID,
    post_logout_redirect_uri: env.WORKSPACE_PUBLIC_URL.replace(/\/+$/, '') + '/',
  };
  if (o.idTokenHint) params.id_token_hint = o.idTokenHint;
  return client.buildEndSessionUrl(config, params);
}

function toTokens(response: Awaited<ReturnType<typeof client.refreshTokenGrant>>): OidcTokens {
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
