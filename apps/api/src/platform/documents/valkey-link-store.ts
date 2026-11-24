// The real LinkStore: one SET NX EX against Valkey. Kept apart from signed-link.ts so that file has no
// network code and its tests need no Valkey. Serves NFR Security (single-use links).
import { Injectable, type OnApplicationShutdown } from '@nestjs/common';
import { Redis, type RedisOptions } from 'ioredis';

import { redisOptionsFromUrl } from '../queue/redis-options';
import type { LinkStore } from './signed-link';

/** How long a link claim waits to connect, and for its answer. */
export const LINK_STORE_TIMEOUT_MS = 1_500;

@Injectable()
export class ValkeyLinkStore implements LinkStore, OnApplicationShutdown {
  private readonly redis: Redis;

  constructor(valkeyUrl: string) {
    // lazyConnect: building the module must not need Valkey. Few retries: a download should fail fast
    // (closed) rather than hang while Valkey is down.
    this.redis = new Redis({
      ...(redisOptionsFromUrl(valkeyUrl) as RedisOptions),
      lazyConnect: true,
      // No offline queue: a SET issued while Valkey is unreachable must fail now. Queued, it would be applied after
      // the reconnect, long after the request gave up, and burn a link nobody was served by.
      enableOfflineQueue: false,
      maxRetriesPerRequest: 2,
      // A host that drops packets would otherwise hold the connect for ioredis's 10 s default.
      connectTimeout: LINK_STORE_TIMEOUT_MS,
      commandTimeout: LINK_STORE_TIMEOUT_MS,
    });
  }

  async claim(key: string, ttlSeconds: number): Promise<boolean> {
    try {
      await this.ready();
      // SET key 1 EX ttl NX answers "OK" only when the key did not exist: that is the single use.
      return (await this.redis.set(key, '1', 'EX', ttlSeconds, 'NX')) === 'OK';
    } catch (error) {
      // The SET may have reached Valkey even though its answer did not come back in time. The caller sees a failed
      // claim and serves nothing, so give the link back: the DEL travels on the same connection, after the SET.
      // If the DEL fails as well, the link stays burned until the claim's own TTL ends (fail closed, never open).
      await this.redis.del(key).catch(() => undefined);
      throw error;
    }
  }

  /** Waits (at most LINK_STORE_TIMEOUT_MS) for a usable connection; with no offline queue, a command needs one. */
  private async ready(): Promise<void> {
    if (this.redis.status === 'ready') return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onReady: (() => void) | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        onReady = resolve;
        this.redis.once('ready', resolve);
        timer = setTimeout(
          () => reject(new Error(`valkey not ready after ${LINK_STORE_TIMEOUT_MS} ms`)),
          LINK_STORE_TIMEOUT_MS,
        );
        if (this.redis.status === 'wait') this.redis.connect().catch(reject);
      });
    } finally {
      clearTimeout(timer);
      if (onReady !== undefined) this.redis.off('ready', onReady);
    }
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.redis.status !== 'end') await this.redis.quit().catch(() => undefined);
  }
}
