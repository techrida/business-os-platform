import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ValkeyLinkStore } from './valkey-link-store';

/**
 * ioredis 6 speaks RESP3 (the newer Redis wire protocol) by default. The link store must keep
 * working on it against the Valkey the stack ships (image pinned in infra/compose): a SET NX EX
 * claim answers "OK" once, and the connection really runs RESP3.
 */
describe('ValkeyLinkStore against a real Valkey', () => {
  let container: StartedTestContainer;
  let url: string;

  beforeAll(async () => {
    container = await new GenericContainer('valkey/valkey:9.1-alpine')
      .withExposedPorts(6379)
      .withWaitStrategy(Wait.forLogMessage(/Ready to accept connections/))
      .start();
    url = `redis://${container.getHost()}:${container.getMappedPort(6379)}`;
  }, 120_000);

  afterAll(async () => {
    await container?.stop();
  });

  it('claims a key once and refuses the second claim', async () => {
    const store = new ValkeyLinkStore(url);
    try {
      expect(await store.claim('link:one', 60)).toBe(true);
      expect(await store.claim('link:one', 60)).toBe(false);
      expect(await store.claim('link:two', 60)).toBe(true);
    } finally {
      store.onApplicationShutdown();
    }
  });

  it('runs its connection on RESP3', async () => {
    const store = new ValkeyLinkStore(url);
    const admin = new Redis(url);
    try {
      await store.claim('link:resp3', 60);
      const clients = String(await admin.client('LIST'));
      expect(clients).toMatch(/resp=3/);
      expect(clients).not.toMatch(/resp=2/);
    } finally {
      store.onApplicationShutdown();
      admin.disconnect();
    }
  });
});
