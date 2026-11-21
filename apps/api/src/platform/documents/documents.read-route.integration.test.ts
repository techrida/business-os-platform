// The generic read routes (GET /v1/documents/:id and POST .../link) admit the read permission an
// owner policy names, not only `documents.read`: the record check accepted `verification.review`
// for case files (U18 #19), but the route's @Can('documents.read') refused the reviewer first.
// End to end over HTTP against real Postgres.
// Real: Postgres 16 (Testcontainers, all migrations as bos_owner, queries as bos_app), the Nest
// controller with the production body-parser setup, `can()` on the request's bound principal, the
// request store (opened and bound per request as the correlation middleware and the tenancy
// interceptor do), requestTx and withTx. The route marker is enforced by a guard making the same
// decision as TenancyInterceptor.enforce (@Can, else @AnyAuthenticated, else deny).
// Fakes: audit and the scan queue; a version's clean verdict is written straight to the row.
// Needs Docker. Run: pnpm --filter @bos/api exec vitest run src/platform/documents/documents.read-route.integration.test.ts
import 'reflect-metadata';

import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import type { AccessScope, OrgKind, Permission } from '@bos/contracts';
import { createTenantWithEntity } from '@bos/db';
import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  type INestApplication,
} from '@nestjs/common';
import { APP_GUARD, Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import type { Queue } from 'bullmq';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { NextFunction, Request, Response } from 'express';
import { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { configureApp } from '../../app.setup';
import { can, type DenyReason, type Principal, type ResourceRef } from '../authz/can';
import { ANY_AUTHENTICATED_KEY, CAN_KEY } from '../authz/decorators';
import { principal } from '../authz/principal';
import { DB, type Db } from '../db/db.module';
import { requestTx, withTx, type TxScope } from '../db/tx';
import { ErrorBodyFilter } from '../tenancy/error-body.filter';
import { bindIdentity, bindPrincipal, runWithRequestStore } from '../tenancy/request-context';
import { DocumentsController } from './documents.controller';
import { DocumentsService } from './documents.service';
import { SignedLinks, type LinkStore } from './signed-link';
import { DiskStorageAdapter } from './storage.adapter';
import { createTestDatabase, type TestDatabase } from '@bos/db/testing';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 180_000 });

const SECRET = 'an-integration-test-secret-of-32-plus-chars';
const PDF = () => Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF\n');

// Three owner types standing for the real ones: vendor files (readPermission vendor.read),
// verification case files (readPermission verification.review) and a memo with no read permission.
const VENDOR_FILES = 'it_vendor_files';
const CASE_FILES = 'it_case_files';
const MEMO = 'it_memo';

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
let service: DocumentsService;
let scope: TxScope;
const idpOrgId = randomUUID();

/** The principal every following HTTP request runs as. */
let caller: Principal;

function callerWith(
  grants: Partial<Record<Permission, AccessScope>>,
  orgKind: OrgKind = 'staff',
): Principal {
  return {
    userId: randomUUID(),
    zitadelUserId: `zitadel-${randomUUID()}`,
    tenantId: scope.tenantId,
    organizationId: scope.organizationId,
    orgKind,
    partyId: orgKind === 'staff' ? null : randomUUID(),
    idpOrgId,
    roles: [],
    departmentId: null,
    status: 'active',
    grants: new Map(Object.entries(grants)) as Map<Permission, AccessScope>,
  };
}

const forbidden = (reason: DenyReason) =>
  new ForbiddenException({ code: 'forbidden', message: 'Forbidden', reason });

/** AuthzService.assert: `can()` on the principal bound to the request, and its 403 body. */
const authz = {
  assert(action: Permission, ref?: ResourceRef): void {
    const decision = can(principal(), action, ref);
    if (!decision.allowed) throw forbidden(decision.reason);
  },
};

