// Integration tests of GET /v1/procurement/receivable-orders on a real Postgres (Testcontainers, needs Docker in WSL).
// Real: migrations as bos_owner, queries as bos_app, ReceivableOrdersService, and ReceiptsService (drafts, confirms and
// reversals are made through it, so the quantities are the ones the receipt routes leave). Faked: the request context
// and authz.assert (the real pure can() on a fake principal). POs are inserted directly as bos_owner.
// Also covers the requester's side of U18 #4: RequestedOrdersService (the receipts picker of a requester) and the
// purchase orders PurchaseRequestsService.get returns with a request.
// Run: pnpm --filter @bos/api exec vitest run src/modules/procurement/receipts/receivable-orders.integration.test.ts
import 'reflect-metadata';

import { randomUUID } from 'node:crypto';

import {
  DEFAULT_ROLE_PERMISSIONS,
  type Permission,
  type RoleKey,
  type Scope,
} from '@bos/contracts';
import {
  createCostCenter,
  createDepartment,
  createParty,
  createStaffUser,
  createTenantWithEntity,
  runMigrations,
} from '@bos/db';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { AuditService } from '../../../platform/audit/audit.service';
import type { AuthzService } from '../../../platform/authz/authz.service';
import { can } from '../../../platform/authz/can';
import type { Principal } from '../../../platform/authz/principal';
import type { Db } from '../../../platform/db/db.module';
import { systemActor, withTx, type TxScope } from '../../../platform/db/tx';
import { NumberingService } from '../../../platform/settings/numbering.service';
import { ReceivableOrdersService } from './receivable-orders.service';
import { ReceiptsService } from './receipts.service';
import { RequestedOrdersService } from './requested-orders.service';
import { PurchaseRequestsService } from '../requests/purchase-requests.service';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 180_000 });

const OWNER_PW = 'owner-test-pw';
const APP_PW = 'app-test-pw';
const now = new Date('2026-11-09T04:00:00Z');
const VENDOR_NAME = 'Himal Supplies Pvt. Ltd.';

let container: StartedPostgreSqlContainer;
let ownerPool: Pool;
let appPool: Pool;
let db: Db;
let scopeA: TxScope;
let scopeB: TxScope;
let receipts: ReceiptsService;
let orders: ReceivableOrdersService;
let requested: RequestedOrdersService;
let requests: PurchaseRequestsService;
let taxCodeId = '';
let vendorId = '';
let departmentA = '';
let departmentB = '';

const U = { warehouse: '', requester: '', otherRequester: '', procurement: '' };

const grantsOf = (role: RoleKey) =>
  new Map(Object.entries(DEFAULT_ROLE_PERMISSIONS[role])) as Map<Permission, Scope>;
