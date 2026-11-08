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

const EnvSchema = z.object({
  OIDC_ISSUER: httpsUrl,
  OIDC_CLIENT_ID: nonEmpty,
  OIDC_REDIRECT_URI: httpsUrl,
  /** The ZITADEL project id; it becomes the access token audience scope. */
  OIDC_AUDIENCE: nonEmpty,
  WORKSPACE_PUBLIC_URL: httpsUrl,
  /** Container-to-container URL of the API, so plain http is allowed. */
  API_INTERNAL_URL: httpUrl,
  VALKEY_URL: redisUrl,
});

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
  cached = parsed.data;
  return cached;
}

/** Tests only: forget the cached env so the next `getEnv()` re-reads `process.env`. */
export function __resetEnvForTests(): void {
  cached = undefined;
}
