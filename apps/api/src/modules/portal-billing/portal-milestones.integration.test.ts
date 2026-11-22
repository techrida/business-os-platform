// Integration test of the portal milestones (F1-Q34) over HTTP on a real database (Testcontainers). Real: every
// migration as bos_owner, every query as bos_app, the controller behind configureApp and ErrorBodyFilter (the body a
// client sees), PortalMilestonesService. Faked: the request principal (PortalCaller); the route permission is the
// controller's @Can, checked by route-policy.check.test.ts.
// It pins: the customer sees its confirmed order's schedule as whitelisted fields (a cancelled line left out, a line
// with a draft invoice read as `reached` without the invoice, an invoiced line naming its issued invoice); another
// customer of the same tenant, a customer of another tenant, the own draft and cancelled orders and the own order in a
// non-default entity all answer one byte-identical 404 and never appear in the list; staff and vendor callers get 403.
// Seeds write the rows the sales-order and invoice services would (the deferred schedule-sum trigger still checks
// that the live lines add up to the order total).
import 'reflect-metadata';

import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { PortalSalesOrderSchema } from '@bos/contracts';
import { createParty } from '@bos/db';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import request from 'supertest';
import { z } from 'zod';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { configureApp } from '../../app.setup';
import type { Principal } from '../../platform/authz/principal';
import { systemActor, withTx, type TxScope } from '../../platform/db/tx';
import { ErrorBodyFilter } from '../../platform/tenancy/error-body.filter';
import {
  seedQuotationFixture,
  type QuotationFixture,
  type QuotationFixtureDb,
} from '../quotations/drafting/quotation.fixture';
import { PortalMilestonesController } from './portal-milestones.controller';
import { PortalMilestonesService } from './portal-milestones.service';
import { createTestDatabase, type TestDatabase } from '@bos/db/testing';

vi.setConfig({ testTimeout: 90_000, hookTimeout: 180_000 });

const REQUEST_ID = 'portal-milestones-probe-0001';
const seedActor = systemActor('portal-milestones-test-seed');

let testDb: TestDatabase;
let pool: Pool;
let db: QuotationFixtureDb;
let app: INestApplication;
let baseUrl: string;
let f: QuotationFixture;
let f2: QuotationFixture;
/** Another customer of tenant A, with no orders. */
let otherCustomer: string;
let soSeq = 0;
let invSeq = 0;

let current: Principal;
const caller = { current: () => current };

/** The orders the tests read. */
const orders = {} as {
  confirmed: string;
  draft: string;
  cancelled: string;
  otherEntity: string;
  otherTenant: string;
  invoiceId: string;
  draftInvoiceId: string;
};

interface LineSeed {
  label: string;
  trigger: string;
  percent: string | null;
  amount: string;
  status: 'planned' | 'billable' | 'drafted' | 'invoiced' | 'cancelled';
  plannedDate?: string;
}

/**
 * One sales order of `fx`'s customer in `entity`, with its schedule lines, in one transaction. A `drafted` line gets
 * a draft tax invoice, an `invoiced` line an issued one, both linked both ways as the invoice services link them.
 */
