import { inspect } from 'node:util';

import { MAX_UPLOAD_BYTES } from '@bos/contracts';
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
  // Per-transaction limits withTx sets with SET LOCAL: how long a statement may wait for a row or
  // table lock (then 55P03, answered as 503 db_busy), and how long a transaction may sit idle before
  // the server ends its session. No 0 (off): a blank value would coerce to it silently.
  DB_LOCK_TIMEOUT_MS: z.coerce.number().int().min(100).max(600_000).default(5_000),
  // How long one statement may run inside withTx (SET LOCAL statement_timeout via set_config), then 57014,
  // answered as 503 db_busy. Same floor and no-0 rule as the lock timeout.
  DB_STATEMENT_TIMEOUT_MS: z.coerce.number().int().min(100).max(600_000).default(15_000),
  DB_IDLE_IN_TX_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(3_600_000).default(30_000),
  // The pool's own limit, for a statement outside withTx (a read on the bare pool): the server cancels it
  // after this long (57014). The API gives 30 s; the worker keeps a longer 120 s for its sweeps and seals.
  // The client-side query_timeout is this plus 5 s, so the server's cancel always lands first.
  DB_POOL_STATEMENT_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(100)
    .max(3_600_000)
    .default(service === 'worker' ? 120_000 : 30_000),
  VALKEY_URL: z
    .string()
    .refine(urlWithProtocol(['redis:', 'rediss:']), 'must be a redis:// or rediss:// URL'),
  // P1 kernel settings the worker needs too (scan job, outbox, user sync). Hosts, ports and paths
  // have dev-safe defaults, like the ports above. Anything with no safe default (SMTP_URL,
  // MAIL_FROM, ZITADEL_API_URL) or secret (the token) is optional here and REQUIRED in production,
  // see kernelProblems(): a dev default must never reach production silently.
  FILES_ROOT: z.string().min(1).default('/var/lib/bos/files'),
  CLAMD_HOST: z.string().min(1).default('clamav'),
  CLAMD_PORT: port.default(3310),
  SMTP_URL: z
    .string()
    .refine(urlWithProtocol(['smtp:', 'smtps:']), 'must be an smtp:// or smtps:// URL')
    .optional(),
  // 'true' lets production use a plain smtp:// URL. Set only by compose for the dev mailbox (mailpit has no TLS).
  SMTP_ALLOW_PLAINTEXT: blankAsUnset,
  MAIL_FROM: z
    .string()
    .refine((v) => v.includes('@'), 'must contain an email address')
    .optional(),
  ZITADEL_API_URL: z
    .string()
    .refine(urlWithProtocol(['https:', 'http:']), 'must be an http(s) URL')
    .optional(),
  ZITADEL_PROVISIONER_TOKEN: z.string().min(1).optional(),
  // Base of the only links emails may carry (`/inbox/<id>`, which needs a login): never a file link.
  WORKSPACE_PUBLIC_URL: z
    .string()
    .refine(urlWithProtocol(['https:', 'http:']), 'must be an http(s) URL')
    .optional(),
  // Base of the links in customer emails (quotation sent, expiring, expired, portal invite): the
  // portal's own hostname, never the workspace's. Built from config only, never from input.
  PORTAL_PUBLIC_URL: z
    .string()
    .refine(urlWithProtocol(['https:', 'http:']), 'must be an http(s) URL')
    .optional(),
  // PDF renderer (Gotenberg), used by the worker's quotation render job. Optional here and required in
  // production for the worker only (see coreSchema): the API never calls it. Dev default: GOTENBERG_DEV_URL.
  GOTENBERG_URL: z
    .string()
    .refine(urlWithProtocol(['https:', 'http:']), 'must be an http(s) URL')
    .optional(),
  // One deadline for a render request including the body, and the most PDF bytes accepted. The size cap may
  // not exceed what the documents module takes (MAX_UPLOAD_BYTES), or a PDF Gotenberg returns would be refused
  // at upload time.
  GOTENBERG_TIMEOUT_MS: z.coerce.number().int().min(1000).max(300_000).default(30_000),
  GOTENBERG_MAX_BYTES: z.coerce.number().int().min(1).max(MAX_UPLOAD_BYTES).default(20_971_520),
});

/** The compose service name; applied outside production only. */
export const GOTENBERG_DEV_URL = 'http://gotenberg:3000';

