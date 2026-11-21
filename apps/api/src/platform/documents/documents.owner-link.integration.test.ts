// issueLinkForOwner (PA-doc): the customer portal serves the quotation PDF through a link issued for an owner
// the portal authorized itself, so the request principal's authz is never asked. Against real Postgres, the
// real storage on a temp dir, the real ScanProcessor with ClamdClient talking to the fake clamd, and real
// SignedLinks: only a clean newest version of a live document of exactly that owner, in exactly that tenant
// and entity, gets a link, every other case is the same 404, and the link redeems through openDownload.
// Generated PDFs are clean at once (D28); a quarantined one is made through the ordinary receive path.
// Fakes: authz (it must never be called here), audit, notify, the scan queue.
// Needs Docker. Run: pnpm --filter @bos/api exec vitest run src/platform/documents/documents.owner-link.integration.test.ts
import 'reflect-metadata';

import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { createTenantWithEntity } from '@bos/db';
import { NotFoundException, UnauthorizedException } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Db } from '../db/db.module';
import { systemActor, withTx, type Actor, type TxScope } from '../db/tx';
import { ClamdClient } from './clamd.client';
import { DocumentsService, type GeneratedFile } from './documents.service';
import { startFakeClamd, type FakeClamd } from './fake-clamd';
import { ScanProcessor } from './scan.processor';
import { SignedLinks, type LinkStore } from './signed-link';
import { DiskStorageAdapter } from './storage.adapter';
import { createTestDatabase, type TestDatabase } from '@bos/db/testing';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 180_000 });

const SECRET = 'an-integration-test-secret-of-32-plus-chars';
const JOB = 'quotation.pdf';
const OWNER_TYPE = 'quotation_version';
const OTHER_OWNER_TYPE = 'test_memo';

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

  storageRoot = await mkdtemp(join(tmpdir(), 'bos-docs-owner-link-'));
  storage = new DiskStorageAdapter(storageRoot);
  service = new DocumentsService(
    db,
    storage,
    new SignedLinks(SECRET, new MemoryStore(), () => Date.now()),
    queue as unknown as Queue,
    authz,
    audit,
  );
  // Both owners exist in every scope and let the system actor attach: the test is about the link, not them.
  for (const ownerType of [OWNER_TYPE, OTHER_OWNER_TYPE]) {
    service.registerOwner({
      ownerType,
      resource: (s) => Promise.resolve({ tenantId: s.tenantId, organizationId: s.organizationId }),
      allowsSystemActor: () => Promise.resolve(true),
    });
  }

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

const userActor = (): Actor => ({
  kind: 'user',
  id: randomUUID(),
  correlationId: 'test-correlation',
});

/**
 * A rendered PDF the way the render job makes it: created and received, clean at once (D28: generated bytes skip
 * the scan). `scan: false` leaves it quarantined instead, awaiting a scan, as an upload would be.
 */
async function rendered(ownerId: string, opts: { ownerType?: string; scan?: boolean } = {}) {
  const file = pdf();
  const who = { scope, actor: systemActor(JOB) };
  const created = await withTx(db, who.scope, who.actor, (tx) =>
    service.createGenerated(tx, { ownerType: opts.ownerType ?? OWNER_TYPE, ownerId }, file),
  );
  if (opts.scan === false) {
    // The ordinary receive path (it always queues a scan), so the file sits in quarantine until a scan runs.
    await service.receiveContent(created.versionId, Readable.from(file.bytes), file.bytes.length, {
      documentId: created.documentId,
      who,
    });
  } else {
    await service.receiveGenerated(created, file, who);
  }
  return { ...created, file };
}

