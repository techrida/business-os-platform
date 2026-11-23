// Unit test of ImagesService (U12, D33): staff only, a 404 for an unknown owner type or malformed owner id, the
// owner's upload check before anything else, the strict body, and the pointer write in one transaction (the new
// document must be a live, not refused image of exactly that owner; the previous image is soft-removed and its
// unclean files cleaned after the commit; `image.set` / `image.removed` is audited). Fakes: the database (an
// in-memory pointer store and a transaction that only answers withTx), DocumentsService, SettingsService, audit.
// Run: apps/api/node_modules/.bin/vitest run src/modules/images/images.service.test.ts (from apps/api)
import 'reflect-metadata';

import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { finished } from 'node:stream/promises';

import { EMPTY_COMPANY_PROFILE, IMAGE_MAX_BYTES, type CompanyProfile } from '@bos/contracts';
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
  type ImageUploadRequest,
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
  createAndReceiveUpload: vi.fn(),
  removeManagedImage: vi.fn(),
  remove: vi.fn(),
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
  documents.createAndReceiveUpload
    .mockReset()
    .mockImplementation((owner: { ownerType: string; ownerId: string }) =>
      Promise.resolve({
        documentId: addDoc(owner.ownerType, owner.ownerId, { status: 'quarantined' }),
        versionId: randomUUID(),
      }),
    );
  documents.removeManagedImage.mockReset().mockResolvedValue(undefined);
  documents.remove.mockReset().mockResolvedValue(undefined);
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

  it.each(ROW_OWNERS)(
    '%s: takes an image uploaded while acting for another entity of the tenant',
    async (ownerType) => {
      const ownerId = randomUUID();
      pointers.set(key(ownerType, ownerId), null);
      const next = addDoc(ownerType, ownerId, { organizationId: OTHER_ORG });
      await service.set(staff, ownerType, ownerId, { documentId: next });
      expect(pointers.get(key(ownerType, ownerId))).toBe(next);
    },
  );

  it.each(ROW_OWNERS)(
    '%s: removes the previous image even when another entity of the tenant uploaded it',
    async (ownerType) => {
      const ownerId = randomUUID();
      const old = addDoc(ownerType, ownerId, { organizationId: OTHER_ORG });
      const next = addDoc(ownerType, ownerId);
      pointers.set(key(ownerType, ownerId), old);
      await service.set(staff, ownerType, ownerId, { documentId: next });
      expect(documents.removeInTransaction).toHaveBeenCalledWith(tx, scope, old);
      expect(pointers.get(key(ownerType, ownerId))).toBe(next);
    },
  );

  it('removes the previous logo of a customer when a user of another entity clears it', async () => {
    const ownerId = randomUUID();
    const old = addDoc('customer_logo', ownerId, { organizationId: OTHER_ORG });
    pointers.set(key('customer_logo', ownerId), old);
    await service.set(staff, 'customer_logo', ownerId, { documentId: null });
    expect(documents.removeInTransaction).toHaveBeenCalledWith(tx, scope, old);
    expect(pointers.get(key('customer_logo', ownerId))).toBeNull();
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

  it('leaves a previous company logo of another entity in place and still moves the pointer', async () => {
    const old = addDoc('entity_logo', ORG, { organizationId: OTHER_ORG });
    const next = addDoc('entity_logo', ORG);
    profile.value = { ...profile.value, logoDocumentId: old };
    await service.set(staff, 'entity_logo', ORG, { documentId: next });
    expect(documents.removeInTransaction).not.toHaveBeenCalled();
    expect(settings.set.mock.calls[0]?.[2]).toMatchObject({ logoDocumentId: next });
  });

  it('null with nothing set writes nothing', async () => {
    await service.set(staff, 'entity_logo', ORG, { documentId: null });
    expect(settings.set).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });
});