/** What a missing optional kernel value becomes outside production (the local compose stack). */
const KERNEL_DEV_DEFAULTS = {
  SMTP_URL: 'smtp://mailpit:1025',
  MAIL_FROM: 'Business OS <noreply@bos.localhost>',
  ZITADEL_API_URL: 'https://auth.localhost',
  WORKSPACE_PUBLIC_URL: 'https://app.localhost',
  PORTAL_PUBLIC_URL: 'https://portal.localhost',
} as const;

const CORE_REQUIRED_IN_PRODUCTION = [
  'SMTP_URL',
  'MAIL_FROM',
  'ZITADEL_API_URL',
  'ZITADEL_PROVISIONER_TOKEN',
  'WORKSPACE_PUBLIC_URL',
  'PORTAL_PUBLIC_URL',
] as const;
/** The worker alone needs the PDF renderer, so only its production config must state GOTENBERG_URL. */
const WORKER_REQUIRED_IN_PRODUCTION = [...CORE_REQUIRED_IN_PRODUCTION, 'GOTENBERG_URL'] as const;
const API_REQUIRED_IN_PRODUCTION = [
  ...CORE_REQUIRED_IN_PRODUCTION,
  'DOCS_LINK_SECRET',
  // Without the keyring, encrypted fields (vendor bank account numbers) can be neither written nor read.
  'FIELD_ENC_KEYS',
  // ZITADEL_ACTIONS_SIGNING_KEY is deliberately NOT required: the webhook is an optional nudge
  // (ADR 0019, the 10-minute reconcile keeps users correct), and without a key the hook answers 401.
] as const;

/** True for `smtps:` and for `smtp:` carrying `requireTLS=true`. The URL is never put in a message. */
function smtpUsesTls(url: string): boolean {
  if (url.toLowerCase().startsWith('smtps:')) return true;
  try {
    return new URL(url).searchParams.get('requireTLS') === 'true';
  } catch {
    return false;
  }
}

/** Production must state every kernel value itself: the names only, never a value, in the message. */
function kernelProblems(required: readonly string[]) {
  return (cfg: { NODE_ENV?: string } & Record<string, unknown>, ctx: z.RefinementCtx): void => {
    if (cfg.NODE_ENV !== 'production') return;
    for (const key of required) {
      if (cfg[key] === undefined) {
        ctx.addIssue({ code: 'custom', path: [key], message: 'is required in production' });
      }
    }
    // The SMTP URL carries the relay password, so production sends it only over TLS: smtps:// (TLS from the
    // first byte) or smtp:// with requireTLS=true (STARTTLS that nodemailer refuses to skip). SMTP_ALLOW_PLAINTEXT
    // is for the compose dev mailbox only; a real deployment leaves it unset.
    const smtp = cfg['SMTP_URL'];
    if (typeof smtp === 'string' && cfg['SMTP_ALLOW_PLAINTEXT'] !== 'true' && !smtpUsesTls(smtp)) {
      ctx.addIssue({
        code: 'custom',
        path: ['SMTP_URL'],
        message:
          'must use smtps:// or smtp:// with requireTLS=true in production (plain smtp:// is not encrypted)',
      });
    }
  };
}

function withKernelDefaults<
  T extends {
    SMTP_URL?: string | undefined;
    MAIL_FROM?: string | undefined;
    ZITADEL_API_URL?: string | undefined;
    WORKSPACE_PUBLIC_URL?: string | undefined;
    PORTAL_PUBLIC_URL?: string | undefined;
    NODE_ENV?: string;
    GOTENBERG_URL?: string | undefined;
  },
>(cfg: T) {
  return {
    ...cfg,
    // Never the dev URL in production: a missing value stays undefined there (and is refused for the worker).
    GOTENBERG_URL:
      cfg.GOTENBERG_URL ?? (cfg.NODE_ENV === 'production' ? undefined : GOTENBERG_DEV_URL),
    SMTP_URL: cfg.SMTP_URL ?? KERNEL_DEV_DEFAULTS.SMTP_URL,
    MAIL_FROM: cfg.MAIL_FROM ?? KERNEL_DEV_DEFAULTS.MAIL_FROM,
    ZITADEL_API_URL: cfg.ZITADEL_API_URL ?? KERNEL_DEV_DEFAULTS.ZITADEL_API_URL,
    WORKSPACE_PUBLIC_URL: cfg.WORKSPACE_PUBLIC_URL ?? KERNEL_DEV_DEFAULTS.WORKSPACE_PUBLIC_URL,
    PORTAL_PUBLIC_URL: cfg.PORTAL_PUBLIC_URL ?? KERNEL_DEV_DEFAULTS.PORTAL_PUBLIC_URL,
  };
}

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

