import 'server-only';

import { createHash, randomBytes } from 'node:crypto';

import { OrgKindSchema } from '@bos/contracts';
import { Redis, type RedisOptions } from 'ioredis';
import { cookies } from 'next/headers';
import { z } from 'zod';

import { cookieName } from './cookie-name';
import { getEnv } from './env';
import { refreshTokens } from './oidc';
import { type Keyring, openSessionValue, sealSessionValue } from './session-crypto';
import { SessionUnavailableError } from './session-unavailable';
import {
  clientStatus,
  CONNECT_WAIT_MS,
  errorCategory,
  whenReady,
  withDeadline,
} from './valkey-health';

/**
 * Server-side sessions for the workspace BFF.
 *
 * The browser only ever holds an opaque 256-bit id in a `__Host-` cookie. Tokens live in
 * Valkey at `ws:sess:<SHA-256 of the id, hex>` and never reach the browser. The key is hashed so
 * that anyone who can list keys (KEYS, SCAN, an AOF or RDB file) learns no usable cookie value,
 * and each value is an AES-256-GCM envelope bound to its key (see session-crypto.ts). The ID
 * token is kept in the record for one reader only: logout sends it as `id_token_hint`, without
 * which ZITADEL does not end its own session. It never leaves this module through `getSession`,
 * and is never logged. All timestamps are epoch seconds, the same unit as a JWT `exp`.
 */

/** `__Host-` makes the browser insist on Secure, Path=/ and no Domain, so no subdomain can plant or read it. */
export const SESSION_COOKIE = cookieName('session');
/** Sliding idle timeout: a session unused for this long is gone. */
export const IDLE_SECONDS = 3600;
/** Hard cap from sign-in, however active the user is. */
export const ABSOLUTE_SECONDS = 86400;

/**
 * A sliding write is skipped when the record was last written less than this many seconds ago, so
 * a busy page does not write the same record on every request. The idle limit is measured from the
 * last write, so it can end up to this many seconds early.
 */
const SLIDE_MIN_INTERVAL_SECONDS = 60;

/** Refresh the access token when fewer than this many seconds remain, so API calls never race its expiry. */
const REFRESH_MARGIN_SECONDS = 60;
/** Upper bound on one refresh round-trip; the lock expires by itself if a process dies mid-refresh. */
const REFRESH_LOCK_MS = 10_000;

export interface Session {
  id: string;
  sub: string;
  orgId: string;
  orgKind: 'staff' | 'customer' | 'vendor';
  roles: string[];
  accessToken: string;
  refreshToken?: string;
  accessExp: number;
  createdAt: number;
  lastSeenAt: number;
}

/**
 * What is stored in Valkey: the session minus its id (the id is the key), plus the ID token,
 * which only `peekSession` hands out (to logout). `Session` leaves it out on purpose, so no
 * Server Component holds it one prop away from the browser.
 */
type StoredSession = Omit<Session, 'id'> & { idToken?: string };

const StoredSessionSchema = z.object({
  sub: z.string().min(1),
  orgId: z.string().min(1),
  orgKind: OrgKindSchema,
  roles: z.array(z.string()),
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1).optional(),
  idToken: z.string().min(1).optional(),
  accessExp: z.number().int(),
  createdAt: z.number().int(),
  lastSeenAt: z.number().int(),
});

/** 32 random bytes in base64url is exactly 43 characters with no padding. */
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/**
 * Valkey key names. Callers pass the raw id (after the SESSION_ID_PATTERN check); only these
 * functions hash it, so the raw id never appears in a key (CR-13).
 */
const hashId = (id: string) => createHash('sha256').update(id).digest('hex');
const sessionKey = (id: string) => `ws:sess:${hashId(id)}`;
const refreshLockKey = (id: string) => `${sessionKey(id)}:refresh`;

/** Reads `Date.now()` so tests control time with `vi.setSystemTime`. */
function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

// ---------------------------------------------------------------------------------------------
// Redis
// ---------------------------------------------------------------------------------------------

/**
 * Fail fast in a Valkey outage (CR-03): a command gets one second and one retry, and with the
 * offline queue off nothing piles up waiting for a connection, so a request fails in about a
 * second instead of hanging. Shared with the OIDC state client.
 */
export const VALKEY_CLIENT_OPTIONS = {
  commandTimeout: 1000,
  enableOfflineQueue: false,
  maxRetriesPerRequest: 1,
} as const satisfies RedisOptions;

// `whenReady` lives in valkey-health.ts (the login rate limiter needs it without `server-only`);
// it is re-exported here for the OIDC state client, which has always imported it from this module.
export { whenReady };