describe('set: the logo for dark and for light backgrounds', () => {
  it.each([
    ['entity_logo_on_dark', 'logoOnDarkDocumentId'],
    ['entity_logo_on_light', 'logoOnLightDocumentId'],
  ] as const)(
    '%s moves only %s, keeping the main logo and the other slot, and removes its own old image',
    async (ownerType, field) => {
      const main = addDoc('entity_logo', ORG);
      const other = addDoc('entity_logo_on_light', ORG);
      const old = addDoc(ownerType, ORG);
      const next = addDoc(ownerType, ORG);
      profile.value = {
        ...profile.value,
        logoDocumentId: main,
        logoOnLightDocumentId: other,
        [field]: old,
        legacyLogoDataUrl: 'data:image/png;base64,AAAA',
      };
      await service.set(staff, ownerType, ORG, { documentId: next });
      const written = settings.set.mock.calls[0]?.[2] as Record<string, unknown>;
      expect(written[field]).toBe(next);
      expect(written['logoDocumentId']).toBe(main);
      if (ownerType === 'entity_logo_on_dark') expect(written['logoOnLightDocumentId']).toBe(other);
      // The pre-documents logo belongs to the main slot: a variant upload leaves it.
      expect(written['legacyLogoDataUrl']).toBe('data:image/png;base64,AAAA');
      expect(documents.removeInTransaction).toHaveBeenCalledWith(tx, scope, old);
      expect(audit.record.mock.calls[0]?.[1]).toMatchObject({
        action: 'image.set',
        entityType: ownerType,
      });
    },
  );

  it('refuses a document of another slot as the new variant image (404)', async () => {
    const mainDoc = addDoc('entity_logo', ORG);
    await expect(
      statusOf(service.set(staff, 'entity_logo_on_dark', ORG, { documentId: mainDoc })),
    ).resolves.toBe(404);
    expect(settings.set).not.toHaveBeenCalled();
  });

  it('removing the main logo leaves the variants stored (nothing prints without a main logo)', async () => {
    const main = addDoc('entity_logo', ORG);
    const dark = addDoc('entity_logo_on_dark', ORG);
    profile.value = { ...profile.value, logoDocumentId: main, logoOnDarkDocumentId: dark };
    await service.set(staff, 'entity_logo', ORG, { documentId: null });
    expect(settings.set.mock.calls[0]?.[2]).toMatchObject({
      logoDocumentId: null,
      logoOnDarkDocumentId: dark,
    });
  });
});

