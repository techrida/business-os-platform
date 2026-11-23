// Integration test of the vendors service (P4 V1) on a real Postgres (Testcontainers, needs Docker in WSL).
// Real parts: every migration as bos_owner, queries as bos_app, VendorsController, VendorsService, the real
// VerificationService and VerificationController, AuditService and the pure can(). The vendor adapter is
// registered the way VendorsModule does it (VendorPartyOwnerRegistrar).
// Run: pnpm --filter @bos/api exec vitest run src/modules/vendors/vendors.integration.test.ts
// supertest bodies are `any`; the assertions below read them directly, as the HTTP contract is what is under test.
/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call */
import 'reflect-metadata';

import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import {
  DEFAULT_ROLE_PERMISSIONS,
  VendorAccountDtoSchema,
  VendorDtoSchema,
  VerificationCaseDtoSchema,
  type Permission,
  type RoleKey,
  type Scope,
  type VendorDto,
} from '@bos/contracts';
import { createParty, createStaffUser, createTenantWithEntity } from '@bos/db';
import { ForbiddenException, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool, type PoolClient } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { configureApp } from '../../app.setup';
import { AuditService } from '../../platform/audit/audit.service';
import { can } from '../../platform/authz/can';
import type { AuthzService } from '../../platform/authz/authz.service';
import type { Principal } from '../../platform/authz/principal';
import type { Db } from '../../platform/db/db.module';
import { ErrorBodyFilter } from '../../platform/tenancy/error-body.filter';
import { VerificationController } from '../verification/verification.controller';
import { VerificationService } from '../verification/verification.service';
import { VendorKycExpiryService } from './vendor-kyc-expiry.service';
import { VendorsController } from './vendors.controller';
import { VendorPartyOwnerRegistrar } from './vendors.module';
import { VendorsService } from './vendors.service';
import { createTestDatabase, type TestDatabase } from '@bos/db/testing';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 180_000 });

let testDb: TestDatabase;
let ownerPool: Pool;
let appPool: Pool;
let db: Db;
let app: INestApplication;
let baseUrl: string;
let service: VendorsService;
let expiry: VendorKycExpiryService;
let tenantId: string;
let orgA: string;
let orgB: string;
let staffIdpOrgId: string;

const U = {} as Record<'founder' | 'procurement' | 'accountant', string>;

const grantsOf = (role: RoleKey) =>
  new Map(Object.entries(DEFAULT_ROLE_PERMISSIONS[role])) as Map<Permission, Scope>;
const current: { userId: string; role: RoleKey; organizationId: string } = {
  userId: '',
  role: 'founder',
  organizationId: '',
};
const as = (key: keyof typeof U, role: RoleKey, organizationId = orgA) => {
  current.userId = U[key];
  current.role = role;
  current.organizationId = organizationId;
};