const current: {
  userId: string;
  role: RoleKey;
  scope: TxScope | null;
  /** Live grants an admin edited, instead of the role default; reset before each test. */
  grants?: Map<Permission, Scope>;
  departmentId?: string | null;
} = {
  userId: '',
  role: 'warehouse',
  scope: null,
};
const scopeNow = (): TxScope => current.scope ?? scopeA;
const principalNow = (): Principal => ({
  userId: current.userId,
  zitadelUserId: `z-${current.userId}`,
  ...scopeNow(),
  orgKind: 'staff',
  partyId: null,
  idpOrgId: 'unused',
  roles: [current.role],
  departmentId: current.departmentId ?? null,
  status: 'active',
  grants: current.grants ?? grantsOf(current.role),
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

const urlFor = (user: string, password: string, database: string) => {
  const url = new URL(container.getConnectionUri());
  url.username = user;
  url.password = password;
  url.pathname = `/${database}`;
  return url.toString();
};

/** One statement as bos_owner, in a transaction that carries the bos.* settings the audit trigger needs. */
async function ownerRun<T extends Record<string, unknown>>(
  organizationId: string,
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  const client = await ownerPool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `SELECT set_config('bos.tenant_id', $1, true), set_config('bos.organization_id', $2, true),
              set_config('bos.actor_kind', 'system', true), set_config('bos.actor_id', 'system:test', true),
              set_config('bos.correlation_id', $3, true), set_config('bos.ip', '', true),
              set_config('bos.user_agent', '', true)`,
      [scopeA.tenantId, organizationId, `sys-${randomUUID()}`],
    );
    const res = await client.query(text, params);
    await client.query('COMMIT');
    return res.rows as T[];
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
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

  ownerPool = new Pool({ connectionString: urlFor('bos_owner', OWNER_PW, 'bos'), max: 2 });
  appPool = new Pool({ connectionString: urlFor('bos_app', APP_PW, 'bos'), max: 8 });
  db = drizzle({ client: appPool });

  const tenant = await createTenantWithEntity(appPool);
  scopeA = { tenantId: tenant.tenantId, organizationId: tenant.organizationId };
  const otherEntityId = randomUUID();
  await withTx(db, scopeA, systemActor('test'), (tx) =>
    tx.execute(
      sql`INSERT INTO app.organizations (id, tenant_id, organization_id, name, code, legal_name, is_default)
          VALUES (${otherEntityId}, ${scopeA.tenantId}, ${otherEntityId}, ${`E-${otherEntityId}`},
                  ${`E-${otherEntityId}`}, ${`E-${otherEntityId}`}, false)`,
    ),
  );
  scopeB = { tenantId: scopeA.tenantId, organizationId: otherEntityId };

  const staff = async (roleKey: RoleKey) =>
    (await createStaffUser(appPool, { ...scopeA, idpOrgId: tenant.idpOrgId, roleKeys: [roleKey] }))
      .userId;
  U.warehouse = await staff('warehouse');
  U.requester = await staff('operations_officer');
  U.otherRequester = await staff('operations_officer');
  U.procurement = await staff('procurement');

  departmentA = (await createDepartment(appPool, scopeA)).departmentId;
  departmentB = (await createDepartment(appPool, scopeB)).departmentId;
  const [taxRow] = await ownerRun<{ id: string }>(
    scopeA.organizationId,
    `INSERT INTO app.tax_codes (tenant_id, code, name, kind, rate_bp, creditable, effective_from)
     VALUES ($1, 'VAT13', 'VAT 13%', 'vat', 1300, true, '2024-01-01') RETURNING id`,
    [scopeA.tenantId],
  );
  taxCodeId = taxRow!.id;

  // One vendor (tenant level) with an account in both entities.
  const party = await createParty(appPool, { tenantId: scopeA.tenantId, kind: 'vendor' });
  vendorId = party.partyId;
  const pan = randomUUID().replaceAll(/\D/g, '').padEnd(9, '7').slice(0, 9);
  await ownerRun(
    scopeA.organizationId,
    `INSERT INTO app.vendors (id, tenant_id, legal_name, kind, pan, country, created_by)
     VALUES ($1, $2, $3, 'company', $4, 'NP', $5)`,
    [vendorId, scopeA.tenantId, VENDOR_NAME, pan, U.procurement],
  );
  for (const org of [scopeA.organizationId, scopeB.organizationId]) {
    await ownerRun(
      org,
      `INSERT INTO app.vendor_accounts (tenant_id, organization_id, vendor_id, default_currency)
       VALUES ($1, $2, $3, 'NPR')`,
      [scopeA.tenantId, org, vendorId],
    );
  }

  receipts = new ReceiptsService(
    db,
    authz as unknown as AuthzService,
    new AuditService(db),
    new NumberingService(),
    caller,
    () => now,
  );
  orders = new ReceivableOrdersService(db, caller);
  requested = new RequestedOrdersService(db, caller);
  // get() reads only the database and the caller; the write collaborators are never reached.
  requests = new PurchaseRequestsService(
    db,
    authz as unknown as AuthzService,
    {} as never,
    {} as never,
    new AuditService(db),
    new NumberingService(),
    {} as never,
    caller,
  );
});

