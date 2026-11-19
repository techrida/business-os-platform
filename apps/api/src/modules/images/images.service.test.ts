// Unit test of ImagesService (U12, D33): staff only, a 404 for an unknown owner type or malformed owner id, the
// owner's upload check before anything else, the strict body, and the pointer write in one transaction (the new
// document must be a live, not refused image of exactly that owner; the previous image is soft-removed and its
// unclean files cleaned after the commit; `image.set` / `image.removed` is audited). Fakes: the database (an
// in-memory pointer store and a transaction that only answers withTx), DocumentsService, SettingsService, audit.
// Run: apps/api/node_modules/.bin/vitest run src/modules/images/images.service.test.ts (from apps/api)
import 'reflect-metadata';

import { randomUUID } from 'node:crypto';

import { EMPTY_COMPANY_PROFILE, type CompanyProfile } from '@bos/contracts';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  NotFoundException,
} from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AuditService } from '../../platform/audit/audit.service';
import type { Principal } from '../../platform/authz/principal';
import type { Db } from '../../platform/db/db.module';
import type { DocumentsService } from '../../platform/documents/documents.service';
import type { SettingsService } from '../../platform/settings/settings.service';
import {
  ImagesService,
  type ImageCaller,
  type ImageDocumentRow,
  type ImagePointerStore,
  type RowImageOwnerType,
} from './images.service';

const TENANT = randomUUID();
const ORG = randomUUID();
const OTHER_ORG = randomUUID();
const USER = randomUUID();
const scope = { tenantId: TENANT, organizationId: ORG };

const principal = (orgKind: Principal['orgKind'] = 'staff'): Principal => ({
  userId: USER,
  zitadelUserId: `z-${USER}`,
  tenantId: TENANT,
  organizationId: ORG,
  orgKind,
  partyId: orgKind === 'staff' ? null : randomUUID(),
  idpOrgId: randomUUID(),
  roles: [],
  departmentId: null,
  status: 'active',
  grants: new Map(),
});
const staff: ImageCaller = {
  scope,
  actor: { kind: 'user', id: USER, correlationId: 'test-corr' },
  principal: principal(),
};
const portal: ImageCaller = { ...staff, principal: principal('customer') };

// ------------------------------------------------------------------------------------------- fakes

const tx = { execute: vi.fn().mockResolvedValue({ rows: [] }) };
const db = { transaction: (fn: (t: unknown) => Promise<unknown>) => fn(tx) } as unknown as Db;

let docs: Map<string, ImageDocumentRow>;
let pointers: Map<string, string | null>;
const key = (ownerType: string, ownerId: string) => `${ownerType}:${ownerId}`;
const store: ImagePointerStore = {
  findDocument: (_tx, s, id) => Promise.resolve(s.tenantId === TENANT ? docs.get(id) : undefined),
  readPointer: (_tx, _s, ownerType, ownerId) => {
    const k = key(ownerType, ownerId);
    return Promise.resolve(pointers.has(k) ? { documentId: pointers.get(k) ?? null } : undefined);
  },
  writePointer: (_tx, _s, ownerType, ownerId, documentId) => {
    pointers.set(key(ownerType, ownerId), documentId);
    return Promise.resolve();
  },
};

const documents = {
  openImage: vi.fn(),
  assertCanManage: vi.fn(),
  removeInTransaction: vi.fn(),
  cleanupRemoved: vi.fn(),
};
let profile: { value: CompanyProfile; version: number | null };
const settings = { getLocked: vi.fn(), set: vi.fn() };
const audit = { record: vi.fn() };

const service = new ImagesService(
  db,
  documents as unknown as DocumentsService,
  settings as unknown as SettingsService,
  audit as unknown as AuditService,
  store,
);

/** A live image document of `ownerType`/`ownerId` in this entity, newest version `status`. */
function addDoc(ownerType: string, ownerId: string, over: Partial<ImageDocumentRow> = {}): string {
  const id = randomUUID();
  docs.set(id, { id, ownerType, ownerId, organizationId: ORG, status: 'clean', ...over });
  return id;
}

const statusOf = (call: Promise<unknown>): Promise<number | string> =>
  call.then(
    () => 'resolved',
    (e: unknown) => (e instanceof HttpException ? e.getStatus() : String(e)),
  );

