// Documents end to end, minus the pieces other units own (authz, audit, notify, Valkey, BullMQ are fakes).
// Real: Postgres 16 (Testcontainers, migrations 0000-0007 as bos_owner, queries as bos_app), the Nest
// controllers with the production body-parser setup (configureApp + rawBody), the storage on a temp dir,
// ClamdClient talking to the fake clamd over TCP, and ScanProcessor.
// Needs Docker. Run: pnpm --filter @bos/api exec vitest run src/platform/documents/documents.integration.test.ts
import 'reflect-metadata';

import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import http, { type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import {
  DocumentVersionDtoSchema,
  ErrorBodySchema,
  MAX_UPLOAD_BYTES,
  SignedLinkDtoSchema,
} from '@bos/contracts';
import { createTenantWithEntity } from '@bos/db';
import {
  BadRequestException,
  PayloadTooLargeException,
  ForbiddenException,
  ServiceUnavailableException,
  UnauthorizedException,
  type INestApplication,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Queue } from 'bullmq';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { configureApp } from '../../app.setup';
import { DB, type Db } from '../db/db.module';
import { withTx, type Actor, type TxScope } from '../db/tx';
import { buildLink, renderEmail, type EmailTemplate } from '../notify/templates';
import { ErrorBodyFilter } from '../tenancy/error-body.filter';
import { ClamdClient } from './clamd.client';
import { DocumentsController } from './documents.controller';
import { DocumentsService } from './documents.service';
import { FilesController } from './files.controller';
import { SignedLinks, type LinkStore } from './signed-link';
import { eicarBytes, startFakeClamd, type FakeClamd } from './fake-clamd';
import { SCAN_JOB_OPTIONS, ScanProcessor, ScanSweepProcessor } from './scan.processor';
import { DiskStorageAdapter } from './storage.adapter';
import { createTestDatabase, type TestDatabase } from '@bos/db/testing';

// requestTx() reads the HTTP request context, which does not exist in this in-process setup. Everything
// else in tx.ts (withTx, systemActor) is the real code.
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
const MISSING_OWNER = '00000000-0000-4000-8000-00000000dead';

const PDF = (padding = 0) =>
  Buffer.concat([
    Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF\n'),
    Buffer.alloc(padding, 0x20),
  ]);
const EXE = () => Buffer.concat([Buffer.from('MZ'), Buffer.alloc(300)]);

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
let processor: ScanProcessor;
let fakeClamd: FakeClamd;
let hangingClamd: FakeClamd;
let hangingProcessor: ScanProcessor;
let now = Date.now();

const authz = { assert: vi.fn() };
const audit = { record: vi.fn().mockResolvedValue(undefined) };
// The fake runs the REAL template validation, as NotifyService.notifyUser does at enqueue time, so a
// link the real service would refuse (and roll the transaction back for) fails here too.
const notify = {
  notifyUser: vi.fn((_tx: unknown, n: { link: string; email?: EmailArg }) => {
    buildLink('http://workspace.test', n.link);
    if (n.email !== undefined) {
      renderEmail(n.email.template, n.email.vars, { workspaceUrl: 'http://workspace.test' });
    }
    return Promise.resolve();
  }),
};
type EmailArg = { template: EmailTemplate; vars: Record<string, string> };
const queue = { add: vi.fn().mockResolvedValue({}) };

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

  storageRoot = await mkdtemp(join(tmpdir(), 'bos-docs-it-'));
  storage = new DiskStorageAdapter(storageRoot);
  service = new DocumentsService(
    db,
    storage,
    new SignedLinks(SECRET, new MemoryStore(), () => now),
    queue as unknown as Queue,
    authz,
    audit,
  );
  service.registerOwner({
    ownerType: 'test_memo',
    resource: (scope, ownerId) =>
      Promise.resolve(
        ownerId === MISSING_OWNER
          ? null
          : { tenantId: scope.tenantId, organizationId: scope.organizationId, ownerUserId: USER },
      ),
  });

  fakeClamd = await startFakeClamd();
  hangingClamd = await startFakeClamd({ mode: 'hang' });
  const make = (c: FakeClamd, timeoutMs: number) =>
    new ScanProcessor(
      db,
      storage,
      new ClamdClient({ host: c.host, port: c.port, timeoutMs }),
      audit,
      notify,
    );
  processor = make(fakeClamd, 5_000);
  hangingProcessor = make(hangingClamd, 300);

  const moduleRef = await Test.createTestingModule({
    controllers: [DocumentsController, FilesController],
    providers: [
      { provide: DocumentsService, useValue: service },
      { provide: DB, useValue: db },
    ],
  }).compile();
  // rawBody: true as in main.ts, and configureApp() as in production: the body-parser setup is what is under test.
  app = moduleRef.createNestApplication({ rawBody: true, logger: false });
  configureApp(app);
  app.useGlobalFilters(new ErrorBodyFilter());
  await app.listen(0, '127.0.0.1');
  baseUrl = `http://127.0.0.1:${((app.getHttpServer() as Server).address() as AddressInfo).port}`;
});

