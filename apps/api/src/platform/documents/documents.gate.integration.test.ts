// The upload gate (R1) and the way out of a bad attachment (R6), end to end over HTTP against real Postgres.
// Real: Postgres 16 (Testcontainers, all migrations as bos_owner, queries as bos_app), the Nest controllers
// with the production body-parser setup, the storage on a temp dir. Fakes: authz, audit, the scan queue.
// There is no scanner here: a version's verdict (clean, infected, scan_failed) is written straight to the
// row, because this file tests what the service does AROUND a verdict, not how the verdict is reached
// (documents.integration.test.ts covers the scan itself).
// Needs Docker. Run: pnpm --filter @bos/api exec vitest run src/platform/documents/documents.gate.integration.test.ts
import 'reflect-metadata';

import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createTenantWithEntity } from '@bos/db';
import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Queue } from 'bullmq';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { configureApp } from '../../app.setup';
import { CAN_KEY } from '../authz/decorators';
import { DB, type Db } from '../db/db.module';
import { withTx, type Actor, type TxScope } from '../db/tx';
import { ErrorBodyFilter } from '../tenancy/error-body.filter';
import { DocumentsController } from './documents.controller';
import { DocumentsService } from './documents.service';
import { FilesController } from './files.controller';
import { SignedLinks, type LinkStore } from './signed-link';
import { DiskStorageAdapter } from './storage.adapter';
import { createTestDatabase, type TestDatabase } from '@bos/db/testing';

// requestTx() reads the HTTP request context, which does not exist in this in-process setup. Everything
// else in tx.ts (withTx) is the real code.
const current = vi.hoisted((): { scope: TxScope; actor: Actor } => ({
  scope: { tenantId: '', organizationId: '' },
  actor: { kind: 'user', id: '', correlationId: 'test-correlation' },
}));
vi.mock('../db/tx', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db/tx')>();
  return { ...actual, requestTx: () => ({ scope: current.scope, actor: current.actor }) };
});

vi.setConfig({ testTimeout: 60_000, hookTimeout: 180_000 });

const SECRET = 'an-integration-test-secret-of-32-plus-chars';
const USER = randomUUID();

const PDF = () => Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF\n');

class MemoryStore implements LinkStore {
  private readonly keys = new Set<string>();
  claim(key: string): Promise<boolean> {
    if (this.keys.has(key)) return Promise.resolve(false);
    this.keys.add(key);
    return Promise.resolve(true);
  }
}

let testDb: TestDatabase;
let pool: Pool;
let db: Db;
let app: INestApplication;
let baseUrl: string;
let storageRoot: string;
let storage: DiskStorageAdapter;
let service: DocumentsService;

const authz = { assert: vi.fn() };
const audit = { record: vi.fn().mockResolvedValue(undefined) };
const queue = { add: vi.fn().mockResolvedValue({}) };

// The gated owner type stands for a memo: it takes attachments only while `attachAllowed` is true.
let attachAllowed = true;
const canAttach = vi.fn((_scope: TxScope, _ownerId: string, _tx?: unknown) =>
  Promise.resolve(attachAllowed),
);

beforeAll(async () => {
  testDb = await createTestDatabase();
  const admin = new Pool({ connectionString: testDb.adminUrl, max: 1 });
  await admin.end();
  const bosAdmin = new Pool({ connectionString: testDb.adminUrl, max: 1 });
  await bosAdmin.end();
  pool = new Pool({ connectionString: testDb.appUrl, max: 8 });
  db = drizzle({ client: pool });

  const { tenantId, organizationId } = await createTenantWithEntity(pool);
  current.scope = { tenantId, organizationId };
  current.actor = { kind: 'user', id: USER, correlationId: 'test-correlation' };

  storageRoot = await mkdtemp(join(tmpdir(), 'bos-docs-gate-'));
  storage = new DiskStorageAdapter(storageRoot);
  service = new DocumentsService(
    db,
    storage,
    new SignedLinks(SECRET, new MemoryStore(), () => Date.now()),
    queue as unknown as Queue,
    authz,
    audit,
  );
  const resource = (scope: TxScope) =>
    Promise.resolve({
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      ownerUserId: USER,
    });
  service.registerOwner({ ownerType: 'gated_memo', resource, canAttach });
  // No canAttach: today's behaviour, always allowed.
  service.registerOwner({ ownerType: 'open_memo', resource });

  const moduleRef = await Test.createTestingModule({
    controllers: [DocumentsController, FilesController],
    providers: [
      { provide: DocumentsService, useValue: service },
      { provide: DB, useValue: db },
    ],
  }).compile();
  app = moduleRef.createNestApplication({ rawBody: true, logger: false });
  configureApp(app);
  app.useGlobalFilters(new ErrorBodyFilter());
  await app.listen(0, '127.0.0.1');
  baseUrl = `http://127.0.0.1:${((app.getHttpServer() as Server).address() as AddressInfo).port}`;
});