beforeEach(() => {
  docs = new Map();
  pointers = new Map();
  profile = {
    value: { ...EMPTY_COMPANY_PROFILE, displayName: 'Acme Pvt Ltd', email: 'hi@acme.test' },
    version: 3,
  };
  documents.openImage.mockReset();
  documents.assertCanManage.mockReset().mockResolvedValue(undefined);
  documents.removeInTransaction.mockReset().mockResolvedValue([]);
  documents.cleanupRemoved.mockReset().mockResolvedValue(undefined);
  settings.getLocked.mockReset().mockImplementation(() => Promise.resolve(profile));
  settings.set.mockReset().mockResolvedValue({ version: 4 });
  audit.record.mockReset().mockResolvedValue(undefined);
});

// ------------------------------------------------------------------------------------------- open

describe('open', () => {
  it('hands the scope, id and If-None-Match to openImage for a staff caller', async () => {
    const handle = { notModified: true, etag: 'v1' };
    documents.openImage.mockResolvedValue(handle);
    const id = randomUUID();
    await expect(service.open(staff, id, '"v1"')).resolves.toBe(handle);
    expect(documents.openImage).toHaveBeenCalledWith(scope, id, '"v1"');
  });

  it('is 403 for a portal caller and for no principal, without reading anything', async () => {
    expect(await statusOf(service.open(portal, randomUUID()))).toBe(403);
    expect(await statusOf(service.open({ ...staff, principal: undefined }, randomUUID()))).toBe(
      403,
    );
    expect(documents.openImage).not.toHaveBeenCalled();
  });
});

// ------------------------------------------------------------------------------------------- set

const ROW_OWNERS: RowImageOwnerType[] = ['user_avatar', 'customer_logo', 'vendor_logo'];

describe('set: row owners', () => {
  for (const ownerType of ROW_OWNERS) {
    it(`${ownerType}: moves the pointer, removes the previous image and audits image.set`, async () => {
      const ownerId = randomUUID();
      const old = addDoc(ownerType, ownerId);
      const next = addDoc(ownerType, ownerId, { status: 'quarantined' });
      pointers.set(key(ownerType, ownerId), old);
      const unclean = [{ id: randomUUID() }];
      documents.removeInTransaction.mockResolvedValue(unclean);

      await expect(service.set(staff, ownerType, ownerId, { documentId: next })).resolves.toEqual({
        documentId: next,
      });

      expect(documents.assertCanManage).toHaveBeenCalledWith(scope, ownerType, ownerId);
      expect(pointers.get(key(ownerType, ownerId))).toBe(next);
      expect(documents.removeInTransaction).toHaveBeenCalledWith(tx, scope, old);
      expect(audit.record).toHaveBeenCalledWith(tx, {
        action: 'image.set',
        entityType: ownerType,
        entityId: ownerId,
        meta: { oldDocumentId: old, newDocumentId: next },
      });
      expect(documents.cleanupRemoved).toHaveBeenCalledWith(unclean);
      expect(settings.set).not.toHaveBeenCalled();
    });
  }

  it('sets a first image without removing anything', async () => {
    const ownerId = randomUUID();
    pointers.set(key('customer_logo', ownerId), null);
    const next = addDoc('customer_logo', ownerId);
    await service.set(staff, 'customer_logo', ownerId, { documentId: next });
    expect(pointers.get(key('customer_logo', ownerId))).toBe(next);
    expect(documents.removeInTransaction).not.toHaveBeenCalled();
    expect(audit.record.mock.calls[0]?.[1]).toMatchObject({
      meta: { oldDocumentId: null, newDocumentId: next },
    });
  });

  it('null clears the pointer, removes the old image and audits image.removed', async () => {
    const ownerId = randomUUID();
    const old = addDoc('vendor_logo', ownerId);
    pointers.set(key('vendor_logo', ownerId), old);
    await expect(service.set(staff, 'vendor_logo', ownerId, { documentId: null })).resolves.toEqual(
      { documentId: null },
    );
    expect(pointers.get(key('vendor_logo', ownerId))).toBeNull();
    expect(documents.removeInTransaction).toHaveBeenCalledWith(tx, scope, old);
    expect(audit.record.mock.calls[0]?.[1]).toMatchObject({
      action: 'image.removed',
      meta: { oldDocumentId: old, newDocumentId: null },
    });
  });

  it('setting the current image again changes, removes and audits nothing', async () => {
    const ownerId = randomUUID();
    const current = addDoc('user_avatar', ownerId);
    pointers.set(key('user_avatar', ownerId), current);
    await expect(
      service.set(staff, 'user_avatar', ownerId, { documentId: current }),
    ).resolves.toEqual({ documentId: current });
    expect(documents.removeInTransaction).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
    expect(docs.has(current)).toBe(true);
  });

  it('tolerates a previous image that is already removed', async () => {
    const ownerId = randomUUID();
    const old = addDoc('customer_logo', ownerId);
    const next = addDoc('customer_logo', ownerId);
    pointers.set(key('customer_logo', ownerId), old);
    documents.removeInTransaction.mockRejectedValue(new NotFoundException('Document not found'));
    await service.set(staff, 'customer_logo', ownerId, { documentId: next });
    expect(pointers.get(key('customer_logo', ownerId))).toBe(next);
    expect(documents.cleanupRemoved).toHaveBeenCalledWith([]);
  });

  it('skips removing a previous image that is gone or belongs to someone else, and still moves the pointer', async () => {
    const ownerId = randomUUID();
    const foreign = addDoc('customer_logo', randomUUID());
    const next = addDoc('customer_logo', ownerId);
    pointers.set(key('customer_logo', ownerId), foreign);
    await service.set(staff, 'customer_logo', ownerId, { documentId: next });
    expect(documents.removeInTransaction).not.toHaveBeenCalled();
    expect(pointers.get(key('customer_logo', ownerId))).toBe(next);
  });

  it('takes a profile picture uploaded while acting for another entity of the tenant', async () => {
    const ownerId = randomUUID();
    pointers.set(key('user_avatar', ownerId), null);
    const next = addDoc('user_avatar', ownerId, { organizationId: OTHER_ORG });
    await service.set(staff, 'user_avatar', ownerId, { documentId: next });
    expect(pointers.get(key('user_avatar', ownerId))).toBe(next);
  });

  it('propagates a rethrown non-404 error from removing the previous image', async () => {
    const ownerId = randomUUID();
    const old = addDoc('vendor_logo', ownerId);
    pointers.set(key('vendor_logo', ownerId), old);
    documents.removeInTransaction.mockRejectedValue(new ConflictException('no attachments'));
    expect(await statusOf(service.set(staff, 'vendor_logo', ownerId, { documentId: null }))).toBe(
      409,
    );
    expect(documents.cleanupRemoved).not.toHaveBeenCalled();
  });
});

