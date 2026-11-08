// Integration tests of QuotationDocumentService.link on a real Postgres (Testcontainers, needs Docker in WSL).
// Real: migrations as bos_owner, queries as bos_app, the scopeWhereFor read of QuotationDocumentStore, and a real
// DocumentsService (disk storage on a temp dir, the real ScanProcessor against the fake clamd, real SignedLinks),
// so a returned link is redeemed through DocumentsService.openDownload. Quotations are created through
// DraftingService.create; their rendered PDF is stored the way the render job leaves it (createGenerated,
// receiveGenerated, then render_state none -> pending -> rendered), copying portal.integration.test.ts.
// Faked: the request context (the caller) and authz.assert on the drafting service.
// Run: pnpm --filter @bos/api exec vitest run src/modules/quotations/document/quotation-document.integration.test.ts
import 'reflect-metadata';

import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DEFAULT_ROLE_PERMISSIONS,
  type Permission,
  type QuotationDto,
  type RoleKey,
  type Scope,
} from '@bos/contracts';
import { runMigrations } from '@bos/db';
import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { Queue } from 'bullmq';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { AuditService } from '../../../platform/audit/audit.service';
import type { AuthzService } from '../../../platform/authz/authz.service';
import { can } from '../../../platform/authz/can';
import type { Principal } from '../../../platform/authz/principal';
import { systemActor, withTx, type TxScope } from '../../../platform/db/tx';
import { ClamdClient } from '../../../platform/documents/clamd.client';
import {
  DocumentsService,
  type GeneratedFile,
} from '../../../platform/documents/documents.service';
import { startFakeClamd, type FakeClamd } from '../../../platform/documents/fake-clamd';
import { ScanProcessor } from '../../../platform/documents/scan.processor';
import { SignedLinks, type LinkStore } from '../../../platform/documents/signed-link';
import { DiskStorageAdapter } from '../../../platform/documents/storage.adapter';
import type { MoneyService } from '../../../platform/settings/money.service';
import { NumberingService } from '../../../platform/settings/numbering.service';
import { DraftingService } from '../drafting/drafting.service';
import {
  goldenCreateBody,
  seedQuotationFixture,
  type QuotationFixture,
  type QuotationFixtureDb,
} from '../drafting/quotation.fixture';
import { PricingService } from '../pricing/pricing.service';
import { QUOTATION_OWNER_TYPE } from '../quotation-owner.policy';
import { QuotationDocumentService, QuotationDocumentStore } from './quotation-document.service';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 180_000 });

const OWNER_PW = 'owner-test-pw';
const APP_PW = 'app-test-pw';
const SIGNING_SECRET = 'an-integration-test-secret-of-32-plus-chars';
const RENDER_JOB = 'quotation-render';
const SIGNED_PATH = /^\/v1\/files\/[A-Za-z0-9._~-]+$/;

class MemoryLinkStore implements LinkStore {
  private readonly keys = new Set<string>();
  claim(key: string): Promise<boolean> {
    if (this.keys.has(key)) return Promise.resolve(false);
    this.keys.add(key);
    return Promise.resolve(true);
  }
}

let container: StartedPostgreSqlContainer;
let ownerPool: Pool;
let appPool: Pool;
let db: QuotationFixtureDb;
let f: QuotationFixture;
let scopeA: TxScope;
let scopeB: TxScope;
let storageRoot: string;
let documents: DocumentsService;
let scanner: ScanProcessor;
let fakeClamd: FakeClamd;
let drafting: DraftingService;
let service: QuotationDocumentService;

const grantsOf = (role: RoleKey) =>
  new Map(Object.entries(DEFAULT_ROLE_PERMISSIONS[role])) as Map<Permission, Scope>;
/** The caller of the download and of the drafting service; beforeEach resets it to the quotation owner. */
const current: {
  scope: TxScope;
  userId: string;
  orgKind: Principal['orgKind'];
  grants: Map<Permission, Scope>;
} = {
  scope: { tenantId: '', organizationId: '' },
  userId: '',
  orgKind: 'staff',
  grants: grantsOf('sales'),
};

const principalNow = (): Principal => ({
  userId: current.userId,
  zitadelUserId: `z-${current.userId}`,
  ...current.scope,
  orgKind: current.orgKind,
  partyId: null,
  idpOrgId: 'unused',
  roles: [],
  departmentId: null,
  status: 'active',
  grants: current.grants,
});
const caller = {
  current: () => ({
    scope: current.scope,
    actor: { kind: 'user' as const, id: current.userId, correlationId: 'test-corr' },
    principal: principalNow(),
  }),
};
const authz = {
  assert: (action: Permission, ref?: Parameters<typeof can>[2]) => {
    const d = can(principalNow(), action, ref);
    if (!d.allowed) {
      throw new ForbiddenException({ code: 'forbidden', message: 'Forbidden', reason: d.reason });
    }
  },
};
const money = {
  toNprSnapshot: () => Promise.reject(new Error('MoneyService is not used for NPR quotations')),
} as unknown as MoneyService;

