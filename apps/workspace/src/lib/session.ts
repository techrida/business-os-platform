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

/** How long a command waits for a client that is still connecting. */
const CONNECT_WAIT_MS = 1000;
const CONNECTING_STATES: ReadonlySet<string> = new Set(['connecting', 'connect', 'reconnecting']);

/**
 * Resolves once `client` is ready, or after CONNECT_WAIT_MS, whichever comes first. Without the
 * offline queue ioredis rejects any command sent while it is still connecting, which would fail
 * the first request after every start (the clients connect lazily, on first use). A client that
 * is still not ready after the wait gets the command anyway and fails fast.
 */
export function whenReady(client: Redis): Promise<Redis> {
  if (!CONNECTING_STATES.has(client.status)) return Promise.resolve(client);
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      client.off('ready', done);
      resolve(client);
    };
    const timer = setTimeout(done, CONNECT_WAIT_MS);
    client.once('ready', done);
  });
}

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

/**
 * Resolves the session from the cookie, or null.
 *
 * Enforces the idle and absolute limits (destroying an expired record), slides `lastSeenAt` and
 * the key TTL, and refreshes the access token when fewer than 60 s remain. A failed refresh
 * destroys the session. It never writes cookies: Server Components may not, so a dead cookie is
 * left for the next sign-in or logout to overwrite.
 *
 * Fails closed and never throws on Valkey errors (CR-03): Valkey runs `noeviction`, so when it is
 * full every write is refused, and a throw here would turn every page into a 500. The user is
 * treated as signed out instead.
 */
export async function getSession(): Promise<Session | null> {
  const id = (await cookies()).get(SESSION_COOKIE)?.value;
  // Validate before building a Redis key from browser input.
  if (!id || !SESSION_ID_PATTERN.test(id)) return null;

  try {
    return await resolveSession(id);
  } catch (err) {
    // Only the error name: ioredis errors carry the command arguments, which here include the
    // session id and the stored record with its tokens.
    console.warn(
      JSON.stringify({
        event: 'session.valkey_unavailable',
        error: err instanceof Error ? err.name : typeof err,
      }),
    );
    return null;
  }
}

/** The Valkey part of `getSession`, for an id that already passed the pattern check. */
async function resolveSession(id: string): Promise<Session | null> {
  const client = await readyRedis();
  const raw = await client.get(sessionKey(id));
  if (raw === null) return null;

  const record = unseal(id, raw);
  const now = nowSeconds();
  if (!record || isExpired(record, now)) {
    await destroySession(id);
    return null;
  }

  if (record.accessExp - now < REFRESH_MARGIN_SECONDS) {
    const refreshed = await refreshUnderLock(id, record, now);
    return refreshed ? toSession(id, refreshed) : null;
  }

  const slid: StoredSession = { ...record, lastSeenAt: now };
  const written = await client.eval(
    CAS_SCRIPT,
    1,
    sessionKey(id),
    raw,
    seal(id, slid),
    String(ttlFor(slid, now)),
  );
  if (written === 'OK') return toSession(id, slid);

  // The record changed under us: deleted (logout) or rewritten by a concurrent request, which
  // already slid it. Trust what is there now rather than overwrite it.
  const latestRaw = await client.get(sessionKey(id));
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
      await destroySession(id);
      return null;
    }
    if (latest.accessExp - now >= REFRESH_MARGIN_SECONDS) return latest;

    if (latest.refreshToken === undefined) {
      // No way to get a fresh token: treat it as a failed refresh.
      await destroySession(id);
      return null;
    }

    let tokens: Awaited<ReturnType<typeof refreshTokens>>;
    try {
      tokens = await refreshTokens(latest.refreshToken);
    } catch {
      // Deliberately not logging the error: it can echo request parameters, including the token.
      await destroySession(id);
      return null;
    }

    const updated = toRecord({
      ...latest,
      accessToken: tokens.accessToken,
      accessExp: tokens.accessExp,
      // Keep the old values when the provider does not send new ones.
      ...(tokens.refreshToken !== undefined ? { refreshToken: tokens.refreshToken } : {}),
      ...(tokens.idToken !== undefined ? { idToken: tokens.idToken } : {}),
      lastSeenAt: now,
    });
    // XX: only if the session still exists, so a concurrent logout is not undone. We hold the
    // lock and the newest tokens, so overwriting a concurrent slide is correct here.
    const written = await client.set(
      sessionKey(id),
      seal(id, updated),
      'EX',
      ttlFor(updated, now),
      'XX',
    );
    return written === 'OK' ? updated : null;
  } finally {
    await client.eval(UNLOCK_SCRIPT, 1, refreshLockKey(id), lockToken);
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
