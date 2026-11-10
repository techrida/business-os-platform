// Integration test of the vendor portal's RFQ reads on a real Postgres (Testcontainers, needs Docker in WSL), PV3 and
// done check 13. Real: migrations as bos_owner, queries as bos_app, VendorPortalRfqService over the real
// DrizzleVendorPortalRfqStore and DrizzleVendorPortalStore (the kernel scopeWhereFor through the invitation view).
// Faked: the caller (a vendor Principal per test). Seeds are plain inserts, as the sourcing tests do: a purchase
// request with its lines (lines go in while the request is a draft, then it moves to sourcing), an RFQ on it and
// its invitations. A `recommended` RFQ is not seeded: its CHECK needs a quotation, and the store's rule is the same
// `status = 'open'` that hides closed and cancelled ones.
// Run: pnpm --filter @bos/api exec vitest run src/modules/portal-vendor/portal-vendor-rfq.integration.test.ts
import 'reflect-metadata';

import { randomUUID } from 'node:crypto';

import type { Permission, Scope } from '@bos/contracts';
import {
  createCostCenter,
  createDepartment,
  createParty,
  createStaffUser,
  createTenantWithEntity,
  runMigrations,
} from '@bos/db';
import { ForbiddenException, HttpException } from '@nestjs/common';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { Principal } from '../../platform/authz/principal';
import type { Db } from '../../platform/db/db.module';
import { systemActor, withTx, type TxScope } from '../../platform/db/tx';
import type { VendorPortalCaller } from '../portal/vendor-portal.caller';
import { VendorPortalRfqService } from './portal-vendor-rfq.service';
import { DrizzleVendorPortalRfqStore } from './portal-vendor-rfq.store';
import { DrizzleVendorPortalStore } from './portal-vendor.store';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 180_000 });

const OWNER_PW = 'owner-test-pw';
const APP_PW = 'app-test-pw';
const DEADLINE = new Date('2026-11-20T11:00:00Z');

let container: StartedPostgreSqlContainer;
let appPool: Pool;
let db: Db;
let scopeA: TxScope;
let scopeB: TxScope;
let idpOrgId: string;
let staffId: string;
/** Approves vendors: never the creator (vendors_approved_by_check). */
let approverId: string;
let deptA: string;
let deptB: string;
let service: VendorPortalRfqService;

const current: { p: Principal | null } = { p: null };
const caller: VendorPortalCaller = {
  current: () => {
    if (current.p === null) throw new Error('no principal');
    return current.p;
  },
};

const urlFor = (user: string, password: string, database: string) => {
  const url = new URL(container.getConnectionUri());
  url.username = user;
  url.password = password;
  url.pathname = `/${database}`;
  return url.toString();
};
const exec = (scope: TxScope, q: ReturnType<typeof sql>) =>
  withTx(db, scope, systemActor('test'), (tx) => tx.execute(q));

/** A vendor portal principal for `partyId`, acting in `scope`. */
function asVendor(partyId: string, scope: TxScope = scopeA, overrides: Partial<Principal> = {}) {
  current.p = {
    userId: randomUUID(),
    zitadelUserId: `z-${partyId.slice(0, 8)}`,
    tenantId: scope.tenantId,
    organizationId: scope.organizationId,
    orgKind: 'vendor',
    partyId,
    idpOrgId: `idp-${partyId.slice(0, 8)}`,
    roles: ['vendor_user'],
    departmentId: null,
    status: 'active',
    grants: new Map<Permission, Scope>([
      ['portal.vendor.read', 'customer_org'],
      ['portal.vendor.submit', 'customer_org'],
    ]),
    ...overrides,
  };
}

/** The status and body of the HttpException `promise` rejects with. */
async function errorOf(promise: Promise<unknown>): Promise<{ status: number; body: unknown }> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof HttpException)
      return { status: error.getStatus(), body: error.getResponse() };
    throw error;
  }
  throw new Error('expected the call to fail');
}

const FORBIDDEN = {
  status: 403,
  body: { code: 'forbidden', message: 'Forbidden', reason: 'no_permission' },
};

type VendorStatus = 'approved' | 'pending_kyc' | 'suspended';
let panSeq = 0;
/** A vendor in `status` with an active account in each of `accountIn`. */
async function vendor(status: VendorStatus, accountIn: TxScope[] = [scopeA]): Promise<string> {
  const { partyId } = await createParty(appPool, {
    tenantId: scopeA.tenantId,
    kind: 'vendor',
    organizationId: scopeA.organizationId,
  });
  await exec(
    scopeA,
    sql`INSERT INTO app.vendors (id, tenant_id, legal_name, pan, status, created_by, approved_by)
        VALUES (${partyId}, ${scopeA.tenantId}, ${`Vendor ${partyId.slice(0, 6)}`},
                ${String(400_000_000 + (panSeq += 1))}, ${status}, ${staffId},
                ${status === 'pending_kyc' ? null : approverId})`,
  );
  for (const s of accountIn) {
    await exec(
      s,
      sql`INSERT INTO app.vendor_accounts (tenant_id, organization_id, vendor_id, active)
          VALUES (${s.tenantId}, ${s.organizationId}, ${partyId}, true)`,
    );
  }
  return partyId;
}