const urlFor = (user: string, password: string, database: string) => {
  const url = new URL(container.getConnectionUri());
  url.username = user;
  url.password = password;
  url.pathname = `/${database}`;
  return url.toString();
};

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  const admin0 = new Pool({ connectionString: container.getConnectionUri(), max: 1 });
  await admin0.query(`CREATE ROLE bos_owner LOGIN PASSWORD '${OWNER_PW}'`);
  await admin0.query(`CREATE ROLE bos_app LOGIN PASSWORD '${APP_PW}'`);
  await admin0.query('CREATE DATABASE bos OWNER bos_owner');
  await admin0.query('GRANT CONNECT ON DATABASE bos TO bos_app');
  await admin0.end();
  const bosAdmin = new Pool({ connectionString: urlFor('test', 'test', 'bos'), max: 1 });
  await bosAdmin.query(
    'ALTER DEFAULT PRIVILEGES FOR ROLE bos_owner GRANT USAGE ON SCHEMAS TO bos_app',
  );
  await bosAdmin.query(
    'ALTER DEFAULT PRIVILEGES FOR ROLE bos_owner GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO bos_app',
  );
  await bosAdmin.end();
  await runMigrations(urlFor('bos_owner', OWNER_PW, 'bos'));

  ownerPool = new Pool({ connectionString: urlFor('bos_owner', OWNER_PW, 'bos'), max: 2 });
  appPool = new Pool({ connectionString: urlFor('bos_app', APP_PW, 'bos'), max: 8 });
  db = drizzle({ client: appPool });

  f = await seedQuotationFixture(db);
  scopeA = { tenantId: f.tenantId, organizationId: f.entityId };
  scopeB = { tenantId: f.tenantId, organizationId: f.otherEntityId };
  current.scope = scopeA;
  current.userId = f.ownerUserId;

  storageRoot = await mkdtemp(join(tmpdir(), 'bos-quotation-pdf-'));
  const storage = new DiskStorageAdapter(storageRoot);
  documents = new DocumentsService(
    db,
    storage,
    new SignedLinks(SIGNING_SECRET, new MemoryLinkStore(), () => Date.now()),
    { add: vi.fn().mockResolvedValue({}) } as unknown as Queue,
    { assert: vi.fn() },
    { record: vi.fn().mockResolvedValue(undefined) },
  );
  // The render job attaches the PDF to a Draft version here: the real owner policy only allows an approved one, and
  // this test is about the download link, not the render job or the approval flow.
  documents.registerOwner({
    ownerType: QUOTATION_OWNER_TYPE,
    resource: (s) => Promise.resolve({ tenantId: s.tenantId, organizationId: s.organizationId }),
    allowsSystemActor: () => Promise.resolve(true),
  });
  fakeClamd = await startFakeClamd();
  scanner = new ScanProcessor(
    db,
    storage,
    new ClamdClient({ host: fakeClamd.host, port: fakeClamd.port, timeoutMs: 5_000 }),
    { record: vi.fn().mockResolvedValue(undefined) },
    { notifyUser: vi.fn().mockResolvedValue(undefined) },
  );

  drafting = new DraftingService(
    db,
    new NumberingService(),
    new PricingService(money),
    authz as unknown as AuthzService,
    new AuditService(db),
    caller,
  );
  service = new QuotationDocumentService(db, documents, new QuotationDocumentStore(), caller);
});

afterAll(async () => {
  await fakeClamd?.close();
  await appPool?.end();
  await ownerPool?.end();
  await container?.stop();
  if (storageRoot) await rm(storageRoot, { recursive: true, force: true });
});

beforeEach(() => {
  current.scope = scopeA;
  current.userId = f.ownerUserId;
  current.orgKind = 'staff';
  current.grants = grantsOf('sales');
});

// ---------------------------------------------------------------------------------------- helpers

