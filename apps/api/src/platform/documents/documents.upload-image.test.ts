// `createAndReceiveUpload` (U12, D33): the one-request image upload of a signed-in user. It refuses a system actor,
// always queues the virus scan (never the generated road), asks the request's authz (never `allowsSystemActor`),
// and removes the just-created document when the receive fails (wrong type, queue down), throwing the receive's
// error even when that removal fails too. Unit level with fakes; Postgres is not involved.
// Run: apps/api/node_modules/.bin/vitest run src/platform/documents/documents.upload-image.test.ts (from apps/api)
import 'reflect-metadata';

import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { IMAGE_MAX_BYTES, IMAGE_MIME } from '@bos/contracts';
import {
  BadRequestException,
  ForbiddenException,
  ServiceUnavailableException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import type { Queue } from 'bullmq';
import { afterAll, describe, expect, it, vi } from 'vitest';

import type { Db, DbTransaction } from '../db/tx';
import { SCAN_ENQUEUE_TIMEOUT_MS } from '../queue/nudge-timeout';
import { DOCS_SCAN_JOB, type DocumentOwnerPolicy } from './documents.ports';
import { DocumentsService } from './documents.service';
import type { SignedLinks } from './signed-link';
import type { StorageAdapter } from './storage.adapter';

const TENANT = randomUUID();
const ORG = randomUUID();
const USER = randomUUID();
const OWNER_ID = randomUUID();
const scope = { tenantId: TENANT, organizationId: ORG };
const user = { kind: 'user' as const, id: USER, correlationId: 'c-1' };

/** A 1x1 PNG: real bytes, so the real type check (file-type) recognises it. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

const imagePolicy = (): DocumentOwnerPolicy => ({
  ownerType: 'user_avatar',
  allowedMime: IMAGE_MIME,
  maxBytes: IMAGE_MAX_BYTES,
  uploadPermission: 'profile.avatar.write',
  resource: (s) => Promise.resolve({ ...s }),
  allowsSystemActor: vi.fn().mockResolvedValue(true),
});

const dir = mkdtempSync(join(tmpdir(), 'docs-upload-image-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/**
 * A database for the whole create, receive and remove road under one actor: the create's inserts, the version and
 * document lookups (built from the inserted version), the receive's updates and the removal's version list.
 */
function pipeline(actor: { kind: string; id: string } = user) {
  const inserted: Record<string, unknown>[] = [];
  const updates: Record<string, unknown>[] = [];
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
  const lookup = () => [{ version: versionRow(), ownerType: 'user_avatar', ownerId: OWNER_ID }];
  const chain = {
    from: () => chain,
    innerJoin: () => chain,
    where: () => chain,
    limit: () => chain,
    orderBy: () => Promise.resolve([versionRow()]),
    then: (resolve: (rows: unknown[]) => unknown) => Promise.resolve(lookup()).then(resolve),
    for: () => Promise.resolve(lookup()),
  };
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
  };
  const db = {
    transaction: (fn: (t: DbTransaction) => Promise<unknown>) => fn(tx as unknown as DbTransaction),
  };
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
  const authz = { assert: vi.fn() };
  const audit = { record: vi.fn().mockResolvedValue(undefined) };
  const policy = imagePolicy();
  const svc = new DocumentsService(
    db as unknown as Db,
    storage as unknown as StorageAdapter,
    {} as SignedLinks,
    queue as unknown as Queue,
    authz,
    audit,
  );
  svc.registerOwner(policy);
  return { svc, inserted, updates, storage, queue, authz, audit, policy };
}

const owner = { ownerType: 'user_avatar', ownerId: OWNER_ID };
const file = { filename: 'me.png', declaredMime: 'image/png', bytes: PNG };
const removedAudit: unknown = expect.objectContaining({ action: 'document.removed' });

