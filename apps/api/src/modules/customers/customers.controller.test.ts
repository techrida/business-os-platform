// Unit tests of the thin HTTP layer: 400s from validation and from a missing Idempotency-Key, the PATCH field
// filter (the controller hands the service only what the client sent) and the route permissions. The service is
// a fake; its rules run on Postgres in customers.integration.test.ts.
import 'reflect-metadata';

import { BadRequestException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import { ANY_AUTHENTICATED_KEY, CAN_KEY } from '../../platform/authz/decorators';
import { CustomersController } from './customers.controller';
import type { CustomersService } from './customers.service';

const ID = '3f1c2a52-9a7e-4c41-8f6e-2b1a1d0c9e11';
const address = { line1: 'Ring Road', city: 'Kathmandu', country: 'NP' };

function setup() {
  const service = {
    list: vi.fn().mockResolvedValue({ items: [], total: 0 }),
    create: vi.fn().mockResolvedValue({}),
    get: vi.fn().mockResolvedValue({}),
    update: vi.fn().mockResolvedValue({}),
    updateTerms: vi.fn().mockResolvedValue({}),
    listContacts: vi.fn().mockResolvedValue([]),
    createContact: vi.fn().mockResolvedValue({}),
  };
  const controller = new CustomersController(service as unknown as CustomersService);
  return { service, controller };
}

describe('GET /v1/customers', () => {
  it('passes a parsed query to the service', async () => {
    const { service, controller } = setup();
    await controller.list({ q: ' acme ', limit: '10' });
    expect(service.list).toHaveBeenCalledWith({ q: 'acme', limit: 10, offset: 0 });
  });

  it('passes repeated filters through, and is a 400 for an unknown relationship', async () => {
    const { service, controller } = setup();
    await controller.list({ relationship: ['active', 'prospect'], industry: 'Retail' });
    expect(service.list).toHaveBeenCalledWith(
      expect.objectContaining({ relationship: ['active', 'prospect'], industry: ['Retail'] }),
    );
    expect(() => controller.list({ relationship: 'vip' })).toThrow(BadRequestException);
  });

  it('is a 400 for a limit over 100', () => {
    const { service, controller } = setup();
    expect(() => controller.list({ limit: '500' })).toThrow(BadRequestException);
    expect(service.list).not.toHaveBeenCalled();
  });
});

describe('POST /v1/customers', () => {
  const contact = { fullName: 'Sita Rai', email: 'sita@acme.example' };
  const body = { legalName: 'Acme Pvt. Ltd.', panVatNo: '123456789', address, contact };

  it('is a 400 without an Idempotency-Key, before the service is called', () => {
    const { service, controller } = setup();
    expect(() => controller.create(undefined, body)).toThrow(/Idempotency-Key/);
    expect(service.create).not.toHaveBeenCalled();
  });

  it('is a 400 for an invalid body', () => {
    const { controller } = setup();
    expect(() => controller.create('k1', { ...body, legalName: '' })).toThrow(BadRequestException);
    expect(() => controller.create('k1', { ...body, panVatNo: 'x' })).toThrow(BadRequestException);
    expect(() => controller.create('k1', { ...body, tenantId: 'x' })).toThrow(BadRequestException);
  });

  it('is a 400 without a first contact, or with one that has no email or a bad one', () => {
    const { service, controller } = setup();
    const { contact: _omitted, ...noContact } = body;
    for (const bad of [
      noContact,
      { ...body, contact: { fullName: 'Sita Rai' } },
      { ...body, contact: { ...contact, email: 'not-an-email' } },
      { ...body, contact: { ...contact, isPrimary: false } },
    ]) {
      expect(() => controller.create('k1', bad), JSON.stringify(bad)).toThrow(BadRequestException);
    }
    expect(service.create).not.toHaveBeenCalled();
  });

  it('hands the service the parsed body (relationship defaulted) and the key', async () => {
    const { service, controller } = setup();
    await controller.create('k1', body);
    expect(service.create).toHaveBeenCalledWith({ ...body, relationship: 'prospect' }, 'k1');
  });
});

describe('PATCH /v1/customers/:id', () => {
  it('does not turn the relationship default into an edit', async () => {
    const { service, controller } = setup();
    await controller.update(ID, { expectedVersion: 4, legalName: 'Acme Traders' });
    expect(service.update).toHaveBeenCalledWith(ID, 4, { legalName: 'Acme Traders' });
  });

  it('keeps a relationship that was sent', async () => {
    const { service, controller } = setup();
    await controller.update(ID, { expectedVersion: 4, relationship: 'active' });
    expect(service.update).toHaveBeenCalledWith(ID, 4, { relationship: 'active' });
  });

  it('is a 400 without expectedVersion', () => {
    const { controller } = setup();
    expect(() => controller.update(ID, { legalName: 'Acme' })).toThrow(BadRequestException);
  });
});

describe('POST /v1/customers/:id/contacts', () => {
  it('is a 400 without an Idempotency-Key', () => {
    const { controller } = setup();
    expect(() => controller.createContact(ID, undefined, { fullName: 'Sita Rai' })).toThrow(
      /Idempotency-Key/,
    );
  });

  it.each(['9812345678', '+0123456789', '+977 981 234', '+97798123456789012'])(
    'is a 400 for the phone number %s (not E.164)',
    (phone) => {
      const { service, controller } = setup();
      expect(() => controller.createContact(ID, 'k1', { fullName: 'Sita Rai', phone })).toThrow(
        BadRequestException,
      );
      expect(service.createContact).not.toHaveBeenCalled();
    },
  );

  it('accepts an E.164 number', async () => {
    const { service, controller } = setup();
    await controller.createContact(ID, 'k1', { fullName: 'Sita Rai', phone: '+9779812345678' });
    expect(service.createContact).toHaveBeenCalledWith(
      ID,
      { fullName: 'Sita Rai', phone: '+9779812345678', isPrimary: false },
      'k1',
    );
  });
});

describe('route permissions', () => {
  const needs = (method: keyof CustomersController): unknown =>
    Reflect.getMetadata(CAN_KEY, CustomersController.prototype[method]);

  const anyAuthenticated = (method: keyof CustomersController): unknown =>
    Reflect.getMetadata(ANY_AUTHENTICATED_KEY, CustomersController.prototype[method]);

  it('reads need customer.read and writes need customer.write (merge is not routed here)', () => {
    expect(needs('list')).toBe('customer.read');
    expect(needs('get')).toBe('customer.read');
    expect(needs('contacts')).toBe('customer.read');
    expect(needs('create')).toBe('customer.write');
    expect(needs('createContact')).toBe('customer.write');
  });

  it('opens the edit and the terms to any signed-in user, so the service decides between two permissions', () => {
    // PATCH :id: customer.write or customers.owner.write; PATCH :id/terms: customer.write or
    // customers.credit_limit.write. A @Can here would shut out Management (owner) or Finance (credit limit).
    for (const method of ['update', 'updateTerms'] as const) {
      expect(needs(method)).toBeUndefined();
      expect(anyAuthenticated(method)).toBe(true);
    }
  });
});

describe('PATCH /v1/customers/:id/terms', () => {
  it('passes the parsed body through, keeping null apart from absent', async () => {
    const { service, controller } = setup();
    const body = { organizationId: ID, creditLimit: null, expectedVersion: 2 };
    await controller.updateTerms(ID, body);
    expect(service.updateTerms).toHaveBeenCalledWith(ID, body);
  });

  it('is a 400 for an empty body, no entity, three decimals or an unknown key, before the service is called', () => {
    const { service, controller } = setup();
    const organizationId = ID;
    expect(() => controller.updateTerms(ID, { organizationId })).toThrow(BadRequestException);
    expect(() => controller.updateTerms(ID, { creditLimit: '1.00' })).toThrow(BadRequestException);
    expect(() => controller.updateTerms(ID, { organizationId, creditLimit: '1.005' })).toThrow(
      BadRequestException,
    );
    expect(() =>
      controller.updateTerms(ID, { organizationId, creditLimit: '1.00', owner: 'x' }),
    ).toThrow(BadRequestException);
    expect(service.updateTerms).not.toHaveBeenCalled();
  });
});
