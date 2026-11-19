// Unit tests of the portal read routes with the real PortalService and fake reads: every route carries
// @Can('portal.quotation.read'), the id carries a UUID pipe, a staff caller (even a founder, who holds the portal
// grants at `all`) gets 403 without a single read, and a customer gets the service's answer.
// `GET /v1/portal/display` is open to any active principal at route level (customers and vendors hold different
// portal permissions); the service refuses every caller but a customer or vendor with a party.
import 'reflect-metadata';

import { ForbiddenException, ParseUUIDPipe } from '@nestjs/common';
import { PATH_METADATA, ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { Test } from '@nestjs/testing';
import { describe, expect, it, vi } from 'vitest';

import { IS_PUBLIC_KEY } from '../../platform/auth/public.decorator';
import { ANY_AUTHENTICATED_KEY, CAN_KEY } from '../../platform/authz/decorators';
import type { Principal } from '../../platform/authz/principal';
import { findUnmarkedRoutes } from '../../platform/authz/route-policy.check';
import { DocumentsService } from '../../platform/documents/documents.service';
import { SettingsService } from '../../platform/settings/settings.service';
import { PortalCaller } from './portal.caller';
import { PortalController, PortalDisplayController } from './portal.controller';
import { PortalService } from './portal.service';
import { PORTAL_QUOTATION_STORE } from './portal.store';

const ID = '4f6c7a5e-0d52-4d1e-9d8a-3f1d2c3b4a5f';

const principalOf = (over: Partial<Principal>): Principal => ({
  userId: '0a000000-0000-4000-8000-000000000009',
  zitadelUserId: 'zitadel-sub-1',
  tenantId: '0a000000-0000-4000-8000-000000000001',
  organizationId: '0a000000-0000-4000-8000-000000000002',
  orgKind: 'customer',
  partyId: '0a000000-0000-4000-8000-000000000003',
  idpOrgId: '0a000000-0000-4000-8000-00000000000a',
  roles: [],
  departmentId: null,
  status: 'active',
  grants: new Map([['portal.quotation.read', 'all']]),
  ...over,
});

async function setup(caller: Principal) {
  const store = {
    listVersions: vi.fn().mockResolvedValue([]),
    loadView: vi.fn().mockResolvedValue(undefined),
    loadDocumentHead: vi.fn().mockResolvedValue(undefined),
  };
  const documents = { listForOwner: vi.fn(), issueLinkForOwner: vi.fn() };
  const settings = {
    get: vi.fn((_scope: unknown, key: string) =>
      Promise.resolve(
        key === 'format.date'
          ? 'dd/MM/yyyy'
          : key === 'currency.enabled'
            ? DISPLAY.enabledCurrencies
            : DISPLAY.numberSystems,
      ),
    ),
  };
  const moduleRef = await Test.createTestingModule({
    controllers: [PortalController, PortalDisplayController],
    providers: [
      PortalService,
      { provide: PortalCaller, useValue: { current: () => caller } },
      { provide: PORTAL_QUOTATION_STORE, useValue: store },
      { provide: DocumentsService, useValue: documents },
      { provide: SettingsService, useValue: settings },
    ],
  }).compile();
  return {
    moduleRef,
    store,
    documents,
    settings,
    controller: moduleRef.get(PortalController),
    displayController: moduleRef.get(PortalDisplayController),
  };
}

const DISPLAY = {
  numberSystems: { NPR: 'international', INR: 'south_asian', USD: 'international' },
  dateFormat: 'dd/MM/yyyy',
  enabledCurrencies: ['NPR', 'INR'],
};

const CUSTOMER = principalOf({});
const FOUNDER = principalOf({ orgKind: 'staff', partyId: null, roles: ['founder'] });

describe('PortalController', () => {
  it('marks every route with portal.quotation.read, and the id with a UUID pipe', async () => {
    const { moduleRef } = await setup(CUSTOMER);
    expect(findUnmarkedRoutes(moduleRef)).toEqual([]);
    for (const handler of [
      PortalController.prototype.list,
      PortalController.prototype.get,
      PortalController.prototype.document,
    ]) {
      expect(Reflect.getMetadata(CAN_KEY, handler)).toBe('portal.quotation.read');
    }
    for (const route of ['get', 'document']) {
      const args = Reflect.getMetadata(ROUTE_ARGS_METADATA, PortalController, route) as Record<
        string,
        { data: string; pipes: unknown[] }
      >;
      const id = Object.values(args).find((a) => a.data === 'id');
      expect(id?.pipes, route).toContain(ParseUUIDPipe);
    }
    await moduleRef.close();
  });

  it('answers 403 to a staff founder on every route, without reading anything', async () => {
    const { moduleRef, controller, store, documents, settings } = await setup(FOUNDER);
    await expect(controller.list()).rejects.toBeInstanceOf(ForbiddenException);
    await expect(controller.get(ID)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(controller.document(ID)).rejects.toBeInstanceOf(ForbiddenException);
    expect(store.listVersions).not.toHaveBeenCalled();
    expect(store.loadView).not.toHaveBeenCalled();
    expect(store.loadDocumentHead).not.toHaveBeenCalled();
    expect(documents.listForOwner).not.toHaveBeenCalled();
    expect(documents.issueLinkForOwner).not.toHaveBeenCalled();
    expect(settings.get).not.toHaveBeenCalled();
    await moduleRef.close();
  });

  it('answers 403 to a customer principal with no party', async () => {
    const { moduleRef, controller, store } = await setup(principalOf({ partyId: null }));
    await expect(controller.list()).rejects.toBeInstanceOf(ForbiddenException);
    expect(store.listVersions).not.toHaveBeenCalled();
    await moduleRef.close();
  });

  it('serves a customer: the list, and the store is asked for exactly the caller', async () => {
    const { moduleRef, controller, store } = await setup(CUSTOMER);
    await expect(controller.list()).resolves.toEqual([]);
    expect(store.listVersions).toHaveBeenCalledWith(CUSTOMER);
    await expect(controller.get(ID)).rejects.toMatchObject({ status: 404 });
    expect(store.loadView).toHaveBeenCalledWith(CUSTOMER, ID);
    await expect(controller.document(ID)).rejects.toMatchObject({ status: 404 });
    expect(store.loadDocumentHead).toHaveBeenCalledWith(CUSTOMER, ID);
    await moduleRef.close();
  });

  it('serves GET /v1/portal/display to any signed-in, active principal at route level, never publicly', async () => {
    const { moduleRef } = await setup(CUSTOMER);
    expect(Reflect.getMetadata(PATH_METADATA, PortalDisplayController)).toBe('v1/portal');
    const handler = PortalDisplayController.prototype.display;
    expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe('display');
    expect(Reflect.getMetadata(ANY_AUTHENTICATED_KEY, handler)).toBe(true);
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, handler)).toBeUndefined();
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, PortalDisplayController)).toBeUndefined();
    await moduleRef.close();
  });

  it('answers a customer 200 with { numberSystems, dateFormat }', async () => {
    const { moduleRef, displayController } = await setup(CUSTOMER);
    await expect(displayController.display()).resolves.toEqual(DISPLAY);
    await moduleRef.close();
  });

  it('answers a vendor portal caller too', async () => {
    const vendor = principalOf({
      orgKind: 'vendor',
      partyId: '0a000000-0000-4000-8000-00000000000b',
      grants: new Map([['portal.vendor.read', 'customer_org']]),
    });
    const { moduleRef, displayController } = await setup(vendor);
    await expect(displayController.display()).resolves.toEqual(DISPLAY);
    await moduleRef.close();
  });

  it('answers 403 to a staff founder on the display, as on the quotation reads, without reading settings', async () => {
    for (const caller of [FOUNDER, principalOf({ partyId: null })]) {
      const { moduleRef, displayController, settings } = await setup(caller);
      await expect(displayController.display()).rejects.toBeInstanceOf(ForbiddenException);
      expect(settings.get).not.toHaveBeenCalled();
      await moduleRef.close();
    }
  });
});