let redis: Redis | undefined;

/** One shared connection per process, created on first use (so `next build` needs no Valkey). */
export function getRedis(): Redis {
  redis ??= new Redis(getEnv().VALKEY_URL, { ...VALKEY_CLIENT_OPTIONS });
  return redis;
}

/** `getRedis()` once it can take commands; see `whenReady`. */
function readyRedis(): Promise<Redis> {
  return whenReady(getRedis());
}

/** Tests only: inject an ioredis-mock instance, or pass undefined to drop the injected one. */
export function __setRedisForTests(client: Redis | undefined): void {
  redis = client;
}

/**
 * Compare-and-set: write the new value only if the key still holds exactly what we read.
 * This stops a slow request from writing back stale tokens over a fresh refresh, and from
 * resurrecting a session that a concurrent logout just deleted (GET then returns false).
 */
const CAS_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[3])
end
return false
`;

/** Delete the lock only if we still own it, so a slow holder never frees someone else's lock. */
const UNLOCK_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

// ---------------------------------------------------------------------------------------------
// Record helpers
// ---------------------------------------------------------------------------------------------

/** Explicit field copy: never persist stray properties a caller happened to pass in. */
function toRecord(data: StoredSession): StoredSession {
  return {
    sub: data.sub,
    orgId: data.orgId,
    orgKind: data.orgKind,
    roles: [...data.roles],
    accessToken: data.accessToken,
    ...(data.refreshToken !== undefined ? { refreshToken: data.refreshToken } : {}),
    ...(data.idToken !== undefined ? { idToken: data.idToken } : {}),
    accessExp: data.accessExp,
    createdAt: data.createdAt,
    lastSeenAt: data.lastSeenAt,
  };
}

/** Returns null for anything that is not a well-formed record (corrupt or tampered data). */
function parseRecord(raw: string): StoredSession | null {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  const parsed = StoredSessionSchema.safeParse(json);
  if (!parsed.success) return null;
  const { refreshToken, idToken, ...rest } = parsed.data;
  return toRecord({
    ...rest,
    ...(refreshToken !== undefined ? { refreshToken } : {}),
    ...(idToken !== undefined ? { idToken } : {}),
  });
}

/** Built from the env on each call, so it never outlives a reset env in tests. */
function keyring(): Keyring {
  const env = getEnv();
  return {
    currentId: env.SESSION_ENC_KEY_ID,
    keys: new Map([[env.SESSION_ENC_KEY_ID, Buffer.from(env.SESSION_ENC_KEY, 'base64')]]),
  };
}

/** The stored form of a record: encrypted, and bound to the session's Valkey key. */
function seal(id: string, record: StoredSession): string {
  return sealSessionValue(JSON.stringify(record), sessionKey(id), keyring());
}

/**
 * Decrypts and parses a stored value, or null. A value that does not decrypt (old plaintext
 * format, another key, tampering) counts as no session. Only the event name is logged.
 */
function unseal(id: string, raw: string): StoredSession | null {
  const plaintext = openSessionValue(raw, sessionKey(id), keyring());
  if (plaintext === null) {
    console.warn(JSON.stringify({ event: 'session.decrypt_failed' }));
    return null;
  }
  return parseRecord(plaintext);
}

/** Seconds the key may live: whichever of the idle and absolute limits comes first. */
function ttlFor(record: StoredSession, now: number): number {
  const idleLeft = IDLE_SECONDS - (now - record.lastSeenAt);
  const absoluteLeft = ABSOLUTE_SECONDS - (now - record.createdAt);
  return Math.min(idleLeft, absoluteLeft);
}

function isExpired(record: StoredSession, now: number): boolean {
  return now - record.lastSeenAt >= IDLE_SECONDS || now - record.createdAt >= ABSOLUTE_SECONDS;
}

// ---------------------------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------------------------

/** Stores a new session and returns its id. The caller sets the cookie with `setSessionCookie`. */
export async function createSession(
  data: Omit<StoredSession, 'createdAt' | 'lastSeenAt'>,
): Promise<string> {
  const id = randomBytes(32).toString('base64url');
  const now = nowSeconds();
  const record = toRecord({ ...data, createdAt: now, lastSeenAt: now });
  // NX: a collision on 256 random bits is not a real risk, but never overwrite an existing session.
  const ok = await (
    await readyRedis()
  ).set(sessionKey(id), seal(id, record), 'EX', ttlFor(record, now), 'NX');
  if (ok !== 'OK') throw new Error('session id collision');
  return id;
}

export async function setSessionCookie(id: string): Promise<void> {
  (await cookies()).set(SESSION_COOKIE, id, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    maxAge: ABSOLUTE_SECONDS,
  });
}

/**
 * Expire the cookie with the same attributes it was set with. `cookies().delete()` would send
 * a Set-Cookie without `Secure`, and browsers ignore that for a `__Host-` name, leaving the
 * old cookie in place.
 */
export async function clearSessionCookie(): Promise<void> {
  (await cookies()).set(SESSION_COOKIE, '', {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    maxAge: 0,
  });
}

export async function destroySession(id: string): Promise<void> {
  if (!SESSION_ID_PATTERN.test(id)) return;
  await (await readyRedis()).del(sessionKey(id));
}

/**
 * Reads a live record by its cookie id for logout, which needs the ID token as `id_token_hint`
 * before it destroys the record. Unlike `getSession` it never slides the TTL, refreshes or
 * deletes anything. Null for a malformed id, a missing, undecryptable or expired record.
 *
 * Throws on Valkey errors: the caller logs only the error name (ioredis errors carry the
 * command arguments) and carries on without a hint.
 */
export async function peekSession(id: string): Promise<{ idToken?: string } | null> {
  if (!SESSION_ID_PATTERN.test(id)) return null;
  const raw = await (await readyRedis()).get(sessionKey(id));
  if (raw === null) return null;
  const record = unseal(id, raw);
  if (!record || isExpired(record, nowSeconds())) return null;
  return record.idToken !== undefined ? { idToken: record.idToken } : {};
}

/** Total time one request may spend reading its session record, including the one retry. */
const READ_DEADLINE_MS = 2000;

/** Where a store failure happened. `cleanup` is the best-effort delete of an invalid record. */
type StoreStage = 'read' | 'slide' | 'rotate' | 'cleanup';
/** What the failure meant for this request. */
type StoreOutcome = 'unavailable' | 'kept' | 'signed_out';

/**
 * One structured line per store failure. Only allow-listed values: never the error message
 * (ioredis errors carry the command arguments, which here include the session key and the stored
 * record with its tokens), never a key name or cookie value.
 */
function logStoreFailure(
  stage: StoreStage,
  outcome: StoreOutcome,
  started: number,
  err: unknown,
): void {
  console.warn(
    JSON.stringify({
      event: 'session.valkey_error',
      stage,
      outcome,
      elapsedMs: Math.round(performance.now() - started),
      clientStatus: clientStatus(redis),
      category: errorCategory(err),
    }),
  );
}

/**
 * Resolves the session from the cookie: the session, or null when there definitively is none.
 *
 * Null means "sign in": no cookie, a malformed id, no record, a record that does not decrypt or
 * parse, an idle- or absolute-expired record (which is destroyed), or a failed token refresh
 * (which destroys the session). It never writes cookies: Server Components may not, so a dead
 * cookie is left for the next sign-in or logout to overwrite.
 *
 * Throws SessionUnavailableError when Valkey cannot say (CR-03 still holds: never a signed-in
 * answer without a record that was read). The cookie and the record are left alone, callers show
 * a retryable notice (pages) or answer 503 (Route Handlers), and nothing protected is served. A
 * transient store failure must not log the user out, which is what returning null used to do.
 *
 * The read gets one readiness-aware retry within READ_DEADLINE_MS. A failed slide is not retried:
 * it keeps the session as read (the TTL catches up on the next request). The refresh itself is
 * never repeated, because that would spend a rotated refresh token twice; only the write of the
 * rotated tokens is retried once (up to about 2 s more: the ready wait plus the command timeout).
 * If that also fails, the current token is kept while it is still valid.
 */
export function getSession(options?: GetSessionOptions): Promise<Session | null> {
  return readSessionOncePerRender(options?.slide ?? true);
}

/** `getSession` options. */
export interface GetSessionOptions {
  /**
   * Whether this read counts as activity and moves the idle timer (default true). Background
   * polls (badge counts, notifications, telemetry) pass false: they still refresh tokens, but a
   * tab left open must not keep the session alive.
   */
  slide?: boolean;
}

async function readSessionOncePerRender(slide: boolean): Promise<Session | null> {
  const id = (await cookies()).get(SESSION_COOKIE)?.value;
  // Validate before building a Redis key from browser input.
  if (!id || !SESSION_ID_PATTERN.test(id)) return null;

  const started = performance.now();
  const raw = await readSessionValue(id, started);
  if (raw === null) return null;
  return resolveRecord(id, raw, started, slide);
}

/**
 * GET of the session record, with one retry after waiting for the client to be ready again
 * (a dropped connection reconnects in the background). Throws SessionUnavailableError when
 * neither attempt answers before the deadline.
 */
async function readSessionValue(id: string, started: number): Promise<string | null> {
  const left = () => READ_DEADLINE_MS - (performance.now() - started);
  let lastError: unknown;
  for (let attempt = 0; attempt < 2 && left() > 0; attempt++) {
    try {
      const client = await whenReady(getRedis(), Math.min(CONNECT_WAIT_MS, left()));
      return await withDeadline(client.get(sessionKey(id)), left());
    } catch (err) {
      lastError = err;
    }
  }
  logStoreFailure('read', 'unavailable', started, lastError);
  throw new SessionUnavailableError();
}

/** Deletes an invalid or expired record. The user is signed out whether or not the delete lands. */
async function destroyQuietly(id: string, started: number): Promise<void> {
  try {
    await destroySession(id);
  } catch (err) {
    logStoreFailure('cleanup', 'signed_out', started, err);
  }
}

/** The rest of `getSession` once the record was read: expiry, refresh and the sliding TTL. */
async function resolveRecord(
  id: string,
  raw: string,
  started: number,
  slide: boolean,
): Promise<Session | null> {
  const record = unseal(id, raw);
  const now = nowSeconds();
  if (!record || isExpired(record, now)) {
    await destroyQuietly(id, started);
    return null;
  }

  if (record.accessExp - now < REFRESH_MARGIN_SECONDS) {
    let refreshed: StoredSession | null;
    try {
      refreshed = await refreshUnderLock(id, record, now, started, slide);
    } catch (err) {
      // Valkey failed around the refresh. The record we read is valid; use its access token while
      // it lasts. Never retry: the refresh may already have rotated the refresh token.
      if (record.accessExp > nowSeconds() && !isExpired(record, nowSeconds())) {
        logStoreFailure('rotate', 'kept', started, err);
        return toSession(id, record);
      }
      logStoreFailure('rotate', 'unavailable', started, err);
      throw new SessionUnavailableError();
    }
    return refreshed ? toSession(id, refreshed) : null;
  }

  // A background read leaves the idle timer alone, and so does a read right after a write.
  if (!slide || now - record.lastSeenAt < SLIDE_MIN_INTERVAL_SECONDS) {
    return toSession(id, record);
  }

  const client = getRedis();
  const slid: StoredSession = { ...record, lastSeenAt: now };
  let written: unknown;
  try {
    written = await client.eval(
      CAS_SCRIPT,
      1,
      sessionKey(id),
      raw,
      seal(id, slid),
      String(ttlFor(slid, now)),
    );
  } catch (err) {
    // The read proved the session valid; only its idle timer did not move. Keep the user in.
    logStoreFailure('slide', 'kept', started, err);
    return toSession(id, record);
  }
  if (written === 'OK') return toSession(id, slid);

  // The record changed under us: deleted (logout) or rewritten by a concurrent request, which
  // already slid it. Trust what is there now rather than overwrite it.
  let latestRaw: string | null;
  try {
    latestRaw = await client.get(sessionKey(id));
  } catch (err) {
    // A logout may have just deleted it, so the earlier read no longer proves anything.
    logStoreFailure('read', 'unavailable', started, err);
    throw new SessionUnavailableError();
  }
  const latest = latestRaw === null ? null : unseal(id, latestRaw);
  if (!latest || isExpired(latest, now)) return null;
  return toSession(id, latest);
}

/**
 * ZITADEL rotates refresh tokens, so two requests refreshing at once would spend the same token
 * twice and the loser would destroy a valid session. One request takes a short lock and
 * refreshes. The others keep using the current access token while it is still valid.
 */
async function refreshUnderLock(
  id: string,
  stale: StoredSession,
  now: number,
  started: number,
  slide: boolean,
): Promise<StoredSession | null> {
  const client = await readyRedis();
  const lockToken = randomBytes(16).toString('base64url');
  const locked = await client.set(refreshLockKey(id), lockToken, 'PX', REFRESH_LOCK_MS, 'NX');
  if (locked !== 'OK') {
    return stale.accessExp > now ? stale : null;
  }

  try {
    // Re-read inside the lock: another request may have finished a refresh since our first read.
    const latestRaw = await client.get(sessionKey(id));
    const latest = latestRaw === null ? null : unseal(id, latestRaw);
    if (!latest || isExpired(latest, now)) {
      await destroyQuietly(id, started);
      return null;
    }
    if (latest.accessExp - now >= REFRESH_MARGIN_SECONDS) return latest;

    if (latest.refreshToken === undefined) {
      // No way to get a fresh token: treat it as a failed refresh.
      await destroyQuietly(id, started);
      return null;
    }

    let tokens: Awaited<ReturnType<typeof refreshTokens>>;
    try {
      tokens = await refreshTokens(latest.refreshToken);
    } catch {
      // Deliberately not logging the error: it can echo request parameters, including the token.
      await destroyQuietly(id, started);
      return null;
    }

    const updated = toRecord({
      ...latest,
      accessToken: tokens.accessToken,
      accessExp: tokens.accessExp,
      // Keep the old values when the provider does not send new ones.
      ...(tokens.refreshToken !== undefined ? { refreshToken: tokens.refreshToken } : {}),
      ...(tokens.idToken !== undefined ? { idToken: tokens.idToken } : {}),
      // A background read that happens to refresh the token must not renew the idle timer.
      lastSeenAt: slide ? now : latest.lastSeenAt,
    });
    // XX: only if the session still exists, so a concurrent logout is not undone. We hold the
    // lock and the newest tokens, so overwriting a concurrent slide is correct here.
    const sealed = seal(id, updated);
    const ttl = ttlFor(updated, now);
    let written: string | null;
    try {
      written = await client.set(sessionKey(id), sealed, 'EX', ttl, 'XX');
    } catch {
      // The provider has already rotated the refresh token, so losing this write would sign the
      // user out at the next refresh. Retry once after a reconnect: the same value, still under
      // the lock, and XX so a concurrent logout is still not undone.
      written = await (await whenReady(client)).set(sessionKey(id), sealed, 'EX', ttl, 'XX');
    }
    return written === 'OK' ? updated : null;
  } finally {
    // Best effort: the lock expires by itself after REFRESH_LOCK_MS, and a failed unlock must not
    // turn a stored refresh into an error.
    await client.eval(UNLOCK_SCRIPT, 1, refreshLockKey(id), lockToken).catch(() => undefined);
  }
}

/** The public form: never carries the ID token (see StoredSession). */
function toSession(id: string, record: StoredSession): Session {
  const { idToken: _idToken, ...rest } = toRecord(record);
  return { id, ...rest };
}

// ---------------------------------------------------------------------------------------------
// returnTo sanitising
// ---------------------------------------------------------------------------------------------

const RETURN_TO_BASE = 'https://workspace.invalid';
const MAX_RETURN_TO_LENGTH = 2048;
/** More nested percent-encoding than this is not a real link; refuse it. */
const MAX_DECODE_ROUNDS = 4;

/**
 * True for a same-origin path: one leading `/`, then no second `/`, no backslash anywhere and no
 * control characters. Browsers treat `//host` and `/\host` as a different host, and silently
 * drop tabs and newlines, which would turn `/\t/evil` into `//evil`.
 */
