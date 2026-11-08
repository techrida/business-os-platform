// Unit test for NotifyController with a fake NotifyService: input validation, the 204, and that every
// route carries @AnyAuthenticated (a route with neither that nor @Can is refused by the tenancy layer).
import { HTTP_CODE_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { describe, expect, it, vi } from 'vitest';

import { ANY_AUTHENTICATED_KEY } from '../authz/decorators';
import { NotifyController } from './notify.controller';
import type { NotifyService } from './notify.service';

const ID = '3f2b8c1e-9d4a-4e6b-8a57-1c2d3e4f5a6b';

function setup() {
  const fake = {
    listMine: vi.fn().mockResolvedValue([]),
    unreadCount: vi.fn().mockResolvedValue(3),
    markRead: vi.fn().mockResolvedValue(undefined),
  };
  return { fake, controller: new NotifyController(fake as unknown as NotifyService) };
}

describe('NotifyController', () => {
  it('marks every route @AnyAuthenticated', () => {
    const reflector = new Reflector();
    for (const name of ['list', 'unreadCount', 'markRead'] as const) {
      const handler = NotifyController.prototype[name];
      expect(reflector.get(ANY_AUTHENTICATED_KEY, handler), name).toBe(true);
    }
  });

  it('GET list defaults the limit and passes before through', async () => {
    const { fake, controller } = setup();
    await controller.list({});
    expect(fake.listMine).toHaveBeenLastCalledWith(30, undefined);

    await controller.list({ limit: '5', before: ID });
    expect(fake.listMine).toHaveBeenLastCalledWith(5, ID);
  });

  it.each([{ limit: '0' }, { limit: '101' }, { limit: 'abc' }, { before: 'not-a-uuid' }])(
    'GET list rejects %j with 400 and never reaches the service',
    (query) => {
      const { fake, controller } = setup();
      expect(() => controller.list(query)).toThrow(/Invalid query/);
      expect(fake.listMine).not.toHaveBeenCalled();
    },
  );

  it('GET unread-count returns { count }', async () => {
    const { controller } = setup();
    expect(await controller.unreadCount()).toEqual({ count: 3 });
  });

  it('POST :id/read answers 204 and passes the id to the service', async () => {
    const { fake, controller } = setup();
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, NotifyController.prototype.markRead)).toBe(204);

    await expect(controller.markRead(ID)).resolves.toBeUndefined();
    expect(fake.markRead).toHaveBeenCalledExactlyOnceWith(ID);
  });
});