afterAll(async () => {
  await app?.close();
  await fakeClamd?.close();
  await hangingClamd?.close();
  await pool?.end();
  await testDb?.drop();
  if (storageRoot) await rm(storageRoot, { recursive: true, force: true });
});

beforeEach(() => {
  authz.assert.mockReset();
  audit.record.mockClear();
  notify.notifyUser.mockClear();
  queue.add.mockReset().mockResolvedValue({});
  now = Date.now();
});

// ---------------------------------------------------------------------------------------- helpers

interface Created {
  documentId: string;
  versionId: string;
  uploadPath: string;
}

async function create(
  over: Partial<{
    ownerType: string;
    ownerId: string;
    filename: string;
    declaredMime: string;
    sizeBytes: number;
  }> = {},
): Promise<Created> {
  const res = await request(baseUrl)
    .post('/v1/documents')
    .send({
      ownerType: 'test_memo',
      ownerId: randomUUID(),
      filename: 'invoice.pdf',
      declaredMime: 'application/pdf',
      sizeBytes: PDF().length,
      ...over,
    });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as Created;
}

const put = (path: string, bytes: Buffer, contentType: string) =>
  request(baseUrl).put(path).set('Content-Type', contentType).send(bytes);

async function row(versionId: string) {
  const { rows } = await pool.query<{
    status: string;
    storage_key: string;
    detected_mime: string | null;
    sha256: Buffer | null;
    scan_signature: string | null;
    current_version_id: string | null;
  }>(
    `SELECT v.status, v.storage_key, v.detected_mime, v.sha256, v.scan_signature, d.current_version_id
       FROM app.document_versions v JOIN app.documents d ON d.id = v.document_id WHERE v.id = $1`,
    [versionId],
  );
  const r = rows[0];
  if (r === undefined) throw new Error('no such version');
  return r;
}

const scanJob = (versionId: string) => ({
  versionId,
  tenantId: current.scope.tenantId,
  organizationId: current.scope.organizationId,
});

/** Uploads a PDF and runs the scan: a clean version. */
async function cleanVersion(): Promise<Created & { bytes: Buffer }> {
  const bytes = PDF(100);
  const c = await create({ sizeBytes: bytes.length });
  expect((await put(c.uploadPath, bytes, 'application/pdf')).status).toBe(200);
  expect(await processor.scanVersion(scanJob(c.versionId), true)).toBe('clean');
  return { ...c, bytes };
}

const codeOf = async (p: Promise<unknown>): Promise<unknown> => {
  try {
    await p;
    return undefined;
  } catch (error) {
    const e = error as { code?: unknown; cause?: { code?: unknown } };
    return e.code ?? e.cause?.code;
  }
};

// ------------------------------------------------------------------------------------------ create