/** The same route-level decision as TenancyInterceptor.enforce. */
class RouteMarkerGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const targets = [context.getHandler(), context.getClass()];
    const action = this.reflector.getAllAndOverride<Permission | undefined>(CAN_KEY, targets);
    if (action !== undefined) {
      authz.assert(action);
      return true;
    }
    const anyAuthenticated = this.reflector.getAllAndOverride<boolean | undefined>(
      ANY_AUTHENTICATED_KEY,
      targets,
    );
    if (anyAuthenticated === true) {
      if (principal().status !== 'active') throw forbidden('inactive_user');
      return true;
    }
    throw forbidden('no_permission');
  }
}

/** Runs `fn` in a request store with `p` bound, as the middleware and the interceptor do. */
function inRequest<T>(p: Principal, fn: () => T): T {
  return runWithRequestStore('it-documents-read-route', () => {
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

function bindRequest(_req: Request, _res: Response, next: NextFunction): void {
  inRequest(caller, next);
}

interface Stored {
  documentId: string;
  versionId: string;
}

/** A clean file of `ownerType`, uploaded by someone holding `documents.upload`. */
function cleanFile(ownerType: string): Promise<Stored> {
  return inRequest(callerWith({ 'documents.upload': 'all' }), async () => {
    const { actor } = requestTx();
    const bytes = PDF();
    const c = await withTx(db, scope, actor, (tx) =>
      service.create(tx, {
        ownerType,
        ownerId: randomUUID(),
        filename: 'evidence.pdf',
        declaredMime: 'application/pdf',
        sizeBytes: bytes.length,
      }),
    );
    await service.receiveContent(c.versionId, Readable.from(bytes), bytes.length, {
      documentId: c.documentId,
    });
    // The verdict a scan would have written; through withTx: the audit trigger needs an actor.
    await withTx(db, scope, actor, async (tx) => {
      await tx.execute(
        sql`UPDATE app.document_versions SET status = 'clean' WHERE id = ${c.versionId}`,
      );
      await tx.execute(
        sql`UPDATE app.documents SET current_version_id = ${c.versionId}
          WHERE id = ${c.documentId}`,
      );
    });
    return { documentId: c.documentId, versionId: c.versionId };
  });
}

const getDoc = (documentId: string) => request(baseUrl).get(`/v1/documents/${documentId}`);
const linkTo = (f: Stored) =>
  request(baseUrl).post(`/v1/documents/${f.documentId}/versions/${f.versionId}/link`);
const reasonOf = (body: unknown) => (body as { error?: { reason?: unknown } }).error?.reason;

let vendorFile: Stored;
let caseFile: Stored;
let memoFile: Stored;

beforeAll(async () => {
  testDb = await createTestDatabase();
  const admin = new Pool({ connectionString: testDb.adminUrl, max: 1 });
  await admin.end();
  const bosAdmin = new Pool({ connectionString: testDb.adminUrl, max: 1 });
  await bosAdmin.end();
  pool = new Pool({ connectionString: testDb.appUrl, max: 8 });
  db = drizzle({ client: pool });

  const tenant = await createTenantWithEntity(pool);
  scope = { tenantId: tenant.tenantId, organizationId: tenant.organizationId };

  storageRoot = await mkdtemp(join(tmpdir(), 'bos-docs-read-route-'));
  service = new DocumentsService(
    db,
    new DiskStorageAdapter(storageRoot),
    new SignedLinks(SECRET, new MemoryStore(), () => Date.now()),
    { add: vi.fn().mockResolvedValue({}) } as unknown as Queue,
    authz,
    { record: vi.fn().mockResolvedValue(undefined) },
  );
  // Each owner is a record of the acting entity owned by someone else: an `all` grant reaches it.
  const resource = (s: TxScope): Promise<ResourceRef> =>
    Promise.resolve({
      tenantId: s.tenantId,
      organizationId: s.organizationId,
      ownerUserId: randomUUID(),
    });
  service.registerOwner({ ownerType: VENDOR_FILES, readPermission: 'vendor.read', resource });
  service.registerOwner({ ownerType: CASE_FILES, readPermission: 'verification.review', resource });
  service.registerOwner({ ownerType: MEMO, resource });

  const moduleRef = await Test.createTestingModule({
    controllers: [DocumentsController],
    providers: [
      { provide: DocumentsService, useValue: service },
      { provide: DB, useValue: db },
      {
        provide: APP_GUARD,
        useFactory: (reflector: Reflector) => new RouteMarkerGuard(reflector),
        inject: [Reflector],
      },
    ],
  }).compile();
  app = moduleRef.createNestApplication({ rawBody: true, logger: false });
  app.use(bindRequest);
  configureApp(app);
  app.useGlobalFilters(new ErrorBodyFilter());
  await app.listen(0, '127.0.0.1');
  baseUrl = `http://127.0.0.1:${((app.getHttpServer() as Server).address() as AddressInfo).port}`;

  vendorFile = await cleanFile(VENDOR_FILES);
  caseFile = await cleanFile(CASE_FILES);
  memoFile = await cleanFile(MEMO);
});

afterAll(async () => {
  await app?.close();
  await pool?.end();
  await testDb?.drop();
  if (storageRoot) await rm(storageRoot, { recursive: true, force: true });
});

describe('the generic read routes and owner read permissions', () => {
  it('carry @AnyAuthenticated and no @Can, so the handler makes the grant check', () => {
    const proto = DocumentsController.prototype;
    for (const handler of [proto.get, proto.link]) {
      expect(Reflect.getMetadata(ANY_AUTHENTICATED_KEY, handler)).toBe(true);
      expect(Reflect.getMetadata(CAN_KEY, handler)).toBeUndefined();
    }
  });

  // Fails on the old code: @Can('documents.read') refused the reviewer before the record check ran.
  it('opens a case file and its link for a role holding only verification.review', async () => {
    caller = callerWith({ 'verification.review': 'all' });
    const res = await getDoc(caseFile.documentId);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ id: caseFile.documentId, ownerType: CASE_FILES });
    const link = await linkTo(caseFile);
    expect(link.status, JSON.stringify(link.body)).toBe(200);
    expect((link.body as { url: string }).url).toMatch(/^\/v1\/files\//);
  });

  it('opens a vendor file and its link for a custom role holding only vendor.read', async () => {
    caller = callerWith({ 'vendor.read': 'all' });
    expect((await getDoc(vendorFile.documentId)).status).toBe(200);
    expect((await linkTo(vendorFile)).status).toBe(200);
  });

  it('reaches no other owner type: vendor.read opens no case file and no memo', async () => {
    caller = callerWith({ 'vendor.read': 'all' });
    for (const f of [caseFile, memoFile]) {
      const res = await getDoc(f.documentId);
      expect(res.status).toBe(403);
      expect(reasonOf(res.body)).toBe('no_permission');
      expect((await linkTo(f)).status).toBe(403);
    }
  });

  it('still opens every owner type with documents.read', async () => {
    caller = callerWith({ 'documents.read': 'all' });
    for (const f of [vendorFile, caseFile, memoFile]) {
      expect((await getDoc(f.documentId)).status).toBe(200);
      expect((await linkTo(f)).status).toBe(200);
    }
  });

  it('refuses a role holding none of them with 403 before reading, for any id', async () => {
    caller = callerWith({ 'crm.lead.read': 'all' });
    for (const id of [caseFile.documentId, randomUUID(), 'not-a-uuid']) {
      const res = await getDoc(id);
      expect(res.status, id).toBe(403);
      expect(reasonOf(res.body)).toBe('no_permission');
    }
    const link = await request(baseUrl).post(`/v1/documents/${randomUUID()}/versions/x/link`);
    expect(link.status).toBe(403);
    expect(reasonOf(link.body)).toBe('no_permission');
  });

  it('checks a portal caller against documents.read alone (owner reads are staff)', async () => {
    caller = callerWith({ 'vendor.read': 'all', 'verification.review': 'all' }, 'vendor');
    for (const f of [vendorFile, caseFile]) {
      const res = await getDoc(f.documentId);
      expect(res.status).toBe(403);
      expect(reasonOf(res.body)).toBe('no_permission');
      expect((await linkTo(f)).status).toBe(403);
    }
  });

  it('refuses an inactive caller who holds the grant', async () => {
    caller = { ...callerWith({ 'verification.review': 'all' }), status: 'inactive' };
    expect((await getDoc(caseFile.documentId)).status).toBe(403);
  });
});