afterAll(async () => {
  await app?.close();
  await pool?.end();
  await testDb?.drop();
  if (storageRoot) await rm(storageRoot, { recursive: true, force: true });
});

beforeEach(() => {
  attachAllowed = true;
  authz.assert.mockReset();
  audit.record.mockClear();
  canAttach.mockClear();
  queue.add.mockReset().mockResolvedValue({});
});

// ---------------------------------------------------------------------------------------- helpers

interface Created {
  documentId: string;
  versionId: string;
  uploadPath: string;
}

const body = (over: Record<string, unknown> = {}) => ({
  filename: 'invoice.pdf',
  declaredMime: 'application/pdf',
  sizeBytes: PDF().length,
  ...over,
});

const createReq = (ownerType: string, ownerId: string) =>
  request(baseUrl)
    .post('/v1/documents')
    .send({ ownerType, ownerId, ...body() });

async function create(ownerType: string, ownerId: string): Promise<Created> {
  const res = await createReq(ownerType, ownerId);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as Created;
}

const put = (path: string, bytes: Buffer = PDF()) =>
  request(baseUrl).put(path).set('Content-Type', 'application/pdf').send(bytes);

const newVersionReq = (documentId: string) =>
  request(baseUrl).post(`/v1/documents/${documentId}/versions`).send(body());

const removeReq = (documentId: string) => request(baseUrl).delete(`/v1/documents/${documentId}`);

/** The verdict a scan would have written. A clean one also becomes the document's current version. */
async function setStatus(versionId: string, status: string): Promise<void> {
  const key = (await statusOf(versionId))?.storage_key ?? '';
  // Through withTx: the audit trigger refuses a write that has no actor.
  await withTx(db, current.scope, current.actor, async (tx) => {
    await tx.execute(
      sql`UPDATE app.document_versions SET status = ${status} WHERE id = ${versionId}`,
    );
    if (status === 'clean') {
      await tx.execute(sql`UPDATE app.documents SET current_version_id = ${versionId}
        WHERE id = (SELECT document_id FROM app.document_versions WHERE id = ${versionId})`);
    }
  });
  // What the scan processor does on a clean verdict: the bytes leave quarantine.
  if (status === 'clean' && existsSync(storage.quarantinePath(key))) await storage.promote(key);
}

/**
 * A memo attachment in `status`, reached the way the system reaches it: `awaiting_content` is a created
 * document with no bytes, `quarantined` is an uploaded one, and the verdicts follow from quarantined
 * (migration 0010 refuses any other move).
 */
async function uploaded(ownerId: string, status: string): Promise<Created> {
  const c = await create('gated_memo', ownerId);
  if (status === 'awaiting_content') return c;
  expect((await put(c.uploadPath)).status).toBe(200);
  if (status !== 'quarantined') await setStatus(c.versionId, status);
  return c;
}

const count = async (table: 'documents' | 'document_versions', ownerId: string) => {
  const sqlText =
    table === 'documents'
      ? 'SELECT count(*)::int AS n FROM app.documents WHERE owner_id = $1'
      : `SELECT count(*)::int AS n FROM app.document_versions v
           JOIN app.documents d ON d.id = v.document_id WHERE d.owner_id = $1`;
  const { rows } = await pool.query<{ n: number }>(sqlText, [ownerId]);
  return rows[0]?.n ?? -1;
};

const statusOf = async (versionId: string) =>
  (
    await pool.query<{ status: string; storage_key: string }>(
      'SELECT status, storage_key FROM app.document_versions WHERE id = $1',
      [versionId],
    )
  ).rows[0];

const removedAt = async (documentId: string) =>
  (
    await pool.query<{ removed_at: Date | null }>(
      'SELECT removed_at FROM app.documents WHERE id = $1',
      [documentId],
    )
  ).rows[0]?.removed_at;

