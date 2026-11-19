// Unit tests of the activity routes without a database: every route carries a marker (the permission is the
// subject's, checked by the service), parsing happens before the service is called, and an activity with two
// subjects (or none) is a 400 at the edge, as the DB CHECK would refuse it anyway. The complete, reschedule and
// cancel bodies are parsed with their contract schemas before the service sees them.
import 'reflect-metadata';

import { BadRequestException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Response } from 'express';
import { describe, expect, it, vi } from 'vitest';

import { ANY_AUTHENTICATED_KEY } from '../../platform/authz/decorators';
import { findUnmarkedRoutes } from '../../platform/authz/route-policy.check';
import { ActivitiesController } from './activities.controller';
import { ActivitiesService } from './activities.service';

const LEAD = '4f6c7a5e-0d52-4d1e-9d8a-3f1d2c3b4a5f';
const OPP = '9b2c1d3e-5f60-4a7b-8c9d-0e1f2a3b4c5d';
const ACT = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';

async function setup() {
  const service = {
    list: vi.fn().mockResolvedValue({ items: [], total: 0 }),
    create: vi.fn().mockResolvedValue({}),
    complete: vi.fn().mockResolvedValue({}),
    reschedule: vi.fn().mockResolvedValue({}),
    cancel: vi.fn().mockResolvedValue({}),
  };
  const moduleRef = await Test.createTestingModule({
    controllers: [ActivitiesController],
    providers: [{ provide: ActivitiesService, useValue: service }],
  }).compile();
  const controller = moduleRef.get(ActivitiesController);
  const res = { setHeader: vi.fn() };
  const list = (query: unknown) => controller.list(query, res as unknown as Response);
  return { service, moduleRef, controller, res, list };
}

describe('ActivitiesController', () => {
  it('has no route without a marker, and every route defers the permission to the subject', async () => {
    const { moduleRef } = await setup();
    expect(findUnmarkedRoutes(moduleRef)).toEqual([]);
    for (const name of ['list', 'create', 'complete', 'reschedule', 'cancel'] as const) {
      expect(Reflect.getMetadata(ANY_AUTHENTICATED_KEY, ActivitiesController.prototype[name])).toBe(
        true,
      );
    }
    await moduleRef.close();
  });

  it('parses the list query: kinds become an array, paging defaults, the total goes in a header', async () => {
    const { service, res, list } = await setup();
    service.list.mockResolvedValue({ items: [{ id: 'a' }], total: 3 });
    await expect(
      list({ leadId: LEAD, kind: 'call', q: ' visit ', limit: '20', offset: '20' }),
    ).resolves.toEqual([{ id: 'a' }]);
    expect(service.list).toHaveBeenCalledWith({
      leadId: LEAD,
      kind: ['call'],
      q: 'visit',
      limit: 20,
      offset: 20,
    });
    expect(res.setHeader).toHaveBeenCalledWith('X-Total-Count', '3');
    await list({ kind: ['call', 'note', 'call'] });
    expect(service.list).toHaveBeenLastCalledWith({ kind: ['call', 'note'], limit: 50, offset: 0 });
    await list({ status: 'planned' });
    expect(service.list).toHaveBeenLastCalledWith({ status: 'planned', limit: 50, offset: 0 });
    await list({});
    expect(service.list).toHaveBeenLastCalledWith({ limit: 50, offset: 0 });
    await list({ dueFrom: '2030-01-01', dueTo: '2030-01-01' });
    expect(service.list).toHaveBeenLastCalledWith({
      dueFrom: '2030-01-01',
      dueTo: '2030-01-01',
      limit: 50,
      offset: 0,
    });
  });

  it('refuses a due day that is not a date, or a range that ends before it starts, with 400', async () => {
    const { service, list } = await setup();
    for (const query of [
      { dueFrom: 'tomorrow' },
      { dueTo: '2030-02-30' },
      { dueFrom: '2030-01-01T00:00:00Z' },
      { dueFrom: '2030-01-03', dueTo: '2030-01-02' },
      { dueFrom: ['2030-01-01', '2030-01-02'] },
    ]) {
      await expect(list(query), JSON.stringify(query)).rejects.toThrow(BadRequestException);
    }
    expect(service.list).not.toHaveBeenCalled();
  });

  it('refuses two subjects, an unknown kind, a bad id, an unknown param or a repeated q with 400', async () => {
    const { service, list } = await setup();
    for (const query of [
      { leadId: LEAD, opportunityId: OPP },
      { kind: 'nonsense' },
      { kind: ['call', 'nonsense'] },
      { status: 'nonsense' },
      { leadId: 'not-a-guid' },
      { color: 'red' },
      { q: ['ab', 'cd'] },
      { offset: '-5' },
    ]) {
      await expect(list(query), JSON.stringify(query)).rejects.toThrow(BadRequestException);
    }
    expect(service.list).not.toHaveBeenCalled();
  });

  it('refuses an activity with two subjects, none, or a kind only the server writes', async () => {
    const { service, controller } = await setup();
    const base = { kind: 'call', subject: 'Follow-up call' };
    for (const body of [
      { ...base, leadId: LEAD, opportunityId: OPP },
      base,
      { ...base, kind: 'stage_change', leadId: LEAD },
      { ...base, kind: 'system', leadId: LEAD },
      // D39: a follow-up is a planned call, meeting or email; `task` stays readable but is no longer written.
      { ...base, kind: 'task', leadId: LEAD },
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

  it('parses the complete, reschedule and cancel bodies before the service sees them', async () => {
    const { service, controller } = await setup();
    const done = {
      expectedVersion: 1,
      note: 'Spoke to Sita',
      occurredAt: '2030-01-01T09:00:00.000Z',
    };
    await controller.complete(ACT, done);
    expect(service.complete).toHaveBeenCalledWith(ACT, done);
    await controller.complete(ACT, { expectedVersion: 2 });
    expect(service.complete).toHaveBeenLastCalledWith(ACT, { expectedVersion: 2 });
    const moved = { expectedVersion: 1, dueAt: '2030-01-02T09:00:00.000Z', assigneeUserId: LEAD };
    await controller.reschedule(ACT, moved);
    expect(service.reschedule).toHaveBeenCalledWith(ACT, moved);
    await controller.cancel(ACT, { expectedVersion: 3 });
    expect(service.cancel).toHaveBeenCalledWith(ACT, { expectedVersion: 3 });

    for (const body of [
      {},
      { expectedVersion: 0 },
      { expectedVersion: '1' },
      { expectedVersion: 1, occurredAt: 'yesterday' },
      { expectedVersion: 1, completedAt: '2030-01-01T09:00:00.000Z' },
    ]) {
      expect(() => controller.complete(ACT, body), JSON.stringify(body)).toThrow(
        BadRequestException,
      );
    }
    for (const body of [
      { expectedVersion: 1 },
      { expectedVersion: 1, dueAt: 'soon' },
      { expectedVersion: 1, dueAt: '2030-01-02T09:00:00.000Z', assigneeUserId: 'not-a-guid' },
      { dueAt: '2030-01-02T09:00:00.000Z' },
    ]) {
      expect(() => controller.reschedule(ACT, body), JSON.stringify(body)).toThrow(
        BadRequestException,
      );
    }
    for (const body of [{}, { expectedVersion: 1, reason: 'no' }]) {
      expect(() => controller.cancel(ACT, body), JSON.stringify(body)).toThrow(BadRequestException);
    }
    expect(service.complete).toHaveBeenCalledTimes(2);
    expect(service.reschedule).toHaveBeenCalledTimes(1);
    expect(service.cancel).toHaveBeenCalledTimes(1);
  });
});
