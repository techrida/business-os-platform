// Unit tests of GET /v1/procurement/receivable-orders (P4 unit P2d-2): the one permission the route needs, that it
// does not sit under the receipts controller's class-level @AnyAuthenticated, the query it parses, and that nothing
// but the parsed query reaches the service. The service is a fake; its query runs on Postgres in
// receivable-orders.integration.test.ts.
import 'reflect-metadata';

import { DEFAULT_ROLE_PERMISSIONS, ROLE_KEYS } from '@bos/contracts';
import { BadRequestException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import { ANY_AUTHENTICATED_KEY, CAN_KEY } from '../../../platform/authz/decorators';
import type { ReceivableOrdersService } from './receivable-orders.service';
import {
  ReceivableOrdersController,
  ReceivedOrdersController,
  RequestedOrdersController,
} from './receipts.controller';
import type { RequestedOrdersService } from './requested-orders.service';

function setup() {
  const service = { list: vi.fn().mockResolvedValue([]) };
  return {
    service,
    controller: new ReceivableOrdersController(service as unknown as ReceivableOrdersService),
  };
}

describe('GET /v1/procurement/receivable-orders', () => {
  it('is mounted on its own path', () => {
    expect(Reflect.getMetadata('path', ReceivableOrdersController)).toBe(
      'v1/procurement/receivable-orders',
    );
  });

  it('needs procurement.receipt.confirm on the route, and no class-level any-signed-in-user marker', () => {
    expect(Reflect.getMetadata(CAN_KEY, ReceivableOrdersController.prototype.list)).toBe(
      'procurement.receipt.confirm',
    );
    expect(Reflect.getMetadata(ANY_AUTHENTICATED_KEY, ReceivableOrdersController)).toBeUndefined();
    expect(
      Reflect.getMetadata(ANY_AUTHENTICATED_KEY, ReceivableOrdersController.prototype.list),
    ).toBeUndefined();
  });

  it('hands the service the parsed query with the default limit', async () => {
    const { service, controller } = setup();
    await controller.list({});
    expect(service.list).toHaveBeenCalledWith({ limit: 50 });
    await controller.list({ limit: '20' });
    expect(service.list).toHaveBeenLastCalledWith({ limit: 20 });
    await controller.list({ limit: '200' });
    expect(service.list).toHaveBeenLastCalledWith({ limit: 200 });
  });

  it('is a 400 for a limit of 0 or over 200, and for an unknown key', () => {
    const { service, controller } = setup();
    expect(() => controller.list({ limit: '0' })).toThrow(BadRequestException);
    expect(() => controller.list({ limit: '201' })).toThrow(BadRequestException);
    expect(() => controller.list({ organizationId: 'x' })).toThrow(BadRequestException);
    expect(service.list).not.toHaveBeenCalled();
  });
});

describe('GET /v1/procurement/requested-orders', () => {
  const requested = () => {
    const service = { list: vi.fn().mockResolvedValue([]) };
    return {
      service,
      controller: new RequestedOrdersController(service as unknown as RequestedOrdersService),
    };
  };

  it('needs procurement.pr.read on the route, with no any-signed-in-user marker', () => {
    expect(Reflect.getMetadata('path', RequestedOrdersController)).toBe(
      'v1/procurement/requested-orders',
    );
    expect(Reflect.getMetadata(CAN_KEY, RequestedOrdersController.prototype.list)).toBe(
      'procurement.pr.read',
    );
    expect(Reflect.getMetadata(ANY_AUTHENTICATED_KEY, RequestedOrdersController)).toBeUndefined();
    expect(
      Reflect.getMetadata(ANY_AUTHENTICATED_KEY, RequestedOrdersController.prototype.list),
    ).toBeUndefined();
  });

  it('hands the service the parsed query, and is a 400 for a bad limit or an unknown key', async () => {
    const { service, controller } = requested();
    await controller.list({});
    expect(service.list).toHaveBeenCalledWith({ limit: 100 });
    expect(() => controller.list({ limit: '0' })).toThrow(BadRequestException);
    expect(() => controller.list({ requesterUserId: 'x' })).toThrow(BadRequestException);
    expect(service.list).toHaveBeenCalledTimes(1);
  });

  it('is reached by the requester role, which holds no purchase order or receipt grant', () => {
    const officer = DEFAULT_ROLE_PERMISSIONS.operations_officer;
    expect(officer['procurement.pr.read']).toBe('own');
    expect(officer['procurement.po.issue']).toBeUndefined();
    expect(officer['procurement.receipt.confirm']).toBeUndefined();
  });
});

describe('GET /v1/procurement/received-orders (U18-Q3)', () => {
  const received = () => {
    const service = { listReceived: vi.fn().mockResolvedValue([]) };
    return {
      service,
      controller: new ReceivedOrdersController(service as unknown as ReceivableOrdersService),
    };
  };

  it('needs procurement.receipt.confirm on the route, with no any-signed-in-user marker', () => {
    expect(Reflect.getMetadata('path', ReceivedOrdersController)).toBe(
      'v1/procurement/received-orders',
    );
    expect(Reflect.getMetadata(CAN_KEY, ReceivedOrdersController.prototype.list)).toBe(
      'procurement.receipt.confirm',
    );
    expect(Reflect.getMetadata(ANY_AUTHENTICATED_KEY, ReceivedOrdersController)).toBeUndefined();
    expect(
      Reflect.getMetadata(ANY_AUTHENTICATED_KEY, ReceivedOrdersController.prototype.list),
    ).toBeUndefined();
  });

  it('hands the service the parsed query, and is a 400 for a bad limit or an unknown key', async () => {
    const { service, controller } = received();
    await controller.list({});
    expect(service.listReceived).toHaveBeenCalledWith({ limit: 20 });
    await controller.list({ limit: '100' });
    expect(service.listReceived).toHaveBeenLastCalledWith({ limit: 100 });
    expect(() => controller.list({ limit: '101' })).toThrow(BadRequestException);
    expect(() => controller.list({ status: 'closed' })).toThrow(BadRequestException);
    expect(service.listReceived).toHaveBeenCalledTimes(2);
  });
});

describe('who holds procurement.receipt.confirm', () => {
  it('is the warehouse with scope all, and not the accountant or the requester role', () => {
    expect(DEFAULT_ROLE_PERMISSIONS.warehouse['procurement.receipt.confirm']).toBe('all');
    const holders = ROLE_KEYS.filter(
      (r) => DEFAULT_ROLE_PERMISSIONS[r]['procurement.receipt.confirm'] !== undefined,
    );
    for (const denied of ['accountant', 'operations_officer'] as const) {
      expect(holders).not.toContain(denied);
    }
  });
});
