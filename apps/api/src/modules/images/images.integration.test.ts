// Integration tests of the image routes (U12, D33) on a real postgres:16-alpine (Testcontainers, needs Docker in WSL).
// Run: pnpm --filter @bos/api exec vitest run src/modules/images/images.integration.test.ts
//
// Real: every migration as bos_owner, every query as bos_app, the image owner policies with their database loaders,
// DocumentsService with the real AuthzService (staff principals carry the seeded DEFAULT_ROLE_PERMISSIONS of their
// role), the disk storage on a temp dir, the type check, the ScanProcessor talking the clamd protocol to fake-clamd,
// SettingsService, AuditService and the controller handlers (the POST upload gets a real readable stream carrying the
// request headers, as Express hands it over), called inside a request store bound to the caller's
// principal as the tenancy interceptor binds it. Fakes: the BullMQ scan queue (the test hands the captured job to
// the processor), notify, and the Express response (a writable stream recording status and headers).
import 'reflect-metadata';

import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';

import {
  DEFAULT_ROLE_PERMISSIONS,
  IMAGE_MAX_BYTES,
  type ImageOwnerType,
  type Permission,
  type RoleKey,
  type Scope,
} from '@bos/contracts';
import { createParty, createStaffUser, createTenantWithEntity, organizations } from '@bos/db';
import { type INestApplication, HttpException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Queue } from 'bullmq';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { Request, Response } from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { configureApp } from '../../app.setup';
import { AuditService } from '../../platform/audit/audit.service';
import { AuthzService } from '../../platform/authz/authz.service';
import type { Principal } from '../../platform/authz/principal';
import type { RoleCache } from '../../platform/authz/role-cache';
import type { Db } from '../../platform/db/db.module';
import { requestTx, systemActor, withTx } from '../../platform/db/tx';
import { ErrorBodyFilter } from '../../platform/tenancy/error-body.filter';
import { ClamdClient } from '../../platform/documents/clamd.client';
import type { ScanJobData } from '../../platform/documents/documents.ports';
import { DocumentsService } from '../../platform/documents/documents.service';
import { startFakeClamd, type FakeClamd } from '../../platform/documents/fake-clamd';
import { ScanProcessor } from '../../platform/documents/scan.processor';
import { SignedLinks, type LinkStore } from '../../platform/documents/signed-link';
import { DiskStorageAdapter } from '../../platform/documents/storage.adapter';
import { SettingsService } from '../../platform/settings/settings.service';
import {
  bindIdentity,
  bindPrincipal,
  runWithRequestStore,
} from '../../platform/tenancy/request-context';
import { drizzleLogoStatsLookup } from './document-logo.resolver';
import { drizzleImageOwnerLoaders, imageOwnerPolicies } from './image-owner.policies';
import { ImagesController } from './images.controller';
import { BrandingController } from './branding.controller';
import { PUBLIC_LOGO_CACHE_CONTROL, PublicLogoController } from './public-logo.controller';
import { drizzleImagePointers, ImagesService } from './images.service';
import { createTestDatabase, type TestDatabase } from '@bos/db/testing';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 180_000 });

const SECRET = 'an-integration-test-secret-of-32-plus-chars';

/** A 1x1 PNG: real bytes, so the real type check (file-type) recognises it. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

class MemoryStore implements LinkStore {
  claim(): Promise<boolean> {
    return Promise.resolve(true);
  }
}

let testDb: TestDatabase;
let pool: Pool;
let db: Db;
let storageRoot: string;
let fakeClamd: FakeClamd;
let processor: ScanProcessor;
let documents: DocumentsService;
let settings: SettingsService;
let controller: ImagesController;
let publicLogo: PublicLogoController;
let httpApp: INestApplication;
let baseUrl: string;
let branding: BrandingController;

const queue = { add: vi.fn().mockResolvedValue({}) };
const notify = { notifyUser: vi.fn().mockResolvedValue(undefined) };

type Tenant = { tenantId: string; organizationId: string; idpOrgId: string; userId: string };
/** Tenant A has its default entity and a second one (`entityA2`); tenant B has only a default. */
let a: Tenant;
let b: Tenant;
let entityA2: string;

/** A staff principal of `t` acting for `organizationId`, with the default grants of `role`. */
function staff(t: Tenant, role: RoleKey = 'founder', organizationId = t.organizationId): Principal {
  return {
    userId: t.userId,
    zitadelUserId: `zitadel-${t.userId}`,
    tenantId: t.tenantId,
    organizationId,
    orgKind: 'staff',
    partyId: null,
    idpOrgId: t.idpOrgId,
    roles: [role],
    departmentId: null,
    status: 'active',
    grants: new Map(Object.entries(DEFAULT_ROLE_PERMISSIONS[role])) as Map<Permission, Scope>,
  };
}

