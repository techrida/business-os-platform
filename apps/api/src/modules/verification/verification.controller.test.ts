// Unit tests of the verification routes with a fake service: what the edge refuses before any rule runs
// (400s), the status codes, and that every route names its policy (deny by default).
import 'reflect-metadata';

import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { Permission } from '@bos/contracts';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { configureApp } from '../../app.setup';
import { ANY_AUTHENTICATED_KEY, CAN_KEY } from '../../platform/authz/decorators';
import { ErrorBodyFilter } from '../../platform/tenancy/error-body.filter';
import { VerificationController } from './verification.controller';
import { VerificationService } from './verification.service';

const ID = randomUUID();
const dto = { id: ID, status: 'draft' };
const service = {
  list: vi.fn(),
  get: vi.fn(),
  create: vi.fn(),
  setChecklistItem: vi.fn(),
  removeChecklistDocument: vi.fn(),
  submit: vi.fn(),
  decide: vi.fn(),
};

let app: INestApplication;
let baseUrl: string;

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({
    controllers: [VerificationController],
    providers: [{ provide: VerificationService, useValue: service }],
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
  service.create.mockResolvedValue({ case: dto, created: true });
  service.decide.mockResolvedValue(dto);
});

describe('route policy', () => {
  const proto = VerificationController.prototype as unknown as Record<string, object>;

  it('names a permission on the read and decision routes', () => {
    const wanted: Record<string, Permission> = {
      list: 'verification.read',
      get: 'verification.read',
      decide: 'verification.review',
    };
    for (const [method, permission] of Object.entries(wanted)) {
      expect(Reflect.getMetadata(CAN_KEY, proto[method]!), method).toBe(permission);
      expect(Reflect.getMetadata(ANY_AUTHENTICATED_KEY, proto[method]!), method).toBeUndefined();
    }
  });

  // A customer case is written with customer.write and a vendor case with vendor.write, so no single route-level
  // permission fits: the service checks the party kind's write permission before it reads anything.
  it('leaves the write routes to the service, with no single route-level permission', () => {
    for (const method of ['create', 'setChecklist', 'removeChecklist', 'submit']) {
      expect(Reflect.getMetadata(ANY_AUTHENTICATED_KEY, proto[method]!), method).toBe(true);
      expect(Reflect.getMetadata(CAN_KEY, proto[method]!), method).toBeUndefined();
    }
  });

  // Detaching a checklist file and removing a loose file exist only on customer document-review cases (a vendor
  // case has no case files), so customer.write is the right route permission, not a dead end for vendor writers.
  it('names customer.write on the two customer-only file routes', () => {
    for (const method of ['detachItem', 'removeLooseDocument']) {
      expect(Reflect.getMetadata(CAN_KEY, proto[method]!), method).toBe('customer.write');
      expect(Reflect.getMetadata(ANY_AUTHENTICATED_KEY, proto[method]!), method).toBeUndefined();
    }
  });
});

describe('POST /v1/verification-cases', () => {
  it('answers 201 for a new case and 200 for an existing one', async () => {
    const partyId = randomUUID();
    const post = () => request(baseUrl).post('/v1/verification-cases').send({ partyId });
    expect((await post()).status).toBe(201);
    service.create.mockResolvedValue({ case: dto, created: false });
    expect((await post()).status).toBe(200);
  });

  it('is 400 for a missing, malformed or extra field, and never reaches the service', async () => {
    for (const body of [{}, { partyId: 'x' }, { partyId: randomUUID(), tenantId: randomUUID() }]) {
      expect((await request(baseUrl).post('/v1/verification-cases').send(body)).status).toBe(400);
    }
    expect(service.create).not.toHaveBeenCalled();
  });
});

