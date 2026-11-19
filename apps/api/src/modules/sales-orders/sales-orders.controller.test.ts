// Unit tests of the sales order routes, with SalesOrdersService mocked: permissions per route, the parsed query and
// bodies reach the service with the Idempotency-Key, a missing key or a bad body is a 400 before the service is
// reached, and the ids carry a UUID pipe. The rules are in sales-orders.integration.test.ts.
import 'reflect-metadata';

import { BadRequestException, ParseUUIDPipe } from '@nestjs/common';
import { ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { Test } from '@nestjs/testing';
import type { Response } from 'express';
import { describe, expect, it, vi } from 'vitest';

import { CAN_KEY } from '../../platform/authz/decorators';
import { findUnmarkedRoutes } from '../../platform/authz/route-policy.check';
import { SalesOrdersController } from './sales-orders.controller';
import { SalesOrdersService } from './sales-orders.service';

const ID = '4f6c7a5e-0d52-4d1e-9d8a-3f1d2c3b4a5f';
const LINE = '9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d';
const VID = '0b1c2d3e-4f50-4a61-8b72-9c8d7e6f5a4b';

async function setup() {
  const service = {
    list: vi.fn().mockResolvedValue({ rows: [], total: 0 }),
    summary: vi.fn().mockResolvedValue({ total: 0, byStatus: {} }),
    detail: vi.fn().mockResolvedValue({ order: { id: ID } }),
    confirmFromQuotation: vi.fn().mockResolvedValue({ order: { id: ID } }),
    markBillable: vi.fn().mockResolvedValue({ order: { id: ID } }),
  };
  const moduleRef = await Test.createTestingModule({
    controllers: [SalesOrdersController],
    providers: [{ provide: SalesOrdersService, useValue: service }],
  }).compile();
  const controller = moduleRef.get(SalesOrdersController);
  const res = { setHeader: vi.fn() };
  const list = (query: unknown) => controller.list(query, res as unknown as Response);
  return { service, moduleRef, controller, res, list };
}

describe('SalesOrdersController', () => {
  it('has no route without a permission marker, each with its sales_order permission', async () => {
    const { moduleRef } = await setup();
    expect(findUnmarkedRoutes(moduleRef)).toEqual([]);
    const proto = SalesOrdersController.prototype;
    expect(Reflect.getMetadata(CAN_KEY, proto.list)).toBe('sales_order.read');
    expect(Reflect.getMetadata(CAN_KEY, proto.summary)).toBe('sales_order.read');
    expect(Reflect.getMetadata(CAN_KEY, proto.detail)).toBe('sales_order.read');
    expect(Reflect.getMetadata(CAN_KEY, proto.confirm)).toBe('sales_order.confirm');
    expect(Reflect.getMetadata(CAN_KEY, proto.markBillable)).toBe('sales_order.mark_billable');
    await moduleRef.close();
  });

  it('lists with the parsed filter as arrays, answers a bare array and sets the total header', async () => {
    const { service, res, list } = await setup();
    service.list.mockResolvedValue({ rows: [{ id: ID }], total: 12 });
    await expect(
      list({ status: 'confirmed', customerId: VID, q: ' acme ', limit: '10', offset: '20' }),
    ).resolves.toEqual([{ id: ID }]);
    expect(service.list).toHaveBeenCalledWith({
      status: ['confirmed'],
      customerId: [VID],
      q: 'acme',
      limit: 10,
      offset: 20,
    });
    expect(res.setHeader).toHaveBeenCalledWith('X-Total-Count', '12');
    await list({});
    // No limit stays no limit: the confirm dialog and the quotation page read every match.
    expect(service.list).toHaveBeenLastCalledWith({ offset: 0 });
  });

  it('accepts repeated status and customerId, dedupes them, and treats a one-character q as no search', async () => {
    const { service, list } = await setup();
    await list({ status: ['draft', 'confirmed', 'draft'], customerId: [VID, VID], q: 'a' });
    expect(service.list).toHaveBeenCalledWith({
      status: ['draft', 'confirmed'],
      customerId: [VID],
      offset: 0,
    });
  });

  it('answers 400 to a bad list query (unknown status or id, unknown key, repeated q, bad paging)', async () => {
    const { service, list } = await setup();
    for (const query of [
      { status: 'paid' },
      { status: ['draft', 'paid'] },
      { customerId: 'nope' },
      { x: '1' },
      { q: ['ab', 'cd'] },
      { limit: '0' },
      { limit: '101' },
      { offset: '-1' },
      { status: Array.from({ length: 21 }, () => 'draft') },
    ]) {
      await expect(list(query), JSON.stringify(query)).rejects.toThrow(BadRequestException);
    }
    expect(service.list).not.toHaveBeenCalled();
  });

  it('summarises with the parsed q and customers, and refuses status and unknown keys', async () => {
    const { service, controller } = await setup();
    await controller.summary({ q: 'acme', customerId: [VID] });
    expect(service.summary).toHaveBeenCalledWith({ q: 'acme', customerId: [VID] });
    for (const query of [{ status: 'draft' }, { limit: '5' }, { customerId: 'nope' }]) {
      expect(() => controller.summary(query), JSON.stringify(query)).toThrow(BadRequestException);
    }
    expect(service.summary).toHaveBeenCalledTimes(1);
  });

  it('routes /summary before /:id, so the word is not read as an order id', () => {
    const names = Object.getOwnPropertyNames(SalesOrdersController.prototype);
    expect(names.indexOf('summary')).toBeLessThan(names.indexOf('detail'));
  });

  it('confirms with the parsed body (evidence defaults to none) and the key', async () => {
    const { service, controller } = await setup();
    await controller.confirm('key-1', { quotationVersionId: VID });
    expect(service.confirmFromQuotation).toHaveBeenCalledWith(
      { quotationVersionId: VID, evidenceDocumentIds: [] },
      'key-1',
    );
  });

  it('answers 400, without calling the service, to a missing key or a bad confirm body', async () => {
    const { service, controller } = await setup();
    expect(() => controller.confirm(undefined, { quotationVersionId: VID })).toThrow(
      BadRequestException,
    );
    for (const body of [
      {},
      { quotationVersionId: 'nope' },
      // The UI sends the version only; the quotation is read from it, so the contract refuses a second id.
      { quotationVersionId: VID, quotationId: ID },
      { quotationVersionId: VID, evidenceDocumentIds: ['nope'] },
      null,
    ]) {
      expect(() => controller.confirm('key-1', body), JSON.stringify(body)).toThrow(
        BadRequestException,
      );
    }
    expect(service.confirmFromQuotation).not.toHaveBeenCalled();
  });

  it('marks billable with both ids, the parsed body and the key', async () => {
    const { service, controller } = await setup();
    const body = { evidenceDocumentId: VID, expectedVersion: 2 };
    await controller.markBillable(ID, LINE, 'key-2', body);
    expect(service.markBillable).toHaveBeenCalledWith(ID, LINE, body, 'key-2');
  });

  it('answers 400 to a missing key or a mark-billable body without the order version', async () => {
    const { service, controller } = await setup();
    expect(() => controller.markBillable(ID, LINE, undefined, { expectedVersion: 1 })).toThrow(
      /Idempotency-Key/,
    );
    for (const body of [{}, { expectedVersion: 0 }, { expectedVersion: 1, extra: true }]) {
      expect(() => controller.markBillable(ID, LINE, 'key-1', body), JSON.stringify(body)).toThrow(
        BadRequestException,
      );
    }
    expect(service.markBillable).not.toHaveBeenCalled();
  });

  it('puts a UUID pipe on every id, so a bad id is a 400 before the handler runs', () => {
    const pipedIndexes = (method: string) =>
      Object.values(
        Reflect.getMetadata(ROUTE_ARGS_METADATA, SalesOrdersController, method) as Record<
          string,
          { index: number; pipes: unknown[] }
        >,
      )
        .filter((arg) => arg.pipes.some((pipe) => pipe === ParseUUIDPipe))
        .map((arg) => arg.index)
        .sort();
    expect(pipedIndexes('detail')).toEqual([0]);
    expect(pipedIndexes('markBillable')).toEqual([0, 1]);
  });
});