/** An optional value where blank means unset, as compose writes `${VAR:-}` for an unset variable. */
const blankAsUnset = z
  .string()
  .optional()
  .transform((v) => (v === undefined || v.trim() === '' ? undefined : v.trim()));

/**
 * Like blankAsUnset, but a nonblank value keeps its exact bytes. For HMAC keys that another system
 * signs with: trimming would change the key and every signature would fail.
 */
const blankAsUnsetRaw = z
  .string()
  .optional()
  .transform((v) => (v === undefined || v.trim() === '' ? undefined : v));

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
  // API-only secrets (the worker neither signs links nor receives the ZITADEL webhook).
  // At least 32 characters when present; blank counts as unset (as in .env.example or compose `${VAR:-}`);
  // required in production (kernelProblems).
  DOCS_LINK_SECRET: blankAsUnset.pipe(z.string().min(32).optional()),
  // At least 32 characters when present (a short HMAC key is brute-forceable); blank still counts as unset.
  ZITADEL_ACTIONS_SIGNING_KEY: blankAsUnsetRaw.pipe(z.string().min(32).optional()),
  // Shared secret for the Postal bounce webhook (HMAC-SHA256 of the raw body). Optional on purpose,
  // like the ZITADEL key: with no secret the hook answers 401 to everyone (deny by default).
  // Blank counts as unset so an empty `POSTAL_WEBHOOK_SECRET=` line (as in .env.example) does not block startup.
  POSTAL_WEBHOOK_SECRET: blankAsUnsetRaw.pipe(z.string().min(32).optional()),
  // Field-level encryption keyring (M20), see parseFieldKeyring for the format. Required in production;
  // blank counts as unset. Parsed into a FieldKeyring, so the raw string never stays on the config.
  FIELD_ENC_KEYS: blankAsUnset,
  FIELD_ENC_ACTIVE_KID: blankAsUnset,
  FIELD_ENC_FP_KID: blankAsUnset,
};

/**
 * The field-encryption keyring (M20): every key that may still open a stored value, by key id, plus
 * the id new values are sealed with and the id the fingerprint key is derived from.
 *
 * The keys sit in a private field and the class redacts itself for JSON.stringify, util.inspect and
 * String(), so logging the config (or this object) never prints key material.
 */
export class FieldKeyring {
  readonly #keys: ReadonlyMap<string, Buffer>;

  constructor(
    /** The id new values are sealed with. */
    readonly activeKid: string,
    /**
     * The id the fingerprint key is derived from. Separate from the active id on purpose: rotating the
     * active key must not change fingerprints, or equal plaintexts stored before and after stop matching.
     */
    readonly fingerprintKid: string,
    keys: ReadonlyMap<string, Buffer>,
  ) {
    if (!keys.has(activeKid) || !keys.has(fingerprintKid)) {
      throw new Error('FieldKeyring: the active and fingerprint ids must name keys in the ring');
    }
    this.#keys = keys;
    Object.freeze(this);
  }