const tokenOf = (url: string): string => url.replace(/^\/v1\/files\//, '');

async function readAll(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

/** Every refusal must be this exact 404, so the portal can never tell "missing" from "not yours". */
async function expectSame404(call: Promise<unknown>): Promise<void> {
  const error: unknown = await call.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(NotFoundException);
  expect((error as NotFoundException).getResponse()).toEqual(
    new NotFoundException('File not found').getResponse(),
  );
}

// ------------------------------------------------------------------------------------------- tests

describe('issueLinkForOwner', () => {
  it('issues a link for a clean newest version, without the principal authz, and it redeems once', async () => {
    const ownerId = randomUUID();
    const doc = await rendered(ownerId);

    const link = await service.issueLinkForOwner(
      scope,
      { ownerType: OWNER_TYPE, ownerId },
      doc.documentId,
    );

    expect(link.url).toMatch(/^\/v1\/files\/.+/);
    expect(Date.parse(link.expiresAt)).toBeGreaterThan(Date.now());
    expect(authz.assert).not.toHaveBeenCalled();

    // The existing public redeem path opens exactly the file that was rendered.
    const download = await service.openDownload(tokenOf(link.url));
    expect(download.filename).toBe('Q-2026-0001.pdf');
    expect(download.mime).toBe('application/pdf');
    expect(await readAll(download.stream)).toEqual(doc.file.bytes);
    // Single use, like any other link.
    await expect(service.openDownload(tokenOf(link.url))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('is a 404 while the only version is quarantined', async () => {
    const ownerId = randomUUID();
    const doc = await rendered(ownerId, { scan: false });

    await expectSame404(
      service.issueLinkForOwner(scope, { ownerType: OWNER_TYPE, ownerId }, doc.documentId),
    );

    // Once the scan clears it, the same call links.
    expect(await processor.scanVersion({ versionId: doc.versionId, ...scope }, true)).toBe('clean');
    const link = await service.issueLinkForOwner(
      scope,
      { ownerType: OWNER_TYPE, ownerId },
      doc.documentId,
    );
    expect(link.url).toMatch(/^\/v1\/files\/.+/);
  });

  it('is a 404 when a newer version is not clean, even though an older one is', async () => {
    const ownerId = randomUUID();
    const doc = await rendered(ownerId);
    await withTx(db, scope, userActor(), (tx) =>
      service.createVersion(tx, doc.documentId, {
        filename: 'Q-2026-0001-r2.pdf',
        declaredMime: 'application/pdf',
        sizeBytes: 100,
      }),
    );

    await expectSame404(
      service.issueLinkForOwner(scope, { ownerType: OWNER_TYPE, ownerId }, doc.documentId),
    );
  });

  it('is a 404 for a document of another owner id or another owner type', async () => {
    const ownerId = randomUUID();
    const doc = await rendered(ownerId);
    const memo = await rendered(ownerId, { ownerType: OTHER_OWNER_TYPE });

    await expectSame404(
      service.issueLinkForOwner(
        scope,
        { ownerType: OWNER_TYPE, ownerId: randomUUID() },
        doc.documentId,
      ),
    );
    // Same owner id, but the document hangs off a different kind of record.
    await expectSame404(
      service.issueLinkForOwner(scope, { ownerType: OWNER_TYPE, ownerId }, memo.documentId),
    );
  });

  it('is a 404 from another entity of the same tenant and from another tenant', async () => {
    const ownerId = randomUUID();
    const doc = await rendered(ownerId);
    const other = await createTenantWithEntity(pool);

    // Same tenant, another entity: only the organization filter can refuse this one.
    await expectSame404(
      service.issueLinkForOwner(
        { tenantId: scope.tenantId, organizationId: randomUUID() },
        { ownerType: OWNER_TYPE, ownerId },
        doc.documentId,
      ),
    );
    await expectSame404(
      service.issueLinkForOwner(
        { tenantId: other.tenantId, organizationId: other.organizationId },
        { ownerType: OWNER_TYPE, ownerId },
        doc.documentId,
      ),
    );
  });

  it('is a 404 for a removed document and for an unknown document id', async () => {
    const ownerId = randomUUID();
    const doc = await rendered(ownerId);
    await service.remove(doc.documentId, { who: { scope, actor: userActor() } });

    await expectSame404(
      service.issueLinkForOwner(scope, { ownerType: OWNER_TYPE, ownerId }, doc.documentId),
    );
    await expectSame404(
      service.issueLinkForOwner(scope, { ownerType: OWNER_TYPE, ownerId }, randomUUID()),
    );
  });
});
