// Unit tests of the two read routes added to SourcingController (P4 unit P2d): the permission each carries, the
// query the list route parses, and that nothing but the parsed query reaches the service. The service is a fake;
// its queries run on Postgres in sourcing.reads.integration.test.ts.
import 'reflect-metadata';

import { DEFAULT_ROLE_PERMISSIONS, ROLE_KEYS } from '@bos/contracts';
import { BadRequestException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import { CAN_KEY } from '../../../platform/authz/decorators';
import { SourcingController } from './sourcing.controller';
import type { SourcingService } from './sourcing.service';

const ID = '3f1c2a52-9a7e-4c41-8f6e-2b1a1d0c9e11';

function setup() {
  const service = {
    listRfqs: vi.fn().mockResolvedValue([]),
    listSubmissions: vi.fn().mockResolvedValue([]),
  };
  return {
    service,
    controller: new SourcingController(service as unknown as SourcingService),
  };
}

describe('GET /v1/procurement/rfqs', () => {
  it('needs procurement.sourcing', () => {
    expect(Reflect.getMetadata(CAN_KEY, SourcingController.prototype.list)).toBe(
      'procurement.sourcing',
    );
  });

  it('hands the service the parsed query with the default limit', async () => {
    const { service, controller } = setup();
    await controller.list({});
    expect(service.listRfqs).toHaveBeenCalledWith({ limit: 50 });
    await controller.list({ status: 'open', limit: '20' });
    expect(service.listRfqs).toHaveBeenLastCalledWith({ status: 'open', limit: 20 });
  });

  it('is a 400 for an unknown status, a limit over 200 and an unknown key', () => {
    const { service, controller } = setup();
    expect(() => controller.list({ status: 'nope' })).toThrow(BadRequestException);
    expect(() => controller.list({ limit: '201' })).toThrow(BadRequestException);
    expect(() => controller.list({ organizationId: ID })).toThrow(BadRequestException);
    expect(service.listRfqs).not.toHaveBeenCalled();
  });
});

describe('GET /v1/procurement/rfqs/:id/submissions', () => {
  it('needs procurement.sourcing and passes the id on', async () => {
    expect(Reflect.getMetadata(CAN_KEY, SourcingController.prototype.submissions)).toBe(
      'procurement.sourcing',
    );
    const { service, controller } = setup();
    await controller.submissions(ID);
    expect(service.listSubmissions).toHaveBeenCalledWith(ID);
  });
});

describe('who holds procurement.sourcing', () => {
  it('is procurement, and not the accountant, the requester role or the warehouse', () => {
    const holders = ROLE_KEYS.filter(
      (r) => DEFAULT_ROLE_PERMISSIONS[r]['procurement.sourcing'] !== undefined,
    );
    expect(holders).toContain('procurement');
    for (const denied of ['accountant', 'operations_officer', 'warehouse'] as const) {
      expect(holders).not.toContain(denied);
    }
  });
});
