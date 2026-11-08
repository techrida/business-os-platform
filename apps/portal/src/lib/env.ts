import { z } from 'zod';

/**
 * Server-side configuration for the portal BFF. Copied from apps/workspace/src/lib/env.ts
 * (dedupe later); the portal has its own client id, public origin and session key id.
 *
 * Read lazily (on first use, not at import) so `next build` and `next start` work without the
 * auth stack or its env present. Validated once and cached for the life of the process.
 */
export interface PortalEnv {
  OIDC_ISSUER: string;
  OIDC_CLIENT_ID: string;
  OIDC_REDIRECT_URI: string;
  OIDC_AUDIENCE: string;
  PORTAL_PUBLIC_URL: string;
  /** Optional: where staff who reach the portal are sent. Without it they only get the message. */
  WORKSPACE_PUBLIC_URL?: string;
  API_INTERNAL_URL: string;
  VALKEY_URL: string;
  /** Login state (state, nonce, PKCE verifier) lives on its own Valkey so it cannot fill the session one. */
  OIDC_STATE_VALKEY_URL: string;
  /** AES-256-GCM key for session records at rest: base64 of exactly 32 bytes. */
  SESSION_ENC_KEY: string;
  /** Written into every stored session value, so a rotated key can be told apart. */
  SESSION_ENC_KEY_ID: string;
}

const nonEmpty = z.string().trim().min(1, 'is required');

/** Any absolute http(s) URL. */
const httpUrl = nonEmpty.refine((v) => {
  try {
    const u = new URL(v);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}, 'must be an absolute http(s) URL');

/**
 * Browser-facing URLs must be https: the `__Host-` session cookie needs `Secure`, and
 * openid-client refuses plain-http issuers. There is deliberately no switch to relax this.
 */
const httpsUrl = nonEmpty.refine((v) => {
  try {
    return new URL(v).protocol === 'https:';
  } catch {
    return false;
  }
}, 'must be an absolute https URL');

const redisUrl = nonEmpty.refine((v) => {
  try {
    const p = new URL(v).protocol;
    return p === 'redis:' || p === 'rediss:';
  } catch {
    return false;
  }
}, 'must be a redis:// or rediss:// URL');

/**
 * Canonical base64 of exactly 32 bytes, as `openssl rand -base64 32` prints it. Node's base64
 * decoder skips characters it does not know, so the value must also re-encode to itself.
 */
const encryptionKey = nonEmpty.refine((v) => {
  const bytes = Buffer.from(v, 'base64');
  return bytes.length === 32 && bytes.toString('base64') === v;
}, 'must be base64 that decodes to exactly 32 bytes (openssl rand -base64 32)');

/** The key id is one dot-separated part of the stored value, so it may not contain a dot. */
const keyId = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9_-]{1,32}$/, 'must be 1 to 32 characters of A-Z, a-z, 0-9, _ or -');

const EnvSchema = z.object({
  OIDC_ISSUER: httpsUrl,
  OIDC_CLIENT_ID: nonEmpty,
  OIDC_REDIRECT_URI: httpsUrl,
  /** The ZITADEL project id; it becomes the access token audience scope. */
  OIDC_AUDIENCE: nonEmpty,
  PORTAL_PUBLIC_URL: httpsUrl,
  WORKSPACE_PUBLIC_URL: httpsUrl.optional(),
  /** Container-to-container URL of the API, so plain http is allowed. */
  API_INTERNAL_URL: httpUrl,
  VALKEY_URL: redisUrl,
  OIDC_STATE_VALKEY_URL: redisUrl.optional(),
  SESSION_ENC_KEY: encryptionKey,
  // `p1`, not the workspace's `k1`: the two apps never share a session key (or its id).
  SESSION_ENC_KEY_ID: keyId.default('p1'),
});

let cached: PortalEnv | undefined;

/**
 * Returns the validated env. Throws an error that names every missing or invalid variable,
 * never their values (some of them could be credentials, e.g. a password inside VALKEY_URL).
 */
export function getEnv(): PortalEnv {
  if (cached) return cached;
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((issue) => {
        const name = issue.path.join('.');
        const missing = process.env[name] === undefined;
        return `${name} ${missing ? 'is missing' : issue.message}`;
      })
      .join('; ');
    throw new Error(`Invalid portal environment: ${problems}`);
  }
  const { OIDC_STATE_VALKEY_URL, WORKSPACE_PUBLIC_URL, ...rest } = parsed.data;
  cached = {
    ...rest,
    ...(WORKSPACE_PUBLIC_URL !== undefined ? { WORKSPACE_PUBLIC_URL } : {}),
    OIDC_STATE_VALKEY_URL: OIDC_STATE_VALKEY_URL ?? rest.VALKEY_URL,
  };
  return cached;
}

/** Tests only: forget the cached env so the next `getEnv()` re-reads `process.env`. */
export function __resetEnvForTests(): void {
  cached = undefined;
}
