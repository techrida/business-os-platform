import { z } from 'zod';

/**
 * Server-side configuration for the workspace BFF.
 *
 * Read lazily (on first use, not at import) so `next build` and `next start` work without the
 * auth stack or its env present. Validated once and cached for the life of the process.
 */
export interface WorkspaceEnv {
  OIDC_ISSUER: string;
  OIDC_CLIENT_ID: string;
  OIDC_REDIRECT_URI: string;
  OIDC_AUDIENCE: string;
  WORKSPACE_PUBLIC_URL: string;
  API_INTERNAL_URL: string;
  VALKEY_URL: string;
  /** Login state (state, nonce, PKCE verifier) lives on its own Valkey so it cannot fill the session one. */
  OIDC_STATE_VALKEY_URL: string;
  /** AES-256-GCM key for session records at rest: base64 of exactly 32 bytes. */
  SESSION_ENC_KEY: string;
  /** Written into every stored session value, so a rotated key can be told apart. */
  SESSION_ENC_KEY_ID: string;
  /**
   * Dev only: replaces the 20-per-minute login limit (CR-03) with a higher one, because all local
   * traffic shares one Caddy client IP. Accepted only on a `localhost` / `*.localhost` public URL.
   */
  BOS_DEV_LOGIN_RATE_LIMIT?: number | undefined;
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

/** True for `localhost` and `*.localhost`: names that resolve to the local machine only. */
function isLocalhostUrl(value: string): boolean {
  try {
    const host = new URL(value).hostname;
    return host === 'localhost' || host.endsWith('.localhost');
  } catch {
    return false;
  }
}

const EnvSchema = z
  .object({
    OIDC_ISSUER: httpsUrl,
    OIDC_CLIENT_ID: nonEmpty,
    OIDC_REDIRECT_URI: httpsUrl,
    /** The ZITADEL project id; it becomes the access token audience scope. */
    OIDC_AUDIENCE: nonEmpty,
    WORKSPACE_PUBLIC_URL: httpsUrl,
    /** Container-to-container URL of the API, so plain http is allowed. */
    API_INTERNAL_URL: httpUrl,
    VALKEY_URL: redisUrl,
    OIDC_STATE_VALKEY_URL: redisUrl.optional(),
    SESSION_ENC_KEY: encryptionKey,
    SESSION_ENC_KEY_ID: keyId.default('k1'),
    /** Not gated on NODE_ENV: the compose `app` profile is a production build on `*.localhost`. */
    BOS_DEV_LOGIN_RATE_LIMIT: z.coerce.number().int().min(21).max(10_000).optional(),
  })
  .superRefine((env, ctx) => {
    if (env.BOS_DEV_LOGIN_RATE_LIMIT !== undefined && !isLocalhostUrl(env.WORKSPACE_PUBLIC_URL)) {
      ctx.addIssue({
        code: 'custom',
        path: ['BOS_DEV_LOGIN_RATE_LIMIT'],
        message:
          'is dev-only and is refused in production: it is allowed only when WORKSPACE_PUBLIC_URL is localhost or *.localhost',
      });
    }
  });

/** Optional links shown in the footer of the sign-in and notice pages. A link is omitted when unset. */
export interface FooterLinks {
  helpUrl: string | undefined;
  privacyUrl: string | undefined;
}

/**
 * Reads BOS_HELP_URL and BOS_PRIVACY_URL on their own, outside the main schema: these pages must
 * still render when an unrelated variable is wrong. Blank or invalid values (anything that is not
 * an absolute http(s) URL, which also rules out `javascript:`) count as unset.
 */
export function getFooterLinks(
  source: Record<string, string | undefined> = process.env,
): FooterLinks {
  const read = (name: string): string | undefined => {
    const parsed = httpUrl.safeParse(source[name]);
    return parsed.success ? parsed.data : undefined;
  };
  return { helpUrl: read('BOS_HELP_URL'), privacyUrl: read('BOS_PRIVACY_URL') };
}

let cached: WorkspaceEnv | undefined;

/**
 * Returns the validated env. Throws an error that names every missing or invalid variable,
 * never their values (some of them could be credentials, e.g. a password inside VALKEY_URL).
 */
export function getEnv(): WorkspaceEnv {
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
    throw new Error(`Invalid workspace environment: ${problems}`);
  }
  const { OIDC_STATE_VALKEY_URL, ...rest } = parsed.data;
  cached = { ...rest, OIDC_STATE_VALKEY_URL: OIDC_STATE_VALKEY_URL ?? rest.VALKEY_URL };
  return cached;
}

/** Tests only: forget the cached env so the next `getEnv()` re-reads `process.env`. */
export function __resetEnvForTests(): void {
  cached = undefined;
}
