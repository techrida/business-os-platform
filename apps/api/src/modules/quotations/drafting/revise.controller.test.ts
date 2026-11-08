// Unit tests of the quotation revise route, with ReviseService mocked: the route passes the id, the parsed body
// and the Idempotency-Key, a missing key or a bad body is a 400 before the service is reached, the route needs
// quotation.revise, and the id carries a UUID pipe. The revise rules themselves are in revise.integration.test.ts.
import 'reflect-metadata';

import { BadRequestException, ParseUUIDPipe } from '@nestjs/common';
import { ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { Test } from '@nestjs/testing';
import { describe, expect, it, vi } from 'vitest';

import { CAN_KEY } from '../../../platform/authz/decorators';
import { findUnmarkedRoutes } from '../../../platform/authz/route-policy.check';
import { ReviseController } from './revise.controller';
import { ReviseService } from './revise.service';

const ID = '4f6c7a5e-0d52-4d1e-9d8a-3f1d2c3b4a5f';
const BODY = { reason: 'Customer asked for a lower price', expectedVersion: 3 };

async function setup() {
  const service = { revise: vi.fn().mockResolvedValue({ id: 'new-version' }) };
  const moduleRef = await Test.createTestingModule({
    controllers: [ReviseController],
    providers: [{ provide: ReviseService, useValue: service }],
  }).compile();
  return { service, moduleRef, controller: moduleRef.get(ReviseController) };
}

describe('ReviseController', () => {
  it('has no route without a permission marker, and revise needs quotation.revise', async () => {
    const { moduleRef } = await setup();
    expect(findUnmarkedRoutes(moduleRef)).toEqual([]);
    expect(Reflect.getMetadata(CAN_KEY, ReviseController.prototype.revise)).toBe(
      'quotation.revise',
    );
    await moduleRef.close();
  });

  it('revises with the id, the parsed body and the Idempotency-Key, and returns the new version', async () => {
    const { service, controller } = await setup();
    await expect(controller.revise(ID, 'key-1', BODY)).resolves.toEqual({ id: 'new-version' });
    expect(service.revise).toHaveBeenCalledWith(ID, BODY, 'key-1');
  });

  it('answers 400, without calling the service, to a missing or bad key and to a bad body', async () => {
    const { service, controller } = await setup();
    expect(() => controller.revise(ID, undefined, BODY)).toThrow(BadRequestException);
    expect(() => controller.revise(ID, '', BODY)).toThrow(BadRequestException);
    expect(() => controller.revise(ID, 'has a space', BODY)).toThrow(BadRequestException);
    for (const body of [
      { expectedVersion: 3 },
      { reason: '', expectedVersion: 3 },
      { reason: 'Price', expectedVersion: 0 },
      { reason: 'Price' },
      { ...BODY, status: 'draft' },
      null,
    ]) {
      expect(() => controller.revise(ID, 'key-1', body), JSON.stringify(body)).toThrow(
        BadRequestException,
      );
    }
    expect(service.revise).not.toHaveBeenCalled();
  });

  it('checks the key before the body, so a missing key is the first thing reported', async () => {
    const { controller } = await setup();
    expect(() => controller.revise(ID, undefined, null)).toThrow(/Idempotency-Key/);
  });

  it('puts a UUID pipe on the id, so a bad id is a 400 before the handler runs', () => {
    const args = Reflect.getMetadata(ROUTE_ARGS_METADATA, ReviseController, 'revise') as Record<
      string,
      { index: number; pipes: unknown[] }
    >;
    const indexes = Object.values(args)
      .filter((arg) => arg.pipes.some((pipe) => pipe === ParseUUIDPipe))
      .map((arg) => arg.index);
    expect(indexes).toEqual([0]);
  });
});
