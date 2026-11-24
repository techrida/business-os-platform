// The real LinkStore: one SET NX EX against Valkey. Kept apart from signed-link.ts so that file has no
// network code and its tests need no Valkey. Serves NFR Security (single-use links).
import { Injectable, type OnApplicationShutdown } from '@nestjs/common';
import { Redis, type RedisOptions } from 'ioredis';

import { redisOptionsFromUrl } from '../queue/redis-options';
import type { LinkStore } from './signed-link';

@Injectable()
export class ValkeyLinkStore implements LinkStore, OnApplicationShutdown {
  private readonly redis: Redis;

  constructor(valkeyUrl: string) {
    // lazyConnect: building the module must not need Valkey. Few retries: a download should fail fast
    // (closed) rather than hang while Valkey is down.
    // replyMapping 'legacy' (ioredis 6's default, stated so the constructor overload resolves under
    // exactOptionalPropertyTypes) keeps the v5 reply shapes on the RESP3 wire.
    this.redis = new Redis({
      ...(redisOptionsFromUrl(valkeyUrl) as RedisOptions),
      lazyConnect: true,
      maxRetriesPerRequest: 2,
      replyMapping: 'legacy',
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
