// Unit tests of the thin HTTP layer of the quotation PDF download: the route carries @Can('quotation.read'), is a
// GET of :id/versions/:vid/document, and passes the ids to the service as given. The service is a fake; its rules
// are in the service unit test and the integration test.
import 'reflect-metadata';

import { Test } from '@nestjs/testing';
import { describe, expect, it, vi } from 'vitest';

import { CAN_KEY } from '../../../platform/authz/decorators';
import { findUnmarkedRoutes } from '../../../platform/authz/route-policy.check';
import { QuotationDocumentController } from './quotation-document.controller';
import { QuotationDocumentService } from './quotation-document.service';

const QID = '3f1c2a52-9a7e-4c41-8f6e-2b1a1d0c9e11';
const VID = '4f1c2a52-9a7e-4c41-8f6e-2b1a1d0c9e12';
const LINK = { url: '/v1/files/token', expiresAt: '2026-11-09T06:01:00.000Z' };

async function setup() {
  const service = { link: vi.fn().mockResolvedValue(LINK) };
  const moduleRef = await Test.createTestingModule({
    controllers: [QuotationDocumentController],
    providers: [{ provide: QuotationDocumentService, useValue: service }],
  }).compile();
  return { service, moduleRef, controller: moduleRef.get(QuotationDocumentController) };
}

describe('GET /v1/quotations/:id/versions/:vid/document', () => {
  it('needs quotation.read and leaves no route unmarked', async () => {
    const { moduleRef } = await setup();
    const handler = QuotationDocumentController.prototype.link;
    expect(Reflect.getMetadata(CAN_KEY, handler)).toBe('quotation.read');
    expect(Reflect.getMetadata('path', handler)).toBe(':id/versions/:vid/document');
    expect(Reflect.getMetadata('path', QuotationDocumentController)).toBe('v1/quotations');
    expect(findUnmarkedRoutes(moduleRef)).toEqual([]);
    await moduleRef.close();
  });

  it('passes the ids to the service and returns its signed link', async () => {
    const { service, controller } = await setup();
    await expect(controller.link(QID, VID)).resolves.toEqual(LINK);
    expect(service.link).toHaveBeenCalledWith(QID, VID);
  });
});