const scopeNow = () => ({ tenantId, organizationId: current.organizationId });
const principalNow = (): Principal => ({
  userId: current.userId,
  zitadelUserId: `z-${current.userId}`,
  ...scopeNow(),
  orgKind: 'staff',
  partyId: null,
  idpOrgId: staffIdpOrgId,
  roles: [],
  departmentId: null,
  status: 'active',
  grants: grantsOf(current.role),
});
const caller = {
  current: () => ({
    scope: scopeNow(),
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

/** A transaction as bos_owner with the bos.* settings the audit triggers need (the fixtures do the same). */
async function ownerTx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await ownerPool.connect();
  try {
    await client.query('BEGIN');
    for (const [k, v] of Object.entries({
      'bos.tenant_id': tenantId,
      'bos.organization_id': orgA,
      'bos.actor_kind': 'system',
      'bos.actor_id': 'system:test',
      'bos.correlation_id': `test:${randomUUID()}`,
      'bos.ip': '',
      'bos.user_agent': '',
    })) {
      await client.query('SELECT set_config($1, $2, true)', [k, v]);
    }
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

beforeAll(async () => {
  testDb = await createTestDatabase();
  const admin0 = new Pool({ connectionString: testDb.adminUrl, max: 1 });
  await admin0.end();
  const bosAdmin = new Pool({ connectionString: testDb.adminUrl, max: 1 });
  await bosAdmin.end();

  ownerPool = new Pool({ connectionString: testDb.ownerUrl, max: 2 });
  appPool = new Pool({ connectionString: testDb.appUrl, max: 6 });
  db = drizzle({ client: appPool });

  const tenant = await createTenantWithEntity(appPool);
  tenantId = tenant.tenantId;
  orgA = tenant.organizationId;
  staffIdpOrgId = tenant.idpOrgId;
  orgB = randomUUID();
  await ownerTx(async (client) => {
    await client.query(
      `INSERT INTO app.organizations (id, tenant_id, organization_id, code, name, legal_name, is_default)
       VALUES ($1, $2, $1, 'ENT-B', 'Entity B', 'Entity B', false)`,
      [orgB, tenantId],
    );
  });
  for (const key of ['founder', 'procurement', 'accountant'] as const) {
    U[key] = (
      await createStaffUser(appPool, { tenantId, organizationId: orgA, idpOrgId: tenant.idpOrgId })
    ).userId;
  }
  // The founder may act for entity B as well; the procurement officer may not.
  await ownerTx(async (client) => {
    await client.query(
      `INSERT INTO app.user_entities (tenant_id, organization_id, user_id, is_default) VALUES ($1, $2, $3, false)`,
      [tenantId, orgB, U.founder],
    );
  });

  const verification = new VerificationService(
    db,
    // Opening a case never touches documents; Nest calls onModuleInit, which registers an owner policy.
    { registerOwner: vi.fn() } as never,
    authz as unknown as AuthzService,
    new AuditService(db),
    caller,
  );
  // What VendorsModule does when it starts.
  new VendorPartyOwnerRegistrar(verification).onModuleInit();
  service = new VendorsService(
    db,
    authz as unknown as AuthzService,
    caller,
    verification,
    new AuditService(db),
  );
  expiry = new VendorKycExpiryService(db, new AuditService(db));
  const moduleRef = await Test.createTestingModule({
    controllers: [VendorsController, VerificationController],
    providers: [
      { provide: VendorsService, useValue: service },
      { provide: VerificationService, useValue: verification },
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
  await appPool?.end();
  await ownerPool?.end();
  await testDb?.drop();
});

beforeEach(() => as('founder', 'founder'));

// ---------------------------------------------------------------------------------------------- helpers

const api = () => request(baseUrl);
let panCounter = 100_000_000;
const nextPan = () => String(panCounter++);
const idem = () => ({ 'Idempotency-Key': randomUUID() });

async function createVendor(
  overrides: Record<string, unknown> = {},
  key: string = randomUUID(),
): Promise<request.Response> {
  return api()
    .post('/v1/vendors')
    .set('Idempotency-Key', key)
    .send({
      legalName: 'Himal Traders Pvt Ltd',
      kind: 'company',
      pan: nextPan(),
      vatRegistered: true,
      country: 'NP',
      ...overrides,
    });
}

/** A vendor created by `creator` (default: procurement), parsed against the contract. */
async function newVendor(creator: [keyof typeof U, RoleKey] = ['procurement', 'procurement']) {
  as(creator[0], creator[1]);
  const res = await createVendor();
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  const dto: VendorDto = VendorDtoSchema.parse(res.body);
  as('founder', 'founder');
  return dto;
}

/** Sets the KYB case of a vendor to a status (the case flow itself is tested in the verification files). */
async function setCase(
  partyId: string,
  status: 'submitted' | 'approved',
  taxClearanceExpiresOn = '2099-01-01',
) {
  await ownerTx(async (client) => {
    await client.query(
      `UPDATE app.verification_cases
          SET status = $2, submitted_by_user_id = $3, submitted_at = now(),
              reviewer_user_id = $4, decided_at = $5, checklist = $6::jsonb
        WHERE tenant_id = $1 AND party_id = $7`,
      [
        tenantId,
        status,
        U.accountant,
        status === 'approved' ? U.founder : null,
        status === 'approved' ? new Date() : null,
        JSON.stringify([
          {
            key: 'tax_clearance',
            required: true,
            status: status === 'approved' ? 'accepted' : 'provided',
            documentId: randomUUID(),
            expiresOn: taxClearanceExpiresOn,
          },
        ]),
        partyId,
      ],
    );
  });
}

const post = (path: string, body?: unknown) =>
  api()
    .post(path)
    .set(idem())
    .send(body ?? {});

const rowOf = async <T extends object>(sqlText: string, params: unknown[]): Promise<T[]> =>
  (await ownerPool.query(sqlText, params)).rows as T[];

/** draft -> pending_kyc -> under_review, by `procurement`, with the KYB case set to submitted. */
async function toUnderReview(v: VendorDto) {
  as('procurement', 'procurement');
  expect((await post(`/v1/vendors/${v.id}/submit-kyc`)).status).toBe(200);
  await setCase(v.id, 'submitted');
  const res = await post(`/v1/vendors/${v.id}/submit-kyc`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  expect(res.body.status).toBe('under_review');
  as('founder', 'founder');
}

// -------------------------------------------------------------------------------------------------- tests

describe('create', () => {
  it('writes party (vendor), vendor and the account of the acting entity in one transaction', async () => {
    as('procurement', 'procurement');
    const res = await createVendor({ kind: 'sole_proprietor' });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const dto = VendorDtoSchema.parse(res.body);
    expect(dto).toMatchObject({
      status: 'draft',
      kind: 'sole_proprietor',
      version: 1,
      logoDocumentId: null,
    });

    const party = await rowOf<{ kind: string; code: string }>(
      'SELECT kind, code FROM app.parties WHERE id = $1',
      [dto.id],
    );
    expect(party).toEqual([{ kind: 'vendor', code: expect.stringMatching(/^VEN-[0-9A-F]{12}$/) }]);
    const vendor = await rowOf<{ kind: string; created_by: string; owner_user_id: string }>(
      'SELECT kind, created_by, owner_user_id FROM app.vendors WHERE id = $1',
      [dto.id],
    );
    expect(vendor).toEqual([
      { kind: 'proprietor', created_by: U.procurement, owner_user_id: U.procurement },
    ]);
    const accounts = await rowOf<{ organization_id: string; default_currency: string }>(
      'SELECT organization_id, default_currency FROM app.vendor_accounts WHERE vendor_id = $1',
      [dto.id],
    );
    expect(accounts).toEqual([{ organization_id: orgA, default_currency: 'NPR' }]);
  });

  it('replays the same Idempotency-Key without a second vendor, and refuses a missing key', async () => {
    const key = randomUUID();
    const body = { legalName: 'Replay Co', pan: nextPan() };
    const first = await createVendor(body, key);
    const second = await createVendor(body, key);
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body.id).toBe(first.body.id);
    const rows = await rowOf('SELECT 1 FROM app.vendors WHERE pan = $1', [body.pan]);
    expect(rows).toHaveLength(1);
    const noKey = await api().post('/v1/vendors').send({ legalName: 'x' });
    expect(noKey.status).toBe(400);
  });

  it('answers 409 for a PAN another vendor of the tenant holds, also when two creates race', async () => {
    const pan = nextPan();
    expect((await createVendor({ pan })).status).toBe(201);
    const dup = await createVendor({ pan, legalName: 'Same PAN Again' });
    expect(dup.status, JSON.stringify(dup.body)).toBe(409);
    expect(dup.body.error.code).toBe('duplicate_pan_vat');
    expect(dup.body.error.message).toMatch(/PAN .* already exists/);

    const racePan = nextPan();
    const results = await Promise.all([
      createVendor({ pan: racePan }),
      createVendor({ pan: racePan }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(await rowOf('SELECT 1 FROM app.vendors WHERE pan = $1', [racePan])).toHaveLength(1);
  });

  it('answers 400 for a foreign vendor with country NP, and 201 for a real foreign vendor without a PAN', async () => {
    const bad = await createVendor({ kind: 'foreign', country: 'NP' });
    expect(bad.status).toBe(400);
    const ok = await createVendor({ kind: 'foreign', country: 'IN', pan: undefined });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(ok.body.pan).toBeNull();
  });

  it('answers 400 for a domestic vendor whose PAN is not nine digits (FX8)', async () => {
    for (const pan of ['12345', 'AB1234567', '12345678901']) {
      const res = await createVendor({ pan });
      expect(res.status, JSON.stringify(res.body)).toBe(400);
    }
  });

  it('is refused without vendor.write (accountant)', async () => {
    as('accountant', 'accountant');
    expect((await createVendor()).status).toBe(403);
  });
});

describe('same-name warning (TR-Q12d)', () => {
  const add = async (legalName: string) => {
    const res = await createVendor({ legalName });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return VendorDtoSchema.parse(res.body);
  };
  const matchesFor = async (legalName: string) => {
    const res = await api().get('/v1/vendors/name-matches').query({ legalName });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return (res.body as { matches: { id: string; legalName: string; status: string }[] }).matches;
  };

  it('lists vendors whose name matches once case, spaces, punctuation and company words are ignored', async () => {
    as('procurement', 'procurement');
    const tag = `Dup${randomUUID().slice(0, 6)}`;
    const first = await add(`${tag} Hardware Traders Pvt. Ltd.`);
    await add(`${tag} Other Supplies`);
    const found = await matchesFor(`  ${tag.toLowerCase()}   hardware-traders private limited `);
    expect(found).toEqual([
      { id: first.id, legalName: `${tag} Hardware Traders Pvt. Ltd.`, status: 'draft' },
    ]);
    expect(await matchesFor(`${tag} Hardware`)).toEqual([]);
    // A name with nothing to match on matches nothing; an empty name is a 400.
    expect(await matchesFor('...')).toEqual([]);
    expect((await api().get('/v1/vendors/name-matches').query({ legalName: ' ' })).status).toBe(
      400,
    );
  });

  it('still creates the namesake, and the audit trail names the vendors it shares its name with', async () => {
    as('procurement', 'procurement');
    const tag = `Aud${randomUUID().slice(0, 6)}`;
    const first = await add(`${tag} Traders`);
    const firstAudit = await rowOf<{ meta: unknown }>(
      `SELECT meta FROM audit.audit_events WHERE tenant_id = $1 AND entity_id = $2 AND action = 'vendor.created_with_same_name'`,
      [tenantId, first.id],
    );
    expect(firstAudit).toEqual([]);

    const second = await add(`${tag.toUpperCase()} TRADERS PVT LTD`);
    expect(second.status).toBe('draft');
    const rows = await rowOf<{ meta: { sameNameVendorIds: string[] } }>(
      `SELECT meta FROM audit.audit_events WHERE tenant_id = $1 AND entity_id = $2 AND action = 'vendor.created_with_same_name'`,
      [tenantId, second.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.meta.sameNameVendorIds).toEqual([first.id]);
  });
});

describe('list', () => {
  const mint = async (legalName: string, overrides: Record<string, unknown> = {}) => {
    const res = await createVendor({ legalName, ...overrides });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return VendorDtoSchema.parse(res.body);
  };
  type Page = { items: { id: string }[]; total: number };

  it('filters by repeated status and kind, pages with the total of the filtered rows', async () => {
    const tag = `Lst${randomUUID().slice(0, 6)}`;
    const company = await mint(`${tag} Alpha Pvt Ltd`);
    const sole = await mint(`${tag} Beta`, { kind: 'sole_proprietor' });
    await mint(`${tag} Gamma`, { kind: 'individual' });

    const kinds = await api()
      .get('/v1/vendors')
      .query({ q: tag, kind: ['company', 'sole_proprietor'], status: ['draft', 'approved'] });
    expect(kinds.status, JSON.stringify(kinds.body)).toBe(200);
    expect((kinds.body as Page).items.map((v) => v.id).sort()).toEqual(
      [company.id, sole.id].sort(),
    );
    expect((kinds.body as Page).total).toBe(2);

    const paged = await api().get('/v1/vendors').query({ q: tag, limit: 1, offset: 1 });
    expect((paged.body as Page).items).toHaveLength(1);
    expect((paged.body as Page).total).toBe(3);

    expect((await api().get('/v1/vendors').query({ status: 'gone' })).status).toBe(400);
    expect(
      (
        await api()
          .get('/v1/vendors')
          .query({ kind: ['company', 'x'] })
      ).status,
    ).toBe(400);
  });

  it('finds a misspelt name', async () => {
    const tag = randomUUID().slice(0, 4);
    const v = await mint(`Himalyan Supplies ${tag} Pvt Ltd`);
    const fuzzy = await api().get('/v1/vendors').query({ q: 'Himalayan' });
    expect((fuzzy.body as Page).items.map((x) => x.id)).toContain(v.id);
  });
});

describe('edit', () => {
  it('uses expectedVersion (stale is 409) and locks the tax identity of an approved vendor', async () => {
    const v = await newVendor();
    const ok = await api()
      .patch(`/v1/vendors/${v.id}`)
      .send({ expectedVersion: 1, vatRegistered: false });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body).toMatchObject({ vatRegistered: false, version: 2 });
    const stale = await api()
      .patch(`/v1/vendors/${v.id}`)
      .send({ expectedVersion: 1, vatRegistered: true });
    expect(stale.status).toBe(409);

    await toUnderReview(v);
    await setCase(v.id, 'approved');
    expect((await post(`/v1/vendors/${v.id}/activate`)).status).toBe(200);
    const locked = await api()
      .get(`/v1/vendors/${v.id}`)
      .then((r) => r.body.version as number)
      .then((version) =>
        api().patch(`/v1/vendors/${v.id}`).send({ expectedVersion: version, legalName: 'Renamed' }),
      );
    expect(locked.status).toBe(409);
    expect(locked.body.error.message).toMatch(/cannot be edited/);
  });

  it('answers 404 for an unknown vendor', async () => {
    expect((await api().get(`/v1/vendors/${randomUUID()}`)).status).toBe(404);
  });
});

describe('D10: the kind and country of a vendor can be edited', () => {
  const patchVendor = (id: string, body: Record<string, unknown>) =>
    api().patch(`/v1/vendors/${id}`).send(body);
  const auditOf = (id: string) =>
    rowOf<{ before: Record<string, unknown>; after: Record<string, unknown> }>(
      `SELECT before, after FROM audit.audit_events
        WHERE tenant_id = $1 AND entity_id = $2 AND action = 'vendor.kind_country_changed' ORDER BY id`,
      [tenantId, id],
    );

  it('moves a Nepal company to a foreign vendor, keeps its PAN, and audits the old and new kind and country', async () => {
    const v = await newVendor();
    const res = await patchVendor(v.id, {
      expectedVersion: v.version,
      kind: 'foreign',
      country: 'IN',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(VendorDtoSchema.parse(res.body)).toMatchObject({
      kind: 'foreign',
      country: 'IN',
      pan: v.pan,
      version: v.version + 1,
    });
    const [row] = await rowOf<{ kind: string; country: string }>(
      'SELECT kind, country FROM app.vendors WHERE id = $1',
      [v.id],
    );
    expect(row).toEqual({ kind: 'foreign', country: 'IN' });
    expect(await auditOf(v.id)).toEqual([
      { before: { kind: 'company', country: 'NP' }, after: { kind: 'foreign', country: 'IN' } },
    ]);
  });

  it('switching a foreign vendor to Nepal asks for a PAN: 400, nothing changed, then 200 with one', async () => {
    const foreign = await createVendor({ kind: 'foreign', country: 'DE', pan: undefined });
    expect(foreign.status, JSON.stringify(foreign.body)).toBe(201);
    const { id, version } = foreign.body as VendorDto;
    const noPan = await patchVendor(id, {
      expectedVersion: version,
      kind: 'company',
      country: 'NP',
    });
    expect(noPan.status, JSON.stringify(noPan.body)).toBe(400);
    expect(noPan.body.error.message).toMatch(/PAN is required/);
    const shortPan = await patchVendor(id, {
      expectedVersion: version,
      kind: 'company',
      country: 'NP',
      pan: '12345',
    });
    expect(shortPan.status).toBe(400);
    expect(shortPan.body.error.message).toMatch(/9 digits/);
    const [untouched] = await rowOf<{ kind: string; country: string; version: number }>(
      'SELECT kind, country, version FROM app.vendors WHERE id = $1',
      [id],
    );
    expect(untouched).toEqual({ kind: 'foreign', country: 'DE', version });
    expect(await auditOf(id)).toEqual([]);

    const pan = nextPan();
    const ok = await patchVendor(id, {
      expectedVersion: version,
      kind: 'company',
      country: 'NP',
      pan,
    });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body).toMatchObject({ kind: 'company', country: 'NP', pan });
    expect(await auditOf(id)).toEqual([
      {
        before: { kind: 'foreign', country: 'DE', pan: null },
        after: { kind: 'company', country: 'NP', pan },
      },
    ]);
  });

  it('a stored loose foreign tax id is not a Nepal PAN: switching to Nepal without a new PAN is refused', async () => {
    const foreign = await createVendor({ kind: 'foreign', country: 'DE', pan: 'DE-70000001' });
    const { id, version } = foreign.body as VendorDto;
    const res = await patchVendor(id, {
      expectedVersion: version,
      kind: 'individual',
      country: 'NP',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(res.body.error.message).toMatch(/9 digits/);
  });

  it('refuses a pair the foreign rule forbids, whatever half was sent', async () => {
    const v = await newVendor();
    const kindOnly = await patchVendor(v.id, { expectedVersion: v.version, kind: 'foreign' });
    expect(kindOnly.status, JSON.stringify(kindOnly.body)).toBe(400);
    expect(kindOnly.body.error.message).toMatch(/foreign vendor cannot have country NP/);
    const countryOnly = await patchVendor(v.id, { expectedVersion: v.version, country: 'IN' });
    expect(countryOnly.status).toBe(400);
    expect(countryOnly.body.error.message).toMatch(/must have kind foreign/);
    const wrongPair = await patchVendor(v.id, {
      expectedVersion: v.version,
      kind: 'company',
      country: 'IN',
    });
    expect(wrongPair.status).toBe(400);
  });

  it('changes between Nepal kinds (company to sole proprietor) with the PAN it has', async () => {
    const v = await newVendor();
    const res = await patchVendor(v.id, { expectedVersion: v.version, kind: 'sole_proprietor' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ kind: 'sole_proprietor', country: 'NP', pan: v.pan });
    expect(await auditOf(v.id)).toEqual([
      {
        before: { kind: 'company', country: 'NP' },
        after: { kind: 'sole_proprietor', country: 'NP' },
      },
    ]);
  });

  it('sending the kind and country it already has changes and audits nothing about them', async () => {
    const v = await newVendor();
    const res = await patchVendor(v.id, {
      expectedVersion: v.version,
      kind: 'company',
      country: 'NP',
      vatRegistered: false,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await auditOf(v.id)).toEqual([]);
  });

  it('answers 409 for a PAN another vendor holds when the switch brings one', async () => {
    const other = await newVendor();
    const foreign = await createVendor({ kind: 'foreign', country: 'DE', pan: undefined });
    const { id, version } = foreign.body as VendorDto;
    const res = await patchVendor(id, {
      expectedVersion: version,
      kind: 'company',
      country: 'NP',
      pan: other.pan,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(409);
  });

  it('is open while the vendor is in KYB review, and locked once it is approved (new KYB review needed)', async () => {
    const v = await newVendor();
    await toUnderReview(v);
    const inReview = await patchVendor(v.id, {
      expectedVersion: (await api().get(`/v1/vendors/${v.id}`)).body.version,
      kind: 'foreign',
      country: 'IN',
    });
    expect(inReview.status, JSON.stringify(inReview.body)).toBe(200);
    // R6AA: an identity change in review sends the vendor back to pending_kyc; it goes through review again.
    expect(inReview.body.status).toBe('pending_kyc');
    await setCase(v.id, 'approved');
    as('procurement', 'procurement');
    expect((await post(`/v1/vendors/${v.id}/submit-kyc`)).status).toBe(200);
    as('founder', 'founder');
    expect((await post(`/v1/vendors/${v.id}/activate`)).status).toBe(200);
    const version = (await api().get(`/v1/vendors/${v.id}`)).body.version as number;
    const locked = await patchVendor(v.id, {
      expectedVersion: version,
      kind: 'foreign',
      country: 'US',
    });
    expect(locked.status, JSON.stringify(locked.body)).toBe(409);
    expect(locked.body.error.code).toBe('vendor_identity_locked');
    expect(locked.body.error.message).not.toMatch(/KYB review/);
    // The kind and country it already has are not a change, so an approved vendor's other edits still work.
    const same = await patchVendor(v.id, {
      expectedVersion: version,
      kind: 'foreign',
      country: 'IN',
      vatRegistered: false,
    });
    expect(same.status, JSON.stringify(same.body)).toBe(200);
  });
});

describe('R6AA: an identity edit before approval voids the KYB case; a foreign vendor may clear its PAN', () => {
  const patchVendor = (id: string, body: Record<string, unknown>) =>
    api().patch(`/v1/vendors/${id}`).send(body);
  const current = async (id: string) =>
    VendorDtoSchema.parse((await api().get(`/v1/vendors/${id}`)).body);
  const caseRow = async (id: string) =>
    (
      await rowOf<{ status: string; checklist: { status: string; documentId: string | null }[] }>(
        'SELECT status, checklist FROM app.verification_cases WHERE tenant_id = $1 AND party_id = $2',
        [tenantId, id],
      )
    )[0];
  const resetAudit = (id: string) =>
    rowOf<{ before: Record<string, unknown>; after: Record<string, unknown> }>(
      `SELECT before, after FROM audit.audit_events
        WHERE tenant_id = $1 AND entity_id = $2 AND action = 'vendor.kyb_reset' ORDER BY id`,
      [tenantId, id],
    );

  it('a legal-name edit while the case is submitted sends the vendor to pending_kyc and the case to an empty draft', async () => {
    const v = await newVendor();
    as('procurement', 'procurement');
    expect((await post(`/v1/vendors/${v.id}/submit-kyc`)).status).toBe(200);
    await setCase(v.id, 'submitted');
    as('founder', 'founder');
    const res = await patchVendor(v.id, {
      expectedVersion: (await current(v.id)).version,
      legalName: 'Renamed Traders Pvt Ltd',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.status).toBe('pending_kyc');
    const c = await caseRow(v.id);
    expect(c?.status).toBe('draft');
    expect(c?.checklist.every((i) => i.status === 'missing' && i.documentId === null)).toBe(true);
    const [audit] = await resetAudit(v.id);
    expect(audit?.before).toMatchObject({ status: 'pending_kyc', legalName: v.legalName });
    expect(audit?.after).toMatchObject({
      status: 'pending_kyc',
      legalName: 'Renamed Traders Pvt Ltd',
    });
    // The vendor cannot be sent for review until the documents are back and submitted.
    as('procurement', 'procurement');
    const again = await post(`/v1/vendors/${v.id}/submit-kyc`);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('kyb_not_submitted');
  });

  it('a PAN edit while under review with an approved case returns the vendor to pending_kyc and voids the approval', async () => {
    const v = await newVendor();
    await toUnderReview(v);
    await setCase(v.id, 'approved');
    const res = await patchVendor(v.id, {
      expectedVersion: (await current(v.id)).version,
      pan: nextPan(),
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.status).toBe('pending_kyc');
    const c = await caseRow(v.id);
    expect(c?.status).toBe('draft');
    expect(c?.checklist.every((i) => i.status === 'missing')).toBe(true);
    as('founder', 'founder');
    expect((await post(`/v1/vendors/${v.id}/activate`)).status).toBe(409);
  });

  it('an edit that leaves the identity alone keeps the review and the case', async () => {
    const v = await newVendor();
    await toUnderReview(v);
    const res = await patchVendor(v.id, {
      expectedVersion: (await current(v.id)).version,
      vatRegistered: false,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.status).toBe('under_review');
    expect((await caseRow(v.id))?.status).toBe('submitted');
    expect(await resetAudit(v.id)).toHaveLength(0);
  });

  it('a draft vendor holding an approved case loses it on an identity edit', async () => {
    const v = await newVendor();
    as('procurement', 'procurement');
    expect((await api().post('/v1/verification-cases').send({ partyId: v.id })).status).toBe(201);
    await setCase(v.id, 'approved');
    const res = await patchVendor(v.id, {
      expectedVersion: (await current(v.id)).version,
      pan: nextPan(),
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.status).toBe('draft');
    expect((await caseRow(v.id))?.status).toBe('draft');
  });

  it('an identity edit on a draft vendor opens no KYB case', async () => {
    const v = await newVendor();
    const res = await patchVendor(v.id, {
      expectedVersion: v.version,
      legalName: 'Draft Rename Pvt Ltd',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.status).toBe('draft');
    expect(await caseRow(v.id)).toBeUndefined();
  });

  it('an approved vendor stays locked, with a sentence that names no review path', async () => {
    const v = await newVendor();
    await toUnderReview(v);
    await setCase(v.id, 'approved');
    expect((await post(`/v1/vendors/${v.id}/activate`)).status).toBe(200);
    const res = await patchVendor(v.id, {
      expectedVersion: (await current(v.id)).version,
      legalName: 'Locked Rename Pvt Ltd',
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('vendor_identity_locked');
    expect(res.body.error.message).toMatch(/cannot be edited/);
    expect(res.body.error.message).not.toMatch(/review/i);
    expect((await caseRow(v.id))?.status).toBe('approved');
  });

  it('a foreign vendor may clear its PAN; a Nepal vendor may not', async () => {
    const foreign = await createVendor({ kind: 'foreign', country: 'DE', pan: 'DE12345678' });
    expect(foreign.status, JSON.stringify(foreign.body)).toBe(201);
    const cleared = await patchVendor(foreign.body.id, {
      expectedVersion: foreign.body.version,
      pan: null,
    });
    expect(cleared.status, JSON.stringify(cleared.body)).toBe(200);
    expect(cleared.body.pan).toBeNull();

    const nepal = await newVendor();
    const refused = await patchVendor(nepal.id, { expectedVersion: nepal.version, pan: null });
    expect(refused.status, JSON.stringify(refused.body)).toBe(400);
    expect((await current(nepal.id)).pan).toBe(nepal.pan);
  });

  it('a PATCH that repeats the stored values writes nothing and keeps the version', async () => {
    const v = await newVendor();
    const res = await patchVendor(v.id, {
      expectedVersion: v.version,
      kind: v.kind,
      country: v.country,
      legalName: v.legalName,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.version).toBe(v.version);
    expect((await current(v.id)).version).toBe(v.version);
    const stale = await patchVendor(v.id, { expectedVersion: v.version + 5, kind: v.kind });
    expect(stale.status).toBe(409);
  });
});

describe('the vendor KYB case through the registered adapter', () => {
  it('opens for a vendor with vendor.write, is refused without it, and is 404 for a customer party', async () => {
    const v = await newVendor();
    as('procurement', 'procurement');
    const opened = await api().post('/v1/verification-cases').send({ partyId: v.id });
    expect(opened.status, JSON.stringify(opened.body)).toBe(201);
    expect(VerificationCaseDtoSchema.parse(opened.body).partyId).toBe(v.id);
    const [kind] = await rowOf<{ party_kind: string }>(
      'SELECT party_kind FROM app.verification_cases WHERE party_id = $1',
      [v.id],
    );
    expect(kind?.party_kind).toBe('vendor');

    const other = await newVendor();
    as('accountant', 'accountant');
    expect((await api().post('/v1/verification-cases').send({ partyId: other.id })).status).toBe(
      403,
    );

    const customer = (await createParty(appPool, { tenantId, kind: 'customer' })).partyId;
    as('procurement', 'procurement');
    // A customer party has no vendor row, and the vendor adapter is not asked for it: the customer adapter is.
    const res = await api().post('/v1/verification-cases').send({ partyId: customer });
    expect(res.status).toBe(404);
  });
});

describe('lifecycle and activation', () => {
  it('moves draft -> pending_kyc (opening the KYB case) -> under_review once the case is submitted', async () => {
    const v = await newVendor();
    as('procurement', 'procurement');
    const first = await post(`/v1/vendors/${v.id}/submit-kyc`);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body.status).toBe('pending_kyc');
    expect(
      await rowOf('SELECT 1 FROM app.verification_cases WHERE party_id = $1', [v.id]),
    ).toHaveLength(1);

    const early = await post(`/v1/vendors/${v.id}/submit-kyc`);
    expect(early.status).toBe(409);
    expect(early.body.error.message).toMatch(/KYB case must be submitted/);

    await setCase(v.id, 'submitted');
    const second = await post(`/v1/vendors/${v.id}/submit-kyc`);
    expect(second.status, JSON.stringify(second.body)).toBe(200);
    expect(second.body.status).toBe('under_review');
  });

  it('says the vendor is ready for review only once its KYB case is submitted, the state submit-kyc enforces', async () => {
    const v = await newVendor();
    as('procurement', 'procurement');
    const ready = async () => {
      const res = await api().get(`/v1/vendors/${v.id}/review-readiness`);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      return res.body as { kybSubmitted: boolean };
    };
    // A draft has no case yet.
    expect(await ready()).toEqual({ kybSubmitted: false });
    expect((await post(`/v1/vendors/${v.id}/submit-kyc`)).status).toBe(200);
    // The case is open, not submitted: not ready, and the API refuses the move too.
    expect(await ready()).toEqual({ kybSubmitted: false });
    const early = await post(`/v1/vendors/${v.id}/submit-kyc`, { expectedStatus: 'pending_kyc' });
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe('kyb_not_submitted');
    await setCase(v.id, 'submitted');
    expect(await ready()).toEqual({ kybSubmitted: true });
    expect(
      (await post(`/v1/vendors/${v.id}/submit-kyc`, { expectedStatus: 'pending_kyc' })).status,
    ).toBe(200);
    // An unknown vendor is a 404.
    expect((await api().get(`/v1/vendors/${randomUUID()}/review-readiness`)).status).toBe(404);
  });

  it('refuses a stale "Start KYB review" with a plain 409 instead of sending the vendor for review', async () => {
    const v = await newVendor();
    as('procurement', 'procurement');
    // Tab 1 starts the review; tab 2 still shows "Start KYB review", drawn for draft.
    const first = await post(`/v1/vendors/${v.id}/submit-kyc`, { expectedStatus: 'draft' });
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body.status).toBe('pending_kyc');
    await setCase(v.id, 'submitted');

    const stale = await post(`/v1/vendors/${v.id}/submit-kyc`, { expectedStatus: 'draft' });
    expect(stale.status, JSON.stringify(stale.body)).toBe(409);
    expect(stale.body.error.code).toBe('conflict');
    expect(stale.body.error.message).toMatch(/changed by someone else/);
    const [row] = await rowOf<{ status: string }>('SELECT status FROM app.vendors WHERE id = $1', [
      v.id,
    ]);
    expect(row?.status).toBe('pending_kyc');

    // The button drawn for pending_kyc still works, and an unknown status is a 400.
    expect((await post(`/v1/vendors/${v.id}/submit-kyc`, { expectedStatus: 'nope' })).status).toBe(
      400,
    );
    const send = await post(`/v1/vendors/${v.id}/submit-kyc`, { expectedStatus: 'pending_kyc' });
    expect(send.status, JSON.stringify(send.body)).toBe(200);
    expect(send.body.status).toBe('under_review');
  });

  it('answers 409 to an activation without an approved KYB case', async () => {
    const v = await newVendor();
    const draft = await post(`/v1/vendors/${v.id}/activate`);
    expect(draft.status).toBe(409);
    expect(draft.body.error.message).toMatch(/cannot be moved to approved/);

    await toUnderReview(v); // the case is submitted, not approved
    const res = await post(`/v1/vendors/${v.id}/activate`);
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.error.code).toBe('kyb_not_verified');
    const [row] = await rowOf<{ status: string }>('SELECT status FROM app.vendors WHERE id = $1', [
      v.id,
    ]);
    expect(row?.status).toBe('under_review');
  });

  it('answers 403 to the creator activating their own vendor, and the DB CHECK is the backstop', async () => {
    const v = await newVendor(['founder', 'founder']);
    as('founder', 'founder');
    expect((await post(`/v1/vendors/${v.id}/submit-kyc`)).status).toBe(200);
    await setCase(v.id, 'submitted');
    expect((await post(`/v1/vendors/${v.id}/submit-kyc`)).status).toBe(200);
    await setCase(v.id, 'approved');

    const res = await post(`/v1/vendors/${v.id}/activate`);
    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.error.reason).toBe('separation_of_duties');
    const [row] = await rowOf<{ status: string; approved_by: string | null }>(
      'SELECT status, approved_by FROM app.vendors WHERE id = $1',
      [v.id],
    );
    expect(row).toEqual({ status: 'under_review', approved_by: null });

    await expect(
      ownerTx((client) =>
        client.query(
          `UPDATE app.vendors SET status = 'approved', approved_by = created_by WHERE id = $1`,
          [v.id],
        ),
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('activates a vendor another user created once its KYB case is approved; accountant may not', async () => {
    const v = await newVendor();
    await toUnderReview(v);
    await setCase(v.id, 'approved');
    as('accountant', 'accountant');
    expect((await post(`/v1/vendors/${v.id}/activate`)).status).toBe(403);

    as('founder', 'founder');
    const res = await post(`/v1/vendors/${v.id}/activate`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.status).toBe('approved');
    const [row] = await rowOf<{ approved_by: string }>(
      'SELECT approved_by FROM app.vendors WHERE id = $1',
      [v.id],
    );
    expect(row?.approved_by).toBe(U.founder);
  });

  it('suspends, blocks and archives along the contract state machine only', async () => {
    const v = await newVendor();
    await toUnderReview(v);
    await setCase(v.id, 'approved');
    expect((await post(`/v1/vendors/${v.id}/activate`)).status).toBe(200);

    expect((await post(`/v1/vendors/${v.id}/archive`, { reason: 'too early' })).status).toBe(409);
    expect((await post(`/v1/vendors/${v.id}/suspend`)).status).toBe(400); // a reason is required
    const suspended = await post(`/v1/vendors/${v.id}/suspend`, { reason: 'audit hold' });
    expect(suspended.body.status).toBe('suspended');
    const blocked = await post(`/v1/vendors/${v.id}/block`, { reason: 'fraud suspicion' });
    expect(blocked.body.status).toBe('blocked');
    const archived = await post(`/v1/vendors/${v.id}/archive`, { reason: 'closed' });
    expect(archived.body.status).toBe('archived');
    expect((await post(`/v1/vendors/${v.id}/activate`)).status).toBe(409);
  });
});

describe('daily KYC expiry (suspendLapsedKyc)', () => {
  const DAY = 86_400_000;
  const day = (offset: number) => new Date(Date.now() + offset * DAY).toISOString().slice(0, 10);

  it('suspends an approved vendor whose tax clearance lapsed, and a reactivation needs a renewed one', async () => {
    const lapsed = await newVendor();
    const valid = await newVendor();
    for (const v of [lapsed, valid]) {
      await toUnderReview(v);
      await setCase(v.id, 'approved', v === lapsed ? day(5) : '2099-01-01');
      expect((await post(`/v1/vendors/${v.id}/activate`)).status).toBe(200);
    }

    // Ten days on, the clearance that ran out five days ahead has lapsed; the other one has not.
    const later = new Date(Date.now() + 10 * DAY);
    expect((await expiry.run(later)).suspended).toEqual([lapsed.id]);
    const status = async (id: string) =>
      (await rowOf<{ status: string }>('SELECT status FROM app.vendors WHERE id = $1', [id]))[0]
        ?.status;
    expect(await status(lapsed.id)).toBe('suspended');
    expect(await status(valid.id)).toBe('approved');
    // A second run finds nothing left to do.
    expect((await expiry.run(later)).suspended).toEqual([]);

    await setCase(lapsed.id, 'approved', '2020-01-01');
    const refused = await post(`/v1/vendors/${lapsed.id}/activate`);
    expect(refused.status, JSON.stringify(refused.body)).toBe(409);
    expect(refused.body.error.message).toMatch(/tax clearance .* expired/);
    await setCase(lapsed.id, 'approved', '2099-01-01');
    expect((await post(`/v1/vendors/${lapsed.id}/activate`)).status).toBe(200);
  });
});

describe('contacts', () => {
  it('makes the first contact primary, swaps the primary, and deletes', async () => {
    const v = await newVendor();
    as('procurement', 'procurement');
    const a = await post(`/v1/vendors/${v.id}/contacts`, {
      name: 'Sita Rai',
      email: 'Sita@Example.com',
      country: 'NP',
      phones: [{ country: 'NP', e164: '+9779812345678', isPrimary: true }],
      role: 'Accounts',
    });
    expect(a.status, JSON.stringify(a.body)).toBe(201);
    expect(a.body).toMatchObject({
      name: 'Sita Rai',
      email: 'sita@example.com',
      role: 'Accounts',
      isPrimary: true,
    });
    for (const e164 of ['+9778123456789', '+97798123456789', '+977012345678']) {
      const bad = await post(`/v1/vendors/${v.id}/contacts`, {
        name: 'Bad Phone',
        country: 'NP',
        phones: [{ country: 'NP', e164, isPrimary: true }],
      });
      expect(bad.status, `${e164}: ${JSON.stringify(bad.body)}`).toBe(400);
    }
    const b = await post(`/v1/vendors/${v.id}/contacts`, { name: 'Ram Karki', country: 'NP' });
    expect(b.body.isPrimary).toBe(false);

    const swap = await api()
      .patch(`/v1/vendors/${v.id}/contacts/${b.body.id}`)
      .send({ expectedVersion: 1, isPrimary: true });
    expect(swap.status, JSON.stringify(swap.body)).toBe(200);
    expect(swap.body.isPrimary).toBe(true);
    const list = await api().get(`/v1/vendors/${v.id}/contacts`);
    expect(
      list.body.map((c: { name: string; isPrimary: boolean }) => [c.name, c.isPrimary]),
    ).toEqual([
      ['Ram Karki', true],
      ['Sita Rai', false],
    ]);

    const stale = await api()
      .patch(`/v1/vendors/${v.id}/contacts/${a.body.id}`)
      .send({ expectedVersion: 1, name: 'S' });
    expect(stale.status).toBe(409); // version moved to 2 when it stepped down as primary

    const other = await newVendor();
    as('procurement', 'procurement');
    expect((await api().delete(`/v1/vendors/${other.id}/contacts/${a.body.id}`)).status).toBe(404);
    expect((await api().delete(`/v1/vendors/${v.id}/contacts/${a.body.id}`)).status).toBe(204);
    expect((await api().get(`/v1/vendors/${v.id}/contacts`)).body).toHaveLength(1);
  });
});

describe('accounts per entity', () => {
  it('answers 404 to a cross-entity read, and 200 once the caller acts for that entity', async () => {
    const v = await newVendor();
    as('founder', 'founder');
    const created = await post(`/v1/vendors/${v.id}/accounts`, {
      organizationId: orgB,
      defaultCurrency: 'USD',
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(VendorAccountDtoSchema.parse(created.body)).toMatchObject({
      organizationId: orgB,
      defaultCurrency: 'USD',
      vendorPartyId: v.id,
    });

    // Acting for entity A: the account of entity B is out of scope.
    const cross = await api().get(`/v1/vendors/${v.id}/accounts/${orgB}`);
    expect(cross.status, JSON.stringify(cross.body)).toBe(404);
    const own = await api().get(`/v1/vendors/${v.id}/accounts/${orgA}`);
    expect(own.status).toBe(200);
    const listA = await api().get(`/v1/vendors/${v.id}/accounts`);
    expect(listA.body.map((a: { organizationId: string }) => a.organizationId)).toEqual([orgA]);

    as('founder', 'founder', orgB);
    const asB = await api().get(`/v1/vendors/${v.id}/accounts/${orgB}`);
    expect(asB.status, JSON.stringify(asB.body)).toBe(200);
    expect((await api().get(`/v1/vendors/${v.id}/accounts/${orgA}`)).status).toBe(404);
  });

  it('refuses an entity the caller is not a member of (404) and a second account for the same entity (409)', async () => {
    const v = await newVendor();
    as('procurement', 'procurement');
    const notMember = await post(`/v1/vendors/${v.id}/accounts`, { organizationId: orgB });
    expect(notMember.status).toBe(404);
    const dup = await post(`/v1/vendors/${v.id}/accounts`, { organizationId: orgA });
    expect(dup.status).toBe(409);
    expect(dup.body.error.message).toMatch(/already has an account/);
    const badTerm = await post(`/v1/vendors/${v.id}/accounts`, {
      organizationId: orgA,
      paymentTermId: randomUUID(),
    });
    expect(badTerm.status).toBe(400);
  });
});

describe('address, country and phones (FX9)', () => {
  it('round-trips a vendor address and a contact with two phones in different countries', async () => {
    as('procurement', 'procurement');
    const address = { line: 'Thamel Marg 12', city: 'Kathmandu' };
    const created = await createVendor({ legalName: 'Address Traders', address });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(VendorDtoSchema.parse(created.body).address).toEqual(address);
    const read = await api().get(`/v1/vendors/${created.body.id}`);
    expect(VendorDtoSchema.parse(read.body)).toMatchObject({ country: 'NP', address });
    const noAddress = await createVendor({ legalName: 'No Address Traders' });
    expect(VendorDtoSchema.parse(noAddress.body).address).toBeNull();

    const phones = [
      { country: 'US', e164: '+14155552671', label: 'work', isPrimary: false },
      { country: 'NP', e164: '+9779812345678', label: 'mobile', isPrimary: true },
    ];
    const contact = await post(`/v1/vendors/${created.body.id}/contacts`, {
      name: 'Maya Gurung',
      country: 'US',
      phones,
    });
    expect(contact.status, JSON.stringify(contact.body)).toBe(201);
    // Primary first, each number with its own country; the contact's country differs from the vendor's.
    const expected = [phones[1], phones[0]];
    expect(contact.body).toMatchObject({ country: 'US', phones: expected });
    const list = await api().get(`/v1/vendors/${created.body.id}/contacts`);
    expect(list.body).toHaveLength(1);
    expect(list.body[0]).toMatchObject({ country: 'US', phones: expected });
    const stored = await rowOf<{ country: string; e164: string; sort_order: number }>(
      'SELECT country, e164, sort_order FROM app.vendor_contact_phones WHERE contact_id = $1 ORDER BY sort_order',
      [contact.body.id],
    );
    expect(stored).toEqual([
      { country: 'US', e164: '+14155552671', sort_order: 0 },
      { country: 'NP', e164: '+9779812345678', sort_order: 1 },
    ]);

    // An edit without `phones` keeps them; a sent list replaces the whole set; an empty list clears it.
    const renamed = await api()
      .patch(`/v1/vendors/${created.body.id}/contacts/${contact.body.id}`)
      .send({ expectedVersion: 1, name: 'Maya G.' });
    expect(renamed.status, JSON.stringify(renamed.body)).toBe(200);
    expect(renamed.body.phones).toEqual(expected);
    const replaced = await api()
      .patch(`/v1/vendors/${created.body.id}/contacts/${contact.body.id}`)
      .send({
        expectedVersion: 2,
        country: 'NP',
        phones: [{ country: 'NP', e164: '+97714123456', label: 'landline', isPrimary: true }],
      });
    expect(replaced.status, JSON.stringify(replaced.body)).toBe(200);
    expect(replaced.body).toMatchObject({
      country: 'NP',
      version: 3,
      phones: [{ country: 'NP', e164: '+97714123456', label: 'landline', isPrimary: true }],
    });
    const cleared = await api()
      .patch(`/v1/vendors/${created.body.id}/contacts/${contact.body.id}`)
      .send({ expectedVersion: 3, phones: [] });
    expect(cleared.status, JSON.stringify(cleared.body)).toBe(200);
    expect(cleared.body.phones).toEqual([]);
    expect(
      await rowOf('SELECT 1 FROM app.vendor_contact_phones WHERE contact_id = $1', [
        contact.body.id,
      ]),
    ).toHaveLength(0);
  });

  it('refuses a phone list without exactly one primary, or a number of the wrong country', async () => {
    const v = await newVendor();
    as('procurement', 'procurement');
    for (const phones of [
      [{ country: 'NP', e164: '+9779812345678', isPrimary: false }],
      [
        { country: 'NP', e164: '+9779812345678', isPrimary: true },
        { country: 'US', e164: '+14155552671', isPrimary: true },
      ],
      [{ country: 'NP', e164: '+14155552671', isPrimary: true }],
    ]) {
      const bad = await post(`/v1/vendors/${v.id}/contacts`, {
        name: 'Bad',
        country: 'NP',
        phones,
      });
      expect(bad.status, JSON.stringify(bad.body)).toBe(400);
    }
  });

  it('refuses an address with only a line, and sets or clears the address on edit', async () => {
    const lineOnly = await createVendor({ address: { line: 'Thamel Marg 12' } });
    expect(lineOnly.status, JSON.stringify(lineOnly.body)).toBe(400);

    const v = await newVendor();
    const address = { line: 'Lakeside Road 4', city: 'Pokhara' };
    const set = await api()
      .patch(`/v1/vendors/${v.id}`)
      .send({ expectedVersion: v.version, address });
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    expect(set.body.address).toEqual(address);
    const halfEdit = await api()
      .patch(`/v1/vendors/${v.id}`)
      .send({ expectedVersion: set.body.version, address: { line: 'Only a line' } });
    expect(halfEdit.status).toBe(400);
    const cleared = await api()
      .patch(`/v1/vendors/${v.id}`)
      .send({ expectedVersion: set.body.version, address: null });
    expect(cleared.status, JSON.stringify(cleared.body)).toBe(200);
    expect(cleared.body.address).toBeNull();
  });

  it('lets a foreign vendor keep a loose tax id on edit, and refuses a short PAN for a Nepal vendor', async () => {
    const foreign = await createVendor({ kind: 'foreign', country: 'DE', pan: undefined });
    expect(foreign.status, JSON.stringify(foreign.body)).toBe(201);
    const taxId = await api()
      .patch(`/v1/vendors/${foreign.body.id}`)
      .send({ expectedVersion: foreign.body.version, pan: 'DE-81234567' });
    expect(taxId.status, JSON.stringify(taxId.body)).toBe(200);
    expect(taxId.body.pan).toBe('DE-81234567');

    const domestic = await newVendor();
    const short = await api()
      .patch(`/v1/vendors/${domestic.id}`)
      .send({ expectedVersion: domestic.version, pan: '12345' });
    expect(short.status, JSON.stringify(short.body)).toBe(400);
    expect((await createVendor({ country: 'NP', pan: '12345' })).status).toBe(400);
  });

  // Red until the contract's CreateVendorBodySchema takes the loose PanVatNoSchema with a Nepal-only refine
  // (packages/contracts/src/vendors.ts: `pan: VendorPanSchema` is NepalPanSchema today, so the controller answers 400).
  it('creates a foreign vendor with a loose tax id', async () => {
    const res = await createVendor({ kind: 'foreign', country: 'US', pan: 'US-12-3456789' });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.pan).toBe('US-12-3456789');
  });
});
