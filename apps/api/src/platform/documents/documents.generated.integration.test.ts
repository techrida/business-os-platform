// Generated documents (kernel gap M14, decision D28): a job writes a file under the system actor and it goes
// through the same quarantine, type check and sha256 as an upload, then SKIPS the virus scan: it is promoted
// and marked clean at once (scan_engine 'generated'). Uploads keep the scan. Against real Postgres, the real
// storage on a temp dir and ClamdClient talking to the fake clamd over TCP, with the real ScanProcessor.
// Fakes: authz (it must never be called on the generated path), audit, notify, the scan queue.
// Needs Docker. Run: pnpm --filter @bos/api exec vitest run src/platform/documents/documents.generated.integration.test.ts
import 'reflect-metadata';

import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { createTenantWithEntity } from '@bos/db';
import { ConflictException, ForbiddenException } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Db } from '../db/db.module';
import { systemActor, withTx, type TxScope } from '../db/tx';
import { ClamdClient } from './clamd.client';
import { DocumentsService, type GeneratedFile } from './documents.service';
import { FAKE_CLAMD_VERSION, eicarBytes, startFakeClamd, type FakeClamd } from './fake-clamd';
import { DOCS_SCAN_JOB } from './documents.ports';
import { ScanProcessor } from './scan.processor';
import { SignedLinks, type LinkStore } from './signed-link';
import { DiskStorageAdapter } from './storage.adapter';
import { createTestDatabase, type TestDatabase } from '@bos/db/testing';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 180_000 });

const SECRET = 'an-integration-test-secret-of-32-plus-chars';
const JOB = 'quotation.pdf';

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
let storageRoot: string;
let storage: DiskStorageAdapter;
let service: DocumentsService;
let processor: ScanProcessor;
let fakeClamd: FakeClamd;
let scope: TxScope;

const authz = { assert: vi.fn() };
const audit = { record: vi.fn().mockResolvedValue(undefined) };
const notify = { notifyUser: vi.fn().mockResolvedValue(undefined) };
const queue = { add: vi.fn().mockResolvedValue({}) };

// The quotation owner: it lets the system actor attach unless `systemAllowed` is false.
let systemAllowed = true;
const allowsSystemActor = vi.fn(
  (_scope: TxScope, _ownerId: string, _actor: unknown, _tx?: unknown) =>
    Promise.resolve(systemAllowed),
);

/** A service over the given storage, with the quotation owner registered (the tests share one database). */
function makeService(adapter: DiskStorageAdapter): DocumentsService {
  const svc = new DocumentsService(
    db,
    adapter,
    new SignedLinks(SECRET, new MemoryStore(), () => Date.now()),
    queue as unknown as Queue,
    authz,
    audit,
  );
  svc.registerOwner({
    ownerType: 'quotation',
    resource: (s) => Promise.resolve({ tenantId: s.tenantId, organizationId: s.organizationId }),
    allowsSystemActor,
  });
  return svc;
}

beforeAll(async () => {
  testDb = await createTestDatabase();
  const admin = new Pool({ connectionString: testDb.adminUrl, max: 1 });
  await admin.end();
  const bosAdmin = new Pool({ connectionString: testDb.adminUrl, max: 1 });
  await bosAdmin.end();

  pool = new Pool({ connectionString: testDb.appUrl, max: 8 });
  db = drizzle({ client: pool });
  const { tenantId, organizationId } = await createTenantWithEntity(pool);
  scope = { tenantId, organizationId };

  storageRoot = await mkdtemp(join(tmpdir(), 'bos-docs-generated-'));
  storage = new DiskStorageAdapter(storageRoot);
  service = makeService(storage);

  fakeClamd = await startFakeClamd();
  processor = new ScanProcessor(
    db,
    storage,
    new ClamdClient({ host: fakeClamd.host, port: fakeClamd.port, timeoutMs: 5_000 }),
    audit,
    notify,
  );
});

afterAll(async () => {
  await fakeClamd?.close();
  await pool?.end();
  await testDb?.drop();
  if (storageRoot) await rm(storageRoot, { recursive: true, force: true });
});

beforeEach(() => {
  systemAllowed = true;
  allowsSystemActor.mockClear();
  authz.assert.mockReset();
  audit.record.mockClear();
  notify.notifyUser.mockClear();
  queue.add.mockReset().mockResolvedValue({});
});

