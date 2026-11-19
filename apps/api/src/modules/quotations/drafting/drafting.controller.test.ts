// Unit tests of the quotation drafting routes, with DraftingService mocked: each route calls the right method
// with the parsed arguments, a bad body, a bad UUID, a bad status filter or a missing Idempotency-Key is a 400
// before the service is reached, reads need quotation.read, writes need quotation.draft, and no route is
// without a permission marker. The rules behind the routes are in the service tests.
import 'reflect-metadata';

import { BadRequestException, ParseUUIDPipe } from '@nestjs/common';
import { ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { Test } from '@nestjs/testing';
import { describe, expect, it, vi } from 'vitest';

import { CAN_KEY } from '../../../platform/authz/decorators';
import { findUnmarkedRoutes } from '../../../platform/authz/route-policy.check';
import { DraftingController } from './drafting.controller';
import { DraftingService } from './drafting.service';

const ID = '4f6c7a5e-0d52-4d1e-9d8a-3f1d2c3b4a5f';
const VID = '9b1c2d3e-4f50-4a6b-8c7d-0e1f2a3b4c5d';
const OPP = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const TAX = '1b2c3d4e-5f60-4b7c-8d9e-0f1a2b3c4d5e';

const CONTENT = {
  currency: 'NPR',
  issueDate: '2026-11-01',
  validUntil: '2026-11-30',
  lines: [
    { description: 'Website', uom: 'job', quantity: '1', unitPrice: '100000.00', taxCodeId: TAX },
  ],
};
const CREATE_BODY = { ...CONTENT, opportunityId: OPP };
const UPDATE_BODY = { ...CONTENT, expectedVersion: 2 };

async function setup() {
  const service = {
    create: vi.fn().mockResolvedValue({}),
    list: vi.fn().mockResolvedValue({ rows: [], total: 0 }),
    summary: vi.fn().mockResolvedValue({ total: 0, byStatus: {} }),
    detail: vi.fn().mockResolvedValue({}),
    getVersion: vi.fn().mockResolvedValue({}),
    updateDraft: vi.fn().mockResolvedValue({ version: 3 }),
  };
  const moduleRef = await Test.createTestingModule({
    controllers: [DraftingController],
    providers: [{ provide: DraftingService, useValue: service }],
  }).compile();
  return { service, moduleRef, controller: moduleRef.get(DraftingController) };
}

/** Parameter indexes of a route handler that carry a ParseUUIDPipe (Nest runs pipes in the route layer). */
function uuidParamIndexes(name: keyof DraftingController): number[] {
  const args = Reflect.getMetadata(ROUTE_ARGS_METADATA, DraftingController, name) as Record<
    string,
    { index: number; pipes: unknown[] }
  >;
  return Object.values(args)
    .filter((arg) => arg.pipes.some((pipe) => pipe === ParseUUIDPipe))
    .map((arg) => arg.index)
    .sort();
}

describe('DraftingController', () => {
  it('has no route without a permission marker', async () => {
    const { moduleRef } = await setup();
    expect(findUnmarkedRoutes(moduleRef)).toEqual([]);
    await moduleRef.close();
  });

  it('requires quotation.read for the GET routes and quotation.draft for create and update', () => {
    const can = (name: keyof DraftingController) =>
      Reflect.getMetadata(CAN_KEY, DraftingController.prototype[name]) as string;
    expect(can('list')).toBe('quotation.read');
    expect(can('summary')).toBe('quotation.read');
    expect(can('detail')).toBe('quotation.read');
    expect(can('getVersion')).toBe('quotation.read');
    expect(can('create')).toBe('quotation.draft');
    expect(can('updateDraft')).toBe('quotation.draft');
  });

  it('creates from the parsed body and the Idempotency-Key', async () => {
    const { service, controller } = await setup();
    await controller.create('key-1', CREATE_BODY);
    expect(service.create).toHaveBeenCalledWith(CREATE_BODY, 'key-1');
  });

  it('answers 400, without calling the service, to a missing or bad key and to a bad create body', async () => {
    const { service, controller } = await setup();
    expect(() => controller.create(undefined, CREATE_BODY)).toThrow(BadRequestException);
    expect(() => controller.create('', CREATE_BODY)).toThrow(BadRequestException);
    expect(() => controller.create('has a space', CREATE_BODY)).toThrow(BadRequestException);
    for (const body of [
      { ...CREATE_BODY, opportunityId: 'not-a-uuid' },
      { ...CREATE_BODY, status: 'sent' },
      { ...CREATE_BODY, lines: [] },
      { ...CREATE_BODY, validUntil: '2026-10-01' },
      CONTENT,
      null,
    ]) {
      expect(() => controller.create('key-1', body), JSON.stringify(body)).toThrow(
        BadRequestException,
      );
    }
    expect(service.create).not.toHaveBeenCalled();
  });

  it('checks the key before the body, so a missing key is the first thing reported', async () => {
    const { controller } = await setup();
    expect(() => controller.create(undefined, null)).toThrow(/Idempotency-Key/);
  });

  it('lists with the defaults, or with the parsed filters, and reports the total in X-Total-Count', async () => {
    const { service, controller } = await setup();
    const res = { setHeader: vi.fn() };
    service.list.mockResolvedValue({ rows: [{ id: ID }], total: 41 });
    await expect(controller.list({}, res as never)).resolves.toEqual([{ id: ID }]);
    expect(service.list).toHaveBeenLastCalledWith({ limit: 50, offset: 0 });
    expect(res.setHeader).toHaveBeenLastCalledWith('X-Total-Count', '41');

    await controller.list(
      {
        status: ['draft', 'sent', 'draft'],
        customerId: ID,
        opportunityId: OPP,
        q: ' acme ',
        limit: '10',
        offset: '20',
      },
      res as never,
    );
    expect(service.list).toHaveBeenLastCalledWith({
      status: ['draft', 'sent'],
      customerId: [ID],
      opportunityId: OPP,
      q: 'acme',
      limit: 10,
      offset: 20,
    });
    await controller.list({ status: 'returned', q: 'a' }, res as never);
    expect(service.list).toHaveBeenLastCalledWith({
      status: ['returned'],
      q: undefined,
      limit: 50,
      offset: 0,
    });
  });

  it('answers 400 to an unknown status, a bad id, a repeated opportunityId, an unknown key or a bad page', async () => {
    const { service, controller } = await setup();
    const res = { setHeader: vi.fn() };
    for (const query of [
      { status: 'nonsense' },
      { status: ['draft', 'nonsense'] },
      { customerId: 'not-a-uuid' },
      { opportunityId: 'not-a-uuid' },
      { opportunityId: [ID, ID] },
      { sort: 'total' },
      { limit: '0' },
      { limit: '201' },
      { offset: '-1' },
    ]) {
      await expect(controller.list(query, res as never), JSON.stringify(query)).rejects.toThrow(
        BadRequestException,
      );
    }
    expect(service.list).not.toHaveBeenCalled();
    expect(res.setHeader).not.toHaveBeenCalled();
  });

  it('summarises with q, customerId and opportunityId, and refuses status, paging and unknown keys', async () => {
    const { service, controller } = await setup();
    await controller.summary({});
    expect(service.summary).toHaveBeenLastCalledWith({});
    await controller.summary({ q: 'acme', customerId: [ID, ID], opportunityId: OPP });
    expect(service.summary).toHaveBeenLastCalledWith({
      q: 'acme',
      customerId: [ID],
      opportunityId: OPP,
    });
    service.summary.mockClear();
    for (const query of [
      { status: 'draft' },
      { limit: '5' },
      { customerId: 'x' },
      { opportunityId: [ID, ID] },
      { nope: '1' },
    ]) {
      expect(() => controller.summary(query), JSON.stringify(query)).toThrow(BadRequestException);
    }
    expect(service.summary).not.toHaveBeenCalled();
  });

  it('declares summary before the :id route, so "summary" is never read as an id', () => {
    const routes = Object.getOwnPropertyNames(DraftingController.prototype);
    expect(routes.indexOf('summary')).toBeGreaterThan(-1);
    expect(routes.indexOf('summary')).toBeLessThan(routes.indexOf('detail'));
  });

  it('reads the detail and a version by their ids', async () => {
    const { service, controller } = await setup();
    await controller.detail(ID);
    expect(service.detail).toHaveBeenCalledWith(ID);
    await controller.getVersion(ID, VID);
    expect(service.getVersion).toHaveBeenCalledWith(ID, VID);
  });

  it('updates the draft with the ids and the parsed body, and returns the new version', async () => {
    const { service, controller } = await setup();
    await expect(controller.updateDraft(ID, VID, UPDATE_BODY)).resolves.toEqual({ version: 3 });
    expect(service.updateDraft).toHaveBeenCalledWith(ID, VID, UPDATE_BODY);
    // A partial edit is allowed: only the fields sent, plus expectedVersion.
    await controller.updateDraft(ID, VID, { scope: 'Phase 1', expectedVersion: 3 });
    expect(service.updateDraft).toHaveBeenLastCalledWith(ID, VID, {
      scope: 'Phase 1',
      expectedVersion: 3,
    });
  });

  it('answers 400 to an update without expectedVersion or with an unknown field', async () => {
    const { service, controller } = await setup();
    for (const body of [
      CONTENT,
      { ...UPDATE_BODY, status: 'sent' },
      { ...UPDATE_BODY, expectedVersion: 0 },
      { ...UPDATE_BODY, lines: [] },
      undefined,
    ]) {
      expect(() => controller.updateDraft(ID, VID, body), JSON.stringify(body)).toThrow(
        BadRequestException,
      );
    }
    expect(service.updateDraft).not.toHaveBeenCalled();
  });

  it('puts a UUID pipe on every id parameter, so a bad id is a 400 before the handler runs', () => {
    expect(uuidParamIndexes('detail')).toEqual([0]);
    expect(uuidParamIndexes('getVersion')).toEqual([0, 1]);
    expect(uuidParamIndexes('updateDraft')).toEqual([0, 1]);
  });
});
