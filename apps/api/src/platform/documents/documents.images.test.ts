// Images as documents (U12, D33): an owner policy may narrow the upload types and size (logos and avatars: PNG,
// JPEG, WebP up to 512 KiB), `openImage` serves a clean image to any signed-in staff of the tenant and entity (a
// profile picture, customer or vendor logo: of the tenant) with one 404 for every refusal and a storage-free "not
// modified" for a matching If-None-Match, `removeInTransaction` removes such a tenant-wide image in the entity it
// was uploaded in, `remove` (DELETE /v1/documents/:id) refuses a picture with 409 after the permission check while
// `removeManagedImage` (the images module) still removes one, and `createAndReceiveScanned` (the legacy-logo
// migrator) never skips the virus scan.
// Unit level with fakes: the SQL filters are checked by their rendered parameters, not against Postgres.
import 'reflect-metadata';

import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { IMAGE_MAX_BYTES, IMAGE_MIME, type CreateDocumentBody } from '@bos/contracts';
import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
  PayloadTooLargeException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import type { Queue } from 'bullmq';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { afterAll, describe, expect, it, vi } from 'vitest';

import type { Principal } from '../authz/principal';
import type { Db, DbTransaction } from '../db/tx';
import { bindIdentity, bindPrincipal, runWithRequestStore } from '../tenancy/request-context';
import { DocumentsController } from './documents.controller';
import { DOCS_SCAN_JOB, type DocumentOwnerPolicy } from './documents.ports';
import { DocumentsService } from './documents.service';
import type { SignedLinks } from './signed-link';
import { StoredFileNotFoundError, type StorageAdapter } from './storage.adapter';

const TENANT = randomUUID();
const ORG = randomUUID();
const USER = randomUUID();
const OWNER_ID = randomUUID();
const SYSTEM = 'system:legacy-logo';
const scope = { tenantId: TENANT, organizationId: ORG };

/** The bound parameters of a drizzle condition, as Postgres would receive them. */
const paramsOf = (condition: SQL): unknown[] => new PgDialect().sqlToQuery(condition).params;

/** A 1x1 PNG: real bytes, so the real type check (file-type) recognises it. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

const imagePolicy = (over: Partial<DocumentOwnerPolicy> = {}): DocumentOwnerPolicy => ({
  ownerType: 'entity_logo',
  allowedMime: IMAGE_MIME,
  maxBytes: IMAGE_MAX_BYTES,
  resource: (s) => Promise.resolve({ ...s }),
  allowsSystemActor: vi.fn().mockResolvedValue(true),
  ...over,
});

/** A transaction that answers readTxContext and records every insert. */
function fakeTx(actor: { kind: string; id: string } = { kind: 'user', id: USER }) {
  const inserted: Record<string, unknown>[] = [];
  const tx = {
    execute: vi.fn().mockResolvedValue({
      rows: [
        { tenant_id: TENANT, organization_id: ORG, actor_id: actor.id, actor_kind: actor.kind },
      ],
    }),
    insert: vi.fn(() => ({
      values: (values: Record<string, unknown>) => {
        inserted.push(values);
        return Promise.resolve();
      },
    })),
  };
  return { tx: tx as unknown as DbTransaction, inserted };
}

function service(
  policy: DocumentOwnerPolicy,
  deps: { db?: unknown; storage?: unknown; queue?: unknown; authz?: { assert: () => void } } = {},
) {
  const authz = deps.authz ?? { assert: vi.fn() };
  const audit = { record: vi.fn().mockResolvedValue(undefined) };
  const queue = deps.queue ?? { add: vi.fn() };
  const svc = new DocumentsService(
    (deps.db ?? {}) as Db,
    (deps.storage ?? {}) as StorageAdapter,
    {} as SignedLinks,
    queue as Queue,
    authz,
    audit,
  );
  svc.registerOwner(policy);
  return { svc, authz, audit, queue };
}

/** Runs `fn` as an HTTP request of a staff user of the scope, as the tenancy interceptor binds it. */
function asRequest<T>(fn: () => Promise<T>): Promise<T> {
  const p: Principal = {
    userId: USER,
    zitadelUserId: `z-${USER}`,
    tenantId: TENANT,
    organizationId: ORG,
    orgKind: 'staff',
    partyId: null,
    idpOrgId: randomUUID(),
    roles: [],
    departmentId: null,
    status: 'active',
    grants: new Map(),
  };
  return runWithRequestStore('c-images', () => {
    bindIdentity({
      tenantId: p.tenantId,
      organizationId: p.organizationId,
      orgKind: p.orgKind,
      partyId: p.partyId,
      idpOrgId: p.idpOrgId,
      userId: p.zitadelUserId,
      roles: p.roles,
      departmentId: p.departmentId,
      tokenExp: Math.floor(Date.now() / 1000) + 300,
    });
    bindPrincipal(p);
    return fn();
  });
}

