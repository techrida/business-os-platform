// Unit tests of the thin HTTP layer of the quotation send: the route carries @Can('quotation.send') and answers
// 200, the Idempotency-Key header is required, the body is parsed with SendQuotationBodySchema (strict:
// recipientContactId, optional message, expectedVersion) before the service is called, and the ids reach the
// service as given. The service is a fake; its rules are in the service unit test and the integration test.
import 'reflect-metadata';

import { BadRequestException, HttpStatus } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { describe, expect, it, vi } from 'vitest';

import { CAN_KEY } from '../../../platform/authz/decorators';
import { findUnmarkedRoutes } from '../../../platform/authz/route-policy.check';
import { QuotationSendController } from './quotation-send.controller';
import { QuotationSendService } from './quotation-send.service';

const QID = '3f1c2a52-9a7e-4c41-8f6e-2b1a1d0c9e11';
const VID = '4f1c2a52-9a7e-4c41-8f6e-2b1a1d0c9e12';
const CONTACT = '5f1c2a52-9a7e-4c41-8f6e-2b1a1d0c9e13';
const BODY = { recipientContactId: CONTACT, expectedVersion: 3 };

async function setup() {
  const service = { send: vi.fn().mockResolvedValue({ marker: 'version' }) };
  const moduleRef = await Test.createTestingModule({
    controllers: [QuotationSendController],
    providers: [{ provide: QuotationSendService, useValue: service }],
  }).compile();
  return { service, moduleRef, controller: moduleRef.get(QuotationSendController) };
}

describe('POST /v1/quotations/:id/versions/:vid/send', () => {
  it('needs quotation.send, answers 200 and leaves no route unmarked', async () => {
    const { moduleRef } = await setup();
    const handler = QuotationSendController.prototype.send;
    expect(Reflect.getMetadata(CAN_KEY, handler)).toBe('quotation.send');
    expect(Reflect.getMetadata('__httpCode__', handler)).toBe(HttpStatus.OK);
    expect(Reflect.getMetadata('path', handler)).toBe(':id/versions/:vid/send');
    expect(Reflect.getMetadata('path', QuotationSendController)).toBe('v1/quotations');
    expect(findUnmarkedRoutes(moduleRef)).toEqual([]);
    await moduleRef.close();
  });

  it('passes the ids, the parsed body and the key to the service and returns its version DTO', async () => {
    const { service, controller } = await setup();
    const body = { ...BODY, message: 'Here is our offer' };
    await expect(controller.send(QID, VID, 'key-1', body)).resolves.toEqual({ marker: 'version' });
    expect(service.send).toHaveBeenCalledWith(QID, VID, body, 'key-1');
  });

  it('is a 400 without a usable Idempotency-Key, and the service is not called', async () => {
    const { service, controller } = await setup();
    for (const key of [undefined, '', 'x'.repeat(201)]) {
      expect(() => controller.send(QID, VID, key, BODY), JSON.stringify(key)).toThrow(
        /Idempotency-Key/,
      );
    }
    expect(service.send).not.toHaveBeenCalled();
  });

  it('is a 400 for a body outside SendQuotationBodySchema, and the service is not called', async () => {
    const { service, controller } = await setup();
    for (const bad of [
      {},
      { expectedVersion: 3 },
      { recipientContactId: 'not-a-uuid', expectedVersion: 3 },
      { recipientContactId: CONTACT, expectedVersion: 0 },
      { ...BODY, attachment: 'quote.pdf' },
      { ...BODY, message: 'x'.repeat(2001) },
      null,
      undefined,
    ]) {
      expect(() => controller.send(QID, VID, 'key-1', bad), JSON.stringify(bad)).toThrow(
        BadRequestException,
      );
    }
    expect(service.send).not.toHaveBeenCalled();
  });
});