let rfqSeq = 0;
/**
 * An RFQ in `scope` on its own purchase request (one live RFQ per request), with two lines inserted out of order
 * and an estimated price on each, invited to `invited` and in `status`.
 */
async function rfq(
  invited: string[],
  opts: { scope?: TxScope; status?: 'open' | 'closed' | 'cancelled' } = {},
): Promise<string> {
  const scope = opts.scope ?? scopeA;
  const prId = randomUUID();
  rfqSeq += 1;
  await exec(
    scope,
    sql`INSERT INTO app.purchase_requests (id, tenant_id, organization_id, request_type, department_id,
          requester_user_id, cost_center_id, justification, required_by, budget_code, currency)
        VALUES (${prId}, ${scope.tenantId}, ${scope.organizationId}, 'goods',
                ${scope === scopeA ? deptA : deptB}, ${staffId}, ${(await createCostCenter(appPool, scope)).costCenterId}, 'Replace switches', '2026-12-31',
                'IT-2083', 'NPR')`,
  );
  // Lines first: they are frozen once the request leaves draft.
  for (const [lineNo, description, uom, quantity, price, amount] of [
    [2, 'Cable', 'm', '50', '90.00', '4500.00'],
    [1, 'Switch', 'pcs', '2', '1500.50', '3001.00'],
  ] as const) {
    await exec(
      scope,
      sql`INSERT INTO app.purchase_request_lines (tenant_id, organization_id, purchase_request_id, line_no,
            description, specification, uom, quantity, estimated_unit_price, estimated_amount)
          VALUES (${scope.tenantId}, ${scope.organizationId}, ${prId}, ${lineNo}, ${description},
                  'Cat6, budget IT-2083', ${uom}, ${quantity}, ${price}, ${amount})`,
    );
  }
  await exec(
    scope,
    sql`UPDATE app.purchase_requests SET status = 'sourcing', fx_rate = 1, estimated_total = '7501.00',
          estimated_total_npr = '7501.00', number = ${`PR-RFQ-${prId.slice(0, 8)}`} WHERE id = ${prId}`,
  );
  const id = randomUUID();
  await exec(
    scope,
    sql`INSERT INTO app.rfqs (id, tenant_id, organization_id, purchase_request_id, number, deadline, created_by)
        VALUES (${id}, ${scope.tenantId}, ${scope.organizationId}, ${prId}, ${`RFQ-V-${rfqSeq}`}, ${DEADLINE},
                ${staffId})`,
  );
  for (const vendorId of invited) {
    await exec(
      scope,
      sql`INSERT INTO app.rfq_vendors (tenant_id, organization_id, rfq_id, vendor_id, invited_by)
          VALUES (${scope.tenantId}, ${scope.organizationId}, ${id}, ${vendorId}, ${staffId})`,
    );
  }
  if (opts.status !== undefined && opts.status !== 'open') {
    await exec(scope, sql`UPDATE app.rfqs SET status = ${opts.status} WHERE id = ${id}`);
  }
  return id;
}

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

  appPool = new Pool({ connectionString: urlFor('bos_app', APP_PW, 'bos'), max: 8 });
  db = drizzle({ client: appPool });

  const tenant = await createTenantWithEntity(appPool);
  idpOrgId = tenant.idpOrgId;
  scopeA = { tenantId: tenant.tenantId, organizationId: tenant.organizationId };
  const otherEntityId = randomUUID();
  await exec(
    scopeA,
    sql`INSERT INTO app.organizations (id, tenant_id, organization_id, name, code, legal_name, is_default)
        VALUES (${otherEntityId}, ${scopeA.tenantId}, ${otherEntityId}, ${`E-${otherEntityId}`},
                ${`E-${otherEntityId}`}, ${`E-${otherEntityId}`}, false)`,
  );
  scopeB = { tenantId: scopeA.tenantId, organizationId: otherEntityId };
  staffId = (await createStaffUser(appPool, { ...scopeA, idpOrgId, roleKeys: ['procurement'] }))
    .userId;
  approverId = (await createStaffUser(appPool, { ...scopeA, idpOrgId, roleKeys: ['management'] }))
    .userId;
  deptA = (await createDepartment(appPool, scopeA)).departmentId;
  deptB = (await createDepartment(appPool, scopeB)).departmentId;

  service = new VendorPortalRfqService(
    caller,
    new DrizzleVendorPortalStore(db),
    new DrizzleVendorPortalRfqStore(db),
  );
});

afterAll(async () => {
  await appPool?.end();
  await container?.stop();
});