/** Runs `fn` as the HTTP request of `p`, as the tenancy interceptor binds it. */
function asCaller<T>(p: Principal, fn: () => Promise<T>): Promise<T> {
  return runWithRequestStore('it-images', () => {
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

/** Uploads PNG as `p` for the owner and runs the queued scan, so the image is clean. Returns the document id. */
async function uploadClean(
  p: Principal,
  ownerType: ImageOwnerType,
  ownerId: string,
): Promise<string> {
  const created = await asCaller(p, () => {
    const { scope, actor } = requestTx();
    return withTx(db, scope, actor, (tx) =>
      documents.create(tx, {
        ownerType,
        ownerId,
        filename: 'picture.png',
        declaredMime: 'image/png',
        sizeBytes: PNG.length,
      }),
    );
  });
  await asCaller(p, () =>
    documents.receiveContent(created.versionId, Readable.from(PNG), PNG.length, {
      documentId: created.documentId,
    }),
  );
  const call = queue.add.mock.calls.find(
    (c) => (c[1] as ScanJobData).versionId === created.versionId,
  );
  if (call === undefined) throw new Error(`no scan was queued for ${created.versionId}`);
  await processor.scanVersion(call[1] as ScanJobData, true);
  return created.documentId;
}

const putAs = (p: Principal, ownerType: string, ownerId: string, body: unknown) =>
  asCaller(p, () => controller.set(ownerType, ownerId, body));

/** POST /v1/images/:ownerType/:ownerId as `p`: the body is `bytes`, sent with `headers` (lower-case names). */
const postAs = (
  p: Principal,
  ownerType: string,
  ownerId: string,
  headers: Record<string, string>,
  bytes: Buffer = PNG,
) =>
  asCaller(p, () =>
    controller.upload(
      ownerType,
      ownerId,
      Object.assign(Readable.from([bytes]), { headers }) as unknown as Request,
    ),
  );

const pngHeaders = (bytes: Buffer = PNG): Record<string, string> => ({
  'content-type': 'image/png',
  'content-length': String(bytes.length),
  'x-file-name': 'my%20face.png',
});

/** How many documents (removed ones included) the owner has: a refusal before the body must leave this unchanged. */
async function documentCount(ownerType: string, ownerId: string): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(
    'SELECT count(*) AS n FROM app.documents WHERE owner_type = $1 AND owner_id = $2',
    [ownerType, ownerId],
  );
  return Number(rows[0]?.n ?? 0);
}

/** An Express-like response that is a real writable stream, recording status and headers. */
function fakeResponse() {
  const sink = new PassThrough();
  const chunks: Buffer[] = [];
  sink.on('data', (c: Buffer) => chunks.push(c));
  const res = Object.assign(sink, {
    statusCode: 200,
    headers: {},
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    set(h: Record<string, string>) {
      Object.assign(res.headers, h);
      return res;
    },
  });
  return { res, body: () => Buffer.concat(chunks) };
}

/** GET /v1/images/:id as `p`: the status and body, or the refusal status. */
async function getAs(p: Principal, documentId: string): Promise<{ status: number; body: Buffer }> {
  const { res, body } = fakeResponse();
  try {
    await asCaller(p, () =>
      controller.open(
        documentId,
        { headers: {} } as unknown as Request,
        res as unknown as Response,
      ),
    );
    return { status: res.statusCode, body: body() };
  } catch (e) {
    if (e instanceof HttpException) return { status: e.getStatus(), body: Buffer.alloc(0) };
    throw e;
  }
}

const statusOf = (call: Promise<unknown>): Promise<number | string> =>
  call.then(
    () => 'resolved',
    (e: unknown) => (e instanceof HttpException ? e.getStatus() : String(e)),
  );

async function removedAt(documentId: string): Promise<Date | null | undefined> {
  const { rows } = await pool.query<{ removed_at: Date | null }>(
    'SELECT removed_at FROM app.documents WHERE id = $1',
    [documentId],
  );
  return rows[0]?.removed_at;
}

async function avatarOf(userId: string): Promise<string | null | undefined> {
  const { rows } = await pool.query<{ avatar_document_id: string | null }>(
    'SELECT avatar_document_id FROM app.users WHERE id = $1',
    [userId],
  );
  return rows[0]?.avatar_document_id;
}

/** The logo pointer of a customer or vendor row. */
async function logoOf(
  ownerType: 'customer_logo' | 'vendor_logo',
  id: string,
): Promise<string | null | undefined> {
  const table = ownerType === 'customer_logo' ? 'app.customers' : 'app.vendors';
  const { rows } = await pool.query<{ logo_document_id: string | null }>(
    `SELECT logo_document_id FROM ${table} WHERE id = $1`,
    [id],
  );
  return rows[0]?.logo_document_id;
}

let panSeq = 0;

/** A tenant-level customer or vendor of tenant A (no entity of its own), for the logo cases. */
async function partyOfA(ownerType: 'customer_logo' | 'vendor_logo'): Promise<string> {
  const kind = ownerType === 'customer_logo' ? 'customer' : 'vendor';
  const { partyId } = await createParty(pool, { tenantId: a.tenantId, kind });
  await withTx(db, a, systemActor('test'), (tx) =>
    kind === 'customer'
      ? tx.execute(sql`
          INSERT INTO app.customers
            (id, tenant_id, number, legal_name, name_norm, country, address_line, address_city)
          VALUES (${partyId}::uuid, ${a.tenantId}::uuid, ${`CUS-${partyId.slice(0, 8)}`},
                  ${`Customer ${partyId.slice(0, 6)}`}, ${`customer ${partyId.slice(0, 6)}`},
                  'NP', 'Thamel 4', 'Kathmandu')`)
      : tx.execute(sql`
          INSERT INTO app.vendors (id, tenant_id, legal_name, pan, status, created_by)
          VALUES (${partyId}::uuid, ${a.tenantId}::uuid, ${`Vendor ${partyId.slice(0, 6)}`},
                  ${String(600_000_000 + (panSeq += 1))}, 'draft', ${a.userId}::uuid)`),
  );
  return partyId;
}

beforeAll(async () => {
  testDb = await createTestDatabase();
  const admin = new Pool({ connectionString: testDb.adminUrl, max: 1 });
  await admin.end();
  const bosAdmin = new Pool({ connectionString: testDb.adminUrl, max: 1 });
  await bosAdmin.end();

  pool = new Pool({ connectionString: testDb.appUrl, max: 12 });
  pool.on('error', () => undefined);
  db = drizzle({ client: pool });
  const audit = new AuditService(db);

  storageRoot = await mkdtemp(join(tmpdir(), 'bos-images-it-'));
  const storage = new DiskStorageAdapter(storageRoot);
  documents = new DocumentsService(
    db,
    storage,
    new SignedLinks(SECRET, new MemoryStore(), () => Date.now()),
    queue as unknown as Queue,
    new AuthzService(db, {} as RoleCache),
    audit,
  );
  for (const policy of imageOwnerPolicies(drizzleImageOwnerLoaders(db))) {
    documents.registerOwner(policy);
  }
  settings = new SettingsService(db);
  controller = new ImagesController(
    new ImagesService(db, documents, settings, audit, drizzleImagePointers()),
  );

  publicLogo = new PublicLogoController(documents);
  branding = new BrandingController(settings);

  // The public route over real HTTP: Nest routing, the error filter and the response headers, with no session at all.
  const moduleRef = await Test.createTestingModule({
    controllers: [PublicLogoController],
    providers: [{ provide: DocumentsService, useValue: documents }],
  }).compile();
  httpApp = moduleRef.createNestApplication({ logger: false });
  configureApp(httpApp);
  httpApp.useGlobalFilters(new ErrorBodyFilter());
  await httpApp.listen(0, '127.0.0.1');
  baseUrl = `http://127.0.0.1:${((httpApp.getHttpServer() as Server).address() as AddressInfo).port}`;

  fakeClamd = await startFakeClamd();
  processor = new ScanProcessor(
    db,
    storage,
    new ClamdClient({ host: fakeClamd.host, port: fakeClamd.port, timeoutMs: 5_000 }),
    audit,
    notify,
  );

  const tenant = async (code: string): Promise<Tenant> => {
    const t = await createTenantWithEntity(pool, { code });
    const { userId } = await createStaffUser(pool, { ...t });
    return { ...t, userId };
  };
  a = await tenant('IA');
  b = await tenant('IB');
  entityA2 = randomUUID();
  await withTx(db, a, systemActor('test'), (tx) =>
    tx.insert(organizations).values({
      id: entityA2,
      tenantId: a.tenantId,
      organizationId: entityA2,
      code: 'IA2',
      name: 'Second entity',
      legalName: 'Second entity',
    }),
  );
}, 180_000);

afterAll(async () => {
  await httpApp?.close();
  await fakeClamd?.close();
  await pool?.end();
  await testDb?.drop();
  if (storageRoot) await rm(storageRoot, { recursive: true, force: true });
});

beforeEach(() => {
  queue.add.mockClear();
});

describe('PUT /v1/images/user_avatar/:userId', () => {
  it('moves the pointer to the new picture and soft-removes the previous one', async () => {
    const me = staff(a);
    const first = await uploadClean(me, 'user_avatar', a.userId);
    await expect(putAs(me, 'user_avatar', a.userId, { documentId: first })).resolves.toEqual({
      documentId: first,
    });
    expect(await avatarOf(a.userId)).toBe(first);

    const second = await uploadClean(me, 'user_avatar', a.userId);
    await expect(putAs(me, 'user_avatar', a.userId, { documentId: second })).resolves.toEqual({
      documentId: second,
    });
    expect(await avatarOf(a.userId)).toBe(second);
    expect(await removedAt(first)).toBeInstanceOf(Date);
    expect(await removedAt(second)).toBeNull();
    // The removed picture is no longer served; the current one is.
    expect((await getAs(me, first)).status).toBe(404);
    const served = await getAs(me, second);
    expect(served.status).toBe(200);
    expect(served.body.equals(PNG)).toBe(true);
  });

  it('is 409 for a picture whose write failed (quarantined, no sha256), and takes it once the bytes are recorded (EF3)', async () => {
    const me = staff(a);
    const created = await asCaller(me, () => {
      const { scope, actor } = requestTx();
      return withTx(db, scope, actor, (tx) =>
        documents.create(tx, {
          ownerType: 'user_avatar',
          ownerId: a.userId,
          filename: 'picture.png',
          declaredMime: 'image/png',
          sizeBytes: PNG.length,
        }),
      );
    });
    // A failed write leaves the version quarantined without the sha256 that receiving the bytes records.
    await withTx(
      db,
      { tenantId: a.tenantId, organizationId: a.organizationId },
      systemActor('test'),
      (tx) =>
        tx.execute(
          sql`UPDATE app.document_versions SET status = 'quarantined', sha256 = NULL WHERE id = ${created.versionId}`,
        ),
    );
    expect(
      await statusOf(putAs(me, 'user_avatar', a.userId, { documentId: created.documentId })),
    ).toBe(409);
    expect(await avatarOf(a.userId)).not.toBe(created.documentId);

    await withTx(
      db,
      { tenantId: a.tenantId, organizationId: a.organizationId },
      systemActor('test'),
      (tx) =>
        tx.execute(
          sql`UPDATE app.document_versions SET sha256 = decode(repeat('ab', 32), 'hex') WHERE id = ${created.versionId}`,
        ),
    );
    await expect(
      putAs(me, 'user_avatar', a.userId, { documentId: created.documentId }),
    ).resolves.toEqual({ documentId: created.documentId });
    expect(await avatarOf(a.userId)).toBe(created.documentId);
  });

  it('two concurrent PUTs for one owner never deadlock: the replacement is 200, the other 200 or 404, never 500', async () => {
    // The cycle the lock order prevents: PUT{current} would lock the current picture and then wait for the owner,
    // while PUT{next} holds the owner and then locks the current picture to remove it.
    const me = staff(a);
    for (let round = 0; round < 5; round += 1) {
      const current = await uploadClean(me, 'user_avatar', a.userId);
      await putAs(me, 'user_avatar', a.userId, { documentId: current });
      const next = await uploadClean(me, 'user_avatar', a.userId);
      const [again, replaced] = await Promise.all([
        statusOf(putAs(me, 'user_avatar', a.userId, { documentId: current })),
        statusOf(putAs(me, 'user_avatar', a.userId, { documentId: next })),
      ]);
      expect(replaced).toBe('resolved');
      expect(['resolved', 404]).toContain(again);
      expect(await avatarOf(a.userId)).toBe(next);
      expect(await removedAt(current)).toBeInstanceOf(Date);
    }
  });

  it('null clears the pointer and removes the picture', async () => {
    const me = staff(a);
    const pic = await uploadClean(me, 'user_avatar', a.userId);
    await putAs(me, 'user_avatar', a.userId, { documentId: pic });
    await expect(putAs(me, 'user_avatar', a.userId, { documentId: null })).resolves.toEqual({
      documentId: null,
    });
    expect(await avatarOf(a.userId)).toBeNull();
    expect(await removedAt(pic)).toBeInstanceOf(Date);
  });
});

describe('GET /v1/images/:documentId', () => {
  it('serves a profile picture to staff acting for another entity of the same tenant', async () => {
    const me = staff(a);
    const pic = await uploadClean(me, 'user_avatar', a.userId);
    await putAs(me, 'user_avatar', a.userId, { documentId: pic });
    const fromOtherEntity = await getAs(staff(a, 'sales', entityA2), pic);
    expect(fromOtherEntity.status).toBe(200);
    expect(fromOtherEntity.body.equals(PNG)).toBe(true);
  });

  it('is 404 to staff of another tenant, and the other tenant cannot point at it either', async () => {
    const pic = await uploadClean(staff(a), 'user_avatar', a.userId);
    expect((await getAs(staff(b), pic)).status).toBe(404);
    expect(await statusOf(putAs(staff(b), 'user_avatar', b.userId, { documentId: pic }))).toBe(404);
    // Tenant A's user is not an owner in tenant B's scope.
    expect(await statusOf(putAs(staff(b), 'user_avatar', a.userId, { documentId: null }))).toBe(
      404,
    );
  });
});

// Customers and vendors are tenant-level records (ADR 0027): their logo is the same in every entity of the tenant,
// whichever entity it was uploaded in, and never visible to another tenant.
describe.each(['customer_logo', 'vendor_logo'] as const)(
  '%s across the entities of a tenant',
  (ownerType) => {
    it('is served to staff of another entity of the same tenant, and 404 to another tenant', async () => {
      const owner = await partyOfA(ownerType);
      const logo = await uploadClean(staff(a), ownerType, owner);
      await putAs(staff(a), ownerType, owner, { documentId: logo });
      expect(await logoOf(ownerType, owner)).toBe(logo);

      const fromOtherEntity = await getAs(staff(a, 'sales', entityA2), logo);
      expect(fromOtherEntity.status).toBe(200);
      expect(fromOtherEntity.body.equals(PNG)).toBe(true);
      expect((await getAs(staff(b), logo)).status).toBe(404);
    });

    it('replaced from another entity: the pointer moves and the first entity logo document is removed', async () => {
      const owner = await partyOfA(ownerType);
      const first = await uploadClean(staff(a), ownerType, owner);
      await putAs(staff(a), ownerType, owner, { documentId: first });

      const inA2 = staff(a, 'founder', entityA2);
      const second = await uploadClean(inA2, ownerType, owner);
      await expect(putAs(inA2, ownerType, owner, { documentId: second })).resolves.toEqual({
        documentId: second,
      });
      expect(await logoOf(ownerType, owner)).toBe(second);
      expect(await removedAt(first)).toBeInstanceOf(Date);
      expect(await removedAt(second)).toBeNull();
      // Both entities see the new logo and neither sees the removed one.
      for (const viewer of [staff(a), inA2]) {
        expect((await getAs(viewer, second)).status).toBe(200);
        expect((await getAs(viewer, first)).status).toBe(404);
      }
    });

    it('cleared from another entity: the pointer is null and the logo document is removed', async () => {
      const owner = await partyOfA(ownerType);
      const logo = await uploadClean(staff(a), ownerType, owner);
      await putAs(staff(a), ownerType, owner, { documentId: logo });

      await expect(
        putAs(staff(a, 'founder', entityA2), ownerType, owner, { documentId: null }),
      ).resolves.toEqual({ documentId: null });
      expect(await logoOf(ownerType, owner)).toBeNull();
      expect(await removedAt(logo)).toBeInstanceOf(Date);
    });

    it('another tenant can neither point at the logo nor reach the record', async () => {
      const owner = await partyOfA(ownerType);
      const logo = await uploadClean(staff(a), ownerType, owner);
      expect(await statusOf(putAs(staff(b), ownerType, owner, { documentId: logo }))).toBe(404);
      expect(await statusOf(putAs(staff(b), ownerType, owner, { documentId: null }))).toBe(404);
      expect(await removedAt(logo)).toBeNull();
    });
  },
);

describe('entity_logo stays with its entity', () => {
  it('is 404 to staff acting for another entity of the same tenant', async () => {
    const logo = await uploadClean(staff(a), 'entity_logo', a.organizationId);
    expect((await getAs(staff(a), logo)).status).toBe(200);
    expect((await getAs(staff(a, 'founder', entityA2), logo)).status).toBe(404);
  });
});

describe('PUT /v1/images/entity_logo/:entityId', () => {
  it('writes entity.profile as the next version, keeping the other fields', async () => {
    const founder = staff(a);
    await withTx(db, a, systemActor('test'), (tx) =>
      settings.set(tx, 'entity.profile', {
        displayName: 'Acme Pvt Ltd',
        logoDocumentId: null,
        legacyLogoDataUrl: null,
        phones: [],
        email: 'hi@acme.test',
        website: null,
        panVatNo: null,
        signatoryName: null,
        signatoryTitle: null,
      }),
    );
    const before = await settings.getCurrent(a, 'entity.profile');

    const logo = await uploadClean(founder, 'entity_logo', a.organizationId);
    await expect(
      putAs(founder, 'entity_logo', a.organizationId, { documentId: logo }),
    ).resolves.toEqual({ documentId: logo });

    const after = await settings.getCurrent(a, 'entity.profile');
    expect(after.version).toBe((before.version ?? 0) + 1);
    expect(after.value).toMatchObject({
      displayName: 'Acme Pvt Ltd',
      email: 'hi@acme.test',
      logoDocumentId: logo,
      legacyLogoDataUrl: null,
    });
    // The other entity of the tenant keeps its own (unset) profile.
    expect(
      (
        await settings.getCurrent(
          { tenantId: a.tenantId, organizationId: entityA2 },
          'entity.profile',
        )
      ).value.logoDocumentId,
    ).toBeNull();

    // Replacing it removes the old logo document.
    const next = await uploadClean(founder, 'entity_logo', a.organizationId);
    await putAs(founder, 'entity_logo', a.organizationId, { documentId: next });
    expect(await removedAt(logo)).toBeInstanceOf(Date);
    expect((await settings.getCurrent(a, 'entity.profile')).version).toBe(
      (before.version ?? 0) + 2,
    );
  });

  it('is 403 for a sales user, and 404 for another entity id', async () => {
    expect(
      await statusOf(
        putAs(staff(a, 'sales'), 'entity_logo', a.organizationId, { documentId: null }),
      ),
    ).toBe(403);
    expect(await statusOf(putAs(staff(a), 'entity_logo', entityA2, { documentId: null }))).toBe(
      404,
    );
  });
});

describe('company logo variants (R6AC)', () => {
  const statsRows = async (documentId: string) =>
    (
      await pool.query<{
        tenant_id: string;
        organization_id: string;
        variant: string;
        luminance: number;
        has_transparency: boolean;
      }>(
        'SELECT tenant_id, organization_id, variant, luminance, has_transparency FROM app.logo_image_stats WHERE document_id = $1',
        [documentId],
      )
    ).rows;

  it.each([
    ['entity_logo', 'logoDocumentId', 'primary'],
    ['entity_logo_on_dark', 'logoOnDarkDocumentId', 'on_dark'],
    ['entity_logo_on_light', 'logoOnLightDocumentId', 'on_light'],
  ] as const)(
    'POST %s points %s at the upload, keeps the other slots, and records what the image measures',
    async (ownerType, field, variant) => {
      const founder = staff(a);
      const { documentId } = await postAs(founder, ownerType, a.organizationId, pngHeaders());
      const profile = (await settings.getCurrent(a, 'entity.profile')).value;
      expect(profile[field]).toBe(documentId);
      const rows = await statsRows(documentId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        tenant_id: a.tenantId,
        organization_id: a.organizationId,
        variant,
      });
      expect(typeof rows[0]!.has_transparency).toBe('boolean');
      expect(rows[0]!.luminance).toBeGreaterThanOrEqual(0);
      expect(rows[0]!.luminance).toBeLessThanOrEqual(1);
    },
  );

  it.each(['entity_logo', 'entity_logo_on_dark', 'entity_logo_on_light'] as const)(
    'POST %s refuses a 600 KB picture with 413, announced or chunked, and writes nothing (R6AC)',
    async (ownerType) => {
      const big = Buffer.concat([PNG, Buffer.alloc(600 * 1024)]);
      const before = await documentCount(ownerType, a.organizationId);
      const announced = pngHeaders(big);
      expect(await statusOf(postAs(staff(a), ownerType, a.organizationId, announced, big))).toBe(
        413,
      );
      const { 'content-length': _omitted, ...chunked } = announced;
      expect(await statusOf(postAs(staff(a), ownerType, a.organizationId, chunked, big))).toBe(413);
      expect(await documentCount(ownerType, a.organizationId)).toBe(before);
    },
  );

  it('keeps all three slots after each is set', async () => {
    const founder = staff(a);
    const main = (await postAs(founder, 'entity_logo', a.organizationId, pngHeaders())).documentId;
    const dark = (await postAs(founder, 'entity_logo_on_dark', a.organizationId, pngHeaders()))
      .documentId;
    const light = (await postAs(founder, 'entity_logo_on_light', a.organizationId, pngHeaders()))
      .documentId;
    expect((await settings.getCurrent(a, 'entity.profile')).value).toMatchObject({
      logoDocumentId: main,
      logoOnDarkDocumentId: dark,
      logoOnLightDocumentId: light,
    });
  });

  it('is 403 to a sales user for a variant, like the main logo', async () => {
    expect(
      await statusOf(
        postAs(staff(a, 'sales'), 'entity_logo_on_dark', a.organizationId, pngHeaders()),
      ),
    ).toBe(403);
  });

  it('is 404 for a variant of another entity id, and a variant document cannot be set as another slot', async () => {
    expect(await statusOf(postAs(staff(a), 'entity_logo_on_dark', entityA2, pngHeaders()))).toBe(
      404,
    );
    const dark = await uploadClean(staff(a), 'entity_logo_on_dark', a.organizationId);
    expect(
      await statusOf(
        putAs(staff(a), 'entity_logo_on_light', a.organizationId, { documentId: dark }),
      ),
    ).toBe(404);
  });

  it("another tenant's lookup finds no stats for the logo (tenant isolation)", async () => {
    const founder = staff(a);
    const { documentId } = await postAs(founder, 'entity_logo', a.organizationId, pngHeaders());
    const lookup = drizzleLogoStatsLookup(db);
    await expect(lookup(a, documentId)).resolves.not.toBeNull();
    await expect(lookup(b, documentId)).resolves.toBeNull();
    await expect(
      lookup({ tenantId: a.tenantId, organizationId: entityA2 }, documentId),
    ).resolves.toBeNull();
  });

  it('refuses a stats row whose document belongs to another tenant (composite foreign key)', async () => {
    const { documentId } = await postAs(staff(a), 'entity_logo', a.organizationId, pngHeaders());
    await expect(
      pool.query(
        `INSERT INTO app.logo_image_stats (tenant_id, organization_id, document_id, variant, luminance, has_transparency)
         VALUES ($1, $2, $3, 'primary', 0.5, false)`,
        [b.tenantId, b.organizationId, documentId],
      ),
    ).rejects.toThrow();
  });
});

/** GET /v1/public/logo/:tenantId with no session at all: no request store, as for a @Public route. */
async function getPublic(
  tenantId: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: Buffer; headers: Record<string, string> }> {
  const { res, body } = fakeResponse();
  try {
    await publicLogo.open(tenantId, { headers } as unknown as Request, res as unknown as Response);
    return { status: res.statusCode, body: body(), headers: res.headers };
  } catch (e) {
    if (e instanceof HttpException) {
      return { status: e.getStatus(), body: Buffer.alloc(0), headers: {} };
    }
    throw e;
  }
}

/** A fresh tenant with its default entity and one staff user, so a test can start with nothing applied. */
async function freshTenant(): Promise<Tenant> {
  const t = await createTenantWithEntity(pool, { code: `F${randomUUID().slice(0, 6)}` });
  const { userId } = await createStaffUser(pool, { ...t });
  return { ...t, userId };
}

/** Uploads a clean logo and applies it as the company logo of `t`'s default entity. */
async function applyLogo(t: Tenant): Promise<string> {
  const logo = await uploadClean(staff(t), 'entity_logo', t.organizationId);
  await putAs(staff(t), 'entity_logo', t.organizationId, { documentId: logo });
  return logo;
}

describe('GET /v1/public/logo/:tenantId (R6Q20, R6Q20b)', () => {
  it('serves the logo the company profile names now, to a reader with no session, with a type, a short public cache and an ETag', async () => {
    await applyLogo(a);
    const res = await getPublic(a.tenantId);
    expect(res.status).toBe(200);
    expect(res.body.equals(PNG)).toBe(true);
    expect(res.headers).toMatchObject({
      'Content-Type': 'image/png',
      'Cache-Control': PUBLIC_LOGO_CACHE_CONTROL,
      'X-Content-Type-Options': 'nosniff',
      'Content-Disposition': 'inline',
    });
    expect(PUBLIC_LOGO_CACHE_CONTROL).toBe('public, max-age=300');
    expect(res.headers.ETag).toMatch(/^"[0-9a-f-]{36}"$/);
  });

  it('answers 304 with no body to a matching If-None-Match', async () => {
    await applyLogo(a);
    const first = await getPublic(a.tenantId);
    const again = await getPublic(a.tenantId, { 'if-none-match': first.headers.ETag ?? '' });
    expect(again.status).toBe(304);
    expect(again.body.length).toBe(0);
  });

  it('keeps one address when the logo is replaced: it serves the new logo, with a new ETag, and never the old one', async () => {
    await applyLogo(a);
    const before = await getPublic(a.tenantId);
    await applyLogo(a);
    const after = await getPublic(a.tenantId);
    expect(after.status).toBe(200);
    expect(after.headers.ETag).not.toBe(before.headers.ETag);
    // The old tag no longer matches: the caller gets the bytes of the current logo, not a 304.
    expect((await getPublic(a.tenantId, { 'if-none-match': before.headers.ETag ?? '' })).status).toBe(
      200,
    );
  });

  it('does not serve a logo that was uploaded but not applied, nor an older logo document', async () => {
    await applyLogo(a);
    const firstTag = (await getPublic(a.tenantId)).headers.ETag;
    // Uploaded and clean, but the profile does not name it.
    await uploadClean(staff(a), 'entity_logo', a.organizationId);
    expect((await getPublic(a.tenantId)).headers.ETag).toBe(firstTag);
    // Applied: the new one is served; the first is not reachable any more under any address.
    await applyLogo(a);
    expect((await getPublic(a.tenantId)).headers.ETag).not.toBe(firstTag);
  });

  it('is 404 for a tenant with no logo applied, and for another tenant id', async () => {
    await applyLogo(a);
    const noLogo = await freshTenant();
    expect((await getPublic(noLogo.tenantId)).status).toBe(404);
    // An uploaded logo that was never applied is not public.
    await uploadClean(staff(noLogo), 'entity_logo', noLogo.organizationId);
    expect((await getPublic(noLogo.tenantId)).status).toBe(404);
    expect((await getPublic(randomUUID())).status).toBe(404);
  });

  it('cannot read any other file: variants, avatars and party logos are never served, whatever the profile points at', async () => {
    // Only the main slot is public: with just a variant set, there is no public logo.
    const only = await freshTenant();
    const variant = await uploadClean(staff(only), 'entity_logo_on_dark', only.organizationId);
    await putAs(staff(only), 'entity_logo_on_dark', only.organizationId, { documentId: variant });
    expect((await getPublic(only.tenantId)).status).toBe(404);
    for (const bad of ['', 'x', '../etc/passwd', '%2e%2e', '1']) {
      expect((await getPublic(bad)).status).toBe(404);
    }
  });

  it('is 404 for a logo whose bytes are not scanned clean yet', async () => {
    const created = await asCaller(staff(a), () => {
      const { scope, actor } = requestTx();
      return withTx(db, scope, actor, (tx) =>
        documents.create(tx, {
          ownerType: 'entity_logo',
          ownerId: a.organizationId,
          filename: 'logo.png',
          declaredMime: 'image/png',
          sizeBytes: PNG.length,
        }),
      );
    });
    await asCaller(staff(a), () =>
      documents.receiveContent(created.versionId, Readable.from(PNG), PNG.length, {
        documentId: created.documentId,
      }),
    );
    await putAs(staff(a), 'entity_logo', a.organizationId, { documentId: created.documentId });
    expect((await getPublic(a.tenantId)).status).toBe(404);
  });

  it('uses the same version rule as the signed-in image route: a newer version still being scanned hides the clean one before it', async () => {
    const logo = await applyLogo(a);
    expect((await getPublic(a.tenantId)).status).toBe(200);
    expect((await getAs(staff(a), logo)).status).toBe(200);
    // Version 2 arrives and is not scanned yet (images have no upload path for it, so the row is written directly).
    await withTx(db, a, systemActor('test'), (tx) =>
      tx.execute(sql`
        INSERT INTO app.document_versions
          (tenant_id, organization_id, document_id, version, filename, declared_mime, size_bytes, storage_key, status)
        SELECT tenant_id, organization_id, document_id, 2, filename, declared_mime, size_bytes,
               tenant_id || '/' || gen_random_uuid(), 'awaiting_content'
          FROM app.document_versions WHERE document_id = ${logo}::uuid AND version = 1`),
    );
    expect((await getAs(staff(a), logo)).status).toBe(404);
    expect((await getPublic(a.tenantId)).status).toBe(404);
  });

  it('stops serving a logo once it is removed', async () => {
    await applyLogo(a);
    expect((await getPublic(a.tenantId)).status).toBe(200);
    await putAs(staff(a), 'entity_logo', a.organizationId, { documentId: null });
    expect((await getPublic(a.tenantId)).status).toBe(404);
  });
});

describe('GET /v1/public/logo/:tenantId over HTTP (R6Q20b)', () => {
  it('serves the current logo to a plain request with no cookie or token, with the public headers', async () => {
    await applyLogo(a);
    const res = await request(baseUrl)
      .get(`/v1/public/logo/${a.tenantId}`)
      .buffer(true)
      .parse((r, done) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => done(null, Buffer.concat(chunks)));
      });
    expect(res.status).toBe(200);
    expect((res.body as Buffer).equals(PNG)).toBe(true);
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.headers['cache-control']).toBe(PUBLIC_LOGO_CACHE_CONTROL);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toBe("default-src 'none'; sandbox");
    expect(res.headers['cross-origin-resource-policy']).toBe('cross-origin');
    expect(res.headers['set-cookie']).toBeUndefined();
    const tag = res.headers.etag ?? '';
    expect(tag).toMatch(/^"[0-9a-f-]{36}"$/);

    const again = await request(baseUrl)
      .get(`/v1/public/logo/${a.tenantId}`)
      .set('If-None-Match', tag);
    expect(again.status).toBe(304);
    expect(again.text).toBe('');
  });

  it('answers a refusal as the shared 404 error body, for an unknown tenant, a tenant with no logo, and a bad id', async () => {
    const noLogo = await freshTenant();
    for (const id of [randomUUID(), noLogo.tenantId, 'not-a-uuid']) {
      const res = await request(baseUrl).get(`/v1/public/logo/${id}`);
      expect(res.status).toBe(404);
      expect(res.headers['content-type']).toContain('application/json');
      // A refusal is never cached as a logo.
      expect(res.headers['cache-control'] ?? '').not.toContain('public');
      expect((res.body as { error?: { code?: string } }).error?.code).toBeTypeOf('string');
    }
  });

  it('has no per-document address any more: the old two-segment path is a 404', async () => {
    const logo = await applyLogo(a);
    const res = await request(baseUrl).get(`/v1/public/logo/${a.tenantId}/${logo}`);
    expect(res.status).toBe(404);
  });

  it('is read-only: only GET is routed', async () => {
    for (const method of ['post', 'put', 'delete', 'patch'] as const) {
      expect((await request(baseUrl)[method](`/v1/public/logo/${a.tenantId}`)).status).toBe(404);
    }
  });
});

