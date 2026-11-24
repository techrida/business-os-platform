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
      maxRetriesPerRequest: 2,
      // A host that drops packets would otherwise hold the connect for ioredis's 10 s default.
      connectTimeout: LINK_STORE_TIMEOUT_MS,
      commandTimeout: LINK_STORE_TIMEOUT_MS,
    });
  }

  async claim(key: string, ttlSeconds: number): Promise<boolean> {
    // SET key 1 EX ttl NX answers "OK" only when the key did not exist: that is the single use.
    return (await this.redis.set(key, '1', 'EX', ttlSeconds, 'NX')) === 'OK';
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.redis.status !== 'end') await this.redis.quit().catch(() => undefined);
  }
}