afterAll(async () => {
  await appPool?.end();
  await ownerPool?.end();
  await container?.stop();
});

beforeEach(() => {
  current.scope = null;
  current.userId = U.warehouse;
  current.role = 'warehouse';
  current.grants = undefined;
  current.departmentId = undefined;
});

// ---------------------------------------------------------------------------------------- fixtures

let counter = 0;
const nextSeq = () => ++counter;

interface LineSpec {
  kind: 'goods' | 'service';
  quantity: string;
  cancelled?: string;
}
const GOODS5: LineSpec = { kind: 'goods', quantity: '5' };
const GOODS3: LineSpec = { kind: 'goods', quantity: '3' };
const SERVICE1: LineSpec = { kind: 'service', quantity: '1' };

interface Po {
  id: string;
  number: string;
  lineIds: string[];
  prId: string;
}

/** A request and a PO in `scope` (issued unless told otherwise) with one line per spec; issued at `issuedAt`. */
async function newPo(
  options: {
    scope?: TxScope;
    status?: string;
    lines?: LineSpec[];
    issuedAt?: string;
    requester?: string;
  } = {},
): Promise<Po> {
  const scope = options.scope ?? scopeA;
  const status = options.status ?? 'issued';
  const draft = status === 'draft';
  const lines = options.lines ?? [GOODS5];
  const [pr] = await ownerRun<{ id: string }>(
    scope.organizationId,
    `INSERT INTO app.purchase_requests
       (tenant_id, organization_id, number, request_type, department_id, requester_user_id, cost_center_id,
        justification, required_by, budget_code, currency)
     VALUES ($1, $2, $3, 'mixed', $4, $5, $6, 'Equipment', '2026-12-31', 'IT-2026', 'NPR')
     RETURNING id`,
    [
      scope.tenantId,
      scope.organizationId,
      `PR-${randomUUID()}`,
      scope === scopeA ? departmentA : departmentB,
      options.requester ?? U.requester,
      (await createCostCenter(appPool, scope)).costCenterId,
    ],
  );
  const [po] = await ownerRun<{ id: string; number: string }>(
    scope.organizationId,
    `INSERT INTO app.purchase_orders
       (tenant_id, organization_id, number, number_seq, fiscal_year, purchase_request_id, vendor_id, currency, status,
        payment_terms_days, approved_total, fx_rate, approved_total_npr, approved_band, current_version, issued_at,
        issued_by, created_by)
     VALUES ($1, $2, $3, $4, '2082/83', $5, $6, 'NPR', $7, 30, 2373.00, 1, 2373.00, 'base', $8,
             CASE WHEN $9 THEN NULL ELSE $11::timestamptz END, CASE WHEN $9 THEN NULL::uuid ELSE $10::uuid END, $10)
     RETURNING id, number`,
    [
      scope.tenantId,
      scope.organizationId,
      `PO-${randomUUID()}`,
      nextSeq(),
      pr!.id,
      vendorId,
      status,
      draft ? 0 : 1,
      draft,
      U.procurement,
      options.issuedAt ?? now.toISOString(),
    ],
  );
  const lineIds: string[] = [];
  for (const [i, s] of lines.entries()) {
    const [line] = await ownerRun<{ id: string }>(
      scope.organizationId,
      `INSERT INTO app.purchase_order_lines
         (tenant_id, organization_id, purchase_order_id, purchase_request_id, line_no, kind, description, uom,
          ordered_quantity, cancelled_quantity, unit_price, tax_code_id, gross, tax_amount, line_total)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'pcs', $8, $9, 1.00, $10, $8::numeric, 0, $8::numeric)
       RETURNING id`,
      [
        scope.tenantId,
        scope.organizationId,
        po!.id,
        pr!.id,
        i + 1,
        s.kind,
        `Line ${i + 1}`,
        s.quantity,
        s.cancelled ?? '0',
        taxCodeId,
      ],
    );
    lineIds.push(line!.id);
  }
  return { id: po!.id, number: po!.number, lineIds, prId: pr!.id };
}