describe('set: entity_logo', () => {
  it('writes entity.profile keeping every other field, clearing the legacy logo, and removes the old image', async () => {
    const old = addDoc('entity_logo', ORG);
    const next = addDoc('entity_logo', ORG);
    profile.value = {
      ...profile.value,
      logoDocumentId: old,
      legacyLogoDataUrl: 'data:image/png;base64,AAAA',
    };
    await expect(service.set(staff, 'entity_logo', ORG, { documentId: next })).resolves.toEqual({
      documentId: next,
    });
    expect(settings.getLocked).toHaveBeenCalledWith(tx, 'entity.profile');
    expect(settings.set).toHaveBeenCalledWith(tx, 'entity.profile', {
      ...EMPTY_COMPANY_PROFILE,
      displayName: 'Acme Pvt Ltd',
      email: 'hi@acme.test',
      logoDocumentId: next,
      legacyLogoDataUrl: null,
    });
    expect(documents.removeInTransaction).toHaveBeenCalledWith(tx, scope, old);
    expect(audit.record.mock.calls[0]?.[1]).toMatchObject({
      action: 'image.set',
      entityType: 'entity_logo',
      entityId: ORG,
    });
  });

  it('null with only a legacy logo still writes the setting, so the legacy logo is gone', async () => {
    profile.value = { ...profile.value, legacyLogoDataUrl: 'data:image/png;base64,AAAA' };
    await service.set(staff, 'entity_logo', ORG, { documentId: null });
    expect(settings.set).toHaveBeenCalledTimes(1);
    expect(settings.set.mock.calls[0]?.[2]).toMatchObject({
      logoDocumentId: null,
      legacyLogoDataUrl: null,
    });
    expect(audit.record.mock.calls[0]?.[1]).toMatchObject({ action: 'image.removed' });
  });

  it('null with nothing set writes nothing', async () => {
    await service.set(staff, 'entity_logo', ORG, { documentId: null });
    expect(settings.set).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });
});