async function seedOrder(
  fx: QuotationFixture,
  entity: string,
  opportunityId: string,
  status: 'draft' | 'confirmed' | 'cancelled',
  lines: LineSeed[],
): Promise<{ orderId: string; invoices: Record<number, string> }> {
  const scope: TxScope = { tenantId: fx.tenantId, organizationId: entity };
  return withTx(db, scope, seedActor, async (tx) => {
    const one = async (q: ReturnType<typeof sql>) =>
      (await tx.execute<{ id: string }>(q)).rows[0]!.id;
    const quotationId = await one(
      sql`INSERT INTO app.quotations (tenant_id, organization_id, number, customer_party_id, opportunity_id)
          VALUES (${fx.tenantId}, ${entity}, ${`QT-${randomUUID().slice(0, 8)}`}, ${fx.customerPartyId},
                  ${opportunityId}) RETURNING id`,
    );
    const versionId = await one(
      sql`INSERT INTO app.quotation_versions (tenant_id, organization_id, quotation_id, revision_no, currency, issue_date, valid_until)
          VALUES (${fx.tenantId}, ${entity}, ${quotationId}, 1, 'NPR', '2026-11-09', '2026-12-09') RETURNING id`,
    );
    soSeq += 1;
    const numbered = status !== 'draft';
    const orderId = await one(
      sql`INSERT INTO app.sales_orders (tenant_id, organization_id, number, seq, fiscal_year, customer_party_id,
            quotation_id, quotation_version_id, status, currency, subtotal, discount_amount, taxable_amount, tax_amount,
            total, fx_rate, amount_npr, credit_days, confirmed_at, cancelled_at, cancel_reason)
          VALUES (${fx.tenantId}, ${entity}, ${numbered ? `SO-2083/84-${String(soSeq).padStart(5, '0')}` : null},
            ${numbered ? soSeq : null}, ${numbered ? '2083/84' : null}, ${fx.customerPartyId}, ${quotationId},
            ${versionId}, ${status}, 'NPR', 1000.00, 0, 1000.00, 130.00, 1130.00, 1, 1130.00, 30,
            ${numbered ? sql`'2026-11-02T04:00:00Z'::timestamptz` : null},
            ${status === 'cancelled' ? sql`now()` : null},
            ${status === 'cancelled' ? 'Customer withdrew' : null}) RETURNING id`,
    );
    const invoices: Record<number, string> = {};
    for (const [i, l] of lines.entries()) {
      const seq = i + 1;
      const initial = l.status === 'drafted' || l.status === 'invoiced' ? 'billable' : l.status;
      const lineId = await one(
        sql`INSERT INTO app.billing_schedule_lines (tenant_id, organization_id, sales_order_id, seq, label, "trigger",
              percent, amount, amount_npr, planned_date, status)
            VALUES (${fx.tenantId}, ${entity}, ${orderId}, ${seq}, ${l.label}, ${l.trigger}, ${l.percent},
                    ${l.amount}, ${l.amount}, ${l.plannedDate ?? null}, ${initial}) RETURNING id`,
      );
      if (initial === l.status) continue;
      const invoiceId = await one(
        sql`INSERT INTO app.invoices (tenant_id, organization_id, kind, customer_party_id, sales_order_id,
              schedule_line_id, currency, subtotal, discount_amount, taxable_vat_amount, tax_amount, total)
            VALUES (${fx.tenantId}, ${entity}, 'tax_invoice', ${fx.customerPartyId}, ${orderId}, ${lineId}, 'NPR',
                    400, 0, 400, 52, 452) RETURNING id`,
      );
      await tx.execute(sql`
        INSERT INTO app.invoice_lines (tenant_id, organization_id, invoice_id, line_no, description, uom, quantity,
          unit_price, tax_code_id, gross, discount_alloc, taxable)
        VALUES (${fx.tenantId}, ${entity}, ${invoiceId}, 1, ${l.label}, 'lot', 1, 400, ${fx.taxCodeVat13Id},
                400, 0, 400)`);
      await tx.execute(sql`
        INSERT INTO app.invoice_tax_summary (tenant_id, organization_id, invoice_id, tax_code_id, label, rate, base, tax)
        VALUES (${fx.tenantId}, ${entity}, ${invoiceId}, ${fx.taxCodeVat13Id}, 'VAT 13%', 13, 400, 52)`);
      await tx.execute(sql`
        UPDATE app.billing_schedule_lines SET status = 'drafted', invoice_id = ${invoiceId} WHERE id = ${lineId}`);
      if (l.status === 'invoiced') {
        invSeq += 1;
        const party = JSON.stringify({
          legalName: 'Acme Pvt. Ltd.',
          panVatNo: null,
          address: 'Kathmandu',
        });
        await tx.execute(sql`
          UPDATE app.invoices
             SET status = 'issued', number = ${`INV-2083/84-${String(invSeq).padStart(5, '0')}`}, seq = ${invSeq},
                 fiscal_year = '2083/84', issue_date = '2026-11-03', issue_date_bs = '2083-07-17',
                 due_date = '2026-12-03', fx_rate = 1, amount_npr = total,
                 seller_snapshot = ${party}::jsonb, buyer_snapshot = ${party}::jsonb,
                 content_hash = decode(repeat('ab', 32), 'hex'), issued_at = now()
           WHERE id = ${invoiceId}`);
        await tx.execute(
          sql`UPDATE app.billing_schedule_lines SET status = 'invoiced' WHERE id = ${lineId}`,
        );
      }
      invoices[seq] = invoiceId;
    }
    return { orderId, invoices };
  });
}

