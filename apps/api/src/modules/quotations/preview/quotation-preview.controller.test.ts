// Unit tests of the thin HTTP layer of the quotation preview: the route carries @Can('quotation.draft'), the body is
// parsed with the contract before the service is called (strict: no unknown field, at least one line), and the
// ids reach the service as given. The service is a fake; its rules run on Postgres in the integration test.
import 'reflect-metadata';

import { BadRequestException, HttpStatus } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { describe, expect, it, vi } from 'vitest';

import { CAN_KEY } from '../../../platform/authz/decorators';
import { findUnmarkedRoutes } from '../../../platform/authz/route-policy.check';
import { QuotationPreviewController } from './quotation-preview.controller';
import { QuotationPreviewService } from './quotation-preview.service';

const QID = '3f1c2a52-9a7e-4c41-8f6e-2b1a1d0c9e11';
const VID = '4f1c2a52-9a7e-4c41-8f6e-2b1a1d0c9e12';
const TAX = '5f1c2a52-9a7e-4c41-8f6e-2b1a1d0c9e13';
const line = {
  description: 'Design',
  uom: 'job',
  quantity: '1',
  unitPrice: '100.00',
  taxCodeId: TAX,
};

async function setup() {
  const service = { preview: vi.fn().mockResolvedValue({ marker: 'result' }) };
  const moduleRef = await Test.createTestingModule({
    controllers: [QuotationPreviewController],
    providers: [{ provide: QuotationPreviewService, useValue: service }],
  }).compile();
  return { service, moduleRef, controller: moduleRef.get(QuotationPreviewController) };
}

describe('POST /v1/quotations/:id/versions/:vid/preview', () => {
  it('needs quotation.draft, answers 200 and leaves no route unmarked', async () => {
    const { moduleRef } = await setup();
    const handler = QuotationPreviewController.prototype.preview;
    expect(Reflect.getMetadata(CAN_KEY, handler)).toBe('quotation.draft');
    expect(Reflect.getMetadata('__httpCode__', handler)).toBe(HttpStatus.OK);
    expect(Reflect.getMetadata('path', handler)).toBe(':id/versions/:vid/preview');
    expect(Reflect.getMetadata('path', QuotationPreviewController)).toBe('v1/quotations');
    expect(findUnmarkedRoutes(moduleRef)).toEqual([]);
    await moduleRef.close();
  });

  it('passes the ids and the parsed body to the service and returns its result', async () => {
    const { service, controller } = await setup();
    const body = { currency: 'NPR', discount: { mode: 'pct', value: '13' }, lines: [line] };
    await expect(controller.preview(QID, VID, body)).resolves.toEqual({ marker: 'result' });
    expect(service.preview).toHaveBeenCalledWith(QID, VID, body);
  });

  it('is a 400 for a body the workspace never sends, and the service is not called', async () => {
    const { service, controller } = await setup();
    for (const bad of [
      {},
      { currency: 'NPR', lines: [] },
      { currency: 'EUR', lines: [line] },
      { currency: 'NPR', lines: [line], issueDate: '2026-11-09' },
      { currency: 'NPR', lines: [{ ...line, quantity: '0' }] },
      { currency: 'NPR', lines: [line], discount: { mode: 'pct', value: '120' } },
      undefined,
    ]) {
      expect(() => controller.preview(QID, VID, bad), JSON.stringify(bad)).toThrow(
        BadRequestException,
      );
    }
    expect(service.preview).not.toHaveBeenCalled();
  });
});
