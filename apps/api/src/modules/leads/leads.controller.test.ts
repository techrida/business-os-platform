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
const LOST_REASON = '7b0e6c1a-2f4d-4c55-8a39-6d1f5e2c9b10';
const VALID_LEAD = {
  title: 'Website for Acme',
  source: 'referral',
  companyName: 'Acme Pvt. Ltd.',
  contactName: 'Sita Rai',
  country: 'NP',
  email: 'sita@acme.example',
};

async function setup() {
  const service = {
    list: vi.fn().mockResolvedValue({ rows: [], total: 0 }),
    summary: vi.fn().mockResolvedValue({ total: 0, byStage: {} }),
    get: vi.fn().mockResolvedValue({}),
    create: vi.fn().mockResolvedValue({}),
    changeStage: vi.fn().mockResolvedValue({}),
    update: vi.fn().mockResolvedValue({}),
    owners: vi.fn().mockResolvedValue([]),
    ownerFilter: vi.fn().mockResolvedValue([]),
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
    expect(can('summary')).toBe('crm.lead.read');
    expect(can('get')).toBe('crm.lead.read');
    expect(can('create')).toBe('crm.lead.write');
    expect(can('changeStage')).toBe('crm.lead.write');
    expect(can('update')).toBe('crm.lead.write');
    expect(can('owners')).toBe('crm.lead.write');
    // The list's Owner filter needs only read: every role that sees the list gets it.
    expect(can('ownerFilter')).toBe('crm.lead.read');
  });

  it('declares GET owners and owner-filter before GET :id, so neither is parsed as a lead id', () => {
    const names = Object.getOwnPropertyNames(LeadsController.prototype);
    for (const [name, path] of [
      ['owners', 'owners'],
      ['ownerFilter', 'owner-filter'],
    ] as const) {
      expect(names.indexOf(name)).toBeGreaterThan(-1);
      expect(names.indexOf(name)).toBeLessThan(names.indexOf('get'));
      expect(Reflect.getMetadata('path', LeadsController.prototype[name])).toBe(path);
    }
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

  it('lists owners for a lead that exists unless the new-lead form asks, and refuses another context', async () => {
    const { service, controller } = await setup();
    await controller.owners({});
    expect(service.owners).toHaveBeenLastCalledWith('reassign');
    await controller.owners({ context: 'create' });
    expect(service.owners).toHaveBeenLastCalledWith('create');

    service.owners.mockClear();
    for (const query of [
      { context: 'approve' },
      { context: ['create', 'reassign'] },
      { scope: 'all' },
    ]) {
      expect(() => controller.owners(query), JSON.stringify(query)).toThrow(BadRequestException);
    }
    expect(service.owners).not.toHaveBeenCalled();
  });

  it('lists the Owner filter through the service', async () => {
    const { service, controller } = await setup();
    await controller.ownerFilter();
    expect(service.ownerFilter).toHaveBeenCalledWith();
  });

  it('parses the list query: repeats become arrays, limit and offset numbers with defaults', async () => {
    const { service, controller } = await setup();
    const res = { setHeader: vi.fn() };
    await controller.list(
      {
        q: 'acme',
        stage: 'contacted',
        source: ['website', 'event', 'website'],
        ownerUserId: ID,
        limit: '20',
        offset: '40',
      },
      res,
    );
    expect(service.list).toHaveBeenCalledWith({
      q: 'acme',
      stage: ['contacted'],
      source: ['website', 'event'],
      ownerUserId: [ID],
      limit: 20,
      offset: 40,
    });
    await controller.list({}, res);
    expect(service.list).toHaveBeenLastCalledWith({ limit: 50, offset: 0 });
    // A one-character search means no search, and an empty filter means no filter.
    await controller.list({ q: 'a', stage: '' }, res);
    expect(service.list).toHaveBeenLastCalledWith({ limit: 50, offset: 0, stage: [] });
  });

  it('refuses unknown params, bad values and a repeated q with 400 before the service', async () => {
    const { service, controller } = await setup();
    const res = { setHeader: vi.fn() };
    for (const query of [
      { stage: 'nonsense' },
      { stage: ['new', 'nonsense'] },
      { source: 'telepathy' },
      { ownerUserId: 'not-a-uuid' },
      { limit: '5000' },
      { limit: '0' },
      { offset: '-1' },
      { q: ['a', 'b'] },
      { status: 'new' },
    ]) {
      await expect(controller.list(query, res), JSON.stringify(query)).rejects.toThrow(
        BadRequestException,
      );
    }
    expect(service.list).not.toHaveBeenCalled();
    expect(res.setHeader).not.toHaveBeenCalled();
  });

  it('sends the total in X-Total-Count and keeps the body a bare array', async () => {
    const { service, controller } = await setup();
    const rows = [{ id: ID }];
    service.list.mockResolvedValue({ rows, total: 134 });
    const res = { setHeader: vi.fn() };
    await expect(controller.list({ limit: '1' }, res)).resolves.toBe(rows);
    expect(res.setHeader).toHaveBeenCalledWith('X-Total-Count', '134');
  });

  it('parses the summary query without a stage or paging, and refuses both', async () => {
    const { service, controller } = await setup();
    await controller.summary({ q: 'acme', source: 'event', ownerUserId: [ID] });
    expect(service.summary).toHaveBeenCalledWith({
      q: 'acme',
      source: ['event'],
      ownerUserId: [ID],
    });
    await controller.summary({});
    expect(service.summary).toHaveBeenLastCalledWith({});
    service.summary.mockClear();
    for (const query of [{ stage: 'new' }, { limit: '5' }, { offset: '0' }, { source: 'x' }]) {
      expect(() => controller.summary(query), JSON.stringify(query)).toThrow(BadRequestException);
    }
    expect(service.summary).not.toHaveBeenCalled();
  });

  it('routes /summary before /:id', () => {
    const names = Object.getOwnPropertyNames(LeadsController.prototype);
    expect(names.indexOf('summary')).toBeLessThan(names.indexOf('get'));
  });

  it('creates from a valid body with the currency defaulted, and refuses a bad one before the service', async () => {
    const { service, controller } = await setup();
    await controller.create(undefined, VALID_LEAD);
    expect(service.create).toHaveBeenCalledWith(
      { ...VALID_LEAD, currency: 'NPR', phones: [] },
      undefined,
    );
    await controller.create('key-1', VALID_LEAD);
    expect(service.create).toHaveBeenLastCalledWith(
      { ...VALID_LEAD, currency: 'NPR', phones: [] },
      'key-1',
    );

    service.create.mockClear();
    for (const body of [
      { ...VALID_LEAD, source: 'telepathy' },
      { ...VALID_LEAD, stage: 'qualified' },
      { ...VALID_LEAD, phones: [{ country: 'NP', e164: '+97798123', isPrimary: true }] },
      { ...VALID_LEAD, country: undefined },
      { title: 'x' },
    ]) {
      expect(() => controller.create(undefined, body), JSON.stringify(body)).toThrow(
        BadRequestException,
      );
    }
    expect(() => controller.create('has a space', VALID_LEAD)).toThrow(BadRequestException);
    expect(service.create).not.toHaveBeenCalled();
  });

  it('never passes converted to the service, nor a lost without one chosen reason and a note', async () => {
    const { service, controller } = await setup();
    for (const body of [
      { stage: 'converted', expectedVersion: 1 },
      { stage: 'lost', expectedVersion: 1 },
      { stage: 'lost', reason: 'price', note: 'too dear', expectedVersion: 1 },
      { stage: 'lost', lostReasonId: LOST_REASON, expectedVersion: 1 },
      {
        stage: 'lost',
        lostReasonId: LOST_REASON,
        newLostReason: 'Slow',
        note: 'n',
        expectedVersion: 1,
      },
      { stage: 'contacted', lostReasonId: LOST_REASON, expectedVersion: 1 },
      { stage: 'on_hold', reason: 'budget', expectedVersion: 1 },
      { stage: 'contacted' },
    ]) {
      expect(() => controller.changeStage(ID, body), JSON.stringify(body)).toThrow(
        BadRequestException,
      );
    }
    expect(service.changeStage).not.toHaveBeenCalled();

    for (const ok of [
      { stage: 'lost', lostReasonId: LOST_REASON, note: 'too dear', expectedVersion: 4 },
      { stage: 'lost', newLostReason: 'Slow to reply', note: 'too dear', expectedVersion: 4 },
    ]) {
      await controller.changeStage(ID, ok);
      expect(service.changeStage).toHaveBeenCalledWith(ID, ok);
    }
  });
});
