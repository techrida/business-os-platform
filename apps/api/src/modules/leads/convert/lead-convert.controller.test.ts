// Unit tests of the convert route without a database: the route carries crm.lead.write, the Idempotency-Key is
// required, and the body is parsed against ConvertLeadBodySchema before the service runs. The rules behind the
// route are in lead-convert.integration.test.ts.
import 'reflect-metadata';

import { BadRequestException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { describe, expect, it, vi } from 'vitest';

import { CAN_KEY } from '../../../platform/authz/decorators';
import { findUnmarkedRoutes } from '../../../platform/authz/route-policy.check';
import { LeadConvertController } from './lead-convert.controller';
import { LeadConvertService } from './lead-convert.service';

const ID = '4f6c7a5e-0d52-4d1e-9d8a-3f1d2c3b4a5f';
const CUSTOMER_ID = '9b1c7a5e-0d52-4d1e-9d8a-3f1d2c3b4a5f';
const EXISTING = {
  customer: { mode: 'existing', customerId: CUSTOMER_ID },
  contact: {
    mode: 'create',
    contact: { fullName: 'Sita Rai', email: 'sita@acme.example', country: 'NP' },
  },
  opportunityName: 'Acme website',
  expectedVersion: 3,
};

async function setup() {
  const service = { convert: vi.fn().mockResolvedValue({ opportunityId: 'o', customerId: 'c' }) };
  const moduleRef = await Test.createTestingModule({
    controllers: [LeadConvertController],
    providers: [{ provide: LeadConvertService, useValue: service }],
  }).compile();
  return { service, moduleRef, controller: moduleRef.get(LeadConvertController) };
}

describe('LeadConvertController', () => {
  it('has no route without a permission marker, and convert needs crm.lead.write', async () => {
    const { moduleRef } = await setup();
    expect(findUnmarkedRoutes(moduleRef)).toEqual([]);
    expect(Reflect.getMetadata(CAN_KEY, LeadConvertController.prototype.convert)).toBe(
      'crm.lead.write',
    );
    await moduleRef.close();
  });

  it('passes the lead id, the parsed body and the key to the service', async () => {
    const { service, controller } = await setup();
    await expect(controller.convert(ID, 'key-1', EXISTING)).resolves.toEqual({
      opportunityId: 'o',
      customerId: 'c',
    });
    expect(service.convert).toHaveBeenCalledWith(
      ID,
      {
        ...EXISTING,
        // The schema's defaults: not the main contact, and no numbers (the service then copies the lead's).
        contact: {
          mode: 'create',
          contact: { ...EXISTING.contact.contact, phones: [], isPrimary: false },
        },
      },
      'key-1',
    );
  });

  it('refuses a missing or malformed Idempotency-Key before the service', async () => {
    const { service, controller } = await setup();
    expect(() => controller.convert(ID, undefined, EXISTING)).toThrow(BadRequestException);
    expect(() => controller.convert(ID, 'has a space', EXISTING)).toThrow(BadRequestException);
    expect(service.convert).not.toHaveBeenCalled();
  });

  it('refuses a body the contract rejects, with no service call', async () => {
    const { service, controller } = await setup();
    for (const body of [
      { ...EXISTING, expectedVersion: undefined },
      { ...EXISTING, opportunityName: '' },
      { ...EXISTING, stage: 'converted' },
      { ...EXISTING, customer: { mode: 'existing' } },
      { ...EXISTING, duplicateOverride: {} },
      { ...EXISTING, duplicateOverride: { reason: '' } },
      // A contact is required, and a new one needs an email so its quotations can be sent.
      { ...EXISTING, contact: undefined },
      { ...EXISTING, contact: { mode: 'create', contact: { fullName: 'Sita Rai' } } },
    ]) {
      expect(() => controller.convert(ID, 'key-1', body), JSON.stringify(body)).toThrow(
        BadRequestException,
      );
    }
    expect(service.convert).not.toHaveBeenCalled();
  });
});
