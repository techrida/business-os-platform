// Integration tests of goods and service receipts on a real Postgres (Testcontainers, needs Docker in WSL).
// Real: migrations as bos_owner, queries as bos_app (so receipt_lines_guard and every 0034 CHECK run),
// ReceiptsService, NumberingService (GRN series) and AuditService. Faked: the request context and authz.assert, which
// still runs the real pure can() on a fake principal built from DEFAULT_ROLE_PERMISSIONS. The issued purchase
// orders are inserted directly as bos_owner, because PO issue is a later unit.
// Run: pnpm --filter @bos/api exec vitest run src/modules/procurement/receipts/receipts.integration.test.ts
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
  receiptLines,
  receipts,
} from '@bos/db';
import { ForbiddenException, HttpException } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { AuditService } from '../../../platform/audit/audit.service';
import type { AuthzService } from '../../../platform/authz/authz.service';
import { can } from '../../../platform/authz/can';
import type { Principal } from '../../../platform/authz/principal';
import type { Db, DbTransaction } from '../../../platform/db/db.module';
import { systemActor, withTx, type TxScope } from '../../../platform/db/tx';
import { NumberingService } from '../../../platform/settings/numbering.service';
import type { CreateReceiptBody } from './receipt.rules';
import { ReceiptsService } from './receipts.service';
import { createTestDatabase, type TestDatabase } from '@bos/db/testing';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 180_000 });

const now = new Date('2026-11-09T04:00:00Z');

let testDb: TestDatabase;
let ownerPool: Pool;
let appPool: Pool;
let db: Db;
let scopeA: TxScope;
let scopeB: TxScope;
let service: ReceiptsService;
let taxCodeId = '';
let vendorId = '';
let departmentA = '';
let departmentB = '';

/** Real staff users of entity A. */
const U = { warehouse: '', accountant: '', requester: '', other: '', procurement: '' };

const grantsOf = (role: RoleKey) =>
  new Map(Object.entries(DEFAULT_ROLE_PERMISSIONS[role])) as Map<Permission, Scope>;
const current: {
  userId: string;
  role: RoleKey;
  scope: TxScope | null;
  grants: Map<Permission, Scope> | null;
} = {
  userId: '',
  role: 'warehouse',
  scope: null,
  grants: null,
};
const as = (userId: string, role: RoleKey) => {
  current.userId = userId;
  current.role = role;
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
  departmentId: null,
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

const read = <T>(fn: (tx: DbTransaction) => Promise<T>) =>
  withTx(db, scopeA, systemActor('test'), fn);

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
  testDb = await createTestDatabase();
  const admin0 = new Pool({ connectionString: testDb.adminUrl, max: 1 });
  await admin0.end();
  const bosAdmin = new Pool({ connectionString: testDb.adminUrl, max: 1 });
  await bosAdmin.end();

  ownerPool = new Pool({ connectionString: testDb.ownerUrl, max: 2 });
  appPool = new Pool({ connectionString: testDb.appUrl, max: 8 });
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
  U.accountant = await staff('accountant');
  U.requester = await staff('operations_officer');
  U.other = await staff('operations_officer');
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

  // One vendor with an account in both entities.
  const party = await createParty(appPool, { tenantId: scopeA.tenantId, kind: 'vendor' });
  vendorId = party.partyId;
  const pan = randomUUID().replaceAll(/\D/g, '').padEnd(9, '7').slice(0, 9);
  await ownerRun(
    scopeA.organizationId,
    `INSERT INTO app.vendors (id, tenant_id, legal_name, kind, pan, country, created_by)
     VALUES ($1, $2, 'Himal Supplies Pvt. Ltd.', 'company', $3, 'NP', $4)`,
    [vendorId, scopeA.tenantId, pan, U.procurement],
  );
  for (const org of [scopeA.organizationId, scopeB.organizationId]) {
    await ownerRun(
      org,
      `INSERT INTO app.vendor_accounts (tenant_id, organization_id, vendor_id, default_currency)
       VALUES ($1, $2, $3, 'NPR')`,
      [scopeA.tenantId, org, vendorId],
    );
  }

  service = new ReceiptsService(
    db,
    authz as unknown as AuthzService,
    new AuditService(db),
    new NumberingService(),
    caller,
    () => now,
  );
});

afterAll(async () => {
  await appPool?.end();
  await ownerPool?.end();
  await testDb?.drop();
});

