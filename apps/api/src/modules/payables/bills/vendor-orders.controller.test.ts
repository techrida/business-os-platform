// Unit tests of the payables purchase order pickers (U18 #12, #13): the one grant each route needs, that the class
// carries no any-signed-in-user marker, the query each parses, and that nothing but the parsed query reaches the
// service. The service is a fake; its query runs on Postgres in vendor-bills.integration.test.ts.
import 'reflect-metadata';

import { DEFAULT_ROLE_PERMISSIONS } from '@bos/contracts';
import { BadRequestException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import { ANY_AUTHENTICATED_KEY, CAN_KEY } from '../../../platform/authz/decorators';
import { VendorOrdersController } from './vendor-orders.controller';
import type { VendorOrdersService } from './vendor-orders.service';

const VENDOR = '33333333-3333-4333-8333-333333333333';

function setup() {
  const service = {
    billable: vi.fn().mockResolvedValue([]),
    forPaymentRequest: vi.fn().mockResolvedValue([]),
  };
  return {
    service,
    controller: new VendorOrdersController(service as unknown as VendorOrdersService),
  };
}

describe('the payables purchase order pickers', () => {
  it('are mounted under v1/payables with no class-level marker', () => {
    expect(Reflect.getMetadata('path', VendorOrdersController)).toBe('v1/payables');
    expect(Reflect.getMetadata(ANY_AUTHENTICATED_KEY, VendorOrdersController)).toBeUndefined();
    expect(Reflect.getMetadata(CAN_KEY, VendorOrdersController)).toBeUndefined();
  });

  it('bill entry needs payables.bill.enter and payment requests need payables.payment.request', () => {
    const proto = VendorOrdersController.prototype;
    expect(Reflect.getMetadata('path', proto.billable)).toBe('billable-orders');
    expect(Reflect.getMetadata(CAN_KEY, proto.billable)).toBe('payables.bill.enter');
    expect(Reflect.getMetadata('path', proto.forPaymentRequest)).toBe('payment-request-orders');
    expect(Reflect.getMetadata(CAN_KEY, proto.forPaymentRequest)).toBe('payables.payment.request');
    for (const handler of [proto.billable, proto.forPaymentRequest]) {
      expect(Reflect.getMetadata(ANY_AUTHENTICATED_KEY, handler)).toBeUndefined();
    }
  });

  it('hands each service method the parsed query with the default limit', async () => {
    const { service, controller } = setup();
    await controller.billable({});
    expect(service.billable).toHaveBeenCalledWith({ limit: 100 });
    await controller.billable({ vendorId: VENDOR, limit: '20' });
    expect(service.billable).toHaveBeenLastCalledWith({ vendorId: VENDOR, limit: 20 });
    await controller.forPaymentRequest({ vendorId: VENDOR });
    expect(service.forPaymentRequest).toHaveBeenCalledWith({ vendorId: VENDOR, limit: 100 });
  });

  it('is a 400 for a vendor that is not an id, a limit out of range or an unknown key', () => {
    const { service, controller } = setup();
    expect(() => controller.billable({ vendorId: 'nope' })).toThrow(BadRequestException);
    expect(() => controller.billable({ limit: '0' })).toThrow(BadRequestException);
    expect(() => controller.forPaymentRequest({ limit: '201' })).toThrow(BadRequestException);
    expect(() => controller.forPaymentRequest({ organizationId: VENDOR })).toThrow(
      BadRequestException,
    );
    expect(service.billable).not.toHaveBeenCalled();
    expect(service.forPaymentRequest).not.toHaveBeenCalled();
  });
});

describe('who reaches the pickers by default', () => {
  it('the accountant enters bills and Finance requests payments, with no purchase order read', () => {
    expect(DEFAULT_ROLE_PERMISSIONS.accountant['payables.bill.enter']).toBe('all');
    expect(DEFAULT_ROLE_PERMISSIONS.finance['payables.payment.request']).toBe('all');
    for (const role of ['accountant', 'finance'] as const) {
      expect(DEFAULT_ROLE_PERMISSIONS[role]['procurement.po.issue']).toBeUndefined();
      expect(DEFAULT_ROLE_PERMISSIONS[role]['procurement.pr.read']).toBeUndefined();
    }
  });
});