describe('GET /v1/branding (R6Q20)', () => {
  /** A customer principal of tenant `t`: no staff grants. */
  const customer = (t: Tenant): Principal => ({
    ...staff(t, 'founder'),
    orgKind: 'customer',
    partyId: randomUUID(),
    roles: [],
    grants: new Map(),
  });

  it('gives staff and a customer of the entity the same name and logo pair, and another tenant its own', async () => {
    const logo = await uploadClean(staff(a), 'entity_logo', a.organizationId);
    await putAs(staff(a), 'entity_logo', a.organizationId, { documentId: logo });
    const current = (await settings.getCurrent(a, 'entity.profile')).value;
    await withTx(db, a, systemActor('test'), (tx) =>
      settings.set(tx, 'entity.profile', { ...current, displayName: 'Brand A' }),
    );

    const expected = { displayName: 'Brand A', logo: { tenantId: a.tenantId, documentId: logo } };
    expect(await asCaller(staff(a), () => branding.get())).toEqual(expected);
    expect(await asCaller(customer(a), () => branding.get())).toEqual(expected);
    // Tenant B has set nothing: it never sees tenant A's name or logo.
    expect((await asCaller(staff(b), () => branding.get())).logo).toBeNull();
    expect((await asCaller(staff(b), () => branding.get())).displayName).not.toBe('Brand A');
    // The tenant it names is the address the public route serves.
    expect((await getPublic(a.tenantId)).status).toBe(200);
  });
});