describe('POST /v1/documents', () => {
  it('creates a document and version 1 awaiting content, after asking the owner policy and authz', async () => {
    const ownerId = randomUUID();
    const c = await create({ ownerId });
    expect(c.uploadPath).toBe(`/v1/documents/${c.documentId}/versions/${c.versionId}/content`);
    expect((await row(c.versionId)).status).toBe('awaiting_content');
    expect(authz.assert).toHaveBeenCalledWith('documents.upload', {
      tenantId: current.scope.tenantId,
      organizationId: current.scope.organizationId,
      ownerUserId: USER,
    });
  });

  it('answers 415 for a type outside the allow-list and 413 for a declared size over 25 MiB', async () => {
    const base = {
      ownerType: 'test_memo',
      ownerId: randomUUID(),
      filename: 'a.exe',
      sizeBytes: 10,
    };
    const exe = await request(baseUrl)
      .post('/v1/documents')
      .send({ ...base, declaredMime: 'application/x-msdownload' });
    expect(exe.status).toBe(415);
    expect(ErrorBodySchema.parse(exe.body).error.code).toBe('unsupported_media_type');
    const big = await request(baseUrl)
      .post('/v1/documents')
      .send({
        ...base,
        filename: 'a.pdf',
        declaredMime: 'application/pdf',
        sizeBytes: MAX_UPLOAD_BYTES + 1,
      });
    expect(big.status).toBe(413);
    expect(ErrorBodySchema.parse(big.body).error.code).toBe('payload_too_large');
  });

  it('answers 400 for an unknown owner type, 404 for a missing owner, 400 for a malformed body', async () => {
    const body = { filename: 'a.pdf', declaredMime: 'application/pdf', sizeBytes: 10 };
    expect(
      (
        await request(baseUrl)
          .post('/v1/documents')
          .send({ ...body, ownerType: 'nope', ownerId: randomUUID() })
      ).status,
    ).toBe(400);
    expect(
      (
        await request(baseUrl)
          .post('/v1/documents')
          .send({ ...body, ownerType: 'test_memo', ownerId: MISSING_OWNER })
      ).status,
    ).toBe(404);
    expect(
      (await request(baseUrl).post('/v1/documents').send({ ownerType: 'test_memo' })).status,
    ).toBe(400);
  });

  it("passes authz.assert's 403 through", async () => {
    authz.assert.mockImplementationOnce(() => {
      throw new ForbiddenException({ code: 'forbidden', reason: 'out_of_scope' });
    });
    const res = await request(baseUrl).post('/v1/documents').send({
      ownerType: 'test_memo',
      ownerId: randomUUID(),
      filename: 'a.pdf',
      declaredMime: 'application/pdf',
      sizeBytes: 10,
    });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: { reason: 'out_of_scope' } });
  });
});

// ------------------------------------------------------------------------------------------ upload