function isLocalPath(value: string): boolean {
  if (!value.startsWith('/') || value.startsWith('//')) return false;
  for (const ch of value) {
    const code = ch.charCodeAt(0);
    if (ch === '\\' || code < 0x20 || (code >= 0x7f && code <= 0x9f)) return false;
  }
  return true;
}

/**
 * Returns `raw` if it is a same-origin relative path, else `/`. Used for post-login redirects,
 * where an attacker-controlled value would otherwise be an open redirect.
 *
 * Every percent-decoded layer is checked too (`/%2f%2fevil`, `/%5cevil`), because a proxy or a
 * later redirect may decode the value again. The URL-normalised result is checked last, since
 * dot segments can collapse a harmless-looking input (`/a/..//evil`) into `//evil`.
 */
export function safeReturnTo(raw: string | null | undefined): string {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_RETURN_TO_LENGTH) return '/';
  if (!isLocalPathAtEveryDecoding(raw)) return '/';

  let url: URL;
  try {
    url = new URL(raw, RETURN_TO_BASE);
  } catch {
    return '/';
  }
  if (url.origin !== RETURN_TO_BASE) return '/';
  const normalised = url.pathname + url.search + url.hash;
  // Normalising can expose a new prefix: `/.%2e/%2fevil` becomes `/%2fevil`, which decodes to
  // `//evil`. So the output gets the same layered check as the input.
  return isLocalPathAtEveryDecoding(normalised) ? normalised : '/';
}

/** `isLocalPath` holds for the value and for each percent-decoded layer of it. */
function isLocalPathAtEveryDecoding(value: string): boolean {
  let layer = value;
  for (let round = 0; ; round++) {
    if (!isLocalPath(layer)) return false;
    let decoded: string;
    try {
      decoded = decodeURIComponent(layer);
    } catch {
      return false; // malformed escape such as `%E0%A4`
    }
    if (decoded === layer) return true;
    if (round >= MAX_DECODE_ROUNDS) return false;
    layer = decoded;
  }
}
