// Unit tests of the vendor portal-access route (K4) with a fake service: the permission it names (deny by default)
// and what the edge refuses before any rule runs (no Idempotency-Key, a bad body, a bad id).
import 'reflect-metadata';

import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { configureApp } from '../../app.setup';
import { CAN_KEY } from '../../platform/authz/decorators';
import { ErrorBodyFilter } from '../../platform/tenancy/error-body.filter';
import { VendorPortalAccessService } from './portal-access.service';
import { VendorPortalAccessController } from './vendor-portal-access.controller';

const VENDOR = randomUUID();
const CONTACT = randomUUID();
const service = { grant: vi.fn() };

let app: INestApplication;
let baseUrl: string;

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({
    controllers: [VendorPortalAccessController],
    providers: [{ provide: VendorPortalAccessService, useValue: service }],
  }).compile();
  app = moduleRef.createNestApplication({ rawBody: true, logger: false });
  configureApp(app);
  app.useGlobalFilters(new ErrorBodyFilter());
  await app.listen(0, '127.0.0.1');
  baseUrl = `http://127.0.0.1:${((app.getHttpServer() as Server).address() as AddressInfo).port}`;
});
afterAll(async () => {
  await app?.close();
});
beforeEach(() => {
  vi.resetAllMocks();
  service.grant.mockResolvedValue({ status: 201, response: { vendorId: VENDOR } });
});

const post = (path = `/v1/vendors/${VENDOR}/portal-access`) =>
  request(baseUrl).post(path).set('Idempotency-Key', 'k-1');

describe('route policy', () => {
  it('names vendor.write', () => {
    const proto = VendorPortalAccessController.prototype as unknown as Record<string, unknown>;
    expect(Reflect.getMetadata(CAN_KEY, proto.grant as object)).toBe('vendor.write');
  });
});

describe('POST /v1/vendors/:id/portal-access', () => {
  it('answers 201 and hands the key and the parsed body to the service', async () => {
    const res = await post().send({ contactId: CONTACT });
    expect(res.status).toBe(201);
    expect(service.grant).toHaveBeenCalledWith(VENDOR, { contactId: CONTACT }, 'k-1');
  });

  it('answers 400 without an Idempotency-Key', async () => {
    const res = await request(baseUrl)
      .post(`/v1/vendors/${VENDOR}/portal-access`)
      .send({ contactId: CONTACT });
    expect(res.status).toBe(400);
    expect(service.grant).not.toHaveBeenCalled();
  });

  it.each([{}, { contactId: 'not-a-uuid' }, { contactId: CONTACT, extra: 1 }])(
    'answers 400 for the body %j',
    async (body) => {
      expect((await post().send(body)).status).toBe(400);
      expect(service.grant).not.toHaveBeenCalled();
    },
  );

  it('answers 400 for a vendor id that is not a uuid', async () => {
    expect((await post('/v1/vendors/nope/portal-access').send({ contactId: CONTACT })).status).toBe(
      400,
    );
  });
});