/** A receipt of `quantity` on one PO line through the receipt service; confirmed unless `draft`. */
async function receive(
  po: Po,
  quantity: string,
  options: { draft?: boolean; line?: number; kind?: 'goods' | 'service' } = {},
) {
  const created = await receipts.create(
    {
      purchaseOrderId: po.id,
      kind: options.kind ?? 'goods',
      receivedAt: '2026-11-09',
      lines: [{ poLineId: po.lineIds[options.line ?? 0]!, quantity }],
    },
    randomUUID(),
  );
  return options.draft ? created : receipts.confirm(created.id, randomUUID());
}

const listed = async (limit = 200) => orders.list({ limit });
const rowOf = async (po: Po) => (await listed()).find((r) => r.id === po.id);

// ---------------------------------------------------------------------------------------- tests

describe('receivable orders', () => {
  it('lists an issued PO with the documented row shape', async () => {
    const po = await newPo({ lines: [GOODS5, GOODS3, SERVICE1] });
    const row = await rowOf(po);
    expect(row).toEqual({
      id: po.id,
      number: po.number,
      vendorId,
      vendorName: VENDOR_NAME,
      kind: 'mixed',
      status: 'issued',
      issuedAt: now.toISOString(),
      openQuantity: '9.0000',
    });
  });

  it('derives kind from the lines: goods, service or mixed', async () => {
    const goods = await newPo({ lines: [GOODS5, GOODS3] });
    const service = await newPo({ lines: [SERVICE1] });
    const mixed = await newPo({ lines: [GOODS5, SERVICE1] });
    expect((await rowOf(goods))?.kind).toBe('goods');
    expect((await rowOf(service))?.kind).toBe('service');
    expect((await rowOf(mixed))?.kind).toBe('mixed');
  });

  it('counts each PO once however many lines and receipts it has', async () => {
    const po = await newPo({ lines: [GOODS5, GOODS3, SERVICE1] });
    await receive(po, '1');
    await receive(po, '1', { line: 1 });
    const rows = (await listed()).filter((r) => r.id === po.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.openQuantity).toBe('7.0000');
  });

  it('holds back the POs that cannot take a receipt', async () => {
    const issued = await newPo();
    const excluded = [
      await newPo({ status: 'draft' }),
      await newPo({ status: 'fully_received' }),
      await newPo({ status: 'amendment_pending' }),
      await newPo({ status: 'closed' }),
    ];
    const ids = (await listed()).map((r) => r.id);
    expect(ids).toContain(issued.id);
    for (const po of excluded) expect(ids).not.toContain(po.id);
  });

  it('shows a partially received PO with its reduced open quantity', async () => {
    const po = await newPo({ lines: [GOODS5, GOODS3] });
    await receive(po, '2');
    expect(await rowOf(po)).toMatchObject({ status: 'partially_received', openQuantity: '6.0000' });
  });

  it('ignores a draft receipt', async () => {
    const po = await newPo();
    await receive(po, '3', { draft: true });
    expect(await rowOf(po)).toMatchObject({ status: 'issued', openQuantity: '5.0000' });
  });

  it('nets a reversed receipt and its reversal to nothing', async () => {
    const po = await newPo();
    const confirmed = await receive(po, '2');
    expect((await rowOf(po))?.openQuantity).toBe('3.0000');
    await receipts.reverse(confirmed.id, { reason: 'Wrong delivery' }, randomUUID());
    expect(await rowOf(po)).toMatchObject({ status: 'issued', openQuantity: '5.0000' });
  });

  it('leaves out the cancelled quantity of a line', async () => {
    const po = await newPo({ lines: [{ kind: 'goods', quantity: '5', cancelled: '2' }, GOODS3] });
    expect((await rowOf(po))?.openQuantity).toBe('6.0000');
    await receive(po, '1');
    expect((await rowOf(po))?.openQuantity).toBe('5.0000');
  });

  it('returns the newest issued first and honours the limit', async () => {
    const older = await newPo({ issuedAt: '2026-01-01T00:00:00Z' });
    const newer = await newPo({ issuedAt: '2026-12-01T00:00:00Z' });
    const ids = (await listed()).map((r) => r.id);
    expect(ids.indexOf(newer.id)).toBeLessThan(ids.indexOf(older.id));
    expect((await listed(1))[0]?.id).toBe(newer.id);
    expect(await listed(1)).toHaveLength(1);
  });

  it('shows only the acting entity: another entity gets its own list, never entity A rows', async () => {
    const inA = await newPo();
    current.scope = scopeB;
    expect(await listed()).toEqual([]);
    const inB = await newPo({ scope: scopeB });
    const idsB = (await listed()).map((r) => r.id);
    expect(idsB).toEqual([inB.id]);
    expect(idsB).not.toContain(inA.id);
    current.scope = null;
    expect((await listed()).map((r) => r.id)).not.toContain(inB.id);
  });
});