  /** The key ids in the ring (not secret). */
  get kids(): string[] {
    return [...this.#keys.keys()];
  }

  /** The 32-byte key for `kid`, or undefined when the ring has no such id. */
  key(kid: string): Buffer | undefined {
    return this.#keys.get(kid);
  }

  toJSON(): { activeKid: string; fingerprintKid: string; kids: string[] } {
    return { activeKid: this.activeKid, fingerprintKid: this.fingerprintKid, kids: this.kids };
  }

  toString(): string {
    return `FieldKeyring(active=${this.activeKid}, fingerprint=${this.fingerprintKid}, kids=${this.kids.join(',')})`;
  }

  [inspect.custom](): string {
    return this.toString();
  }
}

const FIELD_KID = /^[A-Za-z0-9_-]{1,32}$/;
// Standard base64 of exactly 32 bytes: 43 characters and one `=` (what `openssl rand -base64 32` prints).
const FIELD_KEY_B64 = /^[A-Za-z0-9+/]{43}=$/;
const FIELD_KEY_BYTES = 32;
const MORE_THAN_ONE_KEY = 'is required when FIELD_ENC_KEYS holds more than one key';

interface KeyringIssue {
  path: string;
  message: string;
}

/**
 * Parse the field-encryption keyring from the environment.
 *
 *   FIELD_ENC_KEYS="k1:<base64 key>,k2:<base64 key>"   comma-separated `<kid>:<key>` entries
 *   FIELD_ENC_ACTIVE_KID="k2"                         the id new values are sealed with
 *   FIELD_ENC_FP_KID="k1"                             the id the fingerprint key is derived from
 *
 * A kid is 1-32 of [A-Za-z0-9_-]; a key is standard base64 of exactly 32 random bytes
 * (`openssl rand -base64 32`). With one key, both ids default to it; with more than one, both must be
 * named, so a rotation is an explicit choice and never silently moves the fingerprint key.
 * Messages name the entry by position only and never quote any part of the value.
 */
function parseFieldKeyring(
  raw: string,
  activeKid: string | undefined,
  fpKid: string | undefined,
): { keyring: FieldKeyring | undefined; issues: KeyringIssue[] } {
  const issues: KeyringIssue[] = [];
  const keys = new Map<string, Buffer>();
  const entries = raw
    .split(',')
    .map((e) => e.trim())
    .filter((e) => e !== '');
  if (entries.length === 0) {
    issues.push({ path: 'FIELD_ENC_KEYS', message: 'must list at least one key' });
  }
  entries.forEach((entry, index) => {
    const at = `entry ${index + 1}`;
    const sep = entry.indexOf(':');
    if (sep < 0) {
      issues.push({ path: 'FIELD_ENC_KEYS', message: `${at} must be <kid>:<base64 of 32 bytes>` });
      return;
    }
    const kid = entry.slice(0, sep);
    const encoded = entry.slice(sep + 1);
    if (!FIELD_KID.test(kid)) {
      issues.push({ path: 'FIELD_ENC_KEYS', message: `${at} has an invalid key id` });
      return;
    }
    const key = Buffer.from(encoded, 'base64');
    // Buffer.from is lenient (it skips bad characters), so the shape, the length and a round trip all count.
    if (
      !FIELD_KEY_B64.test(encoded) ||
      key.length !== FIELD_KEY_BYTES ||
      key.toString('base64') !== encoded
    ) {
      issues.push({
        path: 'FIELD_ENC_KEYS',
        message: `${at} key must be standard base64 of exactly ${FIELD_KEY_BYTES} bytes`,
      });
      return;
    }
    if (keys.has(kid)) {
      issues.push({ path: 'FIELD_ENC_KEYS', message: `${at} repeats a key id` });
      return;
    }
    keys.set(kid, key);
  });
  if (issues.length > 0) return { keyring: undefined, issues };

  const pick = (path: string, named: string | undefined): string | undefined => {
    if (named === undefined) {
      if (keys.size === 1) return [...keys.keys()][0];
      issues.push({ path, message: MORE_THAN_ONE_KEY });
      return undefined;
    }
    if (!keys.has(named)) {
      issues.push({ path, message: 'names no key in FIELD_ENC_KEYS' });
      return undefined;
    }
    return named;
  };
  const active = pick('FIELD_ENC_ACTIVE_KID', activeKid);
  const fingerprint = pick('FIELD_ENC_FP_KID', fpKid);
  if (active === undefined || fingerprint === undefined) return { keyring: undefined, issues };
  return { keyring: new FieldKeyring(active, fingerprint, keys), issues: [] };
}

/** A malformed keyring fails in every environment; a missing one fails in production (kernelProblems). */
function keyringProblems(
  cfg: {
    FIELD_ENC_KEYS?: string | undefined;
    FIELD_ENC_ACTIVE_KID?: string | undefined;
    FIELD_ENC_FP_KID?: string | undefined;
  },
  ctx: z.RefinementCtx,
): void {
  if (cfg.FIELD_ENC_KEYS === undefined) return;
  const { issues } = parseFieldKeyring(
    cfg.FIELD_ENC_KEYS,
    cfg.FIELD_ENC_ACTIVE_KID,
    cfg.FIELD_ENC_FP_KID,
  );
  for (const issue of issues) {
    ctx.addIssue({ code: 'custom', path: [issue.path], message: issue.message });
  }
}

const AZP_REQUIRED = 'must list at least one client id (or set OIDC_CLIENT_ID)';

function allowedAzp(list: string | undefined, clientId: string | undefined): string[] {
  const source = list === undefined || list.trim() === '' ? (clientId ?? '') : list;
  return source
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id !== '');
}