// ---------------------------------------------------------------------------------------- helpers

const pdf = (): GeneratedFile => ({
  filename: 'Q-2026-0001.pdf',
  declaredMime: 'application/pdf',
  bytes: Buffer.concat([
    Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF\n'),
    Buffer.alloc(200, 0x20),
  ]),
});

const actor = () => systemActor(JOB);

/** What a job does: create the row in its own transaction, commit, then hand over the bytes. */
async function generate(ownerId: string, file: GeneratedFile) {
  const who = { scope, actor: actor() };
  const created = await withTx(db, who.scope, who.actor, (tx) =>
    service.createGenerated(tx, { ownerType: 'quotation', ownerId }, file),
  );
  return { created, who };
}

async function versionRow(versionId: string) {
  const { rows } = await pool.query<{
    status: string;
    storage_key: string;
    sha256: Buffer | null;
    detected_mime: string | null;
    uploaded_by: string | null;
    current_version_id: string | null;
    created_by: string | null;
    scan_engine: string | null;
    scan_signature: string | null;
    scanned_at: Date | null;
  }>(
    `SELECT v.status, v.storage_key, v.sha256, v.detected_mime, v.uploaded_by,
            v.scan_engine, v.scan_signature, v.scanned_at,
            d.current_version_id, d.created_by
       FROM app.document_versions v JOIN app.documents d ON d.id = v.document_id WHERE v.id = $1`,
    [versionId],
  );
  const r = rows[0];
  if (r === undefined) throw new Error('no such version');
  return r;
}

const documentCount = async (ownerId: string): Promise<number> => {
  const { rows } = await pool.query<{ n: string }>(
    'SELECT count(*)::text AS n FROM app.documents WHERE owner_id = $1',
    [ownerId],
  );
  return Number(rows[0]?.n);
};

interface AuditEvent {
  action: string;
  entityId: string;
  meta?: Record<string, unknown>;
}

/** The `document.scanned` events recorded so far in this test. */
const scannedEvents = (): AuditEvent[] =>
  (audit.record.mock.calls as unknown as [unknown, AuditEvent][])
    .map(([, event]) => event)
    .filter((event) => event.action === 'document.scanned');

const scanJob = (versionId: string) => ({
  versionId,
  tenantId: scope.tenantId,
  organizationId: scope.organizationId,
});

// ------------------------------------------------------------------------------------------- tests