describe('vendor portal RFQ isolation (PV3, done check 13)', () => {
  let invited: string;
  let uninvited: string;
  let openRfq: string;
  let closedRfq: string;
  let cancelledRfq: string;
  let otherEntityRfq: string;

  beforeAll(async () => {
    // `invited` trades with both entities; `uninvited` is a full vendor invited to nothing.
    invited = await vendor('approved', [scopeA, scopeB]);
    uninvited = await vendor('approved');
    const sibling = await vendor('approved');
    // The open RFQ also invites another vendor: the invited one must not see that.
    openRfq = await rfq([invited, sibling]);
    closedRfq = await rfq([invited], { status: 'closed' });
    cancelledRfq = await rfq([invited], { status: 'cancelled' });
    otherEntityRfq = await rfq([invited], { scope: scopeB });
    // An RFQ only the sibling is invited to.
    await rfq([sibling]);
  });

  it('shows an invited vendor its open RFQ, with the lines to quote and nothing else', async () => {
    asVendor(invited);
    const list = await service.listRfqs();
    expect(list).toHaveLength(1);
    expect(list[0]).toEqual({
      id: openRfq,
      number: list[0]?.number,
      deadline: DEADLINE.toISOString(),
    });
    expect(list[0]?.number).toMatch(/^RFQ-V-/);

    const view = await service.getRfq(openRfq);
    expect(view).toEqual({
      id: openRfq,
      number: list[0]?.number,
      deadline: '2026-11-20T11:00:00.000Z',
      lines: [
        { lineNo: 1, description: 'Switch', uom: 'pcs', quantity: '2.0000' },
        { lineNo: 2, description: 'Cable', uom: 'm', quantity: '50.0000' },
      ],
    });
    expect(JSON.stringify(view)).not.toMatch(/1500|4500|7501|IT-2083|Cat6/);
  });

  it('gives an uninvited vendor an empty list and a 404 for the RFQ', async () => {
    asVendor(uninvited);
    expect(await service.listRfqs()).toEqual([]);
    const e = await errorOf(service.getRfq(openRfq));
    expect(e.status).toBe(404);
  });

  it('hides a closed and a cancelled RFQ from the vendor that was invited', async () => {
    asVendor(invited);
    expect((await service.listRfqs()).map((r) => r.id)).toEqual([openRfq]);
    for (const id of [closedRfq, cancelledRfq]) {
      expect((await errorOf(service.getRfq(id))).status).toBe(404);
    }
  });

  it('answers one identical 404 body for every id that is not visible', async () => {
    asVendor(uninvited);
    const uninvitedOpen = await errorOf(service.getRfq(openRfq));
    const unknown = await errorOf(service.getRfq(randomUUID()));
    asVendor(invited);
    const closed = await errorOf(service.getRfq(closedRfq));
    const cancelled = await errorOf(service.getRfq(cancelledRfq));
    // Invited, and open, but in the other entity: the acting entity limits the read.
    const otherEntity = await errorOf(service.getRfq(otherEntityRfq));
    expect(uninvitedOpen.status).toBe(404);
    for (const e of [unknown, closed, cancelled, otherEntity]) expect(e).toEqual(uninvitedOpen);
  });

  it('reads RFQs in the acting entity only: the other entity sees its own, not the first one', async () => {
    asVendor(invited, scopeB);
    expect((await service.listRfqs()).map((r) => r.id)).toEqual([otherEntityRfq]);
    expect((await service.getRfq(otherEntityRfq)).lines).toHaveLength(2);
    expect((await errorOf(service.getRfq(openRfq))).status).toBe(404);
  });
});

describe('vendor portal RFQ capability by vendor status (PV3, done check 13)', () => {
  it('answers 403 to a pending_kyc vendor that is invited, on the list and on the RFQ', async () => {
    const pending = await vendor('pending_kyc');
    const id = await rfq([pending]);
    asVendor(pending);
    expect(await errorOf(service.listRfqs())).toEqual(FORBIDDEN);
    expect(await errorOf(service.getRfq(id))).toEqual(FORBIDDEN);
    expect(await errorOf(service.getRfq(randomUUID()))).toEqual(FORBIDDEN);
  });

  it('answers 403 to a suspended vendor: it may read orders but not quote', async () => {
    const suspended = await vendor('suspended');
    const id = await rfq([suspended]);
    asVendor(suspended);
    expect(await errorOf(service.listRfqs())).toEqual(FORBIDDEN);
    expect(await errorOf(service.getRfq(id))).toEqual(FORBIDDEN);
  });

  it('refuses a staff or customer principal, and a vendor party with no vendor record, with 403', async () => {
    const vendorParty = await vendor('approved');
    const id = await rfq([vendorParty]);
    asVendor(vendorParty, scopeA, { orgKind: 'staff' });
    await expect(service.listRfqs()).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.getRfq(id)).rejects.toBeInstanceOf(ForbiddenException);
    asVendor(vendorParty, scopeA, { orgKind: 'customer' });
    await expect(service.listRfqs()).rejects.toBeInstanceOf(ForbiddenException);
    asVendor(randomUUID());
    await expect(service.listRfqs()).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('shows nothing to a vendor principal whose grant is missing (the scope matches no row)', async () => {
    const vendorParty = await vendor('approved');
    await rfq([vendorParty]);
    asVendor(vendorParty, scopeA, { grants: new Map<Permission, Scope>() });
    expect(await service.listRfqs()).toEqual([]);
  });
});
