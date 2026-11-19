// Unit tests of the lead routes without a database: every route carries a permission, reads need crm.lead.read
// and writes need crm.lead.write, and parsing happens before the service is called (converted never reaches it,
// nor a body with a field the contract does not know). The rules behind the routes are in the integration test.
import 'reflect-metadata';

import { BadRequestException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { describe, expect, it, vi } from 'vitest';

import { CAN_KEY } from '../../platform/authz/decorators';
import { findUnmarkedRoutes } from '../../platform/authz/route-policy.check';
import { LeadsController } from './leads.controller';
import { LeadsService } from './leads.service';

const ID = '4f6c7a5e-0d52-4d1e-9d8a-3f1d2c3b4a5f';
const VALID_LEAD = {
  title: 'Website for Acme',
  source: 'referral',
  companyName: 'Acme Pvt. Ltd.',
  contactName: 'Sita Rai',
};

async function setup() {
  const service = {
    list: vi.fn().mockResolvedValue([]),
    get: vi.fn().mockResolvedValue({}),
    create: vi.fn().mockResolvedValue({}),
    changeStage: vi.fn().mockResolvedValue({}),
    update: vi.fn().mockResolvedValue({}),
    owners: vi.fn().mockResolvedValue([]),
  };
  const moduleRef = await Test.createTestingModule({
    controllers: [LeadsController],
    providers: [{ provide: LeadsService, useValue: service }],
  }).compile();
  return { service, moduleRef, controller: moduleRef.get(LeadsController) };
}

describe('LeadsController', () => {
  it('has no route without a permission marker', async () => {
    const { moduleRef } = await setup();
    expect(findUnmarkedRoutes(moduleRef)).toEqual([]);
    await moduleRef.close();
  });

  it('requires read for the GET routes and write for create and the stage change', () => {
    const can = (name: keyof LeadsController) =>
      Reflect.getMetadata(CAN_KEY, LeadsController.prototype[name]) as string;
    expect(can('list')).toBe('crm.lead.read');
    expect(can('get')).toBe('crm.lead.read');
    expect(can('create')).toBe('crm.lead.write');
    expect(can('changeStage')).toBe('crm.lead.write');
    expect(can('update')).toBe('crm.lead.write');
    expect(can('owners')).toBe('crm.lead.write');
  });

  it('declares GET owners before GET :id, so "owners" is never parsed as a lead id', () => {
    const names = Object.getOwnPropertyNames(LeadsController.prototype);
    expect(names.indexOf('owners')).toBeGreaterThan(-1);
    expect(names.indexOf('owners')).toBeLessThan(names.indexOf('get'));
    expect(Reflect.getMetadata('path', LeadsController.prototype.owners)).toBe('owners');
  });

  it('edits with only the fields sent: no currency default, and a bad body never reaches the service', async () => {
    const { service, controller } = await setup();
    const owner = '0b7d4c1e-5a2f-4e3b-8c9d-1a2b3c4d5e6f';
    await controller.update(ID, { ownerUserId: owner, expectedVersion: 3 });
    expect(service.update).toHaveBeenCalledWith(ID, { ownerUserId: owner, expectedVersion: 3 });
    expect(service.update.mock.calls[0]![1]).not.toHaveProperty('currency');

    service.update.mockClear();
    for (const body of [
      { title: 'x' },
      { title: 'x', expectedVersion: 0 },
      { stage: 'qualified', expectedVersion: 1 },
      { ownerUserId: 'not-a-uuid', expectedVersion: 1 },
      { source: 'telepathy', expectedVersion: 1 },
      { followUp: { kind: 'call', dueAt: '2026-12-01T09:00:00Z' }, expectedVersion: 1 },
    ]) {
      expect(() => controller.update(ID, body), JSON.stringify(body)).toThrow(BadRequestException);
    }
    expect(service.update).not.toHaveBeenCalled();
  });

  it('lists owners through the service', async () => {
    const { service, controller } = await setup();
    await controller.owners();
    expect(service.owners).toHaveBeenCalledWith();
  });

  it('parses the list query: limit becomes a number with a default, a bad stage is a 400', async () => {
    const { service, controller } = await setup();
    await controller.list({ q: 'acme', stage: 'contacted', limit: '20' });
    expect(service.list).toHaveBeenCalledWith({ q: 'acme', stage: 'contacted', limit: 20 });
    await controller.list({});
    expect(service.list).toHaveBeenLastCalledWith({ limit: 50 });
    expect(() => controller.list({ stage: 'nonsense' })).toThrow(BadRequestException);
    expect(() => controller.list({ limit: '5000' })).toThrow(BadRequestException);
  });

  it('creates from a valid body with the currency defaulted, and refuses a bad one before the service', async () => {
    const { service, controller } = await setup();
    await controller.create(undefined, VALID_LEAD);
    expect(service.create).toHaveBeenCalledWith({ ...VALID_LEAD, currency: 'NPR' }, undefined);
    await controller.create('key-1', VALID_LEAD);
    expect(service.create).toHaveBeenLastCalledWith({ ...VALID_LEAD, currency: 'NPR' }, 'key-1');

    service.create.mockClear();
    for (const body of [
      { ...VALID_LEAD, source: 'telepathy' },
      { ...VALID_LEAD, stage: 'qualified' },
      { ...VALID_LEAD, phone: '98123' },
      { title: 'x' },
    ]) {
      expect(() => controller.create(undefined, body), JSON.stringify(body)).toThrow(
        BadRequestException,
      );
    }
    expect(() => controller.create('has a space', VALID_LEAD)).toThrow(BadRequestException);
    expect(service.create).not.toHaveBeenCalled();
  });

  it('never passes converted to the service, nor a lost without reason and note', async () => {
    const { service, controller } = await setup();
    for (const body of [
      { stage: 'converted', expectedVersion: 1 },
      { stage: 'lost', expectedVersion: 1 },
      { stage: 'on_hold', reason: 'budget', expectedVersion: 1 },
      { stage: 'contacted' },
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
