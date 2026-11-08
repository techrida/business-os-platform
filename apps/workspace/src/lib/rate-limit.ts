import { isIP } from 'node:net';

import { getRedis } from './session';

/**
 * Fixed-window rate limit for `/auth/login` (CR-03).
 *
 * Every login stores about 2.3 KB of OIDC state in Valkey for 10 minutes. Valkey runs
 * `noeviction` at 192 MB, shared with sessions and BullMQ, so unlimited anonymous logins fill it
 * and then every write fails. This caps logins per client IP. The counter itself costs one small
 * key per IP per window.
 *
 * Constants, not env vars: `lib/env.ts` owns the env schema. `LOGIN_RATE_LIMIT` and
 * `LOGIN_RATE_WINDOW_S` are the intended names if they ever become configurable.
 */
export const LOGIN_RATE_LIMIT = 20;
export const LOGIN_RATE_WINDOW_S = 60;

const loginKey = (ip: string) => `ws:rl:login:${ip}`;

/**
 * INCR and EXPIRE as one step, so a crash between them cannot leave a counter without an expiry.
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
 * Fails OPEN on Valkey errors: this guard exists to protect Valkey, and when Valkey is down or
 * full the login cannot store its OIDC state anyway, so blocking adds nothing but a second
 * outage mode. The warning carries only the error name, never the error itself: ioredis errors
 * hold the command arguments.
 */
export async function checkLoginRateLimit(req: Request): Promise<RateLimitResult> {
  const key = loginKey(clientIp(req.headers));
  let count: number;
  let ttl: number;
  try {
    const reply = (await getRedis().eval(HIT_SCRIPT, 1, key, String(LOGIN_RATE_WINDOW_S))) as [
      number,
      number,
    ];
    [count, ttl] = reply;
  } catch (err) {
    console.warn(
      JSON.stringify({
        event: 'auth.login_rate_limit_unavailable',
        error: err instanceof Error ? err.name : typeof err,
      }),
    );
    return { allowed: true };
  }
  if (count <= LOGIN_RATE_LIMIT) return { allowed: true };
  const retryAfter = Number.isInteger(ttl) && ttl >= 1 ? ttl : LOGIN_RATE_WINDOW_S;
  return { allowed: false, retryAfter };
}
