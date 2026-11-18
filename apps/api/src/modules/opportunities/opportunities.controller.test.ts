// Unit tests of the opportunity routes without a database: every route carries a permission, reads need
// crm.opportunity.read and the stage change needs crm.opportunity.write, and parsing happens before the service
// is called (won and quotation_sent never reach it). The rules behind the routes are in the integration test.
import 'reflect-metadata';

import { OPPORTUNITY_STAGES } from '@bos/contracts';
import { BadRequestException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { describe, expect, it, vi } from 'vitest';

import { CAN_KEY } from '../../platform/authz/decorators';
import { findUnmarkedRoutes } from '../../platform/authz/route-policy.check';
import { OpportunitiesController } from './opportunities.controller';
import { OpportunitiesService } from './opportunities.service';

const ID = '4f6c7a5e-0d52-4d1e-9d8a-3f1d2c3b4a5f';

async function setup() {
  const service = {
    list: vi.fn().mockResolvedValue([]),
    get: vi.fn().mockResolvedValue({}),
    changeStage: vi.fn().mockResolvedValue({}),
  };
  const moduleRef = await Test.createTestingModule({
    controllers: [OpportunitiesController],
    providers: [{ provide: OpportunitiesService, useValue: service }],
  }).compile();
  return { service, moduleRef, controller: moduleRef.get(OpportunitiesController) };
}

describe('OpportunitiesController', () => {
  it('has no route without a permission marker', async () => {
    const { moduleRef } = await setup();
    expect(findUnmarkedRoutes(moduleRef)).toEqual([]);
    await moduleRef.close();
  });

  it('requires read for the two GET routes and write for the stage change', () => {
    const can = (name: keyof OpportunitiesController) =>
      Reflect.getMetadata(CAN_KEY, OpportunitiesController.prototype[name]) as string;
    expect(can('list')).toBe('crm.opportunity.read');
    expect(can('get')).toBe('crm.opportunity.read');
    expect(can('changeStage')).toBe('crm.opportunity.write');
  });

  it('parses the list query: limit becomes a number with a default, a bad stage is a 400', async () => {
    const { service, controller } = await setup();
    await controller.list({ q: 'acme', stage: 'negotiation', limit: '20' });
    expect(service.list).toHaveBeenCalledWith({ q: 'acme', stage: 'negotiation', limit: 20 });
    await controller.list({});
    expect(service.list).toHaveBeenLastCalledWith({ limit: 50 });
    expect(() => controller.list({ stage: 'nonsense' })).toThrow(BadRequestException);
    expect(() => controller.list({ limit: '5000' })).toThrow(BadRequestException);
  });

  it('accepts all stages and rejects empty, invalid or excessive stage lists', async () => {
    const { service, moduleRef, controller } = await setup();
    await controller.list({ stage: OPPORTUNITY_STAGES });
    expect(service.list).toHaveBeenCalledWith({ stage: OPPORTUNITY_STAGES, limit: 50 });
    service.list.mockClear();

    for (const stage of [
      [],
      ['qualified', 'nonsense'],
      ['qualified', ''],
      [...OPPORTUNITY_STAGES, 'qualified'],
    ]) {
      expect(() => controller.list({ stage })).toThrow(BadRequestException);
    }
    expect(service.list).not.toHaveBeenCalled();
    await moduleRef.close();
  });

  it('never passes won or quotation_sent to the service, nor a lost without reason and note', async () => {
    const { service, controller } = await setup();
    for (const body of [
      { stage: 'won', expectedVersion: 1 },
      { stage: 'quotation_sent', expectedVersion: 1 },
      { stage: 'lost', expectedVersion: 1 },
      { stage: 'on_hold', reason: 'budget', expectedVersion: 1 },
      { stage: 'negotiation' },
    ]) {
      expect(() => controller.changeStage(ID, body), JSON.stringify(body)).toThrow(
        BadRequestException,
      );
    }
    expect(service.changeStage).not.toHaveBeenCalled();

    const ok = { stage: 'lost', reason: 'price', note: 'too dear', expectedVersion: 4 };
    await controller.changeStage(ID, ok);
    expect(service.changeStage).toHaveBeenCalledWith(ID, ok);
  });
});