const body = (over: Partial<CreateDocumentBody> = {}): CreateDocumentBody => ({
  ownerType: 'entity_logo',
  ownerId: OWNER_ID,
  filename: 'logo.png',
  declaredMime: 'image/png',
  sizeBytes: 2048,
  ...over,
});

describe('DocumentsService.create with an image owner policy', () => {
  it('refuses a PDF with 415 and writes no row', async () => {
    const { svc } = service(imagePolicy());
    const { tx, inserted } = fakeTx();

    await expect(
      svc.create(tx, body({ filename: 'logo.pdf', declaredMime: 'application/pdf' })),
    ).rejects.toBeInstanceOf(UnsupportedMediaTypeException);
    expect(inserted).toHaveLength(0);
  });

  it('refuses one byte over 512 KiB with 413 and writes no row, and takes exactly 512 KiB', async () => {
    const { svc } = service(imagePolicy());
    const over = fakeTx();
    await expect(
      svc.create(over.tx, body({ sizeBytes: IMAGE_MAX_BYTES + 1 })),
    ).rejects.toBeInstanceOf(PayloadTooLargeException);
    expect(over.inserted).toHaveLength(0);

    const exact = fakeTx();
    await svc.create(exact.tx, body({ sizeBytes: IMAGE_MAX_BYTES }));
    expect(exact.inserted).toHaveLength(2);
  });

  it.each(IMAGE_MIME)('takes %s', async (mime) => {
    const { svc } = service(imagePolicy());
    const { tx, inserted } = fakeTx();

    await svc.create(tx, body({ declaredMime: mime }));
    expect(inserted).toHaveLength(2);
  });

  it('checks the permission first: a caller who may not upload gets 403, not the type or size refusal', async () => {
    const authz = {
      assert: vi.fn(() => {
        throw new ForbiddenException({ code: 'forbidden', reason: 'no_permission' });
      }),
    };
    const { svc } = service(imagePolicy(), { authz });
    const { tx, inserted } = fakeTx();

    await expect(
      svc.create(tx, body({ declaredMime: 'application/pdf', sizeBytes: IMAGE_MAX_BYTES * 4 })),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(authz.assert).toHaveBeenCalledTimes(1);
    expect(inserted).toHaveLength(0);
  });

  it('keeps the generic rules for an owner without its own: a 2 MiB PDF is still taken', async () => {
    const { svc } = service({ ownerType: 'test_memo', resource: (s) => Promise.resolve({ ...s }) });
    const { tx, inserted } = fakeTx();

    await svc.create(
      tx,
      body({ ownerType: 'test_memo', declaredMime: 'application/pdf', sizeBytes: 2 * 1024 * 1024 }),
    );
    expect(inserted).toHaveLength(2);
  });

  it('applies the same rules to createGenerated', async () => {
    const { svc } = service(imagePolicy());
    const { tx, inserted } = fakeTx({ kind: 'system', id: SYSTEM });
    const owner = { ownerType: 'entity_logo', ownerId: OWNER_ID };

    await expect(
      svc.createGenerated(tx, owner, {
        filename: 'logo.pdf',
        declaredMime: 'application/pdf',
        bytes: Buffer.from('%PDF-1.4\n%%EOF\n'),
      }),
    ).rejects.toBeInstanceOf(UnsupportedMediaTypeException);
    await expect(
      svc.createGenerated(tx, owner, {
        filename: 'logo.png',
        declaredMime: 'image/png',
        bytes: Buffer.alloc(IMAGE_MAX_BYTES + 1),
      }),
    ).rejects.toBeInstanceOf(PayloadTooLargeException);
    expect(inserted).toHaveLength(0);
  });
});

const PICTURE_TYPES = ['entity_logo', 'user_avatar', 'customer_logo', 'vendor_logo'];
const PICTURES_ELSEWHERE = {
  code: 'conflict',
  message: 'Pictures are uploaded from their own settings.',
};
const denyAll = () => ({
  assert: vi.fn(() => {
    throw new ForbiddenException({ code: 'forbidden', reason: 'no_permission' });
  }),
});

describe('DocumentsService.createFromRequest (POST /v1/documents)', () => {
  it.each(PICTURE_TYPES)(
    'refuses a %s with 409 after the permission check and writes nothing',
    async (ownerType) => {
      const { svc, authz } = service(imagePolicy({ ownerType }));
      const { tx, inserted } = fakeTx();

      const error: unknown = await svc
        .createFromRequest(tx, body({ ownerType }))
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ConflictException);
      expect((error as ConflictException).getResponse()).toEqual(PICTURES_ELSEWHERE);
      expect(authz.assert).toHaveBeenCalledTimes(1);
      expect(inserted).toHaveLength(0);
    },
  );

  it.each(PICTURE_TYPES)(
    'answers 403, not 409, for a %s when the caller may not upload',
    async (ownerType) => {
      const { svc } = service(imagePolicy({ ownerType }), { authz: denyAll() });
      const { tx, inserted } = fakeTx();
      await expect(svc.createFromRequest(tx, body({ ownerType }))).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(inserted).toHaveLength(0);
    },
  );

  it('still creates a document of another owner type', async () => {
    const { svc } = service({ ownerType: 'test_memo', resource: (s) => Promise.resolve({ ...s }) });
    const { tx, inserted } = fakeTx();
    await svc.createFromRequest(
      tx,
      body({ ownerType: 'test_memo', filename: 'memo.pdf', declaredMime: 'application/pdf' }),
    );
    expect(inserted).toHaveLength(2);
  });

  it('`create` (createAndReceiveUpload, the images module) still takes a picture', async () => {
    for (const ownerType of PICTURE_TYPES) {
      const { svc } = service(imagePolicy({ ownerType }));
      const { tx, inserted } = fakeTx();
      await svc.create(tx, body({ ownerType }));
      expect(inserted).toHaveLength(2);
    }
  });

  it('the controller route calls createFromRequest, never the permissive create', async () => {
    const created = { documentId: randomUUID(), versionId: randomUUID(), uploadPath: '/x' };
    const docs = {
      create: vi.fn(),
      createFromRequest: vi.fn().mockResolvedValue(created),
    };
    const { tx } = fakeTx();
    const db = { transaction: (fn: (t: DbTransaction) => Promise<unknown>) => fn(tx) };
    const controller = new DocumentsController(
      docs as unknown as DocumentsService,
      db as unknown as Db,
    );
    const p = body({ ownerType: 'user_avatar' });

    await expect(asRequest(() => controller.create(p))).resolves.toBe(created);
    expect(docs.createFromRequest).toHaveBeenCalledWith(tx, p);
    expect(docs.create).not.toHaveBeenCalled();
  });
});

