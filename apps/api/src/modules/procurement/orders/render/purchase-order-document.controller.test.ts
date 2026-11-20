// Unit tests of the thin HTTP layer of the purchase order PDF: the download route carries @Can('procurement.po.issue')
// and is a GET of :id/versions/:version/document; the retry route (round 4, R4c2) carries the same permission (issuing
// triggers the render) and is a POST of :id/versions/:version/document/retry answering 202. Both pass the ids to the
// service as given. The service is a fake; its rules are in the integration test.
import 'reflect-metadata';

import { DEFAULT_ROLE_PERMISSIONS, type Permission, type Scope } from '@bos/contracts';
import { RequestMethod } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { describe, expect, it, vi } from 'vitest';

import { can } from '../../../../platform/authz/can';
import { CAN_KEY } from '../../../../platform/authz/decorators';
import type { Principal } from '../../../../platform/authz/principal';
import { findUnmarkedRoutes } from '../../../../platform/authz/route-policy.check';
import { PurchaseOrderDocumentController } from './purchase-order-document.controller';
import { PurchaseOrderDocumentService } from './purchase-order-document.service';

const ID = '3f1c2a52-9a7e-4c41-8f6e-2b1a1d0c9e11';
const LINK = { url: '/v1/files/token', expiresAt: '2026-11-09T06:01:00.000Z' };

async function setup() {
  const service = {
    link: vi.fn().mockResolvedValue(LINK),
    retry: vi.fn().mockResolvedValue({ state: 'queued' }),
  };
  const moduleRef = await Test.createTestingModule({
    controllers: [PurchaseOrderDocumentController],
    providers: [{ provide: PurchaseOrderDocumentService, useValue: service }],
  }).compile();
  return { service, moduleRef, controller: moduleRef.get(PurchaseOrderDocumentController) };
}

describe('POST /v1/procurement/purchase-orders/:id/versions/:version/document/retry', () => {
  it('needs procurement.po.issue like the download, is a POST answering 202 and passes the ids on', async () => {
    const { moduleRef, controller, service } = await setup();
    const handler = PurchaseOrderDocumentController.prototype.retry;
    expect(Reflect.getMetadata(CAN_KEY, handler)).toBe('procurement.po.issue');
    expect(Reflect.getMetadata(CAN_KEY, PurchaseOrderDocumentController.prototype.link)).toBe(
      'procurement.po.issue',
    );
    expect(Reflect.getMetadata('path', handler)).toBe(':id/versions/:version/document/retry');
    expect(Reflect.getMetadata('method', handler)).toBe(RequestMethod.POST);
    expect(Reflect.getMetadata('__httpCode__', handler)).toBe(202);
    expect(findUnmarkedRoutes(moduleRef)).toEqual([]);
    await expect(controller.retry(ID, 2)).resolves.toEqual({ state: 'queued' });
    expect(service.retry).toHaveBeenCalledWith(ID, 2);
    await moduleRef.close();
  });

  it('refuses a role without procurement.po.issue (management) and allows procurement', () => {
    const action = Reflect.getMetadata(
      CAN_KEY,
      PurchaseOrderDocumentController.prototype.retry,
    ) as Permission;
    expect(can(staffWithRole('management'), action).allowed).toBe(false);
    expect(can(staffWithRole('procurement'), action).allowed).toBe(true);
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
