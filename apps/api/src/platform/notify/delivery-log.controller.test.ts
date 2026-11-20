// Unit test for DeliveryLogController with a fake service: each route carries its own permission (deny by
// default), the query is validated before the service runs, and resend answers 200 with the outcome.
import { HTTP_CODE_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { describe, expect, it, vi } from 'vitest';

import { ANY_AUTHENTICATED_KEY, CAN_KEY } from '../authz/decorators';
import { DeliveryLogController } from './delivery-log.controller';
import type { DeliveryLogService } from './delivery-log.service';

const ID = '3f2b8c1e-9d4a-4e6b-8a57-1c2d3e4f5a6b';

function setup() {
  const fake = {
    list: vi.fn().mockResolvedValue({ items: [], nextBefore: null }),
    resend: vi.fn().mockResolvedValue({ outcome: 'queued' }),
  };
  return { fake, controller: new DeliveryLogController(fake as unknown as DeliveryLogService) };
}

describe('DeliveryLogController', () => {
  it('gates reading on email_delivery.read and resending on email_delivery.resend', () => {
    const reflector = new Reflector();
    const list = DeliveryLogController.prototype.list;
    const resend = DeliveryLogController.prototype.resend;
    expect(reflector.get(CAN_KEY, list)).toBe('email_delivery.read');
    expect(reflector.get(CAN_KEY, resend)).toBe('email_delivery.resend');
    // Not open to every signed-in user.
    expect(reflector.get(ANY_AUTHENTICATED_KEY, list)).toBeUndefined();
    expect(reflector.get(ANY_AUTHENTICATED_KEY, resend)).toBeUndefined();
  });

  it('GET lists failed emails by default, 50 at a time', async () => {
    const { fake, controller } = setup();
    await controller.list({});
    expect(fake.list).toHaveBeenLastCalledWith({ filter: 'failed', limit: 50 });

    await controller.list({ filter: 'all', limit: '10', before: ID });
    expect(fake.list).toHaveBeenLastCalledWith({ filter: 'all', limit: 10, before: ID });
  });

  it.each([{ filter: 'sent' }, { limit: '0' }, { limit: '101' }, { before: 'not-a-uuid' }])(
    'GET rejects %j with 400 and never reaches the service',
    (query) => {
      const { fake, controller } = setup();
      expect(() => controller.list(query)).toThrow(/Invalid query/);
      expect(fake.list).not.toHaveBeenCalled();
    },
  );

  it('POST :id/resend answers 200 with the outcome', async () => {
    const { fake, controller } = setup();
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, DeliveryLogController.prototype.resend)).toBe(
      200,
    );
    await expect(controller.resend(ID)).resolves.toEqual({ outcome: 'queued' });
    expect(fake.resend).toHaveBeenCalledExactlyOnceWith(ID);
  });
});