describe('POST /v1/verification-cases/:id/decision', () => {
  const url = `/v1/verification-cases/${ID}/decision`;

  it('is 400 when a rejection has no reason', async () => {
    const res = await request(baseUrl).post(url).send({ decision: 'reject', expectedVersion: 2 });
    expect(res.status).toBe(400);
    expect(service.decide).not.toHaveBeenCalled();
  });

  it('is 400 when an approval has no comment either (the UI asks for one)', async () => {
    const res = await request(baseUrl).post(url).send({ decision: 'approve', expectedVersion: 2 });
    expect(res.status).toBe(400);
    expect(service.decide).not.toHaveBeenCalled();
  });

  it('is 400 for an unknown decision, a missing version, an extra field and a bad id', async () => {
    const base = { decision: 'approve', comment: 'ok', expectedVersion: 2 };
    for (const body of [
      { ...base, decision: 'maybe' },
      { decision: 'approve', comment: 'ok' },
      { ...base, reviewedBy: randomUUID() },
      { ...base, reason: 'old name of comment' },
    ]) {
      expect((await request(baseUrl).post(url).send(body)).status).toBe(400);
    }
    const badId = await request(baseUrl).post('/v1/verification-cases/nope/decision').send(base);
    expect(badId.status).toBe(400);
    expect(service.decide).not.toHaveBeenCalled();
  });

  it('passes a valid decision and its Idempotency-Key to the service; a malformed key is 400', async () => {
    const body = { decision: 'reject', comment: 'Expired ID', expectedVersion: 3 };
    const res = await request(baseUrl).post(url).set('Idempotency-Key', 'key-1').send(body);
    expect(res.status).toBe(200);
    expect(service.decide).toHaveBeenCalledWith(ID, body, 'key-1');
    await request(baseUrl).post(url).send(body);
    expect(service.decide).toHaveBeenLastCalledWith(ID, body, undefined);
    service.decide.mockClear();
    const bad = await request(baseUrl).post(url).set('Idempotency-Key', 'a b').send(body);
    expect(bad.status).toBe(400);
    expect(service.decide).not.toHaveBeenCalled();
  });
});

describe('GET and PATCH', () => {
  it('rejects an unknown filter and a malformed checklist body with 400', async () => {
    const list = (query: Record<string, string>) =>
      request(baseUrl).get('/v1/verification-cases').query(query);
    expect((await list({ status: 'bogus' })).status).toBe(400);
    expect((await list({ owner: 'me' })).status).toBe(400);
    const url = `/v1/verification-cases/${ID}/checklist`;
    for (const body of [
      {},
      { key: 'nope', documentId: randomUUID(), expectedVersion: 1 },
      { key: 'other', documentId: randomUUID() },
    ]) {
      expect((await request(baseUrl).patch(url).send(body)).status).toBe(400);
    }
    expect(service.list).not.toHaveBeenCalled();
    expect(service.setChecklistItem).not.toHaveBeenCalled();
  });

  it('answers a list with a bare array and the full count in X-Total-Count', async () => {
    service.list.mockResolvedValue({ rows: [dto], total: 41 });
    const res = await request(baseUrl).get('/v1/verification-cases').query({ status: 'draft' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual([dto]);
    expect(res.headers['x-total-count']).toBe('41');
    expect(service.list).toHaveBeenCalledWith(
      expect.objectContaining({ status: ['draft'], limit: 25, offset: 0 }),
    );
  });

  it('takes repeated filters, search and paging, and refuses an unknown value', async () => {
    service.list.mockResolvedValue({ rows: [], total: 0 });
    const res = await request(baseUrl).get(
      '/v1/verification-cases?status=submitted&status=draft&partyKind=vendor&q=Himalayan&limit=10&offset=20',
    );
    expect(res.status).toBe(200);
    expect(res.headers['x-total-count']).toBe('0');
    expect(service.list).toHaveBeenCalledWith({
      status: ['submitted', 'draft'],
      partyKind: ['vendor'],
      q: 'Himalayan',
      limit: 10,
      offset: 20,
    });
    const bad = (query: string) => request(baseUrl).get(`/v1/verification-cases?${query}`);
    expect((await bad('partyKind=supplier')).status).toBe(400);
    expect((await bad('status=submitted&status=bogus')).status).toBe(400);
    expect((await bad('limit=101')).status).toBe(400);
  });
});

describe('POST /v1/verification-cases/:id/checklist/remove', () => {
  const url = `/v1/verification-cases/${ID}/checklist/remove`;
  const body = { key: 'other', expectedVersion: 2 };

  it('returns the updated case from the removal operation', async () => {
    service.removeChecklistDocument.mockResolvedValue(dto);
    const res = await request(baseUrl).post(url).send(body);
    expect(res.status).toBe(200);
    expect(res.body).toEqual(dto);
    expect(service.removeChecklistDocument).toHaveBeenCalledWith(ID, body);
    expect(service.setChecklistItem).not.toHaveBeenCalled();
  });

  it('requires a checklist key and a positive integer version', async () => {
    for (const invalid of [
      {},
      { key: 'other' },
      { ...body, key: 'unknown' },
      { ...body, expectedVersion: 0 },
      { ...body, expectedVersion: 1.5 },
      { ...body, documentId: randomUUID() },
    ]) {
      expect((await request(baseUrl).post(url).send(invalid)).status).toBe(400);
    }
    expect(service.removeChecklistDocument).not.toHaveBeenCalled();
  });
});