describe('set: lock order (owner, then the new document, then the previous one)', () => {
  // A concurrent replacement holds the owner lock and then locks its previous document, which may be this request's
  // new one: taking a document lock before the owner lock would deadlock against it.
  const order = (fn: { mock: { invocationCallOrder: number[] } }, call = 0) =>
    fn.mock.invocationCallOrder[call] ?? Number.NaN;

  it.each(ROW_OWNERS)(
    '%s: reads the pointer (owner lock) before locking either document',
    async (ownerType) => {
      const ownerId = randomUUID();
      const old = addDoc(ownerType, ownerId);
      const next = addDoc(ownerType, ownerId);
      pointers.set(key(ownerType, ownerId), old);
      const readPointer = vi.spyOn(store, 'readPointer');
      const findDocument = vi.spyOn(store, 'findDocument');
      try {
        await service.set(staff, ownerType, ownerId, { documentId: next });
        expect(findDocument.mock.calls.map((c) => c[2])).toEqual([next, old]);
        expect(order(readPointer)).toBeLessThan(order(findDocument, 0));
        expect(order(findDocument, 0)).toBeLessThan(order(findDocument, 1));
        expect(order(findDocument, 1)).toBeLessThan(order(documents.removeInTransaction));
      } finally {
        readPointer.mockRestore();
        findDocument.mockRestore();
      }
    },
  );

  it('entity_logo: takes the profile setting lock before locking either document', async () => {
    const old = addDoc('entity_logo', ORG);
    const next = addDoc('entity_logo', ORG);
    profile.value = { ...profile.value, logoDocumentId: old };
    const findDocument = vi.spyOn(store, 'findDocument');
    try {
      await service.set(staff, 'entity_logo', ORG, { documentId: next });
      expect(findDocument.mock.calls.map((c) => c[2])).toEqual([next, old]);
      expect(order(settings.getLocked)).toBeLessThan(order(findDocument, 0));
    } finally {
      findDocument.mockRestore();
    }
  });

  it('takes the owner lock first even when the new document is then refused', async () => {
    const ownerId = randomUUID();
    pointers.set(key('vendor_logo', ownerId), null);
    const doc = addDoc('vendor_logo', ownerId, { status: 'infected' });
    const readPointer = vi.spyOn(store, 'readPointer');
    const findDocument = vi.spyOn(store, 'findDocument');
    try {
      expect(await statusOf(service.set(staff, 'vendor_logo', ownerId, { documentId: doc }))).toBe(
        409,
      );
      expect(order(readPointer)).toBeLessThan(order(findDocument, 0));
    } finally {
      readPointer.mockRestore();
      findDocument.mockRestore();
    }
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

  it('is 404 for a document of another owner type, an unknown or removed one', async () => {
    const ownerId = randomUUID();
    pointers.set(key('vendor_logo', ownerId), null);
    const attachment = addDoc('vendor_bank_evidence', ownerId);
    for (const documentId of [attachment, randomUUID()]) {
      expect(await statusOf(service.set(staff, 'vendor_logo', ownerId, { documentId }))).toBe(404);
    }
    expect(pointers.get(key('vendor_logo', ownerId))).toBeNull();
  });

  it('is 404 for a company logo uploaded in another entity: the entity logo stays its own', async () => {
    const otherEntity = addDoc('entity_logo', ORG, { organizationId: OTHER_ORG });
    expect(
      await statusOf(service.set(staff, 'entity_logo', ORG, { documentId: otherEntity })),
    ).toBe(404);
    expect(settings.set).not.toHaveBeenCalled();
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

  it.each(['awaiting_content', 'scan_failed'])(
    'is 409 for a document whose newest version is %s, keeping and removing nothing',
    async (status) => {
      // A generic create left without bytes is never scanned: it must never replace the current picture.
      const ownerId = randomUUID();
      const old = addDoc('customer_logo', ownerId);
      pointers.set(key('customer_logo', ownerId), old);
      const doc = addDoc('customer_logo', ownerId, { status });
      const error: unknown = await service
        .set(staff, 'customer_logo', ownerId, { documentId: doc })
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ConflictException);
      expect((error as ConflictException).getResponse()).toEqual({
        code: 'conflict',
        message:
          'This image is not ready: its upload or virus scan did not finish. Upload it again.',
      });
      expect(pointers.get(key('customer_logo', ownerId))).toBe(old);
      expect(documents.removeInTransaction).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    },
  );

  it('is 409 for an awaiting_content entity logo too, leaving entity.profile alone', async () => {
    const doc = addDoc('entity_logo', ORG, { status: 'awaiting_content' });
    expect(await statusOf(service.set(staff, 'entity_logo', ORG, { documentId: doc }))).toBe(409);
    expect(settings.set).not.toHaveBeenCalled();
  });

  it('takes a quarantined (received, scan pending) or clean image', async () => {
    for (const status of ['quarantined', 'clean']) {
      const ownerId = randomUUID();
      pointers.set(key('vendor_logo', ownerId), null);
      const doc = addDoc('vendor_logo', ownerId, { status });
      await service.set(staff, 'vendor_logo', ownerId, { documentId: doc });
      expect(pointers.get(key('vendor_logo', ownerId))).toBe(doc);
    }
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

// ------------------------------------------------------------------------------------------- upload

const PNG_BYTES = Buffer.from('89504e470d0a1a0a', 'hex');

/** A request whose body is `chunks`; the headers default to a valid PNG upload. */
function request(
  over: Partial<Omit<ImageUploadRequest, 'stream'>> = {},
  chunks: Buffer[] = [PNG_BYTES],
): ImageUploadRequest & { stream: Readable } {
  return {
    contentType: 'image/png',
    contentLength: undefined,
    fileNameHeader: 'logo.png',
    ...over,
    stream: Readable.from(chunks),
  };
}

/** The body was never touched: no reader attached, never started flowing. */
function untouched(stream: Readable): void {
  expect(stream.listenerCount('data')).toBe(0);
  expect(stream.readableFlowing).toBeNull();
}

describe('upload', () => {
  it('stores the bytes through the scanned upload, moves the pointer and returns the new id', async () => {
    const ownerId = randomUUID();
    pointers.set(key('customer_logo', ownerId), null);
    const req = request(
      { contentType: 'IMAGE/PNG; charset=binary', fileNameHeader: 'my%20logo.png' },
      [PNG_BYTES.subarray(0, 3), PNG_BYTES.subarray(3)],
    );

    const result = await service.upload('customer_logo', ownerId, req, staff);

    expect(documents.assertCanManage).toHaveBeenCalledWith(scope, 'customer_logo', ownerId);
    expect(documents.createAndReceiveUpload).toHaveBeenCalledWith(
      { ownerType: 'customer_logo', ownerId },
      { filename: 'my logo.png', declaredMime: 'image/png', bytes: PNG_BYTES },
      { scope, actor: staff.actor },
    );
    expect(pointers.get(key('customer_logo', ownerId))).toBe(result.documentId);
    expect(audit.record.mock.calls[0]?.[1]).toMatchObject({
      action: 'image.set',
      meta: { oldDocumentId: null, newDocumentId: result.documentId },
    });
    expect(documents.removeManagedImage).not.toHaveBeenCalled();
  });

  it('takes a chunked body without Content-Length up to exactly the cap', async () => {
    const ownerId = randomUUID();
    pointers.set(key('vendor_logo', ownerId), null);
    const half = IMAGE_MAX_BYTES / 2;
    const req = request({}, [Buffer.alloc(half, 1), Buffer.alloc(half, 2)]);
    await service.upload('vendor_logo', ownerId, req, staff);
    const file = documents.createAndReceiveUpload.mock.calls[0]?.[1] as { bytes: Buffer };
    expect(file.bytes.length).toBe(IMAGE_MAX_BYTES);
  });

  it('is 413 from a Content-Length over the cap, before the body is read', async () => {
    const req = request({ contentLength: String(IMAGE_MAX_BYTES + 1) });
    expect(await statusOf(service.upload('customer_logo', randomUUID(), req, staff))).toBe(413);
    untouched(req.stream);
    expect(documents.createAndReceiveUpload).not.toHaveBeenCalled();
  });

  it('is 413 while counting a body over the cap, without destroying the stream (the 413 must still be sent)', async () => {
    for (const contentLength of [undefined, '10']) {
      documents.createAndReceiveUpload.mockClear();
      const chunk = Buffer.alloc(200_000, 7);
      const req = request({ contentLength }, [chunk, chunk, chunk, chunk]);
      expect(await statusOf(service.upload('customer_logo', randomUUID(), req, staff))).toBe(413);
      expect(req.stream.listenerCount('data')).toBe(0);
      // The rest is drained to its natural end: a destroy would reject with ERR_STREAM_PREMATURE_CLOSE.
      await expect(finished(req.stream)).resolves.toBeUndefined();
      expect(documents.createAndReceiveUpload).not.toHaveBeenCalled();
    }
  });

  it('is 415 for a Content-Type that is not PNG, JPEG or WebP, before the body is read', async () => {
    for (const contentType of [
      'image/svg+xml',
      'application/pdf',
      'text/plain',
      'image/gif',
      '',
      undefined,
    ]) {
      const req = request({ contentType });
      expect(await statusOf(service.upload('customer_logo', randomUUID(), req, staff))).toBe(415);
      untouched(req.stream);
    }
    expect(documents.createAndReceiveUpload).not.toHaveBeenCalled();
  });

  it('is 400 for a missing, undecodable or unsafe x-file-name, before the body is read', async () => {
    for (const fileNameHeader of [
      undefined,
      '',
      '%E0%A4%A',
      'a%2Fb.png',
      '..%5Cx.png',
      '%00a.png',
      'x%0Ay.png',
      'x'.repeat(256),
    ]) {
      const req = request({ fileNameHeader });
      expect(await statusOf(service.upload('customer_logo', randomUUID(), req, staff))).toBe(400);
      untouched(req.stream);
    }
    expect(documents.createAndReceiveUpload).not.toHaveBeenCalled();
  });

  it('is 400 for a malformed Content-Length and for an empty body', async () => {
    const bad = request({ contentLength: '12abc' });
    expect(await statusOf(service.upload('customer_logo', randomUUID(), bad, staff))).toBe(400);
    untouched(bad.stream);
    const empty = request({}, []);
    expect(await statusOf(service.upload('customer_logo', randomUUID(), empty, staff))).toBe(400);
    expect(documents.createAndReceiveUpload).not.toHaveBeenCalled();
  });

  it('is 400 for a body that was already consumed', async () => {
    const req = request();
    req.stream.resume();
    await finished(req.stream);
    expect(await statusOf(service.upload('customer_logo', randomUUID(), req, staff))).toBe(400);
    expect(documents.createAndReceiveUpload).not.toHaveBeenCalled();
  });

  it('is 400, not a hung request, when the client goes away mid-body (closed or errored)', async () => {
    for (const cause of [undefined, new Error('reset')]) {
      const stream = new Readable({ read: () => undefined });
      stream.push(PNG_BYTES);
      const req = { ...request(), stream };
      const result = statusOf(service.upload('customer_logo', randomUUID(), req, staff));
      setImmediate(() => stream.destroy(cause));
      expect(await result).toBe(400);
    }
    expect(documents.createAndReceiveUpload).not.toHaveBeenCalled();
  });

  it("passes the owner check's 403 and 404 through before the headers or the body are looked at", async () => {
    for (const refusal of [
      new ForbiddenException({ code: 'forbidden', reason: 'no_permission' }),
      new NotFoundException('Owner record not found'),
    ]) {
      documents.assertCanManage.mockRejectedValueOnce(refusal);
      const req = request({
        contentType: 'image/svg+xml',
        fileNameHeader: undefined,
        contentLength: String(IMAGE_MAX_BYTES * 4),
      });
      expect(await statusOf(service.upload('vendor_logo', randomUUID(), req, staff))).toBe(
        refusal.getStatus(),
      );
      untouched(req.stream);
    }
    expect(documents.createAndReceiveUpload).not.toHaveBeenCalled();
  });

  it('is 403 for a portal caller and 404 for an unknown owner type or bad id, before the owner check', async () => {
    const portalReq = request();
    expect(await statusOf(service.upload('customer_logo', randomUUID(), portalReq, portal))).toBe(
      403,
    );
    untouched(portalReq.stream);
    for (const [ownerType, ownerId] of [
      ['payment_intake', randomUUID()],
      ['customer_logo', 'not-a-uuid'],
    ] as const) {
      const req = request();
      expect(await statusOf(service.upload(ownerType, ownerId, req, staff))).toBe(404);
      untouched(req.stream);
    }
    expect(documents.assertCanManage).not.toHaveBeenCalled();
  });

  it('removes the new document and throws the pointer error when the pointer move fails', async () => {
    // No owner row: set's transaction answers 404 after the document was created.
    const ownerId = randomUUID();
    expect(await statusOf(service.upload('customer_logo', ownerId, request(), staff))).toBe(404);
    const created = (await documents.createAndReceiveUpload.mock.results[0]?.value) as {
      documentId: string;
    };
    expect(documents.removeManagedImage).toHaveBeenCalledWith(created.documentId, {
      who: { scope, actor: staff.actor },
    });
    // Not the HTTP path, which refuses a picture with 409 and would leave the new document behind.
    expect(documents.remove).not.toHaveBeenCalled();
  });

  it('still throws the pointer error when removing the new document fails too', async () => {
    documents.removeManagedImage.mockRejectedValue(new Error('database down'));
    expect(await statusOf(service.upload('customer_logo', randomUUID(), request(), staff))).toBe(
      404,
    );
    expect(documents.removeManagedImage).toHaveBeenCalledTimes(1);
  });

  it('throws the upload error unchanged and moves no pointer when storing fails', async () => {
    const ownerId = randomUUID();
    pointers.set(key('customer_logo', ownerId), null);
    documents.createAndReceiveUpload.mockRejectedValue(
      new HttpException('The file content does not match its declared type', 415),
    );
    expect(await statusOf(service.upload('customer_logo', ownerId, request(), staff))).toBe(415);
    expect(pointers.get(key('customer_logo', ownerId))).toBeNull();
    expect(documents.removeManagedImage).not.toHaveBeenCalled();
  });
});
