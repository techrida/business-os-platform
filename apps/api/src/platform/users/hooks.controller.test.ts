import { createHmac } from 'node:crypto';

import { UnauthorizedException } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { beforeEach, describe, expect, it } from 'vitest';

import type { AppConfig } from '../config/config';
import { HooksController } from './hooks.controller';
import type { UsersSyncData } from './users.constants';
import { FakeUsersStore, fakeQueue } from './users.fakes';

const KEY = 'hook-test-signing-key';

function signedRequest(payload: unknown, key = KEY) {
  const rawBody = Buffer.from(JSON.stringify(payload));
  const t = Math.floor(Date.now() / 1000);
  const v1 = createHmac('sha256', key).update(`${t}.`).update(rawBody).digest('hex');
  return { headers: { 'zitadel-signature': `t=${t},v1=${v1}` }, rawBody, body: payload };
}

const event = (over: Record<string, unknown> = {}) => ({
  instanceID: 'inst-1',
  aggregateID: 'user-42',
  aggregateType: 'user',
  resourceOwner: 'never-trusted',
  sequence: 17,
  event_type: 'user.human.profile.changed',
  ...over,
});

let store: FakeUsersStore;
let queue: ReturnType<typeof fakeQueue>;
const controller = (key: string | null = KEY) =>
  new HooksController(
    { ZITADEL_ACTIONS_SIGNING_KEY: key ?? undefined } as AppConfig,
    store,
    queue as unknown as Queue<UsersSyncData>,
  );
type Req = Parameters<HooksController['zitadel']>[0];

beforeEach(() => {
  store = new FakeUsersStore();
  queue = fakeQueue();
});

describe('POST /v1/hooks/zitadel', () => {
  it('enqueues users.sync with only the aggregate id', async () => {
    await controller().zitadel(signedRequest(event()) as unknown as Req);
    expect(queue.added).toEqual([{ name: 'users.sync', data: { zitadelUserId: 'user-42' } }]);
  });

  it('dedupes on (instanceID, aggregateID, sequence)', async () => {
    const c = controller();
    await c.zitadel(signedRequest(event()) as unknown as Req);
    // Same triple, different event type and a fresh signature: still a duplicate.
    await c.zitadel(signedRequest(event({ event_type: 'other' })) as unknown as Req);
    // The sequence as a string is the same event too.
    await c.zitadel(signedRequest(event({ sequence: '17' })) as unknown as Req);
    expect(queue.added).toHaveLength(1);

    await c.zitadel(signedRequest(event({ sequence: 18 })) as unknown as Req);
    await c.zitadel(signedRequest(event({ instanceID: 'inst-2' })) as unknown as Req);
    expect(queue.added).toHaveLength(3);
  });

  it('records but does not enqueue non-user aggregates', async () => {
    await controller().zitadel(signedRequest(event({ aggregateType: 'org' })) as unknown as Req);
    expect(store.events.size).toBe(1);
    expect(queue.added).toHaveLength(0);
  });

  it('401s on a bad, missing or unconfigured signature and records nothing', async () => {
    const wrongKey = signedRequest(event(), 'not-the-key');
    await expect(controller().zitadel(wrongKey as unknown as Req)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );

    const unsigned = { ...signedRequest(event()), headers: {} };
    await expect(controller().zitadel(unsigned as unknown as Req)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );

    const noRaw = { ...signedRequest(event()), rawBody: undefined };
    await expect(controller().zitadel(noRaw as unknown as Req)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );

    await expect(
      controller(null).zitadel(signedRequest(event()) as unknown as Req),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    expect(store.events.size).toBe(0);
    expect(queue.added).toHaveLength(0);
  });

  it('400s on a signed body without the ids', async () => {
    await expect(
      controller().zitadel(signedRequest({ aggregateType: 'user' }) as unknown as Req),
    ).rejects.toMatchObject({ name: 'BadRequestException' });
  });
});
