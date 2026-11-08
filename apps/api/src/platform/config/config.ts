import { z } from 'zod';

/** The two processes that ship in the one image. They share a core config. */
export type ServiceName = 'api' | 'worker';

const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;

const port = z.coerce.number().int().min(1).max(65535);

/**
 * Parse a URL without throwing and without echoing it: a DATABASE_URL carries a password, and a
 * Zod message that quoted the input would end up in the container log.
 */
function urlWithProtocol(protocols: readonly string[]) {
  return (value: string): boolean => {
    try {
      return protocols.includes(new URL(value).protocol);
    } catch {
      return false;
    }
  };
}

const coreShape = (service: ServiceName) => ({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
  // 9464 for the API and 9465 for the worker, so both can run on one host without a clash.
  METRICS_PORT: port.default(service === 'api' ? 9464 : 9465),
  DATABASE_URL: z
    .string()
    .refine(
      urlWithProtocol(['postgres:', 'postgresql:']),
      'must be a postgres:// or postgresql:// URL',
    ),
  VALKEY_URL: z
    .string()
    .refine(urlWithProtocol(['redis:', 'rediss:']), 'must be a redis:// or rediss:// URL'),
});

/**
 * Is this host a loopback address? Only literal loopbacks count (localhost, 127.0.0.0/8, ::1,
 * 0.0.0.0, ::). `*.localhost` names such as `auth.localhost` are deliberately NOT rejected:
 * the prod-like compose profile runs this image with NODE_ENV=production against
 * https://auth.localhost, which is a real TLS endpoint behind Caddy. What the rule blocks is a
 * production API that trusts an issuer on its own machine, such as an in-process test JWKS.
 */
export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  if (host === 'localhost') return true;
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  if (host === '0.0.0.0') return true;
  // WHATWG URL keeps IPv6 hosts in brackets and normalises IPv4-mapped forms to hex groups.
  if (host === '[::1]' || host === '[::]') return true;
  if (/^\[::ffff:(7f[0-9a-f]{2}:[0-9a-f]{1,4}|0:0)\]$/.test(host)) return true;
  return false;
}

function issuerProblem(issuer: string, nodeEnv: string): string | undefined {
  let url: URL;
  try {
    url = new URL(issuer);
  } catch {
    return 'must be an absolute URL';
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return 'must be an http(s) URL';
  if (nodeEnv !== 'production') return undefined;
  if (url.protocol !== 'https:') return 'must use https: in production';
  if (isLoopbackHost(url.hostname)) return 'must not point at a loopback host in production';
  return undefined;
}

const apiShape = {
  API_PORT: port.default(3001),
  // There is no switch that turns authentication off. Tests point OIDC_ISSUER at an in-process
  // JWKS (same code path, different trusted key); production config refuses such an issuer.
  OIDC_ISSUER: z.string().min(1),
  OIDC_AUDIENCE: z.string().min(1),
  // The workspace client's id. Part of the shared env contract, and the default for
  // OIDC_ALLOWED_AZP below.
  OIDC_CLIENT_ID: z.string().min(1).optional(),
  // Comma-separated client ids whose tokens the API accepts (the token's `azp`). `aud` alone is
  // not enough: any client can ask ZITADEL to add our project to `aud`. Unset or blank means
  // [OIDC_CLIENT_ID]; with neither, the config is refused.
  OIDC_ALLOWED_AZP: z.string().optional(),
};

const AZP_REQUIRED = 'must list at least one client id (or set OIDC_CLIENT_ID)';

function allowedAzp(list: string | undefined, clientId: string | undefined): string[] {
  const source = list === undefined || list.trim() === '' ? (clientId ?? '') : list;
  return source
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id !== '');
}

const coreSchema = (service: ServiceName) => z.object(coreShape(service));

const apiSchema = z
  .object({ ...coreShape('api'), ...apiShape })
  .superRefine((cfg, ctx) => {
    const problem = issuerProblem(cfg.OIDC_ISSUER, cfg.NODE_ENV);
    if (problem !== undefined)
      ctx.addIssue({ code: 'custom', path: ['OIDC_ISSUER'], message: problem });
  })
  .transform((cfg, ctx) => {
    const azp = allowedAzp(cfg.OIDC_ALLOWED_AZP, cfg.OIDC_CLIENT_ID);
    if (azp.length === 0) {
      ctx.addIssue({ code: 'custom', path: ['OIDC_ALLOWED_AZP'], message: AZP_REQUIRED });
      return z.NEVER;
    }
    return { ...cfg, OIDC_ALLOWED_AZP: Object.freeze(azp) };
  });

/**
 * Config both processes need: logging, metrics port, Postgres and Valkey.
 *
 * These are abstract classes so they work as both the Nest injection token and the type
 * (`constructor(private readonly config: AppConfig)` needs no @Inject). Property names match the
 * env var names exactly. The parsed object is a plain frozen object; it satisfies the class type
 * structurally, and `loadAppConfig` below fails to compile if the Zod schema and this type drift.
 */
export abstract class CoreConfig {
  abstract readonly NODE_ENV: 'development' | 'test' | 'production';
  abstract readonly LOG_LEVEL: (typeof LOG_LEVELS)[number];
  abstract readonly METRICS_PORT: number;
  abstract readonly DATABASE_URL: string;
  abstract readonly VALKEY_URL: string;
}

/** The API's config: the core plus its port and the OIDC settings. */
export abstract class AppConfig extends CoreConfig {
  abstract readonly API_PORT: number;
  abstract readonly OIDC_ISSUER: string;
  abstract readonly OIDC_AUDIENCE: string;
  abstract readonly OIDC_CLIENT_ID?: string | undefined;
  /** Never empty: the `azp` values the verifier accepts. */
  abstract readonly OIDC_ALLOWED_AZP: readonly string[];
}

export class ConfigError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`Invalid configuration:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    this.name = 'ConfigError';
  }
}

function describeIssues(error: z.ZodError): string[] {
  // Path and message only. Never `input`: it may be a password or a token.
  return error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`);
}

export type Env = Readonly<Record<string, string | undefined>>;

/** Parse the API's environment. Throws a ConfigError listing every problem at once. */
export function loadAppConfig(env: Env): AppConfig {
  const result = apiSchema.safeParse(env);
  if (!result.success) throw new ConfigError(describeIssues(result.error));
  return Object.freeze(result.data);
}

/** Parse the environment the worker needs (no OIDC, no API port). */
export function loadCoreConfig(env: Env, service: ServiceName): CoreConfig {
  const result = coreSchema(service).safeParse(env);
  if (!result.success) throw new ConfigError(describeIssues(result.error));
  return Object.freeze(result.data);
}