const coreSchema = (service: ServiceName) =>
  z
    .object(coreShape(service))
    .superRefine(
      kernelProblems(
        service === 'worker' ? WORKER_REQUIRED_IN_PRODUCTION : CORE_REQUIRED_IN_PRODUCTION,
      ),
    )
    .transform(withKernelDefaults);

const apiSchema = z
  .object({ ...coreShape('api'), ...apiShape })
  .superRefine((cfg, ctx) => {
    const problem = issuerProblem(cfg.OIDC_ISSUER, cfg.NODE_ENV);
    if (problem !== undefined)
      ctx.addIssue({ code: 'custom', path: ['OIDC_ISSUER'], message: problem });
  })
  .superRefine(kernelProblems(API_REQUIRED_IN_PRODUCTION))
  .superRefine(keyringProblems)
  .transform((cfg, ctx) => {
    const azp = allowedAzp(cfg.OIDC_ALLOWED_AZP, cfg.OIDC_CLIENT_ID);
    if (azp.length === 0) {
      ctx.addIssue({ code: 'custom', path: ['OIDC_ALLOWED_AZP'], message: AZP_REQUIRED });
      return z.NEVER;
    }
    const { FIELD_ENC_KEYS: rawKeys, FIELD_ENC_ACTIVE_KID, FIELD_ENC_FP_KID, ...rest } = cfg;
    // keyringProblems has already refused a malformed ring (the transform runs only on a clean parse).
    const keyring =
      rawKeys === undefined
        ? undefined
        : parseFieldKeyring(rawKeys, FIELD_ENC_ACTIVE_KID, FIELD_ENC_FP_KID).keyring;
    return withKernelDefaults({
      ...rest,
      OIDC_ALLOWED_AZP: Object.freeze(azp),
      FIELD_ENC_KEYS: keyring,
    });
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
  abstract readonly DB_LOCK_TIMEOUT_MS: number;
  abstract readonly DB_STATEMENT_TIMEOUT_MS: number;
  abstract readonly DB_IDLE_IN_TX_TIMEOUT_MS: number;
  abstract readonly DB_POOL_STATEMENT_TIMEOUT_MS: number;
  abstract readonly VALKEY_URL: string;
  abstract readonly FILES_ROOT: string;
  abstract readonly CLAMD_HOST: string;
  abstract readonly CLAMD_PORT: number;
  abstract readonly SMTP_URL: string;
  abstract readonly SMTP_ALLOW_PLAINTEXT?: string | undefined;
  abstract readonly MAIL_FROM: string;
  abstract readonly ZITADEL_API_URL: string;
  abstract readonly WORKSPACE_PUBLIC_URL: string;
  /** Base of customer-facing email links (the portal host). */
  abstract readonly PORTAL_PUBLIC_URL: string;
  /** Undefined outside production when unset; a consumer that needs it must fail with a clear error. */
  abstract readonly ZITADEL_PROVISIONER_TOKEN?: string | undefined;
  /**
   * The PDF renderer's base URL. Defaulted outside production and required in the worker's production
   * config; undefined only in a production API, which never uses it.
   */
  abstract readonly GOTENBERG_URL?: string | undefined;
  abstract readonly GOTENBERG_TIMEOUT_MS: number;
  abstract readonly GOTENBERG_MAX_BYTES: number;
}

/** The API's config: the core plus its port and the OIDC settings. */
export abstract class AppConfig extends CoreConfig {
  abstract readonly API_PORT: number;
  abstract readonly OIDC_ISSUER: string;
  abstract readonly OIDC_AUDIENCE: string;
  abstract readonly OIDC_CLIENT_ID?: string | undefined;
  /** Never empty: the `azp` values the verifier accepts. */
  abstract readonly OIDC_ALLOWED_AZP: readonly string[];
  /** API-only secrets: undefined outside production when unset (see CoreConfig's token). */
  abstract readonly DOCS_LINK_SECRET?: string | undefined;
  abstract readonly ZITADEL_ACTIONS_SIGNING_KEY?: string | undefined;
  /** Postal bounce webhook secret; undefined means the webhook refuses every call. */
  abstract readonly POSTAL_WEBHOOK_SECRET?: string | undefined;
  /**
   * The field-encryption keyring (FIELD_ENC_KEYS, FIELD_ENC_ACTIVE_KID and FIELD_ENC_FP_KID, parsed).
   * Always set in production; undefined outside production when unset, and CryptoModule then refuses
   * to build its cipher.
   */
  abstract readonly FIELD_ENC_KEYS?: FieldKeyring | undefined;
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
