// Integration tests of the customer and vendor CSV import (round 5, K1) on a real Postgres. Real: every migration,
// queries as bos_app, the controller behind the production body parser, error filter and raw text/csv reader,
// PartyImportsService, CustomersService.createInTx, VendorsService.createInTx, withTx, the audit triggers and
// audit.record(). Faked: the request context (PartyImportsCaller and the services' callers) and authz.assert, which
// still runs the real pure can() on a fake principal holding a role's DEFAULT grants, so each 403 is the decision the
// role gets in production.
// Run: pnpm --filter @bos/api exec vitest run src/modules/party-imports/party-imports.integration.test.ts
import 'reflect-metadata';

import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import {
  DEFAULT_ROLE_PERMISSIONS,
  ErrorBodySchema,
  PartyImportBatchSchema,
  PartyImportDetailSchema,
  type Permission,
  type RoleKey,
  type Scope,
} from '@bos/contracts';
import { createStaffUser, createTenantWithEntity, organizations } from '@bos/db';
import { createTestDatabase, type TestDatabase } from '@bos/db/testing';
import { ForbiddenException, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { configureApp } from '../../app.setup';
import { AuditService } from '../../platform/audit/audit.service';
import { can } from '../../platform/authz/can';
import type { AuthzService } from '../../platform/authz/authz.service';
import type { Principal } from '../../platform/authz/principal';
import type { Db } from '../../platform/db/db.module';
import { systemActor, withTx } from '../../platform/db/tx';
import { NumberingService } from '../../platform/settings/numbering.service';
import { ErrorBodyFilter } from '../../platform/tenancy/error-body.filter';
import { CustomersService } from '../customers/customers.service';
import { VendorsService } from '../vendors/vendors.service';
import { PartyImportExpirySweeper } from './party-import-expiry.sweeper';
import { PartyImportsController } from './party-imports.controller';
import { PartyImportsService } from './party-imports.service';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 180_000 });

let testDb: TestDatabase;
let ownerPool: Pool;
let appPool: Pool;
let db: Db;
let app: INestApplication;
let baseUrl: string;
const now = new Date('2026-11-21T04:00:00Z');

type Tenant = { tenantId: string; organizationId: string; idpOrgId: string; userId: string };
let a: Tenant;
let b: Tenant;
let entityA2: string;
const usersA = {} as Record<'founder' | 'sales' | 'procurement', string>;

const current: {
  tenant: Tenant;
  organizationId: string;
  userId: string;
  grants: Map<Permission, Scope>;
} = { tenant: undefined as never, organizationId: '', userId: '', grants: new Map() };
const grantsOf = (role: RoleKey) =>
  new Map(Object.entries(DEFAULT_ROLE_PERMISSIONS[role])) as Map<Permission, Scope>;
const as = (
  role: keyof typeof usersA,
  organizationId = a.organizationId,
  tenant: Tenant = a,
  userId = tenant === a ? usersA[role] : tenant.userId,
) => {
  current.tenant = tenant;
  current.organizationId = organizationId;
  current.userId = userId;
  current.grants = grantsOf(role);
};
const principalNow = (): Principal => ({
  userId: current.userId,
  zitadelUserId: `z-${current.userId}`,
  tenantId: current.tenant.tenantId,
  organizationId: current.organizationId,
  orgKind: 'staff',
  partyId: null,
  idpOrgId: current.tenant.idpOrgId,
  roles: [],
  departmentId: null,
  status: 'active',
  grants: current.grants,
});
const caller = {
  current: () => ({
    scope: { tenantId: current.tenant.tenantId, organizationId: current.organizationId },
    actor: { kind: 'user' as const, id: current.userId, correlationId: 'test-corr' },
    principal: principalNow(),
  }),
};
const authz = {
  assert: (action: Permission, ref?: Parameters<typeof can>[2]) => {
    const d = can(principalNow(), action, ref);
    if (!d.allowed)
      throw new ForbiddenException({ code: 'forbidden', message: 'Forbidden', reason: d.reason });
  },
};

