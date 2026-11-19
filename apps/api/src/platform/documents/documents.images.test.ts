// Images as documents (U12, D33): an owner policy may narrow the upload types and size (logos and avatars: PNG,
// JPEG, WebP up to 512 KiB), `openImage` serves a clean image to any signed-in staff of the tenant and entity with
// one 404 for every refusal, and `createAndReceiveScanned` (the legacy-logo migrator) never skips the virus scan.
// Unit level with fakes; the SQL scoping of openImage against Postgres is not covered here.
import 'reflect-metadata';

import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { IMAGE_MAX_BYTES, IMAGE_MIME, type CreateDocumentBody } from '@bos/contracts';
import {
  ForbiddenException,
  NotFoundException,
  PayloadTooLargeException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import type { Queue } from 'bullmq';
import { afterAll, describe, expect, it, vi } from 'vitest';

import type { Db, DbTransaction } from '../db/tx';
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
    const chain = {
      from: () => chain,
      innerJoin: () => chain,
      where: () => chain,
      orderBy: () => chain,
      limit: () => Promise.resolve(rows),
    };
    const db = { select: vi.fn(() => chain) };
    const storage = {
      openClean: vi.fn(openClean ?? (() => Promise.resolve(Readable.from(PNG)))),
    };
    const { svc, authz } = service(imagePolicy(), { db, storage });
    return { svc, authz, db, storage };
  }

  it('opens a clean image of the scope without asking any permission', async () => {
    const { svc, authz, storage } = imageSetup([good]);

    const image = await svc.openImage(scope, DOC_ID);

    expect(image).toMatchObject({ mime: 'image/png', size: PNG.length, etag: VERSION_ID });
    expect(image.stream).toBeInstanceOf(Readable);
    expect(storage.openClean).toHaveBeenCalledWith(`${TENANT}/${VERSION_ID}`);
    expect(authz.assert).not.toHaveBeenCalled();
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
    ['another entity', () => imageSetup([{ ...good, organizationId: randomUUID() }])],
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
    expect(p.updates[1]).toMatchObject({ detectedMime: 'image/png' });
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