describe('set: refusals', () => {
  it('is 404 for a document of another owner of the same type, writing nothing', async () => {
    const ownerId = randomUUID();
    pointers.set(key('customer_logo', ownerId), null);
    const otherCustomers = addDoc('customer_logo', randomUUID());
    expect(
      await statusOf(service.set(staff, 'customer_logo', ownerId, { documentId: otherCustomers })),
    ).toBe(404);
    expect(pointers.get(key('customer_logo', ownerId))).toBeNull();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('is 404 for a document of another owner type, an unknown or removed one, and another entity', async () => {
    const ownerId = randomUUID();
    pointers.set(key('vendor_logo', ownerId), null);
    const attachment = addDoc('vendor_bank_evidence', ownerId);
    const otherEntity = addDoc('vendor_logo', ownerId, { organizationId: OTHER_ORG });
    for (const documentId of [attachment, otherEntity, randomUUID()]) {
      expect(await statusOf(service.set(staff, 'vendor_logo', ownerId, { documentId }))).toBe(404);
    }
    expect(pointers.get(key('vendor_logo', ownerId))).toBeNull();
  });

  it('is 404 for another tenant scope (the store sees no document)', async () => {
    const ownerId = randomUUID();
    const doc = addDoc('vendor_logo', ownerId);
    const elsewhere: ImageCaller = {
      ...staff,
      scope: { tenantId: randomUUID(), organizationId: ORG },
    };
    expect(
      await statusOf(service.set(elsewhere, 'vendor_logo', ownerId, { documentId: doc })),
    ).toBe(404);
  });

  it('is 409 for a rejected or infected image, and a version-less document', async () => {
    const ownerId = randomUUID();
    pointers.set(key('user_avatar', ownerId), null);
    for (const status of ['rejected', 'infected', null]) {
      const doc = addDoc('user_avatar', ownerId, { status });
      expect(await statusOf(service.set(staff, 'user_avatar', ownerId, { documentId: doc }))).toBe(
        409,
      );
    }
    expect(pointers.get(key('user_avatar', ownerId))).toBeNull();
  });

  it('is 404 when the owner row is gone by the time the transaction reads it', async () => {
    expect(
      await statusOf(service.set(staff, 'customer_logo', randomUUID(), { documentId: null })),
    ).toBe(404);
  });

  it('is 403 when the caller lacks the owner type upload grant, before the body or the database', async () => {
    documents.assertCanManage.mockRejectedValue(
      new ForbiddenException({ code: 'forbidden', reason: 'no_permission' }),
    );
    expect(
      await statusOf(service.set(staff, 'vendor_logo', randomUUID(), { nonsense: true })),
    ).toBe(403);
    expect(audit.record).not.toHaveBeenCalled();
    expect(settings.getLocked).not.toHaveBeenCalled();
  });

  it('is 403 for a portal caller, before the owner check', async () => {
    expect(
      await statusOf(service.set(portal, 'customer_logo', randomUUID(), { documentId: null })),
    ).toBe(403);
    expect(documents.assertCanManage).not.toHaveBeenCalled();
  });

  it('is 404 for an unknown owner type or a malformed owner id, without the owner check', async () => {
    for (const [ownerType, ownerId] of [
      ['payment_intake', randomUUID()],
      ['ENTITY_LOGO', ORG],
      ['customer_logo', 'not-a-uuid'],
      ['user_avatar', ''],
    ] as const) {
      expect(await statusOf(service.set(staff, ownerType, ownerId, { documentId: null }))).toBe(
        404,
      );
    }
    expect(documents.assertCanManage).not.toHaveBeenCalled();
  });

  it('is 400 for any body other than exactly {documentId: uuid | null}', async () => {
    const ownerId = randomUUID();
    for (const body of [
      {},
      { documentId: 'not-a-uuid' },
      { documentId: randomUUID(), extra: 1 },
      { documentId: undefined },
      null,
      'x',
    ]) {
      const result = service.set(staff, 'customer_logo', ownerId, body);
      await expect(result).rejects.toBeInstanceOf(BadRequestException);
    }
    expect(audit.record).not.toHaveBeenCalled();
  });
});
