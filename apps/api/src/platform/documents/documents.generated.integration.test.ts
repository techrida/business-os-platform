// Generated documents (kernel gap M14): a job writes a file under the system actor and it goes through the
// same quarantine, type check, sha256 and virus scan as an upload. Against real Postgres, the real storage on
// a temp dir and ClamdClient talking to the fake clamd over TCP, with the real ScanProcessor. Fakes: authz
// (it must never be called on this path), audit, notify, the scan queue.
// Needs Docker. Run: pnpm --filter @bos/api exec vitest run src/platform/documents/documents.generated.integration.test.ts
import 'reflect-metadata';

import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createTenantWithEntity, runMigrations } from '@bos/db';
import { ConflictException, ForbiddenException } from '@nestjs/common';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { Queue } from 'bullmq';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Db } from '../db/db.module';
import { systemActor, withTx, type TxScope } from '../db/tx';
import { ClamdClient } from './clamd.client';
import { DocumentsService, type GeneratedFile } from './documents.service';
import { eicarBytes, startFakeClamd, type FakeClamd } from './fake-clamd';
import { DOCS_SCAN_JOB } from './documents.ports';
import { ScanProcessor } from './scan.processor';
import { SignedLinks, type LinkStore } from './signed-link';
import { DiskStorageAdapter } from './storage.adapter';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 180_000 });

const OWNER_PW = 'owner-test-pw';
const APP_PW = 'app-test-pw';
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

let container: StartedPostgreSqlContainer;
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

const urlFor = (user: string, password: string, database: string) => {
  const url = new URL(container.getConnectionUri());
  url.username = user;
  url.password = password;
  url.pathname = `/${database}`;
  return url.toString();
};

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  const admin = new Pool({ connectionString: container.getConnectionUri(), max: 1 });
  await admin.query(`CREATE ROLE bos_owner LOGIN PASSWORD '${OWNER_PW}'`);
  await admin.query(`CREATE ROLE bos_app LOGIN PASSWORD '${APP_PW}'`);
  await admin.query('CREATE DATABASE bos OWNER bos_owner');
  await admin.query('REVOKE ALL ON DATABASE bos FROM PUBLIC');
  await admin.query('GRANT CONNECT ON DATABASE bos TO bos_app');
  await admin.end();
  const bosAdmin = new Pool({ connectionString: urlFor('test', 'test', 'bos'), max: 1 });
  await bosAdmin.query(
    'ALTER DEFAULT PRIVILEGES FOR ROLE bos_owner GRANT USAGE ON SCHEMAS TO bos_app',
  );
  await bosAdmin.query(
    'ALTER DEFAULT PRIVILEGES FOR ROLE bos_owner GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO bos_app',
  );
  await bosAdmin.end();
  await runMigrations(urlFor('bos_owner', OWNER_PW, 'bos'));

  pool = new Pool({ connectionString: urlFor('bos_app', APP_PW, 'bos'), max: 8 });
  db = drizzle({ client: pool });
  const { tenantId, organizationId } = await createTenantWithEntity(pool);
  scope = { tenantId, organizationId };

  storageRoot = await mkdtemp(join(tmpdir(), 'bos-docs-generated-'));
  storage = new DiskStorageAdapter(storageRoot);
  service = new DocumentsService(
    db,
    storage,
    new SignedLinks(SECRET, new MemoryStore(), () => Date.now()),
    queue as unknown as Queue,
    authz,
    audit,
  );
  service.registerOwner({
    ownerType: 'quotation',
    resource: (s) => Promise.resolve({ tenantId: s.tenantId, organizationId: s.organizationId }),
    allowsSystemActor,
  });

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
  await container?.stop();
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
  }>(
    `SELECT v.status, v.storage_key, v.sha256, v.detected_mime, v.uploaded_by,
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

const scanJob = (versionId: string) => ({
  versionId,
  tenantId: scope.tenantId,
  organizationId: scope.organizationId,
});

// ------------------------------------------------------------------------------------------- tests

describe('generated documents', () => {
  it('reaches clean through the scan pipeline with its sha256 stored, and is not downloadable before', async () => {
    const ownerId = randomUUID();
    const file = pdf();
    const { created, who } = await generate(ownerId, file);
    expect((await versionRow(created.versionId)).status).toBe('awaiting_content');

    const received = await service.receiveGenerated(created, file, who);
    expect(received.status).toBe('quarantined');
    const expectedSha = createHash('sha256').update(file.bytes).digest('hex');
    expect(received.sha256).toBe(expectedSha);
    expect(received.detectedMime).toBe('application/pdf');
    // The same scan job an upload queues: one job per version.
    expect(queue.add).toHaveBeenCalledWith(
      DOCS_SCAN_JOB,
      scanJob(created.versionId),
      expect.objectContaining({ jobId: created.versionId }),
    );

    // The request principal's authz was never consulted (issueLink below is a read, which does ask it).
    expect(authz.assert).not.toHaveBeenCalled();

    // Not downloadable while it is only quarantined.
    await expect(service.issueLink(scope, created.versionId)).rejects.toBeInstanceOf(
      ConflictException,
    );

    expect(await processor.scanVersion(scanJob(created.versionId), true)).toBe('clean');
    const r = await versionRow(created.versionId);
    expect(r.status).toBe('clean');
    expect(r.sha256?.toString('hex')).toBe(expectedSha);
    expect(r.current_version_id).toBe(created.versionId);
    // No user is behind a generated file: the audit trail names the job, the columns stay null.
    expect(r.uploaded_by).toBeNull();
    expect(r.created_by).toBeNull();
    expect(existsSync(storage.quarantinePath(r.storage_key))).toBe(false);

    const link = await service.issueLink(scope, created.versionId);
    expect(link.url).toMatch(/^\/v1\/files\//);
    // The owner policy was asked for the system actor at create and again at receive.
    expect(allowsSystemActor).toHaveBeenCalledTimes(2);
    expect(allowsSystemActor).toHaveBeenCalledWith(
      scope,
      ownerId,
      { kind: 'system', id: `system:${JOB}` },
      expect.anything(),
    );
  });

  it('an infected generated file is reported, never becomes downloadable and notifies nobody', async () => {
    const bytes = eicarBytes();
    const file: GeneratedFile = {
      filename: 'notes.csv',
      declaredMime: 'text/csv',
      bytes,
    };
    const { created, who } = await generate(randomUUID(), file);
    await service.receiveGenerated(created, file, who);

    expect(await processor.scanVersion(scanJob(created.versionId), true)).toBe('infected');
    expect((await versionRow(created.versionId)).status).toBe('infected');
    await expect(service.issueLink(scope, created.versionId)).rejects.toBeInstanceOf(
      ConflictException,
    );
    // uploaded_by is null, so there is nobody to tell.
    expect(notify.notifyUser).not.toHaveBeenCalled();
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
