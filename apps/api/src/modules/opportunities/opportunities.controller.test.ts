// Unit tests of the opportunity routes without a database: every route carries a permission, reads need
// crm.opportunity.read and the stage change needs crm.opportunity.write, and parsing happens before the service
// is called (won and quotation_sent never reach it). The rules behind the routes are in the integration test.
import 'reflect-metadata';

import { OPPORTUNITY_STAGES } from '@bos/contracts';
import { BadRequestException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Response } from 'express';
import { describe, expect, it, vi } from 'vitest';

import { CAN_KEY } from '../../platform/authz/decorators';
import { findUnmarkedRoutes } from '../../platform/authz/route-policy.check';
import { OpportunitiesController } from './opportunities.controller';
import { OpportunitiesService } from './opportunities.service';

const ID = '4f6c7a5e-0d52-4d1e-9d8a-3f1d2c3b4a5f';
const OWNER = '9b2c1d3e-5f60-4a7b-8c9d-0e1f2a3b4c5d';

async function setup() {
  const service = {
    list: vi.fn().mockResolvedValue({ items: [], total: 0 }),
    get: vi.fn().mockResolvedValue({}),
    changeStage: vi.fn().mockResolvedValue({}),
  };
  const moduleRef = await Test.createTestingModule({
    controllers: [OpportunitiesController],
    providers: [{ provide: OpportunitiesService, useValue: service }],
  }).compile();
  const controller = moduleRef.get(OpportunitiesController);
  const res = { setHeader: vi.fn() };
  const list = (query: unknown) => controller.list(query, res as unknown as Response);
  return { service, moduleRef, controller, res, list };
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

  it('parses the list query: arrays, paging defaults and a total header; a bad value is a 400', async () => {
    const { service, res, list } = await setup();
    service.list.mockResolvedValue({ items: [{ id: 'a' }], total: 7 });
    await expect(
      list({ q: ' acme ', stage: 'negotiation', owner: OWNER, limit: '20', offset: '40' }),
    ).resolves.toEqual([{ id: 'a' }]);
    expect(service.list).toHaveBeenCalledWith({
      q: 'acme',
      stage: ['negotiation'],
      owner: [OWNER],
      limit: 20,
      offset: 40,
    });
    expect(res.setHeader).toHaveBeenCalledWith('X-Total-Count', '7');
    await list({});
    expect(service.list).toHaveBeenLastCalledWith({ limit: 50, offset: 0 });
    await expect(list({ stage: 'nonsense' })).rejects.toThrow(BadRequestException);
    await expect(list({ owner: 'not-a-guid' })).rejects.toThrow(BadRequestException);
    await expect(list({ limit: '5000' })).rejects.toThrow(BadRequestException);
    await expect(list({ offset: '-1' })).rejects.toThrow(BadRequestException);
    await expect(list({ color: 'red' })).rejects.toThrow(BadRequestException);
  });

  it('treats a one-character search as no search and refuses a repeated q', async () => {
    const { service, list } = await setup();
    await list({ q: 'a' });
    expect(service.list).toHaveBeenLastCalledWith({ limit: 50, offset: 0 });
    await expect(list({ q: ['ab', 'cd'] })).rejects.toThrow(BadRequestException);
  });

  it('accepts repeated stages and owners, dedupes them, and refuses unknown or too many', async () => {
    const { service, moduleRef, list } = await setup();
    await list({ stage: [...OPPORTUNITY_STAGES, 'won'], owner: [OWNER, OWNER] });
    expect(service.list).toHaveBeenCalledWith({
      stage: OPPORTUNITY_STAGES,
      owner: [OWNER],
      limit: 50,
      offset: 0,
    });
    service.list.mockClear();

    for (const query of [
      { stage: ['qualified', 'nonsense'] },
      { owner: [OWNER, 'nope'] },
      { stage: Array.from({ length: 21 }, () => 'qualified') },
      {
        owner: Array.from(
          { length: 21 },
          (_, i) => `${OWNER.slice(0, -2)}${String(i).padStart(2, '0')}`,
        ),
      },
    ]) {
      await expect(list(query), JSON.stringify(query)).rejects.toThrow(BadRequestException);
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