/** The 40/30/30 schedule of a 1,130.00 order (a cancelled line on top is left out of the sum). */
const SCHEDULE: LineSeed[] = [
  { label: 'Advance 40%', trigger: 'advance', percent: '40', amount: '452.00', status: 'invoiced' },
  {
    label: 'Design sign-off 30%',
    trigger: 'milestone',
    percent: '30',
    amount: '339.00',
    status: 'drafted',
  },
  {
    label: 'UAT 30%',
    trigger: 'uat',
    percent: '30',
    amount: '339.00',
    status: 'planned',
    plannedDate: '2026-12-15',
  },
  { label: 'Old line', trigger: 'manual', percent: null, amount: '50.00', status: 'cancelled' },
];
const PLANNED_ONLY: LineSeed[] = [
  { label: 'All 100%', trigger: 'advance', percent: '100', amount: '1130.00', status: 'planned' },
];

beforeAll(async () => {
  testDb = await createTestDatabase();
  const admin = new Pool({ connectionString: testDb.adminUrl, max: 1 });
  await admin.end();
  const bosAdmin = new Pool({ connectionString: testDb.adminUrl, max: 1 });
  await bosAdmin.end();

  pool = new Pool({ connectionString: testDb.appUrl, max: 6 });
  db = drizzle({ client: pool });

  f = await seedQuotationFixture(db);
  f2 = await seedQuotationFixture(db);
  ({ partyId: otherCustomer } = await createParty(pool, {
    tenantId: f.tenantId,
    kind: 'customer',
  }));
  await withTx(db, { tenantId: f.tenantId, organizationId: f.entityId }, seedActor, (tx) =>
    tx.execute(sql`
      INSERT INTO app.customers (id, tenant_id, number, legal_name, name_norm, address_line, address_city)
      VALUES (${otherCustomer}, ${f.tenantId}, ${`CUS-${otherCustomer.slice(0, 8)}`}, 'Other Buyer',
              ${`other-${otherCustomer}`}, 'Ring Road', 'Kathmandu')`),
  );

  const confirmed = await seedOrder(f, f.entityId, f.opportunityId, 'confirmed', SCHEDULE);
  orders.confirmed = confirmed.orderId;
  orders.invoiceId = confirmed.invoices[1]!;
  orders.draftInvoiceId = confirmed.invoices[2]!;
  orders.draft = (await seedOrder(f, f.entityId, f.opportunityId, 'draft', PLANNED_ONLY)).orderId;
  orders.cancelled = (
    await seedOrder(f, f.entityId, f.opportunityId, 'cancelled', PLANNED_ONLY)
  ).orderId;
  orders.otherEntity = (
    await seedOrder(f, f.otherEntityId, f.otherEntityOpportunityId, 'confirmed', PLANNED_ONLY)
  ).orderId;
  orders.otherTenant = (
    await seedOrder(f2, f2.entityId, f2.opportunityId, 'confirmed', PLANNED_ONLY)
  ).orderId;

  const service = new PortalMilestonesService(caller, db);
  const moduleRef = await Test.createTestingModule({
    controllers: [PortalMilestonesController],
    providers: [{ provide: PortalMilestonesService, useValue: service }],
  }).compile();
  app = moduleRef.createNestApplication({ rawBody: true, logger: false });
  configureApp(app);
  app.useGlobalFilters(new ErrorBodyFilter());
  await app.listen(0, '127.0.0.1');
  baseUrl = `http://127.0.0.1:${((app.getHttpServer() as Server).address() as AddressInfo).port}`;
});

afterAll(async () => {
  await app?.close();
  await pool?.end();
  await testDb?.drop();
});

function customer(
  party: string,
  tenantId = f.tenantId,
  organizationId = f.entityId,
  orgKind: Principal['orgKind'] = 'customer',
): Principal {
  return {
    userId: randomUUID(),
    zitadelUserId: `z-${party}`,
    tenantId,
    organizationId,
    orgKind,
    partyId: party,
    idpOrgId: randomUUID(),
    roles: ['customer_user'],
    departmentId: null,
    status: 'active',
    grants: new Map([['portal.invoice.read', 'customer_org']]),
  };
}

/** Every key of a JSON value, at any depth. */
function keysOf(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(keysOf);
  if (typeof value !== 'object' || value === null) return [];
  return Object.entries(value).flatMap(([k, v]) => [k, ...keysOf(v)]);
}

