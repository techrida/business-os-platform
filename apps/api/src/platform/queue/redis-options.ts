import type { ConnectionOptions } from 'bullmq';

/**
 * Turns `VALKEY_URL` into the connection object BullMQ wants. BullMQ takes ioredis options, and
 * ioredis options have no `url` field, so the URL is split here once (and unit tested).
 * BullMQ itself sets `maxRetriesPerRequest: null` on its blocking worker connections.
 */
export function redisOptionsFromUrl(value: string): ConnectionOptions {
  const url = new URL(value);
  const db = url.pathname.length > 1 ? Number(url.pathname.slice(1)) : undefined;
  return {
    host: url.hostname,
    port: url.port === '' ? 6379 : Number(url.port),
    ...(url.username !== '' ? { username: decodeURIComponent(url.username) } : {}),
    ...(url.password !== '' ? { password: decodeURIComponent(url.password) } : {}),
    ...(db !== undefined && Number.isInteger(db) ? { db } : {}),
    ...(url.protocol === 'rediss:' ? { tls: {} } : {}),
  };
}