describe('PUT .../content (raw streamed upload)', () => {
  it('streams a 200 KB PDF past the 16 kb JSON parser limit; the SHA-256 and detected type are right', async () => {
    const bytes = PDF(200 * 1024);
    const c = await create({ sizeBytes: bytes.length });
    const res = await put(c.uploadPath, bytes, 'application/pdf');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const dto = DocumentVersionDtoSchema.parse(res.body);
    expect(dto).toMatchObject({
      status: 'quarantined',
      detectedMime: 'application/pdf',
      sizeBytes: bytes.length,
    });
    expect(dto.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(authz.assert).toHaveBeenCalledWith('documents.upload', expect.anything());
    const r = await row(c.versionId);
    expect(r.sha256?.toString('hex')).toBe(dto.sha256);
    expect(existsSync(storage.quarantinePath(r.storage_key))).toBe(true);
    expect(queue.add).toHaveBeenCalledWith(
      'docs.scan',
      scanJob(c.versionId),
      expect.objectContaining({ jobId: c.versionId, attempts: SCAN_JOB_OPTIONS.attempts }),
    );
  });

  it('cannot skip the scan from the request: no query, header or field makes the upload "generated" (D28)', async () => {
    const bytes = PDF(2 * 1024);
    const c = await create({ sizeBytes: bytes.length });
    const res = await request(baseUrl)
      .put(`${c.uploadPath}?generated=true&skipScan=true&scan_engine=generated&status=clean`)
      .set('Content-Type', 'application/pdf')
      .set('X-Skip-Scan', 'true')
      .set('X-Generated', 'true')
      .send(bytes);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(DocumentVersionDtoSchema.parse(res.body).status).toBe('quarantined');
    expect((await row(c.versionId)).status).toBe('quarantined');
    expect(queue.add).toHaveBeenCalledWith(
      'docs.scan',
      scanJob(c.versionId),
      expect.objectContaining({ jobId: c.versionId }),
    );
  });

  it('keeps the bytes and the version quarantined when the scan cannot be queued, and the sweeper re-queues it (FU11)', async () => {
    const bytes = PDF(300);
    const c = await create({ sizeBytes: bytes.length });
    queue.add.mockRejectedValueOnce(new Error('valkey down'));
    const res = await put(c.uploadPath, bytes, 'application/pdf');
    // Received and kept, only the scan waits: accepted (202) with the quarantined version, not a failure.
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ id: c.versionId, status: 'quarantined' });
    // Old code deleted the file and reopened the version; the sha256 stays only with the bytes.
    const r = await row(c.versionId);
    expect(r.status).toBe('quarantined');
    expect(r.sha256?.toString('hex')).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(existsSync(storage.quarantinePath(r.storage_key))).toBe(true);

    const added: { name: string; data: unknown }[] = [];
    const sweepQueue = {
      getJobs: () => Promise.resolve([]),
      add: (name: string, data: unknown) => {
        added.push({ name, data });
        return Promise.resolve({});
      },
    };
    const sweeper = new ScanSweepProcessor(db, sweepQueue as unknown as Queue);
    await sweeper.sweep(new Date(Date.now() + 16 * 60_000));
    expect(added).toContainEqual({ name: 'docs.scan', data: scanJob(c.versionId) });
    expect(await processor.scanVersion(scanJob(c.versionId), true)).toBe('clean');
  });

  it('answers 413 for Content-Length 25 MiB + 1 byte, and keeps the version open for a valid upload', async () => {
    const c = await create();
    const res = await put(
      c.uploadPath,
      Buffer.alloc(MAX_UPLOAD_BYTES + 1, 0x20),
      'application/pdf',
    );
    expect(res.status).toBe(413);
    expect((await row(c.versionId)).status).toBe('awaiting_content');
  });

  it('answers 413 when the bytes counted while streaming pass the cap, and leaves no file', async () => {
    const c = await create({ sizeBytes: MAX_UPLOAD_BYTES });
    // Content-Length (the argument) is within the cap and equals the declared size, but the body has one byte too many.
    const liar = Readable.from(
      (function* () {
        yield PDF();
        yield Buffer.alloc(MAX_UPLOAD_BYTES - PDF().length + 1, 0x20);
      })(),
    );
    const failure = service.receiveContent(c.versionId, liar, MAX_UPLOAD_BYTES, {
      documentId: c.documentId,
      who: { scope: current.scope, actor: current.actor },
    });
    await expect(failure).rejects.toBeInstanceOf(PayloadTooLargeException);
    const r = await row(c.versionId);
    expect(r.status).toBe('rejected');
    expect(existsSync(storage.quarantinePath(r.storage_key))).toBe(false);
    expect(audit.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'document.rejected' }),
    );
  });

  it.each([
    [
      'the stream breaks',
      () =>
        Readable.from(
          (function* () {
            yield PDF().subarray(0, 10);
            throw new Error('connection reset');
          })(),
        ),
    ],
    ['the body is shorter than Content-Length', () => Readable.from([PDF().subarray(0, 10)])],
  ])(
    'keeps a version quarantined when %s: a second PUT is a 409 and the retry is a new version (EF3)',
    async (_name, body) => {
      const c = await create();
      await expect(
        service.receiveContent(c.versionId, body(), PDF().length, {
          documentId: c.documentId,
          who: { scope: current.scope, actor: current.actor },
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      const failed = await row(c.versionId);
      // Old code put it back to awaiting_content, so the next PUT reused the same version.
      expect(failed.status).toBe('quarantined');
      expect(failed.sha256).toBeNull();
      expect(failed.detected_mime).toBeNull();
      expect(existsSync(storage.quarantinePath(failed.storage_key))).toBe(false);

      const again = await put(c.uploadPath, PDF(), 'application/pdf');
      expect(again.status, JSON.stringify(again.body)).toBe(409);
      expect((await row(c.versionId)).status).toBe('quarantined');

      const next = await request(baseUrl).post(`/v1/documents/${c.documentId}/versions`).send({
        filename: 'invoice.pdf',
        declaredMime: 'application/pdf',
        sizeBytes: PDF().length,
      });
      expect(next.status, JSON.stringify(next.body)).toBe(201);
      const retry = next.body as Created;
      expect(retry.versionId).not.toBe(c.versionId);
      expect((await put(retry.uploadPath, PDF(), 'application/pdf')).status).toBe(200);
      expect((await row(retry.versionId)).status).toBe('quarantined');
      expect((await row(retry.versionId)).sha256).not.toBeNull();
    },
  );

  it('answers 411 when there is no Content-Length (chunked encoding)', async () => {
    const c = await create();
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request(
        `${baseUrl}${c.uploadPath}`,
        {
          method: 'PUT',
          headers: { 'Transfer-Encoding': 'chunked', 'Content-Type': 'application/pdf' },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on('error', reject);
      req.write(PDF());
      req.end();
    });
    expect(status).toBe(411);
    expect((await row(c.versionId)).status).toBe('awaiting_content');
  });

  it('answers 415 and marks the version rejected for a renamed .exe declared as PDF; the file is deleted', async () => {
    const bytes = EXE();
    const c = await create({ filename: 'report.pdf', sizeBytes: bytes.length });
    const res = await put(c.uploadPath, bytes, 'application/pdf');
    expect(res.status).toBe(415);
    expect(ErrorBodySchema.parse(res.body).error.code).toBe('unsupported_media_type');
    const r = await row(c.versionId);
    expect(r).toMatchObject({ status: 'rejected', detected_mime: 'application/x-msdownload' });
    expect(existsSync(storage.quarantinePath(r.storage_key))).toBe(false);
    expect(queue.add).not.toHaveBeenCalled();
    expect(audit.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'document.rejected', entityId: c.versionId }),
    );
  });

  it('accepts CSV by the plan rule and refuses CSV with NUL bytes', async () => {
    const good = Buffer.from('name,amount\nSita,1250\n');
    const c1 = await create({
      filename: 'a.csv',
      declaredMime: 'text/csv',
      sizeBytes: good.length,
    });
    expect((await put(c1.uploadPath, good, 'text/csv')).status).toBe(200);
    expect((await row(c1.versionId)).detected_mime).toBe('text/csv');

    const bad = Buffer.from('name,amount\nSi\u0000ta,1250\n');
    const c2 = await create({ filename: 'b.csv', declaredMime: 'text/csv', sizeBytes: bad.length });
    expect((await put(c2.uploadPath, bad, 'text/csv')).status).toBe(415);
  });

  it('answers 415 (not a silent empty file) when the file is sent as application/json', async () => {
    const c = await create({ sizeBytes: 2 });
    const res = await request(baseUrl)
      .put(c.uploadPath)
      .set('Content-Type', 'application/json')
      .send('{}');
    expect(res.status).toBe(415);
    expect((await row(c.versionId)).status).toBe('awaiting_content');
  });

  it('answers 400 when Content-Length differs from the declared size, 409 on a second upload', async () => {
    const c = await create({ sizeBytes: 999 });
    expect((await put(c.uploadPath, PDF(), 'application/pdf')).status).toBe(400);
    const ok = await create({ sizeBytes: PDF().length });
    expect((await put(ok.uploadPath, PDF(), 'application/pdf')).status).toBe(200);
    expect((await put(ok.uploadPath, PDF(), 'application/pdf')).status).toBe(409);
  });

  it('lets exactly one of two simultaneous uploads of the same version through', async () => {
    const c = await create();
    const results = await Promise.all([
      put(c.uploadPath, PDF(), 'application/pdf'),
      put(c.uploadPath, PDF(), 'application/pdf'),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(queue.add).toHaveBeenCalledTimes(1);
  });

  it('answers 404 for another document id, and 400 for a malformed id', async () => {
    const c = await create();
    const other = await create();
    expect(
      (
        await put(
          `/v1/documents/${other.documentId}/versions/${c.versionId}/content`,
          PDF(),
          'application/pdf',
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await put(
          `/v1/documents/not-a-uuid/versions/${c.versionId}/content`,
          PDF(),
          'application/pdf',
        )
      ).status,
    ).toBe(400);
  });
});

// -------------------------------------------------------------------------------------------- scan

describe('docs.scan (ScanProcessor with the fake clamd over TCP)', () => {
  it('clean: promotes the file, sets status clean and the current version, records document.scanned', async () => {
    const c = await cleanVersion();
    const r = await row(c.versionId);
    expect(r).toMatchObject({ status: 'clean', current_version_id: c.versionId });
    expect(existsSync(storage.quarantinePath(r.storage_key))).toBe(false);
    expect(existsSync(join(storageRoot, 'clean', r.storage_key))).toBe(true);
    expect(audit.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'document.scanned', entityId: c.versionId }),
    );
  });

  it('infected: EICAR is reported, the file is deleted, the uploader is notified, no link is possible', async () => {
    const bytes = eicarBytes(); // in memory only; plain ASCII, so it passes the CSV type check and reaches the scanner
    const ownerId = randomUUID();
    const c = await create({
      ownerId,
      filename: 'notes.csv',
      declaredMime: 'text/csv',
      sizeBytes: bytes.length,
    });
    expect((await put(c.uploadPath, bytes, 'text/csv')).status).toBe(200);
    expect(await processor.scanVersion(scanJob(c.versionId), true)).toBe('infected');
    const r = await row(c.versionId);
    expect(r).toMatchObject({ status: 'infected', scan_signature: 'Eicar-Test-Signature' });
    expect(existsSync(storage.quarantinePath(r.storage_key))).toBe(false);
    // The vars must be ones the real template accepts: /inbox (no trailing part) is not, and used to
    // make notifyUser throw, which rolled the whole infected transaction back.
    expect(notify.notifyUser).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        userId: USER,
        link: `/memos/${ownerId}`,
        email: {
          template: 'document.infected',
          vars: { filename: 'notes.csv', linkPath: `/memos/${ownerId}` },
        },
        dedupeKey: `document.infected:${c.versionId}`,
      }),
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'document.infected' }),
    );
    expect(
      (await request(baseUrl).post(`/v1/documents/${c.documentId}/versions/${c.versionId}/link`))
        .status,
    ).toBe(409);
  });

  it('infected: when the transaction fails the quarantined file stays, so the retry can still scan it', async () => {
    const bytes = eicarBytes();
    const c = await create({
      filename: 'retry.csv',
      declaredMime: 'text/csv',
      sizeBytes: bytes.length,
    });
    expect((await put(c.uploadPath, bytes, 'text/csv')).status).toBe(200);
    notify.notifyUser.mockRejectedValueOnce(new Error('notify is down'));

    await expect(processor.scanVersion(scanJob(c.versionId), false)).rejects.toThrow(
      'notify is down',
    );
    const failed = await row(c.versionId);
    expect(failed.status).toBe('quarantined'); // the infected status rolled back with the transaction
    expect(existsSync(storage.quarantinePath(failed.storage_key))).toBe(true);

    // The retry finds the file and finishes the job; only now is the file deleted.
    expect(await processor.scanVersion(scanJob(c.versionId), true)).toBe('infected');
    const done = await row(c.versionId);
    expect(done.status).toBe('infected');
    expect(existsSync(storage.quarantinePath(done.storage_key))).toBe(false);
  });

  it('timeout: a hung scanner means retry first, then scan_failed on the last attempt (file stays in quarantine)', async () => {
    const c = await create();
    await put(c.uploadPath, PDF(), 'application/pdf');
    expect(await hangingProcessor.scanVersion(scanJob(c.versionId), false)).toBe('retry');
    expect((await row(c.versionId)).status).toBe('quarantined');
    expect(await hangingProcessor.scanVersion(scanJob(c.versionId), true)).toBe('scan_failed');
    const r = await row(c.versionId);
    expect(r.status).toBe('scan_failed');
    expect(existsSync(storage.quarantinePath(r.storage_key))).toBe(true);
    expect(
      (await request(baseUrl).post(`/v1/documents/${c.documentId}/versions/${c.versionId}/link`))
        .status,
    ).toBe(409);
  });

  it('is idempotent: a duplicate job for a version that is no longer quarantined is skipped', async () => {
    const c = await cleanVersion();
    expect(await processor.scanVersion(scanJob(c.versionId), true)).toBe('skipped');
    expect((await row(c.versionId)).status).toBe('clean');
  });
});