// The purchase orders of the caller's own requests (U18 #4): the receipts page's picker for a requester, who holds
// no purchase order read. Always the caller's own requests, whatever their read scope, and only the acting entity.
describe("the requester's own purchase orders", () => {
  const asRequester = (userId = U.requester) => {
    current.userId = userId;
    current.role = 'operations_officer';
  };
  const mine = async () => requested.list({ limit: 200 });

  it("lists the caller's own orders with number, status and vendor, without drafts or cancelled ones", async () => {
    const service = await newPo({ lines: [SERVICE1] });
    const done = await newPo({ status: 'fully_received' });
    const draft = await newPo({ status: 'draft' });
    const cancelled = await newPo();
    await ownerRun(
      scopeA.organizationId,
      `UPDATE app.purchase_orders SET status = 'cancelled', closed_reason = 'Vendor withdrew' WHERE id = $1`,
      [cancelled.id],
    );
    asRequester();
    const rows = await mine();
    expect(rows.find((r) => r.id === service.id)).toEqual({
      id: service.id,
      number: service.number,
      status: 'issued',
      vendorName: VENDOR_NAME,
    });
    expect(rows.find((r) => r.id === done.id)?.status).toBe('fully_received');
    const ids = rows.map((r) => r.id);
    expect(ids).not.toContain(draft.id);
    expect(ids).not.toContain(cancelled.id);
  });

  it('returns only the picker fields: no amount, vendor id, request or creator rides along', async () => {
    await newPo({ lines: [SERVICE1] });
    asRequester();
    const rows = await mine();
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(Object.keys(row).sort()).toEqual(['id', 'number', 'status', 'vendorName']);
    }
  });

  it("never lists another requester's orders, even to a caller who reads every request", async () => {
    const theirs = await newPo({ requester: U.otherRequester });
    asRequester();
    expect((await mine()).map((r) => r.id)).not.toContain(theirs.id);
    current.userId = U.procurement;
    current.role = 'procurement';
    expect((await mine()).map((r) => r.id)).not.toContain(theirs.id);
    asRequester(U.otherRequester);
    expect((await mine()).map((r) => r.id)).toContain(theirs.id);
  });

  it('drops an order whose request the requester may no longer read after moving out of a department-scoped read', async () => {
    const po = await newPo({ lines: [SERVICE1] });
    asRequester();
    current.grants = new Map([...grantsOf('operations_officer'), ['procurement.pr.read', 'department']]);
    current.departmentId = departmentA;
    expect((await mine()).find((r) => r.id === po.id)).toEqual({
      id: po.id,
      number: po.number,
      status: 'issued',
      vendorName: VENDOR_NAME,
    });
    // The same requester, now in another department: the request's detail is a 404 for them, so the picker drops
    // the order and nothing of it (number, status or vendor) reaches them.
    current.departmentId = (await createDepartment(appPool, scopeA)).departmentId;
    await expect(requests.get(po.prId)).rejects.toBeInstanceOf(NotFoundException);
    const rows = await mine();
    expect(rows.map((r) => r.id)).not.toContain(po.id);
    const text = JSON.stringify(rows);
    expect(text).not.toContain(po.number);
    expect(text).not.toContain(VENDOR_NAME);
  });

  it("never lists another entity's orders", async () => {
    const inA = await newPo();
    const inB = await newPo({ scope: scopeB });
    asRequester();
    const idsA = (await mine()).map((r) => r.id);
    expect(idsA).toContain(inA.id);
    expect(idsA).not.toContain(inB.id);
    // The file shares one database: entity B may hold this requester's orders from earlier tests too.
    current.scope = scopeB;
    const idsB = (await mine()).map((r) => r.id);
    expect(idsB).toContain(inB.id);
    expect(idsB).not.toContain(inA.id);
  });
});