describe('DocumentsService.createVersion of a picture', () => {
  /** A transaction whose document lookups (plain and locked) return one live document of `ownerType`. */
  function versionTx(ownerType: string) {
    const { tx, inserted } = fakeTx();
    const doc = [{ id: randomUUID(), ownerType, ownerId: OWNER_ID, organizationId: ORG }];
    const locks: unknown[] = [];
    const chain = {
      from: () => chain,
      where: () => chain,
      limit: () => chain,
      then: (resolve: (rows: unknown[]) => unknown) => Promise.resolve(doc).then(resolve),
      for: (mode: unknown) => {
        locks.push(mode);
        return Promise.resolve(doc);
      },
    };
    Object.assign(tx, { select: vi.fn(() => chain) });
    return { tx, inserted, id: doc[0]!.id, locks };
  }

  it.each(PICTURE_TYPES)(
    'refuses a new version of a %s with 409 after the permission check, before the lock and any write',
    async (ownerType) => {
      const { svc, authz } = service(imagePolicy({ ownerType }));
      const v = versionTx(ownerType);

      const error: unknown = await svc
        .createVersion(v.tx, v.id, {
          filename: 'logo.png',
          declaredMime: 'image/png',
          sizeBytes: 10,
        })
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ConflictException);
      expect((error as ConflictException).getResponse()).toEqual(PICTURES_ELSEWHERE);
      expect(authz.assert).toHaveBeenCalledTimes(1);
      expect(v.locks).toHaveLength(0);
      expect(v.inserted).toHaveLength(0);
    },
  );

  it('answers 403, not 409, when the caller may not upload to the picture owner', async () => {
    const { svc } = service(imagePolicy(), { authz: denyAll() });
    const v = versionTx('entity_logo');
    await expect(
      svc.createVersion(v.tx, v.id, {
        filename: 'logo.png',
        declaredMime: 'image/png',
        sizeBytes: 10,
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(v.inserted).toHaveLength(0);
  });

  it("still applies another owner's narrower rules to a new version", async () => {
    const { svc } = service(imagePolicy({ ownerType: 'narrow_memo' }));
    const v = versionTx('narrow_memo');
    await expect(
      svc.createVersion(v.tx, v.id, {
        filename: 'memo.pdf',
        declaredMime: 'application/pdf',
        sizeBytes: 2048,
      }),
    ).rejects.toBeInstanceOf(UnsupportedMediaTypeException);
    await expect(
      svc.createVersion(v.tx, v.id, {
        filename: 'memo.png',
        declaredMime: 'image/png',
        sizeBytes: IMAGE_MAX_BYTES + 1,
      }),
    ).rejects.toBeInstanceOf(PayloadTooLargeException);
    expect(v.inserted).toHaveLength(0);
  });
});

describe('DocumentsService.openImage', () => {
  const DOC_ID = randomUUID();
  const VERSION_ID = randomUUID();

  interface Row {
    ownerType: string;
    tenantId: string;
    organizationId: string;
    removedAt: Date | null;
    version: {
      id: string;
      status: string;
      detectedMime: string | null;
      sizeBytes: number;
      storageKey: string;
    };
  }
  const good: Row = {
    ownerType: 'user_avatar',
    tenantId: TENANT,
    organizationId: ORG,
    removedAt: null,
    version: {
      id: VERSION_ID,
      status: 'clean',
      detectedMime: 'image/png',
      sizeBytes: PNG.length,
      storageKey: `${TENANT}/${VERSION_ID}`,
    },
  };

  function imageSetup(rows: Row[], openClean?: () => Promise<Readable>) {
    const wheres: SQL[] = [];
    const chain = {
      from: () => chain,
      innerJoin: () => chain,
      where: (condition: SQL) => {
        wheres.push(condition);
        return chain;
      },
      orderBy: () => chain,
      limit: () => Promise.resolve(rows),
    };
    const db = { select: vi.fn(() => chain) };
    const storage = {
      openClean: vi.fn(openClean ?? (() => Promise.resolve(Readable.from(PNG)))),
    };
    const { svc, authz } = service(imagePolicy(), { db, storage });
    return { svc, authz, db, storage, wheres };
  }

  it('opens a clean image of the scope without asking any permission', async () => {
    const { svc, authz, storage } = imageSetup([good]);

    const image = await svc.openImage(scope, DOC_ID);

    expect(image).toMatchObject({
      notModified: false,
      mime: 'image/png',
      size: PNG.length,
      etag: VERSION_ID,
    });
    expect(image.notModified ? undefined : image.stream).toBeInstanceOf(Readable);
    expect(storage.openClean).toHaveBeenCalledWith(`${TENANT}/${VERSION_ID}`);
    expect(authz.assert).not.toHaveBeenCalled();
  });

  it('opens a profile picture from another entity of the same tenant: people belong to the tenant', async () => {
    const { svc, storage } = imageSetup([{ ...good, organizationId: randomUUID() }]);

    const image = await svc.openImage(scope, DOC_ID);

    expect(image).toMatchObject({ notModified: false, etag: VERSION_ID });
    expect(storage.openClean).toHaveBeenCalledTimes(1);
  });

  it('is still a 404 for a profile picture of another tenant, whatever its entity', async () => {
    for (const organizationId of [ORG, randomUUID()]) {
      const { svc, storage } = imageSetup([{ ...good, tenantId: randomUUID(), organizationId }]);
      await expect(svc.openImage(scope, DOC_ID)).rejects.toBeInstanceOf(NotFoundException);
      expect(storage.openClean).not.toHaveBeenCalled();
    }
  });

  it.each(['customer_logo', 'vendor_logo'])(
    'opens a %s uploaded in another entity of the same tenant: customers and vendors belong to the tenant',
    async (ownerType) => {
      const { svc, storage } = imageSetup([{ ...good, ownerType, organizationId: randomUUID() }]);

      await expect(svc.openImage(scope, DOC_ID)).resolves.toMatchObject({
        notModified: false,
        etag: VERSION_ID,
      });
      expect(storage.openClean).toHaveBeenCalledTimes(1);
    },
  );

  it.each(['customer_logo', 'vendor_logo'])(
    'is still a 404 for a %s of another tenant, whatever its entity',
    async (ownerType) => {
      for (const organizationId of [ORG, randomUUID()]) {
        const { svc, storage } = imageSetup([
          { ...good, ownerType, tenantId: randomUUID(), organizationId },
        ]);
        await expect(svc.openImage(scope, DOC_ID)).rejects.toBeInstanceOf(NotFoundException);
        expect(storage.openClean).not.toHaveBeenCalled();
      }
    },
  );

  it('keeps an entity_logo to its entity: opens in the same one, 404 from another of the same tenant', async () => {
    const same = imageSetup([{ ...good, ownerType: 'entity_logo' }]);
    await expect(same.svc.openImage(scope, DOC_ID)).resolves.toMatchObject({
      notModified: false,
    });

    const other = imageSetup([{ ...good, ownerType: 'entity_logo', organizationId: randomUUID() }]);
    await expect(other.svc.openImage(scope, DOC_ID)).rejects.toBeInstanceOf(NotFoundException);
    expect(other.storage.openClean).not.toHaveBeenCalled();
  });

  it('asks the database for the tenant always, and for the entity unless the image is tenant-wide', async () => {
    const { svc, wheres } = imageSetup([good]);

    await svc.openImage(scope, DOC_ID);

    expect(wheres).toHaveLength(1);
    const params = paramsOf(wheres[0]!);
    expect(params).toEqual(
      expect.arrayContaining([TENANT, ORG, DOC_ID, 'user_avatar', 'customer_logo', 'vendor_logo']),
    );
    expect(params).not.toContain('entity_logo');
  });

  it.each([
    ['quoted', `"${VERSION_ID}"`],
    ['bare', VERSION_ID],
    ['weak', `W/"${VERSION_ID}"`],
    ['in a comma list', `"${randomUUID()}", W/"${VERSION_ID}" ,"${randomUUID()}"`],
  ])(
    'answers not modified for a matching If-None-Match (%s) without opening the storage',
    async (_name, header) => {
      const { svc, storage } = imageSetup([good]);

      const image = await svc.openImage(scope, DOC_ID, header);

      expect(image).toEqual({ notModified: true, etag: VERSION_ID });
      expect(storage.openClean).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['another version', `"${randomUUID()}"`],
    ['an empty header', ''],
    ['empty quotes', '""'],
    ['a prefix of the version id', `"${VERSION_ID.slice(0, 8)}"`],
  ])('opens the storage for a non-matching If-None-Match (%s)', async (_name, header) => {
    const { svc, storage } = imageSetup([good]);

    const image = await svc.openImage(scope, DOC_ID, header);

    expect(image).toMatchObject({ notModified: false, etag: VERSION_ID });
    expect(storage.openClean).toHaveBeenCalledTimes(1);
  });

  it('is a 404, not a 304, for a refused image even when If-None-Match names its version', async () => {
    const { svc, storage } = imageSetup([
      { ...good, ownerType: 'entity_logo', organizationId: randomUUID() },
    ]);

    await expect(svc.openImage(scope, DOC_ID, `"${VERSION_ID}"`)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(storage.openClean).not.toHaveBeenCalled();
  });

  const refusals: [string, () => ReturnType<typeof imageSetup>, string?][] = [
    ['an unknown id', () => imageSetup([])],
    ['an id that is not a UUID', () => imageSetup([good]), 'not-a-uuid'],
    ['a removed document', () => imageSetup([{ ...good, removedAt: new Date() }])],
    ...(['awaiting_content', 'quarantined', 'infected', 'scan_failed', 'rejected'] as const).map(
      (status): [string, () => ReturnType<typeof imageSetup>] => [
        `a newest version that is ${status}`,
        () => imageSetup([{ ...good, version: { ...good.version, status } }]),
      ],
    ),
    ['an owner type that is not an image', () => imageSetup([{ ...good, ownerType: 'quotation' }])],
    ['another tenant', () => imageSetup([{ ...good, tenantId: randomUUID() }])],
    [
      'a company logo of another entity',
      () => imageSetup([{ ...good, ownerType: 'entity_logo', organizationId: randomUUID() }]),
    ],
    [
      'a clean file whose detected type is not an image',
      () =>
        imageSetup([{ ...good, version: { ...good.version, detectedMime: 'application/pdf' } }]),
    ],
    [
      'a file missing from storage',
      () => imageSetup([good], () => Promise.reject(new StoredFileNotFoundError())),
    ],
  ];

  it.each(refusals)('is a 404 for %s', async (_name, make, id) => {
    const { svc, authz } = make();
    await expect(svc.openImage(scope, id ?? DOC_ID)).rejects.toBeInstanceOf(NotFoundException);
    expect(authz.assert).not.toHaveBeenCalled();
  });

  it('gives the same 404 body for every refusal, so existence never leaks', async () => {
    const bodies = await Promise.all(
      refusals.map(([, make, id]) =>
        make()
          .svc.openImage(scope, id ?? DOC_ID)
          .then(
            () => 'resolved',
            (e: unknown) => (e instanceof NotFoundException ? JSON.stringify(e.getResponse()) : e),
          ),
      ),
    );
    expect(new Set(bodies).size).toBe(1);
    expect(bodies[0]).not.toBe('resolved');
  });

  it('does not query for an id that is not a UUID', async () => {
    const { svc, db } = imageSetup([good]);
    await expect(svc.openImage(scope, "1' OR 1=1")).rejects.toBeInstanceOf(NotFoundException);
    expect(db.select).not.toHaveBeenCalled();
  });
});

describe('DocumentsService.removeInTransaction of an image', () => {
  const OTHER_ORG = randomUUID();

  /**
   * A transaction holding one live document: the lookups (plain and locked) return it, the versions read returns
   * one quarantined version, and every condition of a read and of the soft-remove update is captured.
   */
  function removal(doc: { ownerType: string; organizationId: string }) {
    const id = randomUUID();
    const row = { id, ownerId: OWNER_ID, ...doc };
    const version = { id: randomUUID(), documentId: id, version: 1, status: 'quarantined' };
    const reads: SQL[] = [];
    const updates: SQL[] = [];
    const chain = {
      from: () => chain,
      where: (condition: SQL) => {
        reads.push(condition);
        return chain;
      },
      limit: () => chain,
      orderBy: () => Promise.resolve([version]),
      for: () => Promise.resolve([row]),
      then: (resolve: (rows: unknown[]) => unknown) => Promise.resolve([row]).then(resolve),
    };
    const tx = {
      select: vi.fn(() => chain),
      update: vi.fn(() => ({
        set: () => ({
          where: (condition: SQL) => {
            updates.push(condition);
            return Promise.resolve();
          },
        }),
      })),
    } as unknown as DbTransaction;
    const { svc, authz, audit } = service(imagePolicy({ ownerType: doc.ownerType }));
    return { svc, authz, audit, tx, id, version, reads, updates };
  }

  it.each(['customer_logo', 'vendor_logo', 'user_avatar'])(
    'removes a %s uploaded in another entity of the tenant, writing under that entity',
    async (ownerType) => {
      const r = removal({ ownerType, organizationId: OTHER_ORG });

      await expect(r.svc.removeInTransaction(r.tx, scope, r.id)).resolves.toEqual([r.version]);

      // The owner policy still decides, with the caller's scope.
      expect(r.authz.assert).toHaveBeenCalledTimes(1);
      // The lookups: the tenant, and the caller's entity OR a tenant-wide image type.
      for (const lookup of r.reads.slice(0, 2)) {
        expect(paramsOf(lookup)).toEqual(
          expect.arrayContaining([
            TENANT,
            r.id,
            ORG,
            'user_avatar',
            'customer_logo',
            'vendor_logo',
          ]),
        );
        expect(paramsOf(lookup)).not.toContain('entity_logo');
      }
      // The versions read and the soft-remove: the tenant and the document's own entity, never the caller's.
      for (const condition of [r.reads[2]!, ...r.updates]) {
        expect(paramsOf(condition)).toEqual(expect.arrayContaining([TENANT, OTHER_ORG]));
        expect(paramsOf(condition)).not.toContain(ORG);
      }
      expect(r.updates).toHaveLength(1);
      expect(paramsOf(r.updates[0]!)).toContain(r.id);
      expect(r.audit.record).toHaveBeenCalledTimes(1);
    },
  );

  it('removes an entity_logo of the caller entity under that entity', async () => {
    const r = removal({ ownerType: 'entity_logo', organizationId: ORG });

    await r.svc.removeInTransaction(r.tx, scope, r.id);

    for (const condition of [r.reads[2]!, ...r.updates]) {
      expect(paramsOf(condition)).toEqual(expect.arrayContaining([TENANT, ORG]));
    }
  });

  it('keeps a new version strictly to the caller entity: no tenant-wide lookup there', async () => {
    const r = removal({ ownerType: 'customer_logo', organizationId: ORG });
    Object.assign(r.tx, fakeTx().tx, { select: r.tx.select });

    await r.svc
      .createVersion(r.tx, r.id, {
        filename: 'logo.pdf',
        declaredMime: 'application/pdf',
        sizeBytes: 10,
      })
      .catch(() => undefined);

    expect(paramsOf(r.reads[0]!)).toEqual(expect.arrayContaining([TENANT, ORG, r.id]));
    expect(paramsOf(r.reads[0]!)).not.toContain('customer_logo');
  });
});

describe('DocumentsService.remove (DELETE /v1/documents/:id) of a picture', () => {
  const actor = { kind: 'user' as const, id: USER, correlationId: 'c-1' };

  /**
   * The whole remove road of one live document of `ownerType` (one quarantined version): a database whose
   * transaction runs on a fake tx, the storage for the cleanup, and every update of the tx recorded.
   */
  function road(ownerType: string, authz?: { assert: () => void }) {
    const id = randomUUID();
    const row = { id, ownerType, ownerId: OWNER_ID, organizationId: ORG };
    const version = {
      id: randomUUID(),
      documentId: id,
      version: 1,
      status: 'quarantined',
      storageKey: `${TENANT}/v`,
    };
    const updates: SQL[] = [];
    const chain = {
      from: () => chain,
      where: () => chain,
      limit: () => chain,
      orderBy: () => Promise.resolve([version]),
      for: () => Promise.resolve([row]),
      then: (resolve: (rows: unknown[]) => unknown) => Promise.resolve([row]).then(resolve),
    };
    const tx = {
      execute: vi.fn().mockResolvedValue({ rows: [] }),
      select: vi.fn(() => chain),
      update: vi.fn(() => ({
        set: () => ({
          where: (condition: SQL) => {
            updates.push(condition);
            return Promise.resolve();
          },
        }),
      })),
    };
    const db = { transaction: (fn: (t: DbTransaction) => Promise<unknown>) => fn(tx as never) };
    const storage = { removeQuarantine: vi.fn().mockResolvedValue(undefined) };
    const policy = imagePolicy({ ownerType, canAttach: vi.fn().mockResolvedValue(true) });
    const s = service(policy, { db, storage, ...(authz ? { authz } : {}) });
    return { ...s, id, version, updates, storage, policy };
  }

  const PICTURES = ['entity_logo', 'user_avatar', 'customer_logo', 'vendor_logo'];

  it.each(PICTURES)(
    'refuses a %s with 409 and writes, audits and deletes nothing',
    async (ownerType) => {
      const r = road(ownerType);

      const error: unknown = await r.svc
        .remove(r.id, { who: { scope, actor } })
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ConflictException);
      expect((error as ConflictException).getResponse()).toEqual({
        code: 'conflict',
        message: 'This picture is managed from its own settings: replace or remove it there.',
      });
      // The permission was checked first.
      expect(r.authz.assert).toHaveBeenCalledTimes(1);
      expect(r.updates).toHaveLength(0);
      expect(r.audit.record).not.toHaveBeenCalled();
      expect(r.storage.removeQuarantine).not.toHaveBeenCalled();
    },
  );

  it.each(PICTURES)(
    'answers 403, not 409, for a %s when the caller may not remove it',
    async (ownerType) => {
      const authz = {
        assert: vi.fn(() => {
          throw new ForbiddenException({ code: 'forbidden', reason: 'no_permission' });
        }),
      };
      const r = road(ownerType, authz);

      await expect(r.svc.remove(r.id, { who: { scope, actor } })).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(r.updates).toHaveLength(0);
      expect(r.audit.record).not.toHaveBeenCalled();
    },
  );

  it('still removes a document of another owner type: soft-remove, audit, cleanup', async () => {
    const r = road('test_memo');

    await r.svc.remove(r.id, { who: { scope, actor } });

    expect(r.updates).toHaveLength(1);
    expect(paramsOf(r.updates[0]!)).toContain(r.id);
    expect(r.audit.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'document.removed', entityId: r.id }),
    );
    expect(r.storage.removeQuarantine).toHaveBeenCalledWith(r.version.storageKey);
  });

  it.each(PICTURES)(
    'removeManagedImage (the images module only) still removes a %s, with the same checks and cleanup',
    async (ownerType) => {
      const r = road(ownerType);

      await r.svc.removeManagedImage(r.id, { who: { scope, actor } });

      expect(r.authz.assert).toHaveBeenCalledTimes(1);
      expect(r.updates).toHaveLength(1);
      expect(r.audit.record).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ action: 'document.removed', entityId: r.id }),
      );
      expect(r.storage.removeQuarantine).toHaveBeenCalledWith(r.version.storageKey);
    },
  );
});