beforeAll(async () => {
  testDb = await createTestDatabase();
  ownerPool = new Pool({ connectionString: testDb.ownerUrl, max: 2 });
  appPool = new Pool({ connectionString: testDb.appUrl, max: 8 });
  db = drizzle({ client: appPool });
  const tenant = async (code: string): Promise<Tenant> => {
    const t = await createTenantWithEntity(appPool, { code, name: `Entity ${code}` });
    const { userId } = await createStaffUser(appPool, { ...t });
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
  for (const role of ['founder', 'sales', 'procurement'] as const) {
    usersA[role] = (await createStaffUser(appPool, { ...a, roleKeys: [role] })).userId;
  }
  const audit = new AuditService(db);
  const customersService = new CustomersService(
    db,
    new NumberingService(),
    authz as unknown as AuthzService,
    caller,
    audit,
    () => now,
  );
  const vendorsService = new VendorsService(
    db,
    authz as unknown as AuthzService,
    caller,
    {} as never,
    audit,
    () => now,
  );
  const imports = new PartyImportsService(
    db,
    authz as unknown as AuthzService,
    caller,
    customersService,
    vendorsService,
    audit,
    () => now,
  );
  const moduleRef = await Test.createTestingModule({
    controllers: [PartyImportsController],
    providers: [{ provide: PartyImportsService, useValue: imports }],
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

beforeEach(() => as('founder'));

// ---------------------------------------------------------------------------------------------- helpers

const CUSTOMER_HEADER =
  'legal_name,pan_vat_no,industry,address_line1,address_city,address_country,contact_name,contact_email,contact_phone';
const VENDOR_HEADER =
  'legal_name,kind,pan,vat_registered,country,contact_name,contact_email,contact_phone';
const upload = (kind: 'customers' | 'vendors', csv: string | Buffer, name = 'file.csv') =>
  request(baseUrl)
    .post(`/v1/imports/${kind}?filename=${name}`)
    .set('Content-Type', 'text/csv')
    .send(csv);
const detailOf = (body: unknown) => PartyImportDetailSchema.parse(body);
const errorOf = (body: unknown) => ErrorBodySchema.parse(body).error;
const uniq = () => randomUUID().slice(0, 8);

async function count(sqlText: string, params: unknown[]): Promise<number> {
  const { rows } = await ownerPool.query<{ n: string }>(sqlText, params);
  return Number(rows[0]!.n);
}
const customersOf = (t: Tenant) =>
  count('SELECT count(*) AS n FROM app.customers WHERE tenant_id = $1', [t.tenantId]);
const vendorsOf = (t: Tenant) =>
  count('SELECT count(*) AS n FROM app.vendors WHERE tenant_id = $1', [t.tenantId]);

// ---------------------------------------------------------------------------------------------- customers

describe('customer import', () => {
  it('previews a mixed file with row-level errors, writes nothing, then commits only the valid rows', async () => {
    const tag = uniq();
    const csv = [
      CUSTOMER_HEADER,
      `Valid One ${tag},111${tag.replace(/\D/g, '1').slice(0, 3)}111,Retail,Road 1,Kathmandu,,,one-${tag}@Example.com,`,
      `,222222222,,Road 2,Pokhara,NP,,two@example.com,`,
      `Bad Pan ${tag},AB,,Road 3,Pokhara,NP,,three@example.com,`,
      `Bad Mail ${tag},,,Road 4,Pokhara,NP,,not-an-email,`,
      `No Address ${tag},,,,,NP,,five@example.com,`,
      `Valid Two ${tag},,,Road 6,Lalitpur,NP,Sita Sharma,six-${tag}@example.com,+9779812345678`,
    ].join('\r\n');
    const before = await customersOf(a);

    const res = await upload('customers', csv, 'customers.csv');
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const preview = detailOf(res.body);
    expect(preview).toMatchObject({
      kind: 'customer',
      status: 'previewed',
      fileName: 'customers.csv',
      rowCount: 6,
      validCount: 2,
      errorCount: 4,
      duplicateCount: 0,
      createdCount: 0,
      createdByUserId: usersA.founder,
      committedAt: null,
    });
    expect(preview.rows.map((r) => [r.line, r.status])).toEqual([
      [2, 'valid'],
      [3, 'error'],
      [4, 'error'],
      [5, 'error'],
      [6, 'error'],
      [7, 'valid'],
    ]);
    expect(preview.rows[1]!.issues).toEqual([
      { column: 'legal_name', message: 'legal name is required' },
    ]);
    expect(preview.rows[2]!.issues[0]).toMatchObject({ column: 'pan_vat_no' });
    expect(preview.rows[3]!.issues[0]).toMatchObject({ column: 'contact_email' });
    expect(preview.rows[4]!.issues.map((i) => i.column)).toEqual(['address_line1', 'address_city']);
    expect(await customersOf(a), 'a preview creates no customer').toBe(before);

    const done = await request(baseUrl).post(`/v1/imports/${preview.id}/commit`);
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    const committed = detailOf(done.body);
    expect(committed).toMatchObject({
      status: 'committed',
      validCount: 0,
      createdCount: 2,
      errorCount: 4,
    });
    expect(committed.committedAt).not.toBeNull();
    expect(
      committed.rows.filter((r) => r.status === 'created').every((r) => r.recordId !== undefined),
    ).toBe(true);
    expect(await customersOf(a)).toBe(before + 2);

    // The created customer: prospect, owned by the importer, with its primary contact; the audit trail names the importer.
    const { rows } = await ownerPool.query<{
      id: string;
      owner_user_id: string;
      relationship: string;
      email_norm: string;
      phone_e164: string | null;
    }>(
      `SELECT c.id, c.owner_user_id, c.relationship, k.email_norm, k.phone_e164
         FROM app.customers c JOIN app.customer_contacts k ON k.customer_id = c.id AND k.is_primary
        WHERE c.tenant_id = $1 AND c.legal_name = $2`,
      [a.tenantId, `Valid One ${tag}`],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      owner_user_id: usersA.founder,
      relationship: 'prospect',
      email_norm: `one-${tag}@example.com`,
    });
    const audited = await count(
      `SELECT count(*) AS n FROM audit.audit_events WHERE tenant_id = $1 AND entity_id = $2 AND actor_id = $3`,
      [a.tenantId, rows[0]!.id, usersA.founder],
    );
    expect(audited, 'the importer is the actor of the created row').toBeGreaterThan(0);
    const batchEvents = await count(
      `SELECT count(*) AS n FROM audit.audit_events WHERE tenant_id = $1 AND entity_id = $2 AND action = 'party_import.committed'`,
      [a.tenantId, preview.id],
    );
    expect(batchEvents).toBe(1);

    // The record survives a reload, and a second commit changes nothing.
    const again = await request(baseUrl).get(`/v1/imports/${preview.id}`);
    expect(detailOf(again.body)).toEqual(committed);
    const second = await request(baseUrl).post(`/v1/imports/${preview.id}/commit`);
    expect(detailOf(second.body)).toEqual(committed);
    expect(await customersOf(a)).toBe(before + 2);
  });

  it('is idempotent: the same file again creates nothing, and a name-only row is keyed on its normalised name', async () => {
    const tag = uniq();
    const csv = [
      CUSTOMER_HEADER,
      `Keyed Pan ${tag},${tag.replace(/\D/g, '7').padEnd(9, '7').slice(0, 9)},,Road 1,Kathmandu,NP,,k1-${tag}@example.com,`,
      `Himalaya ${tag} Pvt. Ltd.,,,Road 2,Kathmandu,NP,,k2-${tag}@example.com,`,
    ].join('\n');
    const first = detailOf((await upload('customers', csv)).body);
    expect(first.validCount).toBe(2);
    await request(baseUrl).post(`/v1/imports/${first.id}/commit`).expect(200);
    const afterFirst = await customersOf(a);

    // Same file; and the same company written differently (form word and case).
    const again = detailOf(
      (
        await upload(
          'customers',
          csv.replace(`Himalaya ${tag} Pvt. Ltd.`, `HIMALAYA ${tag} PRIVATE LIMITED`),
        )
      ).body,
    );
    expect(again).toMatchObject({ validCount: 0, duplicateCount: 2 });
    expect(again.rows.every((r) => r.status === 'duplicate')).toBe(true);
    const done = detailOf((await request(baseUrl).post(`/v1/imports/${again.id}/commit`)).body);
    expect(done).toMatchObject({ createdCount: 0, duplicateCount: 2, status: 'committed' });
    expect(await customersOf(a)).toBe(afterFirst);
  });

  it('checks the existing records again at commit: a customer added after the preview is not duplicated', async () => {
    const tag = uniq();
    const pan = tag.replace(/\D/g, '5').padEnd(9, '5').slice(0, 9);
    const csv = `${CUSTOMER_HEADER}\nRaced ${tag},${pan},,Road 1,Kathmandu,NP,,r-${tag}@example.com,\n`;
    const preview = detailOf((await upload('customers', csv)).body);
    expect(preview.validCount).toBe(1);
    // Someone creates the same customer by hand between the preview and the commit.
    await request(baseUrl)
      .post('/v1/imports/customers?filename=x.csv')
      .set('Content-Type', 'text/csv')
      .send(csv)
      .expect(201)
      .then(async (r) =>
        request(baseUrl)
          .post(`/v1/imports/${detailOf(r.body).id}/commit`)
          .expect(200),
      );
    const before = await customersOf(a);
    const done = detailOf((await request(baseUrl).post(`/v1/imports/${preview.id}/commit`)).body);
    expect(done).toMatchObject({ createdCount: 0, duplicateCount: 1 });
    expect(await customersOf(a)).toBe(before);
  });

  it("does not match, reveal or touch another tenant's PAN", async () => {
    const tag = uniq();
    const pan = tag.replace(/\D/g, '3').padEnd(9, '3').slice(0, 9);
    const csv = `${CUSTOMER_HEADER}\nShared Pan ${tag},${pan},,Road 1,Kathmandu,NP,,s-${tag}@example.com,\n`;
    // Tenant B imports it first.
    as('founder', b.organizationId, b);
    const inB = detailOf((await upload('customers', csv)).body);
    await request(baseUrl).post(`/v1/imports/${inB.id}/commit`).expect(200);
    const bBefore = await customersOf(b);

    // Tenant A sees no duplicate and creates its own record; B's record is unchanged.
    as('founder');
    const inA = detailOf((await upload('customers', csv)).body);
    expect(inA).toMatchObject({ validCount: 1, duplicateCount: 0 });
    expect(JSON.stringify(inA)).not.toContain(b.tenantId);
    await request(baseUrl).post(`/v1/imports/${inA.id}/commit`).expect(200);
    expect(await customersOf(b)).toBe(bBefore);
    expect(
      await count('SELECT count(*) AS n FROM app.customers WHERE pan_vat_no = $1', [pan]),
    ).toBe(2);

    // A batch of one tenant (or of another entity of the same tenant) is a 404 to everyone else.
    as('founder', b.organizationId, b);
    const cross = await request(baseUrl).get(`/v1/imports/${inA.id}`);
    expect(cross.status).toBe(404);
    expect((await request(baseUrl).post(`/v1/imports/${inA.id}/commit`)).status).toBe(404);
    as('founder', entityA2);
    expect((await request(baseUrl).get(`/v1/imports/${inA.id}`)).status).toBe(404);
  });

  it('counts a merged customer PAN as taken, so its row is a duplicate and no commit is aborted', async () => {
    const tag = uniq();
    const panA = tag.replace(/\D/g, '4').padEnd(9, '4').slice(0, 9);
    const make = async (pan: string, name: string) => {
      const b = detailOf(
        (
          await upload(
            'customers',
            `${CUSTOMER_HEADER}\n${name},${pan},,R,C,NP,,m-${uniq()}@example.com,\n`,
          )
        ).body,
      );
      return detailOf((await request(baseUrl).post(`/v1/imports/${b.id}/commit`)).body).rows[0]!
        .recordId!;
    };
    const merged = await make(panA, `Merged ${tag}`);
    const keep = await make(tag.replace(/\D/g, '3').padEnd(9, '3').slice(0, 9), `Keep ${tag}`);
    const client = await ownerPool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `SELECT set_config('bos.actor_kind', 'system', true), set_config('bos.actor_id', 'merge-test', true),
                set_config('bos.correlation_id', $1, true), set_config('bos.organization_id', $2, true)`,
        [randomUUID(), a.organizationId],
      );
      await client.query('UPDATE app.customers SET merged_into_id = $1 WHERE id = $2', [
        keep,
        merged,
      ]);
      await client.query('COMMIT');
    } finally {
      client.release();
    }
    const preview = detailOf(
      (
        await upload(
          'customers',
          `${CUSTOMER_HEADER}\nNew Name ${tag},${panA},,R,C,NP,,x-${tag}@example.com,\n`,
        )
      ).body,
    );
    expect(preview).toMatchObject({ validCount: 0, duplicateCount: 1 });
  });

  it('does not copy the uploaded rows into the audit log, only the counts', async () => {
    const tag = uniq();
    const batch = detailOf(
      (
        await upload(
          'customers',
          `${CUSTOMER_HEADER}\nAudit ${tag},,,R,C,NP,,audit-${tag}@example.com,+9779812345678\n`,
        )
      ).body,
    );
    const { rows } = await ownerPool.query<{ n: string }>(
      `SELECT count(*) AS n FROM audit.audit_events WHERE tenant_id = $1 AND (before::text LIKE $2 OR after::text LIKE $2 OR meta::text LIKE $2)`,
      [a.tenantId, `%audit-${tag}@example.com%`],
    );
    expect(Number(rows[0]!.n)).toBe(0);
    expect(
      await count(
        `SELECT count(*) AS n FROM audit.audit_events WHERE tenant_id = $1 AND entity_id = $2 AND action = 'party_import.previewed'`,
        [a.tenantId, batch.id],
      ),
    ).toBe(1);
  });

  it('refuses a formula-injection cell, in every text column, and never stores it', async () => {
    const tag = uniq();
    const before = await customersOf(a);
    const csv = [
      CUSTOMER_HEADER,
      `"=HYPERLINK(""http://evil.example"",""x"")",,,Road 1,Kathmandu,NP,,f1-${tag}@example.com,`,
      `Plus ${tag},,,"+1+1",Kathmandu,NP,,f2-${tag}@example.com,`,
      `At ${tag},,,Road 3,@SUM(A1),NP,,f3-${tag}@example.com,`,
      `Fine ${tag},,,Road 4,Kathmandu,NP,"-cmd|' /C calc'!A0",f4-${tag}@example.com,+9779800000000`,
    ].join('\n');
    const preview = detailOf((await upload('customers', csv)).body);
    expect(preview.rows.map((r) => r.status)).toEqual(['error', 'error', 'error', 'error']);
    expect(preview.rows.flatMap((r) => r.issues.map((i) => i.column))).toEqual([
      'legal_name',
      'address_line1',
      'address_city',
      'contact_name',
    ]);
    expect(preview.rows.flatMap((r) => r.issues).every((i) => /formula/.test(i.message))).toBe(
      true,
    );
    await request(baseUrl).post(`/v1/imports/${preview.id}/commit`).expect(200);
    expect(await customersOf(a)).toBe(before);
  });

  it('answers a malformed or oversized upload as one clear refusal and keeps no batch', async () => {
    const batches = () =>
      count('SELECT count(*) AS n FROM app.party_import_batches WHERE tenant_id = $1', [
        a.tenantId,
      ]);
    const before = await batches();
    const unterminated = await upload(
      'customers',
      `${CUSTOMER_HEADER}\n"never closed,,,x,y,NP,,a@b.co,\n`,
    );
    expect(unterminated.status).toBe(400);
    expect(errorOf(unterminated.body).message).toMatch(/never closed/);
    expect((await upload('customers', 'legal_name,surprise\nA,B\n')).status).toBe(400);
    expect((await upload('customers', `${CUSTOMER_HEADER}\n`)).status).toBe(400);
    const rows = Array.from({ length: 2001 }, (_, i) => `N${i},,,R,C,NP,,n${i}@example.com,`).join(
      '\n',
    );
    const tooMany = await upload('customers', `${CUSTOMER_HEADER}\n${rows}\n`);
    expect(tooMany.status).toBe(400);
    expect(errorOf(tooMany.body).message).toMatch(/more than 2000/);
    const big = await upload('customers', `${CUSTOMER_HEADER}\n${'x'.repeat(2 * 1024 * 1024)}\n`);
    expect(big.status).toBe(413);
    const wrongType = await request(baseUrl)
      .post('/v1/imports/customers')
      .set('Content-Type', 'application/json')
      .send({ csv: 'x' });
    expect(wrongType.status).toBe(415);
    const nul = await upload('customers', `${CUSTOMER_HEADER}\n"Acme\u0000",,,R,C,NP,,a@b.co,\n`);
    expect(nul.status).toBe(400);
    const latin1 = await upload(
      'customers',
      Buffer.from(`${CUSTOMER_HEADER}\nCaf\xE9,,,R,C,NP,,a@b.co,\n`, 'latin1'),
    );
    expect(latin1.status).toBe(400);
    expect(errorOf(latin1.body).message).toMatch(/UTF-8/);
    expect(await batches(), 'a refused file leaves no batch').toBe(before);
  });
});

// ---------------------------------------------------------------------------------------------- vendors

describe('vendor import', () => {
  it('creates unverified (draft) vendors with their account in the acting entity, and skips a duplicate PAN', async () => {
    const tag = uniq();
    const pan1 = tag.replace(/\D/g, '9').padEnd(9, '9').slice(0, 9);
    const pan2 = tag.replace(/\D/g, '8').padEnd(9, '8').slice(0, 9);
    const csv = [
      VENDOR_HEADER,
      `Everest ${tag},company,${pan1},yes,NP,Ram Karki,ram-${tag}@example.com,+9779801234567`,
      `Overseas ${tag},foreign,,no,IN,,,`,
      `Missing Pan ${tag},company,,yes,NP,,,`,
      `Dup In File ${tag},company,${pan1},no,NP,,,`,
      `Solo ${tag},individual,${pan2},,,,,`,
    ].join('\n');
    const before = await vendorsOf(a);
    const preview = detailOf((await upload('vendors', csv)).body);
    expect(preview.rows.map((r) => r.status)).toEqual([
      'valid',
      'valid',
      'error',
      'duplicate',
      'valid',
    ]);
    expect(preview.rows[2]!.issues[0]).toMatchObject({ column: 'pan' });
    expect(await vendorsOf(a)).toBe(before);

    const done = detailOf((await request(baseUrl).post(`/v1/imports/${preview.id}/commit`)).body);
    expect(done).toMatchObject({
      kind: 'vendor',
      status: 'committed',
      createdCount: 3,
      duplicateCount: 1,
      errorCount: 1,
    });
    expect(await vendorsOf(a)).toBe(before + 3);
    const { rows } = await ownerPool.query<{
      legal_name: string;
      status: string;
      kind: string;
      vat_registered: boolean;
      country: string;
      owner_user_id: string;
      accounts: string;
      contacts: string;
    }>(
      `SELECT v.legal_name, v.status, v.kind, v.vat_registered, v.country, v.owner_user_id,
              (SELECT count(*) FROM app.vendor_accounts x WHERE x.vendor_id = v.id AND x.organization_id = $2) AS accounts,
              (SELECT count(*) FROM app.vendor_contacts k WHERE k.vendor_id = v.id) AS contacts
         FROM app.vendors v WHERE v.tenant_id = $1 AND v.legal_name LIKE $3 ORDER BY v.legal_name`,
      [a.tenantId, a.organizationId, `%${tag}`],
    );
    expect(
      rows.map((r) => [
        r.legal_name,
        r.status,
        r.kind,
        r.vat_registered,
        r.country,
        r.accounts,
        r.contacts,
      ]),
    ).toEqual([
      [`Everest ${tag}`, 'draft', 'company', true, 'NP', '1', '1'],
      [`Overseas ${tag}`, 'draft', 'foreign', false, 'IN', '1', '0'],
      [`Solo ${tag}`, 'draft', 'individual', false, 'NP', '1', '0'],
    ]);
    expect(rows.every((r) => r.owner_user_id === usersA.founder)).toBe(true);

    // The same file again: nothing is created.
    const again = detailOf((await upload('vendors', csv)).body);
    expect(again).toMatchObject({ validCount: 0, duplicateCount: 4, errorCount: 1 });
    await request(baseUrl).post(`/v1/imports/${again.id}/commit`).expect(200);
    expect(await vendorsOf(a)).toBe(before + 3);
  });

  it('still notes a vendor created under an existing name, once per batch index, without rereading the table per row', async () => {
    const tag = uniq();
    const pan1 = tag.replace(/\D/g, '2').padEnd(9, '2').slice(0, 9);
    const pan2 = tag.replace(/\D/g, '1').padEnd(9, '1').slice(0, 9);
    const first = `${VENDOR_HEADER}\nSame Name ${tag} Pvt. Ltd.,company,${pan1},no,NP,,,\n`;
    await request(baseUrl)
      .post(`/v1/imports/${detailOf((await upload('vendors', first)).body).id}/commit`)
      .expect(200);
    // A different PAN, the same company name: created (keyed on PAN) and noted in the audit trail.
    const second = `${VENDOR_HEADER}\nSAME NAME ${tag} Private Limited,company,${pan2},no,NP,,,\n`;
    const batch = detailOf((await upload('vendors', second)).body);
    expect(batch.validCount).toBe(1);
    const done = detailOf((await request(baseUrl).post(`/v1/imports/${batch.id}/commit`)).body);
    const created = done.rows[0]!.recordId!;
    expect(
      await count(
        `SELECT count(*) AS n FROM audit.audit_events WHERE tenant_id = $1 AND entity_id = $2 AND action = 'vendor.created_with_same_name'`,
        [a.tenantId, created],
      ),
    ).toBe(1);
  });

  it("does not match another tenant's vendor PAN", async () => {
    const tag = uniq();
    const pan = tag.replace(/\D/g, '6').padEnd(9, '6').slice(0, 9);
    const csv = `${VENDOR_HEADER}\nPan Twin ${tag},company,${pan},no,NP,,,\n`;
    as('founder', b.organizationId, b);
    await request(baseUrl)
      .post(`/v1/imports/${detailOf((await upload('vendors', csv)).body).id}/commit`)
      .expect(200);
    as('founder');
    const inA = detailOf((await upload('vendors', csv)).body);
    expect(inA).toMatchObject({ validCount: 1, duplicateCount: 0 });
    await request(baseUrl).post(`/v1/imports/${inA.id}/commit`).expect(200);
    expect(await count('SELECT count(*) AS n FROM app.vendors WHERE pan = $1', [pan])).toBe(2);
  });
});

// ---------------------------------------------------------------------------------------------- authz and record

describe('who may import, and the record', () => {
  it('needs customer.write for customers and vendor.write for vendors (sales and procurement hold one each)', async () => {
    const csvC = `${CUSTOMER_HEADER}\nAuthz ${uniq()},,,R,C,NP,,a@example.com,\n`;
    const csvV = `${VENDOR_HEADER}\nAuthz ${uniq()},company,${uniq().replace(/\D/g, '4').padEnd(9, '4').slice(0, 9)},no,NP,,,\n`;
    as('procurement');
    expect((await upload('customers', csvC)).status).toBe(403);
    const v = await upload('vendors', csvV);
    expect(v.status, JSON.stringify(v.body)).toBe(201);
    as('sales');
    expect((await upload('vendors', csvV)).status).toBe(403);
    const c = detailOf((await upload('customers', csvC)).body);
    // A vendor batch is not readable or committable by someone who may only import customers.
    expect((await request(baseUrl).get(`/v1/imports/${detailOf(v.body).id}`)).status).toBe(403);
    expect((await request(baseUrl).post(`/v1/imports/${detailOf(v.body).id}/commit`)).status).toBe(
      403,
    );
    expect((await request(baseUrl).post(`/v1/imports/${c.id}/commit`)).status).toBe(200);
    const list = (await request(baseUrl).get('/v1/imports')).body as unknown[];
    expect(list.map((x) => PartyImportBatchSchema.parse(x).kind)).not.toContain('vendor');
    expect(list.map((x) => PartyImportBatchSchema.parse(x).kind)).toContain('customer');
  });

  it('lists the newest batches without their rows', async () => {
    as('founder');
    const list = (await request(baseUrl).get('/v1/imports')).body as Record<string, unknown>[];
    expect(list.length).toBeGreaterThan(0);
    expect(list.every((row) => !('rows' in row))).toBe(true);
    expect((await request(baseUrl).get('/v1/imports?kind=vendor')).body).toSatisfy(
      (rows: { kind: string }[]) => rows.every((r) => r.kind === 'vendor'),
    );
  });

  it('keeps a committed batch final in the database', async () => {
    const preview = detailOf(
      (await upload('customers', `${CUSTOMER_HEADER}\nFinal ${uniq()},,,R,C,NP,,f@example.com,\n`))
        .body,
    );
    await request(baseUrl).post(`/v1/imports/${preview.id}/commit`).expect(200);
    await expect(
      ownerPool.query(`UPDATE app.party_import_batches SET file_name = 'x' WHERE id = $1`, [
        preview.id,
      ]),
    ).rejects.toThrow(/final/);
    await expect(
      ownerPool.query('DELETE FROM app.party_import_batches WHERE id = $1', [preview.id]),
    ).rejects.toThrow(/never deleted/);
  });
});

// Last on purpose: the sweep expires every previewed batch older than 7 days in the whole database, the other tests' too.
describe('an unused preview expires after 7 days (FU11)', () => {
  const DAY = 24 * 60 * 60_000;
  const sweeper = () => new PartyImportExpirySweeper(db, new AuditService(db));
  const batch = async (id: string) =>
    (
      await ownerPool.query<{ status: string; rows: unknown[]; row_count: number }>(
        'SELECT status, rows, row_count FROM app.party_import_batches WHERE id = $1',
        [id],
      )
    ).rows[0]!;
  const preview = async (name: string) =>
    detailOf(
      (
        await upload(
          'customers',
          `${CUSTOMER_HEADER}
${name} ${uniq()},,,R,C,NP,,e@example.com,
`,
        )
      ).body,
    );

  it('expires a stale previewed batch, clears its rows, keeps a young one and a committed one, and is repeatable', async () => {
    const stale = await preview('Stale');
    const young = await preview('Young');
    const committed = await preview('Committed');
    // Old code had no expiry at all: every preview stayed with its rows for ever.
    await withTx(db, a, systemActor('test'), (tx) =>
      tx.execute(
        sql`UPDATE app.party_import_batches SET created_at = ${new Date(now.getTime() + 5 * DAY).toISOString()}::timestamptz WHERE id = ${young.id}::uuid`,
      ),
    );
    await request(baseUrl).post(`/v1/imports/${committed.id}/commit`).expect(200);
    expect((await batch(stale.id)).rows).toHaveLength(1);

    // 6 days 23 hours old: still kept.
    const early = await sweeper().sweep(new Date(now.getTime() + 7 * DAY - 60 * 60_000));
    expect(early.expired).toBe(0);
    expect((await batch(stale.id)).status).toBe('previewed');

    const later = new Date(now.getTime() + 8 * DAY);
    const first = await sweeper().sweep(later);
    expect(first.failed).toBe(0);
    expect(first.expired).toBeGreaterThanOrEqual(1);
    expect(await batch(stale.id)).toMatchObject({ status: 'expired', rows: [], row_count: 1 });
    expect((await batch(young.id)).status).toBe('previewed');
    expect((await batch(young.id)).rows).toHaveLength(1);
    expect((await batch(committed.id)).status).toBe('committed');
    expect((await batch(committed.id)).rows).toHaveLength(1);
    expect(
      await count(
        `SELECT count(*) AS n FROM audit.audit_events WHERE tenant_id = $1 AND entity_id = $2 AND action = 'party_import.expired'`,
        [a.tenantId, stale.id],
      ),
    ).toBe(1);

    const second = await sweeper().sweep(later);
    expect(second.expired).toBe(0);
    expect(
      await count(
        `SELECT count(*) AS n FROM audit.audit_events WHERE tenant_id = $1 AND entity_id = $2 AND action = 'party_import.expired'`,
        [a.tenantId, stale.id],
      ),
    ).toBe(1);

    // The record reads as expired and cannot be committed; the database keeps it final.
    const read = detailOf((await request(baseUrl).get(`/v1/imports/${stale.id}`).expect(200)).body);
    expect(read).toMatchObject({ status: 'expired', rows: [], rowCount: 1 });
    const refused = await request(baseUrl).post(`/v1/imports/${stale.id}/commit`);
    expect(refused.status).toBe(409);
    expect(errorOf(refused.body).message).toMatch(/expired/);
    await expect(
      ownerPool.query(`UPDATE app.party_import_batches SET file_name = 'x' WHERE id = $1`, [
        stale.id,
      ]),
    ).rejects.toThrow(/final/);
  });

  it('refuses an expired batch that still holds rows (the check, not only the job, clears the personal data)', async () => {
    const kept = await preview('Kept');
    // Old check let `expired` keep any array; the finality trigger then blocked clearing it.
    await expect(
      ownerPool.query(`UPDATE app.party_import_batches SET status = 'expired' WHERE id = $1`, [
        kept.id,
      ]),
    ).rejects.toThrow(/party_import_batches_rows_check/);
    await withTx(db, a, systemActor('test'), (tx) =>
      tx.execute(
        sql`UPDATE app.party_import_batches SET status = 'expired', rows = '[]'::jsonb WHERE id = ${kept.id}::uuid`,
      ),
    );
    expect((await batch(kept.id)).status).toBe('expired');
  });
});