// ------------------------------------------------------------------------------- links and download

describe('signed links and GET /v1/files/:token', () => {
  const download = (url: string) =>
    request(baseUrl)
      .get(url)
      .buffer(true)
      .parse((res, callback) => {
        const chunks: Buffer[] = [];
        res.on('data', (d: Buffer) => chunks.push(d));
        res.on('end', () => callback(null, Buffer.concat(chunks)));
      });
  const link = (c: Created) =>
    request(baseUrl).post(`/v1/documents/${c.documentId}/versions/${c.versionId}/link`);

  it('a clean file downloads once: attachment, nosniff, the detected type, the exact bytes; the second use is 401', async () => {
    const c = await cleanVersion();
    const issued = await link(c);
    expect(issued.status).toBe(200);
    const { url, expiresAt } = SignedLinkDtoSchema.parse(issued.body);
    expect(new Date(expiresAt).getTime() - Date.now()).toBeLessThanOrEqual(60_000);
    expect(authz.assert).toHaveBeenCalledWith('documents.read', expect.anything());

    const first = await download(url);
    expect(first.status).toBe(200);
    expect(first.headers['content-disposition']).toBe(
      `attachment; filename="invoice.pdf"; filename*=UTF-8''invoice.pdf`,
    );
    expect(first.headers['x-content-type-options']).toBe('nosniff');
    expect(first.headers['content-type']).toBe('application/pdf');
    expect((first.body as Buffer).equals(c.bytes)).toBe(true);

    const second = await download(url);
    expect(second.status).toBe(401);
  });

  it('refuses a link after 61 s and a tampered token', async () => {
    const c = await cleanVersion();
    const { url } = SignedLinkDtoSchema.parse((await link(c)).body);
    expect((await download(`${url.slice(0, -3)}AAA`)).status).toBe(401); // tampered signature
    now += 61_000; // the service's SignedLinks reads this clock
    expect((await download(url)).status).toBe(401);
  });

  it('issues no link for awaiting_content, quarantined or rejected versions (409), and 404 for an unknown one', async () => {
    const awaiting = await create();
    expect((await link(awaiting)).status).toBe(409);

    const quarantined = await create();
    await put(quarantined.uploadPath, PDF(), 'application/pdf');
    expect((await link(quarantined)).status).toBe(409);

    const bytes = EXE();
    const rejected = await create({ sizeBytes: bytes.length });
    await put(rejected.uploadPath, bytes, 'application/pdf');
    const res = await link(rejected);
    expect(res.status).toBe(409);
    expect(ErrorBodySchema.parse(res.body).error.code).toBe('conflict');

    const unknown = await request(baseUrl).post(
      `/v1/documents/${awaiting.documentId}/versions/${randomUUID()}/link`,
    );
    expect(unknown.status).toBe(404);
  });

  it('refuses to download if the version stops being clean after the link was issued (status is re-checked)', async () => {
    const quarantined = await create();
    await put(quarantined.uploadPath, PDF(), 'application/pdf');
    const links = new SignedLinks(SECRET, new MemoryStore(), () => now);
    // A correctly signed token for a version that is NOT clean: only the status gate can refuse it.
    const { token } = links.issue(quarantined.versionId);
    const other = new DocumentsService(db, storage, links, queue as unknown as Queue, authz, audit);
    await expect(other.openDownload(token)).rejects.toMatchObject({ status: 404 });
  });

  it('fails closed without DOCS_LINK_SECRET: no link is issued (503) and none is accepted (401)', async () => {
    const c = await cleanVersion();
    const { url } = SignedLinkDtoSchema.parse((await link(c)).body);
    const noSecret = new DocumentsService(
      db,
      storage,
      new SignedLinks(undefined, new MemoryStore()),
      queue as unknown as Queue,
      authz,
      audit,
    );
    noSecret.registerOwner({
      ownerType: 'test_memo',
      resource: (scope) =>
        Promise.resolve({ tenantId: scope.tenantId, organizationId: scope.organizationId }),
    });
    await expect(noSecret.issueLink(current.scope, c.versionId)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    await expect(noSecret.openDownload(url.replace('/v1/files/', ''))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });
});

// ------------------------------------------------------------------------------- reads and helpers

describe('get, listForOwner and allClean', () => {
  it('GET /v1/documents/:id returns the document with its versions', async () => {
    const c = await cleanVersion();
    const res = await request(baseUrl).get(`/v1/documents/${c.documentId}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: c.documentId, currentVersionId: c.versionId });
    expect(
      DocumentVersionDtoSchema.parse((res.body as { versions: unknown[] }).versions[0]).status,
    ).toBe('clean');
    expect(authz.assert).toHaveBeenCalledWith('documents.read', expect.anything());
    expect((await request(baseUrl).get(`/v1/documents/${randomUUID()}`)).status).toBe(404);
  });

  it('allClean: true only when every attachment is clean; a rejected upload does not block, a pending one does', async () => {
    const ownerId = randomUUID();
    const scope = current.scope;
    expect(await service.allClean(scope, 'test_memo', ownerId)).toBe(true); // no attachments

    const bytes = PDF(50);
    const a = await create({ ownerId, sizeBytes: bytes.length });
    await put(a.uploadPath, bytes, 'application/pdf');
    expect(await service.allClean(scope, 'test_memo', ownerId)).toBe(false); // quarantined
    expect(await processor.scanVersion(scanJob(a.versionId), true)).toBe('clean');
    expect(await service.allClean(scope, 'test_memo', ownerId)).toBe(true);

    const exe = EXE();
    const rejected = await create({ ownerId, sizeBytes: exe.length });
    await put(rejected.uploadPath, exe, 'application/pdf');
    expect(await service.allClean(scope, 'test_memo', ownerId)).toBe(true); // rejected never counted

    await create({ ownerId }); // awaiting_content
    expect(await service.allClean(scope, 'test_memo', ownerId)).toBe(false);
    expect((await service.listForOwner(scope, 'test_memo', ownerId)).length).toBe(3);
  });
});

// ------------------------------------------------------------------------- database-level guarantees

describe('the database protects a clean version', () => {
  const run = (statement: ReturnType<typeof sql>) =>
    withTx(db, current.scope, current.actor, (tx) => tx.execute(statement));

  it('blocks DELETE of a clean version (restrict_violation 23001)', async () => {
    const c = await cleanVersion();
    expect(
      await codeOf(run(sql`DELETE FROM app.document_versions WHERE id = ${c.versionId}`)),
    ).toBe('23001');
    expect((await row(c.versionId)).status).toBe('clean');
  });

  it('blocks changing a clean version (status, hash), so DELETE cannot be unlocked by an UPDATE first', async () => {
    const c = await cleanVersion();
    expect(
      await codeOf(
        run(sql`UPDATE app.document_versions SET status = 'rejected' WHERE id = ${c.versionId}`),
      ),
    ).toBe('23001');
    expect(
      await codeOf(
        run(
          sql`UPDATE app.document_versions SET sha256 = decode(repeat('00', 32), 'hex') WHERE id = ${c.versionId}`,
        ),
      ),
    ).toBe('23001');
  });

  it('still allows DELETE of a version that is not clean (the trigger is not a blanket block)', async () => {
    const bytes = EXE();
    const c = await create({ sizeBytes: bytes.length });
    await put(c.uploadPath, bytes, 'application/pdf'); // rejected
    await run(sql`DELETE FROM app.document_versions WHERE id = ${c.versionId}`);
    const { rowCount } = await pool.query('SELECT 1 FROM app.document_versions WHERE id = $1', [
      c.versionId,
    ]);
    expect(rowCount).toBe(0);
  });
});
