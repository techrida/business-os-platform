// Unit tests of the activity routes without a database: every route carries a marker (the permission is the
// subject's, checked by the service), parsing happens before the service is called, and an activity with two
// subjects (or none) is a 400 at the edge, as the DB CHECK would refuse it anyway.
import 'reflect-metadata';

import { BadRequestException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { describe, expect, it, vi } from 'vitest';

import { ANY_AUTHENTICATED_KEY } from '../../platform/authz/decorators';
import { findUnmarkedRoutes } from '../../platform/authz/route-policy.check';
import { ActivitiesController } from './activities.controller';
import { ActivitiesService } from './activities.service';

const LEAD = '4f6c7a5e-0d52-4d1e-9d8a-3f1d2c3b4a5f';
const OPP = '9b2c1d3e-5f60-4a7b-8c9d-0e1f2a3b4c5d';

async function setup() {
  const service = {
    list: vi.fn().mockResolvedValue([]),
    create: vi.fn().mockResolvedValue({}),
  };
  const moduleRef = await Test.createTestingModule({
    controllers: [ActivitiesController],
    providers: [{ provide: ActivitiesService, useValue: service }],
  }).compile();
  return { service, moduleRef, controller: moduleRef.get(ActivitiesController) };
}

describe('ActivitiesController', () => {
  it('has no route without a marker, and both routes defer the permission to the subject', async () => {
    const { moduleRef } = await setup();
    expect(findUnmarkedRoutes(moduleRef)).toEqual([]);
    for (const name of ['list', 'create'] as const) {
      expect(Reflect.getMetadata(ANY_AUTHENTICATED_KEY, ActivitiesController.prototype[name])).toBe(
        true,
      );
    }
    await moduleRef.close();
  });

  it('parses the list query: limit becomes a number, two subjects or a bad kind are a 400', async () => {
    const { service, controller } = await setup();
    await controller.list({ leadId: LEAD, kind: 'call', limit: '20' });
    expect(service.list).toHaveBeenCalledWith({ leadId: LEAD, kind: 'call', limit: 20 });
    await controller.list({});
    expect(service.list).toHaveBeenLastCalledWith({ limit: 50 });
    expect(() => controller.list({ leadId: LEAD, opportunityId: OPP })).toThrow(
      BadRequestException,
    );
    expect(() => controller.list({ kind: 'nonsense' })).toThrow(BadRequestException);
    expect(() => controller.list({ leadId: 'not-a-guid' })).toThrow(BadRequestException);
  });

  it('refuses an activity with two subjects, none, or a kind only the server writes', async () => {
    const { service, controller } = await setup();
    const base = { kind: 'call', subject: 'Follow-up call' };
    for (const body of [
      { ...base, leadId: LEAD, opportunityId: OPP },
      base,
      { ...base, kind: 'stage_change', leadId: LEAD },
      { ...base, kind: 'system', leadId: LEAD },
      { ...base, leadId: LEAD, extra: 1 },
    ]) {
      expect(() => controller.create(undefined, body), JSON.stringify(body)).toThrow(
        BadRequestException,
      );
    }
    expect(() => controller.create('has a space', { ...base, leadId: LEAD })).toThrow(
      BadRequestException,
    );
    expect(service.create).not.toHaveBeenCalled();

    await controller.create('key-1', { ...base, leadId: LEAD });
    expect(service.create).toHaveBeenCalledWith({ ...base, leadId: LEAD }, 'key-1');
  });
});