beforeEach(() => {
  current.scope = null;
  current.grants = null;
  as(U.warehouse, 'warehouse');
});

// ---------------------------------------------------------------------------------------- fixtures

let counter = 0;
const nextSeq = () => ++counter;

interface Po {
  id: string;
  /** line 1: 5 goods; line 2: 3 goods that need serials; line 3: 1 service. */
  goods: string;
  serialGoods: string;
  service: string;
}

/** A purchase request raised by `U.requester` and a PO (issued unless told otherwise) with three lines. */
async function newPo(options: { scope?: TxScope; status?: string } = {}): Promise<Po> {
  const scope = options.scope ?? scopeA;
  const status = options.status ?? 'issued';
  const draft = status === 'draft';
  const [pr] = await ownerRun<{ id: string }>(
    scope.organizationId,
    `INSERT INTO app.purchase_requests
       (tenant_id, organization_id, number, request_type, department_id, requester_user_id, cost_center_id,
        justification, required_by, budget_code, currency)
     VALUES ($1, $2, $3, 'mixed', $4, $5, $6, 'Network equipment and installation', '2026-12-31', 'IT-2026', 'NPR')
     RETURNING id`,
    [
      scope.tenantId,
      scope.organizationId,
      `PR-${randomUUID()}`,
      scope === scopeA ? departmentA : departmentB,
      U.requester,
      (await createCostCenter(appPool, scope)).costCenterId,
    ],
  );
  const [po] = await ownerRun<{ id: string }>(
    scope.organizationId,
    `INSERT INTO app.purchase_orders
       (tenant_id, organization_id, number, number_seq, fiscal_year, purchase_request_id, vendor_id, currency, status,
        payment_terms_days, approved_total, fx_rate, approved_total_npr, approved_band, current_version, issued_at,
        issued_by, created_by)
     VALUES ($1, $2, $3, $4, '2082/83', $5, $6, 'NPR', $7, 30, 2373.00, 1, 2373.00, 'base', $8,
             CASE WHEN $9 THEN NULL ELSE now() END, CASE WHEN $9 THEN NULL::uuid ELSE $10::uuid END, $10)
     RETURNING id`,
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
    ],
  );
  const lineIds: string[] = [];
  const specs = [
    {
      kind: 'goods',
      quantity: '5',
      price: '100.00',
      gross: '500.00',
      tax: '65.00',
      serials: false,
    },
    { kind: 'goods', quantity: '3', price: '200.00', gross: '600.00', tax: '78.00', serials: true },
    {
      kind: 'service',
      quantity: '1',
      price: '1000.00',
      gross: '1000.00',
      tax: '130.00',
      serials: false,
    },
  ];
  for (const [i, s] of specs.entries()) {
    const [line] = await ownerRun<{ id: string }>(
      scope.organizationId,
      `INSERT INTO app.purchase_order_lines
         (tenant_id, organization_id, purchase_order_id, purchase_request_id, line_no, kind, description, uom,
          ordered_quantity, unit_price, tax_code_id, gross, tax_amount, line_total, requires_serials)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'pcs', $8, $9, $10, $11, $12, $11::numeric + $12::numeric, $13)
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
        s.price,
        taxCodeId,
        s.gross,
        s.tax,
        s.serials,
      ],
    );
    lineIds.push(line!.id);
  }
  return { id: po!.id, goods: lineIds[0]!, serialGoods: lineIds[1]!, service: lineIds[2]! };
}

const draftBody = (
  po: Po,
  lines: CreateReceiptBody['lines'],
  kind: CreateReceiptBody['kind'] = 'goods',
): CreateReceiptBody => ({ purchaseOrderId: po.id, kind, receivedAt: '2026-11-09', lines });

const serials = (...nos: string[]) => nos.map((serialNo) => ({ serialNo }));

/** The HttpException `promise` rejects with; fails the test when it resolves. */
async function httpErrorOf(promise: Promise<unknown>): Promise<HttpException> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof HttpException) return error;
    throw error;
  }
  throw new Error('expected the call to fail');
}
const codeOf = (e: HttpException) => (e.getResponse() as { code?: string }).code;

const createDraft = (
  po: Po,
  lines: CreateReceiptBody['lines'],
  kind: CreateReceiptBody['kind'] = 'goods',
) => service.create(draftBody(po, lines, kind), randomUUID());
const confirm = (id: string) => service.confirm(id, randomUUID());
const reverse = (id: string, reason = 'Wrong delivery note') =>
  service.reverse(id, { reason }, randomUUID());

/** Draft and confirm as the warehouse. */
async function receiveGoods(po: Po, lines: CreateReceiptBody['lines']) {
  as(U.warehouse, 'warehouse');
  return confirm((await createDraft(po, lines)).id);
}

/** Draft and confirm the service line as its requester. */
async function receiveService(po: Po) {
  as(U.requester, 'operations_officer');
  const draft = await createDraft(po, [{ poLineId: po.service, quantity: '1' }], 'service');
  return confirm(draft.id);
}

const poStatus = async (po: Po) => {
  as(U.warehouse, 'warehouse');
  return (await service.progress(po.id)).status;
};

// ---------------------------------------------------------------------------------------- tests

describe('discard draft receipts', () => {
  it('releases pending quantity, keeps its audit trail and replays once', async () => {
    const po = await newPo();
    const draft = await createDraft(po, [{ poLineId: po.goods, quantity: '5' }]);
    const key = randomUUID();
    const discarded = await service.discard(draft.id, key);
    expect(discarded.status).toBe('discarded');
    expect(await service.discard(draft.id, key)).toEqual(discarded);
    expect(await service.discard(draft.id, randomUUID())).toEqual(discarded);
    expect((await service.progress(po.id)).lines[0]).toMatchObject({ pendingQuantity: '0.0000' });
    expect((await createDraft(po, [{ poLineId: po.goods, quantity: '5' }])).status).toBe('draft');
    const events = await new AuditService(db).list(scopeA, { entityId: draft.id, limit: 100 });
    expect(events.filter((e) => e.action === 'procurement.receipt.discarded')).toHaveLength(1);
  });

  it('refuses confirmed receipts, another entity and an unauthorized accountant', async () => {
    const po = await newPo();
    const draft = await createDraft(po, [{ poLineId: po.goods, quantity: '1' }]);
    current.scope = scopeB;
    expect((await httpErrorOf(service.discard(draft.id, randomUUID()))).getStatus()).toBe(404);
    current.scope = null;
    as(U.accountant, 'accountant');
    expect((await httpErrorOf(service.discard(draft.id, randomUUID()))).getStatus()).toBe(403);
    as(U.warehouse, 'warehouse');
    await confirm(draft.id);
    expect(codeOf(await httpErrorOf(service.discard(draft.id, randomUUID())))).toBe(
      'invalid_transition',
    );
  });

  it('frees serial reservations and allows cancelling the discarded quantity', async () => {
    const po = await newPo();
    const draft = await createDraft(po, [
      { poLineId: po.serialGoods, quantity: '3', serials: serials('A', 'B', 'C') },
    ]);
    await service.discard(draft.id, randomUUID());
    const replacement = await createDraft(po, [
      { poLineId: po.serialGoods, quantity: '3', serials: serials('A', 'B', 'C') },
    ]);
    await service.discard(replacement.id, randomUUID());
    await ownerRun(
      scopeA.organizationId,
      `UPDATE app.purchase_order_lines SET cancelled_quantity = ordered_quantity WHERE id = $1`,
      [po.serialGoods],
    );
  });

  it('serializes confirm against discard so only one transition wins', async () => {
    const po = await newPo();
    const draft = await createDraft(po, [{ poLineId: po.goods, quantity: '1' }]);
    const outcomes = await Promise.allSettled([
      confirm(draft.id),
      service.discard(draft.id, randomUUID()),
    ]);
    expect(outcomes.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const failure = outcomes.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(codeOf(failure.reason as HttpException)).toBe('invalid_transition');
  });
});

describe('over-receipt', () => {
  it('refuses 6 against 5 with 422 over_receipt, writes nothing and gives the GRN number back', async () => {
    const po = await newPo();
    const seqRows = await read(
      async (tx) =>
        (
          await tx.execute<{ max: number | null }>(
            sql`SELECT max(number_seq) AS max FROM app.receipts WHERE organization_id = ${scopeA.organizationId}`,
          )
        ).rows,
    );
    const max = seqRows[0]!.max;
    const err = await httpErrorOf(createDraft(po, [{ poLineId: po.goods, quantity: '6' }]));
    expect(err.getStatus()).toBe(422);
    expect(codeOf(err)).toBe('over_receipt');
    expect(
      await read((tx) => tx.select().from(receipts).where(eq(receipts.purchaseOrderId, po.id))),
    ).toEqual([]);

    // 5 against 5 passes and takes the very next number: the refused attempt consumed none.
    const ok = await createDraft(po, [{ poLineId: po.goods, quantity: '5' }]);
    expect(ok.status).toBe('draft');
    expect(ok.number).toMatch(/^GRN-/);
    const [row] = await read((tx) => tx.select().from(receipts).where(eq(receipts.id, ok.id)));
    expect(row!.numberSeq).toBe((max ?? 0) + 1);
  });

  it('counts the units a draft already holds', async () => {
    const po = await newPo();
    await createDraft(po, [{ poLineId: po.goods, quantity: '3' }]);
    const err = await httpErrorOf(createDraft(po, [{ poLineId: po.goods, quantity: '3' }]));
    expect(codeOf(err)).toBe('over_receipt');
    await createDraft(po, [{ poLineId: po.goods, quantity: '2' }]);
  });

  it('tells the receiver to ask Procurement to amend the order first (F1-Q39)', async () => {
    const po = await newPo();
    const err = await httpErrorOf(createDraft(po, [{ poLineId: po.goods, quantity: '6' }]));
    expect(err.getStatus()).toBe(422);
    expect(codeOf(err)).toBe('over_receipt');
    expect((err.getResponse() as { message?: string }).message).toBe(
      'Line 1 has only 5 still open on the purchase order. To receive more, ask Procurement to amend the purchase order first.',
    );
  });

  it('lets exactly one of two parallel receivers of 3 against 5 through', async () => {
    const po = await newPo();
    const results = await Promise.allSettled([
      createDraft(po, [{ poLineId: po.goods, quantity: '3' }]),
      createDraft(po, [{ poLineId: po.goods, quantity: '3' }]),
    ]);
    const ok = results.filter((r) => r.status === 'fulfilled');
    const failed = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect(codeOf(failed[0]!.reason as HttpException)).toBe('over_receipt');
  });
});

describe('serials', () => {
  it('needs as many serials as units on a line that asks for them', async () => {
    const po = await newPo();
    const few = await httpErrorOf(
      createDraft(po, [{ poLineId: po.serialGoods, quantity: '3', serials: serials('S1', 'S2') }]),
    );
    expect(codeOf(few)).toBe('serials_required');
    const none = await httpErrorOf(createDraft(po, [{ poLineId: po.serialGoods, quantity: '3' }]));
    expect(codeOf(none)).toBe('serials_required');

    const confirmed = await receiveGoods(po, [
      { poLineId: po.serialGoods, quantity: '3', serials: serials('S1', 'S2', 'S3') },
    ]);
    expect(confirmed.status).toBe('confirmed');
    expect(confirmed.lines[0]!.serials.map((s) => s.serialNo)).toEqual(['S1', 'S2', 'S3']);
  });

  it('refuses a duplicate serial, in one line and across receipts of the same PO line', async () => {
    const po = await newPo();
    const twice = await httpErrorOf(
      createDraft(po, [{ poLineId: po.serialGoods, quantity: '2', serials: serials('D1', 'D1') }]),
    );
    expect(codeOf(twice)).toBe('serial_duplicate');

    await receiveGoods(po, [
      { poLineId: po.serialGoods, quantity: '2', serials: serials('D1', 'D2') },
    ]);
    const again = await httpErrorOf(
      createDraft(po, [{ poLineId: po.serialGoods, quantity: '1', serials: serials('D1') }]),
    );
    expect(again.getStatus()).toBe(422);
    expect(codeOf(again)).toBe('serial_duplicate');
    await createDraft(po, [{ poLineId: po.serialGoods, quantity: '1', serials: serials('D3') }]);
  });

  it('refuses serials on a line that does not take them', async () => {
    const po = await newPo();
    const err = await httpErrorOf(
      createDraft(po, [{ poLineId: po.goods, quantity: '1', serials: serials('X1') }]),
    );
    expect(codeOf(err)).toBe('serials_not_allowed');
  });
});

describe('who may receive', () => {
  it('lets the warehouse confirm goods and moves the PO to partially received', async () => {
    const po = await newPo();
    as(U.warehouse, 'warehouse');
    const draft = await createDraft(po, [{ poLineId: po.goods, quantity: '2' }]);
    expect(draft.status).toBe('draft');
    expect(await poStatus(po)).toBe('issued');
    const done = await confirm(draft.id);
    expect(done.status).toBe('confirmed');
    expect(done.confirmedBy).toBe(U.warehouse);
    expect(await poStatus(po)).toBe('partially_received');
  });

  it('refuses an accountant, and the requester, for goods (403) and leaves the draft a draft', async () => {
    const po = await newPo();
    as(U.warehouse, 'warehouse');
    const draft = await createDraft(po, [{ poLineId: po.goods, quantity: '2' }]);

    for (const [user, role] of [
      [U.accountant, 'accountant'],
      [U.requester, 'operations_officer'],
      [U.procurement, 'procurement'],
    ] as const) {
      as(user, role);
      const onConfirm = await httpErrorOf(confirm(draft.id));
      expect(onConfirm.getStatus()).toBe(403);
      const onCreate = await httpErrorOf(createDraft(po, [{ poLineId: po.goods, quantity: '1' }]));
      expect(onCreate.getStatus()).toBe(403);
    }
    as(U.warehouse, 'warehouse');
    expect((await service.get(draft.id)).status).toBe('draft');
  });

  it('lets the requester confirm a service receipt, and no other officer', async () => {
    const po = await newPo();
    as(U.other, 'operations_officer');
    const refused = await httpErrorOf(
      createDraft(po, [{ poLineId: po.service, quantity: '1' }], 'service'),
    );
    expect(refused.getStatus()).toBe(403);

    const done = await receiveService(po);
    expect(done.kind).toBe('service');
    expect(done.status).toBe('confirmed');
    expect(done.confirmedBy).toBe(U.requester);
    expect(await poStatus(po)).toBe('partially_received');
  });

  it('keeps a goods line out of a receipt labelled service', async () => {
    const po = await newPo();
    as(U.requester, 'operations_officer');
    const err = await httpErrorOf(
      createDraft(po, [{ poLineId: po.goods, quantity: '1' }], 'service'),
    );
    expect(codeOf(err)).toBe('receipt_kind_mismatch');
  });

  it('refuses to receive on a PO that is not issued', async () => {
    for (const status of ['draft', 'fully_received', 'closed', 'amendment_pending']) {
      const po = await newPo({ status });
      const err = await httpErrorOf(createDraft(po, [{ poLineId: po.goods, quantity: '1' }]));
      expect(err.getStatus()).toBe(409);
      expect(codeOf(err)).toBe('invalid_transition');
    }
  });

  it('tells each caller which receipt actions it may take, and offers a read-only buyer none', async () => {
    const po = await newPo();
    as(U.warehouse, 'warehouse');
    const goods = await createDraft(po, [{ poLineId: po.goods, quantity: '1' }]);
    as(U.requester, 'operations_officer');
    const svc = await createDraft(po, [{ poLineId: po.service, quantity: '1' }], 'service');
    const none = { confirm: false, discard: false, reverse: false };
    const draftActions = { confirm: true, discard: true, reverse: false };

    as(U.warehouse, 'warehouse');
    expect((await service.get(goods.id)).can).toEqual(draftActions);
    expect((await service.get(svc.id)).can).toEqual(draftActions);
    expect((await service.progress(po.id)).can).toEqual({ goods: true, service: true });

    // Procurement reads every receipt but receives nothing: no Confirm or Discard, not even on a service.
    as(U.procurement, 'procurement');
    expect((await service.get(svc.id)).can).toEqual(none);
    expect((await service.list(po.id)).map((r) => r.can)).toEqual([none, none]);
    expect((await service.progress(po.id)).can).toEqual({ goods: false, service: false });

    as(U.requester, 'operations_officer');
    expect((await service.get(svc.id)).can).toEqual(draftActions);
    expect((await service.get(goods.id)).can).toEqual(none);
    expect((await service.progress(po.id)).can).toEqual({ goods: false, service: true });

    as(U.warehouse, 'warehouse');
    await confirm(goods.id);
    expect((await service.get(goods.id)).can).toEqual({
      confirm: false,
      discard: false,
      reverse: true,
    });
  });

  it('refuses to confirm twice', async () => {
    const po = await newPo();
    const done = await receiveGoods(po, [{ poLineId: po.goods, quantity: '1' }]);
    const err = await httpErrorOf(confirm(done.id));
    expect(codeOf(err)).toBe('invalid_transition');
  });
});

describe('reversal', () => {
  it('is a negative receipt, moves the original to reversed and recomputes the PO status', async () => {
    const po = await newPo();
    const goods = await receiveGoods(po, [{ poLineId: po.goods, quantity: '5' }]);
    const serial = await receiveGoods(po, [
      { poLineId: po.serialGoods, quantity: '3', serials: serials('R1', 'R2', 'R3') },
    ]);
    await receiveService(po);
    expect(await poStatus(po)).toBe('fully_received');

    as(U.warehouse, 'warehouse');
    const reversal = await reverse(goods.id);
    expect(reversal.status).toBe('confirmed');
    expect(reversal.reversesReceiptId).toBe(goods.id);
    expect(reversal.reversalReason).toBe('Wrong delivery note');
    expect(reversal.number).toMatch(/^GRN-/);
    expect(reversal.number).not.toBe(goods.number);
    expect(reversal.lines).toHaveLength(1);
    expect(reversal.lines[0]).toMatchObject({
      poLineId: po.goods,
      quantity: '-5.0000',
      reversesReceiptLineId: goods.lines[0]!.id,
    });
    expect((await service.get(goods.id)).status).toBe('reversed');
    expect(await poStatus(po)).toBe('partially_received');

    const progress = await service.progress(po.id);
    expect(progress.lines[0]).toMatchObject({ receivedQuantity: '0.0000', openQuantity: '5.0000' });
    expect(progress.lines[1]).toMatchObject({ receivedQuantity: '3.0000', openQuantity: '0.0000' });

    // The units are open again: receiving 5 is fine and 6 is not.
    const over = await httpErrorOf(createDraft(po, [{ poLineId: po.goods, quantity: '6' }]));
    expect(codeOf(over)).toBe('over_receipt');
    await createDraft(po, [{ poLineId: po.goods, quantity: '5' }]);

    // Reversing the last receipts takes the PO back to issued, and the serials are free again.
    await reverse(serial.id);
    const rows = await service.list(po.id);
    expect(rows.filter((r) => r.reversesReceiptId !== null)).toHaveLength(2);
    const again = await createDraft(po, [
      { poLineId: po.serialGoods, quantity: '3', serials: serials('R1', 'R2', 'R3') },
    ]);
    expect(again.status).toBe('draft');
  });

  it('takes the PO back to issued when everything is reversed', async () => {
    const po = await newPo();
    const done = await receiveGoods(po, [{ poLineId: po.goods, quantity: '2' }]);
    expect(await poStatus(po)).toBe('partially_received');
    await reverse(done.id);
    expect(await poStatus(po)).toBe('issued');
  });

  it('is full, once, and not of a reversal', async () => {
    const po = await newPo();
    const done = await receiveGoods(po, [{ poLineId: po.goods, quantity: '2' }]);
    const reversal = await reverse(done.id);
    for (const id of [done.id, reversal.id]) {
      const err = await httpErrorOf(reverse(id));
      expect(err.getStatus()).toBe(409);
      expect(codeOf(err)).toBe('invalid_transition');
    }
    const draft = await createDraft(po, [{ poLineId: po.goods, quantity: '1' }]);
    expect(codeOf(await httpErrorOf(reverse(draft.id)))).toBe('invalid_transition');
  });

  it('stores negative quantities only on the reversal lines', async () => {
    const po = await newPo();
    const done = await receiveGoods(po, [{ poLineId: po.goods, quantity: '2' }]);
    const reversal = await reverse(done.id);
    const rows = await read((tx) =>
      tx
        .select({ receiptId: receiptLines.receiptId, quantity: receiptLines.quantity })
        .from(receiptLines)
        .where(eq(receiptLines.purchaseOrderId, po.id)),
    );
    expect(rows.find((r) => r.receiptId === done.id)!.quantity).toBe('2.0000');
    expect(rows.find((r) => r.receiptId === reversal.id)!.quantity).toBe('-2.0000');
  });

  it('follows the same rule as confirming: an accountant is refused', async () => {
    const po = await newPo();
    const done = await receiveGoods(po, [{ poLineId: po.goods, quantity: '2' }]);
    as(U.accountant, 'accountant');
    expect((await httpErrorOf(reverse(done.id))).getStatus()).toBe(403);
    as(U.warehouse, 'warehouse');
    expect((await service.get(done.id)).status).toBe('confirmed');
  });
});

describe('progress view', () => {
  it('gives bill enterers vendor facts and progress without granting receipt access', async () => {
    const po = await newPo();
    const receipt = await createDraft(po, [{ poLineId: po.goods, quantity: '1' }]);
    as(U.accountant, 'accountant');
    expect(await service.progress(po.id)).toMatchObject({
      vendorId,
      vendorName: 'Himal Supplies Pvt. Ltd.',
    });
    expect((await httpErrorOf(service.get(receipt.id))).getStatus()).toBe(403);
    expect((await httpErrorOf(service.list(po.id))).getStatus()).toBe(403);
    current.scope = scopeB;
    expect((await httpErrorOf(service.progress(po.id))).getStatus()).toBe(404);
  });

  it('checks the purchase request scope of the bill-entry grant on progress', async () => {
    const po = await newPo();
    current.grants = new Map([['payables.bill.enter', 'own']]);
    as(U.accountant, 'accountant');
    expect((await httpErrorOf(service.progress(po.id))).getStatus()).toBe(404);
    as(U.requester, 'operations_officer');
    expect((await service.progress(po.id)).purchaseOrderId).toBe(po.id);
  });

  it('shows ordered, received, pending and billed per line', async () => {
    const po = await newPo();
    await receiveGoods(po, [{ poLineId: po.goods, quantity: '2' }]);
    await createDraft(po, [{ poLineId: po.goods, quantity: '1' }]);
    const progress = await service.progress(po.id);
    expect(progress.status).toBe('partially_received');
    expect(progress.lines.map((l) => l.lineNo)).toEqual([1, 2, 3]);
    expect(progress.lines[0]).toMatchObject({
      poLineId: po.goods,
      orderedQuantity: '5.0000',
      cancelledQuantity: '0.0000',
      receivedQuantity: '2.0000',
      pendingQuantity: '1.0000',
      openQuantity: '3.0000',
      billedQuantity: '0.0000',
    });
    expect(progress.lines[2]).toMatchObject({ kind: 'service', receivedQuantity: '0.0000' });
  });

  it('is readable by the warehouse, procurement, bill enterers and the requester, not another officer', async () => {
    const po = await newPo();
    for (const [user, role] of [
      [U.warehouse, 'warehouse'],
      [U.procurement, 'procurement'],
      [U.requester, 'operations_officer'],
      [U.accountant, 'accountant'],
    ] as const) {
      as(user, role);
      expect((await service.progress(po.id)).purchaseOrderId).toBe(po.id);
    }
    as(U.other, 'operations_officer');
    expect((await httpErrorOf(service.progress(po.id))).getStatus()).toBe(404);
  });
});

describe('before any read', () => {
  it('answers 403, not 404, to a caller with no grant over receipts, whatever id they guess', async () => {
    as(U.accountant, 'accountant');
    const missing = randomUUID();
    const calls = [
      () => service.get(missing),
      () => service.list(missing),
      () => confirm(missing),
      () => reverse(missing),
      () =>
        service.create(
          draftBody({ id: missing, goods: missing, serialGoods: missing, service: missing }, [
            { poLineId: missing, quantity: '1' },
          ]),
          randomUUID(),
        ),
    ];
    for (const call of calls) expect((await httpErrorOf(call())).getStatus()).toBe(403);
    // A caller who holds one grant is let through and gets the honest 404 for an id that does not exist.
    as(U.warehouse, 'warehouse');
    expect((await httpErrorOf(service.progress(missing))).getStatus()).toBe(404);
  });
});

describe('idempotency', () => {
  it('replays the same key to the same receipt', async () => {
    const po = await newPo();
    const body = draftBody(po, [{ poLineId: po.goods, quantity: '1' }]);
    const key = randomUUID();
    const first = await service.create(body, key);
    const second = await service.create(body, key);
    expect(second.id).toBe(first.id);
    expect(await service.list(po.id)).toHaveLength(1);
    const changed = await httpErrorOf(
      service.create(draftBody(po, [{ poLineId: po.goods, quantity: '2' }]), key),
    );
    expect(changed.getStatus()).toBe(422);
  });
});

describe('another entity', () => {
  it('answers 404 for a PO or receipt of another entity, on every route', async () => {
    const poB = await newPo({ scope: scopeB });
    const [{ id: receiptB }] = (await ownerRun<{ id: string }>(
      scopeB.organizationId,
      `INSERT INTO app.receipts (tenant_id, organization_id, number, number_seq, fiscal_year, purchase_order_id, kind,
                                 received_at, created_by)
       VALUES ($1, $2, $3, $4, '2082/83', $5, 'goods', '2026-11-09', $6) RETURNING id`,
      [
        scopeA.tenantId,
        scopeB.organizationId,
        `GRN-${randomUUID()}`,
        nextSeq(),
        poB.id,
        U.warehouse,
      ],
    )) as [{ id: string }];

    as(U.warehouse, 'warehouse');
    const calls = [
      () => createDraft(poB, [{ poLineId: poB.goods, quantity: '1' }]),
      () => service.progress(poB.id),
      () => service.list(poB.id),
      () => service.get(receiptB),
      () => confirm(receiptB),
      () => reverse(receiptB),
    ];
    for (const call of calls) {
      const err = await httpErrorOf(call());
      expect(err.getStatus()).toBe(404);
    }
    // And nothing of entity B moved.
    const [row] = await ownerRun<{ status: string }>(
      scopeB.organizationId,
      `SELECT status FROM app.receipts WHERE id = $1`,
      [receiptB],
    );
    expect(row!.status).toBe('draft');
  });

  it('keeps a line of another PO out of a receipt', async () => {
    const po = await newPo();
    const other = await newPo();
    const err = await httpErrorOf(createDraft(po, [{ poLineId: other.goods, quantity: '1' }]));
    expect(codeOf(err)).toBe('po_line_unknown');
  });
});

describe('receipt date (FX6 #6): today in Kathmandu at the latest', () => {
  // Kathmandu is UTC+05:45, so its day turns at 18:15 UTC.
  const lastSecondOfNov9 = new Date('2026-11-09T18:14:59Z');
  const firstSecondOfNov10 = new Date('2026-11-09T18:15:00Z');
  let at = lastSecondOfNov9;
  const clocked = () =>
    new ReceiptsService(
      db,
      authz as unknown as AuthzService,
      new AuditService(db),
      new NumberingService(),
      caller,
      () => at,
    );
  const dated = (po: Po, receivedAt: string): CreateReceiptBody => ({
    ...draftBody(po, [{ poLineId: po.goods, quantity: '1' }]),
    receivedAt,
  });
  const receiptsOf = (po: Po) =>
    read((tx) => tx.select().from(receipts).where(eq(receipts.purchaseOrderId, po.id)));

  it('takes today and refuses tomorrow on create, with 422 RECEIPT_DATE_IN_FUTURE, writing nothing', async () => {
    const po = await newPo();
    at = lastSecondOfNov9;
    const svc = clocked();

    const refused = await httpErrorOf(svc.create(dated(po, '2026-11-10'), randomUUID()));
    expect(refused.getStatus()).toBe(422);
    expect(refused.getResponse()).toMatchObject({
      code: 'RECEIPT_DATE_IN_FUTURE',
      details: { receivedAt: '2026-11-10', today: '2026-11-09' },
    });
    expect(await receiptsOf(po)).toEqual([]);

    const ok = await svc.create(dated(po, '2026-11-09'), randomUUID());
    expect(ok).toMatchObject({ status: 'draft', receivedAt: '2026-11-09' });
  });

  it('follows the Kathmandu day, not the UTC one, at its midnight', async () => {
    const po = await newPo();
    // 18:15 UTC on 9 November is already 10 November in Kathmandu.
    at = firstSecondOfNov10;
    const svc = clocked();
    expect(await svc.create(dated(po, '2026-11-10'), randomUUID())).toMatchObject({
      receivedAt: '2026-11-10',
    });
    expect(codeOf(await httpErrorOf(svc.create(dated(po, '2026-11-11'), randomUUID())))).toBe(
      'RECEIPT_DATE_IN_FUTURE',
    );
  });

  it('refuses to confirm a draft dated after the day it is confirmed, and confirms it once that day comes', async () => {
    const po = await newPo();
    at = lastSecondOfNov9;
    const svc = clocked();
    const draft = await svc.create(dated(po, '2026-11-09'), randomUUID());
    // A draft saved before the rule, or edited outside the API, can carry a later date.
    await ownerRun(
      scopeA.organizationId,
      `UPDATE app.receipts SET received_at = $1 WHERE id = $2`,
      ['2026-11-10', draft.id],
    );

    const refused = await httpErrorOf(svc.confirm(draft.id, randomUUID()));
    expect(refused.getStatus()).toBe(422);
    expect(codeOf(refused)).toBe('RECEIPT_DATE_IN_FUTURE');
    const [row] = await read((tx) => tx.select().from(receipts).where(eq(receipts.id, draft.id)));
    expect(row).toMatchObject({ status: 'draft', confirmedAt: null });

    at = firstSecondOfNov10;
    expect(await svc.confirm(draft.id, randomUUID())).toMatchObject({ status: 'confirmed' });
  });
});
