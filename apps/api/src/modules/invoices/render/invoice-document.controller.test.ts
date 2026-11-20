// Unit tests of the thin HTTP layer of the invoice PDF: the download route carries @Can('invoice.read') and is a GET
// of :id/document; the retry route (round 4, R4c2) carries @Can('invoice.issue'), the permission of the action that
// triggers the render, and is a POST of :id/document/retry answering 202. Both pass the id to the service as given.
// The service is a fake; its rules are in the integration test.
import 'reflect-metadata';

import { DEFAULT_ROLE_PERMISSIONS, type Permission, type Scope } from '@bos/contracts';
import { RequestMethod } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { describe, expect, it, vi } from 'vitest';

import { can } from '../../../platform/authz/can';
import { CAN_KEY } from '../../../platform/authz/decorators';
import type { Principal } from '../../../platform/authz/principal';
import { findUnmarkedRoutes } from '../../../platform/authz/route-policy.check';
import { InvoiceDocumentController } from './invoice-document.controller';
import { InvoiceDocumentService } from './invoice-document.service';

const ID = '3f1c2a52-9a7e-4c41-8f6e-2b1a1d0c9e11';
const LINK = { url: '/v1/files/token', expiresAt: '2026-11-09T06:01:00.000Z' };

async function setup() {
  const service = {
    link: vi.fn().mockResolvedValue(LINK),
    retry: vi.fn().mockResolvedValue({ state: 'queued' }),
  };
  const moduleRef = await Test.createTestingModule({
    controllers: [InvoiceDocumentController],
    providers: [{ provide: InvoiceDocumentService, useValue: service }],
  }).compile();
  return { service, moduleRef, controller: moduleRef.get(InvoiceDocumentController) };
}

describe('GET /v1/invoices/:id/document', () => {
  it('needs invoice.read and leaves no route unmarked', async () => {
    const { moduleRef } = await setup();
    const handler = InvoiceDocumentController.prototype.link;
    expect(Reflect.getMetadata(CAN_KEY, handler)).toBe('invoice.read');
    expect(Reflect.getMetadata('path', handler)).toBe(':id/document');
    expect(Reflect.getMetadata('path', InvoiceDocumentController)).toBe('v1/invoices');
    expect(findUnmarkedRoutes(moduleRef)).toEqual([]);
    await moduleRef.close();
  });
});

describe('POST /v1/invoices/:id/document/retry', () => {
  it('needs invoice.issue, is a POST answering 202 and passes the id to the service', async () => {
    const { moduleRef, controller, service } = await setup();
    const handler = InvoiceDocumentController.prototype.retry;
    expect(Reflect.getMetadata(CAN_KEY, handler)).toBe('invoice.issue');
    expect(Reflect.getMetadata('path', handler)).toBe(':id/document/retry');
    expect(Reflect.getMetadata('method', handler)).toBe(RequestMethod.POST);
    expect(Reflect.getMetadata('__httpCode__', handler)).toBe(202);
    await expect(controller.retry(ID)).resolves.toEqual({ state: 'queued' });
    expect(service.retry).toHaveBeenCalledWith(ID);
    await moduleRef.close();
  });

  it('refuses a reader who may not issue (management) and allows finance', () => {
    const action = Reflect.getMetadata(
      CAN_KEY,
      InvoiceDocumentController.prototype.retry,
    ) as Permission;
    const management = staffWithRole('management');
    expect(can(management, 'invoice.read').allowed).toBe(true);
    expect(can(management, action).allowed).toBe(false);
    expect(can(staffWithRole('finance'), action).allowed).toBe(true);
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
