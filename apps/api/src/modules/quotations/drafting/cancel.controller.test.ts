// Unit tests of the quotation cancel route, with CancelService mocked: the route passes the id, the parsed body
// and the Idempotency-Key, a missing key or a bad body is a 400 before the service is reached, the route needs
// quotation.draft, and the id carries a UUID pipe. The cancel rules themselves are in cancel.integration.test.ts.
import 'reflect-metadata';

import { BadRequestException, ParseUUIDPipe } from '@nestjs/common';
import { ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { Test } from '@nestjs/testing';
import { describe, expect, it, vi } from 'vitest';

import { CAN_KEY } from '../../../platform/authz/decorators';
import { findUnmarkedRoutes } from '../../../platform/authz/route-policy.check';
import { CancelController } from './cancel.controller';
import { CancelService } from './cancel.service';

const ID = '4f6c7a5e-0d52-4d1e-9d8a-3f1d2c3b4a5f';
const BODY = { reason: 'Customer chose another supplier', expectedVersion: 3 };

async function setup() {
  const service = { cancel: vi.fn().mockResolvedValue({ id: 'cancelled-version' }) };
  const moduleRef = await Test.createTestingModule({
    controllers: [CancelController],
    providers: [{ provide: CancelService, useValue: service }],
  }).compile();
  return { service, moduleRef, controller: moduleRef.get(CancelController) };
}

describe('CancelController', () => {
  it('has no route without a permission marker, and cancel needs quotation.draft', async () => {
    const { moduleRef } = await setup();
    expect(findUnmarkedRoutes(moduleRef)).toEqual([]);
    expect(Reflect.getMetadata(CAN_KEY, CancelController.prototype.cancel)).toBe('quotation.draft');
    await moduleRef.close();
  });

  it('cancels with the id, the parsed body and the Idempotency-Key, and returns the cancelled version', async () => {
    const { service, controller } = await setup();
    await expect(controller.cancel(ID, 'key-1', BODY)).resolves.toEqual({
      id: 'cancelled-version',
    });
    expect(service.cancel).toHaveBeenCalledWith(ID, BODY, 'key-1');
  });

  it('answers 400, without calling the service, to a missing or bad key and to a bad body', async () => {
    const { service, controller } = await setup();
    expect(() => controller.cancel(ID, undefined, BODY)).toThrow(BadRequestException);
    expect(() => controller.cancel(ID, '', BODY)).toThrow(BadRequestException);
    expect(() => controller.cancel(ID, 'has a space', BODY)).toThrow(BadRequestException);
    for (const body of [
      { expectedVersion: 3 },
      { reason: '', expectedVersion: 3 },
      { reason: 'Price', expectedVersion: 0 },
      { reason: 'Price' },
      { ...BODY, status: 'draft' },
      null,
    ]) {
      expect(() => controller.cancel(ID, 'key-1', body), JSON.stringify(body)).toThrow(
        BadRequestException,
      );
    }
    expect(service.cancel).not.toHaveBeenCalled();
  });

  it('checks the key before the body, so a missing key is the first thing reported', async () => {
    const { controller } = await setup();
    expect(() => controller.cancel(ID, undefined, null)).toThrow(/Idempotency-Key/);
  });

  it('puts a UUID pipe on the id, so a bad id is a 400 before the handler runs', () => {
    const args = Reflect.getMetadata(ROUTE_ARGS_METADATA, CancelController, 'cancel') as Record<
      string,
      { index: number; pipes: unknown[] }
    >;
    const indexes = Object.values(args)
      .filter((arg) => arg.pipes.some((pipe) => pipe === ParseUUIDPipe))
      .map((arg) => arg.index);
    expect(indexes).toEqual([0]);
  });
});