describe('DocumentsService.createAndReceiveUpload', () => {
  it('creates the document under the user and always queues the virus scan', async () => {
    const p = pipeline();

    const created = await p.svc.createAndReceiveUpload(owner, file, { scope, actor: user });

    expect(p.inserted).toHaveLength(2);
    expect(p.inserted[0]).toMatchObject({ id: created.documentId, ownerType: 'user_avatar' });
    expect(p.inserted[1]).toMatchObject({ id: created.versionId, declaredMime: 'image/png' });
    // The request's grant, never the system policy.
    expect(p.authz.assert).toHaveBeenCalledWith('profile.avatar.write', expect.anything());
    expect(p.policy.allowsSystemActor).not.toHaveBeenCalled();
    expect(p.updates[0]).toMatchObject({ status: 'quarantined' });
    expect(p.updates[0]).toMatchObject({ detectedMime: 'image/png' });
    expect(p.queue.add).toHaveBeenCalledTimes(1);
    expect(p.queue.add).toHaveBeenCalledWith(
      DOCS_SCAN_JOB,
      { versionId: created.versionId, tenantId: TENANT, organizationId: ORG },
      expect.objectContaining({ jobId: created.versionId }),
    );
    // Not the generated road: nothing promoted, nothing marked clean, nothing removed.
    expect(p.storage.promote).not.toHaveBeenCalled();
    expect(p.updates.some((u) => u.status === 'clean')).toBe(false);
    expect(p.updates.some((u) => 'removedAt' in u)).toBe(false);
  });

  it('refuses a system actor with 403 before anything is written', async () => {
    const p = pipeline({ kind: 'system', id: 'system:job' });
    await expect(
      p.svc.createAndReceiveUpload(owner, file, {
        scope,
        actor: { kind: 'system', id: 'system:job', correlationId: 'c-1' },
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(p.inserted).toHaveLength(0);
    expect(p.storage.writeQuarantine).not.toHaveBeenCalled();
    expect(p.queue.add).not.toHaveBeenCalled();
  });

  it('is 400 for an empty file or a file name with a path, before anything is written', async () => {
    for (const bad of [
      { ...file, bytes: Buffer.alloc(0) },
      { ...file, filename: '../me.png' },
    ]) {
      const p = pipeline();
      await expect(
        p.svc.createAndReceiveUpload(owner, bad, { scope, actor: user }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(p.inserted).toHaveLength(0);
    }
  });

  it('removes the new document and throws the 415 when the bytes are not the declared type', async () => {
    const p = pipeline();
    const notAnImage = { ...file, bytes: Buffer.from('plain text, not a PNG at all') };

    await expect(
      p.svc.createAndReceiveUpload(owner, notAnImage, { scope, actor: user }),
    ).rejects.toBeInstanceOf(UnsupportedMediaTypeException);

    expect(p.updates.some((u) => u.status === 'rejected')).toBe(true);
    expect(p.updates.some((u) => 'removedAt' in u)).toBe(true);
    expect(p.audit.record).toHaveBeenCalledWith(expect.anything(), removedAudit);
    expect(p.queue.add).not.toHaveBeenCalled();
  });

  it('removes the new document and throws the 503 when the scan queue is down', async () => {
    const p = pipeline();
    p.queue.add.mockRejectedValue(new Error('valkey down'));

    await expect(p.svc.createAndReceiveUpload(owner, file, { scope, actor: user })).rejects.toThrow(
      /not saved. Upload it again/,
    );
    await expect(
      p.svc.createAndReceiveUpload(owner, file, { scope, actor: user }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);

    expect(p.updates.some((u) => 'removedAt' in u)).toBe(true);
    expect(p.audit.record).toHaveBeenCalledWith(expect.anything(), removedAudit);
  });

  it('waits 4 s for a slow scan enqueue and answers the 503 only after that', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const p = pipeline();
      // A down Valkey leaves bullmq's `queue.add` pending forever: it neither resolves nor rejects.
      p.queue.add.mockReturnValue(new Promise(() => undefined));

      let outcome: unknown = 'pending';
      const request = p.svc
        .createAndReceiveUpload(owner, file, { scope, actor: user })
        .catch((error: unknown) => {
          outcome = error;
        });
      // Let the receive reach the enqueue. It does real I/O (type sniffing), so yield to the real event loop with
      // setImmediate (not faked) until `add` was called; only setTimeout is faked.
      // A real-time bound, not an iteration count: on a loaded runner the sniffing I/O takes longer than any fixed
      // number of immediates (the old count of 5000 ran out in 50 ms on GitHub).
      const until = Date.now() + 10_000;
      while (p.queue.add.mock.calls.length === 0 && Date.now() < until) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      expect(p.queue.add).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(SCAN_ENQUEUE_TIMEOUT_MS - 1);
      expect(outcome).toBe('pending');

      await vi.advanceTimersByTimeAsync(1);
      await request;
      expect(outcome).toBeInstanceOf(ServiceUnavailableException);
      expect(p.updates.some((u) => 'removedAt' in u)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the upload when a slow Valkey answers the scan enqueue inside the bound', async () => {
    const p = pipeline();
    p.queue.add.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve({ id: 'job' }), 1_500)),
    );

    await expect(
      p.svc.createAndReceiveUpload(owner, file, { scope, actor: user }),
    ).resolves.toBeDefined();
    expect(p.updates.some((u) => 'removedAt' in u)).toBe(false);
  });

  it('queues the scan once Valkey is back inside the bound after refusing the add while it reconnected (R6Q24)', async () => {
    const p = pipeline();
    const refused = () =>
      new Error("Stream isn't writeable and enableOfflineQueue options is false");
    p.queue.add
      .mockRejectedValueOnce(refused())
      .mockRejectedValueOnce(refused())
      .mockResolvedValue({ id: 'job' });

    await expect(
      p.svc.createAndReceiveUpload(owner, file, { scope, actor: user }),
    ).resolves.toBeDefined();
    expect(p.queue.add).toHaveBeenCalledTimes(3);
    expect(p.updates.some((u) => 'removedAt' in u)).toBe(false);
  });

  it('still throws the receive error when removing the document fails too', async () => {
    const p = pipeline();
    p.queue.add.mockRejectedValue(new Error('valkey down'));
    const remove = vi
      .spyOn(p.svc, 'removeManagedImage')
      .mockRejectedValue(new Error('database down'));

    await expect(
      p.svc.createAndReceiveUpload(owner, file, { scope, actor: user }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(remove).toHaveBeenCalledWith(p.inserted[0]?.id, { who: { scope, actor: user } });
  });
});