describe('DocumentsService.createAndReceiveScanned', () => {
  const dir = mkdtempSync(join(tmpdir(), 'docs-images-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  /**
   * A database for the whole create-then-receive road under the system actor: the create's inserts, the receive's
   * version lookups (built from the inserted version) and its two updates.
   */
  function pipeline() {
    const { tx, inserted } = fakeTx({ kind: 'system', id: SYSTEM });
    const versionRow = () => {
      const v = inserted[1] as Record<string, unknown>;
      return {
        ...v,
        status: 'awaiting_content',
        detectedMime: null,
        sha256: null,
        scanSignature: null,
        scannedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
    };
    const lookup = () => [{ version: versionRow(), ownerType: 'entity_logo', ownerId: OWNER_ID }];
    const chain = {
      from: () => chain,
      innerJoin: () => chain,
      where: () => chain,
      limit: () => chain,
      then: (resolve: (rows: unknown[]) => unknown) => Promise.resolve(lookup()).then(resolve),
      for: () => Promise.resolve(lookup()),
    };
    const updates: Record<string, unknown>[] = [];
    Object.assign(tx, {
      select: vi.fn(() => chain),
      update: vi.fn(() => ({
        set: (values: Record<string, unknown>) => {
          updates.push(values);
          return {
            where: () =>
              Object.assign(Promise.resolve(), {
                returning: () =>
                  Promise.resolve([{ ...versionRow(), ...values, status: 'quarantined' }]),
              }),
          };
        },
      })),
    });
    const db = { transaction: (fn: (t: DbTransaction) => Promise<unknown>) => fn(tx) };
    const storage = {
      writeQuarantine: vi.fn(async (key: string, src: Readable) => {
        const chunks: Buffer[] = [];
        for await (const chunk of src) chunks.push(chunk as Buffer);
        const bytes = Buffer.concat(chunks);
        writeFileSync(join(dir, key.replaceAll('/', '_')), bytes);
        return { bytes: bytes.length, sha256: Buffer.alloc(32), head: bytes.subarray(0, 4100) };
      }),
      commitQuarantine: vi.fn(),
      quarantinePath: (key: string) => join(dir, key.replaceAll('/', '_')),
      promote: vi.fn(),
      removeQuarantine: vi.fn(),
    };
    const queue = { add: vi.fn().mockResolvedValue(undefined) };
    return { db, storage, queue, inserted, updates };
  }

  const owner = { ownerType: 'entity_logo', ownerId: OWNER_ID };
  const file = { filename: 'logo.png', declaredMime: 'image/png', bytes: PNG };

  it('creates the document and queues the virus scan instead of marking it clean', async () => {
    const p = pipeline();
    const policy = imagePolicy();
    const { svc, audit, authz } = service(policy, p);

    const created = await svc.createAndReceiveScanned(owner, file, {
      scope,
      actor: { kind: 'system', id: SYSTEM, correlationId: 'c-1' },
    });

    expect(p.inserted).toHaveLength(2);
    expect(p.inserted[0]).toMatchObject({ id: created.documentId, ownerType: 'entity_logo' });
    expect(p.inserted[1]).toMatchObject({ id: created.versionId, declaredMime: 'image/png' });
    expect(policy.allowsSystemActor).toHaveBeenCalled();
    expect(authz.assert).not.toHaveBeenCalled();
    expect(p.updates[0]).toMatchObject({ status: 'quarantined' });
    expect(p.updates[0]).toMatchObject({ detectedMime: 'image/png' });
    expect(p.queue.add).toHaveBeenCalledTimes(1);
    expect(p.queue.add).toHaveBeenCalledWith(
      DOCS_SCAN_JOB,
      { versionId: created.versionId, tenantId: TENANT, organizationId: ORG },
      expect.objectContaining({ jobId: created.versionId }),
    );
    // Not the generated road: nothing promoted, nothing marked clean.
    expect(p.storage.promote).not.toHaveBeenCalled();
    expect(p.updates.some((u) => u.status === 'clean')).toBe(false);
    expect(audit.record).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'document.scanned' }),
    );
  });

  it('refuses a user actor with 403 before anything is written', async () => {
    const p = pipeline();
    const { svc } = service(imagePolicy(), p);

    await expect(
      svc.createAndReceiveScanned(owner, file, {
        scope,
        actor: { kind: 'user', id: USER, correlationId: 'c-1' },
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(p.inserted).toHaveLength(0);
    expect(p.storage.writeQuarantine).not.toHaveBeenCalled();
    expect(p.queue.add).not.toHaveBeenCalled();
  });
});
