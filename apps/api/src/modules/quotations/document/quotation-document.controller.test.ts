// Unit tests of the thin HTTP layer of the quotation PDF: the download route carries @Can('quotation.read') and is a
// GET of :id/versions/:vid/document; the retry route carries @Can('quotation.send'), is a POST of
// :id/versions/:vid/document/retry answering 202. Both pass the ids to the service as given. The service is a fake; its rules
// are in the service unit test and the integration test.
import 'reflect-metadata';

import { DEFAULT_ROLE_PERMISSIONS, type Permission, type Scope } from '@bos/contracts';
import { RequestMethod } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { describe, expect, it, vi } from 'vitest';

import { can } from '../../../platform/authz/can';
import { CAN_KEY } from '../../../platform/authz/decorators';
import type { Principal } from '../../../platform/authz/principal';
import { findUnmarkedRoutes } from '../../../platform/authz/route-policy.check';
import { QuotationDocumentController } from './quotation-document.controller';
import { QuotationDocumentService } from './quotation-document.service';

const QID = '3f1c2a52-9a7e-4c41-8f6e-2b1a1d0c9e11';
const VID = '4f1c2a52-9a7e-4c41-8f6e-2b1a1d0c9e12';
const LINK = { url: '/v1/files/token', expiresAt: '2026-11-09T06:01:00.000Z' };

async function setup() {
  const service = {
    link: vi.fn().mockResolvedValue(LINK),
    retry: vi.fn().mockResolvedValue({ state: 'queued' }),
  };
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

describe('POST /v1/quotations/:id/versions/:vid/document/retry', () => {
  it('needs quotation.send, is a POST answering 202 and leaves no route unmarked', async () => {
    const { moduleRef } = await setup();
    const handler = QuotationDocumentController.prototype.retry;
    expect(Reflect.getMetadata(CAN_KEY, handler)).toBe('quotation.send');
    expect(Reflect.getMetadata('path', handler)).toBe(':id/versions/:vid/document/retry');
    expect(Reflect.getMetadata('method', handler)).toBe(RequestMethod.POST);
    expect(Reflect.getMetadata('__httpCode__', handler)).toBe(202);
    expect(findUnmarkedRoutes(moduleRef)).toEqual([]);
    await moduleRef.close();
  });

  it('passes the ids to the service and returns its answer', async () => {
    const { service, controller } = await setup();
    await expect(controller.retry(QID, VID)).resolves.toEqual({ state: 'queued' });
    expect(service.retry).toHaveBeenCalledWith(QID, VID);
  });
});

/** A staff principal holding the default grants of `role`, as the role cache loads them from a fresh seed. */
function staffWithRole(role: keyof typeof DEFAULT_ROLE_PERMISSIONS): Principal {
  return {
    userId: '00000000-0000-4000-8000-000000000003',
    zitadelUserId: 'z-me',
    tenantId: '00000000-0000-4000-8000-000000000001',
    organizationId: '00000000-0000-4000-8000-000000000002',
    orgKind: 'staff',
    partyId: null,
    idpOrgId: '00000000-0000-4000-8000-000000000009',
    roles: [role],
    departmentId: null,
    status: 'active',
    grants: new Map(Object.entries(DEFAULT_ROLE_PERMISSIONS[role]) as [Permission, Scope][]),
  };
}

// The tenancy interceptor answers a denied @Can with the same 403 body as every other route. The workspace hides
// Retry from the same readers (quotations/[id]/pdf-retry.test.tsx).
describe('POST /v1/quotations/:id/versions/:vid/document/retry: who is refused', () => {
  it('refuses a reader who may not send (management) and allows sales', () => {
    const action = Reflect.getMetadata(CAN_KEY, QuotationDocumentController.prototype.retry) as Permission;
    const management = staffWithRole('management');
    expect(can(management, 'quotation.read').allowed).toBe(true);
    expect(can(management, action).allowed).toBe(false);
    expect(can(staffWithRole('sales'), action).allowed).toBe(true);
  });
});
