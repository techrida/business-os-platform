// The real LinkStore: one SET NX EX against Valkey. Kept apart from signed-link.ts so that file has no
// network code and its tests need no Valkey. Serves NFR Security (single-use links).
import { Injectable, type OnApplicationShutdown } from '@nestjs/common';
import { randomUUID } from 'node:crypto';

import { Redis, ReplyError, type RedisOptions } from 'ioredis';

import { redisOptionsFromUrl } from '../queue/redis-options';
import type { LinkStore } from './signed-link';

/** How long a link claim waits to connect, and for its answer. */
export const LINK_STORE_TIMEOUT_MS = 1_500;

/** Deletes the key only when it still holds the caller's nonce. */
const RELEASE_IF_OURS =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";

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
      // No offline queue: a SET issued while Valkey is unreachable must fail now. Queued, it would be applied after
      // the reconnect, long after the request gave up, and burn a link nobody was served by.
      enableOfflineQueue: false,
      // A SET sent just before the socket dropped must not be sent again after the reconnect.
      autoResendUnfulfilledCommands: false,
      maxRetriesPerRequest: 2,
      // A host that drops packets would otherwise hold the connect for ioredis's 10 s default.
      connectTimeout: LINK_STORE_TIMEOUT_MS,
      commandTimeout: LINK_STORE_TIMEOUT_MS,
      replyMapping: 'legacy',
    });
  }

  async claim(key: string, ttlSeconds: number): Promise<boolean> {
    // A value of our own, so a clean-up can tell this claim from one an earlier request made.
    const nonce = randomUUID();
    // Outside the try: when this fails no SET was sent, so there is nothing to give back.
    await this.ready();
    try {
      // SET key nonce EX ttl NX answers "OK" only when the key did not exist: that is the single use.
      return (await this.redis.set(key, nonce, 'EX', ttlSeconds, 'NX')) === 'OK';
    } catch (error) {
      // A server error reply (for example out of memory) proves the SET was not applied: nothing to undo. Any other
      // failure (a timeout, a lost connection) leaves it unknown whether the SET ran, and the caller serves nothing,
      // so give the link back, but only if the key still holds OUR nonce: a plain DEL would also remove the claim of
      // an earlier request that already used this link. If this fails too, the link stays burned until the claim's
      // TTL ends (fail closed, never open).
      if (!(error instanceof ReplyError)) await this.release(key, nonce);
      throw error;
    }
  }

  private async release(key: string, nonce: string): Promise<void> {
    try {
      await this.redis.eval(RELEASE_IF_OURS, 1, key, nonce);
    } catch {
      // Valkey is not answering: the claim's TTL is the backstop.
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

  onApplicationShutdown(): void {
    // disconnect, not quit: with no offline queue quit() rejects while Valkey is unreachable and leaves the socket open.
    this.redis.disconnect();
  }
}
