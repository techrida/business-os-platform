// Unit tests of the thin HTTP layer of the quotation submit: the route carries @Can('quotation.submit') and answers
// 200, the Idempotency-Key header is required, the body is parsed with SubmitQuotationBodySchema (strict: only
// expectedVersion) before the service is called, and the ids reach the service as given. The service is a fake;
// its rules are in the service unit test and, on Postgres, the integration test.
import 'reflect-metadata';

import { BadRequestException, HttpStatus } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { describe, expect, it, vi } from 'vitest';

import { CAN_KEY } from '../../../platform/authz/decorators';
import { findUnmarkedRoutes } from '../../../platform/authz/route-policy.check';
import { QuotationSubmitController } from './quotation-submit.controller';
import { QuotationSubmitService } from './quotation-submit.service';

const QID = '3f1c2a52-9a7e-4c41-8f6e-2b1a1d0c9e11';
const VID = '4f1c2a52-9a7e-4c41-8f6e-2b1a1d0c9e12';

async function setup() {
  const service = { submit: vi.fn().mockResolvedValue({ marker: 'version' }) };
  const moduleRef = await Test.createTestingModule({
    controllers: [QuotationSubmitController],
    providers: [{ provide: QuotationSubmitService, useValue: service }],
  }).compile();
  return { service, moduleRef, controller: moduleRef.get(QuotationSubmitController) };
}

describe('POST /v1/quotations/:id/versions/:vid/submit', () => {
  it('needs quotation.submit, answers 200 and leaves no route unmarked', async () => {
    const { moduleRef } = await setup();
    const handler = QuotationSubmitController.prototype.submit;
    expect(Reflect.getMetadata(CAN_KEY, handler)).toBe('quotation.submit');
    expect(Reflect.getMetadata('__httpCode__', handler)).toBe(HttpStatus.OK);
    expect(Reflect.getMetadata('path', handler)).toBe(':id/versions/:vid/submit');
    expect(Reflect.getMetadata('path', QuotationSubmitController)).toBe('v1/quotations');
    expect(findUnmarkedRoutes(moduleRef)).toEqual([]);
    await moduleRef.close();
  });

  it('passes the ids, the parsed body and the key to the service and returns its version DTO', async () => {
    const { service, controller } = await setup();
    await expect(controller.submit(QID, VID, 'key-1', { expectedVersion: 3 })).resolves.toEqual({
      marker: 'version',
    });
    expect(service.submit).toHaveBeenCalledWith(QID, VID, { expectedVersion: 3 }, 'key-1');
  });

  it('is a 400 without a usable Idempotency-Key, and the service is not called', async () => {
    const { service, controller } = await setup();
    for (const key of [undefined, '', 'x'.repeat(201)]) {
      expect(
        () => controller.submit(QID, VID, key, { expectedVersion: 1 }),
        JSON.stringify(key),
      ).toThrow(/Idempotency-Key/);
    }
    expect(service.submit).not.toHaveBeenCalled();
  });

  it('is a 400 for a body other than { expectedVersion }, and the service is not called', async () => {
    const { service, controller } = await setup();
    for (const bad of [
      {},
      { expectedVersion: 0 },
      { expectedVersion: 1.5 },
      { expectedVersion: '1' },
      { expectedVersion: 1, status: 'approved' },
      null,
      undefined,
    ]) {
      expect(() => controller.submit(QID, VID, 'key-1', bad), JSON.stringify(bad)).toThrow(
        BadRequestException,
      );
    }
    expect(service.submit).not.toHaveBeenCalled();
  });
});