const allClean = (ownerId: string) => service.allClean(current.scope, 'gated_memo', ownerId);

// ------------------------------------------------------------------------------------------ R1

describe('R1: the owner decides whether it still takes attachments', () => {
  it('refuses a new document with 409 and writes no row when canAttach says no', async () => {
    attachAllowed = false;
    const ownerId = randomUUID();
    const res = await createReq('gated_memo', ownerId);
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: { code: 'conflict' } });
    expect(await count('documents', ownerId)).toBe(0);
    expect(await count('document_versions', ownerId)).toBe(0);
    expect(canAttach).toHaveBeenCalledTimes(1);
    expect(canAttach.mock.calls[0]?.[0]).toEqual(current.scope);
    expect(canAttach.mock.calls[0]?.[1]).toBe(ownerId);
    // The open transaction is passed, so an owner can lock its own row inside it.
    expect(canAttach.mock.calls[0]?.[2]).toBeDefined();
  });

  it('allows the upload when canAttach says yes', async () => {
    const ownerId = randomUUID();
    await create('gated_memo', ownerId);
    expect(await count('documents', ownerId)).toBe(1);
    expect(canAttach).toHaveBeenCalledTimes(1);
  });

  it('allows everything when the policy has no canAttach (today’s behaviour)', async () => {
    const ownerId = randomUUID();
    const c = await create('open_memo', ownerId);
    expect((await put(c.uploadPath)).status).toBe(200);
    expect((await newVersionReq(c.documentId)).status).toBe(201);
    expect(canAttach).not.toHaveBeenCalled();
  });

  it('refuses the content upload with 409 when the memo was submitted after the document was created', async () => {
    const ownerId = randomUUID();
    const c = await create('gated_memo', ownerId);
    attachAllowed = false;
    const res = await put(c.uploadPath);
    expect(res.status).toBe(409);
    const v = await statusOf(c.versionId);
    expect(v?.status).toBe('awaiting_content');
    expect(existsSync(storage.quarantinePath(v?.storage_key ?? ''))).toBe(false);
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('refuses a new version with 409 and writes no version row when canAttach says no', async () => {
    const ownerId = randomUUID();
    const c = await uploaded(ownerId, 'clean');
    attachAllowed = false;
    const res = await newVersionReq(c.documentId);
    expect(res.status).toBe(409);
    expect(await count('document_versions', ownerId)).toBe(1);
  });
});

// ------------------------------------------------------------------------------------------ R6

