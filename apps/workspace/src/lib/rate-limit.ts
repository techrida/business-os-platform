import { isIP } from 'node:net';

import type { Redis } from 'ioredis';

import { getEnv } from './env';
import { getOidcRedis } from './oidc';
import { clientStatus, errorCategory, whenReady } from './valkey-health';

/**
 * Fixed-window rate limit for `/auth/login` (CR-03).
 *
 * Every login stores about 2.3 KB of OIDC state in Valkey for 10 minutes. That state lives on its
 * own server (`valkey-oidc`, 32 MB, `volatile-ttl`), so unlimited anonymous logins can fill only
 * that one and never the memory sessions need. This caps logins per client IP. The counter lives
 * on the same server: if the limiter used the session Valkey, an outage there would switch it off
 * (it fails open) while `valkey-oidc` could still be filled. The counter costs one small key per
 * IP per window, and `volatile-ttl` evicts only keys that have a TTL, which `HIT_SCRIPT` always
 * sets.
 *
 * Production is fixed at `LOGIN_RATE_LIMIT` and `LOGIN_RATE_WINDOW_S`. The one exception is the dev
 * override `BOS_DEV_LOGIN_RATE_LIMIT` (owned and validated by `lib/env.ts`): all local traffic shares
 * one Caddy client IP, so a persona e2e run would trip 20 per minute. `getEnv()` accepts it only
 * when `WORKSPACE_PUBLIC_URL` is `localhost` or `*.localhost`, and only 21 to 10000, so it can
 * raise the limit but never lower it, and a production host fails env validation if it is set.
 */
export const LOGIN_RATE_LIMIT = 20;
export const LOGIN_RATE_WINDOW_S = 60;

const loginKey = (ip: string) => `ws:rl:login:${ip}`;

/**
 * INCR and EXPIRE as one step, so a crash between them cannot leave a counter without an expiry
 * (and so `volatile-ttl` can always evict it).
 * The TTL check (not `n == 1`) also repairs a key that lost its expiry some other way, which
 * would otherwise block that IP forever. Returns the count and the seconds left in the window.
 */
const HIT_SCRIPT = `
local n = redis.call('INCR', KEYS[1])
if redis.call('TTL', KEYS[1]) < 0 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
end
return {n, redis.call('TTL', KEYS[1])}
`;

export type RateLimitResult = { allowed: true } | { allowed: false; retryAfter: number };

/**
 * The client IP: the first hop of `X-Forwarded-For`, else `X-Real-IP`, else `'unknown'`.
 *
 * Trusting the first hop is safe only because Caddy is the sole way in (compose.prod.yaml
 * publishes no port but Caddy's) and, with no `trusted_proxies` configured, it replaces any
 * client-sent `X-Forwarded-For` with the real peer address. In dev, `next dev` on :3000 is also
 * reachable directly, so there the header is spoofable. Anything that is not a literal IP is
 * ignored, which also bounds the key length.
 */
export function clientIp(headers: Headers): string {
  const forwarded = headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  if (forwarded && isIP(forwarded)) return forwarded;
  const real = headers.get('x-real-ip')?.trim();
  if (real && isIP(real)) return real;
  return 'unknown';
}

/**
 * Counts this login attempt and says whether it may go ahead.
 *
 * Fails OPEN on Valkey errors: this guard exists to protect `valkey-oidc`, and when that server is
 * down or full the login cannot store its OIDC state anyway, so blocking adds nothing but a second
 * outage mode. The warning carries only allow-listed fields (error category and client state),
 * never the error itself: ioredis errors hold the command arguments.
 *
 * Like the OIDC state writes, it first waits (up to a second) for a client that is still
 * connecting: without the offline queue ioredis rejects a command sent before the connection is
 * ready, which used to switch the limiter off for the first logins after every start.
 */
export async function checkLoginRateLimit(req: Request): Promise<RateLimitResult> {
  const key = loginKey(clientIp(req.headers));
  let count: number;
  let ttl: number;
  let client: Redis | undefined;
  try {
    client = getOidcRedis();
    const redis = await whenReady(client);
    const reply = (await redis.eval(HIT_SCRIPT, 1, key, String(LOGIN_RATE_WINDOW_S))) as [
      number,
      number,
    ];
    [count, ttl] = reply;
  } catch (err) {
    console.warn(
      JSON.stringify({
        event: 'auth.login_rate_limit_unavailable',
        category: errorCategory(err),
        clientStatus: clientStatus(client),
      }),
    );
    return { allowed: true };
  }
  if (count <= (getEnv().BOS_DEV_LOGIN_RATE_LIMIT ?? LOGIN_RATE_LIMIT)) return { allowed: true };
  const retryAfter = Number.isInteger(ttl) && ttl >= 1 ? ttl : LOGIN_RATE_WINDOW_S;
  return { allowed: false, retryAfter };
}