const tokenOf = (url: string): string => url.replace(/^\/v1\/files\//, '');

const pdf = (): GeneratedFile => ({
  filename: 'QT-1-R1.pdf',
  declaredMime: 'application/pdf',
  bytes: Buffer.concat([
    Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF\n'),
    Buffer.alloc(200, 0x20),
  ]),
});

const createQuotation = (): Promise<QuotationDto> =>
  drafting.create(
    goldenCreateBody(f, { opportunityId: f.opportunityId }),
    `create-${randomUUID()}`,
  );

/**
 * The rendered PDF of a version the way the render job leaves it: stored and received, scanned clean unless `scan`
 * is false (it then stays quarantined), then recorded on the version. Returns the document version's id.
 */
async function renderPdf(versionId: string, opts: { scan?: boolean } = {}): Promise<string> {
  const file = pdf();
  const who = { scope: scopeA, actor: systemActor(RENDER_JOB) };
  const created = await withTx(db, who.scope, who.actor, (tx) =>
    documents.createGenerated(tx, { ownerType: QUOTATION_OWNER_TYPE, ownerId: versionId }, file),
  );
  await documents.receiveGenerated(created, file, who);
  if (opts.scan !== false) {
    expect(await scanner.scanVersion({ versionId: created.versionId, ...scopeA }, true)).toBe(
      'clean',
    );
  }
  await withTx(db, scopeA, systemActor('quotation-document-test'), async (tx) => {
    await tx.execute(
      sql`UPDATE app.quotation_versions SET render_state = 'pending' WHERE id = ${versionId}::uuid`,
    );
    await tx.execute(sql`
      UPDATE app.quotation_versions
         SET render_state = 'rendered', rendered_document_id = ${created.documentId}::uuid,
             rendered_sha256 = decode(repeat('cd', 32), 'hex')
       WHERE id = ${versionId}::uuid`);
  });
  return created.versionId;
}

// ---------------------------------------------------------------------------------------------- link

describe('QuotationDocumentService.link', () => {
  it('links a clean rendered PDF, and the link redeems once', async () => {
    const q = await createQuotation();
    await renderPdf(q.currentVersionId);

    const link = await service.link(q.id, q.currentVersionId);

    expect(link.url).toMatch(SIGNED_PATH);
    const opened = await documents.openDownload(tokenOf(link.url));
    expect(opened.mime).toBe('application/pdf');
    expect(opened.filename).toBe('QT-1-R1.pdf');
    opened.stream.destroy();
    await expect(documents.openDownload(tokenOf(link.url))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('is a 409 quotation_pdf_not_ready while the PDF is quarantined, then links once it is clean', async () => {
    const q = await createQuotation();
    const documentVersionId = await renderPdf(q.currentVersionId, { scan: false });

    const refused = await service.link(q.id, q.currentVersionId).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(ConflictException);
    expect((refused as ConflictException).getResponse()).toMatchObject({
      code: 'quotation_pdf_not_ready',
    });

    expect(await scanner.scanVersion({ versionId: documentVersionId, ...scopeA }, true)).toBe(
      'clean',
    );
    const link = await service.link(q.id, q.currentVersionId);
    expect(link.url).toMatch(SIGNED_PATH);
  });

  it('is a 409 quotation_pdf_not_ready for a version that was never rendered', async () => {
    const q = await createQuotation();

    const refused = await service.link(q.id, q.currentVersionId).catch((e: unknown) => e);

    expect(refused).toBeInstanceOf(ConflictException);
    expect((refused as ConflictException).getResponse()).toMatchObject({
      code: 'quotation_pdf_not_ready',
    });
  });

  it('is a 404 from another entity, even with a clean PDF, and issues no link', async () => {
    const q = await createQuotation();
    await renderPdf(q.currentVersionId);
    current.scope = scopeB;

    await expect(service.link(q.id, q.currentVersionId)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('is a 404 for a version of another quotation, an unknown version and an unknown quotation', async () => {
    const q = await createQuotation();
    const other = await createQuotation();
    await renderPdf(q.currentVersionId);
    await renderPdf(other.currentVersionId);

    for (const [name, quotationId, versionId] of [
      ['version of another quotation', q.id, other.currentVersionId],
      ['unknown version', q.id, randomUUID()],
      ['unknown quotation', randomUUID(), q.currentVersionId],
    ] as const) {
      await expect(service.link(quotationId, versionId), name).rejects.toBeInstanceOf(
        NotFoundException,
      );
    }
  });

  it('applies the own scope: another owner gets 404, the owner and an all-scope reader get the link', async () => {
    const q = await createQuotation();
    await renderPdf(q.currentVersionId);

    current.grants = new Map<Permission, Scope>([['quotation.read', 'own']]);
    current.userId = randomUUID();
    await expect(service.link(q.id, q.currentVersionId)).rejects.toBeInstanceOf(NotFoundException);

    current.userId = f.ownerUserId;
    expect((await service.link(q.id, q.currentVersionId)).url).toMatch(SIGNED_PATH);

    current.grants = new Map<Permission, Scope>([['quotation.read', 'all']]);
    current.userId = randomUUID();
    expect((await service.link(q.id, q.currentVersionId)).url).toMatch(SIGNED_PATH);
  });

  it('is a 404 without quotation.read at all, and a 403 for a portal caller', async () => {
    const q = await createQuotation();
    await renderPdf(q.currentVersionId);

    current.grants = new Map<Permission, Scope>();
    await expect(service.link(q.id, q.currentVersionId)).rejects.toBeInstanceOf(NotFoundException);

    current.grants = new Map<Permission, Scope>([['quotation.read', 'all']]);
    current.orgKind = 'customer';
    await expect(service.link(q.id, q.currentVersionId)).rejects.toBeInstanceOf(ForbiddenException);
  });
});