describe('R6: a bad attachment can be removed or replaced', () => {
  it('removing an infected attachment makes allClean true again', async () => {
    const ownerId = randomUUID();
    const bad = await uploaded(ownerId, 'infected');
    await uploaded(ownerId, 'clean');
    expect(await allClean(ownerId)).toBe(false);

    const res = await removeReq(bad.documentId);
    expect(res.status).toBe(204);

    expect(await allClean(ownerId)).toBe(true);
    // Soft remove: the rows stay for the audit trail.
    expect(await removedAt(bad.documentId)).toBeInstanceOf(Date);
    expect((await statusOf(bad.versionId))?.status).toBe('infected');
    expect(audit.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'document.removed', entityId: bad.documentId }),
    );
    // And the owner no longer lists it.
    const listed = await service.listForOwner(current.scope, 'gated_memo', ownerId);
    expect(listed.map((v) => v.documentId)).not.toContain(bad.documentId);
  });

  it.each(['scan_failed', 'awaiting_content', 'quarantined'])(
    'removes a document whose latest version is %s',
    async (status) => {
      const ownerId = randomUUID();
      const c = await uploaded(ownerId, status);
      expect(await allClean(ownerId)).toBe(false);
      expect((await removeReq(c.documentId)).status).toBe(204);
      expect(await allClean(ownerId)).toBe(true);
    },
  );

  it('deletes the quarantined bytes of a removed document', async () => {
    const ownerId = randomUUID();
    const c = await uploaded(ownerId, 'scan_failed');
    const key = (await statusOf(c.versionId))?.storage_key ?? '';
    expect(existsSync(storage.quarantinePath(key))).toBe(true);
    expect((await removeReq(c.documentId)).status).toBe(204);
    expect(existsSync(storage.quarantinePath(key))).toBe(false);
  });

  it('removing a clean file while canAttach is false gets 409 and changes nothing', async () => {
    const ownerId = randomUUID();
    const c = await uploaded(ownerId, 'clean');
    attachAllowed = false;
    const res = await removeReq(c.documentId);
    expect(res.status).toBe(409);
    expect(await removedAt(c.documentId)).toBeNull();
    expect(await allClean(ownerId)).toBe(true);
  });

  it('removes a clean file while canAttach is true, and nothing can reach it afterwards', async () => {
    const ownerId = randomUUID();
    const c = await uploaded(ownerId, 'clean');
    expect((await request(baseUrl).get(`/v1/documents/${c.documentId}`)).status).toBe(200);
    expect((await removeReq(c.documentId)).status).toBe(204);
    expect((await request(baseUrl).get(`/v1/documents/${c.documentId}`)).status).toBe(404);
    const link = await request(baseUrl).post(
      `/v1/documents/${c.documentId}/versions/${c.versionId}/link`,
    );
    expect(link.status).toBe(404);
    expect((await newVersionReq(c.documentId)).status).toBe(404);
    expect((await removeReq(c.documentId)).status).toBe(404);
  });

  it('a link issued before the removal stops working', async () => {
    const ownerId = randomUUID();
    const c = await uploaded(ownerId, 'clean');
    const tokenOf = async () =>
      (await service.issueLink(current.scope, c.versionId, c.documentId)).url.replace(
        '/v1/files/',
        '',
      );
    // Sanity: before the removal a link opens the file.
    const handle = await service.openDownload(await tokenOf());
    handle.stream.destroy();
    const late = await tokenOf();
    expect((await removeReq(c.documentId)).status).toBe(204);
    await expect(service.openDownload(late)).rejects.toMatchObject({ status: 404 });
  });

  it.each(['infected', 'scan_failed'])(
    'accepts a new version on top of a %s one, and the owner is clean once it is',
    async (status) => {
      const ownerId = randomUUID();
      const bad = await uploaded(ownerId, status);
      expect(await allClean(ownerId)).toBe(false);

      const res = await newVersionReq(bad.documentId);
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      const v2 = res.body as Created;
      expect(v2.documentId).toBe(bad.documentId);
      expect(v2.uploadPath).toBe(
        `/v1/documents/${bad.documentId}/versions/${v2.versionId}/content`,
      );
      const { rows } = await pool.query<{ version: number }>(
        'SELECT version FROM app.document_versions WHERE id = $1',
        [v2.versionId],
      );
      expect(rows[0]?.version).toBe(2);

      // The new version is awaiting content, so the owner is still not clean ...
      expect(await allClean(ownerId)).toBe(false);
      expect((await put(v2.uploadPath)).status).toBe(200);
      await setStatus(v2.versionId, 'clean');
      // ... and is once the new version has passed the scan, although version 1 stays as it was.
      expect(await allClean(ownerId)).toBe(true);
      expect((await statusOf(bad.versionId))?.status).toBe(status);
    },
  );

  it('numbers versions one after another when two are requested at once', async () => {
    const ownerId = randomUUID();
    const c = await uploaded(ownerId, 'scan_failed');
    const results = await Promise.all([newVersionReq(c.documentId), newVersionReq(c.documentId)]);
    expect(results.map((r) => r.status)).toEqual([201, 201]);
    const { rows } = await pool.query<{ version: number }>(
      'SELECT version FROM app.document_versions WHERE document_id = $1 ORDER BY version',
      [c.documentId],
    );
    expect(rows.map((r) => r.version)).toEqual([1, 2, 3]);
  });

  it('an upload to a removed document is refused', async () => {
    const ownerId = randomUUID();
    const c = await create('gated_memo', ownerId);
    expect((await removeReq(c.documentId)).status).toBe(204);
    expect((await put(c.uploadPath)).status).toBe(404);
  });

  it('removal and new versions are gated by documents.upload, like the upload', () => {
    const proto = DocumentsController.prototype;
    expect(Reflect.getMetadata(CAN_KEY, proto.remove)).toBe('documents.upload');
    expect(Reflect.getMetadata(CAN_KEY, proto.createVersion)).toBe('documents.upload');
    expect(Reflect.getMetadata(CAN_KEY, proto.create)).toBe('documents.upload');
  });
});
