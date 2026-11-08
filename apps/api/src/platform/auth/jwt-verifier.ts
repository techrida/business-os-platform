import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { createRemoteJWKSet, errors, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose';

// Type-only import: JwksStatus is U3's abstract class. AuthModule binds it to this class as a DI
// token; here we only promise its shape, so this file loads without the health module.
import type { JwksStatus } from '../health/jwks-status';

/**
 * What the verifier trusts. AuthModule builds it from AppConfig (OIDC_ISSUER, OIDC_AUDIENCE,
 * OIDC_ALLOWED_AZP).
 */
export interface AuthOptions {
  /** Must equal the discovery document's `issuer` and every token's `iss`, character for character. */
  readonly issuer: string;
  /** Our ZITADEL project id: the required `aud`, and the project whose roles we read. */
  readonly audience: string;
  /**
   * Client ids allowed as the token's `azp` (authorized party), or its `client_id` when `azp` is
   * absent. `aud` only says our project may read the token, and any client can ask for our project
   * in `aud`. Empty rejects every token.
   */
  readonly allowedAzp: readonly string[];
  /** Delays between warm-up attempts in ms; the last one repeats. Tests shorten it. */
  readonly warmupDelaysMs?: readonly number[];
}

/** DI token for {@link AuthOptions}. A local token keeps this file free of runtime config imports. */
export const AUTH_OPTIONS = Symbol('AUTH_OPTIONS');

/**
 * The identity provider could not be reached or answered nonsense (discovery or JWKS). This says
 * nothing about the token, so the guard answers 503 (retry later), not 401 (log in again).
 */
export class AuthUnavailableError extends Error {
  override readonly name = 'AuthUnavailableError';
}

type RemoteKeySet = ReturnType<typeof createRemoteJWKSet>;

const DISCOVERY_TIMEOUT_MS = 5_000;
/** Clock drift allowed with ZITADEL on `exp` and `nbf`, in seconds. */
const CLOCK_TOLERANCE_SECONDS = 30;
/** How long after its `exp` an ID token still proves a sign-in (step-up reads `auth_time`). */
const ID_TOKEN_EXPIRED_GRACE_SECONDS = 86_400;
const DEFAULT_WARMUP_DELAYS_MS: readonly number[] = [1_000, 2_000, 5_000, 10_000, 30_000];

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const describeError = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Verifies ZITADEL access tokens (JWT, RS256) against the issuer's published keys.
 *
 * The keys are found through OIDC discovery, never a hardcoded URL, so a ZITADEL move or key
 * rotation needs no code change. `jose` caches the key set for 10 minutes and refetches at most
 * every 30 s when a token names a key id it has not seen (rotation).
 */
@Injectable()
export class JwtVerifier implements JwksStatus, OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(JwtVerifier.name);
  private keySet: RemoteKeySet | undefined;
  /** In-flight discovery, shared so a burst of requests triggers one fetch, not one each. */
  private keySetPending: Promise<RemoteKeySet> | undefined;
  private stopped = false;
  private warmupTimer: NodeJS.Timeout | undefined;
  private wakeWarmup: (() => void) | undefined;

  constructor(@Inject(AUTH_OPTIONS) private readonly options: AuthOptions) {}

  /**
   * Starts loading the keys in the background. Not awaited on purpose: Nest awaits this hook before
   * the server listens, and an identity provider that is down must not stop the API from booting.
   * Until the keys load, /health/ready reports not ready and protected routes answer 503.
   */
  onApplicationBootstrap(): void {
    void this.warmUp();
  }

  onModuleDestroy(): void {
    this.stopped = true;
    clearTimeout(this.warmupTimer);
    this.wakeWarmup?.();
  }

  /** True once the key set has been fetched at least once. Read by /health/ready. */
  isJwksReady(): Promise<boolean> {
    return Promise.resolve(this.keySet?.jwks() !== undefined);
  }

  /**
   * Verifies signature, issuer, audience, expiry and required claims, and returns the payload.
   *
   * Throws {@link AuthUnavailableError} when discovery or the key fetch fails, and a `jose` error
   * (or another error) when the token itself is bad.
   */
  async verify(token: string): Promise<JWTPayload> {
    const getKey = await this.keyLookup();

    const { payload } = await jwtVerify(token, getKey, {
      issuer: this.options.issuer,
      audience: this.options.audience,
      // Only RS256. This list is what stops `alg: none` and HS256-signed-with-the-public-key.
      algorithms: ['RS256'],
      clockTolerance: CLOCK_TOLERANCE_SECONDS,
      requiredClaims: ['sub', 'exp', 'iat'],
    });
    // Checked after the signature, so these errors only ever describe a genuine token. Thrown as
    // jose claim errors, so the guard answers 401 like any other bad token.
    // The client is `azp`; some ZITADEL token profiles carry only `client_id`, so that stands in
    // when `azp` is absent. A present `azp` is never overridden by `client_id`.
    const clientId = payload.azp ?? payload.client_id;
    if (typeof clientId !== 'string' || !this.options.allowedAzp.includes(clientId)) {
      throw new errors.JWTClaimValidationFailed(
        'unexpected "azp" claim value',
        payload,
        'azp',
        'check_failed',
      );
    }
    // ID tokens share the issuer, keys and audience of access tokens, and only they carry
    // `nonce`. An ID token is proof of a login, not a bearer credential for this API.
    if ('nonce' in payload) {
      throw new errors.JWTClaimValidationFailed(
        'an ID token is not an access token',
        payload,
        'nonce',
        'check_failed',
      );
    }
    return payload;
  }

  /**
   * Verifies an OIDC ID token as proof that `expectedSub` signed in at its `auth_time` (step-up,
   * K7). ZITADEL puts `auth_time` only in ID tokens, never in access tokens, so the BFF forwards
   * the ID token for a decision that needs a recent sign-in.
   *
   * Same issuer, keys and RS256 as {@link verify}, but `aud` must hold an allowed client id (an ID
   * token is issued to the client, not to our project). An access token is refused by its
   * `at+jwt` type. An expired `exp` is tolerated for up to 24 h: freshness is the caller's
   * `auth_time` check, and ID tokens may expire before the access token they came with.
   *
   * Throws like {@link verify}: {@link AuthUnavailableError} for the identity provider, a `jose`
   * error for the token. It does NOT check how recent `auth_time` is.
   */
  async verifyIdToken(token: string, expectedSub: string): Promise<JWTPayload> {
    const { allowedAzp } = this.options;
    if (expectedSub.length === 0 || allowedAzp.length === 0) {
      throw new errors.JWTClaimValidationFailed(
        'no user or client to match',
        {},
        'sub',
        'check_failed',
      );
    }
    const getKey = await this.keyLookup();

    const { payload, protectedHeader } = await jwtVerify(token, getKey, {
      issuer: this.options.issuer,
      // jose accepts the token when `aud` contains ANY of these.
      audience: [...allowedAzp],
      algorithms: ['RS256'],
      // Applies to `exp` (and `nbf`, re-checked below with the normal 30 s). A token whose `exp`
      // is 24 h or more in the past is refused.
      clockTolerance: ID_TOKEN_EXPIRED_GRACE_SECONDS,
      requiredClaims: ['sub', 'exp', 'iat', 'auth_time'],
    });
    // RFC 9068: a JWT access token is typed `at+jwt` (media type `application/at+jwt`).
    const typ = protectedHeader.typ?.toLowerCase().replace(/^application\//, '');
    if (typ === 'at+jwt') {
      throw new errors.JWTClaimValidationFailed(
        'an access token is not an ID token',
        payload,
        'typ',
        'check_failed',
      );
    }
    const nowSec = Math.floor(Date.now() / 1000);
    if (typeof payload.nbf === 'number' && payload.nbf > nowSec + CLOCK_TOLERANCE_SECONDS) {
      throw new errors.JWTClaimValidationFailed(
        '"nbf" claim timestamp check failed',
        payload,
        'nbf',
        'check_failed',
      );
    }
    // OIDC Core 3.1.3.7: when `azp` is present it names the client the token was issued to.
    if (
      payload.azp !== undefined &&
      (typeof payload.azp !== 'string' || !allowedAzp.includes(payload.azp))
    ) {
      throw new errors.JWTClaimValidationFailed(
        'unexpected "azp" claim value',
        payload,
        'azp',
        'check_failed',
      );
    }
    if (payload.sub !== expectedSub) {
      throw new errors.JWTClaimValidationFailed(
        'the ID token belongs to another user',
        payload,
        'sub',
        'check_failed',
      );
    }
    return payload;
  }

  /**
   * The key lookup for `jwtVerify`. jose reports a failed key fetch as a JOSEError too, just like
   * a bad token. Wrapping the lookup is the only place we can still tell them apart: "no key
   * matches this token" is the token's fault (401); anything else is the identity provider's (503).
   */
  private async keyLookup(): Promise<JWTVerifyGetKey> {
    const keySet = await this.getKeySet();
    return async (header, jws) => {
      try {
        return await keySet(header, jws);
      } catch (err) {
        if (
          err instanceof errors.JWKSNoMatchingKey ||
          err instanceof errors.JWKSMultipleMatchingKeys
        ) {
          throw err;
        }
        throw new AuthUnavailableError(`JWKS unavailable: ${describeError(err)}`, { cause: err });
      }
    };
  }

  private async warmUp(): Promise<void> {
    const delays = this.options.warmupDelaysMs ?? DEFAULT_WARMUP_DELAYS_MS;
    for (let attempt = 0; !this.stopped; attempt++) {
      try {
        const keySet = await this.getKeySet();
        await keySet.reload();
        this.logger.log('JWKS loaded');
        return;
      } catch (err) {
        const delay = delays[Math.min(attempt, delays.length - 1)] ?? 30_000;
        this.logger.warn(
          `JWKS warm-up attempt ${attempt + 1} failed (${describeError(err)}); retrying in ${delay} ms`,
        );
        await this.sleep(delay);
      }
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.wakeWarmup = resolve;
      this.warmupTimer = setTimeout(resolve, ms);
      // An idle retry timer must not keep the process (or a test run) alive.
      this.warmupTimer.unref();
    });
  }

  private getKeySet(): Promise<RemoteKeySet> {
    if (this.keySet) return Promise.resolve(this.keySet);
    // A failed discovery is forgotten (`finally`), so the next request or warm-up attempt tries
    // again instead of answering 503 forever.
    this.keySetPending ??= this.discover()
      .then((keySet) => {
        this.keySet = keySet;
        return keySet;
      })
      .finally(() => {
        this.keySetPending = undefined;
      });
    return this.keySetPending;
  }

  private async discover(): Promise<RemoteKeySet> {
    const { issuer } = this.options;
    const url = `${issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`;

    let doc: unknown;
    try {
      const response = await fetch(url, {
        headers: { accept: 'application/json' },
        // A redirect could hand us someone else's document; ZITADEL serves it directly.
        redirect: 'error',
        signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
      });
      if (response.status !== 200) {
        throw new AuthUnavailableError(`OIDC discovery returned HTTP ${response.status}`);
      }
      doc = await response.json();
    } catch (err) {
      if (err instanceof AuthUnavailableError) throw err;
      throw new AuthUnavailableError(`OIDC discovery failed: ${describeError(err)}`, {
        cause: err,
      });
    }

    // OIDC Discovery 1.0 §4.3: the document's issuer must be exactly the one we asked for.
    if (!isPlainObject(doc) || doc.issuer !== issuer) {
      throw new AuthUnavailableError('OIDC discovery issuer does not match OIDC_ISSUER');
    }
    const jwksUri = doc.jwks_uri;
    if (typeof jwksUri !== 'string') {
      throw new AuthUnavailableError('OIDC discovery document has no jwks_uri');
    }

    let jwksUrl: URL;
    let issuerProtocol: string;
    try {
      jwksUrl = new URL(jwksUri);
      issuerProtocol = new URL(issuer).protocol;
    } catch (err) {
      throw new AuthUnavailableError('OIDC discovery jwks_uri is not a valid URL', { cause: err });
    }
    // Never downgrade: an https issuer must publish its keys over https. (Plain http is only
    // possible when the issuer itself is http, which production config rejects.)
    if (jwksUrl.protocol !== 'https:' && jwksUrl.protocol !== issuerProtocol) {
      throw new AuthUnavailableError('OIDC discovery jwks_uri downgrades the issuer protocol');
    }

    return createRemoteJWKSet(jwksUrl, { cooldownDuration: 30_000, cacheMaxAge: 600_000 });
  }
}