// A purchase request's detail names its orders (U18 #4) under the request's own read, with can.receiveService
// mirroring ReceiptsService.assertMayReceive for a service receipt.
describe('the purchase orders on a purchase request', () => {
  it('shows the requester each order with Receive service only on an open order with a service line', async () => {
    const service = await newPo({ lines: [SERVICE1] });
    current.userId = U.requester;
    current.role = 'operations_officer';
    const pr = await requests.get(service.prId);
    expect(pr.purchaseOrders).toEqual([
      {
        id: service.id,
        number: service.number,
        status: 'issued',
        vendorName: VENDOR_NAME,
        can: { receiveService: true },
      },
    ]);
    // The flag holds: the requester can record the service receipt it promises.
    await expect(
      receipts.create(
        {
          purchaseOrderId: service.id,
          kind: 'service',
          receivedAt: '2026-11-09',
          lines: [{ poLineId: service.lineIds[0]!, quantity: '1' }],
        },
        randomUUID(),
      ),
    ).resolves.toMatchObject({ purchaseOrderId: service.id });
  });

  it('offers no Receive service on a goods order, a received order, or to procurement', async () => {
    const goods = await newPo({ lines: [GOODS5] });
    const done = await newPo({ lines: [SERVICE1], status: 'fully_received' });
    current.userId = U.requester;
    current.role = 'operations_officer';
    expect((await requests.get(goods.prId)).purchaseOrders?.[0]?.can.receiveService).toBe(false);
    expect((await requests.get(done.prId)).purchaseOrders?.[0]?.can.receiveService).toBe(false);
    const service = await newPo({ lines: [SERVICE1] });
    current.userId = U.procurement;
    current.role = 'procurement';
    const seen = (await requests.get(service.prId)).purchaseOrders ?? [];
    expect(seen.map((o) => o.id)).toEqual([service.id]);
    expect(seen[0]?.can.receiveService).toBe(false);
  });

  it('adds only number, status, vendor name and the flag: no amount or vendor id rides along', async () => {
    const po = await newPo({ lines: [SERVICE1, GOODS3] });
    current.userId = U.requester;
    current.role = 'operations_officer';
    const [order] = (await requests.get(po.prId)).purchaseOrders ?? [];
    expect(Object.keys(order ?? {}).sort()).toEqual([
      'can',
      'id',
      'number',
      'status',
      'vendorName',
    ]);
    expect(Object.keys(order?.can ?? {})).toEqual(['receiveService']);
  });

  it('leaves out a draft order, and another requester cannot read the request at all', async () => {
    const draft = await newPo({ status: 'draft' });
    current.userId = U.requester;
    current.role = 'operations_officer';
    expect((await requests.get(draft.prId)).purchaseOrders).toEqual([]);
    current.userId = U.otherRequester;
    await expect(requests.get(draft.prId)).rejects.toBeInstanceOf(NotFoundException);
  });
});