describe('generated documents', () => {
  it('ends clean with no scan job and no clamd call, and is linkable at once (D28)', async () => {
    const ownerId = randomUUID();
    const file = pdf();
    const { created, who } = await generate(ownerId, file);
    expect((await versionRow(created.versionId)).status).toBe('awaiting_content');
    const scansBefore = fakeClamd.scans.length;

    const received = await service.receiveGenerated(created, file, who);
    const expectedSha = createHash('sha256').update(file.bytes).digest('hex');
    expect(received.status).toBe('clean');
    expect(received.sha256).toBe(expectedSha);
    expect(received.detectedMime).toBe('application/pdf');
    expect(received.scanSignature).toBeNull();
    expect(received.scannedAt).not.toBeNull();

    // No scan job, and the scanner was never contacted.
    expect(queue.add).not.toHaveBeenCalled();
    expect(fakeClamd.scans).toHaveLength(scansBefore);
    // The request principal's authz was never consulted (issueLink below is a read, which does ask it).
    expect(authz.assert).not.toHaveBeenCalled();

    const r = await versionRow(created.versionId);
    expect(r.status).toBe('clean');
    expect(r.scan_engine).toBe('generated');
    expect(r.scan_signature).toBeNull();
    expect(r.scanned_at).toBeInstanceOf(Date);
    expect(r.sha256?.toString('hex')).toBe(expectedSha);
    expect(r.current_version_id).toBe(created.versionId);
    // No user is behind a generated file: the audit trail names the job, the columns stay null.
    expect(r.uploaded_by).toBeNull();
    expect(r.created_by).toBeNull();
    expect(existsSync(storage.quarantinePath(r.storage_key))).toBe(false);

    // One audit event, with the generated label and the stored hash.
    const scanned = scannedEvents();
    expect(scanned).toHaveLength(1);
    expect(scanned[0]).toMatchObject({
      entityType: 'document_version',
      entityId: created.versionId,
      meta: { result: 'generated', engine: 'generated', sha256: expectedSha },
    });

    // Downloadable, and the bytes that come back are the rendered ones.
    const link = await service.issueLink(scope, created.versionId);
    expect(link.url).toMatch(/^\/v1\/files\//);
    const download = await service.openDownload(link.url.replace(/^\/v1\/files\//, ''));
    const chunks: Buffer[] = [];
    for await (const chunk of download.stream) chunks.push(chunk as Buffer);
    expect(Buffer.concat(chunks)).toEqual(file.bytes);
    // The owner policy was asked for the system actor at create and again at receive.
    expect(allowsSystemActor).toHaveBeenCalledTimes(2);
    expect(allowsSystemActor).toHaveBeenCalledWith(
      scope,
      ownerId,
      { kind: 'system', id: `system:${JOB}` },
      expect.anything(),
    );

    // A repeat is refused and writes nothing more: the status moved on, so there is no second audit.
    await expect(service.receiveGenerated(created, file, who)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(scannedEvents()).toHaveLength(1);
  });

  it('a generated file of the wrong type is still rejected by the type check, not promoted', async () => {
    const file: GeneratedFile = {
      filename: 'fake.pdf',
      declaredMime: 'application/pdf',
      bytes: Buffer.from('MZ this is not a pdf at all, just some padding bytes'),
    };
    const { created, who } = await generate(randomUUID(), file);

    await expect(service.receiveGenerated(created, file, who)).rejects.toMatchObject({
      status: 415,
    });
    const r = await versionRow(created.versionId);
    expect(r.status).toBe('rejected');
    expect(r.current_version_id).toBeNull();
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('a generated file whose write fails goes back to awaiting_content, never left quarantined without bytes (EF3)', async () => {
    const file = pdf();
    const { created, who } = await generate(randomUUID(), file);
    vi.spyOn(storage, 'writeQuarantine').mockRejectedValueOnce(new Error('EIO'));

    await expect(service.receiveGenerated(created, file, who)).rejects.toMatchObject({
      status: 400,
    });
    const r = await versionRow(created.versionId);
    // Left `quarantined` with no sha256 it would count as a filled version for good, and the render job could never
    // discard the document and render again.
    expect(r.status).toBe('awaiting_content');
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('an upload still queues a scan and ends clean through clamd, never as generated', async () => {
    const ownerId = randomUUID();
    const bytes = pdf().bytes;
    const user = { kind: 'user' as const, id: randomUUID(), correlationId: 'test-correlation' };
    const created = await withTx(db, scope, user, (tx) =>
      service.create(tx, {
        ownerType: 'quotation',
        ownerId,
        filename: 'upload.pdf',
        declaredMime: 'application/pdf',
        sizeBytes: bytes.length,
      }),
    );
    const scansBefore = fakeClamd.scans.length;

    const received = await service.receiveContent(
      created.versionId,
      Readable.from(bytes),
      bytes.length,
      { documentId: created.documentId, who: { scope, actor: user } },
    );
    expect(received.status).toBe('quarantined');
    expect(queue.add).toHaveBeenCalledWith(
      DOCS_SCAN_JOB,
      scanJob(created.versionId),
      expect.objectContaining({ jobId: created.versionId }),
    );
    expect(fakeClamd.scans).toHaveLength(scansBefore);

    expect(await processor.scanVersion(scanJob(created.versionId), true)).toBe('clean');
    const r = await versionRow(created.versionId);
    expect(r.status).toBe('clean');
    expect(r.scan_engine).not.toBe('generated');
    expect(r.scan_engine).toBe(FAKE_CLAMD_VERSION);
    expect(fakeClamd.scans).toHaveLength(scansBefore + 1);
    expect(audit.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'document.scanned',
        meta: expect.objectContaining({ result: 'clean' }) as unknown,
      }),
    );
  });

  it('an infected upload is still caught; only the system-rendered path skips the scan', async () => {
    const bytes = eicarBytes();
    const user = { kind: 'user' as const, id: randomUUID(), correlationId: 'test-correlation' };
    const created = await withTx(db, scope, user, (tx) =>
      service.create(tx, {
        ownerType: 'quotation',
        ownerId: randomUUID(),
        filename: 'notes.csv',
        declaredMime: 'text/csv',
        sizeBytes: bytes.length,
      }),
    );
    await service.receiveContent(created.versionId, Readable.from(bytes), bytes.length, {
      documentId: created.documentId,
      who: { scope, actor: user },
    });

    expect(await processor.scanVersion(scanJob(created.versionId), true)).toBe('infected');
    expect((await versionRow(created.versionId)).status).toBe('infected');
    await expect(service.issueLink(scope, created.versionId)).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('receiveContent, the HTTP-facing method, never skips the scan, even under a system actor', async () => {
    const file = pdf();
    const { created, who } = await generate(randomUUID(), file);

    const received = await service.receiveContent(
      created.versionId,
      Readable.from(file.bytes),
      file.bytes.length,
      { documentId: created.documentId, who },
    );

    expect(received.status).toBe('quarantined');
    expect(queue.add).toHaveBeenCalledWith(
      DOCS_SCAN_JOB,
      scanJob(created.versionId),
      expect.objectContaining({ jobId: created.versionId }),
    );
    const r = await versionRow(created.versionId);
    expect(r.status).toBe('quarantined');
    expect(r.scan_engine).toBeNull();
  });

  it('a user actor cannot call receiveGenerated: 403, nothing received, no scan skipped', async () => {
    const file = pdf();
    const { created } = await generate(randomUUID(), file);
    const user = { kind: 'user' as const, id: randomUUID(), correlationId: 'test-correlation' };

    await expect(
      service.receiveGenerated(created, file, { scope, actor: user }),
    ).rejects.toBeInstanceOf(ForbiddenException);

    const r = await versionRow(created.versionId);
    expect(r.status).toBe('awaiting_content');
    expect(r.sha256).toBeNull();
    expect(r.scan_engine).toBeNull();
    expect(existsSync(storage.quarantinePath(r.storage_key))).toBe(false);
    expect(queue.add).not.toHaveBeenCalled();
  });

  /** The `document.rejected` events recorded so far in this test. */
  const rejectedEvents = (): AuditEvent[] =>
    (audit.record.mock.calls as unknown as [unknown, AuditEvent][])
      .map(([, event]) => event)
      .filter((event) => event.action === 'document.rejected');
  const cleanPath = (key: string) => join(storageRoot, 'clean', key);

  it('a failed promote refuses the version and deletes its bytes, with no scan queued, so the render tries again', async () => {
    const failing = Object.create(storage) as DiskStorageAdapter;
    failing.promote = () => Promise.reject(new Error('disk is away'));
    const flaky = makeService(failing);
    const file = pdf();
    const { created, who } = await generate(randomUUID(), file);

    await expect(flaky.receiveGenerated(created, file, who)).rejects.toThrow('disk is away');

    const r = await versionRow(created.versionId);
    expect(r.status).toBe('rejected');
    expect(r.current_version_id).toBeNull();
    expect(existsSync(storage.quarantinePath(r.storage_key))).toBe(false);
    expect(existsSync(cleanPath(r.storage_key))).toBe(false);
    expect(queue.add).not.toHaveBeenCalled();
    expect(scannedEvents()).toHaveLength(0);
    expect(rejectedEvents()).toHaveLength(1);
    expect(rejectedEvents()[0]).toMatchObject({
      entityId: created.versionId,
      meta: { reason: 'generated_unfinished' },
    });
  });

  it('promote succeeds but the clean mark fails: the version is refused and its clean copy deleted, no scan queued', async () => {
    const file = pdf();
    const { created, who } = await generate(randomUUID(), file);
    // The clean mark (its audit write) fails once: the transaction rolls back after the promote moved the bytes.
    audit.record.mockRejectedValueOnce(new Error('database blip'));

    await expect(service.receiveGenerated(created, file, who)).rejects.toThrow('database blip');

    const r = await versionRow(created.versionId);
    expect(r.status).toBe('rejected');
    expect(r.current_version_id).toBeNull();
    expect(existsSync(storage.quarantinePath(r.storage_key))).toBe(false);
    expect(existsSync(cleanPath(r.storage_key))).toBe(false);
    expect(queue.add).not.toHaveBeenCalled();
    expect(rejectedEvents()).toHaveLength(1);
  });

  it('when the refusal cannot be written either, it stays quarantined and the fallback scan finishes it, audited once', async () => {
    const failing = Object.create(storage) as DiskStorageAdapter;
    failing.promote = () => Promise.reject(new Error('disk is away'));
    const flaky = makeService(failing);
    const file = pdf();
    const { created, who } = await generate(randomUUID(), file);
    // The refusal's audit write fails too: the database is away for both.
    audit.record.mockRejectedValueOnce(new Error('database away'));

    await expect(flaky.receiveGenerated(created, file, who)).rejects.toThrow('disk is away');

    const mid = await versionRow(created.versionId);
    expect(mid.status).toBe('quarantined');
    expect(mid.scan_engine).toBeNull();
    expect(existsSync(storage.quarantinePath(mid.storage_key))).toBe(true);
    // The fallback: the scan was queued, so the file is not stuck until the sweeper finds it.
    expect(queue.add).toHaveBeenCalledWith(
      DOCS_SCAN_JOB,
      scanJob(created.versionId),
      expect.objectContaining({ jobId: created.versionId }),
    );

    expect(await processor.scanVersion(scanJob(created.versionId), true)).toBe('clean');
    const r = await versionRow(created.versionId);
    expect(r.status).toBe('clean');
    expect(r.scan_engine).toBe(FAKE_CLAMD_VERSION);
    expect(r.current_version_id).toBe(created.versionId);
    expect(scannedEvents()).toHaveLength(1);
  });

  it('promote succeeds, then the clean mark and the refusal both fail: the fallback scan finishes it as generated', async () => {
    const file = pdf();
    const { created, who } = await generate(randomUUID(), file);
    audit.record
      .mockRejectedValueOnce(new Error('database blip'))
      .mockRejectedValueOnce(new Error('database blip'));

    await expect(service.receiveGenerated(created, file, who)).rejects.toThrow('database blip');

    const mid = await versionRow(created.versionId);
    expect(mid.status).toBe('quarantined');
    // The promote had already happened: the quarantine copy is gone, so the scan job has nothing to scan.
    expect(existsSync(storage.quarantinePath(mid.storage_key))).toBe(false);
    expect(queue.add).toHaveBeenCalledWith(
      DOCS_SCAN_JOB,
      scanJob(created.versionId),
      expect.objectContaining({ jobId: created.versionId }),
    );
    const scansBefore = fakeClamd.scans.length;

    expect(await processor.scanVersion(scanJob(created.versionId), true)).toBe('clean');

    const r = await versionRow(created.versionId);
    expect(r.status).toBe('clean');
    expect(r.scan_engine).toBe('generated');
    expect(fakeClamd.scans).toHaveLength(scansBefore);
    // The rolled-back attempts wrote no audit row; the finishing run wrote one, labelled generated.
    const committed = scannedEvents().slice(1);
    expect(committed).toHaveLength(1);
    expect(committed[0]).toMatchObject({ meta: { result: 'generated', engine: 'generated' } });
  });

  it('an owner policy that refuses the system actor gives no document row', async () => {
    systemAllowed = false;
    const ownerId = randomUUID();
    const file = pdf();

    await expect(
      withTx(db, scope, actor(), (tx) =>
        service.createGenerated(tx, { ownerType: 'quotation', ownerId }, file),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(allowsSystemActor).toHaveBeenCalledTimes(1);
    expect(await documentCount(ownerId)).toBe(0);
    const { rows } = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM app.document_versions v
         JOIN app.documents d ON d.id = v.document_id WHERE d.owner_id = $1`,
      [ownerId],
    );
    expect(Number(rows[0]?.n)).toBe(0);
    expect(authz.assert).not.toHaveBeenCalled();
  });

  it('a policy that withdraws between create and receive gets no bytes on disk and no scan job', async () => {
    const file = pdf();
    const { created, who } = await generate(randomUUID(), file);

    systemAllowed = false;
    await expect(service.receiveGenerated(created, file, who)).rejects.toBeInstanceOf(
      ForbiddenException,
    );

    const r = await versionRow(created.versionId);
    expect(r.status).toBe('awaiting_content');
    expect(r.sha256).toBeNull();
    expect(existsSync(storage.quarantinePath(r.storage_key))).toBe(false);
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('a user transaction cannot use the generated path to skip authz: no row is written', async () => {
    const ownerId = randomUUID();
    const userActor = {
      kind: 'user' as const,
      id: randomUUID(),
      correlationId: 'test-correlation',
    };

    await expect(
      withTx(db, scope, userActor, (tx) =>
        service.createGenerated(tx, { ownerType: 'quotation', ownerId }, pdf()),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(await documentCount(ownerId)).toBe(0);
    expect(allowsSystemActor).not.toHaveBeenCalled();
  });
});