describe('POST /v1/images/:ownerType/:ownerId', () => {
  it('lets a finance user (no documents.upload) upload their own avatar in one request: 200, scan queued, pointer set', async () => {
    const finance = staff(a, 'finance');
    expect(finance.grants.has('documents.upload')).toBe(false);
    // documentCount sees the new row, so the refusals below that leave it unchanged are not vacuous.
    const before = await documentCount('user_avatar', a.userId);

    const { documentId } = await postAs(finance, 'user_avatar', a.userId, pngHeaders());
    expect(await documentCount('user_avatar', a.userId)).toBe(before + 1);
    expect(await avatarOf(a.userId)).toBe(documentId);
    expect(await removedAt(documentId)).toBeNull();

    // The scan job of the new version was queued; running it makes the picture servable.
    const { rows } = await pool.query<{ id: string }>(
      'SELECT id FROM app.document_versions WHERE document_id = $1',
      [documentId],
    );
    expect(rows).toHaveLength(1);
    const call = queue.add.mock.calls.find((c) => (c[1] as ScanJobData).versionId === rows[0]?.id);
    expect(call).toBeDefined();
    await processor.scanVersion(call?.[1] as ScanJobData, true);
    const served = await getAs(finance, documentId);
    expect(served.status).toBe(200);
    expect(served.body.equals(PNG)).toBe(true);
  });

  it("is 403 for a finance user posting another user's avatar, and stores nothing", async () => {
    const other = await createStaffUser(pool, {
      tenantId: a.tenantId,
      organizationId: a.organizationId,
      idpOrgId: a.idpOrgId,
    });
    const before = await documentCount('user_avatar', other.userId);
    expect(
      await statusOf(postAs(staff(a, 'finance'), 'user_avatar', other.userId, pngHeaders())),
    ).toBe(403);
    expect(await documentCount('user_avatar', other.userId)).toBe(before);
    expect(await avatarOf(other.userId)).toBeNull();
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('is 413 for an over-cap Content-Length before any row is written', async () => {
    const before = await documentCount('user_avatar', a.userId);
    const headers = { ...pngHeaders(), 'content-length': String(IMAGE_MAX_BYTES + 1) };
    expect(await statusOf(postAs(staff(a), 'user_avatar', a.userId, headers))).toBe(413);
    expect(await documentCount('user_avatar', a.userId)).toBe(before);
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('is 415 for a text/plain body, before any row is written', async () => {
    const before = await documentCount('user_avatar', a.userId);
    const headers = { ...pngHeaders(), 'content-type': 'text/plain' };
    expect(await statusOf(postAs(staff(a), 'user_avatar', a.userId, headers))).toBe(415);
    expect(await documentCount('user_avatar', a.userId)).toBe(before);
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('is 403 for a sales user posting the entity logo, and stores nothing', async () => {
    const before = await documentCount('entity_logo', a.organizationId);
    expect(
      await statusOf(postAs(staff(a, 'sales'), 'entity_logo', a.organizationId, pngHeaders())),
    ).toBe(403);
    expect(await documentCount('entity_logo', a.organizationId)).toBe(before);
    expect(queue.add).not.toHaveBeenCalled();
  });
});