const get = (path: string) => request(baseUrl).get(path).set('x-request-id', REQUEST_ID);

async function listIds(): Promise<string[]> {
  const res = await get('/v1/portal/sales-orders');
  expect(res.status, res.text).toBe(200);
  return z
    .array(PortalSalesOrderSchema)
    .parse(res.body)
    .map((o) => o.id);
}

describe('GET /v1/portal/sales-orders (F1-Q34 milestones)', () => {
  it("shows the customer's confirmed order with its schedule as whitelisted milestones", async () => {
    current = customer(f.customerPartyId);
    expect(await listIds()).toEqual([orders.confirmed]);

    const res = await get(`/v1/portal/sales-orders/${orders.confirmed}`);
    expect(res.status, res.text).toBe(200);
    const view = PortalSalesOrderSchema.parse(res.body);
    expect(view).toMatchObject({
      id: orders.confirmed,
      status: 'confirmed',
      confirmedAt: '2026-11-02T04:00:00.000Z',
      currency: 'NPR',
      total: '1130.00',
    });
    expect(view.number).toMatch(/^SO-2083\/84-\d{5}$/);
    expect(view.milestones).toEqual([
      {
        seq: 1,
        label: 'Advance 40%',
        percent: '40',
        amount: '452.00',
        plannedDate: null,
        status: 'invoiced',
        invoice: {
          id: orders.invoiceId,
          number: expect.stringMatching(/^INV-/) as unknown as string,
          dueDate: '2026-12-03',
        },
      },
      // Its invoice is only a draft: the customer sees the milestone reached, and no invoice.
      {
        seq: 2,
        label: 'Design sign-off 30%',
        percent: '30',
        amount: '339.00',
        plannedDate: null,
        status: 'reached',
        invoice: null,
      },
      {
        seq: 3,
        label: 'UAT 30%',
        percent: '30',
        amount: '339.00',
        plannedDate: '2026-12-15',
        status: 'upcoming',
        invoice: null,
      },
    ]);
    // No staff field rides along (NPR value, evidence, marker, version), nor the cancelled line or the draft invoice.
    expect(keysOf(res.body).filter((k) => /npr|evidence|marked|version|fx/i.test(k))).toEqual([]);
    expect(res.text).not.toContain('Old line');
    expect(res.text).not.toContain(orders.draftInvoiceId);
  });

  it('answers one byte-identical 404 for every order that is not the caller’s visible order, and lists none', async () => {
    const hidden: Array<[string, Principal, string]> = [
      ['own draft order', customer(f.customerPartyId), orders.draft],
      ['own cancelled order', customer(f.customerPartyId), orders.cancelled],
      ['own order in a non-default entity', customer(f.customerPartyId), orders.otherEntity],
      ['another customer of the same tenant', customer(otherCustomer), orders.confirmed],
      [
        'a customer of another tenant',
        customer(f2.customerPartyId, f2.tenantId, f2.entityId),
        orders.confirmed,
      ],
      ['an unknown id', customer(f.customerPartyId), randomUUID()],
    ];
    const bodies = new Set<string>();
    for (const [what, who, id] of hidden) {
      current = who;
      const res = await get(`/v1/portal/sales-orders/${id}`);
      expect(res.status, what).toBe(404);
      bodies.add(res.text);
    }
    expect(bodies.size).toBe(1);

    current = customer(otherCustomer);
    expect(await listIds()).toEqual([]);
    current = customer(f2.customerPartyId, f2.tenantId, f2.entityId);
    expect(await listIds()).toEqual([orders.otherTenant]);
  });

  it('shows nothing to the customer acting at the non-default entity', async () => {
    current = customer(f.customerPartyId, f.tenantId, f.otherEntityId);
    expect(await listIds()).toEqual([]);
    expect((await get(`/v1/portal/sales-orders/${orders.otherEntity}`)).status).toBe(404);
  });

  it('refuses staff and vendor callers with 403 before any read', async () => {
    for (const orgKind of ['staff', 'vendor'] as const) {
      current = customer(f.customerPartyId, f.tenantId, f.entityId, orgKind);
      expect((await get('/v1/portal/sales-orders')).status, orgKind).toBe(403);
      expect((await get(`/v1/portal/sales-orders/${orders.confirmed}`)).status, orgKind).toBe(403);
    }
  });
});
